'use strict';

// 选项覆盖路线自检（node test/coverage.js）
// 覆盖：可走选项见证路径、贪心集合覆盖压缩、覆盖率汇总、
//       不可达 / 恒假 / 入口受阻 / 悬空选项不计入分母、
//       循环图按具体状态去重（终止性）、状态上限截断标记不完整、
//       结果确定性、起点受阻、每步状态与选项 UID、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { planCoverage } = require('../src/coverage');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// ---------- 线性链：贪心集合覆盖压缩为 1 条路线 ----------
console.log('贪心集合覆盖压缩：');
const chain = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '去 b', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', text: '去 c', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r1 = planCoverage(chain);
ok('生成成功且结果完整', r1.ok === true && r1.complete === true && r1.truncated === false);
ok('分母 = 2 条可走选项', r1.coverage.coverable === 2 && r1.counts.options === 2);
ok('全部覆盖，覆盖率 100%', r1.coverage.covered === 2 && r1.coverage.rate === 1);
ok('深选项的见证路径顺路覆盖浅选项 => 压缩为 1 条路线', r1.routes.length === 1);
ok('唯一路线覆盖全部选项 UID（o1、o2）',
  JSON.stringify(r1.routes[0].covers) === '["o1","o2"]' &&
  JSON.stringify(r1.routes[0].newlyCovered) === '["o1","o2"]');
ok('路线为 2 步（a -> b -> c）', r1.routes[0].depth === 2);
ok('路线场景序列为 a,b,c',
  r1.routes[0].path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',') === 'a,b,c');
ok('路线每步：选项边携带 UID',
  r1.routes[0].path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(',') === 'o1,o2');
ok('路线每步：场景节点带到达时状态、选项边带选择后状态',
  r1.routes[0].path.every((n) => (n.kind === 'scene' ? n.state : n.stateAfter) !== undefined));

// 分叉：两条支路必须各走一遍 => 2 条路线
const branch = {
  startScene: 's',
  scenes: [
    {
      id: 's', options: [
        { uid: 'oa', text: '去 a', target: 'a' },
        { uid: 'ob', text: '去 b', target: 'b' },
      ],
    },
    { id: 'a', options: [{ uid: 'oa2', text: 'a 继续', target: 'end' }] },
    { id: 'b', options: [{ uid: 'ob2', text: 'b 继续', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const r2 = planCoverage(branch);
ok('分叉剧情：4 条可走选项全部覆盖', r2.coverage.coverable === 4 && r2.coverage.covered === 4);
ok('贪心压缩为 2 条路线（每条支路一条）', r2.routes.length === 2);
ok('每条路线新覆盖 2 条选项',
  r2.routes.every((r) => r.newlyCovered.length === 2));
ok('各路线新覆盖的并集 = 全部可走选项（无重叠）',
  r2.routes.flatMap((r) => r.newlyCovered).sort().join(',') === 'oa,oa2,ob,ob2');

// ---------- 不可走选项不计入分母 ----------
console.log('覆盖分母剔除不可走选项：');
const mixed = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    {
      id: 's', options: [
        { uid: 'ok1', text: '正常', target: 'mid' },
        { uid: 'nt', text: '恒假', condition: 'ghost', target: 'mid' },
        { uid: 'orp', text: '悬空', target: 'nowhere' },
        { uid: 'blk', text: '受阻', target: 'gate', assigns: [{ variable: 'x', value: false }] },
      ],
    },
    { id: 'mid', options: [{ uid: 'ok2', text: '前进', target: 'end' }] },
    { id: 'gate', precondition: 'x', options: [{ uid: 'inGate', text: '门内', target: 'end' }] },
    { id: 'end', options: [] },
    { id: 'iso', options: [{ uid: 'iso1', text: '孤岛', target: 'end' }] },
  ],
};
const r3 = planCoverage(mixed);
ok('分母只含 2 条实际可走选项', r3.coverage.coverable === 2 && r3.coverage.covered === 2);
ok('覆盖率 100%（不可走选项未拖低分母）', r3.coverage.rate === 1);
ok('5 条不可走选项被剔除并单列', r3.excludedOptions.length === 5 && r3.counts.excluded === 5);
const reasonOf = (uid) => r3.excludedOptions.find((o) => o.uid === uid).reason;
ok('恒假选项标注 neverTrue', reasonOf('nt') === 'neverTrue');
ok('悬空选项标注 orphan', reasonOf('orp') === 'orphan');
ok('入口受阻选项标注 blockedEntry', reasonOf('blk') === 'blockedEntry');
ok('不可达场景中的选项标注 unreachableScene',
  reasonOf('inGate') === 'unreachableScene' && reasonOf('iso1') === 'unreachableScene');
ok('完整穷举时剔除判定为确定结论', r3.excludedOptions.every((o) => o.definitive === true));
ok('见证路线顺路覆盖 => 1 条路线', r3.routes.length === 1 &&
  r3.routes[0].covers.sort().join(',') === 'ok1,ok2');

// ---------- 循环图按具体状态去重（必然终止） ----------
console.log('循环图按具体状态去重：');
const loop = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    {
      id: 's', options: [
        { uid: 'take', text: '拿', condition: '!x', target: 's', assigns: [{ variable: 'x', value: true }] },
        { uid: 'go', text: '走', condition: 'x', target: 'end' },
      ],
    },
    { id: 'end', options: [] },
  ],
};
const r4 = planCoverage(loop);
ok('含循环剧情正常终止', r4.ok === true && r4.complete === true);
ok('具体状态去重后仅 3 个状态（s×2 + end）', r4.counts.states === 3);
ok('循环上的选项也被覆盖（take、go）',
  r4.coverage.coverable === 2 && r4.coverage.covered === 2 && r4.routes.length === 1);
ok('覆盖 go 的路线先经 take 改变状态（可复现路径）',
  r4.routes[0].path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(',') === 'take,go');
ok('路线中同一场景的不同具体状态分别列出',
  r4.routes[0].path.filter((n) => n.kind === 'scene' && n.sceneId === 's').length === 2);

// ---------- 状态上限截断：标记结果不完整 ----------
console.log('状态上限截断：');
const r5 = planCoverage(chain, { maxStates: 1 });
ok('达到状态上限时标记截断且不完整', r5.truncated === true && r5.complete === false);
ok('截断时已发现的可走选项仍被覆盖', r5.coverage.coverable === 1 && r5.coverage.covered === 1);
ok('截断时未探索到的选项标注为暂定（非确定结论）',
  r5.excludedOptions.length === 1 && r5.excludedOptions[0].uid === 'o2' &&
  r5.excludedOptions[0].definitive === false);
ok('截断提示文案明确（结果不完整）', /结果不完整/.test(r5.message));

// ---------- 起点受阻 ----------
console.log('起点受阻：');
const r6 = planCoverage({
  startScene: 'a', variables: ['k'],
  scenes: [{ id: 'a', precondition: 'k', options: [{ uid: 'ox', text: 'x', target: 'b' }] }, { id: 'b', options: [] }],
});
ok('起点被挡时 startBlocked 且无路线',
  r6.startBlocked === true && r6.routes.length === 0 && r6.coverage.coverable === 0);
ok('起点被挡时覆盖率为 null 且选项按场景不可达剔除',
  r6.coverage.rate === null && r6.excludedOptions.length === 1 &&
  r6.excludedOptions[0].reason === 'unreachableScene');

// ---------- 确定性：同一剧情两次生成结果完全一致 ----------
console.log('确定性：');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const d1 = planCoverage(demo);
const d2 = planCoverage(demo);
ok('两次生成的路线集完全一致（无随机性）', JSON.stringify(d1) === JSON.stringify(d2));

// ---------- 示例剧情 ----------
console.log('示例剧情：');
ok('示例：13 条选项中 9 条实际可走（分母）',
  d1.counts.options === 13 && d1.coverage.coverable === 9);
ok('示例：9 条可走选项全部覆盖，覆盖率 100%',
  d1.coverage.covered === 9 && d1.coverage.rate === 1 && d1.complete === true);
ok('示例：4 条不可走选项未计入分母（恒假 / 入口受阻 / 悬空 / 场景不可达各 1）',
  d1.excludedOptions.length === 4 &&
  ['neverTrue', 'blockedEntry', 'orphan', 'unreachableScene']
    .every((r) => d1.excludedOptions.some((o) => o.reason === r)));
ok('示例：贪心压缩为 3 条路线', d1.routes.length === 3);
ok('示例：各路线新覆盖并集 = 全部 9 条可走选项',
  d1.routes.flatMap((r) => r.newlyCovered).length === 9 &&
  new Set(d1.routes.flatMap((r) => r.newlyCovered)).size === 9);
ok('示例：路线从起点出发（首个场景节点 = village）',
  d1.routes.every((r) => r.path[0].kind === 'scene' && r.path[0].sceneId === 'village'));
ok('示例：无 uid 的旧数据退回 idx:场景#下标 标识',
  d1.routes.every((r) => r.covers.every((u) => typeof u === 'string' && u.length > 0)));

// ---------- 条件语法错误容错 ----------
const badCond = planCoverage({
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ uid: 'q1', text: 'x', condition: 'k &&', target: 'b' }] }, { id: 'b', options: [] }],
});
ok('语法错误的条件按恒真处理并记录', badCond.coverage.coverable === 1 && badCond.conditionErrors.length === 1);

// ---------- 参数校验 ----------
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
ok('缺少起点 => 400', throws400(() => planCoverage({ scenes: [{ id: 'a' }] }), /起点/));
ok('起点不存在 => 400', throws400(() => planCoverage({ startScene: 'ghost', scenes: [{ id: 'a' }] }), /起点/));

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
      res.on('data', (d) => { data += d; });
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
    // 草稿生成（不落盘）
    const q1 = await req('POST', '/api/coverage', chain);
    ok('POST /api/coverage 返回 200 且压缩为 1 条路线',
      q1.status === 200 && q1.body.routes.length === 1 && q1.body.coverage.rate === 1);

    // { story } 包装形式同样接受
    const q1b = await req('POST', '/api/coverage', { story: branch });
    ok('POST /api/coverage 接受 { story } 包装',
      q1b.status === 200 && q1b.body.routes.length === 2);

    const q2 = await req('POST', '/api/coverage', { scenes: [{ id: 'a' }] });
    ok('缺少起点返回 400', q2.status === 400 && /起点/.test(q2.body.error || ''));

    // 已保存剧情的覆盖路线接口
    const created = await req('POST', '/api/stories', mixed);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;

    const q3 = await req('GET', `/api/stories/${sid}/coverage`);
    ok('GET /api/stories/:id/coverage 返回覆盖路线',
      q3.status === 200 && q3.body.coverage.coverable === 2 && q3.body.routes.length === 1);
    ok('保存后选项带稳定 UID，路线按 UID 列出',
      q3.body.routes[0].covers.every((u) => /^opt-/.test(u)));
    ok('不可走选项随 API 单列且不计入分母',
      q3.body.excludedOptions.length === 5 && q3.body.counts.excluded === 5);

    const q4 = await req('GET', '/api/stories/no-such-id/coverage');
    ok('剧情不存在返回 404', q4.status === 404);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项选项覆盖路线断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
