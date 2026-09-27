'use strict';

/**
 * 伏笔回收路线校验（Foreshadow Payoff Route Check）
 *
 * 作者在编辑页选择一组**铺垫场景**与一组**回收场景**，对编辑中的未保存草稿
 * （不落盘）校验：“伏笔埋下之后，是否每条通往设计结局的路线都把它回收了？”
 *
 * 沿现有「场景 + 完整变量状态」具体状态图，把 1 位**待回收**标记并入遍历去重键：
 *     状态键 = (待回收标记, 场景 ID, 全部布尔变量取值位图)
 *   - 每次**进入铺垫场景**：待回收置为 true（起点即铺垫也算进入）；
 *   - 每次**进入回收场景**：待回收清除为 false；
 *   - 其余场景：沿继承。
 * 同一 (场景, 变量状态) 在待回收 / 已回收两种标记下视为不同节点，因此
 * “先埋伏笔绕一圈再回收”与“未埋伏笔”的路线不会被错误合并；布尔变量有限，
 * 状态总数至多 场景数 × 2^n × 2，含任意环路都必然终止（约 100 万状态安全上限，
 * 超限截断并明确提示）。
 *
 * 违规判定：到达**可达的设计结局**（场景本身没有任何选项的终止具体状态；
 * 有选项但全不可走的死局软锁不算）时待回收仍为 true。BFS 按选项步数逐层展开，
 * 首个被发现的违规状态即**最短违规路线**，发现即停（违规路线是实际可走的，
 * 结论确凿，无需完整探索），沿途每个场景节点带到达时的完整变量状态。
 *
 * 通过判定（全部满足才判 pass，缺一即单独提示）：
 *   1. 完整探索（未因状态上限截断）；
 *   2. 铺垫可达（遍历中至少进入过一次铺垫场景，否则伏笔从未埋下，校验无意义）；
 *   3. 存在可达设计结局（纯循环 / 只有死局时回收无从校验）；
 *   4. 没有任何“设计结局 && 待回收”状态。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 校验查询条件：铺垫 / 回收场景各自非空、不重复、必须存在，且两组不得重叠 */
function normalizeQuery(queryInput, sceneMap) {
  const q = queryInput || {};
  const normList = (raw, label) => {
    if (!Array.isArray(raw) || !raw.length) {
      throw badRequest(`缺少${label}场景：请至少选择一个${label}场景`);
    }
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const id = String(item == null ? '' : item).trim();
      if (!id) throw badRequest(`${label}场景中存在未选择的空行`);
      if (seen.has(id)) throw badRequest(`${label}场景重复："${id}"`);
      seen.add(id);
      if (!sceneMap.has(id)) throw badRequest(`${label}场景 "${id}" 不存在`);
      out.push(id);
    }
    return out;
  };
  const setups = normList(q.setups, '铺垫');
  const payoffs = normList(q.payoffs, '回收');
  const both = setups.filter((id) => payoffs.includes(id));
  if (both.length) {
    throw badRequest(`场景不能既是铺垫又是回收：${both.join('、')}`);
  }
  return { setups, payoffs };
}

/**
 * 对剧情（草稿或已保存）运行伏笔回收路线校验。
 *
 * @param storyInput 剧情对象
 * @param queryInput { setups: [场景ID...], payoffs: [场景ID...] }
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function checkForeshadow(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法校验伏笔回收');
  }
  const { setups, payoffs } = normalizeQuery(queryInput, sceneMap);
  const setupSet = new Set(setups);
  const payoffSet = new Set(payoffs);

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

  // ---- BFS：状态键 = 待回收标记 \x00 场景 ID \x00 变量位图 ----
  const visited = new Set();
  const parent = new Map(); // key -> { parentKey, depth, edge, sceneId, code, pending }
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let transitionCount = 0;
  let setupReached = false;  // 是否进入过铺垫场景（存在待回收状态）
  let pendingStates = 0;     // 待回收具体状态数
  const endingStatesByScene = new Map(); // 设计结局 sceneId -> 终止具体状态数
  let violationKey = null;

  const keyOf = (sceneId, code, pending) => `${pending ? 1 : 0}${sceneId}${code}`;

  // 返回 true 表示新状态入队；'violation' 表示发现最短违规（不再入队，探索停止）
  const offer = (sceneId, code, pending, depth, predKey, edge) => {
    const key = keyOf(sceneId, code, pending);
    if (visited.has(key)) return false;
    visited.add(key);
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, code, pending });
    statesExplored++;
    if (pending) {
      setupReached = true;
      pendingStates++;
    }
    const scene = sceneMap.get(sceneId);
    if ((scene.options || []).length === 0) {
      // 设计结局终止状态（场景无选项 => 必然没有任何出边）
      endingStatesByScene.set(sceneId, (endingStatesByScene.get(sceneId) || 0) + 1);
      if (pending && !violationKey) {
        violationKey = key;
        if (statesExplored > maxStates) truncated = true; // 超限与违规同帧：两者都如实标记
        return 'violation';
      }
    }
    if (statesExplored > maxStates) { truncated = true; return false; }
    queue.push(key);
    return true;
  };

  // 起点：初始状态 = 起点场景的进入赋值；起点即铺垫 => 初始即待回收
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  const base = {
    query: {
      setups: setups.map((id) => ({ sceneId: id, title: (sceneMap.get(id) || {}).title || '' })),
      payoffs: payoffs.map((id) => ({ sceneId: id, title: (sceneMap.get(id) || {}).title || '' })),
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
      setupReached: false,
      pendingStates: 0,
      endingCount: 0,
      endingStates: 0,
      endings: [],
      violation: null,
      counts: { states: 0, transitions: 0, variables: knownVars.length },
      statesExplored: 0,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，无法校验伏笔回收。',
    };
  }
  offer(story.startScene, encodeState(startState, knownVars), setupSet.has(story.startScene), 0, null, null);

  let head = 0;
  while (head < queue.length && !truncated && !violationKey) {
    const curKey = queue[head++];
    const cur = parent.get(curKey);
    const { sceneId, code, pending } = cur;
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

      // 待回收标记传递：进入铺垫置位，进入回收清除，其余继承
      let nextPending = pending;
      if (setupSet.has(targetId)) nextPending = true;
      else if (payoffSet.has(targetId)) nextPending = false;

      const offered = offer(targetId, encodeState(nextState, knownVars), nextPending,
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

  const endingCount = endingStatesByScene.size;
  const endingStates = [...endingStatesByScene.values()].reduce((a, b) => a + b, 0);
  const endings = [...endingStatesByScene.keys()].sort().map((id) => ({
    sceneId: id,
    title: (sceneMap.get(id) || {}).title || '',
    states: endingStatesByScene.get(id),
  }));

  // ---- 违规路径重建（BFS 父指针；首个违规即选项步数最短） ----
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
        pending: p.pending,
        foreshadow: setupSet.has(p.sceneId) ? 'setup' : (payoffSet.has(p.sceneId) ? 'payoff' : null),
      });
      if (p.edge) {
        trail.push({
          kind: 'option',
          ...p.edge,
          stateAfter: decodeState(p.code, knownVars),
          pendingAfter: p.pending,
        });
      }
      k = p.parentKey;
    }
    trail.reverse();
    const end = parent.get(violationKey);
    violation = {
      endingScene: end.sceneId,
      endingTitle: (sceneMap.get(end.sceneId) || {}).title || '',
      depth: end.depth,
      path: trail,
      finalState: decodeState(end.code, knownVars),
    };
  }

  // ---- 结论：违规 > 截断 > 铺垫不可达 > 无设计结局 > 通过 ----
  let status;
  if (violation) status = 'violation';
  else if (truncated) status = 'truncated';
  else if (!setupReached) status = 'setup-unreachable';
  else if (endingCount === 0) status = 'no-ending';
  else status = 'pass';

  const counts = { states: statesExplored, transitions: transitionCount, variables: knownVars.length };
  let message;
  if (status === 'pass') {
    message = `校验通过：已完整探索 ${statesExplored} 个具体状态，铺垫场景可达，`
      + `全部 ${endingCount} 个可达设计结局（${endingStates} 个终止状态）的到达路线上伏笔均已回收。`;
  } else if (status === 'violation') {
    message = `发现未回收的伏笔：到达设计结局 "${violation.endingScene}" 时伏笔仍待回收。`
      + `以下按选项步数展示最短违规路线（${violation.depth} 步）与沿途变量状态（探索在发现违规后停止）。`;
  } else if (status === 'truncated') {
    message = `无法判定：具体状态数量超过安全上限（${maxStates}），探索被截断。`
      + '已探索范围内未发现“到达设计结局仍待回收”的路线，但未探索区域可能存在，不能判通过；请减少变量数量后重试。';
  } else if (status === 'setup-unreachable') {
    message = `无法判定：已完整探索 ${statesExplored} 个具体状态，但从未进入任何铺垫场景`
      + '——伏笔从未被埋下，回收校验无意义。请检查通往铺垫场景的选项链。';
  } else {
    message = `无法判定：已完整探索 ${statesExplored} 个具体状态，铺垫场景可达，`
      + '但剧情没有任何可达的设计结局（场景无选项的终止场景），伏笔回收无从校验。';
  }

  return {
    ...base,
    ok: status === 'pass',
    status,
    startBlocked: false,
    truncated,
    setupReached,
    pendingStates,
    endingCount,
    endingStates,
    endings,
    violation,
    counts,
    statesExplored,
    message,
  };
}

module.exports = { checkForeshadow };
