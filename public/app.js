'use strict';

/* ============================================================
 * 全局状态
 * ============================================================ */
const state = {
  list: [],
  story: null,          // 当前剧情（编辑中的草稿）
  currentId: null,      // 当前选中场景 ID
  analysis: null,       // 最近一次分析结果
  baseline: null,       // 当前剧情保存的分析基线
  diff: null,           // 最近一次基线对比结果 { summary, items }
  diffFilter: 'all',    // 对比状态筛选：all/new/fixed/persistent/changed
  diffStale: false,     // 对比之后剧情又被编辑过
  detailItem: null,     // 详情面板当前展示的对比条目
  detailPathMode: 'after', // 详情中查看的路径：after（当前）/ before（基线）
  pathQuery: { targetScene: '', constraints: [], requiredOptions: [], disabledOptions: [] }, // 目标路径查询条件（编辑中；必经/禁用为选项 UID）
  pathQueryResult: null,  // 最近一次路径查询结果
  pathQueryStale: false,  // 查询之后剧情或查询条件又被修改过
  _pqSig: null,           // 查询面板场景/变量签名（避免每次编辑都重建下拉框）
  probResult: null,       // 最近一次结局概率推演结果
  probStale: false,       // 推演之后剧情又被编辑过
  fcResult: null,         // 最近一次结局必经抉择结果
  fcStale: false,         // 必经分析之后剧情或起点又被修改过
  fcBypasses: {},         // 各结局已请求的绕开反例：{ [sceneId]: { uid, result, loading, error } }
  covResult: null,        // 最近一次选项覆盖路线结果
  covStale: false,        // 生成路线之后剧情又被编辑过
  covReplay: null,        // 逐步回放状态 { routeIndex, uids, result, loading, cursor }
  covReplayTimer: null,   // 草稿变化后回放结果的防抖重算定时器
  foreshadow: { setups: [], payoffs: [] }, // 伏笔回收校验条件（编辑中；铺垫 / 回收场景 ID）
  fsResult: null,         // 最近一次伏笔回收路线校验结果
  fsStale: false,         // 校验之后剧情或校验条件又被修改过
  _fsSig: null,           // 校验面板场景签名（避免每次编辑都重建下拉框）
  pacing: { highIntensityScenes: [], maxConsecutive: 3 }, // 节奏校验设置（编辑中；高强度场景 ID + 允许的最长连续数）
  pacResult: null,        // 最近一次节奏校验结果
  pacStale: false,        // 校验之后剧情或校验设置又被修改过
  _pacSig: null,          // 节奏面板场景签名（避免每次编辑都重建勾选列表）
  strategy: { targetScene: '', environmentScenes: [] }, // 结局保证到达设置（编辑中；目标结局 + 环境控制场景 ID）
  stgResult: null,        // 最近一次结局保证到达求解结果
  stgStale: false,        // 求解之后剧情或求解设置又被修改过
  _stgSig: null,          // 策略面板场景签名（避免每次编辑都重建下拉框与勾选列表）
  aaResult: null,         // 最近一次变量赋值消费审计结果
  aaStale: false,         // 审计之后剧情又被修改过
  dirty: false,
  saving: false,
};

const $ = (id) => document.getElementById(id);

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/* ============================================================
 * 剧情级操作
 * ============================================================ */
async function loadList(selectId) {
  state.list = await api('GET', '/api/stories');
  const sel = $('storySelect');
  sel.innerHTML = '';
  for (const s of state.list) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    sel.appendChild(opt);
  }
  if (selectId && state.list.some((s) => s.id === selectId)) sel.value = selectId;
  else if (state.list.length) sel.value = state.list[0].id;
  return sel.value;
}

async function openStory(id) {
  state.story = await api('GET', `/api/stories/${id}`);
  state.currentId = state.story.startScene || (state.story.scenes[0] && state.story.scenes[0].id) || null;
  state.dirty = false;
  state.baseline = state.story.baseline || null;
  state.diff = null;
  state.diffFilter = 'all';
  state.diffStale = false;
  state.detailItem = null;
  state.pathQuery = { targetScene: '', constraints: [], requiredOptions: [], disabledOptions: [] };
  state.pathQueryResult = null;
  state.pathQueryStale = false;
  state._pqSig = null;
  state.probResult = null;
  state.probStale = false;
  state.fcResult = null;
  state.fcStale = false;
  state.fcBypasses = {};
  state.covResult = null;
  state.covStale = false;
  resetCoverageReplay();
  state.foreshadow = { setups: [], payoffs: [] };
  state.fsResult = null;
  state.fsStale = false;
  state._fsSig = null;
  state.pacing = { highIntensityScenes: [], maxConsecutive: 3 };
  state.pacResult = null;
  state.pacStale = false;
  state._pacSig = null;
  state.strategy = { targetScene: '', environmentScenes: [] };
  state.stgResult = null;
  state.stgStale = false;
  state._stgSig = null;
  state.aaResult = null;
  state.aaStale = false;
  $('storySelect').value = id;
  renderAll();
  await runAnalysis(false);
}

async function refreshAndOpen(id) {
  await loadList(id);
  await openStory(id);
}

async function createStory() {
  const story = {
    title: '未命名剧情',
    description: '',
    startScene: 'start',
    variables: [{ name: 'flag', description: '示例变量，可删除' }],
    scenes: [{
      id: 'start', title: '起点', text: '故事从这里开始。',
      precondition: '', assigns: [],
      options: [{ text: '继续', condition: '', target: '', assigns: [] }],
    }],
  };
  const created = await api('POST', '/api/stories', story);
  toast('已创建新剧情');
  await refreshAndOpen(created.id);
}

async function saveStory() {
  if (!state.story) return;
  state.saving = true;
  try {
    const saved = await api('PUT', `/api/stories/${state.story.id}`, state.story);
    state.story = saved;
    state.baseline = saved.baseline || null;
    state.dirty = false;
    renderMeta();
    renderSceneList();
    renderSaveStatus();
    toast('已保存');
    await runAnalysis(false);
  } catch (e) {
    toast(`保存失败：${e.message}`);
  } finally {
    state.saving = false;
  }
}

async function deleteStory() {
  if (!state.story) return;
  if (!confirm(`确定删除剧情「${state.story.title}」？此操作不可恢复。`)) return;
  await api('DELETE', `/api/stories/${state.story.id}`);
  state.story = null;
  state.analysis = null;
  state.baseline = null;
  state.diff = null;
  state.detailItem = null;
  state.diffStale = false;
  state.pathQuery = { targetScene: '', constraints: [], requiredOptions: [], disabledOptions: [] };
  state.pathQueryResult = null;
  state.pathQueryStale = false;
  state._pqSig = null;
  state.probResult = null;
  state.probStale = false;
  state.fcResult = null;
  state.fcStale = false;
  state.fcBypasses = {};
  state.covResult = null;
  state.covStale = false;
  resetCoverageReplay();
  state.foreshadow = { setups: [], payoffs: [] };
  state.fsResult = null;
  state.fsStale = false;
  state._fsSig = null;
  state.pacing = { highIntensityScenes: [], maxConsecutive: 3 };
  state.pacResult = null;
  state.pacStale = false;
  state._pacSig = null;
  state.strategy = { targetScene: '', environmentScenes: [] };
  state.stgResult = null;
  state.stgStale = false;
  state._stgSig = null;
  state.aaResult = null;
  state.aaStale = false;
  const next = await loadList();
  if (next) await openStory(next);
  else { renderAll(); toast('已删除'); }
}

function exportStory() {
  if (!state.story) return;
  const a = document.createElement('a');
  a.href = `/api/stories/${state.story.id}/export`;
  a.download = `${state.story.id}.json`;
  a.click();
}

function importStory(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.scenes)) throw new Error('JSON 中缺少 scenes 数组');
      delete data.id; // 导入总是创建新剧情，避免覆盖
      delete data.createdAt;
      delete data.updatedAt;
      const created = await api('POST', '/api/stories', data);
      toast('导入成功');
      await refreshAndOpen(created.id);
    } catch (e) {
      toast(`导入失败：${e.message}`);
    }
  };
  reader.readAsText(file, 'utf-8');
}

/* ============================================================
 * 渲染：顶部设置 + 变量
 * ============================================================ */
function renderAll() {
  renderMeta();
  renderVars();
  renderStartSelect();
  renderSceneList();
  renderEditor();
  renderSaveStatus();
  renderAnalysis();
  renderPathQueryPanel();
  renderProbabilityPanel();
  renderForcedPanel();
  renderCoveragePanel();
  renderForeshadowPanel();
  renderPacingPanel();
  renderStrategyPanel();
  renderAssignAuditPanel();
  renderDetail(null);
}

function renderMeta() {
  if (!state.story) return;
  $('storyTitle').value = state.story.title || '';
  $('storyDesc').value = state.story.description || '';
}

function renderStartSelect() {
  const sel = $('startScene');
  sel.innerHTML = '';
  for (const sc of state.story.scenes) {
    const opt = document.createElement('option');
    opt.value = sc.id;
    opt.textContent = `${sc.id}${sc.title ? ' — ' + sc.title : ''}`;
    sel.appendChild(opt);
  }
  sel.value = state.story.startScene || '';
}

function renderVars() {
  const box = $('varList');
  box.innerHTML = '';
  for (const v of state.story.variables) {
    const chip = document.createElement('div');
    chip.className = 'var-chip';
    chip.innerHTML = `<code></code><span class="var-desc"></span><button title="删除变量">✕</button>`;
    chip.querySelector('code').textContent = v.name;
    const desc = chip.querySelector('.var-desc');
    desc.textContent = v.description || '';
    desc.title = '点击编辑说明';
    desc.style.cursor = 'pointer';
    desc.addEventListener('click', () => {
      const d = prompt(`变量 "${v.name}" 的说明：`, v.description || '');
      if (d !== null) { v.description = d; markDirty(renderVars); }
    });
    chip.querySelector('button').addEventListener('click', () => {
      if (!confirm(`删除变量 "${v.name}"？相关条件文本会保留（分析时会提示未声明变量）。`)) return;
      state.story.variables = state.story.variables.filter((x) => x.name !== v.name);
      markDirty(renderVars);
    });
    box.appendChild(chip);
  }
}

function addVar() {
  const input = $('newVarName');
  const name = input.value.trim();
  if (!name) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return toast('变量名需以字母/下划线开头，仅含字母数字下划线');
  if (state.story.variables.some((v) => v.name === name)) return toast('变量已存在');
  state.story.variables.push({ name, description: '' });
  input.value = '';
  markDirty(renderVars);
}

/* ============================================================
 * 渲染：场景列表
 * ============================================================ */
function renderSceneList() {
  const ul = $('sceneList');
  ul.innerHTML = '';
  for (const sc of state.story.scenes) {
    const li = document.createElement('li');
    li.className = 'scene-item' + (sc.id === state.currentId ? ' active' : '');

    const status = state.analysis ? state.analysis.sceneStatus[sc.id] : null;
    let badge = '';
    if (status === 'reachable') badge = '<span class="badge badge-ok">可达</span>';
    else if (status === 'unreachable') badge = '<span class="badge badge-err">不可达</span>';
    else if (status === 'blocked') badge = '<span class="badge badge-err">入口受阻</span>';

    li.innerHTML = `
      <span class="si-id"></span>
      <span class="si-title"></span>
      <span class="si-start">${sc.id === state.story.startScene ? '★起点' : ''}</span>
      ${badge}
    `;
    li.querySelector('.si-id').textContent = sc.id;
    li.querySelector('.si-title').textContent = sc.title || '(无标题)';
    li.addEventListener('click', () => {
      state.currentId = sc.id;
      renderSceneList();
      renderEditor();
    });
    ul.appendChild(li);
  }
}

function addScene() {
  let base = 'scene';
  let id = base;
  let n = 2;
  const ids = new Set(state.story.scenes.map((s) => s.id));
  while (ids.has(id)) id = `${base}${n++}`;
  const sc = { id, title: '新场景', text: '', precondition: '', assigns: [], options: [] };
  state.story.scenes.push(sc);
  state.currentId = id;
  markDirty(() => { renderSceneList(); renderEditor(); renderStartSelect(); });
}

/* ============================================================
 * 渲染：场景编辑器
 * ============================================================ */
function currentScene() {
  return state.story.scenes.find((s) => s.id === state.currentId) || null;
}

function renderEditor() {
  const sc = currentScene();
  $('editorEmpty').hidden = !!sc;
  $('editor').hidden = !sc;
  if (!sc) return;

  $('sceneId').value = sc.id;
  $('sceneTitle').value = sc.title || '';
  $('sceneText').value = sc.text || '';
  $('scenePre').value = sc.precondition || '';
  renderAssigns('sceneAssigns', sc.assigns, 'btnAddSceneAssign');
  renderOptions(sc);
}

function renderAssigns(containerId, assigns, _btnId) {
  const box = $(containerId);
  box.innerHTML = '';
  const varNames = state.story.variables.map((v) => v.name);

  assigns.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'assign-row';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">（选择变量）</option>' +
      varNames.map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.value = a.variable;
    sel.addEventListener('change', () => { a.variable = sel.value; markDirty(); });

    const arrow = document.createElement('span');
    arrow.className = 'assign-arrow';
    arrow.textContent = '←';

    const val = document.createElement('select');
    val.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    val.value = a.value ? 'true' : 'false';
    val.addEventListener('change', () => { a.value = val.value === 'true'; markDirty(); });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除赋值';
    del.addEventListener('click', () => { assigns.splice(i, 1); markDirty(() => renderEditor()); });

    row.append(sel, arrow, val, del);
    box.appendChild(row);
  });
}

function renderOptions(sc) {
  const box = $('optionList');
  box.innerHTML = '';
  sc.options.forEach((opt, i) => {
    const card = document.createElement('div');
    card.className = 'option-card';

    // 分析状态着色
    const optStatus = state.analysis ? state.analysis.optionStatus[`${sc.id}#${i}`] : null;
    if (optStatus === 'orphan' || optStatus === 'blockedEntry' || optStatus === 'neverTrue') card.classList.add('is-bad');
    let statusLabel = '';
    if (optStatus === 'orphan') statusLabel = '<span class="badge badge-err">悬空跳转</span>';
    else if (optStatus === 'blockedEntry') statusLabel = '<span class="badge badge-err">入口受阻</span>';
    else if (optStatus === 'neverTrue') statusLabel = '<span class="badge badge-warn">条件恒假</span>';
    else if (optStatus === 'ok') statusLabel = '<span class="badge badge-ok">可达</span>';
    else if (optStatus === 'inUnreachableScene') statusLabel = '<span class="badge badge-muted">场景不可达</span>';

    card.innerHTML = `
      <div class="option-top">
        <span class="option-index">${i + 1}</span>
        <input type="text" class="opt-text" placeholder="选项文案" />
        ${statusLabel}
        <button class="opt-remove" title="删除选项">✕</button>
      </div>
      <div class="option-grid">
        <label class="field full"><span>显示条件（留空恒真）</span><input type="text" class="opt-cond" spellcheck="false" placeholder="如 hasKey && !witchHelp" /></label>
        <label class="field"><span>跳转目标</span><select class="opt-target"></select></label>
        <label class="field opt-weight-field"><span>权重</span><input type="number" class="opt-weight" min="1" step="1" title="结局概率推演用的正整数权重：同一状态下，可走的选项按权重占比被选中；缺省为 1" /></label>
        <div class="field full">
          <span>选择时赋值</span>
          <div class="assign-list opt-assigns"></div>
          <button class="btn btn-small btn-add-assign">＋ 赋值</button>
        </div>
      </div>
    `;

    const text = card.querySelector('.opt-text');
    const cond = card.querySelector('.opt-cond');
    const target = card.querySelector('.opt-target');
    const weight = card.querySelector('.opt-weight');
    text.value = opt.text || '';
    cond.value = opt.condition || '';
    weight.value = opt.weight === undefined ? 1 : opt.weight;

    target.innerHTML = '<option value="">（不跳转 / 悬空）</option>' +
      state.story.scenes.map((s) => `<option value="${s.id}">${s.id}${s.title ? ' — ' + s.title : ''}</option>`).join('');
    target.value = opt.target || '';

    text.addEventListener('input', () => { opt.text = text.value; markDirty(); });
    cond.addEventListener('input', () => { opt.condition = cond.value; markDirty(); });
    target.addEventListener('change', () => { opt.target = target.value; markDirty(); });
    weight.addEventListener('change', () => {
      const v = Number(weight.value);
      if (!Number.isInteger(v) || v < 1) {
        toast('权重必须是正整数（1、2、3…）');
        weight.value = opt.weight === undefined ? 1 : opt.weight;
        return;
      }
      if (v === 1) delete opt.weight; // 缺省即 1，不写入 JSON
      else opt.weight = v;
      weight.value = v;
      markDirty();
    });
    card.querySelector('.opt-remove').addEventListener('click', () => {
      sc.options.splice(i, 1);
      markDirty(() => renderEditor());
    });
    card.querySelector('.btn-add-assign').addEventListener('click', () => {
      opt.assigns.push({ variable: state.story.variables[0]?.name || '', value: true });
      markDirty(() => renderEditor());
    });
    renderOptionAssigns(card.querySelector('.opt-assigns'), opt);

    box.appendChild(card);
  });
}

function renderOptionAssigns(container, opt) {
  container.innerHTML = '';
  const varNames = state.story.variables.map((v) => v.name);
  opt.assigns.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'assign-row';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">（变量）</option>' +
      varNames.map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.value = a.variable;
    sel.addEventListener('change', () => { a.variable = sel.value; markDirty(); });

    const arrow = document.createElement('span');
    arrow.className = 'assign-arrow';
    arrow.textContent = '←';

    const val = document.createElement('select');
    val.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    val.value = a.value ? 'true' : 'false';
    val.addEventListener('change', () => { a.value = val.value === 'true'; markDirty(); });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.addEventListener('click', () => { opt.assigns.splice(i, 1); markDirty(() => renderEditor()); });

    row.append(sel, arrow, val, del);
    container.appendChild(row);
  });
}

/* ============================================================
 * 编辑器事件绑定
 * ============================================================ */
function bindEditorEvents() {
  $('sceneTitle').addEventListener('input', (e) => { currentScene().title = e.target.value; markDirty(); });
  $('sceneText').addEventListener('input', (e) => { currentScene().text = e.target.value; markDirty(); });
  $('scenePre').addEventListener('input', (e) => { currentScene().precondition = e.target.value; markDirty(); });

  $('sceneId').addEventListener('change', (e) => {
    const sc = currentScene();
    const newId = e.target.value.trim();
    if (!newId) { e.target.value = sc.id; return; }
    if (!/^[A-Za-z0-9_-]+$/.test(newId)) { toast('场景 ID 只能含字母、数字、下划线和连字符'); e.target.value = sc.id; return; }
    if (state.story.scenes.some((x) => x !== sc && x.id === newId)) { toast('该 ID 已存在'); e.target.value = sc.id; return; }
    const oldId = sc.id;
    sc.id = newId;
    // 同步更新所有跳转引用与起点
    for (const other of state.story.scenes) {
      for (const o of other.options) if (o.target === oldId) o.target = newId;
    }
    if (state.story.startScene === oldId) state.story.startScene = newId;
    state.currentId = newId;
    markDirty(() => { renderSceneList(); renderStartSelect(); });
  });

  $('btnAddSceneAssign').addEventListener('click', () => {
    const sc = currentScene();
    sc.assigns.push({ variable: state.story.variables[0]?.name || '', value: true });
    markDirty(() => renderEditor());
  });

  $('btnAddOption').addEventListener('click', () => {
    // 预分配稳定 UID：编辑器中的新选项也能立刻用于路径查询的必经 / 禁用选择
    currentScene().options.push({ uid: genOptionUid(), text: '新选项', condition: '', target: '', assigns: [] });
    markDirty(() => renderEditor());
  });

  $('storyTitle').addEventListener('input', (e) => { state.story.title = e.target.value; markDirty(); });
  $('storyDesc').addEventListener('input', (e) => { state.story.description = e.target.value; markDirty(); });
  $('startScene').addEventListener('change', (e) => { state.story.startScene = e.target.value; markDirty(renderSceneList); });
  $('btnAddVar').addEventListener('click', addVar);
  $('newVarName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addVar(); });
  $('btnAddScene').addEventListener('click', addScene);
}

/* ============================================================
 * 脏标记 / 保存状态
 * ============================================================ */
let reanalyzeTimer = null;
function markDirty(rerender) {
  state.dirty = true;
  if (state.diff) state.diffStale = true;
  markPathQueryStale();
  markProbabilityStale();
  markForcedStale();
  markCoverageStale();
  markForeshadowStale();
  markPacingStale();
  markStrategyStale();
  markAssignAuditStale();
  renderSaveStatus();
  if (rerender) rerender();
  else renderAnalysis();
  renderPathQueryPanel(); // 内部有签名缓存，场景/变量未变时仅刷新过期提示与结果
  renderProbabilityPanel(); // 仅刷新过期提示与已展示的结果，不重新推演
  renderForcedPanel(); // 仅刷新过期提示与已展示的结果，不重新分析
  renderCoveragePanel(); // 仅刷新过期提示与已展示的路线，不重新生成
  renderForeshadowPanel(); // 内部有签名缓存，场景未变时仅刷新过期提示与结果
  renderPacingPanel(); // 内部有签名缓存，场景未变时仅刷新过期提示与结果
  renderStrategyPanel(); // 内部有签名缓存，场景未变时仅刷新过期提示与结果
  renderAssignAuditPanel(); // 仅刷新过期提示与已展示的结果，不重新审计
  clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(() => runAnalysis(true), 500);
}

function renderSaveStatus() {
  const el = $('saveStatus');
  if (!state.story) { el.textContent = ''; return; }
  el.textContent = state.dirty ? '● 有未保存的修改' : '○ 已与服务器同步';
  el.style.color = state.dirty ? 'var(--warning)' : 'var(--ok)';
  $('btnSave').disabled = state.saving;
}

/* ============================================================
 * 分析
 * ============================================================ */
async function runAnalysis(isDraft) {
  if (!state.story) { state.analysis = null; renderAnalysis(); return; }
  try {
    state.analysis = await api('POST', '/api/analyze', state.story);
    renderSceneList();
    renderEditor();
    renderAnalysis();
  } catch (e) {
    toast(`分析失败：${e.message}`);
  }
}

/* ============================================================
 * 分析基线：保存 / 对比 / 删除
 * ============================================================ */
async function saveBaseline() {
  if (!state.story) return;
  try {
    const result = await api('POST', `/api/stories/${state.story.id}/baseline`, state.story);
    state.story = result.story;
    state.baseline = result.baseline;
    state.analysis = result.analysis;
    state.dirty = false;
    state.diffStale = false;
    renderMeta();
    renderSceneList();
    renderEditor();
    renderSaveStatus();
    toast('已保存分析基线，可开始编辑后运行对比');
    await runCompare();
  } catch (e) {
    toast(`保存基线失败：${e.message}`);
  }
}

async function runCompare() {
  if (!state.story || !state.baseline) return;
  try {
    state.diff = await api('POST', `/api/stories/${state.story.id}/baseline/compare`, state.story);
    state.diffStale = false;
    state.detailItem = null;
    renderDetail(null);
    renderAnalysis();
  } catch (e) {
    toast(`对比失败：${e.message}`);
  }
}

async function clearBaseline() {
  if (!state.story || !state.baseline) return;
  if (!confirm('确定删除该剧情的分析基线？删除后将无法再做基线对比。')) return;
  try {
    const result = await api('DELETE', `/api/stories/${state.story.id}/baseline`);
    state.story = result.story;
    state.baseline = null;
    state.diff = null;
    state.diffFilter = 'all';
    state.diffStale = false;
    state.detailItem = null;
    renderDetail(null);
    renderAnalysis();
    toast('基线已删除');
  } catch (e) {
    toast(`删除基线失败：${e.message}`);
  }
}

const DIFF_META = {
  new: { label: '新增', cls: 'diff-new' },
  fixed: { label: '已修复', cls: 'diff-fixed' },
  persistent: { label: '仍存在', cls: 'diff-persistent' },
  changed: { label: '详情变化', cls: 'diff-changed' },
};

/* ============================================================
 * 目标路径查询
 * ============================================================ */
function pqSignature() {
  if (!state.story) return '';
  // 场景与选项（UID / 文案 / 目标）或变量集合变化时才重建下拉框
  return JSON.stringify([
    state.story.scenes.map((s) => [
      s.id,
      (s.options || []).map((o) => [o.uid || '', o.text || '', (o.target || '').trim()]),
    ]),
    state.story.variables.map((v) => v.name),
  ]);
}

/** 客户端为编辑器中新建的选项预分配稳定 UID（保存时服务端会保留合法 UID） */
function genOptionUid() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return 'opt-' + [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 全剧情选项目录（按场景 / 选项顺序），仅含带稳定 UID 的选项 */
function pqOptionCatalog() {
  const catalog = [];
  if (!state.story) return catalog;
  for (const sc of state.story.scenes) {
    (sc.options || []).forEach((o, i) => {
      if (o && o.uid) {
        catalog.push({ uid: o.uid, sceneId: sc.id, index: i, text: o.text || '', target: (o.target || '').trim() });
      }
    });
  }
  return catalog;
}

function pqOptionLabel(e) {
  return `${e.sceneId}#${e.index + 1}「${e.text || '（无文案）'}」→ ${e.target || '（不跳转）'}`;
}

function markPathQueryStale() {
  if (!state.pathQueryResult) return;
  state.pathQueryStale = true;
  const el = $('pqStale');
  if (el) el.hidden = false;
}

function renderPathQueryPanel() {
  const card = $('pathQueryCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;

  // 仅当场景 / 选项 / 变量集合变化时才重建下拉框与各行，避免打断正在进行的交互
  const sig = pqSignature();
  if (sig !== state._pqSig) {
    state._pqSig = sig;
    const sel = $('pqTarget');
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '（选择目标场景）';
    sel.appendChild(ph);
    for (const s of state.story.scenes) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.id}${s.title ? ' — ' + s.title : ''}`;
      sel.appendChild(opt);
    }
    if (state.pathQuery.targetScene &&
        state.story.scenes.some((s) => s.id === state.pathQuery.targetScene)) {
      sel.value = state.pathQuery.targetScene;
    } else {
      state.pathQuery.targetScene = '';
      sel.value = '';
    }
    // 选项被删除 / UID 失效时，自动从查询条件中剔除（保留未选择的空行）
    const validUids = new Set(pqOptionCatalog().map((e) => e.uid));
    const prune = (arr) => arr.filter((uid) => !uid || validUids.has(uid));
    state.pathQuery.requiredOptions = prune(state.pathQuery.requiredOptions);
    state.pathQuery.disabledOptions = prune(state.pathQuery.disabledOptions);
    renderPqConstraints();
    renderPqRequired();
    renderPqDisabled();
  }

  $('pqStale').hidden = !state.pathQueryStale;
  renderPathQueryResult();
}

function renderPqConstraints() {
  const box = $('pqConstraints');
  box.innerHTML = '';
  const varNames = state.story.variables.map((v) => v.name);
  state.pathQuery.constraints.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'assign-row';

    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">（选择变量）</option>' +
      varNames.map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.value = c.variable;
    sel.addEventListener('change', () => { c.variable = sel.value; markPathQueryStale(); });

    const eq = document.createElement('span');
    eq.className = 'assign-arrow';
    eq.textContent = '=';

    const val = document.createElement('select');
    val.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    val.value = c.value ? 'true' : 'false';
    val.addEventListener('change', () => { c.value = val.value === 'true'; markPathQueryStale(); });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除约束';
    del.addEventListener('click', () => {
      state.pathQuery.constraints.splice(i, 1);
      renderPqConstraints();
      markPathQueryStale();
    });

    row.append(sel, eq, val, del);
    box.appendChild(row);
  });
}

/** 构造一个“按场景分组”的选项选择下拉框 */
function buildPqOptionSelect(currentUid, disabledUids) {
  const catalog = pqOptionCatalog();
  const blocked = new Set(disabledUids || []);
  const sel = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '（选择选项）';
  sel.appendChild(placeholder);

  let optgroup = null;
  for (const e of catalog) {
    if (!optgroup || optgroup.label !== e.sceneId) {
      optgroup = document.createElement('optgroup');
      optgroup.label = e.sceneId;
      sel.appendChild(optgroup);
    }
    const opt = document.createElement('option');
    opt.value = e.uid;
    opt.textContent = pqOptionLabel(e);
    // 已被同一列表其他行选中、或在另一列表（必经/禁用互斥）中的选项禁用
    if (e.uid !== currentUid && blocked.has(e.uid)) {
      opt.disabled = true;
      opt.textContent += '（已选用）';
    }
    optgroup.appendChild(opt);
  }
  sel.value = currentUid || '';
  return sel;
}

/** 渲染必经 / 禁用选项行；ordered=true 时带序号与 ↑↓ 排序按钮 */
function renderPqOptionRows(containerId, listKey, ordered) {
  const box = $(containerId);
  box.innerHTML = '';
  const list = state.pathQuery[listKey];
  const otherKey = ordered ? 'disabledOptions' : 'requiredOptions';

  list.forEach((uid, i) => {
    const row = document.createElement('div');
    row.className = 'pq-opt-row';

    if (ordered) {
      const badge = document.createElement('span');
      badge.className = 'pq-order';
      badge.textContent = i + 1;
      row.appendChild(badge);
    }

    const usedInSame = list.filter((u, j) => u && j !== i);
    const sel = buildPqOptionSelect(uid, [...usedInSame, ...state.pathQuery[otherKey]]);
    sel.addEventListener('change', () => {
      list[i] = sel.value;
      renderPqOptionRows(containerId, listKey, ordered);
      markPathQueryStale();
    });
    row.appendChild(sel);

    if (ordered) {
      const up = document.createElement('button');
      up.className = 'pq-order-btn';
      up.textContent = '↑';
      up.title = '前移';
      up.disabled = i === 0;
      up.addEventListener('click', () => {
        if (i === 0) return;
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        renderPqOptionRows(containerId, listKey, ordered);
        markPathQueryStale();
      });
      const down = document.createElement('button');
      down.className = 'pq-order-btn';
      down.textContent = '↓';
      down.title = '后移';
      down.disabled = i === list.length - 1;
      down.addEventListener('click', () => {
        if (i === list.length - 1) return;
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
        renderPqOptionRows(containerId, listKey, ordered);
        markPathQueryStale();
      });
      row.append(up, down);
    }

    const del = document.createElement('button');
    del.className = 'pq-opt-del';
    del.textContent = '✕';
    del.title = ordered ? '移除必经选项' : '移除禁用选项';
    del.addEventListener('click', () => {
      list.splice(i, 1);
      renderPqOptionRows(containerId, listKey, ordered);
      markPathQueryStale();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

function renderPqRequired() {
  renderPqOptionRows('pqRequired', 'requiredOptions', true);
}

function renderPqDisabled() {
  renderPqOptionRows('pqDisabled', 'disabledOptions', false);
}

async function runPathQuery() {
  if (!state.story) return;
  const targetScene = state.pathQuery.targetScene;
  if (!targetScene) return toast('请先选择目标场景');
  const constraints = state.pathQuery.constraints.filter((c) => c.variable);
  const requiredOptions = state.pathQuery.requiredOptions.filter(Boolean);
  const disabledOptions = state.pathQuery.disabledOptions.filter(Boolean);

  if (new Set(requiredOptions).size !== requiredOptions.length) {
    return toast('必经选项存在重复，请删除重复项');
  }
  if (new Set(disabledOptions).size !== disabledOptions.length) {
    return toast('禁用选项存在重复，请删除重复项');
  }
  const conflictUid = requiredOptions.find((uid) => disabledOptions.includes(uid));
  if (conflictUid) {
    const catalog = pqOptionCatalog();
    const e = catalog.find((x) => x.uid === conflictUid);
    return toast(`选项「${e ? pqOptionLabel(e) : conflictUid}」不能既是必经项又是禁用项`);
  }

  try {
    const result = await api('POST', '/api/pathquery', {
      story: state.story,
      query: { targetScene, constraints, requiredOptions, disabledOptions },
    });
    state.pathQueryResult = result;
    state.pathQueryStale = false;
    renderPathQueryPanel();
  } catch (e) {
    toast(`路径查询失败：${e.message}`);
  }
}

/** 查询结果中的路径视图：场景节点带到达时状态，选项边带选择后状态 */
function buildQueryPathView(path, knownVars, found) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (path || []).forEach((node, i, arr) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      const badge = i === 0 ? '<span class="badge badge-ok">起点</span>'
        : (found && i === arr.length - 1 ? '<span class="badge badge-ok">目标</span>' : '');
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'path-edge' + (node.required ? ' is-required' : '');
      div.innerHTML = node.required
        ? `<span class="badge badge-req">必经 ${node.requiredOrder}</span> ` : '';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex + 1}「${node.optionText || ''}」 → ${node.target}`));
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  return wrap;
}

function appendQueryNotes(box, r) {
  const notes = [];
  if (r.startBlocked) {
    notes.push('起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可达状态。');
  }
  if (r.disabledCount) {
    notes.push(`已禁用 ${r.disabledCount} 个选项，本次查询不会走这些选项。`);
  }
  if (r.unknownConstraintVars && r.unknownConstraintVars.length) {
    notes.push(`约束变量 ${r.unknownConstraintVars.join('、')} 未声明且从未被赋值，在状态中恒为 false。`);
  }
  if (r.conditionErrors && r.conditionErrors.length) {
    notes.push(`剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次查询按恒真处理（详见一致性分析）。`);
  }
  for (const text of notes) {
    const div = document.createElement('div');
    div.className = 'pq-note';
    div.textContent = text;
    box.appendChild(div);
  }
}

/** 未完成必经项 chip 列表（顺序、UID、选项文案） */
function renderUnfinishedRequired(box, items) {
  if (!items || !items.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'pq-missing';
  const label = document.createElement('span');
  label.className = 'pq-missing-label';
  label.textContent = '未完成的必经选项：';
  wrap.appendChild(label);
  for (const it of items) {
    const chip = document.createElement('code');
    chip.className = 'pq-missing-chip';
    chip.textContent = `#${it.order} ${it.sceneId}#${it.optionIndex + 1}「${it.text || '（无文案）'}」`;
    wrap.appendChild(chip);
  }
  box.appendChild(wrap);
}

function renderPathQueryResult() {
  const box = $('pqResult');
  box.innerHTML = '';
  const r = state.pathQueryResult;
  if (!r || !state.story) return;

  const banner = document.createElement('div');
  if (r.found) {
    banner.className = 'pq-banner pq-ok';
    const reqTxt = r.requiredCount ? `，并依次经过全部 ${r.requiredCount} 个必经选项` : '';
    banner.textContent = `✓ 找到最短选项链（${r.depth} 步），到达「${r.targetScene}」时满足全部约束${reqTxt}`;
    box.appendChild(banner);
    appendQueryNotes(box, r);
    box.appendChild(buildQueryPathView(r.path, r.knownVars, true));
    return;
  }

  banner.className = 'pq-banner ' + (r.canAssertUnsolvable ? 'pq-err' : 'pq-warn');
  banner.textContent = r.canAssertUnsolvable
    ? `✗ 无解：已穷举全部 ${r.statesExplored} 个可达状态，不存在满足约束与必经顺序的到达状态`
    : `⚠ 未找到满足约束与必经顺序的到达状态；状态数达到上限（已探索 ${r.statesExplored} 个）搜索被截断，不能断言无解`;
  box.appendChild(banner);
  appendQueryNotes(box, r);
  renderUnfinishedRequired(box, r.unfinishedRequiredOptions);

  const c = r.closest;
  if (!c) return;

  const head = document.createElement('div');
  head.className = 'pq-closest-head';
  const lead = document.createElement('b');
  lead.textContent = '差异最少的可达状态';
  const desc = document.createElement('span');
  desc.textContent = c.isTargetScene
    ? `：目标场景「${c.sceneId}」第 ${c.depth} 步的到达状态`
    : `：目标场景「${r.targetScene}」不可达；全剧情中最接近约束的是场景「${c.sceneId}」（第 ${c.depth} 步）`;
  head.append(lead, desc);
  box.appendChild(head);

  if (c.missing && c.missing.length) {
    const miss = document.createElement('div');
    miss.className = 'pq-missing';
    const label = document.createElement('span');
    label.className = 'pq-missing-label';
    label.textContent = '缺失变量：';
    miss.appendChild(label);
    for (const m of c.missing) {
      const chip = document.createElement('code');
      chip.className = 'pq-missing-chip';
      chip.textContent = `${m.variable} 需 ${m.want}（实际 ${m.actual}）`;
      miss.appendChild(chip);
    }
    box.appendChild(miss);
  }
  renderUnfinishedRequired(box, c.unfinishedRequiredOptions);
  if (!(c.missing && c.missing.length) && (!c.unfinishedRequiredOptions || !c.unfinishedRequiredOptions.length)) {
    const okNote = document.createElement('div');
    okNote.className = 'pq-note';
    okNote.textContent = '该状态下全部约束均满足，但它不在目标场景上——请检查通往目标场景的跳转。';
    box.appendChild(okNote);
  }
  box.appendChild(buildQueryPathView(c.path, r.knownVars, false));
}

/* ============================================================
 * 结局概率推演
 * ============================================================ */
function markProbabilityStale() {
  if (!state.probResult) return;
  state.probStale = true;
  const el = $('probStale');
  if (el) el.hidden = false;
}

async function runProbability() {
  if (!state.story) return;
  try {
    // 对编辑中的草稿直接推演（不落盘）
    state.probResult = await api('POST', '/api/probability', state.story);
    state.probStale = false;
    renderProbabilityPanel();
  } catch (e) {
    toast(`推演失败：${e.message}`);
  }
}

function renderProbabilityPanel() {
  const card = $('probCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;
  $('probStale').hidden = !state.probStale;
  renderProbabilityResult();
}

function fmtPct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

/** 单条概率行：名称 + 百分比 + 概率条 */
function buildProbRow(nameHtml, pct, barCls) {
  const row = document.createElement('div');
  row.className = 'prob-row';
  row.innerHTML = `
    <div class="prob-row-head">
      <span class="prob-name"></span>
      <span class="prob-pct">${fmtPct(pct)}</span>
    </div>
    <div class="prob-bar"><div class="prob-bar-fill ${barCls}" style="width:${Math.min(100, Math.max(0, pct * 100))}%"></div></div>
  `;
  row.querySelector('.prob-name').innerHTML = nameHtml;
  return row;
}

function renderProbabilityResult() {
  const box = $('probResult');
  box.innerHTML = '';
  const r = state.probResult;
  if (!r || !state.story) return;

  const banner = document.createElement('div');

  if (r.startBlocked) {
    banner.className = 'pq-banner pq-err';
    banner.textContent = '✗ 起点场景的前置条件在初始状态下不成立，剧情无法开始，没有可推演的概率。';
    box.appendChild(banner);
    return;
  }

  if (!r.ok) {
    banner.className = 'pq-banner pq-warn';
    banner.textContent = `⚠ ${r.message}`;
    box.appendChild(banner);
    return;
  }

  banner.className = 'pq-banner pq-ok';
  banner.textContent = `✓ ${r.message}`;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次推演按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  // 终止场景（设计结局 / 死局）
  const endLabel = document.createElement('div');
  endLabel.className = 'prob-section-label';
  endLabel.textContent = `终止场景（合计 ${fmtPct(r.totalEndingProbability)}）`;
  box.appendChild(endLabel);

  if (!r.endings.length) {
    const none = document.createElement('div');
    none.className = 'pq-note';
    none.textContent = '没有任何可到达的终止场景——全部概率质量都困在循环中。';
    box.appendChild(none);
  } else {
    for (const e of r.endings) {
      const kindBadge = e.kind === 'ending'
        ? '<span class="badge badge-ok">结局</span>'
        : '<span class="badge badge-warn">死局</span>';
      const statesTxt = e.states > 1 ? `（${e.states} 个状态）` : '';
      const row = buildProbRow(
        `${kindBadge}<span class="prob-title"></span><code class="prob-id"></code><span class="prob-states">${statesTxt}</span>`,
        e.probability,
        e.kind === 'ending' ? 'fill-ok' : 'fill-warn');
      row.querySelector('.prob-title').textContent = e.title || e.sceneId;
      row.querySelector('.prob-id').textContent = e.sceneId;
      if (e.kind === 'deadend') {
        row.title = '该场景存在没有任何可走选项的状态（选项条件不成立 / 目标不可进入），玩家会卡死在这里';
      }
      box.appendChild(row);
    }
  }

  // 永远困在循环中的概率质量
  const loopLabel = document.createElement('div');
  const loopLabelText = `永远困在循环中（合计 ${fmtPct(r.loopProbability)}）`;
  loopLabel.className = 'prob-section-label';
  loopLabel.textContent = loopLabelText;
  box.appendChild(loopLabel);

  if (!r.loops.length) {
    const none = document.createElement('div');
    none.className = 'pq-note';
    none.textContent = '不存在陷阱循环：从起点出发，概率 1 最终到达某个终止场景。';
    box.appendChild(none);
  } else {
    for (const loop of r.loops) {
      const row = buildProbRow(
        `<span class="badge badge-err">循环</span><span class="prob-loop-scenes"></span><span class="prob-states">（${loop.states} 个状态）</span>`,
        loop.probability,
        'fill-err');
      const scenesBox = row.querySelector('.prob-loop-scenes');
      scenesBox.textContent = loop.scenes.map((s) => `${s.title || s.id}(${s.id})`).join(' ⇄ ');
      row.title = '进入这组场景状态后没有任何出路，这部分概率质量永远困在循环里';
      box.appendChild(row);
    }
  }
}

/* ============================================================
 * 结局必经抉择
 * ============================================================ */
function markForcedStale() {
  if (!state.fcResult) return;
  state.fcStale = true;
  const el = $('fcStale');
  if (el) el.hidden = false;
}

async function runForcedChoices() {
  if (!state.story) return;
  try {
    // 对编辑中的未保存草稿直接分析（不落盘）
    state.fcResult = await api('POST', '/api/forced-choice', state.story);
    state.fcStale = false;
    state.fcBypasses = {};
    renderForcedPanel();
  } catch (e) {
    toast(`必经抉择分析失败：${e.message}`);
  }
}

/** 请求一条绕开指定选项仍到达该结局的反例路线（仅非必经选项能找到） */
async function runForcedBypass(sceneId, uid) {
  if (!state.story || !state.fcResult) return;
  const slot = state.fcBypasses[sceneId] || {};
  state.fcBypasses[sceneId] = { ...slot, [uid]: { uid, result: null, loading: true, error: null, token: 0 } };
  const entry = state.fcBypasses[sceneId][uid];
  renderForcedResult();
  try {
    const result = await api('POST', '/api/forced-choice/bypass', {
      story: state.story, endingScene: sceneId, uid,
    });
    if (state.fcBypasses[sceneId] && state.fcBypasses[sceneId][uid] === entry) {
      entry.result = result;
      entry.loading = false;
    }
  } catch (e) {
    if (state.fcBypasses[sceneId] && state.fcBypasses[sceneId][uid] === entry) {
      entry.error = e.message;
      entry.loading = false;
    }
  }
  renderForcedResult();
}

function toggleForcedBypass(sceneId, uid) {
  const slot = state.fcBypasses[sceneId];
  if (slot && slot._openUid === uid) {
    delete slot._openUid;
    renderForcedResult();
    return;
  }
  state.fcBypasses[sceneId] = { ...(slot || {}), _openUid: uid };
  renderForcedResult();
  runForcedBypass(sceneId, uid);
}

function renderForcedPanel() {
  const card = $('fcCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;
  $('fcStale').hidden = !state.fcStale;
  renderForcedResult();
}

/** 必经路径视图：复用通用路径样式，必经选项边高亮并标注次序 */
function buildForcedPathView(path, knownVars, forcedOrderByUid) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (path || []).forEach((node, i, arr) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      const badge = i === 0 ? '<span class="badge badge-ok">起点</span>'
        : (i === arr.length - 1 ? '<span class="badge badge-err">结局</span>' : '');
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      const uid = node.optionUid || (node.fromSceneId != null && node.optionIndex != null
        ? `idx:${node.fromSceneId}#${node.optionIndex}` : null);
      const order = forcedOrderByUid && uid ? forcedOrderByUid.get(uid) : null;
      div.className = 'path-edge' + (order ? ' is-required' : '');
      div.innerHTML = order ? `<span class="badge badge-req">必经 ${order}</span> ` : '';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex != null ? node.optionIndex + 1 : '?'}「${node.optionText || ''}」 → ${node.target}`));
      if (uid) {
        const code = document.createElement('code');
        code.className = 'cov-uid';
        code.textContent = uid;
        div.appendChild(code);
      }
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  return wrap;
}

function renderForcedResult() {
  const box = $('fcResult');
  box.innerHTML = '';
  const r = state.fcResult;
  if (!r || !state.story) return;

  const banner = document.createElement('div');
  if (r.startBlocked) {
    banner.className = 'pq-banner pq-err';
    banner.textContent = '✗ 起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可达结局。';
    box.appendChild(banner);
    return;
  }

  banner.className = 'pq-banner ' + (r.canAssertForced ? 'pq-ok' : 'pq-warn');
  banner.textContent = (r.canAssertForced ? '✓ ' : '⚠ ') + r.message;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次分析按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.innerHTML = `
    <div class="stat"><span>可达终止场景</span><b>${r.counts.endings}</b></div>
    <div class="stat"><span>必经抉择（结局×选项）</span><b>${r.counts.forcedOptions === null ? '—' : r.counts.forcedOptions}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${r.counts.states}</b></div>
    <div class="stat ${r.canAssertForced ? 'stat-ok' : 'stat-warn'}"><span>结论可靠性</span><b>${r.canAssertForced ? '完整穷举' : '已截断'}</b></div>
  `;
  box.appendChild(stats);

  if (!r.endings.length) {
    const none = document.createElement('div');
    none.className = 'pq-note';
    none.textContent = '没有任何可到达的终止场景——所有路线都困在循环中。';
    box.appendChild(none);
    return;
  }

  for (const e of r.endings) {
    box.appendChild(buildForcedEndingCard(e, r));
  }
}

function buildForcedEndingCard(e, r) {
  const det = document.createElement('details');
  det.className = 'cov-route fc-ending';
  det.open = true;
  const kindBadge = e.kind === 'ending'
    ? '<span class="badge badge-ok">设计结局</span>'
    : '<span class="badge badge-warn">死局软锁</span>';
  const reliableBadge = e.reliable ? '' : '<span class="badge badge-warn">截断·结论不可靠</span>';
  const statesTxt = e.states > 1 ? `<span class="badge badge-muted">${e.states} 个终止状态</span>` : '';
  const sum = document.createElement('summary');
  sum.innerHTML = `<span class="fc-end-title"></span><code class="fc-end-id"></code>`
    + `${kindBadge}${reliableBadge}${statesTxt}`
    + `<span class="badge ${e.forcedCount ? 'badge-req' : 'badge-muted'} fc-count-badge"></span>`;
  sum.querySelector('.fc-end-title').textContent = e.title || e.sceneId;
  sum.querySelector('.fc-end-id').textContent = e.sceneId;
  sum.querySelector('.fc-count-badge').textContent = e.forcedCount === null
    ? '必经：未知（截断）' : `必经 ${e.forcedCount} 项`;
  det.appendChild(sum);

  const body = document.createElement('div');
  body.className = 'cov-route-body';

  if (!e.reliable) {
    // 截断：该结局不下任何必经 / 非必经结论
    const warn = document.createElement('div');
    warn.className = 'pq-banner pq-warn';
    warn.textContent = '状态图展开达到上限被截断，未探索区域可能存在其他到达路线，该结局的必经选项结论不可靠，已隐藏必经列表与反例请求；请减少变量数量后重新分析。';
    body.appendChild(warn);
    det.appendChild(body);
    return det;
  }

  // 必经选项（按路线先后次序）
  const forcedLabel = document.createElement('div');
  forcedLabel.className = 'cov-section-label';
  forcedLabel.textContent = e.forcedCount
    ? `所有到达路线共同经过的选项（按路线先后，${e.forcedCount} 项）`
    : '必经选项（0 项）';
  body.appendChild(forcedLabel);

  if (!e.forcedCount) {
    const none = document.createElement('div');
    none.className = 'pq-note';
    none.textContent = '不存在必选选项：每个选项都能被某条到达路线绕开（或结局就在起点）。可任选下方任一选项请求绕开反例。';
    body.appendChild(none);
  } else {
    const chain = document.createElement('div');
    chain.className = 'fc-chain';
    e.forcedOptions.forEach((f, idx) => {
      const step = document.createElement('div');
      step.className = 'fc-chain-step';
      step.innerHTML = `<span class="fc-order">${f.order}</span>
        <code class="cov-uid"></code>
        <span class="fc-opt-loc"></span>`;
      step.querySelector('.cov-uid').textContent = f.uid;
      step.querySelector('.fc-opt-loc').textContent =
        `${f.sceneId}#${f.optionIndex != null ? f.optionIndex + 1 : '?'}「${f.text || '（无文案）'}」→ ${f.target || '（不跳转）'}`;
      chain.appendChild(step);
      if (idx < e.forcedOptions.length - 1) {
        const arrow = document.createElement('span');
        arrow.className = 'fc-chain-arrow';
        arrow.textContent = '↓';
        chain.appendChild(arrow);
      }
    });
    body.appendChild(chain);
  }

  // 最短见证路径
  const witLabel = document.createElement('div');
  witLabel.className = 'cov-section-label';
  witLabel.textContent = `首次到达的最短见证路径（${e.witnessDepth} 步）`;
  body.appendChild(witLabel);
  const orderByUid = new Map((e.forcedOptions || []).map((f) => [f.uid, f.order]));
  body.appendChild(buildForcedPathView(e.witnessPath, r.knownVars, orderByUid));

  // 绕开反例：该结局可达子图上的非必经选项都可请求（默认候选）；
  // 必经项也允许尝试，服务端会返回“完整穷举后仍不可绕开”作为验证。
  const candidateUids = [];
  const candidateMeta = new Map();
  for (const f of e.forcedOptions || []) {
    candidateUids.push(f.uid);
    candidateMeta.set(f.uid, f);
  }
  for (const c of e.candidateOptions || []) {
    candidateUids.push(c.uid);
    candidateMeta.set(c.uid, c);
  }
  if (candidateUids.length) {
    const bpLabel = document.createElement('div');
    bpLabel.className = 'cov-section-label';
    bpLabel.textContent = '绕开反例：选择一个选项，请求不经过它仍到达该结局的最短路线';
    body.appendChild(bpLabel);

    const pickRow = document.createElement('div');
    pickRow.className = 'fc-bypass-row';
    const sel = document.createElement('select');
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '（选择要绕开的选项）';
    sel.appendChild(ph);
    for (const uid of candidateUids) {
      const m = candidateMeta.get(uid) || {};
      const forced = orderByUid.has(uid);
      const opt = document.createElement('option');
      opt.value = uid;
      const loc = m.sceneId
        ? `${forced ? '［必经·应无反例］' : '［非必经］'} ${m.sceneId}#${m.optionIndex != null ? m.optionIndex + 1 : '?'}「${m.text || ''}」`
        : uid;
      opt.textContent = loc;
      sel.appendChild(opt);
    }
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = '🔍 请求绕开路线';
    btn.addEventListener('click', () => {
      if (!sel.value) return toast('请先选择要绕开的选项');
      toggleForcedBypass(e.sceneId, sel.value);
    });
    pickRow.append(sel, btn);
    body.appendChild(pickRow);

    const slot = state.fcBypasses[e.sceneId];
    if (slot && slot._openUid) {
      const entry = slot[slot._openUid];
      const bpBox = document.createElement('div');
      bpBox.className = 'fc-bypass-result';
      if (entry && entry.loading) {
        bpBox.className = 'pq-note';
        bpBox.textContent = '正在搜索绕开路线……';
      } else if (entry && entry.error) {
        const err = document.createElement('div');
        err.className = 'pq-banner pq-err';
        err.textContent = `绕开查询失败：${entry.error}`;
        bpBox.appendChild(err);
      } else if (entry && entry.result) {
        bpBox.appendChild(buildForcedBypassView(entry.result, r.knownVars));
      }
      body.appendChild(bpBox);
    }
  }

  det.appendChild(body);
  return det;
}

function buildForcedBypassView(b, knownVars) {
  const frag = document.createDocumentFragment();
  const banner = document.createElement('div');
  if (b.found) {
    banner.className = 'pq-banner pq-ok';
    banner.textContent = `✓ ${b.message}`;
  } else {
    banner.className = b.canAssertUnavoidable ? 'pq-banner pq-err' : 'pq-banner pq-warn';
    banner.textContent = (b.canAssertUnavoidable ? '✗ ' : '⚠ ') + b.message;
  }
  frag.appendChild(banner);
  if (b.found && b.path) {
    // 反例路径中被绕开的选项不应出现（防御性断言，正常必然成立）
    frag.appendChild(buildForcedPathView(b.path, knownVars, null));
  }
  return frag;
}

/* ============================================================
 * 选项覆盖路线
 * ============================================================ */
function markCoverageStale() {
  if (!state.covResult) return;
  state.covStale = true;
  const el = $('covStale');
  if (el) el.hidden = false;
  // 正在逐步回放时，用最新草稿防抖重算（回放只读草稿，不会保存或修改它）
  scheduleCoverageReplayRefresh();
}

/**
 * 路线中稳定选项 UID 序列（从路线快照的选项边逐条提取）：
 * 优先 optionUid；旧数据缺失时用与分析器一致的 idx:场景#下标 兜底
 * （保留循环路线中同一选项的多次出现，不能直接用去重后的 covers）。
 */
function routeOptionUids(route) {
  return (route.path || [])
    .filter((n) => n.kind === 'option')
    .map((n) => n.optionUid || (n.fromSceneId != null && n.optionIndex != null
      ? `idx:${n.fromSceneId}#${n.optionIndex}` : null))
    .filter(Boolean);
}

function resetCoverageReplay() {
  if (state.covReplayTimer) { clearTimeout(state.covReplayTimer); state.covReplayTimer = null; }
  state.covReplay = null;
}

async function runCoverage() {
  if (!state.story) return;
  try {
    // 对编辑中的草稿直接生成（不落盘）
    state.covResult = await api('POST', '/api/coverage', state.story);
    state.covStale = false;
    resetCoverageReplay();
    renderCoveragePanel();
  } catch (e) {
    toast(`生成覆盖路线失败：${e.message}`);
  }
}

/** 开始 / 结束某条路线的逐步回放 */
async function toggleCoverageReplay(routeIndex) {
  if (!state.covResult) return;
  if (state.covReplay && state.covReplay.routeIndex === routeIndex) {
    resetCoverageReplay();
    renderCoverageResult();
    return;
  }
  const route = state.covResult.routes[routeIndex];
  if (!route) return;
  const uids = routeOptionUids(route);
  if (!uids.length) { toast('该路线没有可回放的选项'); return; }
  state.covReplay = { routeIndex, uids, result: null, loading: true, cursor: 0, error: null, reqToken: 0 };
  renderCoverageResult();
  await refreshCoverageReplay();
}

async function refreshCoverageReplay() {
  const replay = state.covReplay;
  if (!replay || !state.covResult) return;
  const route = state.covResult.routes[replay.routeIndex];
  if (!route) { resetCoverageReplay(); renderCoverageResult(); return; }
  const token = ++replay.reqToken;
  replay.loading = true;
  replay.error = null;
  renderCoverageResult();
  try {
    const result = await api('POST', '/api/coverage/replay', {
      story: state.story,
      route: { options: replay.uids, path: route.path },
    });
    // 期间又编辑 / 切剧情 / 发起了更新的请求：丢弃本次过期响应
    if (state.covReplay !== replay || token !== replay.reqToken) return;
    replay.result = result;
  } catch (e) {
    if (state.covReplay !== replay || token !== replay.reqToken) return;
    replay.result = null;
    replay.error = e.message;
  } finally {
    if (state.covReplay === replay && token === replay.reqToken) {
      replay.loading = false;
      replay.cursor = effectiveReplayCursor(replay);
      renderCoverageResult();
    }
  }
}

/**
 * 回放游标：默认停在“已通过的最后一步”；草稿变化导致更靠前的步骤出现分歧时，
 * 服务端返回的首个分歧点更早，游标回退到该分歧点，不会越过分歧继续。
 */
function effectiveReplayCursor(replay) {
  const r = replay.result;
  if (!r) return replay.cursor || 0;
  if (r.divergence && r.divergence.atStep !== undefined) {
    return Math.min(replay.cursor || 0, r.divergence.atStep);
  }
  return Math.min(replay.cursor || 0, r.total);
}

function scheduleCoverageReplayRefresh() {
  if (!state.covReplay) return;
  if (state.covReplayTimer) clearTimeout(state.covReplayTimer);
  state.covReplayTimer = setTimeout(() => {
    state.covReplayTimer = null;
    refreshCoverageReplay();
  }, 400);
}

/** 「下一步」：基于当前草稿重新校验整条路线后再前进一步 */
async function replayStepForward() {
  const replay = state.covReplay;
  if (!replay) return;
  const r = replay.result;
  if (!r || r.divergence || r.completed) return;
  if (replay.cursor >= r.total) return;
  replay.cursor = effectiveReplayCursor(replay) + 1;
  // 用上一次响应即时渲染，再用当前草稿重新校验（若草稿又变了，仍停在首个分歧点）
  renderCoverageResult();
  await refreshCoverageReplay();
}

function replayStepBack() {
  const replay = state.covReplay;
  if (!replay) return;
  replay.cursor = Math.max(0, (replay.cursor || 0) - 1);
  renderCoverageResult();
}

/** 分歧点的一键重新生成覆盖路线（同样不落盘、不修改草稿） */
async function replayRegenerate() {
  await runCoverage();
  toast('已按当前草稿重新生成覆盖路线');
}

function renderCoveragePanel() {
  const card = $('covCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;
  $('covStale').hidden = !state.covStale;
  renderCoverageResult();
}

const COV_REASON_BADGE = {
  unreachableScene: '<span class="badge badge-muted">场景不可达</span>',
  orphan: '<span class="badge badge-err">悬空跳转</span>',
  neverTrue: '<span class="badge badge-warn">条件恒假</span>',
  blockedEntry: '<span class="badge badge-err">入口受阻</span>',
};

/** 选项 UID chip 行（新覆盖 / 路线覆盖 / 未计入分母） */
function covUidChips(label, uids, cls) {
  const wrap = document.createElement('div');
  wrap.className = 'cov-uids';
  const lab = document.createElement('span');
  lab.className = 'cov-uids-label';
  lab.textContent = label;
  wrap.appendChild(lab);
  for (const uid of uids) {
    const chip = document.createElement('code');
    chip.className = 'cov-uid' + (cls ? ` ${cls}` : '');
    chip.textContent = uid;
    wrap.appendChild(chip);
  }
  return wrap;
}

/** 路线视图：场景节点带到达时状态，选项边带 UID 与选择后状态 */
function buildCoveragePathView(path, knownVars) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (path || []).forEach((node, i) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      const badge = i === 0 ? '<span class="badge badge-ok">起点</span>' : '';
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'path-edge';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex + 1}「${node.optionText || ''}」 → ${node.target}`));
      if (node.optionUid) {
        const uid = document.createElement('code');
        uid.className = 'cov-uid';
        uid.textContent = node.optionUid;
        div.appendChild(uid);
      }
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  return wrap;
}

/* ---------- 逐步回放控制台 ---------- */

const REPLAY_REASON_META = {
  startSceneChanged: { label: '起点变化', cls: 'err' },
  startBlocked: { label: '起点前置不成立', cls: 'err' },
  optionMoved: { label: '选项已移位', cls: 'err' },
  uidMissing: { label: 'UID 缺失', cls: 'err' },
  conditionFalse: { label: '选项条件不成立', cls: 'warn' },
  orphanTarget: { label: '悬空跳转', cls: 'err' },
  targetChanged: { label: '跳转目标已改变', cls: 'warn' },
  blockedEntry: { label: '目标前置不成立', cls: 'err' },
  stateMismatch: { label: '状态不一致', cls: 'warn' },
};

/** 期望 / 实际变量对照表（仅列出取值不同的变量） */
function replayStateDiffTable(diffs) {
  const wrap = document.createElement('div');
  wrap.className = 'rp-diff-table';
  if (!diffs || !diffs.length) return wrap;
  const head = document.createElement('div');
  head.className = 'rp-diff-row rp-diff-head';
  head.innerHTML = '<span>变量</span><span>路线期望</span><span>草稿实际</span>';
  wrap.appendChild(head);
  for (const d of diffs) {
    const row = document.createElement('div');
    row.className = 'rp-diff-row';
    row.innerHTML = `<code class="rp-diff-var"></code>
      <span class="rp-diff-val ${d.expected ? 'vtrue' : 'vfalse'}"></span>
      <span class="rp-diff-val ${d.actual ? 'vtrue' : 'vfalse'}"></span>`;
    row.querySelector('.rp-diff-var').textContent = d.variable;
    const vals = row.querySelectorAll('.rp-diff-val');
    vals[0].textContent = String(d.expected);
    vals[1].textContent = String(d.actual);
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * 回放轨迹：起点 -> 已走过的选项 -> 当前停留场景；分歧边标红。
 * 场景节点由服务端 trace.start / trace.end 与每条成功边的 stateAfter 还原。
 */
function buildReplayTracedPath(replay, knownVars) {
  const r = replay.result;
  if (!r) return document.createDocumentFragment();
  const wrap = document.createElement('div');
  wrap.className = 'path-view rp-path';

  const sceneNode = (node, extraCls) => {
    const div = document.createElement('div');
    div.className = 'path-node scene' + (extraCls ? ` ${extraCls}` : '');
    div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>`;
    div.querySelector('.pn-title').textContent = node.title || node.sceneId;
    div.querySelector('.pn-id').textContent = node.sceneId;
    div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
    wrap.appendChild(div);
  };

  const edgeNode = (step, isDiv, reasonLabel) => {
    const div = document.createElement('div');
    div.className = 'path-edge' + (isDiv ? ' broken' : '');
    const tgt = step.target || step.expectedTarget || '';
    div.appendChild(document.createTextNode(
      `${isDiv ? '⛔ ' : ''}选项「${step.text || '（无文案）'}」${tgt ? ' → ' + tgt : ''}`));
    const uid = document.createElement('code');
    uid.className = 'cov-uid';
    uid.textContent = step.uid;
    div.appendChild(uid);
    if (isDiv) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-err';
      badge.textContent = reasonLabel || '分歧';
      div.appendChild(badge);
    }
    wrap.appendChild(div);
  };

  const start = r.trace.start;
  sceneNode(start, start.diverged ? 'blocked' : 'start');

  const cursor = effectiveReplayCursor(replay);
  for (let i = 0; i < r.trace.steps.length && i < cursor; i++) {
    const step = r.trace.steps[i];
    const isDiv = step.status === 'diverged' && r.divergence && r.divergence.index === i;
    const reasonLabel = isDiv
      ? (REPLAY_REASON_META[r.divergence.reason] || { label: '分歧' }).label
      : '';
    edgeNode(step, isDiv, reasonLabel);
    // 成功边之后补上到达的目标场景节点；最后到达的即“当前场景”
    if (!isDiv && step.status === 'ok') {
      sceneNode({
        sceneId: step.target,
        title: step.targetTitle || step.target,
        state: step.stateAfter,
      }, i + 1 === cursor ? 'rp-current' : '');
    }
  }

  // 分歧发生在尚未前进的下一步（如 UID 缺失 / 条件翻假）：单独画出该分歧边
  if (r.divergence && r.divergence.index >= 0 && r.divergence.index >= cursor) {
    const step = r.trace.steps[r.divergence.index];
    if (step) {
      edgeNode(step, true, (REPLAY_REASON_META[r.divergence.reason] || { label: '分歧' }).label);
    }
  }

  // 已完成时的终点
  if (r.completed && cursor >= r.total && r.trace.end) {
    sceneNode(r.trace.end, 'rp-current');
  }
  return wrap;
}

/** 当前场景处可选的下一步（回放 UID）信息 */
function buildNextStepBox(replay) {
  const r = replay.result;
  const box = document.createElement('div');
  box.className = 'rp-next';
  if (!r) return box;
  if (r.completed) {
    box.innerHTML = '<span class="badge badge-ok">回放完成</span> 已按路线走完全部选项。';
    return box;
  }
  if (r.divergence) {
    box.innerHTML = '<span class="muted">回放已停在首个分歧点，无法继续前进。</span>';
    return box;
  }
  const idx = replay.cursor;
  if (idx >= r.total) {
    box.innerHTML = '<span class="badge badge-ok">回放完成</span>';
    return box;
  }
  const step = r.trace.steps[idx];
  const uid = replay.uids[idx];
  box.innerHTML = `<span class="rp-next-label">下一步（${idx + 1} / ${r.total}）</span>`;
  const code = document.createElement('code');
  code.className = 'cov-uid';
  code.textContent = uid;
  box.appendChild(code);
  if (step) {
    const txt = document.createElement('div');
    txt.className = 'rp-next-text';
    txt.textContent = `选项「${step.text || '（无文案）'}」→ ${step.expectedTarget || step.target || '（不跳转）'}`;
    box.appendChild(txt);
    if (step.conditionRaw) {
      const cond = document.createElement('div');
      cond.className = 'rp-next-cond';
      cond.textContent = `显示条件：${step.conditionRaw}`;
      box.appendChild(cond);
    }
  } else {
    const txt = document.createElement('div');
    txt.className = 'rp-next-text muted';
    txt.textContent = '（该 UID 尚未在草稿中定位，点击下一步进行校验）';
    box.appendChild(txt);
  }
  return box;
}

/** 分歧面板：原因 + 期望/实际 + 一键重新生成 */
function buildDivergenceBox(replay) {
  const r = replay.result;
  if (!r || !r.divergence) return null;
  const d = r.divergence;
  const meta = REPLAY_REASON_META[d.reason] || { label: d.reason, cls: 'err' };

  const wrap = document.createElement('div');
  wrap.className = 'rp-divergence';
  const head = document.createElement('div');
  head.className = 'rp-div-head';
  head.innerHTML = `<span class="badge ${meta.cls === 'err' ? 'badge-err' : 'badge-warn'}"></span>
    <span class="rp-div-title"></span>`;
  const stepText = d.atStep !== undefined ? `（第 ${d.atStep} 步）` : '';
  head.querySelector('.badge').textContent = meta.label;
  head.querySelector('.rp-div-title').textContent = d.message + stepText;
  wrap.appendChild(head);

  // UID / 场景定位信息
  const locParts = [];
  if (d.uid) locParts.push(`UID <code>${d.uid}</code>`);
  if (d.sceneId) locParts.push(`场景 <code>${d.sceneId}</code>`);
  if (d.target) locParts.push(`目标 <code>${d.target}</code>`);
  if (locParts.length) {
    const loc = document.createElement('div');
    loc.className = 'rp-div-loc';
    loc.innerHTML = locParts.join(' · ');
    wrap.appendChild(loc);
  }

  // 期望 / 实际两栏
  const ea = document.createElement('div');
  ea.className = 'rp-ea';

  const expectedSide = document.createElement('div');
  expectedSide.className = 'rp-ea-side rp-expected';
  expectedSide.innerHTML = '<div class="rp-ea-label">路线记录（期望）</div>';
  if (!d.expected) {
    expectedSide.insertAdjacentHTML('beforeend', '<div class="muted">—</div>');
  } else {
    if (d.expected.sceneId) expectedSide.insertAdjacentHTML('beforeend', `<div>场景：<code>${d.expected.sceneId}</code></div>`);
    if (d.expected.target !== undefined) {
      expectedSide.insertAdjacentHTML('beforeend',
        `<div>目标：<code>${d.expected.target || '（不跳转）'}</code></div>`);
    }
    if (d.expected.conditionValue !== undefined) {
      expectedSide.insertAdjacentHTML('beforeend',
        `<div>选项条件：<b>${d.expected.conditionValue}</b></div>`);
    }
    if (d.condition && d.reason === 'conditionFalse') {
      expectedSide.insertAdjacentHTML('beforeend', `<div class="rp-ea-cond">条件表达式：<code></code></div>`);
      expectedSide.querySelector('.rp-ea-cond code').textContent = d.condition;
    }
    if (d.expected.state) expectedSide.insertAdjacentHTML('beforeend', stateChips(d.expected.state, r.knownVars));
  }

  const actualSide = document.createElement('div');
  actualSide.className = 'rp-ea-side rp-actual';
  actualSide.innerHTML = '<div class="rp-ea-label">当前草稿（实际）</div>';
  if (d.actual === null || d.actual === undefined) {
    actualSide.insertAdjacentHTML('beforeend', '<div class="muted">不存在（UID 已缺失 / 选项已被删除）</div>');
  } else {
    if (d.actual.sceneId) actualSide.insertAdjacentHTML('beforeend', `<div>场景：<code>${d.actual.sceneId}</code></div>`);
    if (d.actual.target !== undefined) {
      actualSide.insertAdjacentHTML('beforeend',
        `<div>目标：<code>${d.actual.target || '（不跳转）'}</code>${
          d.actual.targetExists === false ? ' <span class="badge badge-err">场景不存在</span>' : ''
        }</div>`);
    }
    if (d.actual.conditionValue !== undefined) {
      actualSide.insertAdjacentHTML('beforeend',
        `<div>选项条件：<b class="${d.actual.conditionValue ? '' : 'rp-bad'}">${d.actual.conditionValue}</b></div>`);
    }
    if (d.actual.state) actualSide.insertAdjacentHTML('beforeend', stateChips(d.actual.state, r.knownVars));
  }

  ea.appendChild(expectedSide);
  ea.appendChild(actualSide);
  wrap.appendChild(ea);

  // 变量级差异表
  if (d.stateDiffs && d.stateDiffs.length) {
    const label = document.createElement('div');
    label.className = 'rp-ea-label';
    label.textContent = `状态差异（${d.stateDiffs.length} 个变量取值不同）`;
    wrap.appendChild(label);
    wrap.appendChild(replayStateDiffTable(d.stateDiffs));
  }

  // 未满足条件解释（选项条件 / 前置条件不成立时）
  if (d.explain) {
    const label = document.createElement('div');
    label.className = 'rp-ea-label';
    label.textContent = '未满足的条件';
    wrap.appendChild(label);
    wrap.appendChild(renderExprNode(d.explain));
  }

  // 一键重新生成
  const actions = document.createElement('div');
  actions.className = 'rp-div-actions';
  const regen = document.createElement('button');
  regen.className = 'btn btn-small btn-primary';
  regen.textContent = '↻ 按当前草稿重新生成覆盖路线';
  regen.addEventListener('click', replayRegenerate);
  actions.appendChild(regen);
  const hint = document.createElement('span');
  hint.className = 'muted rp-div-hint';
  hint.textContent = '回放只读草稿，不会保存或修改剧情；重新生成同样基于编辑中的草稿。';
  actions.appendChild(hint);
  wrap.appendChild(actions);

  return wrap;
}

function buildCoverageReplayConsole(route, knownVars) {
  const replay = state.covReplay;
  const wrap = document.createElement('div');
  wrap.className = 'rp-console';

  const head = document.createElement('div');
  head.className = 'rp-head';
  const title = document.createElement('span');
  title.className = 'rp-title';
  const r = replay.result;
  if (r) {
    const total = r.total;
    const cur = effectiveReplayCursor(replay);
    title.textContent = r.completed
      ? `逐步回放 · 已走完全部 ${total} 步`
      : (r.divergence ? `逐步回放 · 停在第 ${r.divergence.atStep} 步 / 共 ${total} 步`
        : `逐步回放 · 第 ${Math.min(cur, total)} / ${total} 步`);
  } else {
    title.textContent = '逐步回放';
  }
  head.appendChild(title);
  wrap.appendChild(head);

  if (replay.loading && !r) {
    const loading = document.createElement('div');
    loading.className = 'pq-note';
    loading.textContent = '正在用当前草稿重新校验路线……';
    wrap.appendChild(loading);
    return wrap;
  }
  if (replay.error) {
    const err = document.createElement('div');
    err.className = 'pq-banner pq-err';
    err.textContent = `回放校验失败：${replay.error}`;
    wrap.appendChild(err);
    const retryWrap = document.createElement('div');
    retryWrap.className = 'rp-div-actions';
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = '重试';
    btn.addEventListener('click', refreshCoverageReplay);
    retryWrap.appendChild(btn);
    wrap.appendChild(retryWrap);
    return wrap;
  }
  if (!r) return wrap;

  // 控制条：上一步 / 下一步 / 回到起点
  const bar = document.createElement('div');
  bar.className = 'rp-controls';
  const cursor = effectiveReplayCursor(replay);
  const blocked = !!r.divergence || r.completed;
  const mkBtn = (label, disabled, handler, primary) => {
    const b = document.createElement('button');
    b.className = 'btn btn-small' + (primary ? ' btn-primary' : '');
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener('click', handler);
    return b;
  };
  bar.appendChild(mkBtn('← 上一步', cursor <= 0, replayStepBack));
  bar.appendChild(mkBtn('下一步 →', blocked || replay.loading || cursor >= r.total, replayStepForward, true));
  bar.appendChild(mkBtn('⟲ 回到起点', cursor <= 0, () => { replay.cursor = 0; renderCoverageResult(); }));
  wrap.appendChild(bar);

  // 轨迹（同步显示当前场景与变量状态）
  wrap.appendChild(buildReplayTracedPath(replay, knownVars));

  // 下一步选项（未分歧、未完成时）
  if (!blocked && cursor < r.total) wrap.appendChild(buildNextStepBox(replay));

  // 条件语法错误提示（按恒真处理）
  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `草稿中存在 ${r.conditionErrors.length} 处条件语法错误，回放按恒真处理（详见一致性分析）。`;
    wrap.appendChild(note);
  }

  // 分歧面板（期望/实际状态、原因、一键重新生成）
  const divBox = buildDivergenceBox(replay);
  if (divBox) wrap.appendChild(divBox);

  return wrap;
}

function renderCoverageResult() {
  const box = $('covResult');
  box.innerHTML = '';
  const r = state.covResult;
  if (!r || !state.story) return;

  const banner = document.createElement('div');
  if (r.startBlocked) {
    banner.className = 'pq-banner pq-err';
    banner.textContent = '✗ 起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可走的选项。';
    box.appendChild(banner);
    return;
  }

  // 截断 => 结果不完整（已发现的可走选项仍被完整覆盖，但判定不可靠）
  banner.className = 'pq-banner ' + (r.complete ? 'pq-ok' : 'pq-warn');
  banner.textContent = (r.complete ? '✓ ' : '⚠ ') + r.message;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次生成按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  // 覆盖率汇总
  const stats = document.createElement('div');
  stats.className = 'stats';
  const pct = r.coverage.rate === null ? '—' : fmtPct(r.coverage.rate);
  stats.innerHTML = `
    <div class="stat ${r.complete ? 'stat-ok' : 'stat-warn'}"><span>覆盖率（可走选项）</span><b>${pct}</b></div>
    <div class="stat"><span>覆盖 / 分母</span><b>${r.coverage.covered} / ${r.coverage.coverable}</b></div>
    <div class="stat"><span>路线数</span><b>${r.counts.routes}</b></div>
    <div class="stat"><span>不计入分母</span><b>${r.counts.excluded}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${r.counts.states}</b></div>
    <div class="stat"><span>布尔变量</span><b>${r.counts.variables}</b></div>
  `;
  box.appendChild(stats);

  // 路线列表（每条路线列出选项 UID、场景与每步状态）
  const routeLabel = document.createElement('div');
  routeLabel.className = 'cov-section-label';
  routeLabel.textContent = r.routes.length
    ? `覆盖路线（${r.routes.length} 条，贪心集合覆盖压缩后）`
    : '覆盖路线（0 条）';
  box.appendChild(routeLabel);

  if (!r.routes.length) {
    const none = document.createElement('div');
    none.className = 'pq-note';
    none.textContent = '没有实际可走的选项，未生成路线。';
    box.appendChild(none);
  }

  r.routes.forEach((route, i) => {
    const det = document.createElement('details');
    det.className = 'cov-route';
    if (i === 0 || (state.covReplay && state.covReplay.routeIndex === i)) det.open = true;
    const replayActive = !!(state.covReplay && state.covReplay.routeIndex === i);
    const sum = document.createElement('summary');
    sum.innerHTML = `<span>路线 ${route.index} · ${route.depth} 步</span>`
      + `<span class="badge badge-ok">新覆盖 ${route.newlyCovered.length}</span>`
      + `<span class="badge badge-muted">共覆盖 ${route.covers.length}</span>`;
    const replayBtn = document.createElement('button');
    replayBtn.className = 'btn btn-small cov-replay-toggle' + (replayActive ? ' cov-replay-on' : '');
    replayBtn.textContent = replayActive ? '■ 结束回放' : '▶ 逐步回放';
    replayBtn.title = '按路线中的稳定选项 UID 从起点逐步前进，并用当前草稿逐步重新校验';
    replayBtn.addEventListener('click', (e) => {
      e.preventDefault(); // 不切换 details 展开状态
      toggleCoverageReplay(i);
    });
    sum.appendChild(replayBtn);
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'cov-route-body';
    if (replayActive) body.appendChild(buildCoverageReplayConsole(route, r.knownVars));
    body.appendChild(covUidChips('新覆盖选项：', route.newlyCovered, 'cov-new'));
    body.appendChild(covUidChips('路线覆盖选项：', route.covers, ''));
    body.appendChild(buildCoveragePathView(route.path, r.knownVars));
    det.appendChild(body);
    box.appendChild(det);
  });

  // 未计入分母的不可走选项
  if (r.excludedOptions && r.excludedOptions.length) {
    const label = document.createElement('div');
    label.className = 'cov-section-label';
    label.textContent = `未计入分母的不可走选项（${r.excludedOptions.length}）`;
    box.appendChild(label);
    for (const o of r.excludedOptions) {
      const row = document.createElement('div');
      row.className = 'cov-excluded';
      row.innerHTML = `${COV_REASON_BADGE[o.reason] || ''}<span class="cov-ex-loc"></span><code class="cov-uid"></code>`
        + (o.definitive ? '' : '<span class="badge badge-warn">截断前暂定</span>');
      row.querySelector('.cov-ex-loc').textContent =
        `${o.sceneId}#${o.optionIndex + 1}「${o.text || '（无文案）'}」→ ${o.target || '（不跳转）'}`;
      row.querySelector('code.cov-uid').textContent = o.uid;
      box.appendChild(row);
    }
  }
}

/* ============================================================
 * 伏笔回收路线校验
 * ============================================================ */
function fsSignature() {
  if (!state.story) return '';
  // 场景集合（ID / 标题）变化时才重建下拉行
  return JSON.stringify(state.story.scenes.map((s) => [s.id, s.title || '']));
}

function markForeshadowStale() {
  if (!state.fsResult) return;
  state.fsStale = true;
  const el = $('fsStale');
  if (el) el.hidden = false;
}

function renderForeshadowPanel() {
  const card = $('fsCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;

  // 仅当场景集合变化时才重建下拉行，避免打断正在进行的交互
  const sig = fsSignature();
  if (sig !== state._fsSig) {
    state._fsSig = sig;
    // 场景被删除 / 改名时，自动从校验条件中剔除（保留未选择的空行）
    const valid = new Set(state.story.scenes.map((s) => s.id));
    const prune = (arr) => arr.filter((id) => !id || valid.has(id));
    state.foreshadow.setups = prune(state.foreshadow.setups);
    state.foreshadow.payoffs = prune(state.foreshadow.payoffs);
    renderFsRows('setups');
    renderFsRows('payoffs');
  }

  $('fsStale').hidden = !state.fsStale;
  renderForeshadowResult();
}

/** 渲染铺垫 / 回收场景行；两组互斥（同一场景不能既铺垫又回收） */
function renderFsRows(listKey) {
  const containerId = listKey === 'setups' ? 'fsSetups' : 'fsPayoffs';
  const box = $(containerId);
  box.innerHTML = '';
  const list = state.foreshadow[listKey];
  const otherKey = listKey === 'setups' ? 'payoffs' : 'setups';

  list.forEach((sceneId, i) => {
    const row = document.createElement('div');
    row.className = 'pq-opt-row';

    const sel = document.createElement('select');
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '（选择场景）';
    sel.appendChild(ph);
    const usedSame = new Set(list.filter((x, j) => x && j !== i));
    const usedOther = new Set(state.foreshadow[otherKey].filter(Boolean));
    for (const sc of state.story.scenes) {
      const opt = document.createElement('option');
      opt.value = sc.id;
      opt.textContent = `${sc.id}${sc.title ? ' — ' + sc.title : ''}`;
      if (sc.id !== sceneId && (usedSame.has(sc.id) || usedOther.has(sc.id))) {
        opt.disabled = true;
        opt.textContent += usedOther.has(sc.id)
          ? `（已用作${otherKey === 'setups' ? '铺垫' : '回收'}）` : '（已选用）';
      }
      sel.appendChild(opt);
    }
    sel.value = sceneId || '';
    sel.addEventListener('change', () => {
      list[i] = sel.value;
      renderFsRows('setups');
      renderFsRows('payoffs');
      markForeshadowStale();
    });
    row.appendChild(sel);

    const del = document.createElement('button');
    del.className = 'pq-opt-del';
    del.textContent = '✕';
    del.title = listKey === 'setups' ? '移除铺垫场景' : '移除回收场景';
    del.addEventListener('click', () => {
      list.splice(i, 1);
      renderFsRows('setups');
      renderFsRows('payoffs');
      markForeshadowStale();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function runForeshadow() {
  if (!state.story) return;
  const setups = state.foreshadow.setups.filter(Boolean);
  const payoffs = state.foreshadow.payoffs.filter(Boolean);
  if (!setups.length) return toast('请先选择至少一个铺垫场景');
  if (!payoffs.length) return toast('请先选择至少一个回收场景');
  if (new Set(setups).size !== setups.length || new Set(payoffs).size !== payoffs.length) {
    return toast('铺垫 / 回收场景存在重复，请删除重复项');
  }
  const both = setups.filter((id) => payoffs.includes(id));
  if (both.length) return toast(`场景不能既是铺垫又是回收：${both.join('、')}`);

  try {
    // 对编辑中的未保存草稿直接校验（不落盘）
    state.fsResult = await api('POST', '/api/foreshadow', {
      story: state.story,
      query: { setups, payoffs },
    });
    state.fsStale = false;
    renderForeshadowPanel();
  } catch (e) {
    toast(`伏笔回收校验失败：${e.message}`);
  }
}

const FS_STATUS_META = {
  pass: { cls: 'pq-ok', icon: '✓' },
  violation: { cls: 'pq-err', icon: '✗' },
  truncated: { cls: 'pq-warn', icon: '⚠' },
  'setup-unreachable': { cls: 'pq-warn', icon: '⚠' },
  'no-ending': { cls: 'pq-warn', icon: '⚠' },
  'start-blocked': { cls: 'pq-err', icon: '✗' },
};

/** 违规路线视图：场景节点标注铺垫 / 回收事件与待回收状态，选项边带选择后状态 */
function buildForeshadowPathView(path, knownVars) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (path || []).forEach((node, i, arr) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      let badge = i === 0 ? '<span class="badge badge-ok">起点</span>' : '';
      if (node.foreshadow === 'setup') badge += '<span class="badge badge-warn">铺垫 · 置为待回收</span>';
      else if (node.foreshadow === 'payoff') badge += '<span class="badge badge-ok">回收 · 已清除</span>';
      if (i === arr.length - 1) badge += '<span class="badge badge-err">设计结局 · 伏笔未回收</span>';
      const pendingBadge = node.pending
        ? '<span class="badge badge-req" title="进入该场景后伏笔处于待回收状态">待回收</span>' : '';
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}${pendingBadge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'path-edge';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex + 1}「${node.optionText || ''}」 → ${node.target}`));
      if (node.optionUid) {
        const uid = document.createElement('code');
        uid.className = 'cov-uid';
        uid.textContent = node.optionUid;
        div.appendChild(uid);
      }
      if (node.pendingAfter) {
        div.insertAdjacentHTML('beforeend', '<span class="badge badge-req">待回收</span>');
      }
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  return wrap;
}

function renderForeshadowResult() {
  const box = $('fsResult');
  box.innerHTML = '';
  const r = state.fsResult;
  if (!r || !state.story) return;

  const meta = FS_STATUS_META[r.status] || { cls: 'pq-warn', icon: '⚠' };
  const banner = document.createElement('div');
  banner.className = `pq-banner ${meta.cls}`;
  banner.textContent = `${meta.icon} ${r.message}`;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次校验按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  if (r.startBlocked) return;

  // 统计
  const verdict = { pass: '通过', violation: '发现违规' }[r.status] || '无法判定';
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.innerHTML = `
    <div class="stat ${r.status === 'pass' ? 'stat-ok' : (r.status === 'violation' ? 'stat-bad' : 'stat-warn')}"><span>校验结论</span><b>${verdict}</b></div>
    <div class="stat"><span>可达设计结局</span><b>${r.endingCount}</b></div>
    <div class="stat"><span>待回收状态</span><b>${r.pendingStates}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${r.counts.states}</b></div>
    <div class="stat"><span>布尔变量</span><b>${r.counts.variables}</b></div>
  `;
  box.appendChild(stats);

  // 违规：最短违规路线（按选项步数）与沿途变量状态
  if (r.violation) {
    const label = document.createElement('div');
    label.className = 'cov-section-label';
    label.textContent = `最短违规路线（${r.violation.depth} 步，到达设计结局「${r.violation.endingTitle || r.violation.endingScene}」时伏笔仍待回收）`;
    box.appendChild(label);
    box.appendChild(buildForeshadowPathView(r.violation.path, r.knownVars));
    return;
  }

  // 无违规时的补充说明（铺垫不可达 / 无结局 / 截断 / 通过的明细）
  if (r.status === 'pass' && r.endings && r.endings.length) {
    const label = document.createElement('div');
    label.className = 'cov-section-label';
    label.textContent = `已校验的可达设计结局（${r.endings.length} 个）`;
    box.appendChild(label);
    for (const e of r.endings) {
      const row = document.createElement('div');
      row.className = 'pq-note';
      row.textContent = `${e.title || e.sceneId}（${e.sceneId}）— ${e.states} 个终止状态，到达路线均经过回收场景`;
      box.appendChild(row);
    }
  }
}

/* ============================================================
 * 节奏校验（高强度场景连续段）
 * ============================================================ */
function pacSignature() {
  if (!state.story) return '';
  // 场景集合（ID / 标题）变化时才重建勾选行
  return JSON.stringify(state.story.scenes.map((s) => [s.id, s.title || '']));
}

function markPacingStale() {
  if (!state.pacResult) return;
  state.pacStale = true;
  const el = $('pacStale');
  if (el) el.hidden = false;
}

function renderPacingPanel() {
  const card = $('pacCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;

  // 仅当场景集合变化时才重建勾选行，避免打断正在进行的交互
  const sig = pacSignature();
  if (sig !== state._pacSig) {
    state._pacSig = sig;
    // 场景被删除时，自动从校验设置中剔除
    const valid = new Set(state.story.scenes.map((s) => s.id));
    state.pacing.highIntensityScenes = state.pacing.highIntensityScenes.filter((id) => valid.has(id));
    renderPacScenes();
  }

  // 不打断正在输入的焦点；失焦（change）后由事件回调写回合法值
  const maxInput = $('pacMax');
  if (document.activeElement !== maxInput) maxInput.value = state.pacing.maxConsecutive;
  $('pacStale').hidden = !state.pacStale;
  renderPacingResult();
}

/** 渲染高强度场景勾选列表 */
function renderPacScenes() {
  const box = $('pacScenes');
  box.innerHTML = '';
  const selected = new Set(state.pacing.highIntensityScenes);
  for (const sc of state.story.scenes) {
    const label = document.createElement('label');
    label.className = 'pac-scene-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(sc.id);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!state.pacing.highIntensityScenes.includes(sc.id)) state.pacing.highIntensityScenes.push(sc.id);
      } else {
        state.pacing.highIntensityScenes = state.pacing.highIntensityScenes.filter((id) => id !== sc.id);
      }
      markPacingStale();
    });
    const span = document.createElement('span');
    span.textContent = `${sc.id}${sc.title ? ' — ' + sc.title : ''}`;
    label.append(cb, span);
    box.appendChild(label);
  }
}

async function runPacing() {
  if (!state.story) return;
  const highIntensityScenes = state.pacing.highIntensityScenes;
  const maxConsecutive = Number(state.pacing.maxConsecutive);
  if (!highIntensityScenes.length) return toast('请先勾选至少一个高强度场景');
  if (!Number.isInteger(maxConsecutive) || maxConsecutive < 1 || maxConsecutive > 10) {
    return toast('允许的最长连续场景数必须是 1～10 的整数');
  }

  try {
    // 对编辑中的未保存草稿直接校验（不落盘）
    state.pacResult = await api('POST', '/api/pacing', {
      story: state.story,
      query: { highIntensityScenes, maxConsecutive },
    });
    state.pacStale = false;
    renderPacingPanel();
  } catch (e) {
    toast(`节奏校验失败：${e.message}`);
  }
}

const PAC_STATUS_META = {
  pass: { cls: 'pq-ok', icon: '✓' },
  violation: { cls: 'pq-err', icon: '✗' },
  truncated: { cls: 'pq-warn', icon: '⚠' },
  'start-blocked': { cls: 'pq-err', icon: '✗' },
};

/** 连续计数徽标：超过允许上限标红 */
function streakBadge(streak, limit) {
  if (!streak) return '<span class="badge badge-ok">连续 0 · 已清零</span>';
  const cls = streak > limit ? 'badge-err' : 'badge-warn';
  return `<span class="badge ${cls}">连续高强度 ${streak}</span>`;
}

/** 超限路线视图：场景节点带高强度标记与连续计数，选项边带选择后的连续计数 */
function buildPacingPathView(path, knownVars, limit) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (path || []).forEach((node, i, arr) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      let badge = i === 0 ? '<span class="badge badge-ok">起点</span>' : '';
      if (node.highIntensity) badge += '<span class="badge badge-req">高强度</span>';
      if (i === arr.length - 1) badge += '<span class="badge badge-err">超限位置</span>';
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', streakBadge(node.streak, limit));
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'path-edge';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex + 1}「${node.optionText || ''}」 → ${node.target}`));
      if (node.optionUid) {
        const uid = document.createElement('code');
        uid.className = 'cov-uid';
        uid.textContent = node.optionUid;
        div.appendChild(uid);
      }
      div.insertAdjacentHTML('beforeend', streakBadge(node.streakAfter, limit));
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  return wrap;
}

function renderPacingResult() {
  const box = $('pacResult');
  box.innerHTML = '';
  const r = state.pacResult;
  if (!r || !state.story) return;

  const meta = PAC_STATUS_META[r.status] || { cls: 'pq-warn', icon: '⚠' };
  const banner = document.createElement('div');
  banner.className = `pq-banner ${meta.cls}`;
  banner.textContent = `${meta.icon} ${r.message}`;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次校验按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  if (r.startBlocked) return;

  // 统计
  const verdict = { pass: '通过', violation: '发现超限' }[r.status] || '无法判定';
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.innerHTML = `
    <div class="stat ${r.status === 'pass' ? 'stat-ok' : (r.status === 'violation' ? 'stat-bad' : 'stat-warn')}"><span>校验结论</span><b>${verdict}</b></div>
    <div class="stat"><span>允许最长连续</span><b>${r.query.maxConsecutive}</b></div>
    <div class="stat"><span>实际最长连续段</span><b>${r.maxStreak}</b></div>
    <div class="stat"><span>可达高强度场景</span><b>${r.reachedHighScenes.length} / ${r.query.highIntensityScenes.length}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${r.counts.states}</b></div>
    <div class="stat"><span>布尔变量</span><b>${r.counts.variables}</b></div>
  `;
  box.appendChild(stats);

  // 勾选了但实际不可达的高强度场景：提示作者该校验设置可能无意义
  const unreachable = r.query.highIntensityScenes
    .filter((s) => !r.reachedHighScenes.some((x) => x.sceneId === s.sceneId));
  if (unreachable.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `以下勾选的高强度场景在当前草稿中不可达（不参与任何可走路线）：${
      unreachable.map((s) => `${s.title || s.sceneId}（${s.sceneId}）`).join('、')}`;
    box.appendChild(note);
  }

  // 违规：按选项步数最短的超限路线（沿途场景、变量状态与连续计数）
  if (r.violation) {
    const label = document.createElement('div');
    label.className = 'cov-section-label';
    label.textContent = `最短超限路线（${r.violation.depth} 步，连续 ${r.violation.streak} 个高强度场景，在「${r.violation.title || r.violation.sceneId}」超过允许的 ${r.query.maxConsecutive} 个）`;
    box.appendChild(label);
    box.appendChild(buildPacingPathView(r.violation.path, r.knownVars, r.query.maxConsecutive));
  }
}

/* ============================================================
 * 结局保证到达（玩家策略求解）
 * ============================================================ */
function stgSignature() {
  if (!state.story) return '';
  // 场景集合（ID / 标题 / 选项数）变化时才重建下拉框与勾选行：
  // 选项数影响「无选项场景」集合（目标结局候选）
  return JSON.stringify(state.story.scenes.map((s) => [s.id, s.title || '', (s.options || []).length]));
}

function markStrategyStale() {
  if (!state.stgResult) return;
  state.stgStale = true;
  const el = $('stgStale');
  if (el) el.hidden = false;
}

function renderStrategyPanel() {
  const card = $('stgCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;

  // 仅当场景集合（含选项数）变化时才重建下拉框与勾选行，避免打断正在进行的交互
  const sig = stgSignature();
  if (sig !== state._stgSig) {
    state._stgSig = sig;
    // 场景被删除 / 改名时自动从设置中剔除；目标场景若变得含选项也一并清除
    const valid = new Set(state.story.scenes.map((s) => s.id));
    state.strategy.environmentScenes = state.strategy.environmentScenes.filter((id) => valid.has(id));
    const targetScene = state.story.scenes.find((s) => s.id === state.strategy.targetScene);
    if (state.strategy.targetScene && (!targetScene || (targetScene.options || []).length > 0)) {
      state.strategy.targetScene = '';
    }
    renderStgTarget();
    renderStgEnvScenes();
  }

  $('stgStale').hidden = !state.stgStale;
  renderStrategyResult();
}

/** 目标结局下拉框：仅列出无选项的场景 */
function renderStgTarget() {
  const sel = $('stgTarget');
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '（选择目标结局场景）';
  sel.appendChild(ph);
  for (const sc of state.story.scenes) {
    if ((sc.options || []).length > 0) continue; // 目标必须是无选项场景
    const opt = document.createElement('option');
    opt.value = sc.id;
    opt.textContent = `${sc.id}${sc.title ? ' — ' + sc.title : ''}`;
    sel.appendChild(opt);
  }
  sel.value = state.strategy.targetScene || '';
}

/** 环境控制场景勾选列表（未勾选的场景由玩家控制） */
function renderStgEnvScenes() {
  const box = $('stgEnvScenes');
  box.innerHTML = '';
  const selected = new Set(state.strategy.environmentScenes);
  for (const sc of state.story.scenes) {
    const label = document.createElement('label');
    label.className = 'pac-scene-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(sc.id);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!state.strategy.environmentScenes.includes(sc.id)) state.strategy.environmentScenes.push(sc.id);
      } else {
        state.strategy.environmentScenes = state.strategy.environmentScenes.filter((id) => id !== sc.id);
      }
      markStrategyStale();
    });
    const span = document.createElement('span');
    span.textContent = `${sc.id}${sc.title ? ' — ' + sc.title : ''}`;
    label.append(cb, span);
    box.appendChild(label);
  }
}

async function runStrategy() {
  if (!state.story) return;
  const targetScene = state.strategy.targetScene;
  if (!targetScene) return toast('请先选择一个目标结局场景（无选项的场景）');
  const target = state.story.scenes.find((s) => s.id === targetScene);
  if (!target || (target.options || []).length > 0) {
    return toast('目标结局必须是无选项场景，请重新选择');
  }

  try {
    // 对编辑中的未保存草稿直接求解（不落盘）
    state.stgResult = await api('POST', '/api/strategy', {
      story: state.story,
      query: { targetScene, environmentScenes: state.strategy.environmentScenes },
    });
    state.stgStale = false;
    renderStrategyPanel();
  } catch (e) {
    toast(`结局保证到达求解失败：${e.message}`);
  }
}

const STG_STATUS_META = {
  guaranteed: { cls: 'pq-ok', icon: '✓' },
  unguaranteed: { cls: 'pq-err', icon: '✗' },
  truncated: { cls: 'pq-warn', icon: '⚠' },
  'start-blocked': { cls: 'pq-err', icon: '✗' },
};

const STG_REASON_LABEL = {
  deadend: '非目标死局',
  loop: '可无限停留的循环',
  unreachable: '目标不可达',
};

/** 控制方徽标：环境 / 玩家 */
function stgControllerBadge(controller) {
  return controller === 'env'
    ? '<span class="badge badge-warn">环境</span>'
    : '<span class="badge badge-ok">玩家</span>';
}

/** 环境反制见证路线：场景节点带控制方与循环标记，选项边带选择后状态 */
function buildStrategyPathView(path, knownVars) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (path || []).forEach((node, i, arr) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      let badge = i === 0 ? '<span class="badge badge-ok">起点</span>' : '';
      badge += stgControllerBadge(node.controller);
      if (node.inCycle) badge += '<span class="badge badge-req">循环中</span>';
      if (node.terminal) badge += '<span class="badge badge-err">非目标死局 · 剧情停滞</span>';
      else if (i === arr.length - 1 && node.inCycle) badge += '<span class="badge badge-err">回到循环入口</span>';
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'path-edge';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex + 1}「${node.optionText || ''}」 → ${node.target}`));
      if (node.optionUid) {
        const uid = document.createElement('code');
        uid.className = 'cov-uid';
        uid.textContent = node.optionUid;
        div.appendChild(uid);
      }
      div.insertAdjacentHTML('beforeend', stgControllerBadge(node.controller));
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  return wrap;
}

function renderStrategyResult() {
  const box = $('stgResult');
  box.innerHTML = '';
  const r = state.stgResult;
  if (!r || !state.story) return;

  const meta = STG_STATUS_META[r.status] || { cls: 'pq-warn', icon: '⚠' };
  const banner = document.createElement('div');
  banner.className = `pq-banner ${meta.cls}`;
  banner.textContent = `${meta.icon} ${r.message}`;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次求解按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  if (r.startBlocked) return;

  // 统计
  const verdict = { guaranteed: '可保证', unguaranteed: '无法保证' }[r.status] || '无法判定';
  const verdictCls = r.status === 'guaranteed' ? 'stat-ok' : (r.status === 'unguaranteed' ? 'stat-bad' : 'stat-warn');
  const stats = document.createElement('div');
  stats.className = 'stats';
  const envCount = r.query.environmentScenes.length;
  stats.innerHTML = `
    <div class="stat ${verdictCls}"><span>求解结论</span><b>${verdict}</b></div>
    <div class="stat"><span>目标结局</span><b>${r.query.targetScene}</b></div>
    <div class="stat"><span>环境控制场景</span><b>${envCount}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${r.counts.states}</b></div>
    <div class="stat"><span>玩家 / 环境状态</span><b>${r.counts.playerStates ?? '—'} / ${r.counts.envStates ?? '—'}</b></div>
    <div class="stat"><span>布尔变量</span><b>${r.counts.variables}</b></div>
  `;
  box.appendChild(stats);

  // 可保证：起点信息 + 获胜玩家状态表（变量值、推荐选项 UID 与层级）
  if (r.status === 'guaranteed') {
    if (r.start && r.start.rank > 0) {
      const startNote = document.createElement('div');
      startNote.className = 'pq-note';
      startNote.textContent = `起点（${r.start.sceneId}）的保证层级为 ${r.start.rank}：`
        + '玩家沿推荐选项选择时，无论环境如何选择，层级每步严格下降，最坏 '
        + `${r.start.rank} 步内到达目标结局。`;
      box.appendChild(startNote);
    }

    if (r.winningStates && r.winningStates.length) {
      const label = document.createElement('div');
      label.className = 'cov-section-label';
      label.textContent = `获胜玩家状态（${r.winningStates.length} 个：变量值、推荐选项与层级；推荐均进入更低层级）`;
      box.appendChild(label);

      const det = document.createElement('details');
      det.className = 'stg-win-list';
      det.open = r.winningStates.length <= 12;
      const sum = document.createElement('summary');
      sum.textContent = `展开 / 收起全部 ${r.winningStates.length} 个获胜玩家状态`;
      det.appendChild(sum);
      const body = document.createElement('div');
      body.className = 'stg-win-body';
      for (const w of r.winningStates) {
        const row = document.createElement('div');
        row.className = 'stg-win-row';
        const head = document.createElement('div');
        head.className = 'stg-win-head';
        head.innerHTML = `<span class="stg-win-scene"></span>`
          + `<span class="badge badge-ok">层级 ${w.rank}</span>`
          + (w.sceneId === r.startScene ? '<span class="badge badge-muted">含起点状态</span>' : '');
        head.querySelector('.stg-win-scene').textContent = `${w.title || w.sceneId}（${w.sceneId}）`;
        row.appendChild(head);
        row.insertAdjacentHTML('beforeend', stateChips(w.state, r.knownVars || []));
        if (w.recommend) {
          const rec = document.createElement('div');
          rec.className = 'stg-win-rec';
          rec.innerHTML = `<span class="stg-rec-label">推荐选项</span>`
            + `<span class="stg-rec-text"></span><code class="cov-uid"></code>`
            + `<span class="stg-rec-target"></span>`
            + `<span class="badge badge-ok">→ 层级 ${w.recommend.nextRank}</span>`;
          rec.querySelector('.stg-rec-text').textContent = `「${w.recommend.text || '（无文案）'}」`;
          rec.querySelector('code.cov-uid').textContent = w.recommend.uid;
          rec.querySelector('.stg-rec-target').textContent = `→ ${w.recommend.target}`;
          row.appendChild(rec);
        }
        body.appendChild(row);
      }
      det.appendChild(body);
      box.appendChild(det);
    }
    return;
  }

  // 无法保证：失败原因 + 环境反制见证
  if (r.status === 'unguaranteed' && r.failure) {
    const f = r.failure;
    const reason = document.createElement('div');
    reason.className = 'stats';
    reason.innerHTML = `
      <div class="stat stat-bad"><span>失败原因</span><b>${STG_REASON_LABEL[f.reason] || f.reason}</b></div>
      <div class="stat"><span>目标从起点可达</span><b>${f.targetReachable ? '是' : '否'}</b></div>
    `;
    box.appendChild(reason);

    if (f.cycleScenes && f.cycleScenes.length) {
      const cyc = document.createElement('div');
      cyc.className = 'pq-note';
      cyc.textContent = `循环涉及的场景：${f.cycleScenes.map((c) => `${c.title || c.sceneId}（${c.sceneId}）`).join('、')}`
        + '——环境可让剧情在这些场景间无限绕圈，永不到达目标。';
      box.appendChild(cyc);
    }
    if (f.witnessPath && f.witnessPath.length) {
      const label = document.createElement('div');
      label.className = 'cov-section-label';
      label.textContent = f.reason === 'deadend'
        ? `环境反制路线（到达非目标死局「${f.deadendScene.title || f.deadendScene.sceneId}」后剧情停滞）`
        : '环境反制路线（进入循环后可无限停留）';
      box.appendChild(label);
      box.appendChild(buildStrategyPathView(f.witnessPath, r.knownVars));
    }
  }
}

/* ============================================================
 * 变量赋值消费审计
 * ============================================================ */
function markAssignAuditStale() {
  if (!state.aaResult) return;
  state.aaStale = true;
  const el = $('aaStale');
  if (el) el.hidden = false;
}

function renderAssignAuditPanel() {
  const card = $('aaCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;
  $('aaStale').hidden = !state.aaStale;
  renderAssignAuditResult();
}

async function runAssignAudit() {
  if (!state.story) return;
  try {
    // 对编辑中的未保存草稿直接审计（不落盘）
    state.aaResult = await api('POST', '/api/assign-audit', { story: state.story });
    state.aaStale = false;
    renderAssignAuditPanel();
  } catch (e) {
    toast(`变量赋值消费审计失败：${e.message}`);
  }
}

const AA_STATUS_META = {
  consumed: { cls: 'badge-ok', label: '已消费' },
  unconsumed: { cls: 'badge-err', label: '未消费' },
  unknown: { cls: 'badge-warn', label: '未知' },
  unreachable: { cls: 'badge-muted', label: '未执行' },
};

const AA_VERDICT_META = {
  ok: { cls: 'pq-ok', icon: '✓' },
  truncated: { cls: 'pq-warn', icon: '⚠' },
  'start-blocked': { cls: 'pq-err', icon: '✗' },
};

/** 首次引用路线视图：场景 / 选项交替（带每步变量状态），末尾标注引用发生的位置 */
function buildAssignAuditPathView(ref, knownVars) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (ref.path || []).forEach((node, i) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      const badge = i === 0 ? '<span class="badge badge-ok">起点</span>' : '';
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'path-edge';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex + 1}「${node.optionText || ''}」 → ${node.target}`));
      if (node.optionUid) {
        const uid = document.createElement('code');
        uid.className = 'cov-uid';
        uid.textContent = node.optionUid;
        div.appendChild(uid);
      }
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  // 末尾：首次引用发生的位置与当时的变量状态
  const reader = ref.reader || {};
  const div = document.createElement('div');
  div.className = 'path-node aa-ref-node';
  const head = document.createElement('div');
  head.className = 'aa-ref-head';
  const badge = document.createElement('span');
  badge.className = 'badge badge-ok';
  badge.textContent = '首次引用';
  const text = document.createElement('span');
  text.textContent = reader.kind === 'option-condition'
    ? `在场景「${reader.sceneId}」选项 ${reader.optionIndex + 1} 的条件`
      + `（${reader.condition || ''}）中引用变量 ${ref.variable}`
    : `进入场景「${reader.sceneId}」时，其前置条件`
      + `（${reader.condition || ''}）引用变量 ${ref.variable}`;
  head.append(badge, text);
  div.appendChild(head);
  // 短路语义：按真实求值顺序列出实际读取的变量；被 && / || 短路跳过的变量单列
  const readVars = ref.readVariables || [ref.variable];
  const skipLine = document.createElement('div');
  skipLine.className = 'aa-read-order';
  const readSpan = document.createElement('span');
  readSpan.className = 'aa-reads';
  readSpan.textContent = `实际读取（按求值顺序）：${readVars.join('、')}`;
  skipLine.appendChild(readSpan);
  if (ref.skippedVariables && ref.skippedVariables.length) {
    const skipSpan = document.createElement('span');
    skipSpan.className = 'aa-skips';
    skipSpan.textContent = `短路未读：${ref.skippedVariables.join('、')}`;
    skipLine.appendChild(skipSpan);
  }
  div.appendChild(skipLine);
  if (ref.stateAtRead) {
    div.insertAdjacentHTML('beforeend', stateChips(ref.stateAtRead, knownVars || []));
  }
  wrap.appendChild(div);
  return wrap;
}

function renderAssignAuditResult() {
  const box = $('aaResult');
  box.innerHTML = '';
  const r = state.aaResult;
  if (!r || !state.story) return;

  const meta = AA_VERDICT_META[r.status] || { cls: 'pq-warn', icon: '⚠' };
  const banner = document.createElement('div');
  banner.className = `pq-banner ${meta.cls}`;
  banner.textContent = `${meta.icon} ${r.message}`;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次审计按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  if (r.startBlocked) return;

  const s = r.summary || {};
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.innerHTML = `
    <div class="stat ${s.unconsumed ? 'stat-bad' : 'stat-ok'}"><span>未消费赋值</span><b>${s.unconsumed ?? 0}</b></div>
    <div class="stat"><span>赋值位置总数</span><b>${s.total ?? 0}</b></div>
    <div class="stat"><span>可达赋值</span><b>${s.reachable ?? 0}</b></div>
    <div class="stat stat-ok"><span>已消费</span><b>${s.consumed ?? 0}</b></div>
    ${s.unknown ? `<div class="stat stat-warn"><span>未知（截断）</span><b>${s.unknown}</b></div>` : ''}
    <div class="stat"><span>未执行（不可达）</span><b>${s.unreachable ?? 0}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${r.counts.states}</b></div>
    <div class="stat"><span>布尔变量</span><b>${r.counts.variables}</b></div>
  `;
  box.appendChild(stats);

  if (!r.assignments || !r.assignments.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = '剧情中没有任何场景进入赋值或选项赋值，无从审计。';
    box.appendChild(note);
    return;
  }

  const label = document.createElement('div');
  label.className = 'cov-section-label';
  label.textContent = `逐赋值位置结果（${r.assignments.length} 处；已消费项可展开查看首次引用的最短可走路线）`;
  box.appendChild(label);

  const list = document.createElement('div');
  list.className = 'aa-list';
  for (const a of r.assignments) {
    const m = AA_STATUS_META[a.status] || AA_STATUS_META.unknown;
    const head = document.createElement('div');
    head.className = 'aa-item-head';
    const badge = document.createElement('span');
    badge.className = `badge ${m.cls}`;
    badge.textContent = m.label;
    const pos = document.createElement('span');
    pos.className = 'aa-pos';
    pos.textContent = a.label;
    const val = document.createElement('code');
    val.className = 'aa-var';
    val.textContent = `${a.variable} = ${a.value}`;
    head.append(badge, pos, val);

    if (a.status === 'consumed' && a.reference) {
      const det = document.createElement('details');
      det.className = 'aa-item';
      const sum = document.createElement('summary');
      sum.appendChild(head);
      const refInfo = document.createElement('span');
      refInfo.className = 'aa-ref-summary';
      refInfo.textContent = `首次引用 ${a.reference.depth} 步 ▸`;
      sum.appendChild(refInfo);
      det.appendChild(sum);
      const body = document.createElement('div');
      body.className = 'aa-item-body';
      body.appendChild(buildAssignAuditPathView(a.reference, r.knownVars));
      det.appendChild(body);
      list.appendChild(det);
    } else {
      const row = document.createElement('div');
      row.className = 'aa-item aa-item-static';
      row.appendChild(head);
      if (a.reason) {
        const reason = document.createElement('div');
        reason.className = 'aa-reason';
        reason.textContent = a.reason;
        row.appendChild(reason);
      }
      list.appendChild(row);
    }
  }
  box.appendChild(list);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ISSUE_META = {
  unreachableScene: { label: '不可达场景', sev: 'error' },
  orphanOption: { label: '悬空跳转', sev: 'error' },
  blockedEntry: { label: '入口前置冲突', sev: 'warning' },
  neverTrueOption: { label: '条件永不成立', sev: 'warning' },
  error: { label: '结构/语法错误', sev: 'error' },
};

function renderAnalysis() {
  renderBaselineBar();
  renderDiffBar();

  const stats = $('analysisStats');
  const ul = $('issueList');
  ul.innerHTML = '';

  if (!state.analysis || !state.story) {
    stats.innerHTML = '';
    return;
  }
  const c = state.analysis.counts;
  const bad = c.issues > 0 || c.errors > 0;
  stats.innerHTML = `
    <div class="stat"><span>场景 / 可达</span><b>${c.scenes} / ${c.reachableScenes}</b></div>
    <div class="stat"><span>布尔变量</span><b>${c.variables}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${c.concreteStates}</b></div>
    <div class="stat"><span>可达转移 / 观测</span><b>${c.enabledTransitions} / ${c.firedTransitions}</b></div>
    <div class="stat ${bad ? 'stat-bad' : 'stat-ok'}"><span>问题数</span><b>${c.issues + c.errors}</b></div>
  `;

  // 对比模式：按状态筛选展示（截断提示在对比模式下省略，避免混淆）
  if (state.diff) {
    const items = state.diff.items.filter((it) => state.diffFilter === 'all' || it.status === state.diffFilter);
    if (!items.length) {
      ul.innerHTML = '<li class="all-clear">当前筛选下没有问题</li>';
      return;
    }
    for (const item of items) ul.appendChild(renderIssueItem(item));
    return;
  }

  const all = [...state.analysis.issues];
  if (!all.length && !state.analysis.truncated) {
    ul.innerHTML = '<li class="all-clear">✓ 未发现一致性问题：所有场景可达、所有选项均可能触发</li>';
    return;
  }

  if (state.analysis.truncated) {
    const li = document.createElement('li');
    li.className = 'issue-item severity-error';
    li.innerHTML = '<div class="ii-type">分析截断</div><div class="ii-msg">具体状态数量超过安全上限，结果可能不完整，请减少变量数量。</div>';
    ul.appendChild(li);
  }

  all.forEach((issue) => ul.appendChild(renderIssueItem({ status: null, issue })));
}

function renderBaselineBar() {
  const bar = $('baselineBar');
  const info = $('baselineInfo');
  if (!state.story) { bar.hidden = true; return; }
  bar.hidden = false;
  $('btnSaveBaseline').disabled = !!state.saving;
  if (state.baseline) {
    const n = state.baseline.issues.length;
    info.innerHTML = `基线：<b>${fmtTime(state.baseline.savedAt)}</b> · ${n} 条问题`;
    info.title = '基线是之后对比“新增 / 已修复 / 仍存在”的参照快照';
  } else {
    info.innerHTML = '<span class="muted">尚未保存基线</span>';
    info.title = '';
  }
}

function renderDiffBar() {
  const bar = $('diffBar');
  if (!state.story || !state.baseline) { bar.hidden = true; return; }
  bar.hidden = false;
  $('diffStale').hidden = !state.diffStale;

  const sum = $('diffSummary');
  if (state.diff) {
    const s = state.diff.summary;
    const chip = (key, n) => n
      ? `<span class="diff-chip diff-chip-${key}">${DIFF_META[key].label} ${n}</span>`
      : '';
    sum.innerHTML = `<span class="diff-title">对比摘要</span>` +
      chip('new', s.new) + chip('fixed', s.fixed) +
      chip('changed', s.changed) + chip('persistent', s.persistent);
  } else {
    sum.innerHTML = '<span class="muted">保存基线后编辑剧情，再点击「运行对比」查看变化</span>';
  }

  const filters = $('diffFilters');
  filters.innerHTML = '';
  const tabs = [
    ['all', '全部'],
    ['new', '新增'],
    ['fixed', '已修复'],
    ['changed', '详情变化'],
    ['persistent', '仍存在'],
  ];
  for (const [key, label] of tabs) {
    const btn = document.createElement('button');
    btn.className = 'diff-filter' + (state.diffFilter === key ? ' active' : '');
    if (key !== 'all' && state.diff) {
      btn.textContent = `${label} ${state.diff.summary[key]}`;
      if (state.diff.summary[key] === 0) btn.disabled = true;
    } else {
      btn.textContent = label;
    }
    btn.addEventListener('click', () => {
      state.diffFilter = key;
      renderDiffBar();
      const ul = $('issueList');
      ul.innerHTML = '';
      if (!state.diff) return;
      const items = state.diff.items.filter((it) => key === 'all' || it.status === key);
      if (!items.length) ul.innerHTML = '<li class="all-clear">当前筛选下没有问题</li>';
      for (const item of items) ul.appendChild(renderIssueItem(item));
    });
    filters.appendChild(btn);
  }
}

/** 渲染一条问题（对比模式 item 含 status/before；普通模式 status=null） */
function renderIssueItem(item) {
  const issue = item.issue || item.before;
  const meta = ISSUE_META[issue.type] || { label: issue.type, sev: issue.severity || 'warning' };
  const li = document.createElement('li');
  const cls = ['issue-item', `severity-${meta.sev}`];
  if (item.status) cls.push(`is-${item.status}`);
  li.className = cls.join(' ');

  let statusBadge = '';
  if (item.status) {
    const dm = DIFF_META[item.status];
    const changeTxt = item.status === 'changed'
      ? `（${item.changes.map((x) => (x === 'path' ? '路径变化' : '文案变化')).join('、')}）`
      : '';
    statusBadge = `<span class="diff-badge ${dm.cls}">${dm.label}${changeTxt}</span>`;
  }

  li.innerHTML = `
    <div class="ii-head">
      <div class="ii-type">${meta.label}</div>
      ${statusBadge}
    </div>
    <div class="ii-msg"></div>
    <div class="ii-meta"></div>
  `;
  li.querySelector('.ii-msg').textContent = issue.message;
  const loc = [issue.sceneId && `场景:${issue.sceneId}`, issue.optionIndex !== undefined && issue.optionIndex !== null && `选项#${issue.optionIndex + 1}`,
    issue.targetSceneId && `目标:${issue.targetSceneId}`].filter(Boolean).join(' · ');
  li.querySelector('.ii-meta').textContent = loc;
  li.addEventListener('click', () => {
    document.querySelectorAll('.issue-item.active-issue').forEach((x) => x.classList.remove('active-issue'));
    li.classList.add('active-issue');
    openDetail(item);
  });
  return li;
}

function openDetail(item) {
  state.detailItem = item;
  // 已修复的问题当前已不存在，默认展示基线（before）路径
  state.detailPathMode = item.status === 'fixed' ? 'before' : 'after';
  renderDetail(item);
}

/* ============================================================
 * 问题详情：最近可达路径 + 未满足条件
 * ============================================================ */
function stateChips(stateObj, knownVars) {
  const vars = knownVars.length ? knownVars : Object.keys(stateObj || {});
  return `<div class="state-chips">` + vars.map((v) => {
    const on = !!(stateObj && stateObj[v]);
    return `<span class="state-chip ${on ? 'true' : 'false'}">${on ? '✓' : '✗'} ${v}</span>`;
  }).join('') + `</div>`;
}

function renderDetail(item) {
  const panel = $('detailPanel');
  if (!item) { panel.hidden = true; return; }
  panel.hidden = false;

  const status = item.status || null;
  const after = item.issue || null;
  const before = item.before || null;

  // 状态徽标
  const statusBox = $('detailStatus');
  statusBox.innerHTML = '';
  if (status) {
    const dm = DIFF_META[status];
    const badge = document.createElement('span');
    badge.className = `diff-badge ${dm.cls} detail-diff-badge`;
    badge.textContent = `基线对比：${dm.label}`;
    statusBox.appendChild(badge);
  }

  const issue = after || before;
  $('detailTitle').textContent = (ISSUE_META[issue.type] || { label: '问题' }).label;
  $('detailMessage').textContent = issue.message;

  // 路径切换标签（详情变化 / 已修复 时可查看基线中的旧路径）
  const tabs = $('detailPathTabs');
  const canBefore = !!before && status !== 'new';
  const canAfter = !!after && status !== 'fixed';
  if (status && (canBefore || canAfter)) {
    tabs.hidden = false;
    tabs.innerHTML = '';
    const mkTab = (mode, label, enabled) => {
      const b = document.createElement('button');
      b.className = 'path-tab' + (state.detailPathMode === mode ? ' active' : '');
      b.textContent = label;
      b.disabled = !enabled;
      if (enabled) b.addEventListener('click', () => {
        state.detailPathMode = mode;
        renderDetail(item);
      });
      tabs.appendChild(b);
    };
    mkTab('after', '当前路径', canAfter);
    mkTab('before', `基线路径（${fmtTime(before && state.baseline && state.baseline.savedAt)}）`, canBefore);
  } else {
    tabs.hidden = true;
  }

  // 文案前后对比
  const msgBox = $('detailMessage');
  if (status === 'changed' && item.changes.includes('message') && before && after) {
    msgBox.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'msg-diff';
    wrap.innerHTML = `
      <div class="msg-diff-row before"><span class="msg-diff-tag">基线</span><span></span></div>
      <div class="msg-diff-row after"><span class="msg-diff-tag">当前</span><span></span></div>`;
    const rows = wrap.querySelectorAll('.msg-diff-row span:last-child');
    rows[0].textContent = before.message;
    rows[1].textContent = after.message;
    msgBox.appendChild(wrap);
  }

  // 路径
  const showAfter = state.detailPathMode !== 'before' || !canBefore;
  const pathIssue = showAfter ? after : before;
  const knownVars = (showAfter ? state.analysis : (state.baseline && state.baseline.knownVars)) || [];
  const pathBox = $('detailPath');
  pathBox.innerHTML = '';
  if (!pathIssue.path || !pathIssue.path.length) {
    pathBox.innerHTML = `<div class="path-node scene blocked">
      <span class="pn-title">∅ 没有任何可达路径通向此处</span>
      <div style="font-size:11px;color:var(--muted);margin-top:3px">从起点出发，不存在任何选项链可以到达该场景（可能是孤岛场景）。</div>
    </div>`;
  } else {
    pathIssue.path.forEach((node, i) => {
      if (node.kind === 'scene') {
        const div = document.createElement('div');
        const cls = ['path-node', 'scene'];
        if (i === 0) cls.push('start');
        if (node.blockedEntry) cls.push('blocked');
        div.className = cls.join(' ');
        const isLast = i === pathIssue.path.length - 1;
        const badge = i === 0 ? '<span class="badge badge-ok">起点</span>'
          : node.hypothetical ? '<span class="badge badge-warn">假设到达（选项实际无法触发）</span>'
          : node.blockedEntry ? '<span class="badge badge-err">前置条件不成立</span>'
          : isLast ? '<span class="badge badge-err">问题位置</span>' : '';
        div.innerHTML = `
          <span class="pn-title"></span><span class="pn-id"></span>
          ${badge}
        `;
        div.querySelector('.pn-title').textContent = node.title || node.sceneId;
        div.querySelector('.pn-id').textContent = node.sceneId;
        div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars));
        pathBox.appendChild(div);
      } else {
        const div = document.createElement('div');
        div.className = 'path-edge' + (node.broken || node.entryBlocked || node.deadEnd ? ' broken' : '');
        const targetTxt = node.target
          ? ` → ${node.targetTitle ? node.targetTitle + ' (' + node.target + ')' : node.target}`
          : '';
        const prefix = node.broken ? '✕ ' : node.entryBlocked ? '⛔ ' : node.deadEnd ? '🔒 ' : '';
        div.textContent = `${prefix}选项 ${node.optionIndex + 1}「${node.optionText || ''}」${targetTxt}${node.deadEnd ? '（条件不成立，无法选择）' : ''}`;
        if (node.stateAfter) {
          div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars));
        }
        pathBox.appendChild(div);
      }
    });
  }

  // 未满足条件（基线快照不保留解释树，仅当前结果可展示）
  const wrap = $('detailUnmetWrap');
  if (after && after.unmet && showAfter) {
    wrap.hidden = false;
    $('detailUnmet').innerHTML = '';
    $('detailUnmet').appendChild(renderExprNode(after.unmet));
    const flips = collectFlips(after.unmet);
    const fix = $('detailFix');
    if (after.unmet.feasible === false) {
      const cv = after.unmet.conflicts || [];
      fix.innerHTML = `⚠️ 该条件<b>逻辑上不可满足</b>：${cv.length ? `变量 ${cv.map((v) => `<code>${v}</code>`).join('、')} 被同时要求为真和为假；` : '不存在任何变量取值能使它成立；'}请修改条件表达式，而不是调整状态赋值。`;
      fix.style.background = 'var(--danger-bg)';
      fix.style.color = '#8a2b2b';
    } else if (flips.length) {
      fix.style.background = '';
      fix.style.color = '';
      fix.innerHTML = `最少只需让以下变量取反即可满足：${flips.map((v) => `<b><code>${v}</code></b>`).join('、')}。请检查路径上的状态赋值是否缺失或冲突。`;
    } else if (after.unmet.feasible === null) {
      fix.style.background = '';
      fix.style.color = '';
      fix.innerHTML = '条件涉及变量较多，未做完整可满足性枚举；请人工核对子条件。';
    } else {
      fix.style.background = '';
      fix.style.color = '';
      fix.innerHTML = '条件在当前状态下成立（该问题来自结构性不可达，请检查跳转连接）。';
    }
  } else {
    wrap.hidden = true;
  }
}

function collectFlips(node) {
  if (!node) return [];
  const out = new Set();
  const walk = (n) => {
    // OR 只要有一个分支满足：只沿最佳（flip 与父级一致的）分支深入
    (n.flip || []).forEach((f) => out.add(f));
    (n.children || []).forEach(walk);
  };
  walk(node);
  return [...out];
}

function renderExprNode(node) {
  const wrap = document.createElement('div');
  const met = node.satisfied;
  const cls = ['expr-node', met ? 'met' : 'unmet'];
  if (node.feasible === false) cls.push('infeasible');
  if (node.hintAlternative) cls.push('gate');
  wrap.className = cls.join(' ');

  const opLabel = { and: 'AND（全部满足）', or: 'OR（任一满足）', not: 'NOT（取反）' };
  let head = '';
  if (node.op === 'var') {
    head = `<code class="expr-val">${node.name}</code>
      <span>当前 = <b>${node.value}</b>，要求 = <b>${node.want}</b></span>
      ${met ? '✓' : '✗'}`;
  } else if (node.op === 'const') {
    head = `<span>恒真条件</span>`;
  } else {
    head = `<span class="expr-op">${opLabel[node.op]}</span>
      <span class="expr-want">需要 = <b>${node.want}</b>，实际 = <b>${node.value}</b></span>
      ${met ? '✓' : '✗'}`;
  }
  wrap.innerHTML = head;

  if (node.children && node.children.length) {
    const kids = document.createElement('div');
    kids.className = 'expr-children';
    node.children.forEach((ch) => kids.appendChild(renderExprNode(ch)));
    wrap.appendChild(kids);
  }
  return wrap;
}

/* ============================================================
 * 全局事件 & 启动
 * ============================================================ */
function bindGlobalEvents() {
  $('storySelect').addEventListener('change', (e) => {
    if (state.dirty && !confirm('当前剧情有未保存的修改，切换将丢失这些修改，继续？')) {
      e.target.value = state.story.id;
      return;
    }
    openStory(e.target.value);
  });
  $('btnNew').addEventListener('click', () => {
    if (state.dirty && !confirm('当前剧情有未保存的修改，确定新建剧情？')) return;
    createStory();
  });
  $('btnSave').addEventListener('click', saveStory);
  $('btnDelete').addEventListener('click', deleteStory);
  $('btnExport').addEventListener('click', exportStory);
  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importStory(e.target.files[0]);
    e.target.value = '';
  });
  $('btnAnalyze').addEventListener('click', () => runAnalysis(state.dirty));
  $('btnRunProb').addEventListener('click', runProbability);
  $('btnRunForced').addEventListener('click', runForcedChoices);
  $('btnRunCoverage').addEventListener('click', runCoverage);
  $('btnRunForeshadow').addEventListener('click', runForeshadow);
  $('btnFsAddSetup').addEventListener('click', () => {
    state.foreshadow.setups.push('');
    renderFsRows('setups');
    markForeshadowStale();
  });
  $('btnFsAddPayoff').addEventListener('click', () => {
    state.foreshadow.payoffs.push('');
    renderFsRows('payoffs');
    markForeshadowStale();
  });
  $('btnRunPacing').addEventListener('click', runPacing);
  $('pacMax').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      toast('允许的最长连续场景数必须是 1～10 的整数');
      e.target.value = state.pacing.maxConsecutive;
      return;
    }
    state.pacing.maxConsecutive = v;
    markPacingStale();
  });
  $('btnRunStrategy').addEventListener('click', runStrategy);
  $('stgTarget').addEventListener('change', (e) => {
    state.strategy.targetScene = e.target.value;
    markStrategyStale();
  });
  $('btnRunAssignAudit').addEventListener('click', runAssignAudit);
  $('btnCloseDetail').addEventListener('click', () => $('detailPanel').hidden = true);
  $('btnSaveBaseline').addEventListener('click', saveBaseline);
  $('btnRunCompare').addEventListener('click', runCompare);
  $('btnClearBaseline').addEventListener('click', clearBaseline);
  $('btnRunPathQuery').addEventListener('click', runPathQuery);
  $('btnPqAddConstraint').addEventListener('click', () => {
    if (!state.story) return;
    const firstVar = state.story.variables[0];
    state.pathQuery.constraints.push({ variable: firstVar ? firstVar.name : '', value: true });
    renderPqConstraints();
    markPathQueryStale();
  });
  $('btnPqAddRequired').addEventListener('click', () => {
    state.pathQuery.requiredOptions.push('');
    renderPqRequired();
    markPathQueryStale();
  });
  $('btnPqAddDisabled').addEventListener('click', () => {
    state.pathQuery.disabledOptions.push('');
    renderPqDisabled();
    markPathQueryStale();
  });
  $('pqTarget').addEventListener('change', (e) => {
    state.pathQuery.targetScene = e.target.value;
    markPathQueryStale();
  });

  // Ctrl/Cmd + S 保存
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveStory();
    }
  });
}

async function init() {
  bindGlobalEvents();
  bindEditorEvents();
  try {
    const id = await loadList();
    if (id) await openStory(id);
    else {
      renderAll();
      toast('数据目录为空，请新建或导入剧情');
    }
  } catch (e) {
    toast(`初始化失败：${e.message}`);
  }
}

init();
