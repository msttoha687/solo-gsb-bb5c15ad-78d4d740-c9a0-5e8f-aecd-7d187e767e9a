'use strict';

/**
 * 目标路径查询
 *
 * 在「场景 + 完整变量状态」的具体状态空间上执行可终止的 BFS：
 * 从起点场景的初始状态（起点场景的进入赋值）出发，寻找第一个
 * 「位于目标场景 且 全部到达约束成立 且 已按顺序经过全部必经选项」的具体状态，
 * 返回最短选项链及每步状态。
 *
 * 有序必经选项（query.requiredOptions，按稳定 UID 指定，顺序即要求的经过次序）：
 *   BFS 的每个节点带一个进度 k = 已经依次完成的必经序号（0..m）。
 *   走到第 k 个必经选项时进度 +1；乱序经过、重复经过都不计入进度。
 *   去重键为 场景ID + 进度 k + 变量位图 —— 同一局面在不同必经进度下是不同节点，
 *   因此“先绕路完成必经项、再回来”的路线不会被错误去重。
 *
 * 禁用选项（query.disabledOptions，UID 数组）：
 *   传播时这些选项一律不扩展，相当于从图中临时删除。
 *
 * 终止性：去重后的节点数 ≤ 场景数 × (m+1) × 2^n，仍然有限，含循环也必然终止；
 * 另有 maxStates 安全上限（与分析器一致），超限即截断——截断时未找到目标不能断言
 * 无解，结果中以 canAssertUnsolvable=false 标明。
 *
 * 无解时的回退结果：在已探索的可达状态中挑选「与目标差异最少」者——
 *   1. 目标场景上的到达状态优先（最能说明“到了但变量不对 / 必经项没走完”）；
 *   2. 其次差异数更少 = 不满足的变量约束数 + 未完成的必经项数；
 *   3. 再其次由 BFS 顺序保证先提供者胜（路径更短）。
 * 同时返回缺失变量清单、未完成必经项清单与对应路径。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 约束规整：忽略未选变量的空行；同一变量只允许一条约束 */
function normalizeConstraints(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('constraints 必须是 [{ variable, value }] 数组');
  const out = [];
  const seen = new Set();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const variable = String(c.variable === undefined || c.variable === null ? '' : c.variable).trim();
    if (!variable) continue; // 前端可能留有未选择变量的空行
    if (seen.has(variable)) throw badRequest(`变量 "${variable}" 的到达约束重复`);
    seen.add(variable);
    // 宽容处理字符串布尔值，避免 "false" 被 !! 误判为 true
    const value = c.value === 'false' ? false : !!c.value;
    out.push({ variable, value });
  }
  return out;
}

/**
 * 必经 / 禁用 UID 列表规整。
 * @param raw       原始数组（元素为 UID 字符串；空字符串视为前端未选好的空行，忽略）
 * @param field     字段名（用于报错）
 * @param label     中文名（用于报错）
 */
function normalizeUidList(raw, field, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest(`${field} 必须是 UID 字符串数组`);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const uid = String(item === undefined || item === null ? '' : item).trim();
    if (!uid) continue; // 前端下拉框未选择的空行
    if (seen.has(uid)) throw badRequest(`${label}中选项 UID "${uid}" 重复`);
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

/**
 * 执行目标路径查询。
 *
 * @param story  剧情对象（草稿或已保存均可）
 * @param query  {
 *   targetScene,
 *   constraints: [{ variable, value }],
 *   requiredOptions: [uid, ...],  // 有序必经选项（按数组顺序依次经过）
 *   disabledOptions: [uid, ...],  // 禁用选项（不扩展）
 * }
 * @param opts   { maxStates } 测试可注入更小的状态上限
 */
function queryPath(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const query = queryInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }

  const targetScene = String(query.targetScene || '').trim();
  if (!targetScene) throw badRequest('缺少目标场景 targetScene');
  if (!sceneMap.has(targetScene)) throw badRequest(`目标场景 "${targetScene}" 不存在`);
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法执行路径查询');
  }
  const constraints = normalizeConstraints(query.constraints);
  const requiredUids = normalizeUidList(query.requiredOptions, 'requiredOptions', '必经选项');
  const disabledUids = normalizeUidList(query.disabledOptions, 'disabledOptions', '禁用选项');

  // UID -> { sceneId, index, option }：按稳定 UID 定位选项（与数组顺序无关）
  const uidIndex = new Map();
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    (scene.options || []).forEach((option, index) => {
      if (option && option.uid && !uidIndex.has(option.uid)) {
        uidIndex.set(option.uid, { sceneId: scene.id, index, option });
      }
    });
  }

  // 校验：所有引用的 UID 必须存在
  const missingUids = [...new Set([...requiredUids, ...disabledUids])]
    .filter((uid) => !uidIndex.has(uid));
  if (missingUids.length) {
    throw badRequest(`以下选项 UID 不存在：${missingUids.join('、')}`);
  }
  // 校验：必经与禁用不得冲突
  const disabledSet = new Set(disabledUids);
  const conflict = requiredUids.find((uid) => disabledSet.has(uid));
  if (conflict) throw badRequest(`选项 UID "${conflict}" 不能同时出现在必经选项与禁用选项中`);

  // 必经序号 -> UID；仅在走到“当前下一个”必经选项时进度才推进
  const requiredRank = new Map(requiredUids.map((uid, i) => [uid, i]));
  const requiredCount = requiredUids.length;

  const describeUid = (uid) => {
    const e = uidIndex.get(uid);
    return {
      uid,
      sceneId: e.sceneId,
      optionIndex: e.index,
      text: (e.option.text || ''),
      target: ((e.option.target || '')).trim(),
    };
  };
  const describeRequired = (uid, i) => ({ order: i + 1, ...describeUid(uid) });
  const requiredOptions = requiredUids.map(describeRequired);
  const disabledOptions = disabledUids.map(describeUid);

  // 状态空间变量 = 已声明变量 ∪ 赋值中出现的变量（与分析器一致）
  const knownVars = collectStateVars({ ...story, scenes });

  // 编译条件；语法错误的条件按恒真处理（与分析器一致），并记录到 conditionErrors
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optionCompiled = new Map(); // `${sceneId}#${idx}` -> { cond, assigns }
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      optionCompiled.set(`${scene.id}#${idx}`, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
    });
  }

  // 未进入状态空间的约束变量：恒为 false（约束 value=true 时永远缺失）
  const unknownConstraintVars = constraints
    .map((c) => c.variable)
    .filter((v) => !knownVars.includes(v));

  const mismatchesOf = (state) => {
    const miss = [];
    for (const c of constraints) {
      const actual = knownVars.includes(c.variable) ? !!state[c.variable] : false;
      if (actual !== c.value) miss.push({ variable: c.variable, want: c.value, actual });
    }
    return miss;
  };

  // 去重键含“已完成的必经序号 k”：同一场景+变量状态、不同必经进度是不同节点
  const visited = new Set();
  const parent = new Map();         // key -> { parentKey, depth, edge, sceneId, code, prog }
  const keyOf = (id, prog, code) => `${id}\x00${prog}\x00${code}`;
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let targetStates = 0;
  let goalKey = null;
  let closest = null;               // { key, sceneId, code, prog, depth, miss, remaining, total }

  const considerClosest = (rec) => {
    if (!closest) { closest = rec; return; }
    const atTarget = rec.sceneId === targetScene;
    const curAtTarget = closest.sceneId === targetScene;
    if (atTarget !== curAtTarget) {
      if (atTarget) closest = rec;
      return;
    }
    if (rec.total < closest.total) closest = rec;
  };

  const offer = (sceneId, code, prog, depth, predKey, edge) => {
    if (truncated || goalKey) return;
    const key = keyOf(sceneId, prog, code);
    if (visited.has(key)) return;
    visited.add(key);
    statesExplored++;
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, code, prog });
    const state = decodeState(code, knownVars);
    const miss = mismatchesOf(state);
    const remaining = requiredCount - prog;
    if (sceneId === targetScene) {
      targetStates++;
      // BFS 按层提供状态，首次命中即全局最短（更浅的状态此前都已检查过）
      if (miss.length === 0 && prog === requiredCount) { goalKey = key; return; }
    }
    considerClosest({ key, sceneId, code, prog, depth, miss, remaining, total: miss.length + remaining });
    if (statesExplored > maxStates) { truncated = true; return; }
    queue.push({ sceneId, code, prog, depth, key });
  };

  // 起点：初始状态 = 起点场景的进入赋值；起点前置不成立则没有任何可达状态
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (!startBlocked) {
    offer(story.startScene, encodeState(startState, knownVars), 0, 0, null, null);
  }

  // ---- BFS 传播 ----
  let head = 0;
  while (head < queue.length && !truncated && !goalKey) {
    const cur = queue[head++];
    const scene = sceneMap.get(cur.sceneId);
    const state = decodeState(cur.code, knownVars);
    (scene.options || []).forEach((option, idx) => {
      if (truncated || goalKey) return;
      const uid = (option && option.uid) || '';
      if (uid && disabledSet.has(uid)) return; // 禁用选项：不扩展
      const oc = optionCompiled.get(`${cur.sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return;
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return; // 入口前置不成立：不算到达

      // 必经进度：只有“当前下一个”必经选项被经过时才 +1；乱序 / 重复不计
      let nextProg = cur.prog;
      let requiredOrder = null;
      if (requiredCount > 0 && cur.prog < requiredCount &&
          requiredUids[cur.prog] === uid) {
        nextProg = cur.prog + 1;
        requiredOrder = nextProg; // 1-based 序号
      }
      offer(targetId, encodeState(nextState, knownVars), nextProg, cur.depth + 1, cur.key, {
        optionIndex: idx,
        optionUid: uid || null,
        optionText: (option && option.text) || '',
        fromSceneId: cur.sceneId,
        target: targetId,
        required: requiredOrder !== null,
        requiredOrder,
      });
    });
  }

  // 路径重建：scene / option 交替；scene 节点携带到达时的完整变量状态，
  // option 边携带选择后（含目标场景进入赋值）的状态 stateAfter —— 即“每步状态”；
  // 完成某个必经项的边带 requiredOrder（1-based）。
  const buildPath = (key) => {
    const trail = [];
    let k = key;
    while (k) {
      const p = parent.get(k);
      const sc = sceneMap.get(p.sceneId);
      const state = decodeState(p.code, knownVars);
      trail.push({ kind: 'scene', sceneId: p.sceneId, title: sc ? (sc.title || '') : '', state });
      if (p.edge) trail.push({ kind: 'option', ...p.edge, stateAfter: state });
      k = p.parentKey;
    }
    trail.reverse();
    return trail;
  };

  const found = goalKey !== null;
  const targetTitle = sceneMap.get(targetScene).title || '';

  const result = {
    found,
    truncated,
    exhaustive: !truncated,
    // 仅在完整穷举后仍未找到时才能断言无解；截断时该标志为 false
    canAssertUnsolvable: !found && !truncated,
    statesExplored,
    maxStates,
    targetScene,
    targetTitle,
    constraints,
    requiredOptions,
    disabledOptions,
    requiredCount,
    disabledCount: disabledOptions.length,
    knownVars,
    unknownConstraintVars,
    conditionErrors,
    startBlocked,
    targetReachable: targetStates > 0,
    targetStatesExplored: targetStates,
  };

  if (found) {
    const gp = parent.get(goalKey);
    result.depth = gp.depth;
    result.finalState = decodeState(gp.code, knownVars);
    result.path = buildPath(goalKey);
    result.progress = requiredCount;
    result.completedRequiredCount = requiredCount;
    result.unfinishedRequiredOptions = [];
    const reqText = requiredCount ? `，并依次经过全部 ${requiredCount} 个必经选项` : '';
    const disText = disabledOptions.length ? `（已禁用 ${disabledOptions.length} 个选项）` : '';
    result.message = `找到到达 "${targetScene}" 且满足全部约束${reqText} 的最短选项链（${result.depth} 步）${disText}`;
    return result;
  }

  // 未命中：未完成必经项取“差异最少状态”处的进度；起点被挡时全部未完成
  const completed = closest ? closest.prog : 0;
  result.progress = completed;
  result.completedRequiredCount = completed;
  result.unfinishedRequiredOptions = requiredOptions.slice(completed);

  result.closest = closest ? {
    sceneId: closest.sceneId,
    title: (sceneMap.get(closest.sceneId) || {}).title || '',
    isTargetScene: closest.sceneId === targetScene,
    depth: closest.depth,
    state: decodeState(closest.code, knownVars),
    progress: closest.prog,
    completedRequiredCount: closest.prog,
    missing: closest.miss,
    unfinishedRequiredOptions: requiredOptions.slice(closest.prog),
    mismatchCount: closest.total,
    path: buildPath(closest.key),
  } : null;

  if (startBlocked) {
    result.message = '起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可达状态';
  } else if (truncated) {
    result.message = `已探索 ${statesExplored} 个状态（达到上限）仍未找到满足约束与必经顺序的到达状态；因搜索截断，不能断言无解`;
  } else {
    const reqText = requiredCount ? ` 并依次经过 ${requiredCount} 个必经选项` : '';
    const disText = disabledOptions.length ? `（已禁用 ${disabledOptions.length} 个选项）` : '';
    result.message = `已穷举全部 ${statesExplored} 个可达状态，不存在到达 "${targetScene}" 且满足约束${reqText} 的状态${disText}（可断言无解）`;
  }
  return result;
}

module.exports = { queryPath };
