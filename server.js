'use strict';

const express = require('express');
const path = require('path');
const storage = require('./src/storage');
const { analyze } = require('./src/analyzer');
const { queryPath } = require('./src/pathquery');
const { inferEndings } = require('./src/probability');
const { planCoverage } = require('./src/coverage');
const { replayRoute } = require('./src/replay');
const { analyzeForcedChoices, bypassForced } = require('./src/forcedchoice');
const { checkForeshadow } = require('./src/foreshadow');
const { checkPacing } = require('./src/pacing');
const { solveStrategy } = require('./src/strategy');
const { auditAssignments } = require('./src/assignaudit');
const { buildBaseline, compareWithBaseline } = require('./src/baseline');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- 剧情列表 ----
app.get('/api/stories', wrap((req, res) => {
  res.json(storage.listStories());
}));

// ---- 新建剧情 ----
app.post('/api/stories', wrap((req, res) => {
  const record = storage.createStory(req.body || {});
  res.status(201).json(record);
}));

// ---- 读取剧情 ----
app.get('/api/stories/:id', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(story);
}));

// ---- 保存剧情 ----
app.put('/api/stories/:id', wrap((req, res) => {
  const record = storage.updateStory(req.params.id, req.body || {});
  res.json(record);
}));

// ---- 删除剧情 ----
app.delete('/api/stories/:id', wrap((req, res) => {
  storage.deleteStory(req.params.id);
  res.status(204).end();
}));

// ---- 分析剧情（不保存，直接对请求体中的剧情做分析，供编辑时实时检查） ----
app.post('/api/analyze', wrap((req, res) => {
  res.json(analyze(req.body || {}));
}));

// ---- 分析已保存的剧情 ----
app.get('/api/stories/:id/analysis', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(analyze(story));
}));

// ---- 目标路径查询：对请求体中的草稿剧情直接查询（不落盘），供编辑页查询面板实时使用 ----
// 请求体：{
//   story: <剧情>,
//   query: {
//     targetScene,
//     constraints: [{ variable, value }],
//     requiredOptions: [uid, ...],  // 有序必经选项（按数组顺序依次经过）
//     disabledOptions: [uid, ...],  // 禁用选项（传播时不扩展，且不得与必经项冲突）
//   },
// }
// 校验失败（UID 不存在 / 必经与禁用冲突 / 约束重复等）返回 400
app.post('/api/pathquery', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  res.json(queryPath(story, body.query || {}));
}));

// ---- 对已保存的剧情做目标路径查询 ----
app.post('/api/stories/:id/pathquery', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const body = req.body || {};
  const query = body.query !== undefined ? body.query : body;
  res.json(queryPath(story, query));
}));

// ---- 结局概率推演：对请求体中的草稿剧情直接推演（不落盘），供编辑页推演面板实时使用 ----
// 请求体即剧情（或 { story: <剧情> }）。基于「场景 + 变量状态」图精确求解：
// 各终止场景的最终到达概率 + 永远困在循环中的概率质量（含涉及的循环场景）。
// 非法选项权重（非正整数）返回 400 并带场景 / 选项位置。
app.post('/api/probability', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  res.json(inferEndings(story));
}));

// ---- 对已保存的剧情做结局概率推演 ----
app.get('/api/stories/:id/probability', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(inferEndings(story));
}));

// ---- 结局必经抉择：对请求体中的草稿剧情直接分析（不落盘），供编辑页面板实时使用 ----
// 请求体即剧情（或 { story: <剧情> }）。在「场景 + 完整变量状态」图上用标签数据流
// 不动点精确求每个可达终止场景的所有到达路线共同经过的稳定选项 UID（含环 / 同场景
// 多状态仍精确终止，不枚举固定深度路径）；状态上限截断时 canAssertForced=false 且
// 不下必经结论。另附每个结局必经选项的先后次序与首次到达的最短见证路径。
app.post('/api/forced-choice', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  const opts = Number.isInteger(body.maxStates) && body.maxStates > 0 ? { maxStates: body.maxStates } : {};
  res.json(analyzeForcedChoices(story, opts));
}));

// ---- 对已保存的剧情分析结局必经抉择 ----
app.get('/api/stories/:id/forced-choice', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(analyzeForcedChoices(story));
}));

// ---- 绕开反例：求一条不经过指定选项 UID 仍到达指定终止场景的最短路线 ----
// 请求体：{ story?, endingScene, uid }。找不到时区分“确为必经（已完整穷举）”
// 与“因截断不能断言”（canAssertUnavoidable）。UID / 结局场景无效返回 400。
app.post('/api/forced-choice/bypass', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  const opts = Number.isInteger(body.maxStates) && body.maxStates > 0 ? { maxStates: body.maxStates } : {};
  res.json(bypassForced(story, body.endingScene, body.uid, opts));
}));

// ---- 对已保存剧情查询绕开反例（请求体：{ endingScene, uid }） ----
app.post('/api/stories/:id/forced-choice/bypass', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const body = req.body || {};
  res.json(bypassForced(story, body.endingScene, body.uid));
}));

// ---- 选项覆盖路线：对请求体中的草稿剧情直接生成（不落盘），供编辑页覆盖面板实时使用 ----
// 请求体即剧情（或 { story: <剧情> }）。在「场景 + 变量状态」图上为每条实际可走的
// 选项保留可复现路径，再用确定性贪心集合覆盖压缩路线集；不可达 / 恒假 / 入口受阻 /
// 悬空的选项不计入覆盖分母；状态上限截断时 complete=false 标记结果不完整。
app.post('/api/coverage', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  res.json(planCoverage(story));
}));

// ---- 对已保存的剧情生成选项覆盖路线 ----
app.get('/api/stories/:id/coverage', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(planCoverage(story));
}));

// ---- 覆盖路线逐步回放：用路线中的稳定选项 UID 序列在当前草稿上从起点逐步重放 ----
// 请求体：{ story: <剧情>, route: { options: [uid, ...], path? } }
// 每一步用当前草稿重新校验选项条件、目标场景前置条件与状态赋值；草稿变化导致
// UID 缺失 / 状态不一致时停在首个分歧点（divergence），返回期望 / 实际状态。
// 只读剧情，不保存、不修改草稿。
app.post('/api/coverage/replay', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  res.json(replayRoute(story, body.route || {}));
}));

// ---- 对已保存剧情做覆盖路线逐步回放（请求体即 route） ----
app.post('/api/stories/:id/coverage/replay', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const body = req.body || {};
  const route = body.route !== undefined ? body.route : body;
  res.json(replayRoute(story, route));
}));

// ---- 伏笔回收路线校验：对请求体中的草稿剧情直接校验（不落盘），供编辑页面板实时使用 ----
// 请求体：{ story: <剧情>, query: { setups: [场景ID...], payoffs: [场景ID...] } }
// 沿「场景 + 完整变量状态」图把「待回收」标记并入遍历：进入铺垫场景置位、进入回收场景
// 清除；到达可达设计结局时仍待回收 => 返回按选项步数最短的违规路线与沿途变量状态。
// 通过仅在完整探索、铺垫可达且存在可达设计结局时判定；铺垫不可达 / 无结局 / 状态上限
// 截断分别以独立 status 提示。查询校验失败（场景不存在 / 两组重叠 / 列表为空等）返回 400。
app.post('/api/foreshadow', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  const opts = Number.isInteger(body.maxStates) && body.maxStates > 0 ? { maxStates: body.maxStates } : {};
  res.json(checkForeshadow(story, body.query || {}, opts));
}));

// ---- 对已保存的剧情做伏笔回收路线校验（请求体即 query 或 { query }） ----
app.post('/api/stories/:id/foreshadow', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const body = req.body || {};
  const query = body.query !== undefined ? body.query : body;
  res.json(checkForeshadow(story, query));
}));

// ---- 节奏校验（高强度场景连续段）：对请求体中的草稿剧情直接校验（不落盘），供编辑页面板实时使用 ----
// 请求体：{ story: <剧情>, query: { highIntensityScenes: [场景ID...], maxConsecutive: 1～10 } }
// 沿「场景 + 完整变量状态」图把「当前连续高强度计数」并入遍历去重键：进入高强度场景
// 计数 +1，进入非高强度场景清零，环路中的连续段也随计数累计；计数超过允许上限即违规，
// 返回按选项步数最短的超限路线（沿途场景、变量状态与连续计数）。完整遍历且无超限才判
// 通过；状态上限截断时以 truncated 标明无法判定。查询校验失败（场景不存在 / 列表为空 /
// 连续数越界等）返回 400。
app.post('/api/pacing', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  const opts = Number.isInteger(body.maxStates) && body.maxStates > 0 ? { maxStates: body.maxStates } : {};
  res.json(checkPacing(story, body.query || {}, opts));
}));

// ---- 对已保存的剧情做节奏校验（请求体即 query 或 { query }） ----
app.post('/api/stories/:id/pacing', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const body = req.body || {};
  const query = body.query !== undefined ? body.query : body;
  res.json(checkPacing(story, query));
}));

// ---- 结局保证到达（玩家策略求解）：对请求体中的草稿剧情直接求解（不落盘），供编辑页面板实时使用 ----
// 请求体：{ story: <剧情>, query: { targetScene, environmentScenes: [场景ID...] } }
// 沿用现有条件 / 赋值 / 入口语义，在「场景 + 完整变量状态」图上用最小不动点反向扩展：
// 玩家状态至少一个后继已获胜即获胜；环境状态须有合法后继且全部后继已获胜才获胜；
// 选项权重不参与判断。目标必须是无选项场景；非目标死局与可无限停留的循环都不算成功。
// 起点已获胜 => 列出获胜玩家状态的变量值、推荐选项 UID 与层级（推荐必进入更低层级）；
// 起点未获胜 => 明确无法保证并给出环境反制见证（死局路线 / 无限循环 / 目标不可达）；
// 起点受阻或状态上限截断 => 无法判定。目标含选项 / 场景不存在 / 列表非法等返回 400。
app.post('/api/strategy', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  const opts = Number.isInteger(body.maxStates) && body.maxStates > 0 ? { maxStates: body.maxStates } : {};
  res.json(solveStrategy(story, body.query || {}, opts));
}));

// ---- 对已保存的剧情求解结局保证到达（请求体即 query 或 { query }） ----
app.post('/api/stories/:id/strategy', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const body = req.body || {};
  const query = body.query !== undefined ? body.query : body;
  res.json(solveStrategy(story, query));
}));

// ---- 变量赋值消费审计：对请求体中的草稿剧情直接审计（不落盘），供编辑页面板实时使用 ----
// 请求体即剧情（或 { story: <剧情> }）。沿「场景 + 每变量最后赋值来源」状态图追踪每处
// 场景进入赋值 / 选项赋值写入的变量值，在再次被赋值或路线结束前是否被后续条件
// （选项条件 / 场景前置条件）引用；已消费项附到首次引用的最短可走路线；含环必然终止，
// 状态上限截断时未知项标记为 unknown，不判为未消费。剧情缺少有效起点返回 400。
app.post('/api/assign-audit', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  const opts = Number.isInteger(body.maxStates) && body.maxStates > 0 ? { maxStates: body.maxStates } : {};
  res.json(auditAssignments(story, opts));
}));

// ---- 对已保存的剧情做变量赋值消费审计 ----
app.get('/api/stories/:id/assign-audit', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(auditAssignments(story));
}));

// ---- 分析基线：把当前（通常是编辑中的）分析结果保存为基线，随剧情 JSON 持久化 ----
app.post('/api/stories/:id/baseline', wrap((req, res) => {
  const id = req.params.id;
  const existing = storage.getStory(id);
  if (!existing) return res.status(404).json({ error: '剧情不存在' });
  // 请求体即当前草稿剧情（与 PUT /api/stories/:id 相同的形状）
  const draft = req.body && req.body.story !== undefined ? req.body.story : req.body;
  if (!draft || typeof draft !== 'object') return res.status(400).json({ error: '缺少剧情内容' });

  // 先规整（补齐选项 UID 等），再分析：保证基线指纹与后续持久化内容一致
  const normalized = storage.normalize({
    ...draft,
    id,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    baseline: existing.baseline || null,
  });
  const analysis = analyze(normalized);
  const baseline = buildBaseline(analysis, normalized);
  // 保存基线时一并把草稿落盘，保证“基线对应内容”与持久化内容一致
  const record = storage.saveStoryWithBaseline(id, normalized, baseline);
  res.status(201).json({ story: record, baseline, analysis });
}));

// ---- 基线对比：基线（可随请求体传入新的草稿）与当前分析结果对比 ----
app.post('/api/stories/:id/baseline/compare', wrap((req, res) => {
  const id = req.params.id;
  const stored = storage.getStory(id);
  if (!stored) return res.status(404).json({ error: '剧情不存在' });
  if (!stored.baseline) return res.status(404).json({ error: '尚未保存分析基线' });

  // 请求体可缺省：对比已保存的剧情；也可直接对编辑中的草稿对比
  const draft = req.body && req.body.story !== undefined ? req.body.story
    : (req.body && Object.keys(req.body).length ? req.body : stored);
  const analysis = analyze(draft);
  res.json(compareWithBaseline(stored.baseline, analysis));
}));

// ---- 删除基线 ----
app.delete('/api/stories/:id/baseline', wrap((req, res) => {
  const record = storage.clearBaseline(req.params.id);
  res.json({ story: record });
}));

// ---- 导出 ----
app.get('/api/stories/:id/export', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const filename = encodeURIComponent(`${story.id}.json`);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify({ ...story, exportedAt: new Date().toISOString() }, null, 2));
}));

// SPA 回退
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- 错误处理 ----
app.use((err, req, res, next) => {
  const status = err.status || 400;
  res.status(status).json({ error: err.message || '服务器错误' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

storage.ensureDataDir();
const seeded = storage.seedSamples();
if (seeded.length) console.log(`[seed] 已初始化示例剧情: ${seeded.join(', ')}`);

// 直接 `node server.js` 时启动监听；被测试 require 时仅导出 app（由测试自行监听）
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`分支剧情一致性审校应用已启动: http://${HOST}:${PORT}`);
    console.log(`数据目录: ${storage.DATA_DIR}`);
  });
}

module.exports = app;
