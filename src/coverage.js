'use strict';

/**
 * 选项覆盖路线
 *
 * 在「场景 + 变量状态」具体状态图上为每一条**实际可走**的选项保留可复现路径，
 * 再用确定性的贪心集合覆盖把这些路径压缩成一组可执行路线：
 *
 *   1. 从起点场景（初始状态 = 起点场景的进入赋值）BFS 展开具体状态，
 *      按 场景ID + 变量位图 去重（与分析器 / 路径查询 / 概率推演相同，
 *      含循环的剧情也必然终止，上限 MAX_STATES）；
 *   2. 选项在某个具体状态下「可走」= 条件成立 且 目标场景存在 且
 *      应用选项赋值与目标进入赋值后目标前置条件成立。
 *      首次观测到某选项可走时的前驱状态即该选项的见证：从起点到见证状态的
 *      最短选项链 + 该选项本身 = 一条可复现路线（BFS 树路径不会重复经过
 *      同一具体状态，循环图按具体状态去重后路线必然有限）；
 *   3. 覆盖分母只含实际可走的选项：场景不可达、条件恒假、入口前置恒受阻、
 *      悬空跳转的选项一律不计入分母，单独列出并标注原因；
 *   4. 贪心集合覆盖：每轮选出「新覆盖未覆盖选项最多」的见证路线，平分时取
 *      见证发现顺序最早者（完全确定，无随机性），直到全部可走选项被覆盖。
 *
 * 状态数超上限被截断时结果标记为不完整（complete=false）：已发现的可走选项
 * 仍被完整覆盖，但未探索区域可能还有可走选项，且「不可走」判定不再可靠
 * （excludedOptions 中 definitive=false）。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

/** 不可走原因（不计入覆盖分母） */
const REASON_TEXT = {
  unreachableScene: '场景不可达',
  orphan: '悬空跳转',
  neverTrue: '条件恒假',
  blockedEntry: '入口受阻',
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * 对剧情（草稿或已保存）生成选项覆盖路线。
 *
 * @param storyInput 剧情对象
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function planCoverage(storyInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }

  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法生成选项覆盖路线');
  }

  // ---- 编译条件（语法错误按恒真处理，与分析器 / 路径查询 / 概率推演一致） ----
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
  const catalog = [];               // 全部选项（按场景 / 选项顺序）
  for (const scene of sceneMap.values()) {
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      const key = `${scene.id}#${idx}`;
      optionCompiled.set(key, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
      catalog.push({
        key,
        sceneId: scene.id,
        index: idx,
        option: opt || {},
        // 选项稳定身份：优先 uid，旧数据退回 场景ID#下标（与分析器一致）
        uid: (opt && opt.uid) || `idx:${scene.id}#${idx}`,
      });
    });
  }

  // 状态空间变量 = 已声明变量 ∪ 赋值中出现的变量（与分析器一致）
  const knownVars = collectStateVars({ ...story, scenes });

  // ---- BFS 展开具体状态图，记录每条选项首次可走时的见证 ----
  const parent = new Map();        // stateKey -> { parentKey, depth, edge, sceneId, code }
  const visited = new Set();       // stateKey（场景 + 变量位图去重：循环图必然终止）
  const keyOf = (id, code) => `${id}\x00${code}`;
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let walkableTransitions = 0;

  const reachedScenes = new Set();
  const condTrueKeys = new Set();  // 条件曾在某个可达状态下成立的选项
  const witnesses = new Map();     // optKey -> { predKey, edge, targetId, nextCode }（迭代序 = 发现顺序）

  const offer = (sceneId, code, depth, predKey, edge) => {
    if (truncated) return;
    const key = keyOf(sceneId, code);
    if (visited.has(key)) return;
    visited.add(key);
    statesExplored++;
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, code });
    reachedScenes.add(sceneId);
    if (statesExplored > maxStates) { truncated = true; return; }
    queue.push({ sceneId, code, depth, key });
  };

  // 起点：初始状态 = 起点场景的进入赋值；前置不成立则没有任何可达状态
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (!startBlocked) {
    offer(story.startScene, encodeState(startState, knownVars), 0, null, null);
  }

  let head = 0;
  while (head < queue.length && !truncated) {
    const cur = queue[head++];
    const scene = sceneMap.get(cur.sceneId);
    const state = decodeState(cur.code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated) return;
      const key = `${cur.sceneId}#${idx}`;
      const oc = optionCompiled.get(key);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 条件不成立：该状态下不可走
      condTrueKeys.add(key);
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：永远不可走
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return;             // 入口前置不成立：该状态下不可走

      // 该选项在此具体状态下可走
      walkableTransitions++;
      const nextCode = encodeState(nextState, knownVars);
      const edge = {
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        fromSceneId: cur.sceneId,
        target: targetId,
        targetTitle: (sceneMap.get(targetId) || {}).title || '',
      };
      if (!witnesses.has(key)) {
        witnesses.set(key, { predKey: cur.key, edge, targetId, nextCode });
      }
      offer(targetId, nextCode, cur.depth + 1, cur.key, edge);
    });
  }

  // 路径重建：scene / option 交替；场景节点带到达时的完整变量状态，
  // 选项边带选择后（含目标场景进入赋值）的状态 stateAfter —— 即“每步状态”
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

  // ---- 选项分类：可走（计入分母）/ 不可走（不计入分母，标注原因） ----
  const excludedOptions = [];
  for (const entry of catalog) {
    if (witnesses.has(entry.key)) continue; // 可走：计入分母
    const target = (entry.option.target || '').trim();
    let reason;
    if (!reachedScenes.has(entry.sceneId)) reason = 'unreachableScene';
    else if (!target || !sceneMap.has(target)) reason = 'orphan';
    else if (!condTrueKeys.has(entry.key)) reason = 'neverTrue';
    else reason = 'blockedEntry';
    excludedOptions.push({
      uid: entry.uid,
      sceneId: entry.sceneId,
      optionIndex: entry.index,
      text: entry.option.text || '',
      target,
      reason,
      reasonText: REASON_TEXT[reason],
      // 截断时“不可走”只是已探索范围内的暂定结论
      definitive: !truncated,
    });
  }

  // ---- 每条可走选项一条见证路线（可复现路径） ----
  const uidOf = new Map(catalog.map((e) => [e.key, e.uid]));
  const candidates = []; // 见证发现顺序（Map 迭代序），保证贪心结果确定
  for (const [key, w] of witnesses) {
    const path = buildPath(w.predKey);
    const nextState = decodeState(w.nextCode, knownVars);
    path.push({ kind: 'option', ...w.edge, stateAfter: nextState });
    const targetScene = sceneMap.get(w.targetId);
    path.push({
      kind: 'scene',
      sceneId: w.targetId,
      title: targetScene ? (targetScene.title || '') : '',
      state: nextState,
    });
    // 路线覆盖集 = 路线走到的全部可走选项（同一路径上的选项一并覆盖）
    const covers = [...new Set(
      path.filter((n) => n.kind === 'option').map((n) => `${n.fromSceneId}#${n.optionIndex}`)
    )];
    candidates.push({ key, path, covers });
  }

  // ---- 确定性贪心集合覆盖：每轮取新覆盖最多者，平分取发现顺序最早者 ----
  const uncovered = new Set(witnesses.keys());
  const routes = [];
  while (uncovered.size) {
    let best = null;
    let bestNew = null;
    for (const cand of candidates) {
      const newly = cand.covers.filter((k) => uncovered.has(k));
      if (!best || newly.length > bestNew.length) { best = cand; bestNew = newly; }
    }
    if (!best || !bestNew.length) break; // 防御：每条可走选项都有见证路线，正常不会走到
    for (const k of bestNew) uncovered.delete(k);
    routes.push({
      index: routes.length + 1,
      depth: best.path.filter((n) => n.kind === 'option').length,
      covers: best.covers.map((k) => uidOf.get(k)),
      newlyCovered: bestNew.map((k) => uidOf.get(k)),
      path: best.path,
    });
  }

  const coverable = witnesses.size;
  const covered = coverable - uncovered.size;
  const rate = coverable ? covered / coverable : null;

  let message;
  if (startBlocked) {
    message = '起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可走的选项';
  } else if (truncated) {
    message = `状态数达到安全上限（已探索 ${statesExplored} 个具体状态），结果不完整：`
      + `已发现的 ${coverable} 条可走选项由 ${routes.length} 条路线覆盖，`
      + `但未探索区域可能还有可走选项，${excludedOptions.length} 条暂不可走选项的判定也可能变化`;
  } else if (coverable === 0) {
    message = `已穷举全部 ${statesExplored} 个可达状态：没有任何实际可走的选项`
      + (excludedOptions.length ? `（${excludedOptions.length} 条选项不可走，未计入分母）` : '');
  } else {
    message = `已穷举全部 ${statesExplored} 个可达状态：${coverable} 条可走选项由 ${routes.length} 条路线完整覆盖`
      + `（覆盖率 ${(rate * 100).toFixed(1)}%）`
      + (excludedOptions.length ? `；${excludedOptions.length} 条不可走选项未计入分母` : '');
  }

  return {
    ok: true,
    complete: !truncated,
    truncated,
    startBlocked,
    startScene: story.startScene,
    coverage: { coverable, covered, rate },
    counts: {
      options: catalog.length,
      coverable,
      covered,
      excluded: excludedOptions.length,
      routes: routes.length,
      states: statesExplored,
      walkableTransitions,
      variables: knownVars.length,
    },
    routes,
    excludedOptions,
    knownVars,
    conditionErrors,
    statesExplored,
    maxStates,
    message,
  };
}

module.exports = { planCoverage, REASON_TEXT };
