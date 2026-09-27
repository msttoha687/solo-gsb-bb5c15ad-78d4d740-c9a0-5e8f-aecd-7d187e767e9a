'use strict';

// 结局必经抉择自检（node test/forcedchoice.js）
// 覆盖：线性链必经、分叉汇合（分支非必经、汇合后必经）、含环终止性、
//       同场景多状态交集、必经次序与最短见证路径、死局软锁结局、
//       起点即结局、无终止（纯循环）、旧数据 idx: 兜底 UID、
//       绕开反例 BFS（非必经必有反例 / 必经完整穷举不可绕开 / 截断不能断言）、
//       状态上限截断时不下必经结论、起点受阻、确定性、示例剧情、
//       参数校验（400）、HTTP API（草稿 / 已保存 / 404）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forcedchoice-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { analyzeForcedChoices, bypassForced } = require('../src/forcedchoice');

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

// ---------- 线性链：全部选项必经，顺序即链序 ----------
console.log('线性链：全部选项必经');
const chain = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '去 b', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', text: '去 c', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r1 = analyzeForcedChoices(chain);
ok('分析成功且完整穷举', r1.ok === true && r1.truncated === false && r1.canAssertForced === true);
eq('恰有 1 个可达终止场景', r1.endings.length, 1);
eq('终止场景为 c 且是设计结局', r1.endings[0].sceneId, 'c');
eq('结局种类为 ending', r1.endings[0].kind, 'ending');
eq('必经选项数 = 2', r1.endings[0].forcedCount, 2);
eq('必经顺序为 o1、o2',
  r1.endings[0].forcedOptions.map((f) => f.uid).join(','), 'o1,o2');
eq('必经次序标注 1/2',
  r1.endings[0].forcedOptions.map((f) => f.order).join(','), '1,2');
eq('最短见证路径深度 = 2', r1.endings[0].witnessDepth, 2);
eq('见证路径场景序列 a,b,c',
  r1.endings[0].witnessPath.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(','), 'a,b,c');
eq('见证路径选项 UID 为 o1,o2',
  r1.endings[0].witnessPath.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(','), 'o1,o2');
ok('场景节点带完整状态 / 选项边带选择后状态',
  r1.endings[0].witnessPath.every((n) => (n.kind === 'scene' ? n.state : n.stateAfter) !== undefined));
ok('非必经候选列表为空（全部必经）', r1.endings[0].candidateOptions.length === 0);

// ---------- 分叉汇合：分支选项非必经，汇合后的选项必经 ----------
console.log('分叉汇合：分支非必经、汇合后必经');
const diamond = {
  startScene: 's',
  scenes: [
    { id: 's', options: [
      { uid: 'a', text: '支路 a', target: 'm' },
      { uid: 'b', text: '支路 b', target: 'm' },
    ] },
    { id: 'm', options: [{ uid: 'c', text: '汇合后', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r2 = analyzeForcedChoices(diamond);
eq('只有 c 必经', r2.endings[0].forcedOptions.map((f) => f.uid).join(','), 'c');
eq('非必经候选恰为 a、b',
  r2.endings[0].candidateOptions.map((x) => x.uid).sort().join(','), 'a,b');
eq('最短见证深度 = 2', r2.endings[0].witnessDepth, 2);

// 绕开 a：经 b,c 到达
const b1 = bypassForced(diamond, 'e', 'a');
ok('绕开 a 存在反例', b1.found === true && b1.depth === 2);
eq('反例路径不含 a',
  b1.path.filter((n) => n.kind === 'option').some((n) => n.optionUid === 'a'), false);
eq('反例路径为 b -> c',
  b1.path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(','), 'b,c');
// 绕开必经 c：完整穷举后仍不可绕开
const b2 = bypassForced(diamond, 'e', 'c');
ok('绕开 c 无反例', b2.found === false);
ok('完整穷举 => 可断言 c 必经', b2.canAssertUnavoidable === true);
eq('不可绕开时不带路径', b2.path, null);

// ---------- 含环：可反复刷的选项非必经，出口选项也可能非必经 ----------
console.log('含环图：仍精确终止');
const loop = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    { id: 's', options: [
      { uid: 'take', text: '拿钥匙', condition: '!x', target: 's', assigns: [{ variable: 'x', value: true }] },
      { uid: 'go', text: '持钥匙走', condition: 'x', target: 'e' },
      { uid: 'skip', text: '直接走', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r3 = analyzeForcedChoices(loop);
ok('含循环剧情正常终止且结论可靠', r3.ok === true && r3.canAssertForced === true);
eq('具体状态去重后 4 个状态（s×2 + e×2：skip/go 到达 e 时 x 取值不同）', r3.counts.states, 4);
eq('结局 e 对应 2 个终止具体状态', r3.endings[0].states, 2);
eq('环上的 take 非必经、出口也有 skip 分流：无必经选项', r3.endings[0].forcedCount, 0);
ok('take、go、skip 全部作为非必经候选',
  r3.endings[0].candidateOptions.map((x) => x.uid).sort().join(',') === 'go,skip,take');
// 反例：绕开 take => 直接 skip（1 步）
const b3 = bypassForced(loop, 'e', 'take');
ok('绕开环上 take 存在 1 步反例', b3.found === true && b3.depth === 1);
eq('反例直接走 skip',
  b3.path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(','), 'skip');

// 环形“门禁”：必须先取钥匙才能走的出口 => go/skip 二选一，但 take 不是必经
const gated = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    { id: 's', options: [
      { uid: 'take', text: '拿钥匙', condition: '!x', target: 's', assigns: [{ variable: 'x', value: true }] },
      { uid: 'go', text: '持钥匙去结局', condition: 'x', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r3b = analyzeForcedChoices(gated);
eq('唯一出口剧情：take、go 都必经（顺序 take 先于 go）',
  r3b.endings[0].forcedOptions.map((f) => f.uid).join(','), 'take,go');
eq('必经见证路径 take -> go',
  r3b.endings[0].witnessPath.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(','), 'take,go');
// 环上同一选项可走多次：绕开 take 完整穷举不可达
const b3b = bypassForced(gated, 'e', 'take');
ok('绕开 take 后结局不可达 => 可断言必经', b3b.found === false && b3b.canAssertUnavoidable === true);

// ---------- 同场景多状态：结局可从两种变量状态进入，共同选项才必经 ----------
console.log('同场景多状态：按终止节点集合取交集');
const multi = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    { id: 's', options: [
      { uid: 'setX', text: '带 x', target: 'e', assigns: [{ variable: 'x', value: true }] },
      { uid: 'noX', text: '不带 x', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r4 = analyzeForcedChoices(multi);
eq('结局 e 对应 2 个终止具体状态', r4.endings[0].states, 2);
eq('两条入口不同 => 无必经选项', r4.endings[0].forcedCount, 0);
ok('两条入口都列为非必经候选',
  r4.endings[0].candidateOptions.map((x) => x.uid).sort().join(',') === 'noX,setX');
eq('绕开 setX 仍可达（走 noX）', bypassForced(multi, 'e', 'setX').found, true);
eq('绕开 noX 仍可达（走 setX）', bypassForced(multi, 'e', 'noX').found, true);

// 多状态但共享同一条入口：入口仍必经
const multiShared = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    { id: 's', options: [{ uid: 'enter', text: '进入', target: 'm' }] },
    { id: 'm', options: [
      { uid: 't', text: '置 x 到结局', target: 'e', assigns: [{ variable: 'x', value: true }] },
      { uid: 'f', text: '不置 x 到结局', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r4b = analyzeForcedChoices(multiShared);
eq('多状态共享入口 enter 必经', r4b.endings[0].forcedOptions.map((x) => x.uid).join(','), 'enter');

// ---------- 必经次序：绕路分支不改变相对次序 ----------
console.log('必经次序：按最短见证路径先后');
const orderStory = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [
      { uid: 'u1', text: '正道', target: 'b' },
      { uid: 'detour', text: '绕路', target: 'z' },
    ] },
    { id: 'z', options: [{ uid: 'back', text: '绕回来', target: 'b' }] },
    { id: 'b', options: [{ uid: 'u2', text: '继续', target: 'c' }] },
    { id: 'c', options: [{ uid: 'u3', text: '到结局', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r5 = analyzeForcedChoices(orderStory);
eq('必经为 u2、u3（绕路选项非必经）',
  r5.endings[0].forcedOptions.map((f) => f.uid).join(','), 'u2,u3');
eq('最短见证走正道（不绕 z），深度 3', r5.endings[0].witnessDepth, 3);
eq('绕开 u2 的反例不存在 => u2 必经', bypassForced(orderStory, 'e', 'u2').found, false);
eq('绕开 detour 的反例存在', bypassForced(orderStory, 'e', 'detour').found, true);

// ---------- 死局软锁：场景有选项但在终止状态下全部不可走 ----------
console.log('死局软锁结局');
const dead = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    { id: 's', options: [
      { uid: 'lock', text: '走进死局', target: 'd', assigns: [{ variable: 'x', value: true }] },
      { uid: 'go', text: '去真结局', target: 'e' },
    ] },
    { id: 'd', options: [{ uid: 'needsNoX', text: '需要 !x', condition: '!x', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r6 = analyzeForcedChoices(dead);
const byScene = Object.fromEntries(r6.endings.map((x) => [x.sceneId, x]));
ok('同时列出真结局与死局', byScene.e && byScene.d);
eq('d 标记为 deadend', byScene.d.kind, 'deadend');
eq('进入死局的 lock 必经', byScene.d.forcedOptions.map((f) => f.uid).join(','), 'lock');
eq('真结局 e 的 go 必经', byScene.e.forcedOptions.map((f) => f.uid).join(','), 'go');
eq('死局结局排在设计结局之后', r6.endings.map((x) => x.sceneId).join(','), 'e,d');

// ---------- 起点即终止 ----------
console.log('起点即终止');
const r7 = analyzeForcedChoices({ startScene: 's', scenes: [{ id: 's', options: [] }] });
eq('起点本身为结局', r7.endings.length, 1);
eq('0 必经选项、见证深度 0', r7.endings[0].forcedCount, 0);
eq('见证路径深度 = 0', r7.endings[0].witnessDepth, 0);
eq('见证路径只含起点场景', r7.endings[0].witnessPath.length, 1);

// ---------- 纯循环：没有任何终止场景 ----------
console.log('纯循环剧情：无可达终止');
const pureLoop = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    { id: 's', options: [
      { uid: 'flip', text: '翻转', target: 's', assigns: [{ variable: 'x', value: true }] },
      { uid: 'back', condition: 'x', text: '循环', target: 't' },
    ] },
    { id: 't', options: [{ uid: 'ret', text: '回 s', target: 's' }] },
  ],
};
const r8 = analyzeForcedChoices(pureLoop);
ok('完整穷举但无终止场景', r8.ok === true && r8.endings.length === 0 && r8.canAssertForced === true);

// ---------- 旧数据无 uid：退回 idx:场景#下标 ----------
console.log('旧数据 idx: 兜底 UID');
const legacy = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ text: '没 uid', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const r9 = analyzeForcedChoices(legacy);
eq('无 uid 选项以 idx:a#0 标识为必经',
  r9.endings[0].forcedOptions.map((f) => f.uid).join(','), 'idx:a#0');
const b9 = bypassForced(legacy, 'b', 'idx:a#0');
ok('idx 兜底 UID 同样可用于绕开查询且不可绕开', b9.found === false && b9.canAssertUnavoidable === true);

// ---------- 状态上限截断：不得下必经结论 ----------
console.log('状态上限截断');
const r10 = analyzeForcedChoices(chain, { maxStates: 2 });
ok('截断标记', r10.truncated === true && r10.ok === false);
ok('截断时不能下必经结论', r10.canAssertForced === false);
eq('截断时汇总 forcedOptions = null', r10.counts.forcedOptions, null);
ok('已发现的终止场景仍列出', r10.endings.some((x) => x.sceneId === 'b'));
ok('每个截断结局均 reliable=false 且 forcedOptions=null',
  r10.endings.every((x) => x.reliable === false && x.forcedOptions === null && x.forcedCount === null
    && x.witnessPath === null && x.candidateOptions === null));
ok('截断提示文案明确', /截断/.test(r10.message) && /不可靠/.test(r10.message));
// 截断时绕开查询也不能断言必经
const b10 = bypassForced(chain, 'b', 'o1', { maxStates: 2 });
ok('截断时绕开查询不可断言必经', b10.found === false && b10.canAssertUnavoidable === false && b10.truncated === true);

// ---------- 起点受阻 ----------
console.log('起点受阻');
const r11 = analyzeForcedChoices({
  startScene: 'a', variables: ['k'],
  scenes: [{ id: 'a', precondition: 'k', options: [{ uid: 'ox', target: 'b' }] }, { id: 'b', options: [] }],
});
ok('起点被挡', r11.startBlocked === true && r11.endings.length === 0);
ok('起点受阻时绕开查询返回 400', throws400(() => bypassForced({
  startScene: 'a', precondition: 'k', variables: ['k'], scenes: [{ id: 'a', precondition: 'k', options: [] }],
}, 'a', 'x'), /起点/));

// ---------- 条件语法错误容错 ----------
const badCond = analyzeForcedChoices({
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ uid: 'q1', text: 'x', condition: 'k &&', target: 'b' }] }, { id: 'b', options: [] }],
});
ok('语法错误按恒真处理：q1 仍必经',
  badCond.endings[0].forcedOptions.map((f) => f.uid).join(',') === 'q1' && badCond.conditionErrors.length === 1);

// ---------- 参数校验 ----------
console.log('参数校验');
ok('缺少起点 => 400', throws400(() => analyzeForcedChoices({ scenes: [{ id: 'a' }] }), /起点/));
ok('起点不存在 => 400', throws400(() => analyzeForcedChoices({ startScene: 'ghost', scenes: [{ id: 'a' }] }), /起点/));
ok('绕开：缺结局场景 => 400', throws400(() => bypassForced(chain, '', 'o1'), /终止场景/));
ok('绕开：缺 UID => 400', throws400(() => bypassForced(chain, 'c', ''), /UID/));
ok('绕开：结局场景不存在 => 400', throws400(() => bypassForced(chain, 'ghost', 'o1'), /不存在/));
ok('绕开：UID 不存在 => 400', throws400(() => bypassForced(chain, 'c', 'nope'), /不存在/));
ok('绕开：目标场景非终止 => 400',
  throws400(() => bypassForced(chain, 'a', 'o1'), /不是可达的终止场景/));
// 悬空选项指向的场景不是终止；diamond 中 m 非终止
ok('绕开：中途场景不算终止 => 400', throws400(() => bypassForced(diamond, 'm', 'a'), /终止场景/));
// 不可达场景也不是可达终止
const withUnreachable = {
  startScene: 's',
  scenes: [
    { id: 's', options: [{ uid: 'go', target: 'e' }] },
    { id: 'e', options: [] },
    { id: 'iso', options: [] },
  ],
};
ok('绕开：不可达的终止场景 => 400', throws400(() => bypassForced(withUnreachable, 'iso', 'go'), /终止场景/));

// ---------- 确定性：同一剧情两次结果完全一致 ----------
console.log('确定性');
eq('同一剧情两次分析结果一致', JSON.stringify(analyzeForcedChoices(orderStory)),
  JSON.stringify(analyzeForcedChoices(orderStory)));

// ---------- 示例剧情 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const d = analyzeForcedChoices(demo);
ok('示例完整穷举', d.ok === true && d.canAssertForced === true && d.truncated === false);
ok('示例识别出 2 个可达终止（throneRoom 路线终点 ending 与 castle 死局）',
  d.endings.map((x) => x.sceneId).sort().join(',') === 'castle,ending');
const endEnding = d.endings.find((x) => x.sceneId === 'ending');
ok('到达 ending 必经“走进森林”（先拿钥匙）',
  endEnding.forcedOptions.some((f) => f.sceneId === 'village' && f.optionIndex === 0));
ok('到达 ending 必经“出示古老钥匙”',
  endEnding.forcedOptions.some((f) => f.sceneId === 'castle' && f.optionIndex === 1));
ok('到达 ending 必经王座厅“登上王座”',
  endEnding.forcedOptions.some((f) => f.sceneId === 'throneRoom'));
ok('女巫支线选项不在 ending 的必经列表中',
  !endEnding.forcedOptions.some((f) => f.sceneId === 'witchTower'));
eq('必经选项严格按见证路径升序',
  endEnding.forcedOptions.map((f) => f.order).join(','),
  endEnding.forcedOptions.map((_, i) => i + 1).join(','));
eq('示例：绕开“强行撞门”（恒假、无此边标签）的 UID 不存在 => 400',
  throws400(() => bypassForced(demo, 'ending', 'does-not-exist'), /不存在/), true);
// 必经项绕不开
const throneUid = endEnding.forcedOptions.find((f) => f.sceneId === 'throneRoom').uid;
eq('示例：绕开王座厅必经项无反例', bypassForced(demo, 'ending', throneUid).found, false);

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
    // 草稿分析（不落盘）
    const q1 = await req('POST', '/api/forced-choice', chain);
    ok('POST /api/forced-choice 返回 200 且必经 o1,o2',
      q1.status === 200 && q1.body.endings[0].forcedOptions.map((f) => f.uid).join(',') === 'o1,o2');

    // { story } 包装形式同样接受
    const q1b = await req('POST', '/api/forced-choice', { story: diamond });
    ok('POST /api/forced-choice 接受 { story } 包装',
      q1b.status === 200 && q1b.body.endings[0].forcedOptions.map((f) => f.uid).join(',') === 'c');

    const q1err = await req('POST', '/api/forced-choice', { scenes: [{ id: 'a' }] });
    ok('缺少起点返回 400', q1err.status === 400 && /起点/.test(q1err.body.error || ''));

    // 截断参数注入
    const q1t = await req('POST', '/api/forced-choice', { story: chain, maxStates: 2 });
    ok('maxStates 注入生效：截断且不下结论',
      q1t.status === 200 && q1t.body.truncated === true && q1t.body.canAssertForced === false);

    // 绕开反例
    const q2 = await req('POST', '/api/forced-choice/bypass', { story: diamond, endingScene: 'e', uid: 'a' });
    ok('POST /api/forced-choice/bypass 返回反例路径',
      q2.status === 200 && q2.body.found === true && q2.body.path.length > 0);
    const q2b = await req('POST', '/api/forced-choice/bypass', { story: diamond, endingScene: 'e', uid: 'c' });
    ok('必经项绕不开：canAssertUnavoidable=true',
      q2b.status === 200 && q2b.body.found === false && q2b.body.canAssertUnavoidable === true);
    const q2err = await req('POST', '/api/forced-choice/bypass', { story: chain, endingScene: 'c', uid: 'ghost' });
    ok('绕开查询 UID 不存在返回 400', q2err.status === 400);

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', diamond);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const q3 = await req('GET', `/api/stories/${sid}/forced-choice`);
    ok('GET /api/stories/:id/forced-choice 返回分析且恰有 1 项必经',
      q3.status === 200 && q3.body.endings[0].forcedOptions.length === 1);
    const savedUid = q3.body.endings[0].forcedOptions[0].uid;
    ok('保存后选项带 opt- UID，必经按 UID 列出', /^opt-/.test(savedUid));
    const q4 = await req('POST', `/api/stories/${sid}/forced-choice/bypass`, { endingScene: 'e', uid: savedUid });
    ok('已保存剧情绕开必经项无反例', q4.status === 200 && q4.body.found === false);
    const q5 = await req('GET', '/api/stories/no-such-id/forced-choice');
    ok('剧情不存在返回 404', q5.status === 404);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项结局必经抉择断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
