'use strict';

// 分析引擎冒烟测试（非项目运行依赖，仅用于开发期自检）
const assert = require('assert');
const { analyze } = require('../src/analyzer');
const { compile } = require('../src/expression');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// ---------- 表达式 ----------
console.log('表达式解析：');
ok('空表达式恒真', compile('').evaluate({}) === true);
ok('&& / || / !', compile('a && !b || c').evaluate({ a: true, b: false, c: false }) === true);
ok('括号优先级', compile('(a || b) && c').evaluate({ a: true, b: false, c: false }) === false);
ok('未定义变量按 false', compile('a').evaluate({}) === false);
assert.throws(() => compile('a &&'), /语法错误/);
ok('语法错误抛异常', true);

const ex = compile('a && b').explain({ a: true, b: false }, true);
ok('解释树定位失败变量 b', JSON.stringify(ex.flip) === '["b"]');
const ex2 = compile('a || b').explain({ a: false, b: false }, true);
ok('OR 给出最小翻转（1 个变量）', ex2.flip.length === 1);
const ex3 = compile('!a').explain({ a: true }, true);
ok('NOT 翻转建议', ex3.flip[0] === 'a');

// ---------- SAT 精确求解 ----------
console.log('条件可满足性求解：');
const sat1 = compile('a && b && c').explain({ a: true, b: false, c: false }, true);
ok('AND 多变量翻转计数精确', sat1.flip.length === 2 && sat1.feasible === true);
const sat2 = compile('a && !a').explain({ a: false }, true);
ok('矛盾式 a && !a 判为不可满足', sat2.feasible === false && sat2.flip.length === 0);
ok('矛盾式报告冲突变量', sat2.conflicts.includes('a'));
const sat3 = compile('a || b || c').explain({ a: false, b: false, c: false }, true);
ok('OR 最少翻转 = 1', sat3.flip.length === 1);
const sat4 = compile('(a && b) || (a && !b)').explain({ a: false, b: true }, true);
ok('子句合并后仅需翻转 a', sat4.flip.length === 1 && sat4.flip[0] === 'a');
const sat5 = compile('!a && (a || b)').explain({ a: true, b: false }, true);
ok('跨分支约束推出需 b=true（翻 a、b 两个）', sat5.flip.sort().join() === 'a,b');
const sat6 = compile('a').explain({ a: true }, true);
ok('已满足条件无需翻转', sat6.flip.length === 0 && sat6.satisfied === true);
const sat7 = compile('!(a && b)').explain({ a: true, b: true }, true);
ok('否定 AND：翻任一变量即可', sat7.flip.length === 1);
const sat8 = compile('a && !a && b').explain({ a: false, b: false }, true);
ok('含矛盾的合取不可满足', sat8.feasible === false);

// ---------- 含循环但可终止 ----------
console.log('循环终止性：');
const loopStory = {
  startScene: 's1',
  variables: ['x'],
  scenes: [
    { id: 's1', options: [{ text: '循环', condition: '!x', target: 's1', assigns: [{ variable: 'x', value: true }] }, { text: '继续', condition: 'x', target: 's2' }] },
    { id: 's2', options: [{ text: '回去', condition: '', target: 's1', assigns: [{ variable: 'x', value: false }] }] },
  ],
};
const r1 = analyze(loopStory);
ok('循环故事分析正常终止', r1.ok === true);
ok('具体状态有限（s1 有 2 个状态）', r1.counts.concreteStates >= 3);
ok('两场景都可达', r1.counts.reachableScenes === 2);
ok('无问题', r1.counts.issues === 0);

// ---------- 不可达场景 ----------
console.log('缺陷检测：');
const story2 = {
  startScene: 'a',
  variables: [],
  scenes: [
    { id: 'a', options: [] },
    { id: 'orphan', options: [] },
  ],
};
const r2 = analyze(story2);
ok('检测到不可达场景', r2.issues.some((i) => i.type === 'unreachableScene' && i.sceneId === 'orphan'));

// ---------- 条件永不成立 ----------
const story3 = {
  startScene: 'a',
  variables: ['locked'],
  scenes: [
    { id: 'a', options: [{ text: '强行', condition: 'locked', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const r3 = analyze(story3);
ok('检测到 neverTrueOption', r3.issues.some((i) => i.type === 'neverTrueOption'));
ok('目标 b 不可达', r3.sceneStatus.b === 'unreachable');

// ---------- 悬空跳转 ----------
const story4 = {
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ text: 'x', target: 'ghost' }] }],
};
const r4 = analyze(story4);
ok('检测到 orphanOption', r4.issues.some((i) => i.type === 'orphanOption'));

// ---------- 入口前置冲突 ----------
const story5 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [{ text: '去', target: 'b', assigns: [{ variable: 'k', value: false }] }] },
    { id: 'b', precondition: 'k', options: [] },
  ],
};
const r5 = analyze(story5);
ok('检测到 blockedEntry', r5.issues.some((i) => i.type === 'blockedEntry'));
ok('b 状态为不可达', r5.sceneStatus.b === 'unreachable');
const bi = r5.issues.find((i) => i.type === 'blockedEntry');
ok('blockedEntry 附带未满足解释', bi.unmet && bi.unmet.flip[0] === 'k');
ok('blockedEntry 附带可达路径', bi.path.length === 3); // scene a -> option -> (b 未入列，路径只到 option)

// ---------- 起点前置不成立 ----------
const story6 = {
  startScene: 'a', variables: ['k'],
  scenes: [{ id: 'a', precondition: 'k', assigns: [{ variable: 'k', value: false }], options: [] }],
};
const r6 = analyze(story6);
ok('起点前置不成立被报告', r6.issues.some((i) => i.type === 'unreachableScene' && i.sceneId === 'a'));

// ---------- 状态赋值必须区分具体状态（同名选项不同状态下不同可达性） ----------
const story7 = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [
      { text: '拿钥匙', target: 'b', assigns: [{ variable: 'k', value: true }] },
      { text: '空手', target: 'b' },
    ] },
    { id: 'b', options: [{ text: '用钥匙', condition: 'k', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r7 = analyze(story7);
ok('同一选项在部分状态下可触发 => 不报问题', r7.counts.issues === 0);
ok('c 可达（带钥匙状态）', r7.sceneStatus.c === 'reachable');

// ---------- 示例剧情 ----------
console.log('示例剧情：');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rd = analyze(demo);
ok('示例分析终止', rd.ok);
const types = rd.issues.map((i) => i.type);
ok('示例含不可达 dungeon', types.includes('unreachableScene'));
ok('示例含 neverTrueOption（gateOpen）', types.includes('neverTrueOption'));
ok('示例含 orphanOption（dragonLair）', types.includes('orphanOption'));
ok('示例含 blockedEntry（侧门->宝库）', types.includes('blockedEntry'));
ok('王座厅可达', rd.sceneStatus.throneRoom === 'reachable');
ok('起点 village 可达', rd.sceneStatus.village === 'reachable');
const ntIssue = rd.issues.find((i) => i.type === 'neverTrueOption');
ok('neverTrueOption 附带路径与解释', ntIssue.path.length >= 2 && ntIssue.unmet);
ok('解释建议翻转 gateOpen', ntIssue.unmet.flip.includes('gateOpen'));

console.log(`\n全部 ${passed} 项断言通过 ✔`);
