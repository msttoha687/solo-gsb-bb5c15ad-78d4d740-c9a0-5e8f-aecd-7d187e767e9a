'use strict';

/**
 * 选项权重
 *
 * 权重用于「结局概率推演」：同一具体状态下，所有“条件成立且目标可进入”的选项
 * 按权重占比被选中。权重必须是正整数（1、2、3…）；缺省（未填写）视为 1，
 * 因此旧剧情 JSON 不写 weight 也能直接参与推演。
 *
 * 非法权重（0、负数、小数、字符串、布尔值等）在保存 / 导入 / 推演时
 * 都会得到带场景与选项位置的明确校验错误（HTTP 400）。
 */

function isValidWeight(raw) {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1;
}

/** 选项位置描述，用于校验错误定位 */
function weightWhere(sceneId, optionIndex, optionText) {
  const label = optionText ? `「${optionText}」` : '';
  return `场景 "${sceneId || '(无 ID)'}" 选项 ${optionIndex + 1}${label}`;
}

function badWeight(raw, where) {
  let shown;
  try { shown = JSON.stringify(raw); } catch (e) { shown = String(raw); }
  if (shown === undefined) shown = String(raw);
  const err = new Error(`${where}的权重必须是正整数（1、2、3…），当前值：${shown}`);
  err.status = 400;
  return err;
}

/**
 * 规整权重：缺省 => undefined（调用方按 1 处理，保存时不落盘该字段）；
 * 合法正整数 => 原值；非法 => 抛出带位置的 400 错误。
 */
function normalizeWeight(raw, where) {
  if (raw === undefined || raw === null) return undefined;
  if (!isValidWeight(raw)) throw badWeight(raw, where);
  return raw;
}

/** 推演时取权重：缺省 => 1；非法 => 抛出带位置的 400 错误 */
function weightOrDefault(raw, where) {
  const w = normalizeWeight(raw, where);
  return w === undefined ? 1 : w;
}

module.exports = { isValidWeight, normalizeWeight, weightOrDefault, weightWhere };
