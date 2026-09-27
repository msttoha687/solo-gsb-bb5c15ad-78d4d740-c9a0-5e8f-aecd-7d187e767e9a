'use strict';

// 节奏校验自检（node test/pacing.js）
// 覆盖：基本超限与最短路线、非高强度清零、清零后重新累计、多路线取最短、
//       环路中连续段累计（自环超限 / 环中喘息永不超限）、连续计数并入去重键
//       （同场景同变量状态不同计数不合并、同场景多变量状态）、起点即高强度、
//       条件不可走路线不计入、死局不算超限、状态上限截断、截断前发现超限、
//       参数校验（400）、条件语法错误容错、起点受阻、确定性、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacing-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { checkPacing } = require('../src/pacing');

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

// ---------- 基本超限：连续 3 个高强度场景，允许 2 个，中途（非结局）即超限 ----------
console.log('基本超限：连续高强度段超过允许上限');
const st1 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '进入第一场高强度', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', text: '第二场', target: 'c' }] },
    { id: 'c', options: [{ uid: 'o3', text: '第三场', target: 'd' }] },
    { id: 'd', options: [{ uid: 'o4', text: '离开（超限在进入时已成立）', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const q1 = { highIntensityScenes: ['b', 'c', 'd'], maxConsecutive: 2 };
const r1 = checkPacing(st1, q1);
eq('结论为违规', r1.status, 'violation');
ok('不通过', r1.ok === false);
eq('超限场景为 d', r1.violation.sceneId, 'd');
eq('超限连续计数 = 3', r1.violation.streak, 3);
eq('最短违规路线深度 = 3（选项步数）', r1.violation.depth, 3);
eq('违规路径场景序列 a,b,c,d',
  r1.violation.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(','), 'a,b,c,d');
eq('违规路径选项 UID 为 o1,o2,o3',
  r1.violation.path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(','), 'o1,o2,o3');
ok('每个场景节点带到达时完整变量状态',
  r1.violation.path.filter((n) => n.kind === 'scene').every((n) => n.state !== undefined));
ok('每个场景节点带连续计数',
  r1.violation.path.filter((n) => n.kind === 'scene').every((n) => Number.isInteger(n.streak)));
ok('每条选项边带选择后连续计数',
  r1.violation.path.filter((n) => n.kind === 'option').every((n) => Number.isInteger(n.streakAfter)));
const sceneStreaks = r1.violation.path.filter((n) => n.kind === 'scene').map((n) => n.streak);
eq('沿途连续计数为 0,1,2,3', sceneStreaks.join(','), '0,1,2,3');
ok('高强度场景节点带 highIntensity 标记',
  r1.violation.path.filter((n) => n.kind === 'scene' && n.sceneId !== 'a').every((n) => n.highIntensity === true));
eq('观测到的最长连续段 = 3', r1.maxStreak, 3);

// ---------- 非高强度场景清零：通过 ----------
console.log('非高强度场景清零后通过');
const st2 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'l' }] },   // 高强度
    { id: 'l', options: [{ uid: 'ol', target: 'c' }] },   // 喘息（非高强度）：清零
    { id: 'c', options: [{ uid: 'o3', target: 'd' }] },   // 高强度
    { id: 'd', options: [{ uid: 'o4', target: 'e' }] },   // 高强度（连续 2，未超限）
    { id: 'e', options: [] },                              // 非高强度结局
  ],
};
const q2 = { highIntensityScenes: ['b', 'c', 'd'], maxConsecutive: 2 };
const r2 = checkPacing(st2, q2);
eq('结论为通过', r2.status, 'pass');
ok('ok=true 且未截断', r2.ok === true && r2.truncated === false);
eq('观测到的最长连续段 = 2', r2.maxStreak, 2);
eq('完整探索 6 个具体状态', r2.counts.states, 6);
eq('违规为空', r2.violation, null);
ok('全部勾选场景可达', r2.reachedHighScenes.length === 3);
ok('通过文案含完整探索与最长连续段',
  /校验通过/.test(r2.message) && /完整探索/.test(r2.message) && /最长连续段为 2/.test(r2.message));

// 对照：把喘息场景也标成高强度 => 连续 3 个 => 违规
const r2b = checkPacing(st2, { highIntensityScenes: ['b', 'l', 'c', 'd'], maxConsecutive: 2 });
eq('缺少喘息场景即连续超限', r2b.status, 'violation');
eq('超限深度 = 3（b,l,c）', r2b.violation.depth, 3);

// ---------- 多条违规路线：按选项步数取最短 ----------
console.log('多条违规路线取最短');
const st3 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [
      { uid: 'long', text: '绕远路', target: 'p' },
      { uid: 'short', text: '直奔高强度', target: 'h1' },
    ] },
    { id: 'p', options: [{ uid: 'lp', target: 'q' }] },
    { id: 'q', options: [{ uid: 'lq', target: 'h1' }] },
    { id: 'h1', options: [{ uid: 'h12', target: 'h2' }] },
    { id: 'h2', options: [] },
  ],
};
const r3 = checkPacing(st3, { highIntensityScenes: ['h1', 'h2'], maxConsecutive: 1 });
eq('结论为违规', r3.status, 'violation');
eq('最短违规深度 = 2（a->h1->h2，而非绕远路的 4 步）', r3.violation.depth, 2);
eq('最短路线首步选项为 short',
  r3.violation.path.filter((n) => n.kind === 'option')[0].optionUid, 'short');

// ---------- 连续计数并入「场景 + 变量状态」去重键：不同计数不得合并 ----------
console.log('连续计数并入去重键');
const st4 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [ // 非高强度：两条路到达同一场景 c（高强度），连续计数不同
      { uid: 'direct', text: '直接进入 c', target: 'c' },       // c 的计数 = 1
      { uid: 'viaX', text: '先经过 x', target: 'x' },
    ] },
    { id: 'x', options: [{ uid: 'x2c', target: 'c' }] },        // 高强度：c 的计数 = 2
    { id: 'c', options: [{ uid: 'c2e', target: 'e' }] },        // 高强度
    { id: 'e', options: [] },                                   // 非高强度：清零
  ],
};
const r4 = checkPacing(st4, { highIntensityScenes: ['x', 'c'], maxConsecutive: 1 });
// 若错误地只按 (场景, 变量状态) 去重，viaX 到达的 c（计数 2）会被 direct 的 c（计数 1）吞掉而漏报
eq('计数并入键 => 经 x 的路线超限', r4.status, 'violation');
eq('超限深度 = 2（a->x->c）', r4.violation.depth, 2);
eq('超限路线为 a,x,c',
  r4.violation.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(','), 'a,x,c');
// 允许上限放宽到 2：两条路线均不超限
const r4b = checkPacing(st4, { highIntensityScenes: ['x', 'c'], maxConsecutive: 2 });
eq('上限放宽到 2 => 通过', r4b.status, 'pass');

// ---------- 同场景多变量状态：变量位图同样并入遍历 ----------
console.log('同场景多变量状态并入遍历');
const st5 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [
      { uid: 'withX', target: 'h', assigns: [{ variable: 'x', value: true }] },
      { uid: 'noX', target: 'h' },
    ] },
    { id: 'h', options: [{ uid: 'loop', target: 'h' }] }, // 高强度自环
  ],
};
const r5 = checkPacing(st5, { highIntensityScenes: ['h'], maxConsecutive: 1 });
eq('结论为违规', r5.status, 'violation');
eq('违规深度 = 2（h 自环一圈）', r5.violation.depth, 2);
ok('违规结局状态带变量位图', typeof r5.violation.finalState.x === 'boolean');
ok('起点 + 两种变量状态的 h 均入队后才发现违规（>=3 状态）', r5.counts.states >= 3);

// ---------- 环路：高强度自环，连续段逐圈累计 ----------
console.log('含环图：连续段随环累计');
const st6 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'h' }] },
    { id: 'h', options: [ // 高强度：可自环徘徊，也可去结局
      { uid: 'loop', text: '再来一场', target: 'h' },
      { uid: 'fin', text: '去平静结局', target: 'e' },
    ] },
    { id: 'e', options: [] }, // 非高强度
  ],
};
const r6 = checkPacing(st6, { highIntensityScenes: ['h'], maxConsecutive: 2 });
eq('自环第三场超限', r6.status, 'violation');
eq('超限计数 = 3', r6.violation.streak, 3);
eq('违规路线 a,h,h,h（深度 3）',
  r6.violation.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(','), 'a,h,h,h');
// 上限放宽：自环两次（streak3）仍超 max2? 不，max=3 时自环两圈 streak3 不超，第三圈才超；
// 存在平静出口 e，BFS 仍会发现自环超限
const r6b = checkPacing(st6, { highIntensityScenes: ['h'], maxConsecutive: 3 });
eq('max=3：自环两圈不超、三圈超（streak4，深度4）',
  r6b.violation.streak, 4);

// 环中每圈都有非高强度喘息：计数每圈清零，永不超限
const st7 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'h' }] },
    { id: 'h', options: [{ uid: 'toL', target: 'l' }] }, // 高强度
    { id: 'l', options: [{ uid: 'toH', target: 'h' }] }, // 非高强度喘息：清零
  ],
};
const r7 = checkPacing(st7, { highIntensityScenes: ['h'], maxConsecutive: 1 });
eq('环中喘息每圈清零 => 完整遍历且通过', r7.status, 'pass');
eq('最长连续段始终为 1', r7.maxStreak, 1);

// ---------- 起点即高强度：初始连续计数为 1 ----------
console.log('起点即高强度');
const st8 = {
  startScene: 'h0',
  scenes: [
    { id: 'h0', options: [{ uid: 'o1', target: 'h1' }] },
    { id: 'h1', options: [] },
  ],
};
const r8 = checkPacing(st8, { highIntensityScenes: ['h0', 'h1'], maxConsecutive: 1 });
eq('起点计数为 1，再进一个高强度即超限', r8.status, 'violation');
eq('超限深度 = 1', r8.violation.depth, 1);
eq('起点节点连续计数 = 1', r8.violation.path[0].streak, 1);
// 起点即高强度但本身就是终点：计数 1 不超 max1
const st8b = { startScene: 'h0', scenes: [{ id: 'h0', options: [] }] };
const r8b = checkPacing(st8b, { highIntensityScenes: ['h0'], maxConsecutive: 1 });
eq('仅起点且计数 1 不超限 => 通过', r8b.status, 'pass');

// ---------- 条件不成立的路线不可走：唯一超限路线被条件挡住 => 通过 ----------
console.log('按选项条件与场景前置遍历：不可走路线不计入');
const st9 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [
      { uid: 'blocked', condition: 'x', target: 'h1' }, // x 恒 false：不可走
      { uid: 'calm', target: 'e' },
    ] },
    { id: 'h1', options: [{ uid: 'o2', target: 'h2' }] },
    { id: 'h2', options: [] },
    { id: 'e', options: [] },
  ],
};
const r9 = checkPacing(st9, { highIntensityScenes: ['h1', 'h2'], maxConsecutive: 1 });
eq('唯一超限路线选项恒假 => 通过', r9.status, 'pass');
ok('不可达的高强度场景被单独列出',
  r9.reachedHighScenes.length === 0 && r9.query.highIntensityScenes.length === 2);

// 目标场景前置条件挡路同样不构成边
const st9b = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'h1' }] },
    { id: 'h1', precondition: 'x', options: [] }, // 入口前置恒不成立
  ],
};
const r9b = checkPacing(st9b, { highIntensityScenes: ['h1'], maxConsecutive: 1 });
eq('入口前置恒不成立 => 高强度场景不可达，通过', r9b.status, 'pass');

// ---------- 死局软锁（有选项但全不可走）：停在死局，不构成超限 ----------
console.log('死局不算超限');
const st10 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'h' }] },
    { id: 'h', options: [{ uid: 'stuck', condition: 'x', target: 'h2' }] },
    { id: 'h2', options: [] },
  ],
};
const r10 = checkPacing(st10, { highIntensityScenes: ['h', 'h2'], maxConsecutive: 1 });
eq('死局停留不继续累计 => 通过', r10.status, 'pass');
eq('最长连续段 = 1（h2 不可达）', r10.maxStreak, 1);

// ---------- 状态上限截断：无法判定，不能判通过 ----------
console.log('状态上限截断');
const r11 = checkPacing(st2, q2, { maxStates: 3 });
eq('截断状态', r11.status, 'truncated');
ok('截断标记且不通过', r11.truncated === true && r11.ok === false);
ok('截断文案明确', /截断/.test(r11.message) && /不能判通过/.test(r11.message));

// ---------- 截断前发现超限：超限路线确凿，仍报违规 ----------
console.log('截断前发现超限仍报违规');
const r12 = checkPacing(st1, q1, { maxStates: 4 });
eq('上限恰好够到超限状态 => 违规', r12.status, 'violation');
eq('违规深度仍为 3', r12.violation.depth, 3);
const r12b = checkPacing(st1, q1, { maxStates: 3 });
eq('超限同帧达到上限 => 仍报违规', r12b.status, 'violation');
ok('超限同帧时截断标记保留', r12b.truncated === true);

// ---------- 参数校验 ----------
console.log('参数校验');
ok('缺 query => 400', throws400(() => checkPacing(st2), /高强度/));
ok('空 query => 400', throws400(() => checkPacing(st2, {}), /高强度/));
ok('高强度为空数组 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: [], maxConsecutive: 2 }), /高强度/));
ok('缺最长连续数 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['b'] }), /最长连续/));
ok('最长连续数为 0 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['b'], maxConsecutive: 0 }), /1～10/));
ok('最长连续数为 11 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['b'], maxConsecutive: 11 }), /1～10/));
ok('最长连续数为小数 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['b'], maxConsecutive: 1.5 }), /1～10/));
ok('最长连续数为字符串 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['b'], maxConsecutive: '2' }), /1～10/));
ok('边界值 1 合法',
  checkPacing(st2, { highIntensityScenes: ['b'], maxConsecutive: 1 }).status !== undefined);
ok('边界值 10 合法',
  checkPacing(st2, { highIntensityScenes: ['b'], maxConsecutive: 10 }).status !== undefined);
ok('高强度场景不存在 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['ghost'], maxConsecutive: 2 }), /不存在/));
ok('高强度列表重复 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['b', 'b'], maxConsecutive: 2 }), /重复/));
ok('空行 => 400',
  throws400(() => checkPacing(st2, { highIntensityScenes: ['b', ''], maxConsecutive: 2 }), /空行/));
ok('缺起点 => 400',
  throws400(() => checkPacing({ scenes: [{ id: 'a' }] }, { highIntensityScenes: ['a'], maxConsecutive: 2 }), /起点/));
ok('起点不存在 => 400',
  throws400(() => checkPacing({ startScene: 'ghost', scenes: [{ id: 'a' }] },
    { highIntensityScenes: ['a'], maxConsecutive: 2 }), /起点/));

// ---------- 条件语法错误容错（按恒真处理） ----------
console.log('条件语法错误容错');
const stBad = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', condition: 'x &&', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const rBad = checkPacing(stBad, { highIntensityScenes: ['b', 'c'], maxConsecutive: 1 });
eq('语法错误按恒真处理：路线可走并报超限', rBad.status, 'violation');
eq('记录 1 处条件语法错误', rBad.conditionErrors.length, 1);

// ---------- 起点受阻 ----------
console.log('起点受阻');
const stBlock = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', precondition: 'k', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const rBlock = checkPacing(stBlock, { highIntensityScenes: ['b'], maxConsecutive: 2 });
eq('起点受阻状态', rBlock.status, 'start-blocked');
ok('startBlocked 标记且不通过', rBlock.startBlocked === true && rBlock.ok === false);

// ---------- 确定性：同一剧情两次结果完全一致 ----------
console.log('确定性');
eq('同一剧情两次校验结果一致',
  JSON.stringify(checkPacing(st1, q1)),
  JSON.stringify(checkPacing(st1, q1)));

// ---------- 示例剧情：可正常运行并返回结构化结果 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rDemo = checkPacing(demo, { highIntensityScenes: ['forest', 'castle'], maxConsecutive: 1 });
ok('示例剧情校验正常返回', typeof rDemo.status === 'string' && rDemo.counts.states > 0);
ok('示例剧情森林自环即连续第二场 => 违规', rDemo.status === 'violation');

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
    // 草稿校验（不落盘）
    const qApi = { story: st1, query: q1 };
    const p1 = await req('POST', '/api/pacing', qApi);
    ok('POST /api/pacing 返回 200 且报违规',
      p1.status === 200 && p1.body.status === 'violation' && p1.body.violation.depth === 3);

    const p1b = await req('POST', '/api/pacing', { story: st2, query: q2 });
    ok('通过剧情返回 pass', p1b.status === 200 && p1b.body.status === 'pass' && p1b.body.ok === true);

    const p1c = await req('POST', '/api/pacing', { story: st2, query: { highIntensityScenes: ['b'], maxConsecutive: 11 } });
    ok('最长连续数越界返回 400', p1c.status === 400 && /1～10/.test(p1c.body.error || ''));

    const p1d = await req('POST', '/api/pacing', { story: st2, query: { highIntensityScenes: [], maxConsecutive: 2 } });
    ok('空高强度列表返回 400', p1d.status === 400);

    const p1e = await req('POST', '/api/pacing', { story: st2 });
    ok('缺查询条件返回 400', p1e.status === 400 && /高强度/.test(p1e.body.error || ''));

    // 截断参数注入
    const p1t = await req('POST', '/api/pacing', { story: st2, query: q2, maxStates: 2 });
    ok('maxStates 注入生效：截断且不通过',
      p1t.status === 200 && p1t.body.status === 'truncated' && p1t.body.truncated === true);

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', st1);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const p2 = await req('POST', `/api/stories/${sid}/pacing`, q1);
    ok('POST /api/stories/:id/pacing（query 直接作请求体）报违规',
      p2.status === 200 && p2.body.status === 'violation');
    const p2b = await req('POST', `/api/stories/${sid}/pacing`, { query: q1 });
    ok('POST /api/stories/:id/pacing 接受 { query } 包装',
      p2b.status === 200 && p2b.body.status === 'violation');
    const p3 = await req('POST', '/api/stories/no-such-id/pacing', q1);
    ok('剧情不存在返回 404', p3.status === 404);

    // 草稿校验不落盘：已保存剧情内容不因校验而改变
    const after = await req('GET', `/api/stories/${sid}`);
    ok('校验后剧情内容未被修改',
      JSON.stringify(after.body.scenes) === JSON.stringify(created.body.scenes));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项节奏校验断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
