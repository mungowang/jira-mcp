import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Start the MCP server over stdio and return a minimal JSON-RPC client. */
export async function startServer(env = {}, { timeoutMs = 30_000, cwd = ROOT } = {}) {
  const proc = spawn(process.execPath, [resolve(ROOT, 'src/index.ts')], {
    cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const slot = pending.get(msg.id);
    if (slot) { pending.delete(msg.id); slot(msg); }
  });

  const request = (method, params) => new Promise((ok, fail) => {
    const id = nextId++;
    const timer = setTimeout(() => { if (pending.delete(id)) fail(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); ok(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harness', version: '0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    proc,
    stderr: () => stderr,
    stop: () => proc.kill(),
    listTools: async () => (await request('tools/list', {})).result.tools,
    callTool: async (name, args = {}) => {
      const r = await request('tools/call', { name, arguments: args });
      if (r.error) return { ok: false, text: r.error.message ?? JSON.stringify(r.error) };
      const text = (r.result.content ?? []).map((c) => c.text).join('\n');
      return { ok: !r.result.isError, text, structuredContent: r.result.structuredContent };
    },
  };
}

export const isReadOnly = (t) => !!(t.annotations ?? {}).readOnlyHint;
