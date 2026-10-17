import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { workspaceManager } from './workspace.js';
import { develop } from './development.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = path.join(here, 'data');
const defaultSettings = { endpoint: 'http://127.0.0.1:11434', model: '', models: {}, timeoutSeconds: 180 };
const baseRoles = [
  { id: 'architect', name: 'Architect', mark: '01', description: 'Turns the request into a plan, with the goal and constraints up front.', prompt: 'Analyze the request, identify the goal and constraints, and propose a concise implementation plan.' },
  { id: 'builder', name: 'Builder', mark: '02', description: 'Breaks the request into concrete components, files, and interfaces.', prompt: 'Turn the request into a concrete solution outline with components, interfaces, and implementation details.' },
  { id: 'reviewer', name: 'Reviewer', mark: '03', description: 'Looks for edge cases, ambiguity, and what could go sideways.', prompt: 'Find ambiguity, failure cases, security concerns, and the smallest useful verification plan.' }
];
const presets = {
  general: { name: 'General', roles: baseRoles },
  coding: { name: 'Software build', roles: [
    { ...baseRoles[0], name: 'Planner', description: 'Defines architecture, scope, and interfaces.', prompt: 'Plan the implementation. Identify architecture, files, interfaces, dependencies, and acceptance criteria.' },
    { ...baseRoles[1], name: 'Builder', description: 'Proposes the concrete implementation.', prompt: 'Propose a practical implementation with code structure, edge cases, and specific changes.' },
    { ...baseRoles[2], name: 'Tester', description: 'Challenges the design and defines verification.', prompt: 'Review the proposal for bugs, security risks, missing cases, and meaningful tests.' }
  ] },
  troubleshoot: { name: 'Troubleshooting', roles: [
    { ...baseRoles[0], name: 'Triage Lead', description: 'Frames symptoms and ranks likely causes.', prompt: 'Structure the incident. Separate facts from assumptions and rank likely causes with evidence needed.' },
    { ...baseRoles[1], name: 'Investigator', description: 'Builds a diagnostic path and commands.', prompt: 'Create a step-by-step investigation. Include exact checks, expected results, and what each result means.' },
    { ...baseRoles[2], name: 'Peer Reviewer', description: 'Checks alternative causes and operational risk.', prompt: 'Challenge the leading diagnosis. Find alternate explanations, risky steps, and ways to confirm a fix.' }
  ] },
  research: { name: 'Research', roles: [
    { ...baseRoles[0], name: 'Question Framer', description: 'Defines the question and evidence standard.', prompt: 'Frame the research question, scope, key terms, and what evidence would answer it.' },
    { ...baseRoles[1], name: 'Analyst', description: 'Organizes findings and implications.', prompt: 'Analyze the available information, organize findings, and explain practical implications.' },
    { ...baseRoles[2], name: 'Skeptic', description: 'Looks for weak evidence and missing context.', prompt: 'Look for unsupported claims, counterexamples, uncertainty, and missing evidence.' }
  ] }
};

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(temp, file);
}

function json(res, status, body) {
  const bytes = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bytes), 'cache-control': 'no-store' });
  res.end(bytes);
}

async function bodyJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64_000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(data || '{}'); }
  catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}

function normalizeEndpoint(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('Endpoint must be a valid http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endpoint must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Put credentials in the service itself, not in the endpoint URL.');
  return url.toString().replace(/\/$/, '');
}

async function getSettings(stateDir = dataDir) {
  const saved = await readJson(path.join(stateDir, 'settings.json'), {});
  return { ...defaultSettings, ...saved };
}

async function fetchModels(settings) {
  const base = normalizeEndpoint(settings.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const native = await fetch(`${base}/api/tags`, { signal: controller.signal });
    if (native.ok) {
      const data = await native.json();
      return (data.models || []).map((m) => ({ id: m.name, name: m.name, size: m.details?.parameter_size || '' }));
    }
    const compatible = await fetch(`${base}/v1/models`, { signal: controller.signal });
    if (!compatible.ok) throw new Error(`Model list failed (${compatible.status}).`);
    const data = await compatible.json();
    return (data.data || []).map((m) => ({ id: m.id, name: m.id, size: '' }));
  } finally { clearTimeout(timer); }
}

async function askModel(settings, model, messages, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(20, Number(settings.timeoutSeconds) || 180) * 1000);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const res = await fetch(`${normalizeEndpoint(settings.endpoint)}/api/chat`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.35 } })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Model call failed (${res.status}).`);
    const answer = data.message?.content;
    if (!answer) throw new Error('The model returned an empty response.');
    return answer;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}

export function createServer({ stateDir = dataDir } = {}) {
  const workspaces = workspaceManager(stateDir);
  const settingsPath = path.join(stateDir, 'settings.json');
  const historyPath = path.join(stateDir, 'runs.json');
  let historyPromise;
  let writeQueue = Promise.resolve();
  const controllers = new Map();
  const deletedRuns = new Set();
  const getRuns = () => (historyPromise ||= readJson(historyPath, []).then(runs => {
    for (const run of runs) {
      if (['running', 'cancelling'].includes(run.status)) {
        run.status = 'interrupted';
        run.error = 'Server restarted. Previous model calls were interrupted; start a follow-up or new mission.';
        run.finishedAt = new Date().toISOString();
      }
    }
    return runs;
  }));
  async function saveRuns() {
    const runs = await getRuns();
    writeQueue = writeQueue.then(() => writeJson(historyPath, runs.slice(0, 30)));
    return writeQueue;
  }
  async function saveRun(run) {
    if (deletedRuns.has(run.id)) return;
    const runs = await getRuns();
    const index = runs.findIndex((item) => item.id === run.id);
    if (index < 0) runs.unshift(run); else runs[index] = run;
    runs.splice(30);
    await saveRuns();
  }
  async function getRun(id) { return (await getRuns()).find((run) => run.id === id); }

  async function executeRound(run, round, preset, settings, signal) {
    const activeRoles = preset.roles;
    const models = run.models;
    const total = activeRoles.length + 1;
    const update = async () => {
      run.agents = round.agents;
      run.coordinator = round.coordinator;
      run.progress = { completed: [...round.agents, round.coordinator].filter((item) => item?.status === 'complete' || item?.status === 'error').length, total, message: `Round ${round.number}: ${[...round.agents, round.coordinator].filter(Boolean).length} of ${total} complete` };
      await saveRun(run);
    };
    round.agents = activeRoles.map((role) => ({ ...role, model: models[role.id], status: 'queued', answer: '' }));
    round.status = 'running';
    await update();
    await Promise.all(round.agents.map(async (agent, index) => {
      const role = activeRoles[index];
      if (signal.aborted) { agent.status = 'cancelled'; agent.answer = 'Cancelled.'; return update(); }
      agent.status = 'running';
      await update();
      try {
        agent.answer = await askModel(settings, agent.model, [
          { role: 'system', content: `${role.prompt}\n\nYou are the ${role.name} in a local multi-agent workbench. Be direct and useful. Do not claim to have changed files or run commands.` },
          { role: 'user', content: round.prompt }
        ], signal);
        agent.status = 'complete';
      } catch (err) {
        agent.status = signal.aborted ? 'cancelled' : 'error';
        agent.answer = signal.aborted ? 'Cancelled.' : err.name === 'AbortError' ? 'Timed out. Increase the timeout or try a smaller model.' : err.message;
      }
      await update();
    }));
    if (signal.aborted) {
      round.status = 'cancelled'; round.coordinator = { name: 'Coordinator', model: run.model, status: 'cancelled', answer: 'Cancelled before synthesis.' };
      run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); return update();
    }
    const synthesisContext = round.agents.map((agent) => `## ${agent.name} (${agent.status})\n${agent.answer}`).join('\n\n');
    round.coordinator = { name: 'Coordinator', model: run.model, status: 'running', answer: '' };
    await update();
    try {
      round.coordinator.answer = await askModel(settings, run.model, [
        { role: 'system', content: 'You are the Coordinator for Agent Yard. Synthesize independent agent responses into one clear, actionable answer. Start with the recommended outcome, reconcile disagreements, flag unresolved uncertainty, and give concrete next steps. Do not invent facts or claim work was performed.' },
        { role: 'user', content: `Mission: ${run.task}\n\nCurrent round request: ${round.prompt}\n\nAgent responses:\n${synthesisContext}` }
      ], signal);
      round.coordinator.status = 'complete';
    } catch (err) {
      round.coordinator.status = signal.aborted ? 'cancelled' : 'error';
      round.coordinator.answer = signal.aborted ? 'Cancelled.' : err.name === 'AbortError' ? 'Timed out. Increase the timeout or try a smaller model.' : err.message;
    }
    round.status = signal.aborted ? 'cancelled' : round.agents.some((agent) => agent.status === 'error') || round.coordinator.status === 'error' ? 'partial' : 'complete';
    run.status = round.status; run.finishedAt = new Date().toISOString();
    await update();
  }

  async function startRound(run, round) {
    const controller = new AbortController();
    controllers.set(run.id, controller);
    try {
      const settings = await getSettings(stateDir);
      if (run.preset === 'coding' && run.autonomous) {
        round.status = 'running';
        const roles = presets.coding.roles;
        const generate = (role, prompt) => askModel(settings, run.models[role] || run.model,
          [{ role: 'system', content: role === 'builder'
            ? 'You write complete small source files. Output only valid JSON with files and notes. Never use markdown.'
            : role === 'reviewer'
              ? 'Review the test outcome and implementation. Output only valid JSON: {"pass":boolean,"feedback":"reason"}.'
              : 'Provide a concise implementation plan.' },
           { role: 'user', content: prompt }], controller.signal);
        const result = await develop({ task: round.prompt, id: run.id, workspaces, generate,
          signal: controller.signal, cycles: run.maxCycles || 3,
          onProgress: async entry => {
            run.execution ||= [];
            run.execution.push(entry);
            run.progress = { completed: run.execution.length, total: (run.maxCycles || 3) * 2, message: 'Autonomous cycle: ' + (entry.attempt || 1) };
            await saveRun(run);
          } });
        run.development = result;
        round.agents = [];
        round.coordinator = { name: 'Coordinator', model: run.model, status: 'complete',
          answer: result.status === 'complete' ? 'Build and tests passed reviewer check. Inspect mission workspace.' : 'Development stopped after bounded retries. Inspect the execution log.' };
        run.agents = round.agents; run.coordinator = round.coordinator;
        round.status = result.status === 'complete' ? 'complete' : 'partial';
        run.status = round.status; run.finishedAt = new Date().toISOString();
        await saveRun(run);
      } else await executeRound(run, round, presets[run.preset] || presets.general, settings, controller.signal);
    }
    catch (err) { run.status = 'error'; run.error = err.message; run.finishedAt = new Date().toISOString(); await saveRun(run); }
    finally { controllers.delete(run.id); }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // Workspace tools are available only for missions recorded in this installation.
      const workspaceMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/workspace(?:\/(files|file|actions|approvals)(?:\/([^/]+))?)?$/);
      if (workspaceMatch) {
        const [, runId, operation, ticketId] = workspaceMatch;
        if (!await getRun(runId)) return json(res, 404, { error: 'Mission not found.' });
        if (req.method === 'GET' && !operation) return json(res, 200, { files: await workspaces.list(runId), approvals: workspaces.approvals(runId) });
        if (req.method === 'GET' && operation === 'files') return json(res, 200, { files: await workspaces.list(runId) });
        if (req.method === 'GET' && operation === 'file') return json(res, 200, { path: url.searchParams.get('path'), content: await workspaces.read(runId, url.searchParams.get('path')) });
        if (req.method === 'GET' && operation === 'approvals') return json(res, 200, { approvals: workspaces.approvals(runId) });
        if (req.method === 'POST' && operation === 'actions' && !ticketId) {
          const input = await bodyJson(req);
          return json(res, 202, { approval: await workspaces.propose(runId, input.action, input.action === 'write' ? { path: input.path, content: input.content } : { command: input.command }) });
        }
        if (req.method === 'POST' && operation === 'approvals' && ticketId) {
          const input = await bodyJson(req);
          if (typeof input.approve !== 'boolean') return json(res, 400, { error: 'approve must be true or false' });
          if (!workspaces.approvals(runId).some(a => a.id === ticketId)) return json(res, 404, { error: 'Approval not in this mission' });
          return json(res, 200, { approval: await workspaces.decide(ticketId, input.approve) });
        }
        return json(res, 405, { error: 'Unsupported workspace operation.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/presets') {
        return json(res, 200, { presets: Object.entries(presets).map(([id, preset]) => ({ id, name: preset.name, roles: preset.roles.map(({ id: roleId, name, description }) => ({ id: roleId, name, description })) })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, await getSettings(stateDir));
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const input = await bodyJson(req);
        let endpoint;
        try { endpoint = normalizeEndpoint(input.endpoint); }
        catch (err) { return json(res, 400, { error: err.message }); }
        const current = await getSettings(stateDir);
        const next = { ...current, endpoint, model: String(input.model || '').trim(), models: Object.fromEntries(baseRoles.map((role) => [role.id, String(input.models?.[role.id] || '').trim()])), timeoutSeconds: Math.min(600, Math.max(20, Number(input.timeoutSeconds) || 180)) };
        await writeJson(settingsPath, next);
        return json(res, 200, next);
      }
      if (req.method === 'POST' && url.pathname === '/api/models') {
        const input = await bodyJson(req);
        try { const settings = await getSettings(stateDir); const endpoint = input.endpoint ? normalizeEndpoint(input.endpoint) : settings.endpoint; return json(res, 200, { models: await fetchModels({ ...settings, endpoint }) }); }
        catch (err) { return json(res, 502, { error: err.name === 'AbortError' ? 'Ollama did not answer within 12 seconds.' : err.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        try { return json(res, 200, { models: await fetchModels(await getSettings(stateDir)) }); }
        catch (err) { return json(res, 502, { error: err.name === 'AbortError' ? 'Ollama did not answer within 12 seconds.' : err.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, { runs: (await getRuns()).slice(0, 30) });
      if (req.method === 'DELETE' && url.pathname === '/api/runs') {
        for (const controller of controllers.values()) controller.abort();
        const runs = await getRuns();
        for (const run of runs) deletedRuns.add(run.id);
        runs.splice(0); await saveRuns();
        return json(res, 200, { ok: true });
      }
      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const run = await getRun(cancelMatch[1]);
        if (!run) return json(res, 404, { error: 'Mission not found.' });
        const controller = controllers.get(run.id);
        if (controller) { controller.abort(); run.status = 'cancelling'; await saveRun(run); }
        return json(res, 200, { run });
      }
      const followMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/follow-up$/);
      if (req.method === 'POST' && followMatch) {
        const run = await getRun(followMatch[1]);
        if (!run) return json(res, 404, { error: 'Mission not found.' });
        if (controllers.has(run.id) || !['complete', 'partial'].includes(run.status)) return json(res, 409, { error: 'Wait for the current round to finish first.' });
        if (run.rounds.length >= 4) return json(res, 400, { error: 'A mission can have up to four rounds.' });
        const input = await bodyJson(req);
        const prompt = String(input.prompt || '').trim();
        if (!prompt || prompt.length > 4_000) return json(res, 400, { error: 'Enter a follow-up under 4,000 characters.' });
        const previous = run.rounds.at(-1)?.coordinator?.answer || '';
        const round = { number: run.rounds.length + 1, prompt: `Follow-up request: ${prompt}\n\nPrevious coordinator summary:\n${previous}`, agents: [], coordinator: null, status: 'queued', createdAt: new Date().toISOString() };
        run.rounds.push(round); run.status = 'running'; run.finishedAt = null;
        await saveRun(run); void startRound(run, round);
        return json(res, 202, { run });
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (req.method === 'GET' && runMatch) {
        const run = await getRun(runMatch[1]);
        return run ? json(res, 200, { run }) : json(res, 404, { error: 'Mission not found.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const input = await bodyJson(req);
        const task = String(input.task || '').trim();
        const model = String(input.model || '').trim();
        const preset = presets[input.preset] ? input.preset : 'general';
        if (!task) return json(res, 400, { error: 'Describe the job first.' });
        if (task.length > 12_000) return json(res, 400, { error: 'Keep a job under 12,000 characters.' });
        const selectedModels = Object.fromEntries(baseRoles.map((role) => [role.id, String(input.models?.[role.id] || model).trim()]));
        if (!model || Object.values(selectedModels).some((item) => !item)) return json(res, 400, { error: 'Choose a model for the Coordinator and each role.' });
        const run = { id: randomUUID(), task, model, models: selectedModels, preset, autonomous: preset === 'coding' && input.autonomous === true, maxCycles: Math.min(5, Math.max(1, Number(input.maxCycles) || 3)), status: 'running', createdAt: new Date().toISOString(), agents: [], coordinator: null, rounds: [], progress: { completed: 0, total: 4, message: 'Starting crew…' } };
        const first = { number: 1, prompt: task, agents: [], coordinator: null, status: 'queued', createdAt: run.createdAt };
        run.rounds.push(first);
        const runs = await getRuns(); runs.unshift(run); runs.splice(30); await saveRuns();
        await workspaces.dir(run.id);
        void startRound(run, first);
        return json(res, 202, { run });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const html = await readFile(path.join(publicDir, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/')) {
        const name = path.basename(url.pathname);
        if (name === 'app.js' || name === 'styles.css') {
          const file = await readFile(path.join(publicDir, name));
          res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(file);
        }
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (err) { return json(res, err.status || 500, { error: err.message || 'Unexpected server error.' }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? '<server-lan-ip>' : host;
    console.log(`Agent Yard is up at http://${displayHost}:${port}`);
  });
}
