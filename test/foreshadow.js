'use strict';

// 伏笔回收路线校验自检（node test/foreshadow.js）
// 覆盖：基本违规与最短路线、回收后通过、多结局取最短、铺垫不可达、无设计结局
//       （纯循环 / 仅死局）、死局待回收不算违规、状态上限截断、截断前发现违规、
//       起点即铺垫即结局、含环终止性、同场景多状态并入遍历、回收后再铺垫、
//       参数校验（400）、条件语法错误容错、起点受阻、确定性、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreshadow-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { checkForeshadow } = require('../src/foreshadow');

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

// ---------- 基本违规：铺垫后直达设计结局，未回收 ----------
console.log('基本违规：铺垫后未回收直达结局');
const st1 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '去铺垫', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', text: '去结局', target: 'e' }] },
    { id: 'e', options: [] },
    { id: 'c', options: [] }, // 回收场景（不可达，仅用于通过查询校验）
  ],
};
const r1 = checkForeshadow(st1, { setups: ['b'], payoffs: ['c'] });
eq('结论为违规', r1.status, 'violation');
ok('不通过', r1.ok === false);
eq('违规结局为 e', r1.violation.endingScene, 'e');
eq('最短违规路线深度 = 2（选项步数）', r1.violation.depth, 2);
eq('违规路径场景序列 a,b,e',
  r1.violation.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(','), 'a,b,e');
eq('违规路径选项 UID 为 o1,o2',
  r1.violation.path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(','), 'o1,o2');
ok('每个场景节点带到达时完整变量状态',
  r1.violation.path.filter((n) => n.kind === 'scene').every((n) => n.state !== undefined));
ok('每条选项边带选择后状态',
  r1.violation.path.filter((n) => n.kind === 'option').every((n) => n.stateAfter !== undefined));
const bNode = r1.violation.path.find((n) => n.kind === 'scene' && n.sceneId === 'b');
ok('铺垫场景节点标注 setup 且待回收', bNode.foreshadow === 'setup' && bNode.pending === true);
const eNode = r1.violation.path[r1.violation.path.length - 1];
ok('结局节点仍待回收', eNode.sceneId === 'e' && eNode.pending === true);
ok('铺垫可达、待回收状态被统计', r1.setupReached === true && r1.pendingStates >= 2);
eq('可达设计结局数 = 1', r1.endingCount, 1);

// ---------- 回收后通过：铺垫 -> 回收 -> 结局 ----------
console.log('回收后通过');
const st2 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'c' }] }, // 铺垫
    { id: 'c', options: [{ uid: 'o3', target: 'e' }] }, // 回收
    { id: 'e', options: [] },
  ],
};
const r2 = checkForeshadow(st2, { setups: ['b'], payoffs: ['c'] });
eq('结论为通过', r2.status, 'pass');
ok('ok=true 且未截断', r2.ok === true && r2.truncated === false);
eq('探索 4 个具体状态', r2.counts.states, 4);
eq('违规为空', r2.violation, null);
eq('设计结局明细含 e', r2.endings.map((x) => x.sceneId).join(','), 'e');
ok('通过文案说明完整探索', /校验通过/.test(r2.message) && /完整探索/.test(r2.message));

// ---------- 多条违规路线：按选项步数取最短 ----------
console.log('多条违规路线取最短');
const st3 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [
      { uid: 'long', text: '绕远路', target: 'x' },
      { uid: 'short', text: '走近路', target: 'b' },
    ] },
    { id: 'x', options: [{ uid: 'lx', target: 'y' }] },
    { id: 'y', options: [{ uid: 'ly', target: 'b' }] },
    { id: 'b', options: [{ uid: 'be', target: 'e' }] }, // 铺垫
    { id: 'e', options: [] },
    { id: 'c', options: [] }, // 回收（不可达）
  ],
};
const r3 = checkForeshadow(st3, { setups: ['b'], payoffs: ['c'] });
eq('结论为违规', r3.status, 'violation');
eq('最短违规深度 = 2（a->b->e，而非绕远路的 4 步）', r3.violation.depth, 2);
eq('最短路线首步选项为 short',
  r3.violation.path.filter((n) => n.kind === 'option')[0].optionUid, 'short');

// ---------- 铺垫不可达：单独提示 ----------
console.log('铺垫不可达');
const st4 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [] },
    { id: 'b', options: [] }, // 铺垫场景：孤岛，不可达
    { id: 'c', options: [] }, // 回收场景
  ],
};
const r4 = checkForeshadow(st4, { setups: ['b'], payoffs: ['c'] });
eq('结论为铺垫不可达', r4.status, 'setup-unreachable');
ok('不通过且不判违规', r4.ok === false && r4.violation === null);
ok('铺垫标记为未到达', r4.setupReached === false);
ok('提示文案指向铺垫未埋下', /从未进入任何铺垫场景/.test(r4.message));

// ---------- 无设计结局：纯循环 / 仅死局，分别单独提示 ----------
console.log('无设计结局');
const st5 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'a' }] }, // 铺垫，循环回 a
    { id: 'c', options: [] }, // 回收（不可达）
  ],
};
const r5 = checkForeshadow(st5, { setups: ['b'], payoffs: ['c'] });
eq('纯循环 => 无结局', r5.status, 'no-ending');
ok('铺垫可达但无设计结局', r5.setupReached === true && r5.endingCount === 0);
ok('不通过', r5.ok === false);

const st6 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    // 铺垫场景的唯一选项条件恒假 => 死局软锁（不是设计结局）
    { id: 'b', options: [{ uid: 'o2', condition: 'x', target: 'a' }] },
    { id: 'c', options: [] },
  ],
};
const r6 = checkForeshadow(st6, { setups: ['b'], payoffs: ['c'] });
eq('仅死局 => 无结局（死局不算设计结局）', r6.status, 'no-ending');
ok('死局上的待回收不算违规', r6.violation === null);

// ---------- 死局待回收不算违规：完整探索后判通过 ----------
console.log('死局待回收不算违规（通过）');
const st7 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'go', target: 'b' }] },
    { id: 'b', options: [ // 铺垫
      { uid: 'toDead', target: 'd' },
      { uid: 'toPayoff', target: 'c' },
    ] },
    { id: 'd', options: [{ uid: 'stuck', condition: 'x', target: 'a' }] }, // 死局（x 恒 false）
    { id: 'c', options: [{ uid: 'fin', target: 'e' }] }, // 回收
    { id: 'e', options: [] },
  ],
};
const r7 = checkForeshadow(st7, { setups: ['b'], payoffs: ['c'] });
eq('死局上的待回收不影响通过', r7.status, 'pass');
ok('完整探索', r7.truncated === false);

// ---------- 状态上限截断：单独提示，不能判通过 ----------
console.log('状态上限截断');
const r8 = checkForeshadow(st2, { setups: ['b'], payoffs: ['c'] }, { maxStates: 2 });
eq('截断状态', r8.status, 'truncated');
ok('截断标记且不通过', r8.truncated === true && r8.ok === false);
ok('截断文案明确', /截断/.test(r8.message) && /不能判通过/.test(r8.message));

// ---------- 截断前发现违规：违规路线确凿，仍报违规 ----------
console.log('截断前发现违规仍报违规');
const r9 = checkForeshadow(st1, { setups: ['b'], payoffs: ['c'] }, { maxStates: 3 });
eq('上限恰好够到违规状态 => 违规', r9.status, 'violation');
eq('违规深度仍为 2', r9.violation.depth, 2);
const r9b = checkForeshadow(st1, { setups: ['b'], payoffs: ['c'] }, { maxStates: 2 });
eq('超限同帧发现违规 => 仍报违规', r9b.status, 'violation');
ok('超限同帧时截断标记保留', r9b.truncated === true);

// ---------- 起点即铺垫且起点即结局：深度 0 违规 ----------
console.log('起点即铺垫即结局');
const st10 = { startScene: 'a', scenes: [{ id: 'a', options: [] }, { id: 'c', options: [] }] };
const r10 = checkForeshadow(st10, { setups: ['a'], payoffs: ['c'] });
eq('结论为违规', r10.status, 'violation');
eq('深度 = 0', r10.violation.depth, 0);
eq('路径只含起点场景', r10.violation.path.length, 1);
ok('起点节点标注铺垫且待回收',
  r10.violation.path[0].foreshadow === 'setup' && r10.violation.path[0].pending === true);

// ---------- 含环：自循环与往返循环仍终止；环上逃逸口报违规 ----------
console.log('含环图：仍终止');
const st11 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [ // 铺垫
      { uid: 'loop', text: '原地徘徊', target: 'b' },
      { uid: 'pay', text: '去回收', target: 'c' },
      { uid: 'skip', text: '直接逃走', target: 'e' },
    ] },
    { id: 'c', options: [ // 回收
      { uid: 'back', text: '再回铺垫', target: 'b' },
      { uid: 'fin', text: '迎向结局', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r11 = checkForeshadow(st11, { setups: ['b'], payoffs: ['c'] });
eq('含环仍终止且报违规', r11.status, 'violation');
eq('逃逸口 skip 构成最短违规（深度 2）', r11.violation.depth, 2);
eq('违规路线末步选项为 skip',
  r11.violation.path.filter((n) => n.kind === 'option').pop().optionUid, 'skip');

// 去掉逃逸口：所有路线都经过回收 => 通过（含环仍终止）
const st11b = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [
      { uid: 'loop', target: 'b' },
      { uid: 'pay', target: 'c' },
    ] },
    { id: 'c', options: [
      { uid: 'back', target: 'b' },
      { uid: 'fin', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r11b = checkForeshadow(st11b, { setups: ['b'], payoffs: ['c'] });
eq('含环全部回收 => 通过', r11b.status, 'pass');

// ---------- 同场景多状态：变量位图与待回收标记一起并入遍历 ----------
console.log('同场景多状态并入遍历');
const st12 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [
      { uid: 'withX', target: 'b', assigns: [{ variable: 'x', value: true }] },
      { uid: 'noX', target: 'b' },
    ] },
    { id: 'b', options: [{ uid: 'fin', target: 'e' }] }, // 铺垫
    { id: 'e', options: [] },
    { id: 'c', options: [] }, // 回收（不可达）
  ],
};
const r12 = checkForeshadow(st12, { setups: ['b'], payoffs: ['c'] });
eq('结论为违规', r12.status, 'violation');
eq('两种变量状态都展开（a + b×2 + e 违规即停）', r12.counts.states, 4);
ok('违规结局状态带变量位图', typeof r12.violation.finalState.x === 'boolean');

// ---------- 回收后再铺垫：后埋的伏笔也要回收 ----------
console.log('回收后再铺垫');
const st13 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'c' }] }, // 铺垫 1
    { id: 'c', options: [{ uid: 'o3', target: 'd' }] }, // 回收
    { id: 'd', options: [{ uid: 'o4', target: 'e' }] }, // 铺垫 2
    { id: 'e', options: [] },
  ],
};
const r13 = checkForeshadow(st13, { setups: ['b', 'd'], payoffs: ['c'] });
eq('第二处铺垫未回收 => 违规', r13.status, 'violation');
eq('违规深度 = 4', r13.violation.depth, 4);
const dNode = r13.violation.path.find((n) => n.kind === 'scene' && n.sceneId === 'd');
const cNode = r13.violation.path.find((n) => n.kind === 'scene' && n.sceneId === 'c');
ok('回收场景节点标注 payoff 且已清除', cNode.foreshadow === 'payoff' && cNode.pending === false);
ok('第二铺垫节点重新置为待回收', dNode.foreshadow === 'setup' && dNode.pending === true);

// ---------- 参数校验 ----------
console.log('参数校验');
ok('缺 query => 400', throws400(() => checkForeshadow(st2), /铺垫/));
ok('空 query => 400', throws400(() => checkForeshadow(st2, {}), /铺垫/));
ok('铺垫为空数组 => 400', throws400(() => checkForeshadow(st2, { setups: [], payoffs: ['c'] }), /铺垫/));
ok('缺回收 => 400', throws400(() => checkForeshadow(st2, { setups: ['b'] }), /回收/));
ok('铺垫场景不存在 => 400',
  throws400(() => checkForeshadow(st2, { setups: ['ghost'], payoffs: ['c'] }), /不存在/));
ok('回收场景不存在 => 400',
  throws400(() => checkForeshadow(st2, { setups: ['b'], payoffs: ['ghost'] }), /不存在/));
ok('铺垫回收重叠 => 400',
  throws400(() => checkForeshadow(st2, { setups: ['b'], payoffs: ['b'] }), /既是铺垫又是回收/));
ok('铺垫列表重复 => 400',
  throws400(() => checkForeshadow(st2, { setups: ['b', 'b'], payoffs: ['c'] }), /重复/));
ok('空行 => 400',
  throws400(() => checkForeshadow(st2, { setups: ['b', ''], payoffs: ['c'] }), /空行/));
ok('缺起点 => 400', throws400(() => checkForeshadow({ scenes: [{ id: 'a' }] }, { setups: ['a'], payoffs: ['a'] }), /起点/));
ok('起点不存在 => 400',
  throws400(() => checkForeshadow({ startScene: 'ghost', scenes: [{ id: 'a' }] }, { setups: ['a'], payoffs: ['a'] }), /起点/));

// ---------- 条件语法错误容错（按恒真处理） ----------
console.log('条件语法错误容错');
const stBad = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', condition: 'x &&', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'e' }] },
    { id: 'e', options: [] },
    { id: 'c', options: [] },
  ],
};
const rBad = checkForeshadow(stBad, { setups: ['b'], payoffs: ['c'] });
eq('语法错误按恒真处理：伏笔仍被埋下并报违规', rBad.status, 'violation');
eq('记录 1 处条件语法错误', rBad.conditionErrors.length, 1);

// ---------- 起点受阻 ----------
console.log('起点受阻');
const stBlock = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', precondition: 'k', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [] },
    { id: 'c', options: [] },
  ],
};
const rBlock = checkForeshadow(stBlock, { setups: ['b'], payoffs: ['c'] });
eq('起点受阻状态', rBlock.status, 'start-blocked');
ok('startBlocked 标记且不通过', rBlock.startBlocked === true && rBlock.ok === false);

// ---------- 确定性：同一剧情两次结果完全一致 ----------
console.log('确定性');
eq('同一剧情两次校验结果一致',
  JSON.stringify(checkForeshadow(st11, { setups: ['b'], payoffs: ['c'] })),
  JSON.stringify(checkForeshadow(st11, { setups: ['b'], payoffs: ['c'] })));

// ---------- 示例剧情：可正常运行并返回结构化结果 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rDemo = checkForeshadow(demo, { setups: ['forest'], payoffs: ['witchTower'] });
ok('示例剧情校验正常返回', typeof rDemo.status === 'string' && rDemo.counts.states > 0);
ok('示例剧情铺垫（森林）可达', rDemo.setupReached === true);

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
    const q1 = await req('POST', '/api/foreshadow', { story: st1, query: { setups: ['b'], payoffs: ['c'] } });
    ok('POST /api/foreshadow 返回 200 且报违规',
      q1.status === 200 && q1.body.status === 'violation' && q1.body.violation.depth === 2);

    const q1b = await req('POST', '/api/foreshadow', { story: st2, query: { setups: ['b'], payoffs: ['c'] } });
    ok('通过剧情返回 pass', q1b.status === 200 && q1b.body.status === 'pass' && q1b.body.ok === true);

    const q1c = await req('POST', '/api/foreshadow', { story: st2, query: { setups: ['b'], payoffs: ['b'] } });
    ok('铺垫回收重叠返回 400', q1c.status === 400 && /既是铺垫又是回收/.test(q1c.body.error || ''));

    const q1d = await req('POST', '/api/foreshadow', { story: st2, query: { setups: [], payoffs: ['c'] } });
    ok('空铺垫列表返回 400', q1d.status === 400);

    const q1e = await req('POST', '/api/foreshadow', { story: st2 });
    ok('缺查询条件返回 400', q1e.status === 400 && /铺垫/.test(q1e.body.error || ''));

    // 截断参数注入
    const q1t = await req('POST', '/api/foreshadow', { story: st2, query: { setups: ['b'], payoffs: ['c'] }, maxStates: 2 });
    ok('maxStates 注入生效：截断且不通过',
      q1t.status === 200 && q1t.body.status === 'truncated' && q1t.body.truncated === true);

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', st1);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const q2 = await req('POST', `/api/stories/${sid}/foreshadow`, { setups: ['b'], payoffs: ['c'] });
    ok('POST /api/stories/:id/foreshadow（query 直接作请求体）报违规',
      q2.status === 200 && q2.body.status === 'violation');
    const q2b = await req('POST', `/api/stories/${sid}/foreshadow`, { query: { setups: ['b'], payoffs: ['c'] } });
    ok('POST /api/stories/:id/foreshadow 接受 { query } 包装',
      q2b.status === 200 && q2b.body.status === 'violation');
    const q3 = await req('POST', '/api/stories/no-such-id/foreshadow', { setups: ['b'], payoffs: ['c'] });
    ok('剧情不存在返回 404', q3.status === 404);

    // 草稿校验不落盘：已保存剧情内容不因校验而改变
    const after = await req('GET', `/api/stories/${sid}`);
    ok('校验后剧情内容未被修改',
      JSON.stringify(after.body.scenes) === JSON.stringify(created.body.scenes));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项伏笔回收路线校验断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
