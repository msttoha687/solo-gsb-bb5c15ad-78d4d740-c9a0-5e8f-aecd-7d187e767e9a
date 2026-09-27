'use strict';

/**
 * 结局概率推演
 *
 * 在编辑中草稿展开出的「场景 + 变量状态」具体状态图上构建马尔可夫链：
 *   1. 从起点场景（初始状态 = 起点场景的进入赋值）BFS 展开具体状态，
 *      按 场景ID + 变量位图 去重（与分析器相同，含环也必然终止，上限 MAX_STATES）；
 *   2. 每个具体状态下，仅对「条件成立 且 目标可进入」（目标场景存在、
 *      应用选项赋值与目标进入赋值后目标前置条件成立）的选项按权重归一化，
 *      得到该状态的转移概率分布；
 *   3. 没有任何可走选项的状态是吸收态：场景本身无选项 => 设计结局（ending），
 *      场景有选项但全部不可走 => 死局（deadend）；
 *   4. 用 Kosaraju 求强连通分量，找出所有“底 SCC”（无出边的闭合类）：
 *      单态且无外/内边 => 吸收结局；含内部边的底 SCC => 陷阱循环
 *      （进入后永远困在其中，其概率质量单独列出）；
 *   5. 各终止类的最终到达概率 = 对瞬态子链精确求解线性方程组 (I - Q)X = B
 *      （高斯消元 + 部分主元，多右端一次解出）。这是方程的精确解，
 *      不是固定步数截断：截断会把“仍在途中”的概率错算给循环，
 *      而这里循环概率只统计真正闭合的底 SCC。
 *
 * 状态数超过 DENSE_SOLVER_LIMIT 时改用 Gauss-Seidel 迭代求解同一方程组，
 * 收敛到容差内才输出（converged 标记）；不收敛则明确报告，绝不以截断值冒充。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');
const { weightOrDefault, weightWhere } = require('./weight');

const DENSE_SOLVER_LIMIT = 1200; // 稠密精确求解的瞬态状态上限（超出改迭代）
const ITER_TOL = 1e-11;          // 迭代收敛容差（max |Δx|）
const ITER_MAX_SWEEPS = 20000;   // 迭代扫描上限；不收敛则如实报告

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Kosaraju 强连通分量（迭代实现，避免深递归）；返回 { comp, ncomp } */
function computeSCC(adj) {
  const n = adj.length;
  const radj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (const j of adj[i]) radj[j].push(i);

  const visited = new Uint8Array(n);
  const order = [];
  for (let s = 0; s < n; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const stack = [[s, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const v = top[0];
      if (top[1] < adj[v].length) {
        const w = adj[v][top[1]++];
        if (!visited[w]) { visited[w] = 1; stack.push([w, 0]); }
      } else {
        order.push(v);
        stack.pop();
      }
    }
  }

  const comp = new Int32Array(n).fill(-1);
  let ncomp = 0;
  for (let oi = order.length - 1; oi >= 0; oi--) {
    const s = order[oi];
    if (comp[s] !== -1) continue;
    comp[s] = ncomp;
    const stack = [s];
    while (stack.length) {
      const v = stack.pop();
      for (const w of radj[v]) {
        if (comp[w] === -1) { comp[w] = ncomp; stack.push(w); }
      }
    }
    ncomp++;
  }
  return { comp, ncomp };
}

/**
 * 高斯消元（部分主元）求解 A·X = B，A 为 m×m 行主序，B 为 m×k 多右端。
 * 返回 m×k 的解矩阵（行主序）。A 为瞬态子链的 (I - Q)，必然非奇异。
 */
function solveDense(m, A, B, k) {
  for (let col = 0; col < m; col++) {
    let piv = col;
    let best = Math.abs(A[col * m + col]);
    for (let r = col + 1; r < m; r++) {
      const v = Math.abs(A[r * m + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) throw new Error('推演矩阵奇异，无法求解（剧情结构异常）');
    if (piv !== col) {
      for (let c = 0; c < m; c++) {
        const t = A[col * m + c]; A[col * m + c] = A[piv * m + c]; A[piv * m + c] = t;
      }
      for (let c = 0; c < k; c++) {
        const t = B[col * k + c]; B[col * k + c] = B[piv * k + c]; B[piv * k + c] = t;
      }
    }
    const inv = 1 / A[col * m + col];
    for (let r = col + 1; r < m; r++) {
      const f = A[r * m + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < m; c++) A[r * m + c] -= f * A[col * m + c];
      for (let c = 0; c < k; c++) B[r * k + c] -= f * B[col * k + c];
    }
  }
  const X = new Float64Array(m * k);
  for (let col = m - 1; col >= 0; col--) {
    const diag = A[col * m + col];
    for (let c = 0; c < k; c++) {
      let acc = B[col * k + c];
      for (let j = col + 1; j < m; j++) acc -= A[col * m + j] * X[j * k + c];
      X[col * k + c] = acc / diag;
    }
  }
  return X;
}

/**
 * Gauss-Seidel 迭代求解 x = b + Qx（即 (I - Q)x = b），仅用于大规模瞬态链。
 * 收敛（max |Δx| < ITER_TOL）才视为有效；否则返回 converged:false 如实报告。
 */
function solveIterative(rows, k) {
  // rows: [{ q: [[col, prob], ...], b: Float64Array(k) }]
  const m = rows.length;
  const X = new Float64Array(m * k);
  let converged = false;
  let sweeps = 0;
  for (sweeps = 1; sweeps <= ITER_MAX_SWEEPS; sweeps++) {
    let maxDelta = 0;
    for (let i = 0; i < m; i++) {
      const row = rows[i];
      for (let c = 0; c < k; c++) {
        let acc = row.b[c];
        for (const [j, p] of row.q) acc += p * X[j * k + c];
        const d = Math.abs(acc - X[i * k + c]);
        if (d > maxDelta) maxDelta = d;
        X[i * k + c] = acc;
      }
    }
    if (maxDelta < ITER_TOL) { converged = true; break; }
  }
  return { X, converged, sweeps };
}

/** 浮点噪声收敛到 [0,1]（如 -1e-17 => 0）；明显越界的值保持原样以便暴露问题 */
function clamp01(x) {
  if (x < 0 && x > -1e-9) return 0;
  if (x > 1 && x < 1 + 1e-9) return 1;
  return x;
}

/**
 * 对剧情（草稿或已保存）推演各终止场景的到达概率与困在循环中的概率质量。
 *
 * @param storyInput 剧情对象
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function inferEndings(storyInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }

  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法推演结局概率');
  }

  // ---- 权重校验：正整数，缺省为 1；非法权重 => 400（带场景与选项位置） ----
  const optionWeight = new Map(); // `${sceneId}#${idx}` -> 正整数权重
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    (scene.options || []).forEach((opt, idx) => {
      const w = weightOrDefault(opt && opt.weight, weightWhere(scene.id, idx, (opt && opt.text) || ''));
      optionWeight.set(`${scene.id}#${idx}`, w);
    });
  }

  // ---- 编译条件（语法错误按恒真处理，与分析器 / 路径查询一致） ----
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

  const knownVars = collectStateVars({ ...story, scenes });

  // ---- 起点 ----
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (startBlocked) {
    return {
      ok: true,
      truncated: false,
      startBlocked: true,
      startScene: story.startScene,
      counts: { states: 0, transitions: 0, endings: 0, loops: 0, variables: knownVars.length },
      endings: [],
      totalEndingProbability: 0,
      loopProbability: 0,
      loops: [],
      solver: 'none',
      knownVars,
      conditionErrors,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可推演的概率。',
    };
  }

  // ---- 展开「场景 + 变量状态」图并构建加权转移 ----
  const stateList = [];               // index -> { sceneId, code }
  const stateIndex = new Map();       // `${sceneId}\x00${code}` -> index
  const edgeWeight = [];              // index -> Map(toIndex -> 权重和)
  const queue = [];
  let truncated = false;

  const getOrCreate = (sceneId, code) => {
    const key = `${sceneId}\x00${code}`;
    const hit = stateIndex.get(key);
    if (hit !== undefined) return hit;
    const idx = stateList.length;
    stateList.push({ sceneId, code });
    stateIndex.set(key, idx);
    edgeWeight.push(new Map());
    if (stateList.length > maxStates) { truncated = true; return idx; }
    queue.push(idx);
    return idx;
  };

  getOrCreate(story.startScene, encodeState(startState, knownVars));

  let transitionCount = 0;
  for (let head = 0; head < queue.length && !truncated; head++) {
    const cur = queue[head];
    const { sceneId, code } = stateList[cur];
    const scene = sceneMap.get(sceneId);
    const state = decodeState(code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated) return;
      const oc = optionCompiled.get(`${sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 条件不成立：不参与归一化
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：目标不可进入
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return;             // 目标前置不成立：不可进入

      const to = getOrCreate(targetId, encodeState(nextState, knownVars));
      if (truncated) return;
      const w = optionWeight.get(`${sceneId}#${idx}`) || 1;
      const row = edgeWeight[cur];
      const had = row.has(to);
      row.set(to, (row.get(to) || 0) + w);
      if (!had) transitionCount++;
    });
  }

  if (truncated) {
    // 状态空间未展开完就给出概率 = 以偏概全，明确拒绝输出
    return {
      ok: false,
      truncated: true,
      startBlocked: false,
      startScene: story.startScene,
      counts: { states: stateList.length, transitions: transitionCount, endings: 0, loops: 0, variables: knownVars.length },
      endings: null,
      totalEndingProbability: null,
      loopProbability: null,
      loops: null,
      solver: 'none',
      knownVars,
      conditionErrors,
      message: `具体状态数量超过安全上限（${maxStates}），推演终止；为避免以不完整的状态图冒充结果，未输出概率。请减少变量数量后重试。`,
    };
  }

  const n = stateList.length;
  // 转移概率：每个状态仅对“条件成立且目标可进入”的选项按权重归一化
  const adj = [];   // 出边（用于 SCC）
  const probs = []; // index -> Map(to -> p)
  for (let i = 0; i < n; i++) {
    const row = edgeWeight[i];
    let total = 0;
    for (const w of row.values()) total += w;
    const p = new Map();
    if (total > 0) for (const [to, w] of row) p.set(to, w / total);
    probs.push(p);
    adj.push([...row.keys()]);
  }

  // ---- SCC：底 SCC = 闭合类（吸收结局 或 陷阱循环） ----
  const { comp, ncomp } = computeSCC(adj);
  const compMembers = Array.from({ length: ncomp }, () => []);
  for (let i = 0; i < n; i++) compMembers[comp[i]].push(i);

  const classes = []; // { isLoop, members }
  const classOfState = new Int32Array(n).fill(-1);
  for (let c = 0; c < ncomp; c++) {
    const members = compMembers[c];
    let bottom = true;
    let internal = members.length > 1;
    for (const v of members) {
      for (const w of adj[v]) {
        if (comp[w] !== c) bottom = false;
        else if (v === w) internal = true; // 自环
      }
    }
    if (!bottom) continue;
    const idx = classes.length;
    classes.push({ isLoop: internal, members });
    for (const s of members) classOfState[s] = idx;
  }

  // ---- 求解各闭合类的最终到达概率 ----
  const k = classes.length;
  const answer = new Float64Array(k);
  let solver = 'trivial';
  let converged = true;
  let sweeps = 0;

  const startClass = classOfState[0];
  if (startClass !== -1) {
    answer[startClass] = 1; // 起点本身就在闭合类中（如纯循环剧情）
  } else if (k === 1) {
    answer[0] = 1; // 只有一个闭合类：有限马尔可夫链必然以概率 1 进入
  } else {
    // 瞬态状态子链：(I - Q)X = B，B[i][c] = 从 i 直接进入类 c 的概率
    const transient = [];
    const rowOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (classOfState[i] === -1) { rowOf[i] = transient.length; transient.push(i); }
    }
    const m = transient.length;
    if (m > 0) {
      if (m <= DENSE_SOLVER_LIMIT) {
        solver = 'exact';
        const A = new Float64Array(m * m);
        const B = new Float64Array(m * k);
        for (let r = 0; r < m; r++) {
          const s = transient[r];
          A[r * m + r] = 1;
          for (const [to, p] of probs[s]) {
            const tc = classOfState[to];
            if (tc === -1) A[r * m + rowOf[to]] -= p;
            else B[r * k + tc] += p;
          }
        }
        const X = solveDense(m, A, B, k);
        const sr = rowOf[0];
        for (let c = 0; c < k; c++) answer[c] = X[sr * k + c];
      } else {
        solver = 'iterative';
        const rows = [];
        for (let r = 0; r < m; r++) {
          const s = transient[r];
          const q = [];
          const b = new Float64Array(k);
          for (const [to, p] of probs[s]) {
            const tc = classOfState[to];
            if (tc === -1) q.push([rowOf[to], p]);
            else b[tc] += p;
          }
          rows.push({ q, b });
        }
        const it = solveIterative(rows, k);
        converged = it.converged;
        sweeps = it.sweeps;
        const sr = rowOf[0];
        for (let c = 0; c < k; c++) answer[c] = it.X[sr * k + c];
      }
    }
  }

  if (!converged) {
    return {
      ok: false,
      truncated: false,
      startBlocked: false,
      startScene: story.startScene,
      counts: { states: n, transitions: transitionCount, endings: 0, loops: 0, variables: knownVars.length },
      endings: null,
      totalEndingProbability: null,
      loopProbability: null,
      loops: null,
      solver,
      converged: false,
      sweeps,
      knownVars,
      conditionErrors,
      message: `迭代求解在 ${sweeps} 轮后仍未收敛到容差 ${ITER_TOL}，为避免以未收敛值冒充结果，未输出概率。`,
    };
  }

  // ---- 汇总结局（按场景合并吸收态）与循环 ----
  const endingsByScene = new Map();
  const loops = [];
  classes.forEach((cls, ci) => {
    const p = clamp01(answer[ci]);
    if (cls.isLoop) {
      const sceneIds = [...new Set(cls.members.map((s) => stateList[s].sceneId))];
      loops.push({
        probability: p,
        states: cls.members.length,
        scenes: sceneIds.map((id) => ({ id, title: (sceneMap.get(id) || {}).title || '' })),
      });
      return;
    }
    // 吸收态：单态闭合类
    const sceneId = stateList[cls.members[0]].sceneId;
    const scene = sceneMap.get(sceneId);
    const kind = ((scene.options || []).length === 0) ? 'ending' : 'deadend';
    if (!endingsByScene.has(sceneId)) {
      endingsByScene.set(sceneId, {
        sceneId,
        title: scene.title || '',
        kind,
        probability: 0,
        states: 0,
      });
    }
    const e = endingsByScene.get(sceneId);
    e.probability += p;
    e.states += 1;
  });

  const endings = [...endingsByScene.values()]
    .map((e) => ({ ...e, probability: clamp01(e.probability) }))
    .sort((a, b) => b.probability - a.probability || a.sceneId.localeCompare(b.sceneId));
  loops.sort((a, b) => b.probability - a.probability);

  const totalEndingProbability = clamp01(endings.reduce((acc, e) => acc + e.probability, 0));
  const loopProbability = clamp01(loops.reduce((acc, l) => acc + l.probability, 0));

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const message = `已精确求解 ${n} 个具体状态上的概率分布：`
    + `${endings.length} 个终止场景合计 ${pct(totalEndingProbability)}`
    + (loops.length ? `，${loops.length} 处循环合计 ${pct(loopProbability)}` : '，无陷阱循环');

  return {
    ok: true,
    truncated: false,
    startBlocked: false,
    startScene: story.startScene,
    counts: {
      states: n,
      transitions: transitionCount,
      endings: endings.length,
      loops: loops.length,
      variables: knownVars.length,
    },
    endings,
    totalEndingProbability,
    loopProbability,
    loops,
    solver,
    knownVars,
    conditionErrors,
    message,
  };
}

module.exports = { inferEndings, DENSE_SOLVER_LIMIT };
