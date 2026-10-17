import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { workspaceManager } from '../workspace.js';

test('workspace writes require approval and reads stay within mission', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'yard-work-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const manager = workspaceManager(stateDir);
  const id = '12345678-1234-1234-1234-123456789abc';
  const ticket = await manager.propose(id, 'write', { path: 'src/hello.txt', content: 'test value' });
  assert.equal(ticket.status, 'pending');
  await assert.rejects(manager.read(id, 'src/hello.txt'));
  assert.equal((await manager.decide(ticket.id, true)).status, 'complete');
  assert.equal(await manager.read(id, 'src/hello.txt'), 'test value');
  assert.ok((await manager.list(id)).some(x => x.path === 'src/hello.txt'));
  for (const unsafe of ['../outside', '/tmp/bad', 'src/../../bad', '.git/config', 'src//bad']) {
    await assert.rejects(manager.propose(id, 'write', { path: unsafe, content: 'oops' }));
  }
});

test('reject and allowlist enforce explicit tool authorization', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'yard-work-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const manager = workspaceManager(stateDir);
  const id = '12345678-1234-1234-1234-123456789abc';
  await assert.rejects(manager.propose(id, 'command', { command: 'rm -rf /' }));
  const ticket = await manager.propose(id, 'write', { path: 'untouched.txt', content: 'not saved' });
  assert.equal((await manager.decide(ticket.id, false)).status, 'rejected');
  await assert.rejects(manager.read(id, 'untouched.txt'));
  await assert.rejects(manager.decide(ticket.id, true));
});
