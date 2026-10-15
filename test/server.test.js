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

test('local mission flow discovers models, runs three roles, saves history, and clears it', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agent-yard-test-'));
  const requests = [];
  const ollama = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'test-model:latest', details: { parameter_size: '8B' } }] }));
    }
    if (req.url === '/api/chat' && req.method === 'POST') {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push({ prompt: body.messages[0].content, model: body.model });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: { content: `Answer ${requests.length}` } }));
    }
    res.writeHead(404).end();
  });
  const ollamaUrl = await listen(ollama);
  const app = createServer({ stateDir });
  const appUrl = await listen(app);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => ollama.close(resolve))]);
    await rm(stateDir, { recursive: true, force: true });
  });

  const savedSettings = await fetch(`${appUrl}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: ollamaUrl, model: 'test-model:latest', timeoutSeconds: 60 })
  }).then((r) => r.json());
  assert.equal(savedSettings.endpoint, ollamaUrl);
  const models = await fetch(`${appUrl}/api/models`).then((r) => r.json());
  assert.equal(models.models[0].id, 'test-model:latest');

  const response = await fetch(`${appUrl}/api/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Build a small test feature.', model: 'test-model:latest', models: { architect: 'planner:latest', builder: 'coder:latest', reviewer: 'critic:latest' } })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.run.status, 'complete');
  assert.equal(result.run.agents.length, 3);
  assert.equal(requests.length, 3);
  assert.match(requests.map((r) => r.prompt).join('\n'), /architect/i);
  assert.match(requests.map((r) => r.prompt).join('\n'), /builder/i);
  assert.match(requests.map((r) => r.prompt).join('\n'), /reviewer/i);
  assert.deepEqual(new Set(requests.map((r) => r.model)), new Set(['planner:latest', 'coder:latest', 'critic:latest']));

  const history = await fetch(`${appUrl}/api/runs`).then((r) => r.json());
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].task, 'Build a small test feature.');

  await fetch(`${appUrl}/api/runs`, { method: 'DELETE' });
  const empty = await fetch(`${appUrl}/api/runs`).then((r) => r.json());
  assert.equal(empty.runs.length, 0);
});

test('rejects invalid endpoint schemes and empty missions', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agent-yard-test-'));
  const app = createServer({ stateDir });
  const appUrl = await listen(app);
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(stateDir, { recursive: true, force: true }); });

  const badSettings = await fetch(`${appUrl}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'file:///etc/passwd' })
  });
  assert.equal(badSettings.status, 400);

  const emptyMission = await fetch(`${appUrl}/api/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: '', model: 'anything' })
  });
  assert.equal(emptyMission.status, 400);
});
