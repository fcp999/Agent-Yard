const $ = (selector) => document.querySelector(selector);
const task = $('#task');
const model = $('#model');
const launch = $('#launch');
const errorBox = $('#error');
const dialog = $('#settings-dialog');
let settings = { endpoint: '', model: '', models: {}, timeoutSeconds: 180 };

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setConnection(ok, message) {
  $('#connection-label').textContent = message;
  $('.pulse').style.background = ok ? 'var(--lime)' : '#e5a74f';
  $('.pulse').style.boxShadow = ok ? '0 0 9px var(--lime)' : '0 0 9px #e5a74f';
}

function roleModels() {
  return Object.fromEntries([...document.querySelectorAll('.role-model')].map((select) => [select.dataset.role, select.value]));
}

function populateModels(models, preferred = '') {
  const roleSelects = [...document.querySelectorAll('.role-model')];
  model.innerHTML = '';
  for (const item of models) model.add(new Option(item.name, item.id));
  if (!models.length) {
    model.add(new Option('No models found', ''));
    for (const select of roleSelects) select.innerHTML = '<option value="">No models found</option>';
    settings.model = '';
    settings.models = {};
    setConnection(true, 'Connected • no models found');
    return;
  }
  const fallback = models.find((item) => item.id === preferred) || models[0];
  model.value = fallback.id;
  settings.model = fallback.id;
  for (const select of roleSelects) {
    const assigned = settings.models?.[select.dataset.role];
    for (const item of models) select.add(new Option(item.name, item.id));
    select.value = models.some((item) => item.id === assigned) ? assigned : fallback.id;
  }
  settings.models = roleModels();
  setConnection(true, `Connected • ${models.length} model${models.length === 1 ? '' : 's'}`);
}

async function loadModels(preferred = '') {
  const list = await api('/api/models');
  populateModels(list.models || [], preferred);
}

async function loadSettings() {
  settings = await api('/api/settings');
  $('#endpoint').value = settings.endpoint;
  $('#timeout').value = settings.timeoutSeconds;
  try { await loadModels(settings.model); }
  catch (err) { model.innerHTML = '<option value="">Connection unavailable</option>'; document.querySelectorAll('.role-model').forEach((select) => { select.innerHTML = '<option value="">Connection unavailable</option>'; }); setConnection(false, 'Ollama unavailable'); errorBox.textContent = err.message; errorBox.hidden = false; }
}

function renderRun(run) {
  $('#results').hidden = false;
  const modelList = (run.agents || []).map((agent) => `${agent.name}: ${agent.model || run.model}`).join(' · ');
  $('#run-meta').textContent = `${modelList} · ${new Date(run.createdAt).toLocaleString()}`;
  $('#run-status').textContent = run.status.toUpperCase();
  $('#run-status').style.color = run.status === 'complete' ? 'var(--lime)' : '#ffb582';
  const grid = $('#result-grid');
  grid.innerHTML = '';
  for (const agent of run.agents || []) {
    const article = document.createElement('article');
    article.className = 'result-card';
    const title = document.createElement('h3'); title.textContent = `${agent.name} · ${agent.model || run.model}`;
    const answer = document.createElement('div'); answer.className = `answer ${agent.status === 'error' ? 'failed' : ''}`; answer.textContent = agent.answer;
    article.append(title, answer); grid.append(article);
  }
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHistory(runs) {
  const box = $('#history'); box.innerHTML = '';
  if (!runs.length) { box.innerHTML = '<div class="empty-history">Your missions will show up here.</div>'; return; }
  for (const run of runs) {
    const row = document.createElement('div'); row.className = 'history-row'; row.tabIndex = 0;
    const title = document.createElement('div'); title.className = 'history-task'; title.textContent = run.task;
    const usedModels = [...new Set((run.agents || []).map((agent) => agent.model).filter(Boolean))];
    const meta = document.createElement('div'); meta.className = 'history-meta'; meta.textContent = `${new Date(run.createdAt).toLocaleString()} · ${usedModels.join(', ') || run.model}`;
    const badge = document.createElement('div'); badge.className = 'history-badge'; badge.textContent = run.status.toUpperCase();
    row.append(title, meta, badge); row.addEventListener('click', () => renderRun(run));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') renderRun(run); });
    box.append(row);
  }
}

async function refreshHistory() { renderHistory((await api('/api/runs')).runs); }

async function persistAssignments() {
  settings.model = model.value;
  settings.models = roleModels();
  settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ endpoint: settings.endpoint, model: settings.model, models: settings.models, timeoutSeconds: settings.timeoutSeconds }) });
}

launch.addEventListener('click', async () => {
  errorBox.hidden = true;
  const brief = task.value.trim();
  if (!brief) { errorBox.textContent = 'Write a mission brief first.'; errorBox.hidden = false; task.focus(); return; }
  if (!model.value || Object.values(roleModels()).some((value) => !value)) { errorBox.textContent = 'Choose a model for each role.'; errorBox.hidden = false; return; }
  launch.disabled = true; launch.querySelector('span').textContent = 'Crew is thinking…';
  $('.agent-grid').querySelectorAll('.agent-state').forEach((el) => { el.textContent = 'WORKING'; el.style.color = 'var(--lime)'; });
  try {
    await persistAssignments();
    const { run } = await api('/api/runs', { method: 'POST', body: JSON.stringify({ task: brief, model: model.value, models: roleModels() }) });
    renderRun(run); await refreshHistory();
  } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
  finally { launch.disabled = false; launch.querySelector('span').textContent = 'Launch the crew'; $('.agent-grid').querySelectorAll('.agent-state').forEach((el) => { el.textContent = 'IDLE'; el.style.color = ''; }); }
});

$('#settings-open').addEventListener('click', () => { $('#settings-message').textContent = ''; $('#settings-message').style.color = 'var(--lime)'; dialog.showModal(); });
$('#save-settings').addEventListener('click', async () => {
  const message = $('#settings-message'); message.textContent = 'Saving…'; message.style.color = 'var(--lime)';
  try {
    const next = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ endpoint: $('#endpoint').value, model: model.value, models: roleModels(), timeoutSeconds: $('#timeout').value }) });
    settings = next;
    await loadModels(settings.model);
    message.textContent = 'Saved and connected.';
  } catch (err) { message.textContent = err.message; message.style.color = '#ffad9e'; }
});
$('#test-connection').addEventListener('click', async () => {
  const message = $('#settings-message'); message.textContent = 'Checking Ollama…'; message.style.color = 'var(--lime)';
  try {
    const list = await api('/api/models', { method: 'POST', body: JSON.stringify({ endpoint: $('#endpoint').value }) });
    message.textContent = `Connected. Found ${list.models.length} model${list.models.length === 1 ? '' : 's'}.`;
  } catch (err) { message.textContent = err.message; message.style.color = '#ffad9e'; }
});
$('#refresh-models').addEventListener('click', async () => {
  const button = $('#refresh-models'); button.textContent = '↻ Checking…';
  try { await loadModels(model.value); errorBox.hidden = true; }
  catch (err) { setConnection(false, 'Ollama unavailable'); errorBox.textContent = err.message; errorBox.hidden = false; }
  finally { button.textContent = '↻ Refresh models'; }
});
$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Clear locally saved mission history?')) return;
  try { await api('/api/runs', { method: 'DELETE' }); renderHistory([]); $('#results').hidden = true; }
  catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
});

model.addEventListener('change', async () => {
  settings.model = model.value;
  document.querySelectorAll('.role-model').forEach((select) => { select.value = model.value; });
  settings.models = roleModels();
  try { await persistAssignments(); } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
});
document.querySelectorAll('.role-model').forEach((select) => select.addEventListener('change', async () => {
  settings.models = roleModels();
  try { await persistAssignments(); } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
}));
loadSettings().then(refreshHistory).catch((err) => { errorBox.textContent = err.message; errorBox.hidden = false; });
