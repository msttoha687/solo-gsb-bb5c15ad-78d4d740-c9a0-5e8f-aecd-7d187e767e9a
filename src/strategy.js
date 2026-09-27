'use strict';

/**
 * 结局保证到达（玩家策略求解 / Guaranteed Ending Reachability）
 *
 * 作者在编辑页选择一个**目标结局**（必须是无选项场景）并勾选一组**环境控制场景**
 * （其余场景由玩家控制），对编辑中的未保存草稿（不落盘）回答：
 * “是否存在一个玩家策略，使得无论环境在其控制的场景里选择哪个合法选项，
 *   剧情都能在有限步内到达目标结局？”
 *
 * 沿用分析器的条件 / 赋值 / 入口前置语义，在「场景 + 完整变量状态」具体状态图上
 * 求解（与结局必经抉择共用同一个图展开：条件不成立、悬空跳转、目标前置不成立的
 * 选项不构成边；按 场景ID+位图 去重，含环必然终止，约 100 万状态安全上限）。
 * 选项权重不参与判断（那是概率推演的概念，这里只问“能不能保证”）。
 *
 * 判定方法 = 最小不动点反向扩展（吸引子计算 / attractor）：
 *   - 目标结局的全部可达终止状态是已获胜的种子（层级 0）；
 *   - **玩家状态**：至少一个后继已获胜 => 已获胜；
 *   - **环境状态**：必须有合法后继，且**全部**后继已获胜 => 已获胜
 *     （环境可以任意选择，所以必须封死所有出口）；
 *   - 每个已获胜状态带层级 rank：目标为 0，其余为 使其获胜的后继层级 + 1。
 * 反向扩展是单调增长的最小不动点，含任意环路都必然收敛终止。
 *
 * 两种“看似没输”的情形都**不算成功**：
 *   - 非目标死局（终止状态不在目标场景）：环境状态没有合法后继时永远不获胜，
 *     玩家状态全部后继不可走时同样不获胜——死局不是目标，停滞不算到达；
 *   - 可无限停留的循环：最小不动点只把“能强制在有限步内到达目标”的状态标为
 *     已获胜，永远绕圈的状态始终不获胜（有限步保证由层级体现：沿推荐走，
 *     层级严格下降，必然在有限步内落到层级 0 的目标）。
 *
 * 起点已获胜 => 存在保证策略（guaranteed）：列出全部**获胜玩家状态**的变量值、
 * 推荐选项 UID 与层级；推荐边必然进入**更低层级**（rank 严格下降），玩家照推荐
 * 选择即可保证有限步内到达，环境怎么选都无法阻止。
 *
 * 起点未获胜 => 无法保证（unguaranteed）：给出失败原因与一条环境反制见证——
 *   - deadend：环境可把剧情引入非目标死局（附到达死局的最短路线）；
 *   - loop：目标可达，但环境可让剧情在循环中无限停留（附进入循环的路线与循环场景）；
 *   - unreachable：完整探索后目标结局从起点根本不可达。
 * 起点前置不成立（start-blocked）与状态上限截断（truncated）都显示**无法判定**。
 */

const { expandGraph } = require('./forcedchoice');
const { decodeState } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * 校验查询条件：目标结局必须存在且为无选项场景；
 * 环境控制场景列表不得含空行 / 重复项，每个场景必须存在（可为空数组 = 全由玩家控制）。
 */
function normalizeQuery(queryInput, sceneMap) {
  const q = queryInput || {};
  const targetScene = String(q.targetScene == null ? '' : q.targetScene).trim();
  if (!targetScene) throw badRequest('缺少目标结局场景：请选择一个无选项的场景作为目标');
  if (!sceneMap.has(targetScene)) throw badRequest(`目标结局场景 "${targetScene}" 不存在`);
  const targetOptions = (sceneMap.get(targetScene).options || []);
  if (targetOptions.length > 0) {
    throw badRequest(`目标结局场景 "${targetScene}" 含有 ${targetOptions.length} 个选项：`
      + '目标必须是无选项场景（剧情在那里结束）');
  }

  const raw = q.environmentScenes === undefined ? [] : q.environmentScenes;
  if (!Array.isArray(raw)) throw badRequest('环境控制场景列表必须是数组');
  const environmentScenes = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item == null ? '' : item).trim();
    if (!id) throw badRequest('环境控制场景中存在未选择的空行');
    if (seen.has(id)) throw badRequest(`环境控制场景重复："${id}"`);
    seen.add(id);
    if (!sceneMap.has(id)) throw badRequest(`环境控制场景 "${id}" 不存在`);
    environmentScenes.push(id);
  }
  return { targetScene, environmentScenes };
}

/**
 * 对剧情（草稿或已保存）求解“结局保证到达”的玩家策略。
 *
 * @param storyInput 剧情对象
 * @param queryInput { targetScene, environmentScenes: [场景ID...] }
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function solveStrategy(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法求解结局保证');
  }
  const { targetScene, environmentScenes } = normalizeQuery(queryInput, sceneMap);
  const envSet = new Set(environmentScenes);

  // 展开「场景 + 完整变量状态」图（与结局必经抉择共用：相同的条件 / 赋值 / 入口语义）
  const graph = expandGraph(story, opts);
  const { stateList, out, knownVars, conditionErrors, sceneMap: sm } = graph;

  const base = {
    query: {
      targetScene,
      targetTitle: (sceneMap.get(targetScene) || {}).title || '',
      environmentScenes: environmentScenes.map((id) => ({
        sceneId: id,
        title: (sceneMap.get(id) || {}).title || '',
      })),
    },
    startScene: story.startScene,
    knownVars,
    conditionErrors,
    maxStates: graph.maxStates,
  };

  // ---- 起点受阻：无法判定 ----
  if (graph.startBlocked) {
    return {
      ...base,
      ok: false,
      status: 'start-blocked',
      guaranteed: null,
      startBlocked: true,
      truncated: false,
      start: null,
      winningStates: null,
      winningStateCount: null,
      failure: null,
      counts: { states: 0, transitions: 0, variables: knownVars.length, playerStates: 0, envStates: 0, targetStates: 0 },
      statesExplored: 0,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，无法判定是否能保证到达目标结局。',
    };
  }

  // ---- 状态上限截断：图未展开完，无法判定（不下任何保证 / 不保证结论） ----
  if (graph.truncated) {
    return {
      ...base,
      ok: false,
      status: 'truncated',
      guaranteed: null,
      startBlocked: false,
      truncated: true,
      start: null,
      winningStates: null,
      winningStateCount: null,
      failure: null,
      counts: {
        states: stateList.length,
        transitions: graph.transitionCount,
        variables: knownVars.length,
        playerStates: null,
        envStates: null,
        targetStates: null,
      },
      statesExplored: graph.statesExplored,
      message: `无法判定：具体状态数量超过安全上限（${graph.maxStates}），状态图未完整展开。`
        + '未探索区域可能改变结论，既不能断言可保证到达，也不能断言无法保证；请减少变量数量后重试。',
    };
  }

  const n = stateList.length;
  const controller = new Array(n); // 'player' | 'env'
  let playerStates = 0;
  let envStates = 0;
  for (let i = 0; i < n; i++) {
    controller[i] = envSet.has(stateList[i].sceneId) ? 'env' : 'player';
    if (controller[i] === 'env') envStates++;
    else playerStates++;
  }

  // ---- 最小不动点反向扩展（吸引子）----
  // 目标结局的全部可达终止状态为种子（层级 0）；玩家状态一个后继获胜即获胜，
  // 环境状态须有合法后继且全部后继获胜才获胜。FIFO 工作队列按层级非递减出队，
  // 因此每个状态首次被标记时的层级即其最小保证步数层级。
  const targetNodes = graph.terminalByScene.get(targetScene) || [];
  const isTarget = new Uint8Array(n);
  for (const t of targetNodes) isTarget[t] = 1;

  const radj = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) {
    for (const e of out[u]) radj[e.to].push(u);
  }

  const win = new Uint8Array(n);
  const rank = new Int32Array(n).fill(-1);
  const remaining = new Int32Array(n); // 环境状态：尚未确认获胜的后继数
  for (let i = 0; i < n; i++) remaining[i] = out[i].length;

  const queue = [];
  for (const t of targetNodes) {
    win[t] = 1;
    rank[t] = 0;
    queue.push(t);
  }
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    for (const u of radj[v]) {
      if (win[u]) continue;
      if (controller[u] === 'player') {
        win[u] = 1;
        rank[u] = rank[v] + 1;
        queue.push(u);
      } else {
        remaining[u]--;
        if (remaining[u] === 0) { // 有合法后继（out 非空）且全部已获胜
          win[u] = 1;
          rank[u] = rank[v] + 1;
          queue.push(u);
        }
      }
    }
  }

  // ---- 推荐选项：每个获胜玩家状态选一条进入最低层级后继的边（必严格下降）----
  // 平局按 (层级, uid, 目标状态号) 确定性取最小，结果无随机性。
  const recommend = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!win[i] || controller[i] !== 'player' || isTarget[i]) continue;
    let best = null;
    for (const e of out[i]) {
      if (!win[e.to]) continue;
      const cand = { uid: e.uid, to: e.to, nextRank: rank[e.to] };
      if (!best
        || cand.nextRank < best.nextRank
        || (cand.nextRank === best.nextRank
          && (cand.uid < best.uid || (cand.uid === best.uid && cand.to < best.to)))) {
        best = cand;
      }
    }
    if (best) {
      const info = graph.labelInfo.get(best.uid) || {};
      recommend[i] = {
        uid: best.uid,
        optionIndex: info.optionIndex != null ? info.optionIndex : null,
        text: info.text || '',
        target: stateList[best.to].sceneId,
        targetTitle: (sm.get(stateList[best.to].sceneId) || {}).title || '',
        nextRank: best.nextRank,
      };
    }
  }

  const describeState = (i) => ({
    sceneId: stateList[i].sceneId,
    title: (sm.get(stateList[i].sceneId) || {}).title || '',
    controller: controller[i],
    state: decodeState(stateList[i].code, knownVars),
    rank: rank[i],
    recommend: recommend[i],
  });

  const startIdx = graph.startIdx;
  const start = describeState(startIdx);

  const counts = {
    states: n,
    transitions: graph.transitionCount,
    variables: knownVars.length,
    playerStates,
    envStates,
    targetStates: targetNodes.length,
  };

  // ---- 起点已获胜：存在保证策略 ----
  if (win[startIdx]) {
    // 获胜玩家状态（不含目标终止状态），按发现顺序列出
    const winningStates = [];
    for (let i = 0; i < n; i++) {
      if (win[i] && controller[i] === 'player' && !isTarget[i]) winningStates.push(describeState(i));
    }
    const message = start.rank === 0
      ? `起点即目标结局 "${targetScene}"（层级 0）：剧情已经开始于目标，平凡地保证到达。`
      : `存在玩家策略：从起点出发，无论环境如何选择合法选项，都能在有限步内到达目标结局 `
        + `"${targetScene}"（起点的保证层级为 ${start.rank}，即最坏 ${start.rank} 步内到达）。`
        + `共 ${winningStates.length} 个获胜玩家状态，下表给出每个状态的推荐选项——`
        + '推荐均进入更低层级，沿推荐选择层级严格下降，必然在有限步内落到目标。';
    return {
      ...base,
      ok: true,
      status: 'guaranteed',
      guaranteed: true,
      startBlocked: false,
      truncated: false,
      start,
      winningStates,
      winningStateCount: winningStates.length,
      failure: null,
      counts,
      statesExplored: graph.statesExplored,
      message,
    };
  }

  // ---- 起点未获胜：无法保证。分析失败原因并构造环境反制见证 ----
  // 反制子图 = 未获胜状态之间的边：玩家状态的所有出边都留在未获胜区域，
  // 环境状态至少有一条出边留在未获胜区域（否则它已获胜）。
  const spoilerEdge = (u) => {
    // 返回 u 在反制子图中的第一条出边（确定性）；玩家取首边，环境取首条未获胜边
    for (const e of out[u]) {
      if (!win[e.to]) return e;
    }
    return null;
  };

  // 目标从起点是否可达（沿完整图 BFS）
  let targetReachable = false;
  {
    const seen = new Uint8Array(n);
    const q = [startIdx];
    seen[startIdx] = 1;
    let h = 0;
    while (h < q.length && !targetReachable) {
      const u = q[h++];
      if (isTarget[u]) { targetReachable = true; break; }
      for (const e of out[u]) {
        if (!seen[e.to]) { seen[e.to] = 1; q.push(e.to); }
      }
    }
  }

  // 反制子图中从起点 BFS：找最近的非目标死局（没有任何合法后继的终止状态）
  let deadendIdx = -1;
  const pred = new Int32Array(n).fill(-1);
  const predEdge = new Array(n).fill(null);
  {
    const seen = new Uint8Array(n);
    const q = [startIdx];
    seen[startIdx] = 1;
    let h = 0;
    while (h < q.length && deadendIdx === -1) {
      const u = q[h++];
      if (out[u].length === 0) { deadendIdx = u; break; } // 未获胜的终止状态必非目标
      for (const e of out[u]) {
        if (win[e.to] || seen[e.to]) continue;
        seen[e.to] = 1;
        pred[e.to] = u;
        predEdge[e.to] = e;
        q.push(e.to);
      }
    }
  }

  const edgeLabel = (from, e) => {
    const info = graph.labelInfo.get(e.uid) || {};
    return {
      kind: 'option',
      optionIndex: info.optionIndex != null ? info.optionIndex : null,
      optionUid: (e.uid && !e.uid.startsWith('idx:')) ? e.uid : null,
      optionText: info.text || '',
      fromSceneId: stateList[from].sceneId,
      target: stateList[e.to].sceneId,
      targetTitle: (sm.get(stateList[e.to].sceneId) || {}).title || '',
      controller: controller[from],
      stateAfter: decodeState(stateList[e.to].code, knownVars),
    };
  };
  const sceneLabel = (i, extra = {}) => ({
    kind: 'scene',
    sceneId: stateList[i].sceneId,
    title: (sm.get(stateList[i].sceneId) || {}).title || '',
    controller: controller[i],
    state: decodeState(stateList[i].code, knownVars),
    ...extra,
  });

  let failure;
  if (deadendIdx !== -1) {
    // 非目标死局：重建起点到死局的最短反制路线
    const trail = [];
    let cur = deadendIdx;
    while (cur !== -1) {
      trail.push(sceneLabel(cur, cur === deadendIdx ? { terminal: true } : {}));
      const p = pred[cur];
      if (p !== -1) trail.push(edgeLabel(p, predEdge[cur]));
      cur = p;
    }
    trail.reverse();
    failure = {
      reason: 'deadend',
      targetReachable,
      deadendScene: {
        sceneId: stateList[deadendIdx].sceneId,
        title: (sm.get(stateList[deadendIdx].sceneId) || {}).title || '',
      },
      witnessPath: trail,
      cycleScenes: null,
    };
  } else {
    // 没有死局：未获胜区域里只能无限绕圈。从起点沿反制子图确定性行走，
    // 有限图必有状态重复 => 得到一条进入循环的路线与循环本身。
    const walk = [];
    const firstSeenAt = new Map();
    let cur = startIdx;
    let cycleStart = -1;
    for (;;) {
      if (firstSeenAt.has(cur)) { cycleStart = firstSeenAt.get(cur); break; }
      firstSeenAt.set(cur, walk.length);
      walk.push(cur);
      const e = spoilerEdge(cur);
      if (!e) break; // 不会到达（死局已在上面处理），防御性退出
      cur = e.to;
    }
    const cycleNodes = cycleStart >= 0 ? walk.slice(cycleStart) : [];
    const cycleSceneIds = [];
    const seenScene = new Set();
    for (const i of cycleNodes) {
      const sid = stateList[i].sceneId;
      if (!seenScene.has(sid)) { seenScene.add(sid); cycleSceneIds.push(sid); }
    }
    // 见证路线：起点 -> 循环入口 -> 沿循环再走回入口（完整展示一圈）
    const route = cycleStart >= 0 ? [...walk, walk[cycleStart]] : walk;
    const inCycle = new Set(cycleNodes);
    const trail = [];
    route.forEach((nodeIdx, pos) => {
      trail.push(sceneLabel(nodeIdx, inCycle.has(nodeIdx) ? { inCycle: true } : {}));
      if (pos < route.length - 1) {
        const e = out[nodeIdx].find((x) => x.to === route[pos + 1] && !win[x.to]);
        if (e) trail.push(edgeLabel(nodeIdx, e));
      }
    });
    failure = {
      reason: targetReachable ? 'loop' : 'unreachable',
      targetReachable,
      deadendScene: null,
      witnessPath: trail,
      cycleScenes: cycleSceneIds.map((sid) => ({
        sceneId: sid,
        title: (sm.get(sid) || {}).title || '',
      })),
    };
  }

  let message;
  if (failure.reason === 'deadend') {
    message = `无法保证到达目标结局 "${targetScene}"：环境可以选择合法选项，把剧情引入非目标死局 `
      + `"${failure.deadendScene.sceneId}"（剧情在那里停滞，永远到不了目标）。`
      + '以下是一条环境反制的最短路线。';
  } else if (failure.reason === 'loop') {
    message = `无法保证到达目标结局 "${targetScene}"：目标虽然可达，但环境可以让剧情在循环中`
      + '无限停留（永不到达目标，无限绕圈不算成功）。以下展示一条进入循环的路线与循环涉及的场景。';
  } else {
    message = `无法保证到达目标结局 "${targetScene}"：已完整探索全部可达状态，`
      + '从起点没有任何路线到达目标结局。'
      + (failure.cycleScenes && failure.cycleScenes.length
        ? '剧情只能在以下场景间无限绕圈。' : '');
  }

  return {
    ...base,
    ok: false,
    status: 'unguaranteed',
    guaranteed: false,
    startBlocked: false,
    truncated: false,
    start,
    winningStates: [],
    winningStateCount: 0,
    failure,
    counts,
    statesExplored: graph.statesExplored,
    message,
  };
}

module.exports = { solveStrategy };
