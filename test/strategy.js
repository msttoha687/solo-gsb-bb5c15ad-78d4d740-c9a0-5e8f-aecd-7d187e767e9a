'use strict';

// 结局保证到达（玩家策略求解）自检（node test/strategy.js）
// 覆盖：线性链可保证与层级 / 推荐、环境全部分支获胜才可保证、非目标死局（含环境
//       无合法后继）、可无限停留的循环、目标不可达、玩家按状态选择策略、同场景
//       多变量状态、推荐必进入更低层级、起点即目标、权重不参与、状态上限截断、
//       起点受阻、参数校验（400）、条件语法错误容错、确定性、示例剧情、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { solveStrategy } = require('../src/strategy');

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

// ---------- 线性链：全玩家控制 => 可保证，层级沿链递减，推荐进入更低层级 ----------
console.log('线性链：可保证与层级 / 推荐');
const st1 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '去 b', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', text: '去 t', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const r1 = solveStrategy(st1, { targetScene: 't', environmentScenes: [] });
eq('结论为可保证', r1.status, 'guaranteed');
ok('ok=true 且 guaranteed=true', r1.ok === true && r1.guaranteed === true);
eq('起点层级 = 2（最坏 2 步）', r1.start.rank, 2);
eq('起点控制方为玩家', r1.start.controller, 'player');
eq('获胜玩家状态数 = 2（a、b；目标终止状态不列入）', r1.winningStates.length, 2);
eq('a 的推荐选项为 o1', r1.winningStates.find((w) => w.sceneId === 'a').recommend.uid, 'o1');
eq('b 的推荐选项为 o2', r1.winningStates.find((w) => w.sceneId === 'b').recommend.uid, 'o2');
ok('每个获胜玩家状态的推荐都进入更低层级',
  r1.winningStates.every((w) => w.recommend && w.recommend.nextRank === w.rank - 1));
ok('获胜玩家状态带完整变量值', r1.winningStates.every((w) => w.state && typeof w.state === 'object'));
eq('目标状态计数 = 1', r1.counts.targetStates, 1);
eq('环境状态数 = 0', r1.counts.envStates, 0);
ok('回显目标与环境列表', r1.query.targetScene === 't' && r1.query.environmentScenes.length === 0);

// ---------- 环境状态：全部后继获胜才获胜；一个出口进死局即无法保证 ----------
console.log('环境状态的全部分支约束');
const st2 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'x' }] },
    {
      id: 'x', options: [
        { uid: 'good', text: '通往结局', target: 't' },
        { uid: 'bad', text: '通往死局', target: 'd' },
      ],
    },
    { id: 'd', options: [{ uid: 'stuck', condition: 'k', target: 't' }] }, // 条件恒假 => 死局软锁
    { id: 't', options: [] },
  ],
};
const r2 = solveStrategy(st2, { targetScene: 't', environmentScenes: ['x'] });
eq('环境可选死局 => 无法保证', r2.status, 'unguaranteed');
ok('ok=false 且 guaranteed=false', r2.ok === false && r2.guaranteed === false);
eq('失败原因为非目标死局', r2.failure.reason, 'deadend');
eq('死局场景为 d', r2.failure.deadendScene.sceneId, 'd');
ok('目标从起点可达', r2.failure.targetReachable === true);
eq('反制路线场景序列 a,x,d',
  r2.failure.witnessPath.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(','), 'a,x,d');
ok('死局场景节点带 terminal 标记',
  r2.failure.witnessPath.some((n) => n.kind === 'scene' && n.terminal === true));
ok('反制路线选项边带控制方标记',
  r2.failure.witnessPath.filter((n) => n.kind === 'option').every((n) => n.controller === 'player' || n.controller === 'env'));
eq('x 的控制方为环境', r2.failure.witnessPath.find((n) => n.kind === 'scene' && n.sceneId === 'x').controller, 'env');

// 对照：环境两个出口都到目标 => 可保证
const st2b = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'x' }] },
    { id: 'x', options: [{ uid: 'g1', target: 't' }, { uid: 'g2', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const r2b = solveStrategy(st2b, { targetScene: 't', environmentScenes: ['x'] });
eq('环境全部出口到目标 => 可保证', r2b.status, 'guaranteed');
eq('起点层级 = 2', r2b.start.rank, 2);
eq('环境状态计数 = 1', r2b.counts.envStates, 1);

// ---------- 环境状态没有任何合法后继 => 非目标死局，无法保证 ----------
console.log('环境状态无合法后继');
const st3 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [{ uid: 'go', condition: 'k', target: 't' }] }, // 恒假：环境被卡死
    { id: 't', options: [] },
  ],
};
const r3 = solveStrategy(st3, { targetScene: 't', environmentScenes: ['e'] });
eq('环境无合法后继 => 无法保证', r3.status, 'unguaranteed');
eq('失败原因为死局', r3.failure.reason, 'deadend');
eq('死局场景为 e', r3.failure.deadendScene.sceneId, 'e');

// ---------- 可无限停留的循环：环境可永远绕圈 => 无法保证（loop） ----------
console.log('可无限停留的循环不算成功');
const st4 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'l' }] },
    {
      id: 'l', options: [
        { uid: 'stay', text: '再来一圈', target: 'l' },
        { uid: 'exit', text: '去结局', target: 't' },
      ],
    },
    { id: 't', options: [] },
  ],
};
const r4 = solveStrategy(st4, { targetScene: 't', environmentScenes: ['l'] });
eq('环境可无限停留 => 无法保证', r4.status, 'unguaranteed');
eq('失败原因为循环', r4.failure.reason, 'loop');
eq('循环场景为 l', r4.failure.cycleScenes.map((c) => c.sceneId).join(','), 'l');
ok('见证路线含循环标记的场景节点',
  r4.failure.witnessPath.some((n) => n.kind === 'scene' && n.inCycle === true && n.sceneId === 'l'));
ok('循环见证路线回到循环入口（末节点在循环中）',
  r4.failure.witnessPath[r4.failure.witnessPath.length - 1].inCycle === true);

// 对照：同一循环由玩家控制 => 玩家选 exit，可保证
const r4b = solveStrategy(st4, { targetScene: 't', environmentScenes: [] });
eq('循环由玩家控制 => 可保证', r4b.status, 'guaranteed');
const lWin = r4b.winningStates.find((w) => w.sceneId === 'l');
eq('玩家在循环状态的推荐为 exit', lWin.recommend.uid, 'exit');
eq('exit 直接进入层级 0（目标）', lWin.recommend.nextRank, 0);

// ---------- 目标不可达：完整探索后没有任何路线到目标 ----------
console.log('目标不可达');
const st5 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'a' }] },
    { id: 't', options: [] },
  ],
};
const r5 = solveStrategy(st5, { targetScene: 't', environmentScenes: [] });
eq('目标不可达 => 无法保证', r5.status, 'unguaranteed');
eq('失败原因为目标不可达', r5.failure.reason, 'unreachable');
ok('targetReachable=false', r5.failure.targetReachable === false);
ok('不可达文案明确', /没有任何路线到达目标结局/.test(r5.message));
ok('仍给出可无限绕圈的场景', r5.failure.cycleScenes.length === 2);

// ---------- 玩家按状态选择：prepare 设 k 后环境被迫到目标；rush 则环境死局 ----------
console.log('玩家策略需按状态选择');
const st6 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'prepare', text: '先拿到钥匙', target: 'x', assigns: [{ variable: 'k', value: true }] },
        { uid: 'rush', text: '直接冲过去', target: 'x' },
      ],
    },
    { id: 'x', options: [{ uid: 'go', condition: 'k', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const r6 = solveStrategy(st6, { targetScene: 't', environmentScenes: ['x'] });
eq('存在正确策略 => 可保证', r6.status, 'guaranteed');
eq('起点推荐 prepare（而非 rush）', r6.start.recommend.uid, 'prepare');
eq('起点状态带变量值 k=false', r6.start.state.k, false);

// 对照：只有 rush 可走 => 环境在 x 无合法后继，无法保证
const st6b = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [{ uid: 'rush', target: 'x' }] },
    { id: 'x', options: [{ uid: 'go', condition: 'k', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const r6b = solveStrategy(st6b, { targetScene: 't', environmentScenes: ['x'] });
eq('缺少 prepare => 无法保证', r6b.status, 'unguaranteed');
eq('失败原因为死局', r6b.failure.reason, 'deadend');

// ---------- 同场景多变量状态：环境场景 m 在 k=true 时被迫到目标，k=false 时死局 ----------
console.log('同场景多变量状态');
const st7 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'withK', target: 'm', assigns: [{ variable: 'k', value: true }] },
        { uid: 'noK', target: 'm' },
      ],
    },
    { id: 'm', options: [{ uid: 'go', condition: 'k', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const r7 = solveStrategy(st7, { targetScene: 't', environmentScenes: ['m'] });
eq('玩家选择赋 k 路线 => 可保证', r7.status, 'guaranteed');
eq('推荐 withK', r7.start.recommend.uid, 'withK');
eq('m 的两个变量状态分别计入环境状态', r7.counts.envStates, 2);

// ---------- 选项权重不参与判断 ----------
console.log('选项权重不参与判断');
const st8 = {
  startScene: 'a',
  scenes: [
    {
      id: 'a', options: [
        { uid: 'heavy', weight: 999, target: 't' },
        { uid: 'light', weight: 1, target: 'd' },
      ],
    },
    { id: 'd', options: [{ uid: 'stuck', condition: 'k', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const r8 = solveStrategy(st8, { targetScene: 't', environmentScenes: ['a'] });
eq('环境场景含高权重出口也不影响判定', r8.status, 'unguaranteed');
eq('仍因死局失败', r8.failure.reason, 'deadend');
const r8b = solveStrategy(st8, { targetScene: 't', environmentScenes: [] });
eq('玩家控制时高权重死局出口不影响可保证', r8b.status, 'guaranteed');
eq('推荐为重权重但通往目标的 heavy', r8b.start.recommend.uid, 'heavy');

// ---------- 起点即目标：平凡可保证 ----------
console.log('起点即目标');
const st9 = { startScene: 't', scenes: [{ id: 't', options: [] }] };
const r9 = solveStrategy(st9, { targetScene: 't' });
eq('起点即目标 => 可保证', r9.status, 'guaranteed');
eq('起点层级 = 0', r9.start.rank, 0);
eq('没有需要推荐的获胜玩家状态', r9.winningStates.length, 0);
ok('文案说明起点即目标', /起点即目标结局/.test(r9.message));

// ---------- 状态上限截断：无法判定 ----------
console.log('状态上限截断');
const r10 = solveStrategy(st1, { targetScene: 't' }, { maxStates: 1 });
eq('截断状态', r10.status, 'truncated');
ok('截断标记', r10.truncated === true && r10.ok === false);
ok('不下保证结论（guaranteed=null）', r10.guaranteed === null);
ok('不列出获胜状态（winningStates=null）', r10.winningStates === null);
ok('截断文案明确', /无法判定/.test(r10.message) && /截断|上限/.test(r10.message));

// ---------- 起点受阻：无法判定 ----------
console.log('起点受阻');
const st11 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', precondition: 'k', options: [{ uid: 'o1', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const r11 = solveStrategy(st11, { targetScene: 't' });
eq('起点受阻状态', r11.status, 'start-blocked');
ok('startBlocked 标记且无法判定', r11.startBlocked === true && r11.guaranteed === null);

// ---------- 参数校验 ----------
console.log('参数校验');
ok('缺 query => 400', throws400(() => solveStrategy(st1), /目标结局/));
ok('空 query => 400', throws400(() => solveStrategy(st1, {}), /目标结局/));
ok('目标场景不存在 => 400', throws400(() => solveStrategy(st1, { targetScene: 'ghost' }), /不存在/));
ok('目标场景含选项 => 400', throws400(() => solveStrategy(st1, { targetScene: 'a' }), /无选项场景/));
ok('环境列表含空行 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 't', environmentScenes: [''] }), /空行/));
ok('环境列表重复 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 't', environmentScenes: ['a', 'a'] }), /重复/));
ok('环境场景不存在 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 't', environmentScenes: ['ghost'] }), /不存在/));
ok('环境列表非数组 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 't', environmentScenes: 'a' }), /数组/));
ok('缺起点 => 400', throws400(() => solveStrategy({ scenes: [{ id: 't', options: [] }] }, { targetScene: 't' }), /起点/));
ok('起点不存在 => 400',
  throws400(() => solveStrategy({ startScene: 'ghost', scenes: [{ id: 't', options: [] }] }, { targetScene: 't' }), /起点/));
ok('环境列表可省略（全玩家控制）',
  solveStrategy(st1, { targetScene: 't' }).status === 'guaranteed');
ok('环境列表可包含目标场景（目标恒为获胜终止，不受影响）',
  solveStrategy(st1, { targetScene: 't', environmentScenes: ['t'] }).status === 'guaranteed');

// ---------- 条件语法错误容错（按恒真处理） ----------
console.log('条件语法错误容错');
const stBad = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', condition: 'k &&', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const rBad = solveStrategy(stBad, { targetScene: 't' });
eq('语法错误按恒真处理：边成立，可保证', rBad.status, 'guaranteed');
eq('记录 1 处条件语法错误', rBad.conditionErrors.length, 1);

// ---------- 确定性：同一剧情两次求解结果完全一致 ----------
console.log('确定性');
eq('同一剧情两次求解结果一致',
  JSON.stringify(solveStrategy(st6, { targetScene: 't', environmentScenes: ['x'] })),
  JSON.stringify(r6));

// ---------- 示例剧情：可正常运行并返回结构化结果 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rDemo = solveStrategy(demo, { targetScene: 'dungeon', environmentScenes: ['forest'] });
ok('示例剧情求解正常返回', typeof rDemo.status === 'string' && rDemo.counts.states > 0);
ok('示例剧情目标不可达 => 无法保证', rDemo.status === 'unguaranteed' && rDemo.guaranteed === false);

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
    // 草稿求解（不落盘）
    const p1 = await req('POST', '/api/strategy', { story: st1, query: { targetScene: 't' } });
    ok('POST /api/strategy 返回 200 且可保证',
      p1.status === 200 && p1.body.status === 'guaranteed' && p1.body.start.rank === 2);

    const p1b = await req('POST', '/api/strategy', { story: st2, query: { targetScene: 't', environmentScenes: ['x'] } });
    ok('无法保证剧情返回 unguaranteed',
      p1b.status === 200 && p1b.body.status === 'unguaranteed' && p1b.body.failure.reason === 'deadend');

    const p1c = await req('POST', '/api/strategy', { story: st1, query: { targetScene: 'a' } });
    ok('目标含选项返回 400', p1c.status === 400 && /无选项场景/.test(p1c.body.error || ''));

    const p1d = await req('POST', '/api/strategy', { story: st1 });
    ok('缺查询条件返回 400', p1d.status === 400 && /目标结局/.test(p1d.body.error || ''));

    const p1e = await req('POST', '/api/strategy',
      { story: st1, query: { targetScene: 't', environmentScenes: ['ghost'] } });
    ok('环境场景不存在返回 400', p1e.status === 400 && /不存在/.test(p1e.body.error || ''));

    // 截断参数注入
    const p1t = await req('POST', '/api/strategy', { story: st1, query: { targetScene: 't' }, maxStates: 1 });
    ok('maxStates 注入生效：截断且无法判定',
      p1t.status === 200 && p1t.body.status === 'truncated' && p1t.body.guaranteed === null);

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', st1);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const p2 = await req('POST', `/api/stories/${sid}/strategy`, { targetScene: 't' });
    ok('POST /api/stories/:id/strategy（query 直接作请求体）可保证',
      p2.status === 200 && p2.body.status === 'guaranteed');
    const p2b = await req('POST', `/api/stories/${sid}/strategy`, { query: { targetScene: 't' } });
    ok('POST /api/stories/:id/strategy 接受 { query } 包装',
      p2b.status === 200 && p2b.body.status === 'guaranteed');
    const p3 = await req('POST', '/api/stories/no-such-id/strategy', { targetScene: 't' });
    ok('剧情不存在返回 404', p3.status === 404);

    // 草稿求解不落盘：已保存剧情内容不因求解而改变
    const after = await req('GET', `/api/stories/${sid}`);
    ok('求解后剧情内容未被修改',
      JSON.stringify(after.body.scenes) === JSON.stringify(created.body.scenes));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项结局保证到达断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
