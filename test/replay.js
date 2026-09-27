'use strict';

// 覆盖路线逐步回放自检（node test/replay.js）
// 覆盖：无分歧走完全程、逐步重新校验条件 / 目标前置 / 状态赋值、
//       各类分歧点（UID 缺失 / 移位、条件翻假、悬空、目标改变、入口受阻、
//       状态不一致、起点变化、起点受阻）、期望/实际状态差异、
//       语法错误按恒真、参数校验、只读草稿、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { replayRoute } = require('../src/replay');
const { planCoverage } = require('../src/coverage');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 与前端 routeOptionUids 一致：真实 UID 优先，缺失时按 场景#下标 兜底（保留重复边） */
const routeOptions = (rt) => rt.path
  .filter((n) => n.kind === 'option')
  .map((n) => n.optionUid || `idx:${n.fromSceneId}#${n.optionIndex}`);

const baseStory = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '去 b', target: 'b', assigns: [{ variable: 'x', value: true }] }] },
    { id: 'b', precondition: 'x', options: [{ uid: 'o2', text: '去 c', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};

// 直接由覆盖路线生成“路线记录”（含每步期望状态快照）
const cov = planCoverage(baseStory);
ok('前置：覆盖路线只有 1 条且覆盖 o1、o2', cov.routes.length === 1);
const route = cov.routes[0];
const routeReq = {
  options: routeOptions(route),
  path: route.path,
};
ok('路线选项序列为 o1,o2', JSON.stringify(routeReq.options) === '["o1","o2"]');

// ---------- 无分歧：从起点逐步走完全程 ----------
console.log('无分歧回放：');
const r0 = replayRoute(baseStory, routeReq);
ok('回放完成、无分歧', r0.completed === true && r0.divergence === null);
ok('总步数 = 2', r0.total === 2);
ok('每一步都成功（status=ok）', r0.trace.steps.every((s) => s.status === 'ok'));
ok('起点状态：x=false（起点无进入赋值）',
  r0.trace.start.state.x === false && r0.trace.start.diverged !== true);
ok('第 1 步：选项赋值后到达 b，x=true，目标前置 x 成立',
  r0.trace.steps[0].target === 'b' && r0.trace.steps[0].stateAfter.x === true);
ok('第 2 步到达 c，终点为 c',
  r0.trace.steps[1].target === 'c' && r0.trace.end.sceneId === 'c');
ok('轨迹携带已知变量', r0.knownVars.includes('x'));

// 回放不得修改输入草稿
const snapshotBefore = JSON.stringify(baseStory);
replayRoute(baseStory, routeReq);
ok('回放不修改剧情对象（深比较一致）', JSON.stringify(baseStory) === snapshotBefore);

// ---------- 每一步都用当前草稿重新校验条件 ----------
console.log('选项条件分歧：');
let d = clone(baseStory);
d.scenes[0].options[0].condition = 'y'; // y 未赋值，恒 false
let rr = replayRoute(d, routeReq);
ok('条件在当前状态下翻假 => conditionFalse，停在第 1 步',
  rr.completed === false && rr.divergence.reason === 'conditionFalse' &&
  rr.divergence.atStep === 1 && rr.divergence.index === 0 && rr.divergence.uid === 'o1');
ok('conditionFalse 携带条件表达式与解释树',
  rr.divergence.condition === 'y' && rr.divergence.explain && rr.divergence.explain.op === 'var');
ok('分歧后后续步骤不再执行（steps 只有 1 条且标红）',
  rr.trace.steps.length === 1 && rr.trace.steps[0].status === 'diverged');

// 条件变化让更早的步骤先分歧：o1 条件改恒真、o2 条件改 !x（x=true 时为假）
d = clone(baseStory);
d.scenes[1].options[0].condition = '!x';
rr = replayRoute(d, routeReq);
ok('第 2 步条件翻假 => conditionFalse atStep=2',
  rr.divergence.reason === 'conditionFalse' && rr.divergence.atStep === 2);

// ---------- 状态赋值变化导致前置不成立 / 状态不一致 ----------
console.log('状态赋值分歧：');
d = clone(baseStory);
d.scenes[0].options[0].assigns = []; // 不再赋 x => b 的前置 x 不成立
rr = replayRoute(d, routeReq);
ok('丢失赋值导致目标前置不成立 => blockedEntry',
  rr.divergence.reason === 'blockedEntry' && rr.divergence.target === 'b' &&
  rr.divergence.atStep === 1 && rr.divergence.explain);

d = clone(baseStory);
d.scenes[1].precondition = ''; // 去掉前置，单独暴露状态差异
d.scenes[0].options[0].assigns = [{ variable: 'x', value: false }];
rr = replayRoute(d, routeReq);
ok('赋值结果与期望位图不一致 => stateMismatch',
  rr.divergence.reason === 'stateMismatch' &&
  JSON.stringify(rr.divergence.stateDiffs) === '[{"variable":"x","expected":true,"actual":false}]');
ok('stateMismatch 给出期望 / 实际两侧状态',
  rr.divergence.expected.state.x === true && rr.divergence.actual.state.x === false);

// 起点进入赋值变化 => 起点状态不一致
d = clone(baseStory);
d.scenes[0].assigns = [{ variable: 'x', value: true }];
rr = replayRoute(d, routeReq);
ok('起点进入赋值变化 => 第 0 步 stateMismatch',
  rr.divergence.reason === 'stateMismatch' && rr.divergence.atStep === 0 &&
  rr.divergence.stateDiffs[0].variable === 'x');
ok('起点分歧在 trace.start 上标记', rr.trace.start.diverged === true);

// 新增变量也出现在差异全集里（期望侧缺省按 false）
d = clone(baseStory);
d.variables.push('z');
d.scenes[2].assigns = [{ variable: 'z', value: true }]; // 终点 c 的进入赋值（路线终点无后续边）
rr = replayRoute(d, routeReq);
// 最后一条边的期望 stateAfter 没有 z，实际有 z => stateMismatch
ok('草稿新增变量被纳入状态对比',
  rr.divergence && rr.divergence.reason === 'stateMismatch' &&
  rr.divergence.stateDiffs.some((x) => x.variable === 'z' && x.expected === false && x.actual === true));

// ---------- UID 缺失 / 移位 ----------
console.log('UID 身份分歧：');
d = clone(baseStory);
delete d.scenes[0].options[0].uid; // 草稿退回 idx:a#0，o1 消失
rr = replayRoute(d, routeReq);
ok('UID 被删除 => uidMissing',
  rr.divergence.reason === 'uidMissing' && rr.divergence.uid === 'o1' &&
  rr.divergence.actual === null);

d = clone(baseStory);
const moved = d.scenes[0].options[0];
d.scenes[0].options = [];
d.scenes[1].options.push(moved); // o1 被挪到 b
rr = replayRoute(d, routeReq);
ok('UID 被移动到别的场景 => optionMoved 并给出新位置',
  rr.divergence.reason === 'optionMoved' &&
  rr.divergence.actual.sceneId === 'b' && rr.divergence.actual.optionIndex === 1);

// ---------- 悬空跳转 / 目标改变 ----------
console.log('跳转目标分歧：');
d = clone(baseStory);
d.scenes[0].options[0].target = 'ghost';
rr = replayRoute(d, routeReq);
ok('目标场景不存在 => orphanTarget',
  rr.divergence.reason === 'orphanTarget' && rr.divergence.actual.targetExists === false);

d = clone(baseStory);
d.scenes[0].options[0].target = 'c'; // 改指已存在场景
rr = replayRoute(d, routeReq);
ok('目标改指 => targetChanged，期望 b / 实际 c',
  rr.divergence.reason === 'targetChanged' &&
  rr.divergence.expected.target === 'b' && rr.divergence.actual.target === 'c');

// ---------- 起点变化 / 起点受阻 ----------
console.log('起点分歧：');
d = clone(baseStory);
d.startScene = 'b';
rr = replayRoute(d, routeReq);
ok('起点场景被修改 => startSceneChanged',
  rr.divergence.reason === 'startSceneChanged' && rr.divergence.atStep === 0);

d = clone(baseStory);
d.variables.push('k');
d.scenes[0].precondition = 'k'; // k 恒 false，起点被挡
rr = replayRoute(d, routeReq);
ok('起点前置不成立 => startBlocked',
  rr.divergence.reason === 'startBlocked' && rr.divergence.explain);

// ---------- 语法错误按恒真（与分析器 / 覆盖路线一致） ----------
console.log('语法容错：');
d = clone(baseStory);
d.scenes[0].options[0].condition = 'x &&';
rr = replayRoute(d, routeReq);
ok('语法错误条件按恒真处理：回放仍可继续并记录 conditionErrors',
  rr.completed === true && rr.conditionErrors.length === 1);

// 语法错误按恒真后条件本应为假的情况不再拦截
d = clone(baseStory);
d.scenes[0].options[0].condition = 'y &&';
rr = replayRoute(d, routeReq);
ok('即使错误条件引用恒假变量，仍按恒真放行', rr.completed === true);

// ---------- 无 path 快照时仅做执行性校验 ----------
console.log('无快照降级：');
rr = replayRoute(baseStory, { options: ['o1', 'o2'] });
ok('不携带 path 也能完整回放', rr.completed === true);
d = clone(baseStory);
d.scenes[0].options[0].assigns = [];
rr = replayRoute(d, { options: ['o1', 'o2'] });
ok('无快照时赋值差异不报告，但入口受阻仍能发现',
  rr.divergence && rr.divergence.reason === 'blockedEntry');

// ---------- 参数校验 ----------
console.log('参数校验：');
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
ok('缺少 route.options => 400', throws400(() => replayRoute(baseStory, {}), /选项序列/));
ok('空路线 => 400', throws400(() => replayRoute(baseStory, { options: [] }), /不包含/));
ok('UID 非字符串 => 400', throws400(() => replayRoute(baseStory, { options: ['o1', 1] }), /非空字符串/));
ok('起点缺失 => 400',
  throws400(() => replayRoute({ scenes: [{ id: 'a' }] }, { options: ['o1'] }), /起点/));

// ---------- 示例剧情：覆盖路线全部可回放 ----------
console.log('示例剧情：');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const dcov = planCoverage(demo);
ok(`示例 ${dcov.routes.length} 条覆盖路线全部可在原草稿上无分歧回放`,
  dcov.routes.every((rt) => {
    const x = replayRoute(demo, {
      options: routeOptions(rt),
      path: rt.path,
    });
    return x.completed === true && x.total === rt.depth;
  }));

// 对示例草稿做一处修改（删除一个被路线引用的选项）=> 某条路线在该 UID 处停下。
// 示例本身使用 idx: 兜底身份，选项删除 / 重排会改变下标语义，因此这里给副本补齐
// 显式稳定 UID 后再生成路线，以确定性地验证“UID 缺失即停”。
const demoWithUids = clone(demo);
demoWithUids.scenes.forEach((sc) => (sc.options || []).forEach((o, i) => {
  if (!o.uid) o.uid = `opt-demo-${sc.id}-${i}`;
}));
const dcov2 = planCoverage(demoWithUids);
const firstEdge = dcov2.routes[0].path.find((n) => n.kind === 'option');
const firstUid = firstEdge.optionUid;
for (const sc of demoWithUids.scenes) {
  const idx = (sc.options || []).findIndex((o) => o.uid === firstUid);
  if (idx >= 0) { sc.options.splice(idx, 1); break; }
}
const changed = replayRoute(demoWithUids, {
  options: routeOptions(dcov2.routes[0]),
  path: dcov2.routes[0].path,
});
ok('删除被路线引用的选项后，回放停在该 UID 的分歧点',
  changed.divergence && changed.divergence.uid === firstUid &&
  changed.divergence.reason === 'uidMissing');

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
    const q1 = await req('POST', '/api/coverage/replay', { story: baseStory, route: routeReq });
    ok('POST /api/coverage/replay 草稿回放 200 且完成',
      q1.status === 200 && q1.body.completed === true && q1.body.total === 2);

    const broken = clone(baseStory);
    broken.scenes[0].options[0].condition = 'y';
    const q2 = await req('POST', '/api/coverage/replay', { story: broken, route: routeReq });
    ok('分歧回放 200（分歧不是 HTTP 错误）并带 divergence',
      q2.status === 200 && q2.body.divergence && q2.body.divergence.reason === 'conditionFalse');

    const q3 = await req('POST', '/api/coverage/replay', { story: baseStory });
    ok('缺少 route => 400', q3.status === 400 && /选项序列/.test(q3.body.error || ''));

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', baseStory);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const savedRoute = (await req('GET', `/api/stories/${sid}/coverage`)).body.routes[0];
    const q4 = await req('POST', `/api/stories/${sid}/coverage/replay`, {
      options: routeOptions(savedRoute),
      path: savedRoute.path,
    });
    ok('POST /api/stories/:id/coverage/replay 对已保存剧情回放成功',
      q4.status === 200 && q4.body.completed === true);
    const q5 = await req('POST', '/api/stories/no-such-id/coverage/replay', { options: ['x'] });
    ok('剧情不存在返回 404', q5.status === 404);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项逐步回放断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
