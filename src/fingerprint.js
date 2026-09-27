'use strict';

/**
 * 问题稳定指纹
 *
 * 基线对比要求“同一条问题”在两次分析（场景/选项数组顺序可能变化、问题数组顺序也可能变化）
 * 之间能够被重新识别。指纹只依赖问题的**身份要素**，而不依赖路径、文案等易变细节：
 *
 *   问题类型 + 场景 ID + 选项身份（稳定 UID，缺失时退回 sceneId#数组下标）+ 关键目标场景 ID
 *
 * 序列化时对对象键排序，数组仅用于“本身就有顺序含义”的元组，因此指纹不依赖任何
 * 容器（scenes / options / issues）的遍历顺序。
 */

const crypto = require('crypto');

/** 规范化 JSON：对象键按字典序输出，避免键顺序影响结果 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 选项身份：优先使用随剧情持久化的稳定 UID，旧数据退回 场景ID#下标 */
function optionRef(issue) {
  if (issue.optionUid) return issue.optionUid;
  if (issue.optionIndex !== undefined && issue.optionIndex !== null) {
    return `idx:${issue.sceneId || ''}#${issue.optionIndex}`;
  }
  return 'idx:?';
}

function errorKey(issue) {
  const code = issue.code || 'unknown';
  switch (code) {
    case 'noStart':
      return ['error', code];
    case 'missingStart':
      return ['error', code, issue.startScene || ''];
    case 'dupScene':
      return ['error', code, [...(issue.sceneIds || [])].sort()];
    case 'noSceneId':
      // 没有 ID 的场景无法使用场景身份，只能以下标 + 标题兜底
      return ['error', code, issue.sceneIndex ?? -1, issue.title || ''];
    case 'badSyntax':
    case 'unknownVar': {
      const key = ['error', code];
      if (issue.variable) key.push(`var:${issue.variable}`);
      if (issue.optionIndex !== undefined && issue.optionIndex !== null) {
        key.push('option', issue.sceneId || '', optionRef(issue));
      } else if (issue.sceneId) {
        key.push('precondition', issue.sceneId);
      }
      return key;
    }
    default:
      return ['error', code, issue.sceneId || '', issue.optionIndex ?? ''];
  }
}

/**
 * 返回标识“同一条问题”的稳定元组（不包含路径 / 文案 / 状态等易变信息）。
 */
function issueKey(issue) {
  switch (issue.type) {
    case 'unreachableScene':
      return ['unreachableScene', 'scene', issue.sceneId ?? ''];
    case 'orphanOption':
    case 'blockedEntry':
    case 'neverTrueOption':
      return [
        issue.type,
        'option',
        issue.sceneId || '',
        optionRef(issue),
        issue.targetSceneId || '',
      ];
    case 'error':
      return errorKey(issue);
    default:
      return [issue.type || 'unknown', stableJson(issue)];
  }
}

/** 16 位 SHA-1 摘要：足够在单份剧情内去重，且 JSON 内体积小巧 */
function issueFingerprint(issue) {
  return crypto.createHash('sha1')
    .update(stableJson(issueKey(issue)))
    .digest('hex')
    .slice(0, 16);
}

module.exports = { stableJson, issueKey, issueFingerprint };
