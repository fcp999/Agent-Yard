import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const commands = {
  test: ['npm', ['test', '--', '--runInBand']],
  'node-test': ['node', ['--test']],
  'git-status': ['git', ['status', '--short']],
  'git-diff': ['git', ['diff', '--']],
};
export function workspaceManager(stateDir) {
  const root = path.join(stateDir, 'workspaces');
  const pending = new Map();
  const auditFile = path.join(stateDir, 'workspace-audit.jsonl');
  let auditQueue = Promise.resolve();
  async function audit(event) {
    const { appendFile } = await import('node:fs/promises');
    auditQueue = auditQueue.catch(() => {}).then(async () => {
      await mkdir(stateDir, { recursive: true });
      await appendFile(auditFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
    });
    await auditQueue;
  }
  function validId(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error('Invalid mission ID'), { status: 400 });
    return id;
  }
  async function dir(id) {
    const target = path.join(root, validId(id));
    await mkdir(target, { recursive: true });
    return target;
  }
  async function resolve(id, relative, mustExist = false) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative)) throw Object.assign(new Error('Invalid relative path'), { status: 400 });
    const pieces = relative.split('/');
    if (pieces.some(x => !x || x === '.' || x === '..' || x === '.git')) throw Object.assign(new Error('Unsafe path'), { status: 400 });
    const base = await dir(id);
    let current = base;
    for (const part of pieces) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw Object.assign(new Error('Symlinks are not permitted'), { status: 400 });
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (mustExist) throw Object.assign(new Error('File not found'), { status: 404 });
      }
    }
    return current;
  }
  async function list(id) {
    const base = await dir(id);
    const entries = [];
    async function visit(parent, prefix = '', depth = 0) {
      if (depth >= 5 || entries.length >= 250) return;
      for (const ent of await readdir(parent, { withFileTypes: true })) {
        if (ent.isSymbolicLink()) continue;
        const name = prefix ? prefix + '/' + ent.name : ent.name;
        entries.push({ path: name, type: ent.isDirectory() ? 'directory' : 'file' });
        if (ent.isDirectory()) await visit(path.join(parent, ent.name), name, depth + 1);
        if (entries.length >= 250) break;
      }
    }
    await visit(base);
    return entries;
  }
  async function read(id, relative) {
    const file = await resolve(id, relative, true);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 256_000) throw Object.assign(new Error('Not a readable text file (256 KB limit)'), { status: 400 });
    return await readFile(file, 'utf8');
  }
  async function propose(id, action, details) {
    validId(id);
    if (action === 'write') {
      await resolve(id, details.path);
      if (typeof details.content !== 'string' || Buffer.byteLength(details.content) > 256_000) throw Object.assign(new Error('Text content required (256 KB maximum)'), { status: 400 });
    } else if (action === 'command') {
      if (!Object.hasOwn(commands, details.command)) throw Object.assign(new Error('Command not permitted'), { status: 400 });
    } else throw Object.assign(new Error('Unsupported action'), { status: 400 });
    const ticket = { id: randomUUID(), runId: id, action, details, status: 'pending', createdAt: new Date().toISOString() };
    pending.set(ticket.id, ticket);
    await audit({ type: 'proposed', ticketId: ticket.id, runId: id, action, path: details.path, command: details.command });
    return summary(ticket);
  }
  function summary(t) { return { id: t.id, runId: t.runId, action: t.action, status: t.status, createdAt: t.createdAt, path: t.details.path, command: t.details.command, contentPreview: t.action === 'write' ? t.details.content.slice(0, 1000) : undefined, result: t.result }; }
  async function decide(id, approved) {
    const t = pending.get(id);
    if (!t) throw Object.assign(new Error('Approval not found or expired'), { status: 404 });
    if (t.status !== 'pending') throw Object.assign(new Error('Already decided'), { status: 409 });
    t.status = approved ? 'executing' : 'rejected';
    await audit({ type: approved ? 'approved' : 'rejected', ticketId: id, runId: t.runId });
    if (!approved) return summary(t);
    try {
      if (t.action === 'write') {
        const file = await resolve(t.runId, t.details.path);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, t.details.content, { flag: 'w' });
        t.result = 'Saved ' + t.details.path;
      } else {
        const [binary, args] = commands[t.details.command];
        const { stdout, stderr } = await execFileAsync(binary, args, { cwd: await dir(t.runId), timeout: 30000, maxBuffer: 256000, shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1' } });
        t.result = (stdout + stderr).slice(0, 12000);
      }
      t.status = 'complete';
    } catch (e) { t.status = 'error'; t.result = String(e.message).slice(0, 12000); }
    await audit({ type: t.status, ticketId: id, runId: t.runId });
    return summary(t);
  }
  return { dir, list, read, propose, decide, approvals: id => [...pending.values()].filter(x => x.runId === id).map(summary) };
}
