const $ = (selector) => document.querySelector(selector);
const task = $('#task');
const model = $('#model');
const launch = $('#launch');
const errorBox = $('#error');
const dialog = $('#settings-dialog');
let settings = { endpoint: '', model: '', models: {}, timeoutSeconds: 180 };
let activeRunId = null;
let selectedRun = null;
let presetList = [];

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

function applyPreset(id) {
  const preset = presetList.find((item) => item.id === id);
  if (!preset) return;
  for (const role of preset.roles) {
    const card = document.querySelector(`[data-role-name="${role.id}"]`)?.closest('.agent-card');
    if (!card) continue;
    card.querySelector('[data-role-name]').textContent = role.name;
    card.querySelector('[data-role-description]').textContent = role.description;
  }
}

function populateModels(models, preferred = '') {
  const roleSelects = [...document.querySelectorAll('.role-model')];
  model.innerHTML = '';
  for (const item of models) model.add(new Option(item.name, item.id));
  if (!models.length) {
    model.add(new Option('No models found', ''));
    for (const select of roleSelects) select.innerHTML = '<option value="">No models found</option>';
    settings.model = ''; settings.models = {}; setConnection(true, 'Connected • no models found'); return;
  }
  const fallback = models.find((item) => item.id === preferred) || models[0];
  model.value = fallback.id; settings.model = fallback.id;
  for (const select of roleSelects) {
    const assigned = settings.models?.[select.dataset.role];
    for (const item of models) select.add(new Option(item.name, item.id));
    select.value = models.some((item) => item.id === assigned) ? assigned : fallback.id;
  }
  settings.models = roleModels(); setConnection(true, `Connected • ${models.length} model${models.length === 1 ? '' : 's'}`);
}

async function loadPresets() {
  const result = await api('/api/presets'); presetList = result.presets;
  const select = $('#preset'); select.innerHTML = '';
  for (const item of presetList) select.add(new Option(item.name, item.id));
  select.value = 'general'; applyPreset(select.value);
}

async function loadModels(preferred = '') { const list = await api('/api/models'); populateModels(list.models || [], preferred); }

async function loadSettings() {
  settings = await api('/api/settings'); $('#endpoint').value = settings.endpoint; $('#timeout').value = settings.timeoutSeconds;
  try { await loadModels(settings.model); }
  catch (err) { model.innerHTML = '<option value="">Connection unavailable</option>'; document.querySelectorAll('.role-model').forEach((select) => { select.innerHTML = '<option value="">Connection unavailable</option>'; }); setConnection(false, 'Ollama unavailable'); errorBox.textContent = err.message; errorBox.hidden = false; }
}

function statusClass(status) { return ['error', 'cancelled'].includes(status) ? 'failed' : ''; }

function renderRun(run, scroll = false) {
  if (!run) return;
  selectedRun = run; $('#results').hidden = false;
  const usedModels = [...new Set([...(run.agents || []).map((agent) => agent.model), run.model].filter(Boolean))];
  $('#run-meta').textContent = `${presetList.find((preset) => preset.id === run.preset)?.name || 'General'} crew · ${usedModels.join(', ')} · ${new Date(run.createdAt).toLocaleString()}`;
  $('#run-status').textContent = run.status.toUpperCase();
  $('#run-status').style.color = ['complete', 'partial'].includes(run.status) ? 'var(--lime)' : run.status === 'running' || run.status === 'cancelling' ? '#b5d1ff' : '#ffb582';
  const progress = run.progress || { completed: 0, total: 4, message: run.status };
  $('#progress-bar').style.width = `${Math.min(100, progress.completed / Math.max(1, progress.total) * 100)}%`;
  $('#progress-message').textContent = progress.message || '';
  const grid = $('#result-grid'); grid.innerHTML = '';
  const rounds = run.rounds?.length ? run.rounds : [{ number: 1, agents: run.agents || [], coordinator: run.coordinator, status: run.status }];
  for (const round of rounds) {
    const label = document.createElement('h3'); label.className = 'round-title'; label.textContent = `Round ${round.number}${round.number === 1 ? ' · Original mission' : ' · Follow-up'}`; grid.append(label);
    for (const agent of round.agents || []) {
      const article = document.createElement('article'); article.className = 'result-card';
      const title = document.createElement('h3'); title.textContent = `${agent.name} · ${agent.model || run.model} · ${agent.status.toUpperCase()}`;
      const answer = document.createElement('div'); answer.className = `answer ${statusClass(agent.status)}`; answer.textContent = agent.answer || (agent.status === 'running' ? 'Working…' : 'Waiting to start…');
      article.append(title, answer); grid.append(article);
    }
    if (round.coordinator) {
      const article = document.createElement('article'); article.className = 'result-card coordinator-card';
      const title = document.createElement('h3'); title.textContent = `Coordinator · ${round.coordinator.model || run.model} · ${round.coordinator.status.toUpperCase()}`;
      const answer = document.createElement('div'); answer.className = `answer ${statusClass(round.coordinator.status)}`; answer.textContent = round.coordinator.answer || (round.coordinator.status === 'running' ? 'Reconciling the crew’s responses…' : 'Waiting for crew responses…');
      article.append(title, answer); grid.append(article);
    }
  }
  const canContinue = ['complete', 'partial'].includes(run.status) && rounds.length < 4;
  $('#round-actions').hidden = !canContinue;
  $('#follow-up-button').disabled = !!activeRunId;
  $('#cancel-run').hidden = !['running', 'cancelling'].includes(run.status);
  launch.disabled = !!activeRunId;
  launch.querySelector('span').textContent = activeRunId ? 'Crew is thinking…' : 'Launch the crew';
  const liveAgents = (run.agents || []);
  document.querySelectorAll('.agent-state').forEach((el, i) => {
    const agent = liveAgents[i]; el.textContent = agent?.status?.toUpperCase() || (run.status === 'running' ? 'QUEUED' : 'IDLE');
    el.style.color = agent?.status === 'complete' ? 'var(--lime)' : agent?.status === 'running' ? '#b5d1ff' : '';
  });
  if (scroll) $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    row.append(title, meta, badge);
    row.addEventListener('click', async () => { try { renderRun((await api(`/api/runs/${run.id}`)).run, true); } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; } });
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') row.click(); }); box.append(row);
  }
}

async function refreshHistory() { renderHistory((await api('/api/runs')).runs); }

async function persistAssignments() {
  settings.model = model.value; settings.models = roleModels();
  settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ endpoint: settings.endpoint, model: settings.model, models: settings.models, timeoutSeconds: settings.timeoutSeconds }) });
}

async function watchRun(id, scroll = false) {
  activeRunId = id;
  let first = true;
  while (activeRunId === id) {
    const { run } = await api(`/api/runs/${id}`);
    renderRun(run, scroll && first); first = false; await refreshHistory();
    if (!['running', 'cancelling'].includes(run.status)) { activeRunId = null; renderRun(run); break; }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
}

function markdownForRun(run) {
  const lines = [`# Agent Yard mission`, '', `**Created:** ${new Date(run.createdAt).toLocaleString()}`, `**Crew:** ${presetList.find((preset) => preset.id === run.preset)?.name || 'General'}`, `**Status:** ${run.status}`, '', '## Mission', '', run.task, ''];
  for (const round of run.rounds || []) {
    lines.push(`## Round ${round.number}`, '', ...(round.number > 1 ? [`**Follow-up:** ${round.prompt}`, ''] : []));
    for (const agent of round.agents || []) lines.push(`### ${agent.name} (${agent.model || run.model})`, '', agent.answer || `_${agent.status}_`, '');
    if (round.coordinator) lines.push(`### Coordinator (${round.coordinator.model || run.model})`, '', round.coordinator.answer || `_${round.coordinator.status}_`, '');
  }
  return `${lines.join('\n')}\n`;
}

function exportMarkdown() {
  if (!selectedRun) return;
  const blob = new Blob([markdownForRun(selectedRun)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `agent-yard-${selectedRun.id.slice(0, 8)}.md`; link.click(); URL.revokeObjectURL(url);
}

launch.addEventListener('click', async () => {
  errorBox.hidden = true; const brief = task.value.trim();
  if (!brief) { errorBox.textContent = 'Write a mission brief first.'; errorBox.hidden = false; task.focus(); return; }
  if (!model.value || Object.values(roleModels()).some((value) => !value)) { errorBox.textContent = 'Choose a model for the Coordinator and each role.'; errorBox.hidden = false; return; }
  try {
    await persistAssignments();
    const { run } = await api('/api/runs', { method: 'POST', body: JSON.stringify({ task: brief, preset: $('#preset').value, model: model.value, models: roleModels() }) });
    await watchRun(run.id, true);
  } catch (err) { activeRunId = null; errorBox.textContent = err.message; errorBox.hidden = false; }
});

$('#cancel-run').addEventListener('click', async () => {
  if (!activeRunId) return;
  try { await api(`/api/runs/${activeRunId}/cancel`, { method: 'POST', body: '{}' }); } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
});

$('#follow-up-button').addEventListener('click', async () => {
  const prompt = $('#follow-up').value.trim();
  if (!selectedRun || !prompt) return;
  try {
    const { run } = await api(`/api/runs/${selectedRun.id}/follow-up`, { method: 'POST', body: JSON.stringify({ prompt }) });
    $('#follow-up').value = ''; await watchRun(run.id, true);
  } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
});

$('#export-markdown').addEventListener('click', exportMarkdown);
$('#preset').addEventListener('change', () => applyPreset($('#preset').value));
$('#settings-open').addEventListener('click', () => { $('#settings-message').textContent = ''; $('#settings-message').style.color = 'var(--lime)'; dialog.showModal(); });
$('#save-settings').addEventListener('click', async () => {
  const message = $('#settings-message'); message.textContent = 'Saving…'; message.style.color = 'var(--lime)';
  try { const next = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ endpoint: $('#endpoint').value, model: model.value, models: roleModels(), timeoutSeconds: $('#timeout').value }) }); settings = next; await loadModels(settings.model); message.textContent = 'Saved and connected.'; }
  catch (err) { message.textContent = err.message; message.style.color = '#ffad9e'; }
});
$('#test-connection').addEventListener('click', async () => {
  const message = $('#settings-message'); message.textContent = 'Checking Ollama…'; message.style.color = 'var(--lime)';
  try { const list = await api('/api/models', { method: 'POST', body: JSON.stringify({ endpoint: $('#endpoint').value }) }); message.textContent = `Connected. Found ${list.models.length} model${list.models.length === 1 ? '' : 's'}.`; }
  catch (err) { message.textContent = err.message; message.style.color = '#ffad9e'; }
});
$('#refresh-models').addEventListener('click', async () => {
  const button = $('#refresh-models'); button.textContent = '↻ Checking…';
  try { await loadModels(model.value); errorBox.hidden = true; }
  catch (err) { setConnection(false, 'Ollama unavailable'); errorBox.textContent = err.message; errorBox.hidden = false; }
  finally { button.textContent = '↻ Refresh models'; }
});
$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Clear locally saved mission history?')) return;
  try { await api('/api/runs', { method: 'DELETE' }); renderHistory([]); $('#results').hidden = true; selectedRun = null; }
  catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
});

model.addEventListener('change', async () => {
  settings.model = model.value; document.querySelectorAll('.role-model').forEach((select) => { select.value = model.value; }); settings.models = roleModels();
  try { await persistAssignments(); } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
});
document.querySelectorAll('.role-model').forEach((select) => select.addEventListener('change', async () => {
  settings.models = roleModels(); try { await persistAssignments(); } catch (err) { errorBox.textContent = err.message; errorBox.hidden = false; }
}));

Promise.all([loadPresets(), loadSettings()]).then(refreshHistory).catch((err) => { errorBox.textContent = err.message; errorBox.hidden = false; });
