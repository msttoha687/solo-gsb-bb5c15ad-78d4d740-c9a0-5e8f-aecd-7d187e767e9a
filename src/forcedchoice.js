'use strict';

/**
 * 结局必经抉择（Forced Ending Choices）
 *
 * 对编辑中的草稿展开「场景 + 完整变量状态」具体状态图后，针对每个**可达终止场景**
 * 回答：“无论玩家怎么走，要到达这个结局，都必定会经过哪些选项（按稳定 UID 标识）？
 * 它们在路线中的先后次序如何？首次到达该结局的最短见证路径长什么样？”
 *
 * 终止具体状态 = 该状态下没有任何「条件成立且目标可进入」的选项：
 *   - 所在场景本身没有选项            => 设计结局（ending）
 *   - 场景有选项但全部不可走          => 死局软锁（deadend）
 * 同一结束场景可能对应多个不同变量状态的终止节点（同场景多状态）。
 *
 * 必经判定（不是枚举固定深度路径！）：
 *   某选项 UID 对结局 T 必经，当且仅当**每一条**从起点出发、到达 T 中任意终止
 *   具体状态的路线上都出现了该选项。等价地：在「能到达 T 的存活子图」上做
 *   标签数据流的最大不动点——
 *       F(v) = 所有到达 v 的路线共同携带的选项标签集合
 *            = ⋂_{(u --L--> v) ∈ 入边} (F(u) ∪ {L})
 *   起点 F(s) = ∅（空路线不经过任何选项；环上回到起点的路线不改变该初值）。
 *   以全集初始化、按逆边做 worklist 单调收缩（只做集合交），每个节点的取值在
 *   有限标签幂集上单调下降，故**含任意环路都必然收敛终止**；
 *   结局 T 的必经标签 = ⋂_{t ∈ T} F(t)。这是对全部（有限长度）路线的精确结论，
 *   与“枚举到某个深度”无关，同场景多状态通过终止节点集合的交集一并正确处理。
 *
 * 必经次序：所有必经选项都出现在每条到达路线上，任取一条到达路线即可读出它们
 * 的相对先后（不同路线间相对次序不一致的两个标签不可能同为必经——否则会出现
 * “u 在 v 前”与“v 在 u 前”两条路线，取另一路线即构成绕开反例）。这里取 BFS
 * 首次发现的终止节点的最短路线（最短见证路径），按标签在该路径上首次出现的
 * 位置排序。
 *
 * 状态上限截断时：图未展开完，任何必经 / 非必经结论都可能被未探索区域推翻，
 * 结果以 canAssertForced=false 标明且不下必经结论（forcedOptions=null）。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * 展开「场景 + 完整变量状态」具体状态图（与分析器 / 路径查询 / 覆盖路线一致：
 * 条件不成立、悬空跳转、目标前置不成立的选项不构成边；按 场景ID+位图 去重，
 * 含环必然终止，超过 maxStates 截断）。
 *
 * 返回图结构供必经分析与绕开反例 BFS 复用：
 *   stateList[i] = { sceneId, code }
 *   out[i]       = [{ to, uid, edge }]，(from,to,uid) 三元组去重
 *   parent       = stateKey -> { parentKey, depth, edge, sceneId, code }（BFS 树）
 *   terminals    = 终止具体状态索引数组；terminalByScene: sceneId -> [index]
 *   labelInfo    = uid(标签) -> { sceneId, optionIndex, text, target }
 */
function expandGraph(storyInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法分析结局必经抉择');
  }

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

  const stateList = [];
  const stateIndex = new Map();                 // `${sceneId}\x00${code}` -> 节点号
  const out = [];                              // 节点号 -> [{to, uid, edge}]
  const edgeSeen = [];                         // 节点号 -> Set(`${to}\x00${uid}`)
  const parent = new Map();
  const queue = [];
  const labelInfo = new Map();
  const terminalByScene = new Map();
  const terminals = [];
  let truncated = false;
  let statesExplored = 0;
  let transitionCount = 0;

  const keyOf = (sceneId, code) => `${sceneId}\x00${code}`;
  const getOrCreate = (sceneId, code, depth, predKey, edge) => {
    const key = keyOf(sceneId, code);
    const hit = stateIndex.get(key);
    if (hit !== undefined) return hit;
    const idx = stateList.length;
    stateList.push({ sceneId, code });
    stateIndex.set(key, idx);
    out.push([]);
    edgeSeen.push(new Set());
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, code });
    statesExplored++;
    if (statesExplored > maxStates) { truncated = true; return idx; }
    queue.push(idx);
    return idx;
  };

  // 起点：初始状态 = 起点场景的进入赋值；前置不成立则没有任何可达状态
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (startBlocked) {
    return {
      truncated: false, startBlocked: true, startScene: story.startScene,
      stateList, out, parent, terminals, terminalByScene, labelInfo,
      statesExplored, maxStates, transitionCount, knownVars, conditionErrors, sceneMap,
    };
  }
  const startIdx = getOrCreate(story.startScene, encodeState(startState, knownVars), 0, null, null);

  let head = 0;
  while (head < queue.length && !truncated) {
    const cur = queue[head++];
    const { sceneId, code } = stateList[cur];
    const scene = sceneMap.get(sceneId);
    const state = decodeState(code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated) return;
      const oc = optionCompiled.get(`${sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 条件不成立：此状态下不可走
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：不构成边
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return;            // 入口前置不成立：不构成边

      // 选项稳定身份：优先 uid，旧数据退回 场景ID#下标（与其余模块一致）
      const uid = (option && option.uid) || `idx:${sceneId}#${idx}`;
      const nextCode = encodeState(nextState, knownVars);
      const to = getOrCreate(targetId, nextCode, parent.get(keyOf(sceneId, code)).depth + 1,
        keyOf(sceneId, code), {
          optionIndex: idx,
          optionUid: (option && option.uid) || null,
          optionText: (option && option.text) || '',
          fromSceneId: sceneId,
          target: targetId,
          targetTitle: (sceneMap.get(targetId) || {}).title || '',
        });
      if (truncated) return;

      if (!labelInfo.has(uid)) {
        labelInfo.set(uid, {
          uid, sceneId, optionIndex: idx,
          text: (option && option.text) || '', target: targetId,
        });
      }
      const dedupeKey = `${to}\x00${uid}`;
      if (!edgeSeen[cur].has(dedupeKey)) {
        edgeSeen[cur].add(dedupeKey);
        out[cur].push({ to, uid });
        transitionCount++;
      }
    });
  }

  // 终止具体状态：没有任何可走边。截断时只统计**已处理**（出边已枚举完）的节点——
  // 未处理节点的 out 为空只是“还没扩展”，不能误判为终止。
  const processedCount = truncated ? head : stateList.length;
  for (let i = 0; i < processedCount; i++) {
    if (out[i].length === 0) {
      terminals.push(i);
      const sid = stateList[i].sceneId;
      if (!terminalByScene.has(sid)) terminalByScene.set(sid, []);
      terminalByScene.get(sid).push(i);
    }
  }

  return {
    truncated, startBlocked: false, startScene: story.startScene,
    stateList, out, parent, terminals, terminalByScene, labelInfo,
    statesExplored, maxStates, transitionCount, knownVars, conditionErrors, sceneMap,
    startIdx,
  };
}

/** 沿 BFS 父指针重建 scene / option 交替路径（与覆盖路线的路径格式一致） */
function buildBfsPath(graph, nodeIdx) {
  const { stateList, parent, sceneMap, knownVars } = graph;
  const trail = [];
  let key = `${stateList[nodeIdx].sceneId}\x00${stateList[nodeIdx].code}`;
  while (key) {
    const p = parent.get(key);
    const sceneId = p.sceneId;
    const sc = sceneMap.get(sceneId);
    trail.push({ kind: 'scene', sceneId, title: sc ? (sc.title || '') : '', state: decodeState(p.code, knownVars) });
    if (p.edge) trail.push({ kind: 'option', ...p.edge, stateAfter: decodeState(p.code, knownVars) });
    key = p.parentKey;
  }
  trail.reverse();
  return trail;
}

/**
 * 在已展开的图上计算某结局（终止节点集合 targetNodes）的必经选项。
 * 使用标签数据流最大不动点（见模块头注释），返回 { forcedBits, labels, live }。
 */
function computeForced(graph, targetNodes) {
  const { stateList, out, startIdx } = graph;
  const n = stateList.length;

  // 存活子图：能到达任一终止节点的节点（逆图可达）；非存活节点上的边不参与结论
  const radjAll = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) {
    for (const e of out[u]) radjAll[e.to].push({ u, uid: e.uid });
  }
  const live = new Uint8Array(n);
  const revQueue = [...targetNodes];
  for (const t of targetNodes) live[t] = 1;
  let qh = 0;
  while (qh < revQueue.length) {
    const v = revQueue[qh++];
    for (const { u } of radjAll[v]) {
      if (!live[u]) { live[u] = 1; revQueue.push(u); }
    }
  }

  // 标签全集 = 存活子图内部边上出现过的选项 UID（进入存活节点的边必来自存活节点）
  const labels = [];
  const labelBit = new Map();
  for (let u = 0; u < n; u++) {
    if (!live[u]) continue;
    for (const e of out[u]) {
      if (live[e.to] && !labelBit.has(e.uid)) {
        labelBit.set(e.uid, BigInt(labels.length));
        labels.push(e.uid);
      }
    }
  }
  const m = labels.length;
  const universe = (1n << BigInt(m)) - 1n;
  const bitOf = (uid) => 1n << labelBit.get(uid);

  // 仅保留存活子图内部的逆边
  const radj = Array.from({ length: n }, () => []);
  const sadj = Array.from({ length: n }, () => []); // 存活子图顺边（用于 worklist 传播）
  for (let u = 0; u < n; u++) {
    if (!live[u]) continue;
    for (const e of out[u]) {
      if (!live[e.to]) continue;
      radj[e.to].push({ u, bit: bitOf(e.uid) });
      sadj[u].push(e.to);
    }
  }

  // 最大不动点：F(起点)=∅；其余初始化为全集，按逆边交收缩直到不变。
  // 用普通 bigint 数组（而非 BigInt64Array），选项数超过 63 时位集仍可扩展。
  const F = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) if (live[i] && i !== startIdx) F[i] = universe;

  const worklist = [];
  for (let i = 0; i < n; i++) if (live[i] && i !== startIdx) worklist.push(i);
  let w = 0;
  while (w < worklist.length) {
    const v = worklist[w++];
    let acc = universe;
    for (const { u, bit } of radj[v]) acc &= F[u] | bit;
    if (acc !== F[v]) {
      F[v] = acc;
      for (const t of sadj[v]) {
        if (t !== startIdx) worklist.push(t);
      }
    }
  }

  // 结局必经 = 到达每个终止具体状态的共同标签（同场景多状态取交集）
  let forcedBits = universe;
  for (const t of targetNodes) forcedBits &= F[t];
  if (!targetNodes.length) forcedBits = 0n;

  return { forcedBits, labels, live };
}

/**
 * 对剧情（草稿或已保存）分析每个可达终止场景的结局必经抉择。
 *
 * @param storyInput 剧情对象
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function analyzeForcedChoices(storyInput, opts = {}) {
  const graph = expandGraph(storyInput, opts);
  const { startScene, knownVars, conditionErrors } = graph;

  if (graph.startBlocked) {
    return {
      ok: true,
      truncated: false,
      complete: true,
      canAssertForced: true,
      startBlocked: true,
      startScene,
      counts: { states: 0, transitions: 0, endings: 0, forcedOptions: 0, labels: 0, variables: knownVars.length },
      endings: [],
      knownVars,
      conditionErrors,
      statesExplored: 0,
      maxStates: graph.maxStates,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可达结局。',
    };
  }

  const { truncated, stateList, terminalByScene, labelInfo } = graph;

  if (truncated) {
    // 图未展开完：已发现的终止场景照常列出，但一律不下必经结论
    const partialEndings = [];
    for (const [sceneId, nodes] of terminalByScene.entries()) {
      const scene = graph.sceneMap.get(sceneId);
      partialEndings.push({
        sceneId,
        title: scene ? (scene.title || '') : '',
        kind: (scene.options || []).length === 0 ? 'ending' : 'deadend',
        reliable: false,
        states: nodes.length,
        forcedCount: null,
        forcedOptions: null,
        candidateOptions: null,
        witnessDepth: null,
        witnessPath: null,
        finalState: null,
      });
    }
    partialEndings.sort((a, b) => a.sceneId.localeCompare(b.sceneId));
    return {
      ok: false,
      truncated: true,
      complete: false,
      canAssertForced: false, // 截断时不得下必经结论
      startBlocked: false,
      startScene,
      counts: {
        states: stateList.length,
        transitions: graph.transitionCount,
        endings: partialEndings.length,
        forcedOptions: null,
        labels: labelInfo.size,
        variables: knownVars.length,
      },
      endings: partialEndings,
      knownVars,
      conditionErrors,
      statesExplored: graph.statesExplored,
      maxStates: graph.maxStates,
      message: `具体状态数量超过安全上限（${graph.maxStates}），分析在展开完整状态图前被截断：`
        + '未探索区域可能存在新的到达路线，以下结局的必经选项结论一律不可靠，未输出必经选项。'
        + '请减少变量数量后重试。',
    };
  }

  // ---- 完整展开：对每个可达终止场景计算必经选项 ----
  const endings = [];
  let forcedTotal = 0;
  for (const [sceneId, nodes] of terminalByScene.entries()) {
    const scene = graph.sceneMap.get(sceneId);
    const kind = (scene.options || []).length === 0 ? 'ending' : 'deadend';
    const { forcedBits, labels } = computeForced(graph, nodes);

    // 最短见证路径：BFS 父指针深度最小的终止节点（nodes 按 BFS 发现顺序排列，取首个）
    let nearest = nodes[0];
    let nearestDepth = Infinity;
    for (const t of nodes) {
      const key = `${stateList[t].sceneId}\x00${stateList[t].code}`;
      const d = graph.parent.get(key).depth;
      if (d < nearestDepth) { nearestDepth = d; nearest = t; }
    }
    const witnessPath = buildBfsPath(graph, nearest);

    // 必经次序：标签在最短见证路径上首次出现的位置（必经标签必出现在该路径上）
    const firstPos = new Map();
    witnessPath.forEach((node, i) => {
      if (node.kind === 'option') {
        const uid = node.optionUid
          || (node.fromSceneId != null && node.optionIndex != null
            ? `idx:${node.fromSceneId}#${node.optionIndex}` : null);
        if (uid && !firstPos.has(uid)) firstPos.set(uid, i);
      }
    });

    const forcedUids = [];
    for (let i = 0; i < labels.length; i++) {
      if ((forcedBits >> BigInt(i)) & 1n) forcedUids.push(labels[i]);
    }
    forcedUids.sort((a, b) => (firstPos.get(a) ?? Infinity) - (firstPos.get(b) ?? Infinity)
      || a.localeCompare(b));

    // 该结局存活子图（能到达该结局的状态）上的全部选项标签：
    // 非必经选项未必出现在最短见证路径上，反例候选需要这一完整集合。
    const forcedSet = new Set(forcedUids);
    const candidateOptions = labels
      .filter((uid) => !forcedSet.has(uid))
      .map((uid) => {
        const info = labelInfo.get(uid) || { uid, sceneId: '', optionIndex: null, text: '', target: '' };
        return {
          uid,
          sceneId: info.sceneId,
          optionIndex: info.optionIndex,
          text: info.text,
          target: info.target,
        };
      })
      .sort((a, b) => a.sceneId.localeCompare(b.sceneId)
        || (a.optionIndex ?? 0) - (b.optionIndex ?? 0) || a.uid.localeCompare(b.uid));

    const forcedOptions = forcedUids.map((uid, i) => {
      const info = labelInfo.get(uid) || { uid, sceneId: '', optionIndex: null, text: '', target: '' };
      return {
        order: i + 1,
        uid,
        sceneId: info.sceneId,
        optionIndex: info.optionIndex,
        text: info.text,
        target: info.target,
      };
    });
    forcedTotal += forcedOptions.length;

    const endKey = `${stateList[nearest].sceneId}\x00${stateList[nearest].code}`;
    endings.push({
      sceneId,
      title: scene ? (scene.title || '') : '',
      kind,
      reliable: true,
      states: nodes.length,
      forcedCount: forcedOptions.length,
      forcedOptions,
      candidateOptions,
      witnessDepth: nearestDepth,
      witnessPath,
      finalState: decodeState(stateList[nearest].code, knownVars),
    });
  }

  // 设计结局在前、死局在后；同类按场景 ID 确定排序（结果无随机性）
  endings.sort((a, b) => (a.kind === b.kind ? a.sceneId.localeCompare(b.sceneId)
    : (a.kind === 'ending' ? -1 : 1)));

  const endingCount = endings.filter((e) => e.kind === 'ending').length;
  const deadendCount = endings.length - endingCount;
  const message = `已穷举全部 ${stateList.length} 个可达具体状态：`
    + `${endingCount} 个设计结局、${deadendCount} 个死局结局，`
    + (forcedTotal
      ? `各结局路线共识别出 ${forcedTotal} 个（结局 × 选项）必经抉择。`
      : '不存在任何“必选”的选项——每个结局都有至少两条不同选项路线可达（或结局就在起点）。');

  return {
    ok: true,
    truncated: false,
    complete: true,
    canAssertForced: true,
    startBlocked: false,
    startScene,
    counts: {
      states: stateList.length,
      transitions: graph.transitionCount,
      endings: endings.length,
      forcedOptions: forcedTotal,
      labels: labelInfo.size,
      variables: knownVars.length,
    },
    endings,
    knownVars,
    conditionErrors,
    statesExplored: graph.statesExplored,
    maxStates: graph.maxStates,
    message,
  };
}

/**
 * 绕开反例：求一条**不经过指定选项 UID** 仍能到达指定终止场景的最短路线。
 *
 * 若该选项本就是该结局的必经选项，则完整穷举后仍找不到（unavoidable=true）；
 * 非必经时必然能找到（found=true，返回最短路线）。
 * 状态上限截断时找不到也不能断言必经（canAssertUnavoidable=false）。
 *
 * @param storyInput  剧情对象
 * @param endingScene  目标终止场景 ID
 * @param uid          要绕开的选项 UID（缺失 uid 的旧选项用 idx:场景#下标）
 * @param opts         { maxStates }
 */
function bypassForced(storyInput, endingScene, uid, opts = {}) {
  const sceneId0 = String(endingScene || '').trim();
  const skipUid = String(uid || '').trim();
  if (!sceneId0) throw badRequest('缺少目标终止场景 endingScene');
  if (!skipUid) throw badRequest('缺少要绕开的选项 UID');

  const graph = expandGraph(storyInput, opts);
  if (graph.startBlocked) {
    throw badRequest('起点场景的前置条件在初始状态下不成立，剧情无法开始');
  }
  if (!graph.sceneMap.has(sceneId0)) throw badRequest(`终止场景 "${sceneId0}" 不存在`);
  if (!graph.labelInfo.has(skipUid)) throw badRequest(`选项 UID "${skipUid}" 不存在`);

  const targetNodes = graph.terminalByScene.get(sceneId0);
  if (!targetNodes || !targetNodes.length) {
    throw badRequest(`场景 "${sceneId0}" 不是可达的终止场景（没有任何可到达的终止状态），无法查询绕开路线`);
  }

  const option = graph.labelInfo.get(skipUid);
  const scene = graph.sceneMap.get(sceneId0);
  const base = {
    endingScene: sceneId0,
    endingTitle: scene ? (scene.title || '') : '',
    uid: skipUid,
    option: {
      uid: skipUid,
      sceneId: option.sceneId,
      optionIndex: option.optionIndex,
      text: option.text,
      target: option.target,
    },
    truncated: graph.truncated,
  };

  if (graph.truncated) {
    return {
      ...base,
      found: false,
      canAssertUnavoidable: false,
      depth: null,
      path: null,
      finalState: null,
      statesExplored: graph.statesExplored,
      maxStates: graph.maxStates,
      message: `状态图展开达到上限（${graph.maxStates}）被截断：在已探索范围内没有找到绕开该选项的路线，`
        + '但未探索区域可能存在，不能断言该选项必经。',
    };
  }

  // 在完整图上 BFS：跳过所有标签为 skipUid 的边（同 UID 可能出现在多条边上）
  const { stateList, out, startIdx, knownVars } = graph;
  const goalSet = new Set(targetNodes);
  const seen = new Uint8Array(stateList.length);
  const pred = new Int32Array(stateList.length).fill(-1);
  const predEdgeUid = new Array(stateList.length).fill(null);
  const bfsQueue = [startIdx];
  seen[startIdx] = 1;
  let goal = goalSet.has(startIdx) ? startIdx : -1;
  let h = 0;
  let explored = 0;
  while (h < bfsQueue.length && goal === -1) {
    const cur = bfsQueue[h++];
    explored++;
    for (const e of out[cur]) {
      if (e.uid === skipUid) continue; // 绕开：该选项的所有边都不走
      if (seen[e.to]) continue;
      seen[e.to] = 1;
      pred[e.to] = cur;
      predEdgeUid[e.to] = e.uid;
      if (goalSet.has(e.to)) { goal = e.to; break; }
      bfsQueue.push(e.to);
    }
  }

  if (goal === -1) {
    return {
      ...base,
      found: false,
      canAssertUnavoidable: true, // 完整穷举后仍不可绕开 => 确为必经
      depth: null,
      path: null,
      finalState: null,
      statesExplored: explored,
      maxStates: graph.maxStates,
      message: `已穷举全部可达状态：不存在绕开选项「${option.text || skipUid}」仍能到达 "${sceneId0}" 的路线，`
        + '该选项确实是此结局的必经选项。',
    };
  }

  // 沿 BFS 父指针重建路径，并补回每条边的展示信息
  const path = [];
  let cur = goal;
  while (cur !== startIdx) {
    const p = pred[cur];
    const sc = graph.sceneMap.get(stateList[cur].sceneId);
    path.push({
      kind: 'scene', sceneId: stateList[cur].sceneId,
      title: sc ? (sc.title || '') : '',
      state: decodeState(stateList[cur].code, knownVars),
    });
    const edgeUid = predEdgeUid[cur];
    const info = graph.labelInfo.get(edgeUid) || {};
    // 找到 p -> cur 的实际边，取选项定位（idx 兜底标签也覆盖）
    const edge = out[p].find((e) => e.to === cur && e.uid === edgeUid);
    path.push({
      kind: 'option',
      optionIndex: info.optionIndex != null ? info.optionIndex : null,
      optionUid: edgeUid.startsWith('idx:') ? null : edgeUid,
      optionText: info.text || '',
      fromSceneId: info.sceneId || (edge ? stateList[p].sceneId : ''),
      target: stateList[cur].sceneId,
      targetTitle: (graph.sceneMap.get(stateList[cur].sceneId) || {}).title || '',
      stateAfter: decodeState(stateList[cur].code, knownVars),
    });
    cur = p;
  }
  path.push({
    kind: 'scene',
    sceneId: stateList[startIdx].sceneId,
    title: (graph.sceneMap.get(stateList[startIdx].sceneId) || {}).title || '',
    state: decodeState(stateList[startIdx].code, knownVars),
  });
  path.reverse();
  const depth = path.filter((n) => n.kind === 'option').length;

  return {
    ...base,
    found: true,
    canAssertUnavoidable: false,
    depth,
    path,
    finalState: decodeState(stateList[goal].code, knownVars),
    statesExplored: explored,
    maxStates: graph.maxStates,
    message: `存在绕开选项「${option.text || skipUid}」仍到达结局 "${sceneId0}" 的路线（${depth} 步）：`
      + '该选项不是必经选项，以下为最短反例路线。',
  };
}

module.exports = { analyzeForcedChoices, bypassForced, expandGraph };
