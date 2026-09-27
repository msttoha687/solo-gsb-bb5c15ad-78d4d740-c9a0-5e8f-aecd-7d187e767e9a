'use strict';

// 结局概率推演自检（node test/probability.js）
// 覆盖：权重归一化、条件 / 入口前置 / 悬空目标过滤、含环图精确求解（非固定步数截断）、
//       陷阱循环概率质量、死局、变量状态区分、状态上限截断的诚实报告、
//       权重校验（400）、权重随剧情 JSON 持久化 / 导入导出、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probability-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { inferEndings } = require('../src/probability');
const storage = require('../src/storage');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------- 权重归一化 ----------
console.log('权重归一化：');
const story1 = {
  startScene: 'a',
  scenes: [
    {
      id: 'a', options: [
        { text: '去 b', target: 'b', weight: 1 },
        { text: '去 c', target: 'c', weight: 3 },
      ],
    },
    { id: 'b', options: [] },
    { id: 'c', options: [] },
  ],
};
const r1 = inferEndings(story1);
ok('推演成功', r1.ok === true && r1.truncated === false);
ok('两个结局按权重 1:3 分配', (() => {
  const b = r1.endings.find((e) => e.sceneId === 'b');
  const c = r1.endings.find((e) => e.sceneId === 'c');
  return close(b.probability, 0.25) && close(c.probability, 0.75);
})());
ok('无循环时循环概率为 0', r1.loopProbability === 0 && r1.loops.length === 0);
ok('结局概率合计为 1', close(r1.totalEndingProbability, 1));
ok('无选项场景是设计结局（ending）', r1.endings.every((e) => e.kind === 'ending'));
ok('结局按概率降序排列', r1.endings[0].sceneId === 'c');

// 缺省权重视为 1
const storyNoWeight = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ text: 'x', target: 'b' }, { text: 'y', target: 'c' }] },
    { id: 'b', options: [] },
    { id: 'c', options: [] },
  ],
};
const r1b = inferEndings(storyNoWeight);
ok('缺省权重按 1 处理（0.5 / 0.5）',
  r1b.endings.every((e) => close(e.probability, 0.5)));

// 同一目标的多条选项权重合并
const storyDup = {
  startScene: 'a',
  scenes: [
    {
      id: 'a', options: [
        { text: 'x1', target: 'b', weight: 1 },
        { text: 'x2', target: 'b', weight: 2 },
        { text: 'y', target: 'c', weight: 1 },
      ],
    },
    { id: 'b', options: [] },
    { id: 'c', options: [] },
  ],
};
const r1c = inferEndings(storyDup);
ok('指向同一目标的选项权重合并（3/4 与 1/4）',
  close(r1c.endings.find((e) => e.sceneId === 'b').probability, 0.75) &&
  close(r1c.endings.find((e) => e.sceneId === 'c').probability, 0.25));

// ---------- 仅对“条件成立且目标可进入”的选项归一化 ----------
console.log('可走选项过滤：');
const storyCond = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    {
      id: 'a', options: [
        { text: '需要 x', condition: 'x', target: 'b', weight: 5 },
        { text: '总是可走', target: 'c', weight: 1 },
      ],
    },
    { id: 'b', options: [] },
    { id: 'c', options: [] },
  ],
};
const r2 = inferEndings(storyCond);
ok('条件不成立的选项不参与归一化（权重 5 也不计）',
  r2.endings.length === 1 && r2.endings[0].sceneId === 'c' && close(r2.endings[0].probability, 1));

const storyBlocked = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    {
      id: 'a', options: [
        { text: '被前置挡住', target: 't', weight: 4, assigns: [{ variable: 'k', value: false }] },
        { text: '可行', target: 'ok', weight: 1 },
      ],
    },
    { id: 't', precondition: 'k', options: [] },
    { id: 'ok', options: [] },
  ],
};
const r3 = inferEndings(storyBlocked);
ok('目标入口前置不成立的选项不参与归一化',
  r3.endings.length === 1 && r3.endings[0].sceneId === 'ok' && close(r3.endings[0].probability, 1));

const storyOrphan = {
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ text: '悬空', target: 'ghost', weight: 3 }] }],
};
const r4 = inferEndings(storyOrphan);
ok('悬空跳转不可进入：所在状态成为死局（概率 1）',
  r4.endings.length === 1 && r4.endings[0].sceneId === 'a' &&
  r4.endings[0].kind === 'deadend' && close(r4.endings[0].probability, 1));

// ---------- 含环图精确求解（禁止固定步数截断） ----------
console.log('含环图精确求解：');
// s ⇄ t，各自有一半概率走向自己的结局：P(e1) = 2/3，P(e2) = 1/3
const storyLoop = {
  startScene: 's',
  scenes: [
    {
      id: 's', options: [
        { text: '去 t', target: 't', weight: 1 },
        { text: '结局1', target: 'e1', weight: 1 },
      ],
    },
    {
      id: 't', options: [
        { text: '回 s', target: 's', weight: 1 },
        { text: '结局2', target: 'e2', weight: 1 },
      ],
    },
    { id: 'e1', options: [] },
    { id: 'e2', options: [] },
  ],
};
const r5 = inferEndings(storyLoop);
ok('含环图求解成功', r5.ok === true);
ok('使用精确求解器（非迭代截断）', r5.solver === 'exact');
ok('环上概率精确到分数：P(e1)=2/3、P(e2)=1/3',
  close(r5.endings.find((e) => e.sceneId === 'e1').probability, 2 / 3) &&
  close(r5.endings.find((e) => e.sceneId === 'e2').probability, 1 / 3));
ok('环有出口时不算陷阱循环', r5.loopProbability === 0 && r5.loops.length === 0);

// 长链（60 个确定性转移）：固定步数截断会谎报“困在途中”，精确解必须为 1
const chainScenes = [{ id: 's0', options: [{ text: '前进', target: 's1' }] }];
for (let i = 1; i < 60; i++) {
  chainScenes.push({ id: `s${i}`, options: [{ text: '前进', target: `s${i + 1}` }] });
}
chainScenes.push({ id: 's60', options: [] });
const rChain = inferEndings({ startScene: 's0', scenes: chainScenes });
ok('60 步长链精确求解：终点概率恰为 1（非步数截断的近似）',
  rChain.ok === true && rChain.endings.length === 1 &&
  rChain.endings[0].sceneId === 's60' && rChain.endings[0].probability === 1);
ok('长链无循环概率', rChain.loopProbability === 0);

// 自循环带出口：该状态是瞬态，结局概率为 1
const storySelfLoop = {
  startScene: 's',
  scenes: [
    {
      id: 's', options: [
        { text: '原地打转', target: 's', weight: 3 },
        { text: '结束', target: 'end', weight: 1 },
      ],
    },
    { id: 'end', options: [] },
  ],
};
const r6 = inferEndings(storySelfLoop);
ok('带出口的自循环不是陷阱：结局概率为 1',
  close(r6.endings.find((e) => e.sceneId === 'end').probability, 1) && r6.loopProbability === 0);

// ---------- 陷阱循环：永远困在循环中的概率质量 ----------
console.log('陷阱循环：');
const storyTrap = {
  startScene: 's',
  scenes: [
    {
      id: 's', options: [
        { text: '结局', target: 'end', weight: 1 },
        { text: '入环', target: 'l1', weight: 1 },
      ],
    },
    { id: 'l1', options: [{ text: '转', target: 'l2' }] },
    { id: 'l2', options: [{ text: '转回', target: 'l1' }] },
    { id: 'end', options: [] },
  ],
};
const r7 = inferEndings(storyTrap);
ok('结局与陷阱循环各占一半概率',
  close(r7.endings.find((e) => e.sceneId === 'end').probability, 0.5) &&
  close(r7.loopProbability, 0.5));
ok('循环概率单列且给出涉及的循环场景',
  r7.loops.length === 1 &&
  r7.loops[0].scenes.map((s) => s.id).sort().join(',') === 'l1,l2' &&
  r7.loops[0].states === 2);
ok('结局概率 + 循环概率 = 1', close(r7.totalEndingProbability + r7.loopProbability, 1));

// 纯自循环：全部概率困在循环中
const storyPureLoop = {
  startScene: 's',
  scenes: [{ id: 's', options: [{ text: '原地打转', target: 's' }] }],
};
const r8 = inferEndings(storyPureLoop);
ok('纯自循环剧情：循环概率为 1，无结局',
  r8.loopProbability === 1 && r8.endings.length === 0 && r8.totalEndingProbability === 0);
ok('纯自循环的循环场景即起点场景',
  r8.loops.length === 1 && r8.loops[0].scenes[0].id === 's' && r8.loops[0].states === 1);

// 多结局 + 循环混合（权重 2:1:1）
const storyMix = {
  startScene: 's',
  scenes: [
    {
      id: 's', options: [
        { text: 'e1', target: 'e1', weight: 2 },
        { text: 'e2', target: 'e2', weight: 1 },
        { text: '入环', target: 'l1', weight: 1 },
      ],
    },
    { id: 'l1', options: [{ text: '转', target: 'l2' }] },
    { id: 'l2', options: [{ text: '转回', target: 'l1' }] },
    { id: 'e1', options: [] },
    { id: 'e2', options: [] },
  ],
};
const r9 = inferEndings(storyMix);
ok('多结局 + 循环：0.5 / 0.25 / 0.25',
  close(r9.endings.find((e) => e.sceneId === 'e1').probability, 0.5) &&
  close(r9.endings.find((e) => e.sceneId === 'e2').probability, 0.25) &&
  close(r9.loopProbability, 0.25));

// ---------- 变量状态区分 ----------
console.log('变量状态：');
const storyVars = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    {
      id: 's', options: [
        { text: '拿', condition: '!x', target: 's', assigns: [{ variable: 'x', value: true }] },
        { text: '走', condition: 'x', target: 'end' },
      ],
    },
    { id: 'end', options: [] },
  ],
};
const r10 = inferEndings(storyVars);
ok('同一场景的不同变量状态分别归一化（先拿后走 => 结局概率 1）',
  r10.ok === true && r10.endings.length === 1 && close(r10.endings[0].probability, 1));
ok('具体状态数 = 同场景多状态 + 结局（3 个）', r10.counts.states === 3);

// 同一场景的多个吸收状态按场景合并
const storyTwoStates = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    {
      id: 's', options: [
        { text: '设 x', target: 'd', weight: 1, assigns: [{ variable: 'x', value: true }] },
        { text: '不设', target: 'd', weight: 1 },
      ],
    },
    { id: 'd', options: [{ text: '恒假', condition: 'ghost', target: 'nowhere' }] },
  ],
};
const r11 = inferEndings(storyTwoStates);
ok('同一场景的多个死局状态合并为一个结局条目（2 个状态）',
  r11.endings.length === 1 && r11.endings[0].sceneId === 'd' &&
  r11.endings[0].kind === 'deadend' && r11.endings[0].states === 2 &&
  close(r11.endings[0].probability, 1));

// ---------- 边界与诚实报告 ----------
console.log('边界情况：');
const rBlocked = inferEndings({
  startScene: 'a', variables: ['k'],
  scenes: [{ id: 'a', precondition: 'k', options: [] }],
});
ok('起点被前置条件挡住：明确报告且无概率',
  rBlocked.startBlocked === true && rBlocked.endings.length === 0 &&
  rBlocked.loopProbability === 0 && rBlocked.ok === true);

// 大规模瞬态链（> 稠密求解上限）：走迭代求解同一线性方程组，收敛后输出
const bigScenes = [];
const BIG_N = 1300;
for (let i = 0; i < BIG_N; i++) {
  bigScenes.push({
    id: `s${i}`,
    options: i < BIG_N - 1
      ? [{ text: '前进', target: `s${i + 1}`, weight: 1 }, { text: '出结局A', target: 'endA', weight: 1 }]
      : [{ text: '出结局A', target: 'endA', weight: 1 }, { text: '出结局B', target: 'endB', weight: 1 }],
  });
}
bigScenes.push({ id: 'endA', options: [] }, { id: 'endB', options: [] });
const rBig = inferEndings({ startScene: 's0', scenes: bigScenes });
ok('大规模瞬态链使用迭代求解且收敛', rBig.ok === true && rBig.solver === 'iterative');
ok('迭代解与精确解一致（P(endB)=2^-1300≈0，P(endA)≈1）',
  rBig.endings.find((e) => e.sceneId === 'endA').probability > 1 - 1e-9 &&
  close(rBig.totalEndingProbability, 1) && rBig.loopProbability === 0);

const rTrunc = inferEndings(
  { startScene: 's0', scenes: chainScenes },
  { maxStates: 5 });
ok('状态超上限时标记截断且不输出概率（不以偏概全）',
  rTrunc.ok === false && rTrunc.truncated === true &&
  rTrunc.endings === null && rTrunc.loopProbability === null && rTrunc.loops === null);
ok('截断消息说明未输出概率的原因', /上限/.test(rTrunc.message) && /未输出概率/.test(rTrunc.message));

// ---------- 权重校验 ----------
console.log('权重校验：');
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
const badWeightStory = (weight) => ({
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ text: 'x', target: 'b', weight }] }, { id: 'b', options: [] }],
});
for (const bad of [0, -1, 2.5, '3', true, NaN]) {
  ok(`非法权重 ${JSON.stringify(bad)} => 400 正整数错误`,
    throws400(() => inferEndings(badWeightStory(bad)), /正整数/));
}
ok('权重错误消息带场景与选项位置',
  throws400(() => inferEndings(badWeightStory(0)), /场景 "a" 选项 1/));
ok('缺少起点 => 400', throws400(() => inferEndings({ scenes: [{ id: 'a' }] }), /起点/));
ok('起点不存在 => 400', throws400(() => inferEndings({ startScene: 'ghost', scenes: [{ id: 'a' }] }), /起点/));
ok('权重为合法正整数时正常推演', inferEndings(badWeightStory(7)).ok === true);

// ---------- 权重随剧情 JSON 保存 / 导入导出 ----------
console.log('权重持久化：');
const norm = storage.normalize({
  title: 't', startScene: 'a',
  scenes: [{ id: 'a', options: [{ text: 'x', target: 'b', weight: 5 }, { text: 'y', target: 'c' }] }],
});
ok('合法权重随规整化保留', norm.scenes[0].options[0].weight === 5);
ok('缺省权重不落盘字段', !('weight' in norm.scenes[0].options[1]) || norm.scenes[0].options[1].weight === undefined);
ok('保存时非法权重抛出明确校验错误',
  throws400(() => storage.normalize({
    startScene: 'a',
    scenes: [{ id: 'a', options: [{ text: 'x', target: 'b', weight: 0 }] }],
  }), /正整数/));

// ---------- 示例剧情 ----------
console.log('示例剧情：');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rd = inferEndings(demo);
ok('示例推演成功且精确求解', rd.ok === true && rd.solver === 'exact');
ok('示例概率总和为 1', close(rd.totalEndingProbability + rd.loopProbability, 1));
ok('示例无陷阱循环（所有环都有出口）', rd.loopProbability === 0);
ok('示例终章结局概率 = 3/7（手算验证）',
  close(rd.endings.find((e) => e.sceneId === 'ending').probability, 3 / 7));
ok('示例城堡死局概率 = 4/7（求助女巫后无路可走）',
  close(rd.endings.find((e) => e.sceneId === 'castle').probability, 4 / 7));

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
    // 草稿推演（不落盘）
    const q1 = await req('POST', '/api/probability', storyLoop);
    ok('POST /api/probability 返回 200 且精确解出 2/3',
      q1.status === 200 && close(q1.body.endings.find((e) => e.sceneId === 'e1').probability, 2 / 3));

    // { story } 包装形式同样接受
    const q1b = await req('POST', '/api/probability', { story: story1 });
    ok('POST /api/probability 接受 { story } 包装', q1b.status === 200 && q1b.body.ok === true);

    const q2 = await req('POST', '/api/probability', badWeightStory(0));
    ok('草稿含非法权重返回 400', q2.status === 400 && /正整数/.test(q2.body.error || ''));

    const q3 = await req('POST', '/api/probability', { scenes: [{ id: 'a' }] });
    ok('缺少起点返回 400', q3.status === 400 && /起点/.test(q3.body.error || ''));

    // 权重随剧情保存并在读取 / 导出时携带
    const created = await req('POST', '/api/stories', story1);
    ok('创建带权重的剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    ok('保存后权重保留（1 与 3）',
      created.body.scenes[0].options[0].weight === 1 && created.body.scenes[0].options[1].weight === 3);

    const got = await req('GET', `/api/stories/${sid}`);
    ok('读取剧情时权重仍在', got.status === 200 && got.body.scenes[0].options[1].weight === 3);

    const exported = await req('GET', `/api/stories/${sid}/export`);
    ok('导出 JSON 携带权重', exported.status === 200 && exported.body.scenes[0].options[1].weight === 3);

    // 已保存剧情的推演接口
    const q4 = await req('GET', `/api/stories/${sid}/probability`);
    ok('GET /api/stories/:id/probability 返回结局概率',
      q4.status === 200 && close(q4.body.endings.find((e) => e.sceneId === 'c').probability, 0.75));
    const q5 = await req('GET', '/api/stories/no-such-id/probability');
    ok('剧情不存在返回 404', q5.status === 404);

    // 保存 / 导入时的权重校验
    const badSave = await req('PUT', `/api/stories/${sid}`, badWeightStory(-2));
    ok('保存时非法权重返回 400', badSave.status === 400 && /正整数/.test(badSave.body.error || ''));
    const badImport = await req('POST', '/api/stories', badWeightStory(1.5));
    ok('导入时非法权重返回 400', badImport.status === 400 && /正整数/.test(badImport.body.error || ''));

    // 合法保存后权重更新
    const okSave = await req('PUT', `/api/stories/${sid}`, {
      ...story1,
      scenes: [
        {
          id: 'a', options: [
            { text: '去 b', target: 'b', weight: 2 },
            { text: '去 c', target: 'c' },
          ],
        },
        { id: 'b', options: [] },
        { id: 'c', options: [] },
      ],
    });
    ok('合法权重保存成功（缺省项不写 weight 字段）',
      okSave.status === 200 && okSave.body.scenes[0].options[0].weight === 2 &&
      !('weight' in okSave.body.scenes[0].options[1]));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项结局概率推演断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
