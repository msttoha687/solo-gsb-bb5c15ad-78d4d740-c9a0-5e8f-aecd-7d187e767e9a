'use strict';

// 变量赋值消费审计自检（node test/assignaudit.js）
// 覆盖：基本消费 / 未消费、选项条件先于本选项赋值、目标场景赋值先于其前置条件、
//       入口被挡仍算引用、选项赋值被目标前置消费、再次被赋值前未引用（def-use 精确）、
//       条件求值为 false 也算引用、存在性规则（同一位置一次有效引用即消费）、
//       短路求值只消费实际读取（|| / && / ! 与嵌套括号）、入口受阻前的前置求值仍计入、
//       同变量多分支读取见证、环路终止、不可达赋值（场景未进入 / 悬空选项）、
//       状态上限截断（未知不判未消费）、起点受阻、参数校验（400）、语法错误容错、
//       确定性、最短见证（更短替换）、初始值引用不消费、同列表后者覆盖前者、
//       起点前置消费起点赋值、示例剧情、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assignaudit-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { auditAssignments } = require('../src/assignaudit');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name, actual, expected) => {
  assert.strictEqual(actual, expected, `${name}（实际 ${JSON.stringify(actual)}）`);
  passed++; console.log(`  ✓ ${name}`);
};
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
// 按位置特征查找赋值结果
const defOf = (r, pred) => r.assignments.find(pred);

// ---------- 基本消费：场景进入赋值被后续场景的选项条件引用 ----------
console.log('基本消费：场景进入赋值 → 选项条件');
const st1 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }],
      options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', condition: 'x', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r1 = auditAssignments(st1);
eq('结论状态 ok', r1.status, 'ok');
eq('赋值总数 = 1', r1.summary.total, 1);
eq('已消费 = 1', r1.summary.consumed, 1);
const d1 = defOf(r1, (a) => a.kind === 'scene' && a.sceneId === 'a' && a.variable === 'x');
eq('场景进入赋值已消费', d1.status, 'consumed');
eq('首次引用深度 = 1（在场景 b 处）', d1.reference.depth, 1);
eq('引用者类型 = 选项条件', d1.reference.reader.kind, 'option-condition');
eq('引用者场景 = b', d1.reference.reader.sceneId, 'b');
eq('引用者选项序号 = 1', d1.reference.reader.optionIndex, 0);
eq('引用变量 = x', d1.reference.variable, 'x');
eq('最短路线场景序列 a,b',
  d1.reference.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(','), 'a,b');
ok('路线每个场景节点带到达时完整变量状态',
  d1.reference.path.filter((n) => n.kind === 'scene').every((n) => n.state !== undefined));
ok('引用时变量状态带 x=true', d1.reference.stateAtRead.x === true);

// ---------- 基本未消费：赋值后路线结束，无任何引用 ----------
console.log('基本未消费：路线结束前无引用');
const st2 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b', assigns: [{ variable: 'x', value: true }] }] },
    { id: 'b', options: [] },
  ],
};
const r2 = auditAssignments(st2);
const d2 = defOf(r2, (a) => a.kind === 'option' && a.sceneId === 'a');
eq('选项赋值可达但未消费', d2.status, 'unconsumed');
ok('未消费项可达标记为真', d2.reachable === true);
eq('未消费 = 1', r2.summary.unconsumed, 1);
eq('未消费项无首次引用路线', d2.reference, null);

// ---------- 选项条件先于本选项赋值：自己的赋值不被自己的条件消费 ----------
console.log('选项条件先于本选项赋值');
const st3 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }],
      options: [{ uid: 'o1', condition: 'x', target: 'b', assigns: [{ variable: 'x', value: true }] }] },
    { id: 'b', options: [] },
  ],
};
const r3 = auditAssignments(st3);
const d3a = defOf(r3, (a) => a.kind === 'scene' && a.sceneId === 'a');
const d3b = defOf(r3, (a) => a.kind === 'option' && a.sceneId === 'a');
eq('起点场景赋值被选项条件消费（深度 0）', d3a.status, 'consumed');
eq('起点处引用深度 = 0', d3a.reference.depth, 0);
eq('选项自己的赋值不被自己的条件消费', d3b.status, 'unconsumed');

// ---------- 目标场景进入赋值先于其前置条件：被自己的前置条件消费 ----------
console.log('目标场景赋值先于其前置条件');
const st4 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', precondition: 'x', assigns: [{ variable: 'x', value: true }], options: [] },
  ],
};
const r4 = auditAssignments(st4);
const d4 = defOf(r4, (a) => a.kind === 'scene' && a.sceneId === 'b');
eq('场景进入赋值被自己的前置条件消费', d4.status, 'consumed');
eq('引用者类型 = 场景前置条件', d4.reference.reader.kind, 'scene-precondition');
eq('引用者场景 = b', d4.reference.reader.sceneId, 'b');
eq('首次引用深度 = 1（沿边跳转后）', d4.reference.depth, 1);
eq('路线末段为通往 b 的选项边',
  d4.reference.path[d4.reference.path.length - 1].target, 'b');

// ---------- 入口被挡仍算引用：前置条件不成立，但引用已发生 ----------
console.log('入口被挡仍算引用');
const st5 = {
  startScene: 'a',
  variables: ['x', 'y'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', precondition: 'x && y', // y 恒 false：入口恒受阻
      assigns: [{ variable: 'x', value: true }],
      options: [{ uid: 'o2', condition: 'x', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r5 = auditAssignments(st5);
const d5 = defOf(r5, (a) => a.kind === 'scene' && a.sceneId === 'b');
eq('被挡入口的进入赋值仍被前置条件消费', d5.status, 'consumed');
eq('引用者 = b 的前置条件', d5.reference.reader.kind, 'scene-precondition');
ok('被挡场景从未进入（b 不可达），但赋值已执行', d5.reachable === true);

// ---------- 选项赋值被目标场景前置条件消费 ----------
console.log('选项赋值被目标场景前置条件消费');
const st6 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b', assigns: [{ variable: 'x', value: true }] }] },
    { id: 'b', precondition: 'x', options: [] },
  ],
};
const r6 = auditAssignments(st6);
const d6 = defOf(r6, (a) => a.kind === 'option' && a.sceneId === 'a');
eq('选项赋值被目标前置条件消费', d6.status, 'consumed');
eq('引用者类型 = 场景前置条件', d6.reference.reader.kind, 'scene-precondition');

// ---------- 再次被赋值前未引用：旧赋值未消费，最新赋值被消费（def-use 精确） ----------
console.log('再次被赋值前未引用（def-use 精确性）');
const st7 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b', assigns: [{ variable: 'x', value: true }] }] },
    { id: 'b', assigns: [{ variable: 'x', value: false }],
      options: [{ uid: 'o2', condition: 'x', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r7 = auditAssignments(st7);
const d7old = defOf(r7, (a) => a.kind === 'option' && a.sceneId === 'a');
const d7new = defOf(r7, (a) => a.kind === 'scene' && a.sceneId === 'b');
eq('被覆盖的旧赋值未消费', d7old.status, 'unconsumed');
eq('最新赋值被后续条件消费', d7new.status, 'consumed');
eq('条件求值为 false 也算引用（x=false 仍被读）', d7new.reference.stateAtRead.x, false);

// ---------- 存在性规则：同一位置在任意可达状态下被引用一次即消费 ----------
console.log('存在性规则：同一位置一次有效引用即消费');
const st9 = {
  startScene: 'a',
  variables: ['x', 'y'],
  scenes: [
    { id: 'a', options: [
      { uid: 'o1', target: 's' },                                             // 路线 1：y 保持 false
      { uid: 'o2', target: 's', assigns: [{ variable: 'y', value: true }] },  // 路线 2
    ] },
    { id: 's', assigns: [{ variable: 'x', value: true }],
      options: [
        { uid: 't1', condition: 'y', target: 'v' },
        { uid: 't2', condition: '!y', target: 'u', assigns: [{ variable: 'x', value: false }] },
      ] },
    { id: 'u', options: [{ uid: 'u1', condition: 'x', target: 'w' }] },
    { id: 'v', options: [{ uid: 'v1', condition: 'x', target: 'w' }] },
    { id: 'w', options: [] },
  ],
};
const r9 = auditAssignments(st9);
const d9x = defOf(r9, (a) => a.kind === 'scene' && a.sceneId === 's' && a.variable === 'x');
const d9x2 = defOf(r9, (a) => a.kind === 'option' && a.sceneId === 's' && a.variable === 'x');
const d9y = defOf(r9, (a) => a.kind === 'option' && a.sceneId === 'a' && a.variable === 'y');
eq('同一位置在路线 2 被引用一次即消费', d9x.status, 'consumed');
eq('首次引用发生在场景 v（而非路线 1 的 u）', d9x.reference.reader.sceneId, 'v');
eq('首次引用深度 = 2', d9x.reference.depth, 2);
eq('覆盖它的赋值在路线 1 被消费', d9x2.status, 'consumed');
eq('其引用发生在场景 u（def 身份不混淆）', d9x2.reference.reader.sceneId, 'u');
eq('路线 2 的选项赋值被 t1 条件消费', d9y.status, 'consumed');
eq('y 的首次引用深度 = 1（在场景 s 处）', d9y.reference.depth, 1);

// 对照：去掉路线 2 后，同一位置在再次被赋值前从未被引用 => 未消费
const st9b = {
  startScene: 'a',
  variables: ['x', 'y'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 's' }] },
    { id: 's', assigns: [{ variable: 'x', value: true }],
      options: [
        { uid: 't1', condition: 'y', target: 'v' },
        { uid: 't2', condition: '!y', target: 'u', assigns: [{ variable: 'x', value: false }] },
      ] },
    { id: 'u', options: [{ uid: 'u1', condition: 'x', target: 'w' }] },
    { id: 'v', options: [] },
    { id: 'w', options: [] },
  ],
};
const r9b = auditAssignments(st9b);
const d9bx = defOf(r9b, (a) => a.kind === 'scene' && a.sceneId === 's' && a.variable === 'x');
eq('对照组：唯一引用路线不存在 => 未消费', d9bx.status, 'unconsumed');

// ---------- 环路：自环赋值被消费，遍历必然终止 ----------
console.log('含环图：自环赋值消费且终止');
const st10 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [
      { uid: 'lp', condition: '!x', target: 'b', assigns: [{ variable: 'x', value: true }] },
      { uid: 'ck', condition: 'x', target: 'c' },
    ] },
    { id: 'c', options: [] },
  ],
};
const r10 = auditAssignments(st10);
const d10 = defOf(r10, (a) => a.kind === 'option' && a.sceneId === 'b');
eq('自环选项赋值被消费', d10.status, 'consumed');
eq('含环遍历终止（4 个具体状态）', r10.counts.states, 4);
ok('自环赋值首次引用在绕环一圈后（深度 2）', d10.reference.depth === 2);

// ---------- 不可达赋值：场景从未进入 / 悬空选项 ----------
console.log('不可达赋值单独列出');
const st11 = {
  startScene: 'a',
  variables: ['x', 'z', 'w'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [
      { uid: 'ob', target: 'nowhere', assigns: [{ variable: 'z', value: true }] }, // 悬空跳转
    ] },
    { id: 'ghost', assigns: [{ variable: 'x', value: true }],
      options: [{ uid: 'g1', target: 'b', assigns: [{ variable: 'w', value: true }] }] },
  ],
};
const r11 = auditAssignments(st11);
eq('完整探索（不可达不等于截断）', r11.status, 'ok');
const d11z = defOf(r11, (a) => a.variable === 'z');
const d11x = defOf(r11, (a) => a.variable === 'x');
const d11w = defOf(r11, (a) => a.variable === 'w');
eq('悬空选项的赋值 = 未执行', d11z.status, 'unreachable');
ok('悬空选项赋值的说明指向选项不可走', /从未可走/.test(d11z.reason));
eq('未进入场景的进入赋值 = 未执行', d11x.status, 'unreachable');
ok('场景未进入的说明', /从未进入/.test(d11x.reason));
eq('未进入场景里的选项赋值 = 未执行', d11w.status, 'unreachable');
eq('未执行计数 = 3', r11.summary.unreachable, 3);
eq('未消费计数 = 0', r11.summary.unconsumed, 0);

// ---------- 状态上限截断：未知项不能判为未消费；截断前已证实的消费保留 ----------
console.log('状态上限截断');
const chain = { startScene: 's0', variables: ['x', 'z'], scenes: [] };
for (let i = 0; i <= 6; i++) {
  chain.scenes.push({
    id: `s${i}`,
    assigns: i === 0 ? [{ variable: 'x', value: true }, { variable: 'z', value: true }] : [],
    options: [{ uid: `o${i}`, condition: i === 1 ? 'x' : (i === 6 ? 'z' : ''), target: `s${i + 1}` }],
  });
}
chain.scenes.push({ id: 's7', options: [] });
const r12full = auditAssignments(chain);
eq('完整探索时 z 的赋值被消费', defOf(r12full, (a) => a.variable === 'z').status, 'consumed');
eq('完整探索状态 = ok', r12full.status, 'ok');
const r12 = auditAssignments(chain, { maxStates: 3 });
eq('截断状态', r12.status, 'truncated');
ok('截断标记且不通过', r12.truncated === true && r12.ok === false);
eq('截断前已证实的消费保留（x 在 s1 被引用）',
  defOf(r12, (a) => a.variable === 'x').status, 'consumed');
eq('未探索区域的引用不得判未消费（z = 未知）',
  defOf(r12, (a) => a.variable === 'z').status, 'unknown');
eq('截断时未消费计数 = 0', r12.summary.unconsumed, 0);
eq('截断时未知计数 = 1', r12.summary.unknown, 1);
ok('截断文案明确', /截断/.test(r12.message) && /不能判为未消费/.test(r12.message));

// ---------- 起点受阻 ----------
console.log('起点受阻');
const stBlock = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', precondition: 'k', assigns: [{ variable: 'k', value: false }],
      options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const rBlock = auditAssignments(stBlock);
eq('起点受阻状态', rBlock.status, 'start-blocked');
ok('startBlocked 标记且不通过', rBlock.startBlocked === true && rBlock.ok === false);
eq('起点受阻时不产出赋值结果', rBlock.assignments.length, 0);

// ---------- 起点前置条件消费起点自己的进入赋值 ----------
console.log('起点前置条件引用起点赋值');
const stStartPc = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', precondition: 'x', assigns: [{ variable: 'x', value: true }], options: [] },
  ],
};
const rStartPc = auditAssignments(stStartPc);
const dStartPc = defOf(rStartPc, (a) => a.kind === 'scene' && a.sceneId === 'a');
eq('起点赋值被起点前置条件消费', dStartPc.status, 'consumed');
eq('引用深度 = 0', dStartPc.reference.depth, 0);
eq('引用者 = 场景前置条件', dStartPc.reference.reader.kind, 'scene-precondition');

// ---------- 参数校验 ----------
console.log('参数校验');
ok('缺起点 => 400', throws400(() => auditAssignments({ scenes: [{ id: 'a' }] }), /起点/));
ok('起点不存在 => 400',
  throws400(() => auditAssignments({ startScene: 'ghost', scenes: [{ id: 'a' }] }), /起点/));

// ---------- 条件语法错误容错（按恒真处理，不产生幻影引用） ----------
console.log('条件语法错误容错');
const stBad = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }],
      options: [{ uid: 'o1', condition: 'x &&', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const rBad = auditAssignments(stBad);
eq('语法错误按恒真处理：路线可走且审计完成', rBad.status, 'ok');
eq('记录 1 处条件语法错误', rBad.conditionErrors.length, 1);
eq('语法错误的条件不产生幻影引用（x 未被消费）',
  defOf(rBad, (a) => a.variable === 'x').status, 'unconsumed');

// ---------- 初始值引用不消费任何赋值 ----------
console.log('初始值引用不消费');
const st18 = {
  startScene: 'a',
  variables: ['x', 'ghost'],
  scenes: [
    { id: 'a', options: [
      { uid: 'o1', condition: 'ghost', target: 'b' }, // ghost 从未被赋值：读初始值
      { uid: 'o2', target: 'c' },
    ] },
    { id: 'b', options: [] },
    { id: 'c', options: [{ uid: 'o3', target: 'd', assigns: [{ variable: 'x', value: true }] }] },
    { id: 'd', options: [] },
  ],
};
const r18 = auditAssignments(st18);
eq('初始值引用不产生消费', r18.summary.consumed, 0);
eq('唯一赋值路线结束前未被引用', r18.summary.unconsumed, 1);

// ---------- 同一赋值列表内后者覆盖前者 ----------
console.log('同列表后者覆盖前者');
const stDup = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', assigns: [{ variable: 'x', value: true }, { variable: 'x', value: false }],
      options: [{ uid: 'o1', condition: 'x', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const rDup = auditAssignments(stDup);
const dupFirst = rDup.assignments.find((a) => a.kind === 'scene' && a.assignIndex === 0);
const dupSecond = rDup.assignments.find((a) => a.kind === 'scene' && a.assignIndex === 1);
eq('列表内先被覆盖的赋值未消费', dupFirst.status, 'unconsumed');
eq('列表内后者被消费', dupSecond.status, 'consumed');

// ---------- 最短见证：边触发的前置引用先被记录，更短的选项条件引用替换之 ----------
console.log('最短见证路线（更短替换）');
const st17 = {
  startScene: 's0',
  variables: ['x'],
  scenes: [
    { id: 's0', assigns: [{ variable: 'x', value: true }],
      options: [
        { uid: 'oA', target: 'a' },
        { uid: 'oB', target: 'b' },
      ] },
    { id: 'a', options: [{ uid: 'oX', target: 't' }] },   // a 先被处理：t 的前置条件读 x（深度 2）
    { id: 't', precondition: 'x', options: [] },
    { id: 'b', options: [{ uid: 'oY', condition: 'x', target: 't' }] }, // b 的选项条件读 x（深度 1）
  ],
};
const r17 = auditAssignments(st17);
const d17 = defOf(r17, (a) => a.kind === 'scene' && a.sceneId === 's0');
eq('首次引用取最短（深度 1 而非 2）', d17.reference.depth, 1);
eq('最短引用者 = b 的选项条件', d17.reference.reader.kind, 'option-condition');
eq('最短引用者场景 = b', d17.reference.reader.sceneId, 'b');

// ---------- 短路求值（||）：起点写 x=true、y=true，条件 x || y 实际只读 x ----------
console.log('短路求值 ||：只消费实际读取的变量');
const stSC1 = {
  startScene: 'start',
  variables: ['x', 'y'],
  scenes: [
    { id: 'start',
      assigns: [{ variable: 'x', value: true }, { variable: 'y', value: true }],
      options: [{ uid: 'o1', condition: 'x || y', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const rSC1 = auditAssignments(stSC1);
const sc1x = defOf(rSC1, (a) => a.variable === 'x');
const sc1y = defOf(rSC1, (a) => a.variable === 'y');
eq('|| 左操作数为真：x 被消费', sc1x.status, 'consumed');
eq('|| 右操作数被短路：y 未消费', sc1y.status, 'unconsumed');
eq('实际读取变量按序为 [x]', sc1x.reference.readVariables.join(','), 'x');
eq('被短路跳过变量为 [y]', sc1x.reference.skippedVariables.join(','), 'y');
eq('首次引用者 = start 的选项条件', sc1x.reference.reader.kind, 'option-condition');
eq('首次引用深度 = 0', sc1x.reference.depth, 0);
eq('y 无首次引用路线', sc1y.reference, null);
eq('已消费 = 1 / 未消费 = 1', rSC1.summary.consumed === 1 && rSC1.summary.unconsumed === 1, true);

// 对照：x=false、y=true 时 || 必须继续读右操作数，y 被消费、x 也被读取（值为 false 也算读）
const stSC1b = {
  startScene: 'start',
  variables: ['x', 'y'],
  scenes: [
    { id: 'start',
      assigns: [{ variable: 'x', value: false }, { variable: 'y', value: true }],
      options: [{ uid: 'o1', condition: 'x || y', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const rSC1b = auditAssignments(stSC1b);
const sc1bx = defOf(rSC1b, (a) => a.variable === 'x');
const sc1by = defOf(rSC1b, (a) => a.variable === 'y');
eq('|| 左操作数为假：x 仍被读取并消费', sc1bx.status, 'consumed');
eq('|| 继续读右操作数：y 被消费', sc1by.status, 'consumed');
eq('实际读取顺序为 x,y', sc1by.reference.readVariables.join(','), 'x,y');
eq('无短路跳过变量', sc1by.reference.skippedVariables.length, 0);

// ---------- 短路求值（&&）：x=false 时只读 x，y 不读；条件整体为 false 也算已读 ----------
console.log('短路求值 &&：左假则不读右');
const stSC2 = {
  startScene: 'start',
  variables: ['x', 'y'],
  scenes: [
    { id: 'start',
      assigns: [{ variable: 'x', value: false }, { variable: 'y', value: true }],
      options: [{ uid: 'o1', condition: 'x && y', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const rSC2 = auditAssignments(stSC2);
eq('&& 左操作数为假：x 已被读（条件为 false 也算引用）',
  defOf(rSC2, (a) => a.variable === 'x').status, 'consumed');
eq('&& 右操作数被短路：y 未消费',
  defOf(rSC2, (a) => a.variable === 'y').status, 'unconsumed');
eq('&& 读取顺序为 [x] 且跳过 y',
  defOf(rSC2, (a) => a.variable === 'x').reference.readVariables.join(','), 'x');

// 对照：x=true、y=false 时 && 两侧都读
const stSC2b = {
  startScene: 'start',
  variables: ['x', 'y'],
  scenes: [
    { id: 'start',
      assigns: [{ variable: 'x', value: true }, { variable: 'y', value: false }],
      options: [{ uid: 'o1', condition: 'x && y', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const rSC2b = auditAssignments(stSC2b);
eq('&& 左真右假：两侧均读取（y 消费）',
  defOf(rSC2b, (a) => a.variable === 'y').status, 'consumed');

// ---------- 嵌套 && / || / ! 与括号按真实顺序读取 ----------
console.log('嵌套 && / || / ! 与括号的短路顺序');
const stSC3 = {
  startScene: 'start',
  variables: ['a', 'b', 'c', 'd'],
  scenes: [
    { id: 'start',
      assigns: [
        { variable: 'a', value: true }, { variable: 'b', value: true },
        { variable: 'c', value: true }, { variable: 'd', value: true },
      ],
      // (a && b) 为真 => 整个 || 在此短路，!c 与 d 都不求值
      options: [{ uid: 'o1', condition: '(a && b) || (!c && d)', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const rSC3 = auditAssignments(stSC3);
const refSC3 = defOf(rSC3, (x) => x.variable === 'a').reference;
eq('嵌套条件实际读取顺序 a,b', refSC3.readVariables.join(','), 'a,b');
eq('嵌套条件短路跳过 c,d', refSC3.skippedVariables.slice().sort().join(','), 'c,d');
eq('a/b 消费、c/d 未消费',
  rSC3.assignments.filter((x) => ['a', 'b'].includes(x.variable)).every((x) => x.status === 'consumed')
  && rSC3.assignments.filter((x) => ['c', 'd'].includes(x.variable)).every((x) => x.status === 'unconsumed'),
  true);

// ! 不改变短路：!(a || b) 中 a=true 时 b 不读；外层取反只影响结果不影响读取
const stSC3b = {
  startScene: 'start',
  variables: ['a', 'b'],
  scenes: [
    { id: 'start',
      assigns: [{ variable: 'a', value: true }, { variable: 'b', value: true }],
      // !(a || b) 整体为 false：选项不可走，但求值中 a 已读、b 被短路
      options: [{ uid: 'o1', condition: '!(a || b)', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const rSC3b = auditAssignments(stSC3b);
eq('! 包裹的 || 仍短路：a 消费', defOf(rSC3b, (x) => x.variable === 'a').status, 'consumed');
eq('! 包裹的 || 仍短路：b 未消费', defOf(rSC3b, (x) => x.variable === 'b').status, 'unconsumed');
eq('选项不可走（无任何边）但 a 的引用仍然成立',
  defOf(rSC3b, (x) => x.variable === 'a').reference.reader.kind, 'option-condition');

// ---------- 入口受阻：前置条件在短路点之前已做的求值仍计入消费 ----------
console.log('入口受阻前的前置条件求值仍计入');
const stSC4 = {
  startScene: 'a',
  variables: ['x', 'y', 'z'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    // 进入 b 时先执行赋值：x=true、y=true、z=true；前置 x || (y && z) 只读 x 即真
    { id: 'b', precondition: 'x || (y && z)',
      assigns: [
        { variable: 'x', value: true }, { variable: 'y', value: true },
        { variable: 'z', value: true },
      ],
      options: [] },
  ],
};
const rSC4 = auditAssignments(stSC4);
eq('入口成立：x 被前置条件消费', defOf(rSC4, (a) => a.variable === 'x').status, 'consumed');
eq('入口成立：y、z 被短路未消费',
  defOf(rSC4, (a) => a.variable === 'y').status === 'unconsumed'
  && defOf(rSC4, (a) => a.variable === 'z').status === 'unconsumed', true);

// 入口被挡版本：x=false 使 || 继续读 (y && z)，y=false 使 && 短路，z 不读；前置整体为假
const stSC4b = {
  startScene: 'a',
  variables: ['x', 'y', 'z'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', precondition: 'x || (y && z)',
      assigns: [
        { variable: 'x', value: false }, { variable: 'y', value: false },
        { variable: 'z', value: true },
      ],
      options: [{ uid: 'o2', condition: 'z', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const rSC4b = auditAssignments(stSC4b);
const sc4bx = defOf(rSC4b, (a) => a.variable === 'x');
const sc4by = defOf(rSC4b, (a) => a.variable === 'y');
const sc4bz = defOf(rSC4b, (a) => a.variable === 'z');
eq('被挡入口：x 在前置中已读（消费）', sc4bx.status, 'consumed');
eq('被挡入口：y 在短路点前已读（消费，值 false 也算）', sc4by.status, 'consumed');
eq('被挡入口：z 被 && 短路且场景未进入，从未被读', sc4bz.status, 'unconsumed');
ok('被挡赋值确实执行过（可达）', sc4bx.reachable && sc4by.reachable && sc4bz.reachable);
eq('被挡前置的读取顺序为 x,y', sc4by.reference.readVariables.join(','), 'x,y');
eq('被挡前置短路跳过 z', sc4by.reference.skippedVariables.join(','), 'z');
eq('引用者 = b 的前置条件（非 b 内不可达选项）', sc4by.reference.reader.kind, 'scene-precondition');

// ---------- 存在性规则与短路：另一可达状态读到时仍算消费 ----------
console.log('短路与存在性：不同状态下被读到一次即消费');
const stSC5 = {
  startScene: 'a',
  variables: ['x', 'y'],
  scenes: [
    { id: 'a', options: [
      { uid: 'o1', target: 's' },                                            // x 保持 false
      { uid: 'o2', target: 's', assigns: [{ variable: 'x', value: true }] }, // x=true
    ] },
    { id: 's', assigns: [{ variable: 'y', value: true }],
      options: [{ uid: 't1', condition: 'x || y', target: 'v' }] },
    { id: 'v', options: [] },
  ],
};
const rSC5 = auditAssignments(stSC5);
// 状态一（x=false）：读 x 再读 y；状态二（x=true）：只读 x。
// y 的赋值在状态一被读到 => 消费；x=true 的选项赋值在状态二被读到 => 消费
eq('x=true 路线：|| 短路只读 x，选项赋值消费',
  defOf(rSC5, (a) => a.kind === 'option' && a.sceneId === 'a' && a.variable === 'x').status, 'consumed');
eq('x=false 路线继续读到 y：场景 s 的 y 赋值消费',
  defOf(rSC5, (a) => a.kind === 'scene' && a.sceneId === 's').status, 'consumed');

// ---------- 确定性：同一剧情两次审计结果完全一致 ----------
console.log('确定性');
eq('同一剧情两次审计结果一致',
  JSON.stringify(auditAssignments(st9)),
  JSON.stringify(auditAssignments(st9)));

// ---------- 示例剧情：全部赋值均被消费 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rDemo = auditAssignments(demo);
eq('示例剧情审计完成', rDemo.status, 'ok');
eq('示例剧情共 3 处赋值', rDemo.summary.total, 3);
ok('森林找钥匙的选项赋值被消费',
  defOf(rDemo, (a) => a.kind === 'option' && a.sceneId === 'forest' && a.variable === 'hasKey').status === 'consumed');
ok('女巫塔进入赋值被消费',
  defOf(rDemo, (a) => a.kind === 'scene' && a.sceneId === 'witchTower').status === 'consumed');
ok('侧门选项赋值被宝库前置条件消费（即使入口被挡）',
  defOf(rDemo, (a) => a.kind === 'option' && a.sceneId === 'castle').status === 'consumed');

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', (x) => { data += x; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // 草稿审计（不落盘）
    const p1 = await req('POST', '/api/assign-audit', { story: st1 });
    ok('POST /api/assign-audit 返回 200 且已消费',
      p1.status === 200 && p1.body.status === 'ok' && p1.body.summary.consumed === 1);

    const p1b = await req('POST', '/api/assign-audit', st2);
    ok('请求体直接为剧情也可审计',
      p1b.status === 200 && p1b.body.summary.unconsumed === 1);

    const p1c = await req('POST', '/api/assign-audit', { story: chain, maxStates: 3 });
    ok('maxStates 注入生效：截断且未知项不判未消费',
      p1c.status === 200 && p1c.body.status === 'truncated'
      && p1c.body.summary.unknown === 1 && p1c.body.summary.unconsumed === 0);

    // 短路语义经草稿 API 暴露：x || y（均为 true）只消费 x，y 显示未消费
    const p1sc = await req('POST', '/api/assign-audit', { story: stSC1 });
    const scApiX = p1sc.body.assignments.find((a) => a.variable === 'x');
    const scApiY = p1sc.body.assignments.find((a) => a.variable === 'y');
    ok('API：被 || 短路的 y 判为未消费，x 的见证只记录实际读取 [x]',
      p1sc.status === 200 && scApiX.status === 'consumed' && scApiY.status === 'unconsumed'
      && scApiX.reference.readVariables.join(',') === 'x'
      && scApiX.reference.skippedVariables.join(',') === 'y');

    const p1d = await req('POST', '/api/assign-audit', { story: { scenes: [{ id: 'a' }] } });
    ok('缺起点返回 400', p1d.status === 400 && /起点/.test(p1d.body.error || ''));

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', st9);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const p2 = await req('GET', `/api/stories/${sid}/assign-audit`);
    ok('GET /api/stories/:id/assign-audit 返回 200 且结果一致',
      p2.status === 200 && p2.body.summary.consumed === 3);
    const p3 = await req('GET', '/api/stories/no-such-id/assign-audit');
    ok('剧情不存在返回 404', p3.status === 404);

    // 已保存剧情接口与草稿接口结论一致（短路语义）
    const createdSC = await req('POST', '/api/stories', stSC1);
    const pSC = await req('GET', `/api/stories/${createdSC.body.id}/assign-audit`);
    ok('已保存剧情接口同样只判 x 消费、y 未消费',
      pSC.status === 200
      && pSC.body.assignments.find((a) => a.variable === 'x').status === 'consumed'
      && pSC.body.assignments.find((a) => a.variable === 'y').status === 'unconsumed');

    // 草稿审计不落盘：已保存剧情内容不因审计而改变
    const draft = JSON.parse(JSON.stringify(st9));
    draft.scenes[1].assigns = [{ variable: 'x', value: false }];
    const p4 = await req('POST', '/api/assign-audit', { story: draft });
    ok('修改后的草稿审计结果不同（按草稿计算）',
      p4.status === 200 && p4.body.assignments.some((a) => a.variable === 'x' && a.value === false));
    const after = await req('GET', `/api/stories/${sid}`);
    ok('审计后剧情内容未被修改',
      JSON.stringify(after.body.scenes) === JSON.stringify(created.body.scenes));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项变量赋值消费审计断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
