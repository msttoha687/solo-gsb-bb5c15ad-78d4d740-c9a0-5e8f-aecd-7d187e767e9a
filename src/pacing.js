'use strict';

/**
 * 节奏校验（高强度场景连续段检查 / Pacing Check）
 *
 * 作者在编辑页勾选一组**高强度场景**，并设置**允许的最长连续场景数**（1～10），
 * 对编辑中的未保存草稿（不落盘）校验：“是否存在一条可走路线，连续进入的高强度
 * 场景超过允许上限？”——例如连排 5 场战斗而中间没有任何喘息场景。
 *
 * 沿现有「场景 + 完整变量状态」具体状态图，把**当前连续高强度计数**并入遍历去重键：
 *     状态键 = (连续计数, 场景 ID, 全部布尔变量取值位图)
 *   - 每次**进入高强度场景**：连续计数 +1（起点即高强度则从 1 计起）；
 *   - 每次**进入非高强度场景**：连续计数清零；
 *   - 同一 (场景, 变量状态) 在不同连续计数下视为不同节点，因此
 *     “绕环一周累计到第 3 连”与“首次到达只有 1 连”的路线不会被错误合并，
 *     **环路中的连续段也须累计**（环上每圈高强度场景都会推高计数）。
 * 连续计数只取 0..maxConsecutive（达到上限+1 即超限，不再入队），所以状态总数至多
 * 场景数 × 2^n × (maxConsecutive + 1)，含任意环路都必然终止（沿用约 100 万状态
 * 安全上限，超限截断并明确提示无法判定）。
 *
 * 违规判定：某具体状态的连续计数 > maxConsecutive，即“连续第 maxConsecutive+1 个
 * 高强度场景”被进入。BFS 按选项步数逐层展开，首个被发现的超限状态即**按选项步数
 * 最短的违规路线**，发现即停（违规路线是实际可走的，结论确凿，无需完整探索）；
 * 路线沿途每个场景节点带到达时的完整变量状态与连续计数。
 *
 * 通过判定：完整探索（未因状态上限截断）且未发现任何超限状态。达到状态上限时
 * 以 truncated 标明**无法判定**（已探索范围无超限，但未探索区域可能存在）。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

const MAX_CONSECUTIVE_LIMIT = 10; // 允许设置的最长连续场景数上限（1～10）

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 校验查询条件：高强度场景非空、不重复、必须存在；最长连续数为 1～10 的整数 */
function normalizeQuery(queryInput, sceneMap) {
  const q = queryInput || {};
  const raw = q.highIntensityScenes;
  if (!Array.isArray(raw) || !raw.length) {
    throw badRequest('缺少高强度场景：请至少勾选一个高强度场景');
  }
  const scenes = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item == null ? '' : item).trim();
    if (!id) throw badRequest('高强度场景中存在未选择的空行');
    if (seen.has(id)) throw badRequest(`高强度场景重复："${id}"`);
    seen.add(id);
    if (!sceneMap.has(id)) throw badRequest(`高强度场景 "${id}" 不存在`);
    scenes.push(id);
  }
  const max = q.maxConsecutive;
  if (!Number.isInteger(max) || max < 1 || max > MAX_CONSECUTIVE_LIMIT) {
    throw badRequest(`最长连续场景数必须是 1～${MAX_CONSECUTIVE_LIMIT} 的整数`);
  }
  return { highIntensityScenes: scenes, maxConsecutive: max };
}

/**
 * 对剧情（草稿或已保存）运行节奏校验。
 *
 * @param storyInput 剧情对象
 * @param queryInput { highIntensityScenes: [场景ID...], maxConsecutive: 1～10 }
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function checkPacing(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法校验节奏');
  }
  const { highIntensityScenes, maxConsecutive } = normalizeQuery(queryInput, sceneMap);
  const highSet = new Set(highIntensityScenes);

  // 编译条件；语法错误按恒真处理（与其余模块一致），记录到 conditionErrors
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
  for (const scene of sceneMap.values()) {
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      optionCompiled.set(`${scene.id}#${idx}`, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });

  // ---- BFS：状态键 = 连续计数 \x00 场景 ID \x00 变量位图 ----
  const visited = new Set();
  const parent = new Map(); // key -> { parentKey, depth, edge, sceneId, code, streak }
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let transitionCount = 0;
  let maxStreakSeen = 0;              // 已入队状态中观测到的最大连续计数
  const reachedHighScenes = new Set(); // 实际进入过的高强度场景
  let violationKey = null;

  const keyOf = (sceneId, code, streak) => `${streak}\x00${sceneId}\x00${code}`;

  // 返回 true 表示新状态入队；'violation' 表示发现最短超限（不再入队，探索停止）
  const offer = (sceneId, code, streak, depth, predKey, edge) => {
    const key = keyOf(sceneId, code, streak);
    if (visited.has(key)) return false;
    visited.add(key);
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, code, streak });
    statesExplored++;
    if (streak > maxStreakSeen) maxStreakSeen = streak;
    if (highSet.has(sceneId)) reachedHighScenes.add(sceneId);
    if (streak > maxConsecutive) {
      // 连续高强度场景数超限：首个（BFS 意义下最短）超限状态，发现即停
      violationKey = key;
      if (statesExplored > maxStates) truncated = true; // 超限与违规同帧：两者都如实标记
      return 'violation';
    }
    if (statesExplored > maxStates) { truncated = true; return false; }
    queue.push(key);
    return true;
  };

  // 起点：初始状态 = 起点场景的进入赋值；起点即高强度 => 初始连续计数为 1
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  const base = {
    query: {
      highIntensityScenes: highIntensityScenes.map((id) => ({
        sceneId: id,
        title: (sceneMap.get(id) || {}).title || '',
      })),
      maxConsecutive,
    },
    startScene: story.startScene,
    knownVars,
    conditionErrors,
    maxStates,
  };
  if (startBlocked) {
    return {
      ...base,
      ok: false,
      status: 'start-blocked',
      startBlocked: true,
      truncated: false,
      maxStreak: 0,
      reachedHighScenes: [],
      violation: null,
      counts: { states: 0, transitions: 0, variables: knownVars.length },
      statesExplored: 0,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，无法校验节奏。',
    };
  }
  offer(story.startScene, encodeState(startState, knownVars),
    highSet.has(story.startScene) ? 1 : 0, 0, null, null);

  let head = 0;
  while (head < queue.length && !truncated && !violationKey) {
    const curKey = queue[head++];
    const cur = parent.get(curKey);
    const { sceneId, code, streak } = cur;
    const scene = sceneMap.get(sceneId);
    const state = decodeState(code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated || violationKey) return;
      const oc = optionCompiled.get(`${sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 条件不成立：此状态下不可走
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：不构成边
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return;            // 入口前置不成立：不构成边

      // 连续计数传递：进入高强度场景 +1，进入非高强度场景清零
      const nextStreak = highSet.has(targetId) ? streak + 1 : 0;

      const offered = offer(targetId, encodeState(nextState, knownVars), nextStreak,
        cur.depth + 1, curKey, {
          optionIndex: idx,
          optionUid: (option && option.uid) || null,
          optionText: (option && option.text) || '',
          fromSceneId: sceneId,
          target: targetId,
          targetTitle: (sceneMap.get(targetId) || {}).title || '',
        });
      if (offered === true) transitionCount++;
    });
  }

  // ---- 违规路径重建（BFS 父指针；首个超限即选项步数最短） ----
  let violation = null;
  if (violationKey) {
    const trail = [];
    let k = violationKey;
    while (k) {
      const p = parent.get(k);
      const sc = sceneMap.get(p.sceneId);
      trail.push({
        kind: 'scene',
        sceneId: p.sceneId,
        title: sc ? (sc.title || '') : '',
        state: decodeState(p.code, knownVars),
        streak: p.streak,
        highIntensity: highSet.has(p.sceneId),
      });
      if (p.edge) {
        trail.push({
          kind: 'option',
          ...p.edge,
          stateAfter: decodeState(p.code, knownVars),
          streakAfter: p.streak,
        });
      }
      k = p.parentKey;
    }
    trail.reverse();
    const end = parent.get(violationKey);
    violation = {
      sceneId: end.sceneId,
      title: (sceneMap.get(end.sceneId) || {}).title || '',
      depth: end.depth,
      streak: end.streak,
      path: trail,
      finalState: decodeState(end.code, knownVars),
    };
  }

  // ---- 结论：违规 > 截断（无法判定） > 通过 ----
  let status;
  if (violation) status = 'violation';
  else if (truncated) status = 'truncated';
  else status = 'pass';

  const reachedList = highIntensityScenes
    .filter((id) => reachedHighScenes.has(id))
    .map((id) => ({ sceneId: id, title: (sceneMap.get(id) || {}).title || '' }));

  const counts = { states: statesExplored, transitions: transitionCount, variables: knownVars.length };
  let message;
  if (status === 'pass') {
    message = `校验通过：已完整探索 ${statesExplored} 个具体状态，所有可走路线上连续高强度场景均不超过 `
      + `${maxConsecutive} 个（实际观测到的最长连续段为 ${maxStreakSeen} 个）。`;
  } else if (status === 'violation') {
    message = `发现节奏超限：存在连续 ${violation.streak} 个高强度场景的路线（允许最长连续 `
      + `${maxConsecutive} 个），在进入 "${violation.sceneId}" 时超限。`
      + `以下按选项步数展示最短超限路线（${violation.depth} 步）与沿途变量状态、连续计数（探索在发现超限后停止）。`;
  } else {
    message = `无法判定：具体状态数量超过安全上限（${maxStates}），探索被截断。`
      + '已探索范围内未发现连续高强度场景超限的路线，但未探索区域可能存在，不能判通过；请减少变量数量后重试。';
  }

  return {
    ...base,
    ok: status === 'pass',
    status,
    startBlocked: false,
    truncated,
    maxStreak: maxStreakSeen,
    reachedHighScenes: reachedList,
    violation,
    counts,
    statesExplored,
    message,
  };
}

module.exports = { checkPacing, MAX_CONSECUTIVE_LIMIT };
