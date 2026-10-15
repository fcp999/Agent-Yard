import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = path.join(here, 'data');
const defaultSettings = { endpoint: 'http://127.0.0.1:11434', model: '', models: {}, timeoutSeconds: 180 };
const roles = [
  { id: 'architect', name: 'Architect', mark: '01', prompt: 'You are the architect. Analyze the request, identify the goal and constraints, and propose a concise implementation plan. Do not claim to have changed files or run commands.' },
  { id: 'builder', name: 'Builder', mark: '02', prompt: 'You are the builder. Turn the request into a concrete solution outline with files, interfaces, and implementation details. Do not claim to have changed files or run commands.' },
  { id: 'reviewer', name: 'Reviewer', mark: '03', prompt: 'You are the skeptical reviewer. Find ambiguity, failure cases, security concerns, and the smallest useful verification plan. Do not claim to have changed files or run commands.' }
];

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

async function askModel(settings, model, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(20, Number(settings.timeoutSeconds) || 180) * 1000);
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
  } finally { clearTimeout(timer); }
}

export function createServer({ stateDir = dataDir } = {}) {
  const currentSettingsPath = path.join(stateDir, 'settings.json');
  const currentHistoryPath = path.join(stateDir, 'runs.json');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const settings = await getSettings(stateDir);
        return json(res, 200, settings);
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const input = await bodyJson(req);
        let endpoint;
        try { endpoint = normalizeEndpoint(input.endpoint); }
        catch (err) { return json(res, 400, { error: err.message }); }
        const current = await getSettings(stateDir);
        const next = {
          ...current,
          endpoint,
          model: String(input.model || '').trim(),
          models: Object.fromEntries(roles.map((role) => [role.id, String(input.models?.[role.id] || '').trim()])),
          timeoutSeconds: Math.min(600, Math.max(20, Number(input.timeoutSeconds) || 180))
        };
        await writeJson(currentSettingsPath, next);
        return json(res, 200, next);
      }
      if (req.method === 'POST' && url.pathname === '/api/models') {
        const input = await bodyJson(req);
        try {
          const settings = await getSettings(stateDir);
          const endpoint = input.endpoint ? normalizeEndpoint(input.endpoint) : settings.endpoint;
          return json(res, 200, { models: await fetchModels({ ...settings, endpoint }) });
        } catch (err) { return json(res, 502, { error: err.name === 'AbortError' ? 'Ollama did not answer within 12 seconds.' : err.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        try { return json(res, 200, { models: await fetchModels(await getSettings(stateDir)) }); }
        catch (err) { return json(res, 502, { error: err.name === 'AbortError' ? 'Ollama did not answer within 12 seconds.' : err.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const runs = await readJson(currentHistoryPath, []);
        return json(res, 200, { runs: runs.slice(0, 30) });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/runs') {
        await writeJson(currentHistoryPath, []);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const input = await bodyJson(req);
        const task = String(input.task || '').trim();
        const model = String(input.model || '').trim();
        if (!task) return json(res, 400, { error: 'Describe the job first.' });
        if (task.length > 12_000) return json(res, 400, { error: 'Keep a job under 12,000 characters.' });
        const selectedModels = Object.fromEntries(roles.map((role) => [role.id, String(input.models?.[role.id] || model).trim()]));
        if (Object.values(selectedModels).some((item) => !item)) return json(res, 400, { error: 'Choose an Ollama model for each role.' });
        const settings = await getSettings(stateDir);
        const run = { id: randomUUID(), task, model, models: selectedModels, status: 'running', createdAt: new Date().toISOString(), agents: [] };
        const runs = await readJson(currentHistoryPath, []);
        runs.unshift(run);
        await writeJson(currentHistoryPath, runs.slice(0, 30));
        const results = await Promise.all(roles.map(async (role) => {
          const roleModel = selectedModels[role.id];
          try {
            const answer = await askModel(settings, roleModel, [
              { role: 'system', content: `${role.prompt}\n\nYou are part of Agent Yard, a local-first multi-agent workbench. Be direct and useful.` },
              { role: 'user', content: task }
            ]);
            return { ...role, model: roleModel, status: 'complete', answer };
          } catch (err) { return { ...role, model: roleModel, status: 'error', answer: err.name === 'AbortError' ? 'Timed out. Increase the timeout or try a smaller model.' : err.message }; }
        }));
        run.agents = results;
        run.status = results.every((r) => r.status === 'complete') ? 'complete' : 'partial';
        run.finishedAt = new Date().toISOString();
        const saved = await readJson(currentHistoryPath, []);
        const index = saved.findIndex((r) => r.id === run.id);
        if (index >= 0) saved[index] = run;
        await writeJson(currentHistoryPath, saved.slice(0, 30));
        return json(res, 200, { run });
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
    } catch (err) {
      return json(res, err.status || 500, { error: err.message || 'Unexpected server error.' });
    }
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
