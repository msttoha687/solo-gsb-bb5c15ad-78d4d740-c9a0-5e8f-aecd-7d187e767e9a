'use strict';

/**
 * 变量赋值消费审计（Assignment Consumption Audit）
 *
 * 对编辑中的未保存草稿（不落盘）回答：“每一处**场景进入赋值**与**选项赋值**写入的
 * 变量值，在**再次被赋值或路线结束之前**，是否被后续条件（选项条件 / 场景前置条件）
 * 引用过？”——即沿全部可走路线的 def-use（定义-使用）审计，帮助作者发现
 * “写了却没人读”的死赋值（可删除或说明遗漏了条件分支）。
 *
 * 语义与一致性分析器完全一致：
 *   - **选项条件先于本选项赋值**求值：选项自己的赋值不会被自己的条件读到；
 *   - **目标场景进入赋值先于其前置条件**求值：场景自己的进入赋值可能被自己的
 *     前置条件读到（即使前置条件最终不成立、入口被挡，引用也已经发生）；
 *   - 悬空跳转（无目标 / 目标不存在）不构成边，其选项赋值不会执行；
 *   - 条件语法错误按恒真处理（与其余模块一致），记录到 conditionErrors。
 *
 * **短路读取**：条件按 JavaScript 的 && / || / ! 短路语义自左向右真实求值，
 * 只有求值过程中**实际读取**的变量才计入消费——`x || y` 在 x 为 true 时只读
 * x（y 被短路，不会被记为消费），`x && y` 在 x 为 false 时只读 x；! 与括号
 * 不改变短路顺序。读取只归到当时该变量「最后一次赋值」的来源 def；即使该次
 * 求值整体为 false（选项不可走 / 入口被挡），求值中已经发生的读取仍然有效。
 *
 * 实现：把「每个变量最后由哪处赋值写入」并入遍历去重键——
 *     状态键 = (场景 ID, 每个变量的最后赋值来源 def 向量)
 * 由于每处赋值写入的是常量，变量取值位图可由 def 向量直接推出；def 向量空间
 * 至多 ∏(该变量赋值位置数 + 1)，有限，因此含任意环路都必然终止（沿用约 100 万
 * 状态安全上限，超限截断）。BFS 过程中每次求值条件时，按真实短路顺序被读取的
 * 变量当前的来源 def 即被“消费”一次；同一赋值位置在不同可达状态下**只要存在
 * 一次有效引用即算已消费**。首次引用按选项步数取最短（BFS 逐层展开 + 更短见证
 * 替换），并为已消费项重建到首次引用的最短可走路线。
 *
 * 截断安全：状态上限截断时，尚未被证实消费的赋值一律标记为 **unknown（未知）**，
 * 绝不能判为“未消费”；已被证实的消费结论仍然确凿（路线真实可走）。
 */

const { compile } = require('./expression');
const { collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * 对剧情（草稿或已保存）运行变量赋值消费审计。
 *
 * @param storyInput 剧情对象
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function auditAssignments(storyInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法进行赋值消费审计');
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

  // ---- 赋值位置（def）枚举：场景进入赋值 + 选项赋值，按剧情书写顺序编号 ----
  const defs = []; // { id, kind, sceneId, optionIndex?, optionUid?, optionText?, assignIndex, variable, value }
  const sceneAssignDefs = new Map(); // sceneId -> [defId,...]（按赋值书写顺序）
  const optionAssignDefs = new Map(); // `${sceneId}#${idx}` -> [defId,...]
  const sceneCond = new Map();       // sceneId -> compiled | null
  const optionCond = new Map();      // optKey -> compiled | null

  for (const scene of sceneMap.values()) {
    const pc = safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`);
    sceneCond.set(scene.id, pc);

    const sIds = [];
    (scene.assigns || []).filter((a) => a && a.variable).forEach((a, ai) => {
      const id = defs.length + 1;
      defs.push({
        id, kind: 'scene', sceneId: scene.id, assignIndex: ai,
        variable: a.variable, value: !!a.value,
      });
      sIds.push(id);
    });
    sceneAssignDefs.set(scene.id, sIds);

    (scene.options || []).forEach((opt, idx) => {
      const optKey = `${scene.id}#${idx}`;
      const oc = safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`);
      optionCond.set(optKey, oc);
      const oIds = [];
      ((opt && opt.assigns) || []).filter((a) => a && a.variable).forEach((a, ai) => {
        const id = defs.length + 1;
        defs.push({
          id, kind: 'option', sceneId: scene.id, optionIndex: idx,
          optionUid: (opt && opt.uid) || null, optionText: (opt && opt.text) || '',
          assignIndex: ai, variable: a.variable, value: !!a.value,
        });
        oIds.push(id);
      });
      optionAssignDefs.set(optKey, oIds);
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });

  // 每个拥有至少一处赋值的变量占一个 def 向量槽位；槽位值 = 最后写入该变量的 def id（0 = 初始值）
  const slotOfVar = new Map();
  const defSlot = [0]; // defId -> slot（1-based）
  for (const def of defs) {
    if (!slotOfVar.has(def.variable)) slotOfVar.set(def.variable, slotOfVar.size);
    defSlot[def.id] = slotOfVar.get(def.variable);
  }
  const slotCount = slotOfVar.size;
  const defById = [null, ...defs]; // 1-based

  // 由 def 向量还原完整变量取值：某变量的值 = 最后写入它的赋值位置的常量；从未赋值 = false
  const deriveState = (vec) => {
    const st = {};
    for (const v of knownVars) st[v] = false;
    for (let i = 0; i < slotCount; i++) {
      if (vec[i]) st[defById[vec[i]].variable] = defById[vec[i]].value;
    }
    return st;
  };

  // ---- BFS：状态键 = 场景 ID \x00 每变量最后赋值来源向量 ----
  const visited = new Set();
  const parent = new Map(); // key -> { parentKey, depth, edge, sceneId, vec }
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let transitionCount = 0;

  const reachedDefs = new Set();  // 至少执行过一次的赋值位置
  const consumedBest = new Map(); // defId -> { readDepth, stateKey, reader, edge, stateAtRead, readVars, skippedVars }
  const sceneEntered = new Set(); // 成功进入过的场景

  const keyOf = (sceneId, vec) => `${sceneId}\x00${vec.join(',')}`;

  const offer = (sceneId, vec, depth, predKey, edge) => {
    const key = keyOf(sceneId, vec);
    if (visited.has(key)) return false;
    visited.add(key);
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, vec });
    statesExplored++;
    if (statesExplored > maxStates) { truncated = true; return false; }
    queue.push(key);
    return true;
  };

  // 一次条件求值后，按真实短路顺序记录其中的引用：
  // reads 只包含本次求值**实际读取**的变量（被 &&/|| 短路跳过的子式变量不在其中），
  // 每个被读变量当前的来源 def 即被消费。同一 def 只保留选项步数最短的见证
  //（BFS 逐层展开，发现更短见证时替换）。
  const markReads = (vec, reads, compiled, readDepth, stateKey, reader, edge, stateAtRead) => {
    // 同一条件里重复读取同一变量只计一次，保留首次读取顺序
    const readVars = [];
    for (const v of reads) {
      if (!readVars.includes(v)) readVars.push(v);
    }
    // 条件中出现、但本次被短路跳过的变量（仅用于见证展示，不构成消费）
    const skippedVars = compiled
      ? [...compiled.vars()].filter((v) => !readVars.includes(v))
      : [];
    for (const v of readVars) {
      const slot = slotOfVar.get(v);
      if (slot === undefined) continue; // 从未被任何赋值设置的变量：读到的是初始值
      const defId = vec[slot];
      if (!defId) continue;             // 初始值（尚未被任何赋值写入）
      const rec = consumedBest.get(defId);
      if (!rec || readDepth < rec.readDepth) {
        consumedBest.set(defId, { readDepth, stateKey, reader, edge, stateAtRead, readVars, skippedVars });
      }
    }
  };

  // 按真实短路顺序求条件并记录读取：语法错误按恒真处理（无任何读取），
  // 返回条件取值（供调用方决定选项是否可走 / 入口是否被挡）。
  const evalAndMark = (compiled, state, vec, readDepth, stateKey, reader, edge) => {
    if (!compiled) return true;
    const { value, reads } = compiled.evaluateTracked(state);
    markReads(vec, reads, compiled, readDepth, stateKey, reader, edge, state);
    return value;
  };

  // ---- 起点：初始 def 向量全 0（全部初始值），先执行起点场景的进入赋值 ----
  const startVec = new Array(slotCount).fill(0);
  for (const defId of sceneAssignDefs.get(story.startScene) || []) {
    startVec[defSlot[defId]] = defId;
    reachedDefs.add(defId);
  }
  const startState = deriveState(startVec);
  const startPc = sceneCond.get(story.startScene);
  // 起点前置条件在起点进入赋值之后、按真实短路顺序求值；即使结果为假（起点受阻），
  // 求值中已经发生的读取也会被记录——但起点受阻时审计整体不产出逐项结果。
  const startValue = startPc ? startPc.evaluateTracked(startState) : { value: true, reads: [] };
  const startBlocked = !startValue.value;

  const base = {
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
      assignments: [],
      summary: {
        total: defs.length, reachable: 0, consumed: 0, unconsumed: 0, unknown: 0, unreachable: 0,
      },
      counts: { states: 0, transitions: 0, variables: knownVars.length },
      statesExplored: 0,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，无法进行赋值消费审计。',
    };
  }

  const startKey = keyOf(story.startScene, startVec);
  offer(story.startScene, startVec, 0, null, null);
  sceneEntered.add(story.startScene);
  // 记录起点前置条件求值中按真实短路顺序发生的读取（消费起点进入赋值）
  markReads(startVec, startValue.reads, startPc, 0, startKey, {
    kind: 'scene-precondition',
    sceneId: story.startScene,
    sceneTitle: (sceneMap.get(story.startScene) || {}).title || '',
    condition: (sceneMap.get(story.startScene).precondition || '').trim(),
  }, null, startState);

  let head = 0;
  while (head < queue.length && !truncated) {
    const curKey = queue[head++];
    const cur = parent.get(curKey);
    const scene = sceneMap.get(cur.sceneId);
    const state = deriveState(cur.vec);

    (scene.options || []).forEach((option, idx) => {
      if (truncated) return;
      const optKey = `${cur.sceneId}#${idx}`;
      // 1) 选项条件先于本选项赋值、按真实短路顺序求值：条件中实际读到的引用消费当前来源
      const reader = {
        kind: 'option-condition',
        sceneId: cur.sceneId,
        sceneTitle: (sceneMap.get(cur.sceneId) || {}).title || '',
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        condition: ((option && option.condition) || '').trim(),
      };
      const condValue = evalAndMark(optionCond.get(optKey), state, cur.vec, cur.depth, curKey, reader, null);
      // 2) 条件不成立：此具体状态下该选项不可走（条件求值中的读取已经计入）
      if (!condValue) return;
      // 3) 悬空跳转：不构成边，其赋值不会执行
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;
      // 4) 选项赋值
      const newVec = cur.vec.slice();
      for (const defId of optionAssignDefs.get(optKey) || []) {
        newVec[defSlot[defId]] = defId;
        reachedDefs.add(defId);
      }
      // 5) 目标场景进入赋值（先于其前置条件）
      for (const defId of sceneAssignDefs.get(targetId) || []) {
        newVec[defSlot[defId]] = defId;
        reachedDefs.add(defId);
      }
      const nextState = deriveState(newVec);
      const edge = {
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        fromSceneId: cur.sceneId,
        target: targetId,
        targetTitle: (sceneMap.get(targetId) || {}).title || '',
      };
      // 6) 目标场景前置条件按真实短路顺序求值：实际读到的引用消费赋值后的来源
      //（即使入口被挡，求值中已经发生的读取仍须计入）
      const pcValue = evalAndMark(sceneCond.get(targetId), nextState, newVec, cur.depth + 1, curKey, {
        kind: 'scene-precondition',
        sceneId: targetId,
        sceneTitle: (sceneMap.get(targetId) || {}).title || '',
        condition: (sceneMap.get(targetId).precondition || '').trim(),
      }, edge);
      // 7) 入口前置不成立：不构成边
      if (!pcValue) return;
      const offered = offer(targetId, newVec, cur.depth + 1, curKey, edge);
      if (offered) {
        transitionCount++;
        sceneEntered.add(targetId);
      }
    });
  }

  // ---- 路径重建：从见证状态沿父指针回溯，场景 / 选项交替 ----
  const buildTrail = (stateKey) => {
    const trail = [];
    let k = stateKey;
    while (k) {
      const p = parent.get(k);
      const sc = sceneMap.get(p.sceneId);
      trail.push({
        kind: 'scene',
        sceneId: p.sceneId,
        title: sc ? (sc.title || '') : '',
        state: deriveState(p.vec),
      });
      if (p.edge) {
        trail.push({ kind: 'option', ...p.edge, stateAfter: deriveState(p.vec) });
      }
      k = p.parentKey;
    }
    trail.reverse();
    return trail;
  };

  // ---- 逐赋值位置汇总 ----
  const assignments = defs.map((def) => {
    const scene = sceneMap.get(def.sceneId);
    const label = def.kind === 'scene'
      ? `场景 "${def.sceneId}" 的进入赋值 #${def.assignIndex + 1}`
      : `场景 "${def.sceneId}" 选项 ${def.optionIndex + 1}`
        + `${def.optionText ? `「${def.optionText}」` : ''}的赋值 #${def.assignIndex + 1}`;
    const reachable = reachedDefs.has(def.id);
    const rec = consumedBest.get(def.id);

    let status;
    if (rec) status = 'consumed';
    else if (!reachable) status = truncated ? 'unknown' : 'unreachable';
    else status = truncated ? 'unknown' : 'unconsumed';

    let reason = null;
    if (status === 'unreachable') {
      if (def.kind === 'scene') {
        reason = `场景 "${def.sceneId}" 从未进入，该进入赋值从未执行`;
      } else if (!sceneEntered.has(def.sceneId)) {
        reason = `所在场景 "${def.sceneId}" 从未进入，该选项赋值从未执行`;
      } else {
        reason = '该选项从未可走（条件恒假 / 目标悬空 / 入口恒受阻），其赋值从未执行';
      }
    }

    let reference = null;
    if (rec) {
      const path = buildTrail(rec.stateKey);
      // 场景前置条件的引用发生在沿边跳转之后：把这条边并入路线
      if (rec.edge) path.push({ kind: 'option', ...rec.edge, stateAfter: rec.stateAtRead });
      reference = {
        variable: def.variable,
        depth: rec.readDepth,
        reader: rec.reader,
        // 该次条件求值中按真实短路顺序实际读取的变量（去重、保留首次读取次序）
        readVariables: rec.readVars,
        // 条件中出现但被短路跳过、当次未读取的变量
        skippedVariables: rec.skippedVars,
        path,
        stateAtRead: rec.stateAtRead,
      };
    }

    const item = {
      id: def.id,
      kind: def.kind,
      sceneId: def.sceneId,
      sceneTitle: scene ? (scene.title || '') : '',
      assignIndex: def.assignIndex,
      variable: def.variable,
      value: def.value,
      label,
      reachable,
      status,
      reason,
      reference,
    };
    if (def.kind === 'option') {
      item.optionIndex = def.optionIndex;
      item.optionUid = def.optionUid;
      item.optionText = def.optionText;
    }
    return item;
  });

  const summary = {
    total: defs.length,
    reachable: reachedDefs.size,
    consumed: 0,
    unconsumed: 0,
    unknown: 0,
    unreachable: 0,
  };
  for (const a of assignments) summary[a.status]++;

  const status = truncated ? 'truncated' : 'ok';
  let message;
  if (status === 'ok') {
    message = `审计完成：完整探索 ${statesExplored} 个具体状态，共 ${summary.total} 处赋值，`
      + `可达 ${summary.reachable} 处——已消费 ${summary.consumed} 处、`
      + `在再次被赋值或路线结束前从未被条件引用 ${summary.unconsumed} 处`
      + (summary.unreachable ? `；另有 ${summary.unreachable} 处赋值从未执行（不可达）` : '')
      + '。';
  } else {
    message = `无法完全判定：具体状态数量超过安全上限（${maxStates}），探索被截断。`
      + `已确认 ${summary.consumed} 处赋值被消费（结论确凿）；其余 ${summary.unknown} 处状态未知`
      + '——未探索区域可能存在对它们的引用，不能判为未消费；请减少变量数量后重试。';
  }

  return {
    ...base,
    ok: !truncated,
    status,
    startBlocked: false,
    truncated,
    assignments,
    summary,
    counts: { states: statesExplored, transitions: transitionCount, variables: knownVars.length },
    statesExplored,
    message,
  };
}

module.exports = { auditAssignments };
