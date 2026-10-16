import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from '../server.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitForRun(base, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { run } = await fetch(`${base}/api/runs/${id}`).then((response) => response.json());
    if (!['running', 'cancelling'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Mission did not finish in time.');
}

function mockOllama({ delay = 0 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'test-model:latest', details: { parameter_size: '8B' } }] }));
    }
    if (req.url === '/api/chat' && req.method === 'POST') {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const answer = body.messages[0].content.includes('Coordinator') ? `Synthesis ${requests.length}` : `Answer ${requests.length}`;
      return setTimeout(() => {
        if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: { content: answer } })); }
      }, delay);
    }
    res.writeHead(404).end();
  });
  return { server, requests };
}

test('mission runs three preset roles, synthesizes, supports follow-up, and saves history', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agent-yard-test-'));
  const ollama = mockOllama();
  const ollamaUrl = await listen(ollama.server);
  const app = createServer({ stateDir });
  const appUrl = await listen(app);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => ollama.server.close(resolve))]);
    await rm(stateDir, { recursive: true, force: true });
  });

  const savedSettings = await fetch(`${appUrl}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: ollamaUrl, model: 'test-model:latest', timeoutSeconds: 60 })
  }).then((r) => r.json());
  assert.equal(savedSettings.endpoint, ollamaUrl);
  const models = await fetch(`${appUrl}/api/models`).then((r) => r.json());
  assert.equal(models.models[0].id, 'test-model:latest');
  const presets = await fetch(`${appUrl}/api/presets`).then((r) => r.json());
  assert.deepEqual(presets.presets.map((preset) => preset.id), ['general', 'coding', 'troubleshoot', 'research']);

  const response = await fetch(`${appUrl}/api/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Build a small test feature.', preset: 'coding', model: 'test-model:latest', models: { architect: 'planner:latest', builder: 'coder:latest', reviewer: 'critic:latest' } })
  });
  assert.equal(response.status, 202);
  const { run: started } = await response.json();
  const first = await waitForRun(appUrl, started.id);
  assert.equal(first.status, 'complete');
  assert.equal(first.preset, 'coding');
  assert.equal(first.agents.length, 3);
  assert.equal(first.rounds[0].coordinator.status, 'complete');
  assert.equal(ollama.requests.length, 4);
  assert.match(first.agents.map((agent) => agent.name).join(' '), /Planner Builder Tester/);
  assert.deepEqual(new Set(ollama.requests.slice(0, 3).map((request) => request.model)), new Set(['planner:latest', 'coder:latest', 'critic:latest']));

  const followup = await fetch(`${appUrl}/api/runs/${first.id}/follow-up`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Now identify the smallest safe first implementation.' })
  });
  assert.equal(followup.status, 202);
  const second = await waitForRun(appUrl, first.id);
  assert.equal(second.status, 'complete');
  assert.equal(second.rounds.length, 2);
  assert.match(second.rounds[1].prompt, /Previous coordinator summary/);
  assert.equal(ollama.requests.length, 8);

  const history = await fetch(`${appUrl}/api/runs`).then((r) => r.json());
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].rounds.length, 2);
  await fetch(`${appUrl}/api/runs`, { method: 'DELETE' });
  const empty = await fetch(`${appUrl}/api/runs`).then((r) => r.json());
  assert.equal(empty.runs.length, 0);
});

test('mission can be cancelled while agents are working', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agent-yard-test-'));
  const ollama = mockOllama({ delay: 100 });
  const ollamaUrl = await listen(ollama.server);
  const app = createServer({ stateDir });
  const appUrl = await listen(app);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => ollama.server.close(resolve))]);
    await rm(stateDir, { recursive: true, force: true });
  });
  await fetch(`${appUrl}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: ollamaUrl }) });
  const started = await fetch(`${appUrl}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'Cancel this test.', model: 'test-model' }) }).then((r) => r.json());
  const cancel = await fetch(`${appUrl}/api/runs/${started.run.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  const final = await waitForRun(appUrl, started.run.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.rounds[0].coordinator.status, 'cancelled');
});

test('clearing history during an active mission does not resurrect it', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agent-yard-test-'));
  const ollama = mockOllama({ delay: 100 }); const ollamaUrl = await listen(ollama.server);
  const app = createServer({ stateDir }); const appUrl = await listen(app);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => ollama.server.close(resolve))]);
    await rm(stateDir, { recursive: true, force: true });
  });
  await fetch(`${appUrl}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: ollamaUrl }) });
  await fetch(`${appUrl}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'Clear this active mission.', model: 'test-model' }) });
  await fetch(`${appUrl}/api/runs`, { method: 'DELETE' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const history = await fetch(`${appUrl}/api/runs`).then((response) => response.json());
  assert.equal(history.runs.length, 0);
});

test('rejects invalid endpoint schemes and empty missions', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agent-yard-test-'));
  const app = createServer({ stateDir }); const appUrl = await listen(app);
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(stateDir, { recursive: true, force: true }); });
  const badSettings = await fetch(`${appUrl}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'file:///etc/passwd' }) });
  assert.equal(badSettings.status, 400);
  const emptyMission = await fetch(`${appUrl}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: '', model: 'anything' }) });
  assert.equal(emptyMission.status, 400);
});
