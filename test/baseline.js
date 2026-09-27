'use strict';

// 分析基线 / 稳定指纹自检（node test/baseline.js）
const assert = require('assert');
const { analyze } = require('../src/analyzer');
const { buildBaseline, compareWithBaseline } = require('../src/baseline');
const { issueFingerprint } = require('../src/fingerprint');
const storage = require('../src/storage');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// ---------- 指纹不依赖数组顺序 ----------
console.log('指纹稳定性：');
const makeStory = (sceneOrder) => ({
  startScene: 'a',
  variables: ['k'],
  scenes: sceneOrder.map((id) => {
    if (id === 'a') {
      return {
        id: 'a', options: [
          { uid: 'o1', text: '恒假选项', condition: 'k', target: 'b' },
          { uid: 'o2', text: '悬空选项', target: 'ghost' },
        ],
      };
    }
    if (id === 'b') return { id: 'b', options: [] };
    return { id, options: [] };
  }),
});
const rA = analyze(makeStory(['a', 'b', 'c']));
const rB = analyze(makeStory(['c', 'b', 'a']));
ok('两次分析问题数相同', rA.issues.length === rB.issues.length);
const fpsA = rA.issues.map((i) => i.fingerprint).sort();
const fpsB = rB.issues.map((i) => i.fingerprint).sort();
ok('场景数组顺序变化后指纹集合一致', fpsA.join() === fpsB.join());
ok('neverTrueOption 指纹相同',
  rA.issues.find((i) => i.type === 'neverTrueOption').fingerprint ===
  rB.issues.find((i) => i.type === 'neverTrueOption').fingerprint);

// ---------- 选项重排（带稳定 UID）不改变选项问题指纹 ----------
const storyOptOrder1 = {
  startScene: 'a', variables: ['k'],
  scenes: [{
    id: 'a', options: [
      { uid: 'x1', text: '正常', target: 'b' },
      { uid: 'x2', text: '恒假', condition: 'k', target: 'b' },
    ],
  }, { id: 'b', options: [] }],
};
const storyOptOrder2 = {
  ...storyOptOrder1,
  scenes: [{
    id: 'a', options: [
      { uid: 'x2', text: '恒假', condition: 'k', target: 'b' },
      { uid: 'x1', text: '正常', target: 'b' },
    ],
  }, storyOptOrder1.scenes[1]],
};
const nt1 = analyze(storyOptOrder1).issues.find((i) => i.type === 'neverTrueOption');
const nt2 = analyze(storyOptOrder2).issues.find((i) => i.type === 'neverTrueOption');
ok('选项重排后同一条 neverTrueOption 指纹不变（依赖 UID 而非下标）',
  nt1.fingerprint === nt2.fingerprint);

// 选项文案变化（身份不变）指纹也不变
const storyRenamed = {
  ...storyOptOrder1,
  scenes: [{
    id: 'a', options: [
      { uid: 'x1', text: '正常', target: 'b' },
      { uid: 'x2', text: '换了个说法', condition: 'k', target: 'b' },
    ],
  }, { id: 'b', options: [] }],
};
const nt3 = analyze(storyRenamed).issues.find((i) => i.type === 'neverTrueOption');
ok('仅选项文案变化时指纹不变', nt3.fingerprint === nt1.fingerprint);

// 目标变化 => 不同的问题
const storyRetarget = {
  ...storyOptOrder1,
  scenes: [{
    id: 'a', options: [
      { uid: 'x1', text: '正常', target: 'b' },
      { uid: 'x2', text: '恒假', condition: 'k', target: 'c' },
    ],
  }, { id: 'b', options: [] }, { id: 'c', options: [] }],
};
const nt4 = analyze(storyRetarget).issues.find((i) => i.type === 'neverTrueOption');
ok('关键目标变化 => 指纹不同', nt4.fingerprint !== nt1.fingerprint);

// ---------- 基线对比：新增 / 已修复 / 仍存在 ----------
console.log('基线对比分类：');
const initial = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '去 b（恒假）', condition: 'k', target: 'b' }] },
    { id: 'b', options: [] },
    { id: 'lonely', options: [] },
  ],
};
const baseAnalysis = analyze(initial);
const baseline = buildBaseline(baseAnalysis, initial);
ok('基线保留每条问题指纹', baseline.issues.length === baseAnalysis.issues.length);
ok('基线问题含路径快照', baseline.issues.every((i) => i.fingerprint && '_pathSig' in i));

const edited = {
  startScene: 'a', variables: ['k'],
  scenes: [
    // 修复恒假选项：进入 a 时先把 k 置真；删除孤岛 lonely；新增孤岛 isolated2
    { id: 'a', assigns: [{ variable: 'k', value: true }],
      options: [{ uid: 'o1', text: '去 b（现在可达）', condition: 'k', target: 'b' }] },
    { id: 'b', options: [] },
    { id: 'isolated2', options: [] },
  ],
};
const cmp = compareWithBaseline(baseline, analyze(edited));
ok('1 条新增（isolated2）', cmp.summary.new === 1);
ok('3 条已修复（恒假选项、不可达的 b、被删的 lonely）', cmp.summary.fixed === 3);
ok('没有“仍存在/详情变化”', cmp.summary.persistent === 0 && cmp.summary.changed === 0);

const statusByTypeScene = new Map(cmp.items.map((it) => {
  const i = it.issue || it.before;
  return [`${it.status}:${i.type}:${i.sceneId || ''}`, it];
}));
ok('新增的是不可达 isolated2', !!statusByTypeScene.get('new:unreachableScene:isolated2'));
ok('已修复的是原 neverTrueOption', cmp.items.some((it) => it.status === 'fixed' && it.before.type === 'neverTrueOption'));
ok('lonely 不可达被修复（场景已删除）',
  cmp.items.some((it) => it.status === 'fixed' && it.before.type === 'unreachableScene' && it.before.sceneId === 'lonely'));

// ---------- 同一问题路径 / 文案变化 => changed 且保留前后路径 ----------
console.log('详情变化：');
// tail 唯一通路是 x 上条件恒假的选项；故事 1 中 x 从 a 一步可达
const story1 = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [{ uid: 'p1', text: '进入 x', target: 'x' }] },
    { id: 'x', options: [{ uid: 'x1', text: '去 tail（条件恒假）', condition: 'k', target: 'tail' }] },
    { id: 'tail', options: [] },
  ],
};
// 故事 2：在 a 与 x 之间插入场景 m，tail 的身份要素不变，但最接近可达路径变长
const story2 = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [{ uid: 'p0', text: '先经过中间场景', target: 'm' }] },
    { id: 'm', options: [{ uid: 'm1', text: '继续', target: 'x' }] },
    { id: 'x', options: [{ uid: 'x1', text: '去 tail（条件恒假）', condition: 'k', target: 'tail' }] },
    { id: 'tail', options: [] },
  ],
};
const b2 = buildBaseline(analyze(story1), story1);
const cmp2 = compareWithBaseline(b2, analyze(story2));
const tailItem = cmp2.items.find((it) => (it.issue || it.before).sceneId === 'tail');
ok('tail 问题仍在', !!tailItem && tailItem.status !== 'new' && tailItem.status !== 'fixed');
ok('路径变长时标记为详情变化（path）',
  tailItem.status === 'changed' && tailItem.changes.includes('path'));
ok('changed 条目保留基线（before）路径与当前路径',
  Array.isArray(tailItem.before.path) && Array.isArray(tailItem.issue.path) &&
  tailItem.before.path.length < tailItem.issue.path.length);

// 无关元素变化（不影响 tail 的路径节点：路径签名不含场景标题）=> 仍存在
const story3 = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', title: '场景 a 改了标题', options: [{ uid: 'p1', text: '进入 x', target: 'x' }] },
    { id: 'x', options: [{ uid: 'x1', text: '去 tail（条件恒假）', condition: 'k', target: 'tail' }] },
    { id: 'tail', options: [] },
  ],
};
const cmp3 = compareWithBaseline(b2, analyze(story3));
const tailItem3 = cmp3.items.find((it) => (it.issue || it.before).sceneId === 'tail');
ok('无关标题变化时 tail 仍为仍存在', tailItem3.status === 'persistent');

// 文案变化（message）：恒假选项文案本身改变 => 同一问题标记 message 变化
const story4 = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [{ uid: 'p1', text: '进入 x', target: 'x' }] },
    { id: 'x', options: [{ uid: 'x1', text: '换了说法的恒假入口', condition: 'k', target: 'tail' }] },
    { id: 'tail', options: [] },
  ],
};
const cmp4 = compareWithBaseline(b2, analyze(story4));
const ntItem = cmp4.items.find((it) => (it.issue || it.before).type === 'neverTrueOption');
ok('问题消息文案变化 => changed 且 changes 含 message',
  ntItem.status === 'changed' && ntItem.changes.includes('message'));

// ---------- 顺序无关：基线问题数组打乱后对比结果不变 ----------
const shuffled = { ...baseline, issues: [...baseline.issues].reverse() };
const cmpShuffled = compareWithBaseline(shuffled, analyze(edited));
ok('基线问题顺序不影响分类', JSON.stringify(cmpShuffled.summary) === JSON.stringify(cmp.summary));

// ---------- 结构性错误的稳定指纹 ----------
console.log('错误指纹：');
const errStory1 = { startScene: 'a', scenes: [{ id: 'a', precondition: 'a &&', options: [] }] };
const errStory2 = { startScene: 'a', scenes: [{ id: 'a', precondition: 'a &&', options: [] }, { id: 'z', options: [] }] };
const e1 = analyze(errStory1).issues.find((i) => i.code === 'badSyntax');
const e2 = analyze(errStory2).issues.find((i) => i.code === 'badSyntax');
ok('语法错误有指纹且不受场景顺序影响', e1.fingerprint === e2.fingerprint);

// 选项上的语法错误携带稳定选项 UID（重排选项后仍是同一条错误）
const errOpt1 = analyze({
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ uid: 'good-opt', condition: '', target: 'a' }, { uid: 'bad-opt', condition: 'a &&', target: 'a' }] }],
}).issues.find((i) => i.code === 'badSyntax');
const errOpt2 = analyze({
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ uid: 'bad-opt', condition: 'a &&', target: 'a' }, { uid: 'good-opt', condition: '', target: 'a' }] }],
}).issues.find((i) => i.code === 'badSyntax');
ok('选项语法错误按 UID 识别（重排后指纹不变）',
  errOpt1.optionUid === 'bad-opt' && errOpt1.fingerprint === errOpt2.fingerprint);

// ---------- 存储：基线随剧情持久化、选项 UID 回填 ----------
console.log('持久化：');
const norm = storage.normalize({
  title: 't', startScene: 'a',
  scenes: [{ id: 'a', options: [{ text: '无 UID 旧选项', target: 'b' }, { uid: 'keep-uid', text: '已有 UID' }] }],
});
ok('旧选项在保存时回填 UID',
  norm.scenes[0].options[0].uid.startsWith('opt-') && norm.scenes[0].options[1].uid === 'keep-uid');
const norm2 = storage.normalize({
  ...norm,
  scenes: [{ id: 'a', options: [
    { uid: 'dup', text: '1' }, { uid: 'dup', text: '2' },
  ] }],
});
ok('重复 UID 被重新分配', new Set(norm2.scenes[0].options.map((o) => o.uid)).size === 2);

const validBaseline = { savedAt: '2026-01-01T00:00:00Z', issues: [{ fingerprint: 'abcdef1234567890', type: 'error', message: 'x', path: [] }] };
ok('合法基线被保留', storage.sanitizeBaseline(validBaseline) !== null);
ok('非法基线被丢弃', storage.sanitizeBaseline({ issues: [{ message: '无指纹' }] }) === null);
ok('空基线被丢弃', storage.sanitizeBaseline(null) === null);

// 回填 UID 后，旧剧情选项问题在下标稳定时仍可匹配（idx: 兜底）
const legacyStory = {
  startScene: 'a', variables: ['k'],
  scenes: [{ id: 'a', options: [{ text: '旧选项', condition: 'k', target: 'b' }] }, { id: 'b', options: [] }],
};
const legacyAnalyzed = analyze(legacyStory);
ok('无 UID 选项使用 场景#下标 兜底指纹',
  legacyAnalyzed.issues.some((i) => i.type === 'neverTrueOption' && i.optionUid === 'idx:a#0'));

console.log(`\n全部 ${passed} 项基线断言通过 ✔`);
