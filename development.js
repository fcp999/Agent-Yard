// Executes a finite plan/build/test/review cycle with the existing workspace API.
export async function develop({ task, id, workspaces, generate, onProgress, signal, cycles = 3 }) {
  const history = [];
  const plan = await generate('architect', task);
  for (let attempt = 1; attempt <= Math.min(5, cycles); attempt++) {
    if (signal.aborted) throw new Error('Mission cancelled');
    const files = (await workspaces.list(id)).filter(f => f.type === 'file').slice(0, 20);
    const existing = await Promise.all(files.map(async f => ({ path: f.path, content: (await workspaces.read(id, f.path)).slice(0, 8000) })));
    const output = await generate('builder', JSON.stringify({ task, plan, existing, history,
      format: 'Return JSON only: {"files":[{"path":"relative/path","content":"complete file text"}],"notes":"summary"}' }));
    const obj = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
    if (!Array.isArray(obj.files) || obj.files.length > 12) throw new Error('Builder must return up to 12 files');
    const changed = [];
    for (const file of obj.files) {
      if (typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Invalid file');
      const ticket = await workspaces.propose(id, 'write', file);
      const outcome = await workspaces.decide(ticket.id, true);
      if (outcome.status !== 'complete') throw new Error(outcome.result || 'Write failed');
      changed.push(file.path);
    }
    await onProgress({ attempt, action: 'write', files: changed });
    const ticket = await workspaces.propose(id, 'command', { command: 'node-test' });
    const result = await workspaces.decide(ticket.id, true);
    const reviewText = await generate('reviewer', JSON.stringify({ task, plan, changed, result }));
    const review = JSON.parse(reviewText.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
    const entry = { attempt, files: changed, test: result.status, testOutput: result.result, review };
    history.push(entry);
    await onProgress(entry);
    if (result.status === 'complete' && review.pass === true) return { status: 'complete', plan, history };
  }
  return { status: 'needs-review', plan, history };
}
