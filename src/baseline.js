'use strict';

/**
 * 分析基线
 *
 * 用户可把某次分析结果保存为基线（随剧情 JSON 持久化），之后编辑剧情再次分析时，
 * 对比基线与当前结果，把每条问题标记为：
 *
 *   new         新增问题（基线没有、当前存在）
 *   fixed       已修复（基线有、当前没有）
 *   persistent  仍存在（指纹相同、细节也相同）
 *   changed     同一问题仍存在，但路径或文案等细节发生了变化（保留前后路径/消息）
 *
 * 匹配依据是 issue.fingerprint（见 fingerprint.js），与问题数组顺序无关。
 */

const { stableJson, issueFingerprint } = require('./fingerprint');

/**
 * 对同指纹下的多条问题再做区分：同一场景可能有两条选项都指向不存在的同名目标，
 * 此时用数组序号作为辅助序号（极少出现；正常情况下同指纹只有一条）。
 */
const PATH_NODE_KEEP = [
  'kind', 'sceneId', 'title', 'optionIndex', 'optionText', 'target', 'targetTitle',
  'state', 'stateAfter', 'blockedEntry', 'hypothetical', 'broken', 'deadEnd', 'entryBlocked',
];

function slimPath(path) {
  return (Array.isArray(path) ? path : []).map((n) => {
    const out = {};
    for (const k of PATH_NODE_KEEP) if (n[k] !== undefined) out[k] = n[k];
    return out;
  });
}

/**
 * 路径签名：只保留“经过哪些场景 / 选了哪条选项 / 跳到哪”，
 * 变量状态变化导致的路径证据变化也算路径变化（说明触发条件发生了改变）。
 */
function pathSignature(path) {
  return stableJson((Array.isArray(path) ? path : []).map((n) => {
    if (n.kind === 'scene') {
      return {
        kind: 'scene',
        sceneId: n.sceneId || '',
        state: n.state || null,
        blockedEntry: !!n.blockedEntry,
        hypothetical: !!n.hypothetical,
      };
    }
    return {
      kind: 'option',
      optionIndex: n.optionIndex ?? null,
      optionText: n.optionText || '',
      target: n.target || '',
      stateAfter: n.stateAfter || null,
      broken: !!n.broken,
      entryBlocked: !!n.entryBlocked,
      deadEnd: !!n.deadEnd,
    };
  }));
}

/** 基线中每条问题保留的字段（身份字段 + 前端对比展示所需的最小集合） */
function slimIssue(issue) {
  return {
    type: issue.type,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    sceneId: issue.sceneId,
    optionIndex: issue.optionIndex,
    optionUid: issue.optionUid || null,
    targetSceneId: issue.targetSceneId,
    fingerprint: issue.fingerprint,
    distance: issue.distance,
    path: slimPath(issue.path),
    _pathSig: pathSignature(issue.path),
  };
}

/** 由完整分析报告构造基线快照 */
function buildBaseline(analysis, story, savedAt) {
  const issues = (analysis.issues || []).map(slimIssue);
  return {
    savedAt: savedAt || new Date().toISOString(),
    storyTitle: (story && story.title) || '',
    startScene: (story && story.startScene) || '',
    knownVars: analysis.knownVars ? [...analysis.knownVars] : [],
    counts: { ...(analysis.counts || {}) },
    issues,
  };
}

/**
 * 对比基线与当前分析结果。
 * 返回 { baseline, summary, items:[{status, before, issue, changes}] }
 */
function compareWithBaseline(baseline, analysis) {
  if (!baseline || !Array.isArray(baseline.issues)) {
    throw new Error('基线数据无效或不存在');
  }

  // 指纹 -> 条目（同指纹多条时保留全部，按出现次序配对）
  const beforeMap = new Map();
  for (const b of baseline.issues) {
    const fp = b.fingerprint || issueFingerprint(b);
    if (!beforeMap.has(fp)) beforeMap.set(fp, []);
    beforeMap.get(fp).push(b);
  }
  const afterMap = new Map();
  for (const a of (analysis.issues || [])) {
    const fp = a.fingerprint || issueFingerprint(a);
    if (!afterMap.has(fp)) afterMap.set(fp, []);
    afterMap.get(fp).push(a);
  }

  const items = [];
  const summary = { total: 0, new: 0, fixed: 0, persistent: 0, changed: 0 };

  // 仍存在 / 详情变化 / 新增
  for (const [fp, afterList] of afterMap) {
    const beforeList = beforeMap.get(fp) || [];
    afterList.forEach((issue, i) => {
      const before = beforeList[i];
      if (!before) {
        items.push({ status: 'new', before: null, issue, changes: [] });
        summary.new++;
        return;
      }
      const changes = [];
      if ((before.message || '') !== (issue.message || '')) changes.push('message');
      const afterSig = pathSignature(issue.path);
      if (before._pathSig !== afterSig) changes.push('path');
      const status = changes.length ? 'changed' : 'persistent';
      items.push({ status, before, issue, changes });
      summary[status]++;
    });
  }

  // 已修复
  for (const [fp, beforeList] of beforeMap) {
    const afterList = afterMap.get(fp) || [];
    beforeList.forEach((before, i) => {
      if (i < afterList.length) return;
      items.push({ status: 'fixed', before, issue: null, changes: [] });
      summary.fixed++;
    });
  }

  summary.total = items.length;

  // 新增优先、其次详情变化、仍存在、已修复；同组按问题原有顺序
  const rank = { new: 0, changed: 1, persistent: 2, fixed: 3 };
  const orderOf = (it) => {
    const list = it.issue ? analysis.issues : baseline.issues;
    return list.indexOf(it.issue || it.before);
  };
  items.sort((a, b) => (rank[a.status] - rank[b.status]) || (orderOf(a) - orderOf(b)));

  return { baseline, summary, items };
}

module.exports = {
  buildBaseline,
  compareWithBaseline,
  slimIssue,
  pathSignature,
};
