'use strict';

/**
 * 覆盖路线逐步回放
 *
 * 用一条已生成覆盖路线中的**稳定选项 UID 序列**，在**当前草稿**上从起点逐步
 * 重新执行：每一步都重新
 *   1. 在当前（草稿重新推导的）变量状态下求值选项条件；
 *   2. 校验目标场景存在；
 *   3. 应用选项赋值与目标场景进入赋值后，校验目标场景前置条件；
 *   4. 与路线生成时记录的期望场景 / 期望状态逐位对比。
 *
 * 草稿相对生成路线时已被修改（UID 缺失 / 被挪到别的场景、条件翻假、目标消失
 * 或改指、状态赋值变化导致位图不一致、起点变化等）时，停在**首个分歧点**，
 * 返回期望 / 实际状态与可读原因。整个过程只读取剧情对象，不保存、不修改草稿。
 */

const { compile } = require('./expression');
const { applyAssigns, collectStateVars } = require('./analyzer');

/** 分歧原因（供前端徽标 / 文案使用） */
const DIVERGENCE_TEXT = {
  startSceneChanged: '路线起点与当前草稿的起点场景不一致',
  startBlocked: '起点场景的前置条件在当前草稿的初始状态下不成立，剧情无法开始',
  optionMoved: '该稳定选项 UID 已不在原场景中（可能被移动到了别的场景）',
  uidMissing: '草稿中找不到该稳定选项 UID（选项可能已被删除）',
  conditionFalse: '选项条件在当前草稿推导出的变量状态下不再成立',
  orphanTarget: '选项没有目标或跳向了草稿中不存在的场景（悬空跳转）',
  targetChanged: '选项的跳转目标与路线记录不一致',
  blockedEntry: '应用当前草稿的赋值后，目标场景的前置条件不成立',
  stateMismatch: '当前草稿推导出的变量状态与路线记录的期望状态不一致',
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 选项稳定身份：优先 uid，旧数据退回 场景ID#下标（与分析器 / 覆盖路线一致） */
function uidOf(sceneId, index, option) {
  return (option && option.uid) || `idx:${sceneId}#${index}`;
}

/**
 * 对比期望 / 实际状态，返回取值不同的变量清单（变量全集 = 两者键的并集）。
 * 期望状态缺省（旧路线未携带 path 快照）时返回 null。
 */
function stateDiffs(expected, actual) {
  if (!expected || typeof expected !== 'object') return null;
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual || {})])].sort();
  const diffs = [];
  for (const v of names) {
    const e = !!expected[v];
    const a = !!(actual && actual[v]);
    if (e !== a) diffs.push({ variable: v, expected: e, actual: a });
  }
  return diffs;
}

/**
 * 在当前草稿上回放一条覆盖路线。
 *
 * @param storyInput 当前剧情（草稿或已保存），只读
 * @param routeInput { options: string[]（稳定选项 UID 序列，必填）,
 *                     path?: 生成路线时的场景/选项交替快照（提供期望状态） }
 * @returns 回放轨迹与首个分歧点（无分歧时 completed=true）
 */
function replayRoute(storyInput, routeInput) {
  const story = storyInput || {};
  const route = routeInput || {};

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法回放覆盖路线');
  }

  const uids = Array.isArray(route.options) ? route.options : null;
  if (!uids) throw badRequest('回放请求缺少路线选项序列（route.options）');
  if (!uids.length) throw badRequest('路线不包含任何选项，无法回放');
  if (uids.some((u) => typeof u !== 'string' || !u)) {
    throw badRequest('路线选项序列中的 UID 必须是非空字符串');
  }

  // 路线快照：[scene0, option0, scene1, option1, ...]
  const snapshotPath = Array.isArray(route.path) ? route.path : [];
  const expectedSceneNode = (edgeCount) => {
    const node = snapshotPath[edgeCount * 2];
    return node && node.kind === 'scene' ? node : null;
  };
  const expectedOptionNode = (i) => {
    const node = snapshotPath[i * 2 + 1];
    return node && node.kind === 'option' ? node : null;
  };

  // ---- 编译条件（语法错误按恒真处理，与分析器 / 覆盖路线一致） ----
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  for (const scene of sceneMap.values()) {
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
  }
  /** 取得某场景某选项的当前草稿编译结果（每次按现取值编译，捕获刚改过的条件） */
  const optionDraft = (sceneId, index) => {
    const scene = sceneMap.get(sceneId);
    const option = scene && Array.isArray(scene.options) ? scene.options[index] : null;
    if (!option) return null;
    const cond = safeCompile(option.condition, `场景 "${sceneId}" 选项 ${index + 1} 的条件`);
    return {
      option,
      cond,
      conditionRaw: (option.condition || '').trim(),
      conditionSyntaxError: cond === null && !!(option.condition || '').trim(),
      assigns: (option.assigns || []).filter((a) => a && a.variable),
    };
  };

  // 全剧情 UID 索引（首次出现位置），用于判断 UID 是缺失还是被挪到了别的场景
  const uidIndex = new Map();
  for (const scene of sceneMap.values()) {
    (scene.options || []).forEach((option, index) => {
      const uid = uidOf(scene.id, index, option);
      if (!uidIndex.has(uid)) uidIndex.set(uid, { sceneId: scene.id, index });
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });

  /** 按已知变量全集归一化：未出现的变量显式记为 false（前端可直接展示完整位图） */
  const normalizeState = (s) => {
    const out = {};
    for (const v of knownVars) out[v] = !!(s && s[v]);
    return out;
  };

  const mkDivergence = (reason, extra) => ({
    reason,
    reasonText: DIVERGENCE_TEXT[reason] || reason,
    message: DIVERGENCE_TEXT[reason] || reason,
    ...extra,
  });

  const traceSteps = [];
  let divergence = null;
  const stop = (reason, extra) => {
    if (!divergence) divergence = mkDivergence(reason, extra);
  };

  // ---- 起点：初始状态 = 起点场景的进入赋值 ----
  const startSceneId = story.startScene;
  const startScene = sceneMap.get(startSceneId);
  const startNode = expectedSceneNode(0);
  let state = normalizeState(applyAssigns({}, sceneAssigns.get(startSceneId) || []));

  const startTrace = {
    kind: 'scene',
    sceneId: startSceneId,
    title: startScene.title || '',
    state: { ...state },
    expectedSceneId: startNode ? startNode.sceneId : null,
    expectedState: startNode && startNode.state ? { ...startNode.state } : null,
  };
  startTrace.stateDiffs = stateDiffs(startTrace.expectedState, state);

  // 起点场景本身与路线记录不一致
  if (startNode && startNode.sceneId !== startSceneId) {
    stop('startSceneChanged', {
      index: -1,
      atStep: 0,
      uid: null,
      sceneId: startSceneId,
      expected: { sceneId: startNode.sceneId },
      actual: { sceneId: startSceneId },
    });
  } else {
    const startPc = sceneCond.get(startSceneId);
    if (startPc && !startPc.evaluate(state)) {
      stop('startBlocked', {
        index: -1,
        atStep: 0,
        uid: null,
        sceneId: startSceneId,
        expected: { sceneId: startSceneId, state: { ...state } },
        actual: { sceneId: startSceneId, state: { ...state } },
        explain: startPc.explain(state, true),
      });
    } else {
      const diffs = stateDiffs(startTrace.expectedState, state);
      if (diffs && diffs.length) {
        stop('stateMismatch', {
          index: -1,
          atStep: 0,
          uid: null,
          sceneId: startSceneId,
          expected: { sceneId: startSceneId, state: { ...startTrace.expectedState } },
          actual: { sceneId: startSceneId, state: { ...state } },
          stateDiffs: diffs,
        });
      }
    }
  }
  if (divergence) startTrace.diverged = true;

  // ---- 沿 UID 序列逐步推进，停在首个分歧点 ----
  let curSceneId = startSceneId;
  for (let i = 0; i < uids.length && !divergence; i++) {
    const uid = uids[i];
    const expNode = expectedOptionNode(i);
    const expSceneNode = expectedSceneNode(i + 1);
    const scene = sceneMap.get(curSceneId);
    const curOptions = scene ? (scene.options || []) : [];
    const localIndex = curOptions.findIndex((o, idx) => uidOf(curSceneId, idx, o) === uid);
    const od = localIndex >= 0 ? optionDraft(curSceneId, localIndex) : null;

    const baseStep = {
      index: i,
      uid,
      fromSceneId: curSceneId,
      optionIndex: localIndex >= 0 ? localIndex : null,
      text: od ? (od.option.text || '') : (expNode ? expNode.optionText || '' : ''),
      conditionRaw: od ? od.conditionRaw : null,
      conditionSyntaxError: od ? od.conditionSyntaxError : false,
      expectedUid: uid,
      expectedText: expNode ? expNode.optionText || '' : null,
      expectedTarget: expNode ? expNode.target || ''
        : (expSceneNode ? expSceneNode.sceneId || '' : ''),
      expectedStateBefore: (() => {
        const before = expectedSceneNode(i);
        return before && before.state ? { ...before.state } : null;
      })(),
      expectedStateAfter: expNode && expNode.stateAfter ? { ...expNode.stateAfter }
        : (expSceneNode && expSceneNode.state ? { ...expSceneNode.state } : null),
      stateBefore: { ...state },
      target: null,
      targetTitle: null,
      stateAfter: null,
      stateDiffsBefore: null,
      stateDiffsAfter: null,
      status: 'ok',
    };

    // 1) UID 在当前草稿中是否还能在原场景定位
    if (!od) {
      const elsewhere = uidIndex.get(uid);
      baseStep.status = 'diverged';
      traceSteps.push(baseStep);
      stop(elsewhere ? 'optionMoved' : 'uidMissing', {
        index: i,
        atStep: i + 1,
        uid,
        sceneId: curSceneId,
        expected: { sceneId: curSceneId },
        actual: elsewhere
          ? { sceneId: elsewhere.sceneId, optionIndex: elsewhere.index }
          : null,
      });
      break;
    }

    // 2) 到达当前场景时的状态是否仍与路线记录一致
    const beforeDiffs = stateDiffs(baseStep.expectedStateBefore, state);
    baseStep.stateDiffsBefore = beforeDiffs;
    if (beforeDiffs && beforeDiffs.length) {
      baseStep.status = 'diverged';
      traceSteps.push(baseStep);
      stop('stateMismatch', {
        index: i,
        atStep: i + 1,
        uid,
        sceneId: curSceneId,
        expected: { sceneId: curSceneId, state: { ...baseStep.expectedStateBefore } },
        actual: { sceneId: curSceneId, state: { ...state } },
        stateDiffs: beforeDiffs,
      });
      break;
    }

    // 3) 选项条件（草稿现取值重新编译求值）
    const condValue = !od.cond || od.cond.evaluate(state);
    if (!condValue) {
      baseStep.conditionValue = false;
      baseStep.status = 'diverged';
      traceSteps.push(baseStep);
      stop('conditionFalse', {
        index: i,
        atStep: i + 1,
        uid,
        sceneId: curSceneId,
        condition: od.conditionRaw,
        expected: { conditionValue: true },
        actual: { conditionValue: false },
        explain: od.cond ? od.cond.explain(state, true) : null,
      });
      break;
    }
    baseStep.conditionValue = true;

    // 4) 目标场景必须存在
    const targetId = (od.option.target || '').trim();
    baseStep.target = targetId;
    if (!targetId || !sceneMap.has(targetId)) {
      baseStep.status = 'diverged';
      traceSteps.push(baseStep);
      stop('orphanTarget', {
        index: i,
        atStep: i + 1,
        uid,
        sceneId: curSceneId,
        expected: { target: baseStep.expectedTarget || null },
        actual: { target: targetId || null, targetExists: false },
      });
      break;
    }

    // 应用选项赋值 + 目标场景进入赋值
    let nextState = applyAssigns(state, od.assigns);
    nextState = normalizeState(applyAssigns(nextState, sceneAssigns.get(targetId) || []));
    const targetScene = sceneMap.get(targetId);
    baseStep.targetTitle = targetScene.title || '';
    baseStep.stateAfter = { ...nextState };

    // 5) 跳转目标是否与路线记录一致
    if (baseStep.expectedTarget && targetId !== baseStep.expectedTarget) {
      baseStep.stateDiffsAfter = stateDiffs(baseStep.expectedStateAfter, nextState);
      baseStep.status = 'diverged';
      traceSteps.push(baseStep);
      stop('targetChanged', {
        index: i,
        atStep: i + 1,
        uid,
        sceneId: curSceneId,
        expected: { target: baseStep.expectedTarget },
        actual: { target: targetId },
      });
      break;
    }

    // 6) 目标场景前置条件（在应用当前草稿赋值后的状态下重新求值）
    const tc = sceneCond.get(targetId);
    if (tc && !tc.evaluate(nextState)) {
      baseStep.status = 'diverged';
      traceSteps.push(baseStep);
      stop('blockedEntry', {
        index: i,
        atStep: i + 1,
        uid,
        sceneId: curSceneId,
        target: targetId,
        expected: { target: targetId, conditionValue: true },
        actual: { target: targetId, conditionValue: false },
        explain: tc.explain(nextState, true),
      });
      break;
    }

    // 7) 赋值结果是否与路线记录的期望状态一致
    const afterDiffs = stateDiffs(baseStep.expectedStateAfter, nextState);
    baseStep.stateDiffsAfter = afterDiffs;
    if (afterDiffs && afterDiffs.length) {
      baseStep.status = 'diverged';
      traceSteps.push(baseStep);
      stop('stateMismatch', {
        index: i,
        atStep: i + 1,
        uid,
        sceneId: curSceneId,
        target: targetId,
        expected: { sceneId: targetId, state: { ...baseStep.expectedStateAfter } },
        actual: { sceneId: targetId, state: { ...nextState } },
        stateDiffs: afterDiffs,
      });
      break;
    }

    traceSteps.push(baseStep);
    state = nextState;
    curSceneId = targetId;
  }

  const completed = divergence === null && traceSteps.length === uids.length;
  const endScene = completed ? sceneMap.get(curSceneId) : null;

  return {
    ok: true,
    startScene: startSceneId,
    total: uids.length,
    completed,
    divergence,
    trace: {
      start: startTrace,
      steps: traceSteps,
      end: completed ? {
        kind: 'scene',
        sceneId: curSceneId,
        title: endScene ? (endScene.title || '') : '',
        state: { ...state },
      } : null,
    },
    knownVars,
    conditionErrors,
  };
}

module.exports = { replayRoute, DIVERGENCE_TEXT };
