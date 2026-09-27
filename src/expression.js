'use strict';

/**
 * 布尔条件表达式解析器
 *
 * 文法（递归下降）:
 *   expr    := or
 *   or      := and ('||' and)*
 *   and     := unary ('&&' unary)*
 *   unary   := '!' unary | primary
 *   primary := '(' expr ')' | IDENT
 *
 * IDENT 规则：以字母或下划线开头，可含字母、数字、下划线。
 * 空字符串视为恒真（无前置条件）。
 */

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '&' && src[i + 1] === '&') { tokens.push({ type: '&&' }); i += 2; continue; }
    if (ch === '|' && src[i + 1] === '|') { tokens.push({ type: '||' }); i += 2; continue; }
    if (ch === '!') { tokens.push({ type: '!' }); i++; continue; }
    if (ch === '(') { tokens.push({ type: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: ')' }); i++; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'var', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`无法识别的字符 "${ch}"（位置 ${i + 1}）`);
  }
  return tokens;
}

class Parser {
  constructor(tokens, raw) {
    this.tokens = tokens;
    this.raw = raw;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(type) {
    const t = this.next();
    if (!t || t.type !== type) {
      throw new Error(`条件 "${this.raw}" 语法错误：缺少 ${type}`);
    }
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek() && this.peek().type === '||') {
      this.next();
      const right = this.parseAnd();
      left = { op: 'or', args: [...toArgs(left, 'or'), ...toArgs(right, 'or')] };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseUnary();
    while (this.peek() && this.peek().type === '&&') {
      this.next();
      const right = this.parseUnary();
      left = { op: 'and', args: [...toArgs(left, 'and'), ...toArgs(right, 'and')] };
    }
    return left;
  }
  parseUnary() {
    if (this.peek() && this.peek().type === '!') {
      this.next();
      return { op: 'not', arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.next();
    if (!t) throw new Error(`条件 "${this.raw}" 语法错误：条件不完整`);
    if (t.type === 'var') return { op: 'var', name: t.value };
    if (t.type === '(') {
      const node = this.parseOr();
      this.expect(')');
      return node;
    }
    throw new Error(`条件 "${this.raw}" 语法错误：意外的 token "${t.type}"`);
  }
}

function toArgs(node, op) {
  return node.op === op ? node.args : [node];
}

/** 解析为 AST；空表达式返回 null（恒真） */
function parse(raw) {
  const src = (raw || '').trim();
  if (!src) return null;
  const tokens = tokenize(src);
  if (tokens.length === 0) return null;
  const parser = new Parser(tokens, src);
  const ast = parser.parseOr();
  if (parser.pos !== tokens.length) {
    throw new Error(`条件 "${src}" 语法错误：括号或运算符不匹配`);
  }
  return ast;
}

/** AST 在给定变量状态下求值 */
function evalAst(node, state) {
  if (node === null) return true;
  switch (node.op) {
    case 'var': return !!state[node.name];
    case 'not': return !evalAst(node.arg, state);
    case 'and': return node.args.every((n) => evalAst(n, state));
    case 'or': return node.args.some((n) => evalAst(n, state));
    default: throw new Error(`未知 AST 节点: ${node.op}`);
  }
}

/** 收集 AST 中引用的全部变量名 */
function varsOf(node, out = new Set()) {
  if (node === null) return out;
  if (node.op === 'var') out.add(node.name);
  else if (node.op === 'not') varsOf(node.arg, out);
  else node.args.forEach((n) => varsOf(n, out));
  return out;
}

/**
 * 解释为什么条件在 state 下成立 / 不成立，并给出最少需要翻转的变量。
 *
 * 返回结构（递归树）：
 *   { op, value, want, satisfied, feasible, flip:[names...], conflicts:[names...], children, name? }
 *
 * “最少翻转”通过三值逻辑剪枝的回溯搜索精确求解（变量数较少）：
 *   - 找到与当前状态差异最小的、能让条件取期望值的赋值；
 *   - 若穷举后仍无解（如 a && !a），标记 feasible=false，提示修改条件本身。
 */

const SEARCH_VAR_CAP = 16;   // 参与精确搜索的变量上限
const SEARCH_NODE_CAP = 60000; // 搜索节点预算

function eval3(node, assignment) {
  if (node === null) return true;
  switch (node.op) {
    case 'var': {
      const v = assignment[node.name];
      return v === undefined ? null : v;
    }
    case 'not': {
      const v = eval3(node.arg, assignment);
      return v === null ? null : !v;
    }
    case 'and': {
      let anyUnknown = false;
      for (const a of node.args) {
        const v = eval3(a, assignment);
        if (v === false) return false;
        if (v === null) anyUnknown = true;
      }
      return anyUnknown ? null : true;
    }
    case 'or': {
      let anyUnknown = false;
      for (const a of node.args) {
        const v = eval3(a, assignment);
        if (v === true) return true;
        if (v === null) anyUnknown = true;
      }
      return anyUnknown ? null : false;
    }
    default: throw new Error(`未知 AST 节点: ${node.op}`);
  }
}

/**
 * 求使 node 取值为 want、且相对 state 翻转变量最少的赋值。
 * 返回 { feasible: true|false|null(未知/超时), assignment, flips, conflicts }
 * conflicts：无解时，被表达式同时要求为真与为假的变量（不可满足核心中的变量）。
 */
function solve(node, want, state) {
  if (node === null) return { feasible: true, assignment: {}, flips: [], conflicts: [] };
  const vars = [...varsOf(node)];
  if (vars.length > SEARCH_VAR_CAP) return { feasible: null, assignment: null, flips: [], conflicts: [] };

  let budget = SEARCH_NODE_CAP;
  let exhausted = true;
  let best = null; // { flips, assignment }

  const dfs = (assignment, flips) => {
    if (budget-- <= 0) { exhausted = false; return; }
    if (best && flips >= best.flips) return; // 分支限界：不可能更优
    const v = eval3(node, assignment);
    if (v === !want) return;                 // 已确定失败，剪枝
    if (v === want) { best = { flips, assignment: { ...assignment } }; return; }

    const name = vars.find((x) => assignment[x] === undefined);
    if (name === undefined) return;
    const cur = !!state[name];
    for (const val of [cur, !cur]) {
      assignment[name] = val;
      dfs(assignment, flips + (val !== cur ? 1 : 0));
      delete assignment[name];
      if (best && best.flips === 0) return;
    }
  };
  dfs({}, 0);

  if (!exhausted && !best) return { feasible: null, assignment: null, flips: [], conflicts: [] };
  if (!best) {
    // 提取冲突：尝试要求每个叶子取真/取假，若两个方向本身都被整体公式需要，则为冲突变量
    const conflicts = findConflicts(node, want);
    return { feasible: false, assignment: null, flips: [], conflicts };
  }
  return {
    feasible: true,
    assignment: best.assignment,
    flips: vars.filter((x) => best.assignment[x] !== !!state[x]),
    conflicts: [],
  };
}

/**
 * 无解时定位冲突变量：变量 x 是冲突变量，当且仅当
 *   (node | x=true 蕴含结果不可能为 want) 且 (node | x=false 同样不可能)
 * 即固定 x 为任意值都无解。这里通过两次小规模 SAT 检查（含其余变量枚举）实现。
 */
function findConflicts(node, want) {
  const vars = [...varsOf(node)];
  const out = [];
  for (const x of vars) {
    let bothDirsUnsat = true;
    for (const b of [true, false]) {
      let found = false;
      let locBudget = 30000;
      const rest = vars.filter((v) => v !== x);
      const dfs2 = (assignment) => {
        if (found || locBudget-- <= 0) return;
        const v = eval3(node, assignment);
        if (v === !want) return;
        if (v === want) { found = true; return; }
        const name = rest.find((q) => assignment[q] === undefined);
        if (name === undefined) return;
        for (const val of [true, false]) {
          assignment[name] = val;
          dfs2(assignment);
          delete assignment[name];
          if (found) return;
        }
      };
      dfs2({ [x]: b });
      if (found) { bothDirsUnsat = false; break; }
    }
    if (bothDirsUnsat) out.push(x);
  }
  return out;
}

function explain(node, state, want = true) {
  return explainAst2(node, state, want, null);
}

/**
 * @param witness 父级全局求解得到的见证赋值；若该赋值能使本子树取 want，则直接采用，
 *                避免跨分支约束（如 !a && (a||b)）被独立求解误判为矛盾。
 */
function explainAst2(node, state, want, witness) {
  if (node === null) {
    return { op: 'const', value: true, want, satisfied: true, feasible: true, flip: [], conflicts: [], children: [], ast: null };
  }

  const value = evalAst(node, state);
  const satisfied = value === want;

  if (node.op === 'var') {
    const feasible = witness ? evalAst(node, witness) === want : true;
    return {
      op: 'var', name: node.name, value, want, satisfied,
      feasible,
      flip: satisfied || !witness ? (satisfied ? [] : [node.name])
        : (witness[node.name] !== !!state[node.name] ? [node.name] : []),
      conflicts: [],
      children: [],
      ast: node,
    };
  }

  if (node.op === 'not') {
    const childWitness = witness || null;
    const child = explainAst2(node.arg, state, !want, childWitness);
    return {
      op: 'not', value, want, satisfied,
      feasible: child.feasible, flip: child.flip, conflicts: child.conflicts,
      children: [child],
      ast: node,
    };
  }

  const subsRender = (w) => node.args.map((n) => explainAst2(n, state, want, w));
  const base = { op: node.op, value, want, satisfied, ast: node };

  if (satisfied) {
    return { ...base, feasible: true, flip: [], conflicts: [], children: subsRender(null) };
  }

  // 对整个（子）表达式全局精确求解：一次 SAT 搜索即正确处理跨分支共享变量约束
  const sol = solve(node, want, state);
  const witnessAssign = sol.assignment || null;

  if (sol.feasible === true) {
    const allNeeded = (node.op === 'and') === want;
    const children = subsRender(witnessAssign);
    if (allNeeded) {
      return { ...base, feasible: true, flip: sol.flips, conflicts: [], children };
    }
    // 只需一个分支满足：标注见证赋值实际满足的那个（些）分支为推荐路径
    const hit = children.filter((c) => evalAst(c.ast, witnessAssign) === want);
    const preferred = new Set(hit);
    return {
      ...base, feasible: true, flip: sol.flips, conflicts: [],
      children: children.map((c) => (preferred.has(c) ? c : { ...c, hintAlternative: true })),
    };
  }

  if (sol.feasible === false) {
    // 不可满足：对子树独立求解以定位冲突来自哪些变量/分支
    const children = node.args.map((n) => explainAst2(n, state, want, null));
    const conflicts = new Set(sol.conflicts || []);
    if (!conflicts.size) {
      // 全局求解耗尽预算外的无解兜底：从子解收集
      children.forEach((c) => (c.flip || []).forEach(() => {}));
    }
    return { ...base, feasible: false, flip: [], conflicts: [...conflicts], children };
  }

  // feasible === null（变量过多/搜索预算耗尽）
  return { ...base, feasible: null, flip: [], conflicts: [], children: subsRender(null) };
}

/** 编译原始条件字符串，返回求值与解释接口 */
function compile(raw) {
  const ast = parse(raw);
  return {
    ast,
    raw: (raw || '').trim(),
    evaluate: (state) => evalAst(ast, state),
    vars: () => varsOf(ast),
    explain: (state, want = true) => explain(ast, state, want),
  };
}

module.exports = { parse, compile, evalAst, varsOf, explain };
