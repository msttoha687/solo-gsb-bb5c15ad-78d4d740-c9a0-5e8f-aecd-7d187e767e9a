'use strict';

/**
 * 文件存储：剧情以 JSON 文件形式保存在 DATA_DIR 下，
 * 首次启动（且未禁用播种）时将 samples/ 目录中的示例剧情复制进去。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeWeight, weightWhere } = require('./weight');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SAMPLES_DIR = process.env.SAMPLES_DIR || path.join(__dirname, '..', 'samples');
const SEED_ON_START = process.env.SEED_ON_START !== 'false';

function newToken() {
  return crypto.randomBytes(8).toString('hex');
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function storyPath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('非法的剧情 ID');
  return path.join(DATA_DIR, `${id}.json`);
}

function listStories() {
  ensureDataDir();
  const items = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          id: raw.id,
          title: raw.title || '未命名剧情',
          description: raw.description || '',
          startScene: raw.startScene || null,
          sceneCount: (raw.scenes || []).length,
          variableCount: (raw.variables || []).length,
          hasBaseline: !!(raw.baseline && Array.isArray(raw.baseline.issues)),
          baselineSavedAt: raw.baseline && raw.baseline.savedAt || null,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
  items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return items;
}

function getStory(id) {
  const p = storyPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * 保存分析基线：以传入的剧情（通常是编辑中的草稿）覆盖剧情内容，
 * 同时写入基线快照。返回规整后的完整记录。
 */
function saveStoryWithBaseline(id, story, baseline) {
  const existing = getStory(id);
  if (!existing) throw Object.assign(new Error('剧情不存在'), { status: 404 });
  const now = new Date().toISOString();
  const record = normalize({
    ...story,
    id,
    baseline,
    createdAt: existing.createdAt,
    updatedAt: now,
  });
  writeAtomic(storyPath(id), record);
  return record;
}

/** 清除基线（剧情内容保持不变） */
function clearBaseline(id) {
  const existing = getStory(id);
  if (!existing) throw Object.assign(new Error('剧情不存在'), { status: 404 });
  if (!existing.baseline) return existing;
  const record = normalize({ ...existing, baseline: null, updatedAt: new Date().toISOString() });
  writeAtomic(storyPath(id), record);
  return record;
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function createStory(story) {
  ensureDataDir();
  const id = story.id && /^[a-zA-Z0-9_-]+$/.test(story.id) ? story.id : newId();
  if (fs.existsSync(storyPath(id))) throw Object.assign(new Error('剧情 ID 已存在'), { status: 409 });
  const now = new Date().toISOString();
  const record = normalize({ ...story, id, createdAt: now, updatedAt: now });
  writeAtomic(storyPath(id), record);
  return record;
}

function updateStory(id, story) {
  const existing = getStory(id);
  if (!existing) throw Object.assign(new Error('剧情不存在'), { status: 404 });
  const record = normalize({
    ...story,
    id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  writeAtomic(storyPath(id), record);
  return record;
}

function deleteStory(id) {
  const p = storyPath(id);
  if (!fs.existsSync(p)) throw Object.assign(new Error('剧情不存在'), { status: 404 });
  fs.unlinkSync(p);
}

/** 规整化：只保留受支持的字段，补齐结构，避免脏数据写入 */
function normalize(input) {
  const variables = (input.variables || []).map((v) => {
    if (typeof v === 'string') return { name: v, description: '' };
    return { name: String(v.name || '').trim(), description: v.description || '' };
  }).filter((v) => v.name);

  const normAssigns = (list) => (list || [])
    .map((a) => ({ variable: String(a.variable || '').trim(), value: !!a.value }))
    .filter((a) => a.variable);

  // 选项 UID：基线指纹依赖“选项身份”而非数组下标。
  // 输入中的合法且未重复的 UID 予以保留；缺失 / 非法 / 重复则重新生成。
  const usedUids = new Set();
  const uidRe = /^[A-Za-z0-9_-]{4,40}$/;
  const collectUid = (uid) => {
    const u = String(uid || '').trim();
    if (uidRe.test(u) && !usedUids.has(u)) {
      usedUids.add(u);
      return u;
    }
    let gen;
    do { gen = `opt-${newToken()}`; } while (usedUids.has(gen));
    usedUids.add(gen);
    return gen;
  };

  const scenes = (input.scenes || []).map((s) => ({
    id: String(s.id || '').trim(),
    title: s.title || '',
    text: s.text || '',
    precondition: s.precondition || '',
    assigns: normAssigns(s.assigns),
    options: (s.options || []).map((o, oi) => ({
      uid: collectUid(o.uid),
      text: o.text || '',
      condition: o.condition || '',
      target: (o.target || '').trim(),
      // 结局概率推演权重：正整数，缺省不落盘（推演时按 1 处理）；非法权重抛出 400
      weight: normalizeWeight(o.weight, weightWhere(s.id, oi, o.text || '')),
      assigns: normAssigns(o.assigns),
    })),
  }));

  return {
    id: input.id,
    title: input.title || '未命名剧情',
    description: input.description || '',
    startScene: (input.startScene || '').trim(),
    variables,
    scenes,
    baseline: sanitizeBaseline(input.baseline),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

/**
 * 校验基线快照（基线由服务端 analyze 后生成，但导入的 JSON 也可能携带）。
 * 无效则丢弃（返回 null），保证持久化文件中不会出现脏基线。
 */
function sanitizeBaseline(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.issues)) return null;
  const issues = raw.issues
    .filter((i) => i && typeof i === 'object' && typeof i.fingerprint === 'string')
    .map((i) => ({
      type: typeof i.type === 'string' ? i.type : 'error',
      severity: i.severity === 'warning' ? 'warning' : 'error',
      code: typeof i.code === 'string' ? i.code : undefined,
      message: typeof i.message === 'string' ? i.message : '',
      sceneId: typeof i.sceneId === 'string' ? i.sceneId : undefined,
      optionIndex: Number.isInteger(i.optionIndex) ? i.optionIndex : undefined,
      optionUid: typeof i.optionUid === 'string' ? i.optionUid : null,
      targetSceneId: typeof i.targetSceneId === 'string' ? i.targetSceneId : undefined,
      fingerprint: i.fingerprint,
      distance: Number.isFinite(i.distance) ? i.distance : null,
      path: Array.isArray(i.path) ? i.path.filter((n) => n && typeof n === 'object') : [],
      _pathSig: typeof i._pathSig === 'string' ? i._pathSig : '',
    }));
  if (!issues.length) return null;
  return {
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    storyTitle: typeof raw.storyTitle === 'string' ? raw.storyTitle : '',
    startScene: typeof raw.startScene === 'string' ? raw.startScene : '',
    knownVars: Array.isArray(raw.knownVars) ? raw.knownVars.filter((v) => typeof v === 'string') : [],
    counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
    issues,
  };
}

/** 首次启动：当数据目录为空时，把 samples/ 下的示例播种进来 */
function seedSamples() {
  ensureDataDir();
  const existing = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  if (existing.length > 0 || !SEED_ON_START) return [];
  if (!fs.existsSync(SAMPLES_DIR)) return [];

  const seeded = [];
  for (const f of fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const story = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, f), 'utf8'));
      if (!story.id) story.id = path.basename(f, '.json');
      const now = new Date().toISOString();
      const record = normalize({ ...story, createdAt: now, updatedAt: now });
      writeAtomic(storyPath(record.id), record);
      seeded.push(record.id);
    } catch (e) {
      console.error(`[seed] 跳过无效示例 ${f}: ${e.message}`);
    }
  }
  return seeded;
}

module.exports = {
  DATA_DIR,
  ensureDataDir,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
  saveStoryWithBaseline,
  clearBaseline,
  normalize,
  sanitizeBaseline,
  seedSamples,
  newId,
};
