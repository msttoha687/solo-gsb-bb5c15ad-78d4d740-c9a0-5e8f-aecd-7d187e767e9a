'use strict';

/**
 * 剧情一致性分析引擎
 *
 * 核心思想：把“场景 + 变量状态”作为一个具体状态（concrete state）。
 * 从起点（初始状态由起点场景的赋值得到）开始，对每个选项：
 *   1. 在当前变量状态下求值选项条件；
 *   2. 条件成立且目标场景存在 => 应用目标场景的状态赋值，得到新的具体状态并入队；
 *   3. 用 sceneId + 状态编码去重。
 * 变量数量有限（布尔变量，状态空间 2^n），所以即使剧情含循环，BFS 也必然终止。
 *
 * 问题类型：
 *   unreachableScene  不可达场景（含起点前置条件永不成立的情况）
 *   orphanOption      选项目标为空或指向不存在的场景（悬空跳转）
 *   blockedEntry      选项可达，但进入目标时其前置条件恒不成立（被赋值挡在门外）
 *   neverTrueOption   选项每次被到达时，条件都不成立（条件永不成立）
 *   error             结构性 / 表达式错误
 */

const { compile } = require('./expression');
const { issueFingerprint } = require('./fingerprint');

const MAX_STATES = 1 << 20; // 安全上限：约 100 万个具体状态
const INF = 1e9;            // “不存在任何路径”的距离哨兵（保证 JSON 可序列化）

/** 选项稳定身份：优先 uid（随剧情持久化、与数组顺序无关），旧数据退回数组下标 */
function optionUid(od) {
  return (od.option && od.option.uid) || `idx:${od.sceneId}#${od.index}`;
}

function encodeState(state, varNames) {
  let s = '';
  for (const v of varNames) s += state[v] ? '1' : '0';
  return s;
}

function decodeState(code, varNames) {
  const state = {};
  varNames.forEach((v, i) => { state[v] = code[i] === '1'; });
  return state;
}

function applyAssigns(state, assigns) {
  const next = { ...state };
  for (const a of assigns || []) {
    if (a && a.variable) next[a.variable] = !!a.value;
  }
  return next;
}

/**
 * 状态空间变量 = 已声明变量 ∪ 在赋值中出现的变量。
 * 仅在条件中出现、但从未声明也从未被赋值的变量会作为“永远为 false”的可疑引用上报。
 */
function collectStateVars(story) {
  const known = new Set((story.variables || []).map((v) => (typeof v === 'string' ? v : v.name)).filter(Boolean));
  for (const scene of story.scenes || []) {
    for (const a of scene.assigns || []) if (a && a.variable) known.add(a.variable);
    for (const opt of scene.options || []) {
      for (const a of opt.assigns || []) if (a && a.variable) known.add(a.variable);
    }
  }
  return [...known];
}

/** 预编译所有条件，同时收集硬错误 */
function compileAll(story, knownVars) {
  const errors = [];
  const sceneMap = new Map((story.scenes || []).map((s) => [s.id, s]));

  // loc 为结构化位置信息（供指纹去重使用）：
  //   { kind:'scenePrecondition', sceneId } 或 { kind:'option', sceneId, optionIndex }
  const locText = (loc) => (loc.kind === 'option'
    ? `场景 "${loc.sceneId}" 选项 ${loc.optionIndex + 1} 的条件`
    : `场景 "${loc.sceneId}" 的前置条件`);

  const cond = (raw, loc) => {
    try {
      return compile(raw);
    } catch (e) {
      errors.push({
        type: 'error', severity: 'error', code: 'badSyntax',
        where: locText(loc), message: e.message, ...loc,
      });
      return null;
    }
  };

  const checkVars = (compiled, loc) => {
    if (!compiled) return;
    for (const v of compiled.vars()) {
      if (!knownVars.includes(v)) {
        errors.push({
          type: 'error', severity: 'warning', code: 'unknownVar',
          where: loc.kind === 'option'
            ? `场景 "${loc.sceneId}" 选项 ${loc.optionIndex + 1}`
            : `场景 "${loc.sceneId}" 的前置条件`,
          message: `引用了未声明且从未赋值的变量 "${v}"，它将永远为 false`,
          variable: v, ...loc,
        });
      }
    }
  };

  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optData = []; // {sceneId, index, option, cond, assigns}

  for (const scene of story.scenes || []) {
    const preLoc = { kind: 'scenePrecondition', sceneId: scene.id };
    const pc = cond(scene.precondition, preLoc);
    sceneCond.set(scene.id, pc);
    checkVars(pc, preLoc);
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      const optLoc = { kind: 'option', sceneId: scene.id, optionIndex: idx, optionUid: opt.uid || null };
      const c = cond(opt.condition, optLoc);
      checkVars(c, optLoc);
      const assigns = (opt.assigns || []).filter((a) => a && a.variable);
      optData.push({ sceneId: scene.id, index: idx, option: opt, cond: c, assigns });
    });
  }

  return { errors, sceneMap, sceneCond, sceneAssigns, optData };
}

/**
 * 执行分析，返回完整分析报告。
 */
function analyze(storyInput) {
  const story = storyInput || {};
  const errors = [];
  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneIds = scenes.map((s) => s.id);

  // ---- 结构性校验 ----
  if (!story.startScene) {
    errors.push({ type: 'error', severity: 'error', code: 'noStart', message: '未指定起点场景' });
  }
  const dupIds = sceneIds.filter((id, i) => sceneIds.indexOf(id) !== i);
  if (dupIds.length) {
    errors.push({
      type: 'error', severity: 'error', code: 'dupScene',
      sceneIds: [...new Set(dupIds)],
      message: `存在重复的场景 ID：${[...new Set(dupIds)].join('、')}`,
    });
  }
  const sceneMap = new Map();
  for (const s of scenes) {
    if (!s.id) {
      errors.push({
        type: 'error', severity: 'error', code: 'noSceneId',
        sceneIndex: scenes.indexOf(s), title: s.title || '',
        message: `存在没有 ID 的场景（标题：${s.title || '无标题'}）`,
      });
    } else if (!sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (story.startScene && !sceneMap.has(story.startScene)) {
    errors.push({
      type: 'error', severity: 'error', code: 'missingStart',
      startScene: story.startScene,
      message: `起点场景 "${story.startScene}" 不存在`,
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });
  const compiled = compileAll({ ...story, scenes }, knownVars);
  errors.push(...compiled.errors);
  const { sceneCond, sceneAssigns, optData } = compiled;
  const optDataMap = new Map(optData.map((o) => [`${o.sceneId}#${o.index}`, o]));

  // ---- 数据结构 ----
  const visited = new Map(); // sceneId -> Set<stateCode>
  for (const id of sceneMap.keys()) visited.set(id, new Set());
  const parent = new Map();   // "sceneId\x00code" -> { parentKey, depth, edge }
  const keyOf = (id, code) => `${id}\x00${code}`;

  // 选项观测记录
  const firedBest = new Map();      // optKey -> 触发时的最短前驱信息
  const enabledBest = new Map();    // optKey -> 条件成立时的最短前驱
  const blockedBest = new Map();    // optKey -> 条件成立但目标前置不满足时的最短前驱
  const optKey = (sceneId, idx) => `${sceneId}#${idx}`;

  const queue = [];
  let truncated = false;
  let stateCount = 0;

  const offer = (sceneId, stateCode, depth, predKey, edge) => {
    if (truncated) return;
    const set = visited.get(sceneId);
    if (!set) return; // 目标场景不存在，调用方负责上报
    if (set.has(stateCode)) return;
    set.add(stateCode);
    stateCount++;
    const key = keyOf(sceneId, stateCode);
    parent.set(key, { parentKey: predKey, depth, edge });
    if (stateCount > MAX_STATES) truncated = true;
    else queue.push({ sceneId, code: stateCode, depth, key });
  };

  // ---- 起点：初始状态 = 起点场景的赋值 ----
  const startReachable = sceneMap.has(story.startScene);
  if (startReachable) {
    const startScene = sceneMap.get(story.startScene);
    const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
    const startCode = encodeState(startState, knownVars);
    const pc = sceneCond.get(story.startScene);
    const startEntryOk = !pc || pc.evaluate(startState);
    if (startEntryOk) {
      offer(story.startScene, startCode, 0, null, null);
    } else {
      // 起点自身前置条件不成立：记录一个“被挡住的起点”用于路径展示
      visited.get(story.startScene).add(startCode);
      const key = keyOf(story.startScene, startCode);
      parent.set(key, { parentKey: null, depth: 0, edge: null, entryBlocked: true });
    }
  }

  // ---- BFS 传播 ----
  let head = 0;
  while (head < queue.length) {
    if (truncated) break;
    const cur = queue[head++];
    const scene = sceneMap.get(cur.sceneId);
    const state = decodeState(cur.code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      const key = optKey(cur.sceneId, idx);
      if (!firedBest.has(key)) {
        firedBest.set(key, { predKey: cur.key, depth: cur.depth, state: { ...state } });
      }

      const od = optDataMap.get(key);
      const condOk = !od || !od.cond || od.cond.evaluate(state);
      if (!condOk) return; // 条件不成立：该具体状态下选项走不通

      if (!enabledBest.has(key)) {
        enabledBest.set(key, { predKey: cur.key, depth: cur.depth, state: { ...state } });
      }

      const targetId = (option.target || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return; // 悬空跳转：后面统一上报

      let nextState = state;
      if (od && od.assigns.length) nextState = applyAssigns(nextState, od.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const nextCode = encodeState(nextState, knownVars);
      const already = visited.get(targetId).has(nextCode);

      const targetCond = sceneCond.get(targetId);
      const entryOk = !targetCond || targetCond.evaluate(nextState);

      if (entryOk) {
        if (!already) offer(targetId, nextCode, cur.depth + 1, cur.key, { optionIndex: idx, optionText: option.text });
      } else {
        if (!blockedBest.has(key)) {
          blockedBest.set(key, {
            predKey: cur.key, depth: cur.depth, state: { ...state },
            nextState: { ...nextState },
          });
        }
      }
    });
  }

  // ---- 汇总 ----
  const reachableScenes = new Set();
  const blockedStartScenes = new Set();
  for (const [id, set] of visited) {
    if (set.size === 0) continue;
    const hasReal = [...set].some((code) => {
      const p = parent.get(keyOf(id, code));
      return p && !p.entryBlocked;
    });
    if (hasReal) reachableScenes.add(id);
    else blockedStartScenes.add(id);
  }

  const issueCount = { unreachableScene: 0, orphanOption: 0, blockedEntry: 0, neverTrueOption: 0, error: errors.length };

  // 路径重建：从前驱 key 沿 parent 回溯，返回起点->终点的 [{kind:'scene'},{kind:'option'}, ...]
  const buildPath = (predKey, lastEdge) => {
    const trail = [];
    if (lastEdge) trail.push({ kind: 'option', ...lastEdge });
    let k = predKey;
    while (k) {
      const [sid, code] = k.split('\x00');
      const sc = sceneMap.get(sid);
      trail.push({
        kind: 'scene',
        sceneId: sid,
        title: sc ? sc.title : sid,
        state: decodeState(code, knownVars),
      });
      const p = parent.get(k);
      if (p && p.edge) trail.push({ kind: 'option', ...p.edge });
      k = p ? p.parentKey : null;
    }
    trail.reverse();
    // 合并：option 节点后面补上其指向的场景信息（选项文本里已含 target）
    return trail;
  };

  const issues = [];

  // 起点被自身前置条件挡住
  if (startReachable && blockedStartScenes.has(story.startScene)) {
    const startScene = sceneMap.get(story.startScene);
    const startCode = [...visited.get(story.startScene)][0];
    const state = decodeState(startCode, knownVars);
    const pc = sceneCond.get(story.startScene);
    issueCount.unreachableScene++;
    issues.push({
      type: 'unreachableScene',
      severity: 'error',
      sceneId: story.startScene,
      title: startScene.title,
      message: `起点场景 "${story.startScene}" 的前置条件在初始状态下不成立，剧情无法开始`,
      path: [{
        kind: 'scene', sceneId: story.startScene, title: startScene.title, state,
        blockedEntry: true,
      }],
      unmet: pc ? pc.explain(state, true) : null,
      distance: 0,
    });
  }

  // ---- 收集每个场景的入边证据（用于不可达场景的“最接近可达路径”） ----
  const incoming = new Map(); // targetId -> { kind, depth, predKey, edge, nextState }
  const addIncoming = (targetId, rec) => {
    const cur = incoming.get(targetId);
    // blocked 证据（选项可触发但被目标前置挡住）优先展示；同类取距离更短的
    if (!cur || (rec.kind === 'blocked' && cur.kind !== 'blocked') ||
        (rec.kind === cur.kind && rec.depth < cur.depth)) {
      incoming.set(targetId, rec);
    }
  };
  for (const od0 of optData) {
    const key0 = optKey(od0.sceneId, od0.index);
    const tid = (od0.option.target || '').trim();
    if (!tid || !sceneMap.has(tid)) continue;
    if (blockedBest.has(key0)) {
      const b = blockedBest.get(key0);
      addIncoming(tid, {
        kind: 'blocked', depth: b.depth, predKey: b.predKey, nextState: b.nextState,
        fromSceneId: od0.sceneId, optionIndex: od0.index,
        edge: { optionIndex: od0.index, optionText: od0.option.text, target: tid, entryBlocked: true },
      });
    }
    const e = enabledBest.get(key0) || firedBest.get(key0);
    if (e) {
      addIncoming(tid, {
        kind: 'dead', depth: e.depth, predKey: e.predKey, state: e.state,
        fromSceneId: od0.sceneId, optionIndex: od0.index,
        edge: { optionIndex: od0.index, optionText: od0.option.text, target: tid, deadEnd: true },
      });
    }
  }

  // 不可达场景（重复 ID 只报告一次）
  const reportedUnreachable = new Set();
  for (const scene of scenes) {
    if (!scene.id || scene.id === story.startScene) continue;
    if (reachableScenes.has(scene.id) || reportedUnreachable.has(scene.id)) continue;
    reportedUnreachable.add(scene.id);
    issueCount.unreachableScene++;
    const pc = sceneCond.get(scene.id);
    const inc = incoming.get(scene.id);
    let path = [];
    let unmet = null;
    let distance = INF;
    let suffix = '（剧情中没有任何选项指向这里：孤岛场景）';

    if (inc && inc.kind === 'blocked') {
      suffix = '（存在可到达的选项链，但进入时前置条件恒不成立）';
      distance = inc.depth;
      path = buildPath(inc.predKey, inc.edge);
      path.push({ kind: 'scene', sceneId: scene.id, title: scene.title, state: inc.nextState, blockedEntry: true });
      if (pc) unmet = pc.explain(inc.nextState, true);
    } else if (inc) {
      // 入边选项在所有可达状态下都不成立（会同时作为 neverTrueOption 报告）
      suffix = '（唯一通路的选项条件在所有可达状态下都不成立）';
      distance = inc.depth;
      path = buildPath(inc.predKey, inc.edge);
      const srcOpt = optDataMap.get(optKey(inc.fromSceneId, inc.optionIndex));
      if (srcOpt && srcOpt.cond) unmet = srcOpt.cond.explain(inc.state, true);
      // 追加“假设该选项可触发”后目标场景将呈现的状态节点
      let hypoState = inc.state;
      if (srcOpt) hypoState = applyAssigns(hypoState, srcOpt.assigns);
      hypoState = applyAssigns(hypoState, sceneAssigns.get(scene.id) || []);
      path.push({
        kind: 'scene', sceneId: scene.id, title: scene.title,
        state: hypoState, blockedEntry: true, hypothetical: true,
      });
    } else {
      const initState = applyAssigns({}, sceneAssigns.get(scene.id) || []);
      if (pc) {
        unmet = pc.explain(initState, true);
        if (unmet.flip.length) suffix += ' 其自身前置条件在初始赋值后也不成立。';
      }
    }

    issues.push({
      type: 'unreachableScene',
      severity: 'error',
      sceneId: scene.id,
      title: scene.title,
      message: `场景 "${scene.id}" 从起点不可达${suffix}`,
      path,
      unmet,
      distance,
    });
  }

  // 选项问题
  for (const od of optData) {
    const key = optKey(od.sceneId, od.index);
    const inReachableScene = reachableScenes.has(od.sceneId);
    if (!inReachableScene) continue; // 不可达场景里的选项随场景一起报告，不重复计
    const option = od.option;
    const targetId = (option.target || '').trim();
    const optionLabel = option.text || `选项 ${od.index + 1}`;

    if (!targetId || !sceneMap.has(targetId)) {
      const f = enabledBest.get(key) || firedBest.get(key);
      issueCount.orphanOption++;
      issues.push({
        type: 'orphanOption',
        severity: 'error',
        sceneId: od.sceneId,
        optionIndex: od.index,
        optionUid: optionUid(od),
        targetSceneId: targetId || '',
        message: targetId
          ? `选项 "${optionLabel}" 指向不存在的场景 "${targetId}"（悬空跳转）`
          : `选项 "${optionLabel}" 没有设置目标场景`,
        path: f ? buildPath(f.predKey, { optionIndex: od.index, optionText: option.label || optionLabel, target: targetId, broken: true }) : [],
        distance: f ? f.depth : INF,
      });
      continue;
    }

    if (blockedBest.has(key)) {
      const b = blockedBest.get(key);
      issueCount.blockedEntry++;
      const targetScene = sceneMap.get(targetId);
      const tc = sceneCond.get(targetId);
      const blockedPath = buildPath(b.predKey, {
        optionIndex: od.index,
        optionText: option.label || optionLabel,
        target: targetId,
        targetTitle: targetScene.title,
        stateAfter: b.nextState,
        entryBlocked: true,
      });
      blockedPath.push({
        kind: 'scene',
        sceneId: targetId,
        title: targetScene.title,
        state: b.nextState,
        blockedEntry: true,
      });
      issues.push({
        type: 'blockedEntry',
        severity: 'warning',
        sceneId: od.sceneId,
        targetSceneId: targetId,
        optionIndex: od.index,
        optionUid: optionUid(od),
        message: `选项 "${optionLabel}" 可以到达，但进入 "${targetId}" 时其前置条件恒不成立（状态赋值冲突）`,
        path: blockedPath,
        unmet: tc ? tc.explain(b.nextState, true) : null,
        distance: b.depth,
      });
      continue;
    }

    if (!enabledBest.has(key)) {
      const f = firedBest.get(key);
      issueCount.neverTrueOption++;
      const atScene = sceneMap.get(od.sceneId);
      const issue = {
        type: 'neverTrueOption',
        severity: 'warning',
        sceneId: od.sceneId,
        targetSceneId: targetId,
        optionIndex: od.index,
        optionUid: optionUid(od),
        message: `选项 "${optionLabel}" 的条件在所有可达状态下都不成立（条件永不成立）`,
        path: f
          ? buildPath(f.predKey, { optionIndex: od.index, optionText: option.label || optionLabel, target: targetId })
          : [{ kind: 'scene', sceneId: od.sceneId, title: atScene.title }],
        unmet: od.cond && f ? od.cond.explain(f.state, true) : null,
        distance: f ? f.depth : INF,
      };
      issues.push(issue);
    }
  }

  // 结构性 / 语法错误置于最前（它们可能导致其他分析结果失真）
  const ERROR_KEEP = [
    'code', 'where', 'sceneId', 'optionIndex', 'optionUid', 'variable',
    'sceneIds', 'sceneIndex', 'title', 'startScene',
  ];
  for (const e of errors) {
    const issue = {
      type: 'error',
      severity: e.severity || 'error',
      message: e.where ? `${e.where}：${e.message}` : e.message,
      path: [],
      distance: -1,
    };
    for (const k of ERROR_KEEP) if (e[k] !== undefined) issue[k] = e[k];
    issues.push(issue);
  }

  // 为每条问题附加不依赖数组顺序的稳定指纹（基线对比使用）
  for (const issue of issues) issue.fingerprint = issueFingerprint(issue);

  // 结构性错误排前面，其余按路径长度（最接近可达的优先）
  const rank = { error: 0, unreachableScene: 1, blockedEntry: 2, orphanOption: 3, neverTrueOption: 4 };
  issues.sort((a, b) => (rank[a.type] - rank[b.type]) || ((a.distance ?? INF) - (b.distance ?? INF)));

  // 场景状态汇总（供前端标注）
  const sceneStatus = {};
  for (const scene of scenes) {
    if (!scene.id) continue;
    sceneStatus[scene.id] = reachableScenes.has(scene.id)
      ? 'reachable'
      : (blockedStartScenes.has(scene.id) ? 'blocked' : 'unreachable');
  }

  // 选项状态汇总
  const optionStatus = {};
  for (const od of optData) {
    const key = optKey(od.sceneId, od.index);
    if (!reachableScenes.has(od.sceneId)) {
      optionStatus[key] = 'inUnreachableScene';
    } else if (!(od.option.target || '').trim() || !sceneMap.has(od.option.target)) {
      optionStatus[key] = 'orphan';
    } else if (blockedBest.has(key)) {
      optionStatus[key] = 'blockedEntry';
    } else if (!enabledBest.has(key)) {
      optionStatus[key] = 'neverTrue';
    } else {
      optionStatus[key] = 'ok';
    }
  }

  const totalTransitions = enabledBest.size;

  return {
    ok: !truncated,
    truncated,
    counts: {
      scenes: scenes.length,
      variables: knownVars.length,
      reachableScenes: reachableScenes.size,
      concreteStates: stateCount,
      firedTransitions: firedBest.size,
      enabledTransitions: totalTransitions,
      issues: issueCount.unreachableScene + issueCount.orphanOption + issueCount.blockedEntry + issueCount.neverTrueOption,
      errors: issueCount.error,
    },
    issueCount,
    issues,
    sceneStatus,
    optionStatus,
    reachableScenes: [...reachableScenes],
    knownVars,
  };
}

module.exports = { analyze, encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES };
