import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { T3Adapter } from '../../../src/agent/t3/adapter';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { profileCapability } from '../../../src/agent/capability';
import { SessionCatalog } from '../../../src/session/catalog';
import type { T3Connection } from '../../../src/agent/t3/client';
import type { AgentEvent } from '../../../src/agent/types';

const config = { endpoint: 'http://127.0.0.1:3773/mcp', tokenFile: '/secret/oauth.json', environmentId: 'host' };
function fixture(status = 'completed') {
  const call = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === 't3_project_list') return { projects: [{ id: 'project', workspaceRoot: process.cwd() }], nextCursor: null };
    if (name === 't3_thread_launch') return { threadId: 't3-thread', runId: 't3-run' };
    if (name === 't3_thread_send' || name === 't3_thread_send_attachments') return { runId: 't3-run' };
    if (name === 't3_thread_interrupt' || name === 't3_queue') return { status: 'interrupt_requested' };
    if (name === 't3_thread_read') return {
      thread: { projectId: 'project', worktreePath: null, activeRunId: null, runtimeMode: 'auto', interactionMode: 'default' },
      recentRuns: [{ runId: 't3-run', status }],
      items: [{ itemId: 'answer', runId: 't3-run', type: 'assistant_message', createdBy: 'agent', text: 'hello', textTruncated: false }],
      hasMore: false, nextPosition: null,
    };
    throw new Error(`unexpected ${name} ${JSON.stringify(args)}`);
  });
  const close = vi.fn(async () => {});
  const upload = vi.fn(async () => ({ id: 'image', type: 'image', name: 'x.png', mimeType: 'image/png', sizeBytes: 1 }));
  const connect = async (): Promise<T3Connection> => ({ call: call as T3Connection['call'], close, upload });
  return { call, close, upload, adapter: new T3Adapter(config, undefined, connect) };
}
async function drain(events: AsyncIterable<AgentEvent>) { const output = []; for await (const event of events) output.push(event); return output; }

describe('T3 backend', () => {
  it('normalizes an explicit T3 profile without a Codex configuration', () => {
    const profile = createDefaultProfileConfig({ agentKind: 't3', t3: config, accounts: { app: { id: 'bot', secret: 'test', tenant: 'feishu' } } });
    expect(profile.t3).toEqual(config);
    expect(profileCapability(profile).agentId).toBe('t3');
    expect(() => createDefaultProfileConfig({ agentKind: 't3', accounts: profile.accounts })).toThrow('t3 profile requires');
  });
  it('creates a visible T3 thread and emits persistent identity and final output', async () => {
    const f = fixture();
    const run = f.adapter.run({ runId: 'bridge-run', cwd: process.cwd(), prompt: 'test', images: ['/cache/image.png'], sandbox: 'danger-full-access' });
    const output = await drain(run.events);
    expect(f.call).toHaveBeenCalledWith('t3_thread_launch', expect.objectContaining({ runtimeMode: 'auto', interactionMode: 'default', projectId: 'project', attachments: [expect.objectContaining({ id: 'image' })], clientRequestId: 'bridge-run' }));
    expect(output).toContainEqual({ type: 'system', threadId: 't3-thread', cwd: process.cwd() });
    expect(output).toContainEqual({ type: 'final_text', content: 'hello' });
    expect(output.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(await run.waitForExit(1)).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('continues the same thread and supplies cached image paths in its queued turn', async () => {
    const f = fixture();
    await drain(f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'next', threadId: 'existing-t3', images: ['/cache/image.png'] }).events);
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.call).toHaveBeenCalledWith('t3_thread_send', expect.objectContaining({ threadId: 'existing-t3', mode: 'queue', message: expect.stringContaining('/cache/image.png') }));
    expect(f.call.mock.calls.some(([name]) => name === 't3_thread_launch')).toBe(false);
  });
  it('rejects resumed threads whose directory or permission mode changed in T3', async () => {
    const f = fixture();
    const output = await drain(f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'next', threadId: 'old', sandbox: 'read-only' }).events);
    expect(output.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('workspace or permission') });
    expect(f.call.mock.calls.some(([name]) => name === 't3_thread_send')).toBe(false);
  });
  it('can stop a persisted remote thread after a restart', async () => {
    const f = fixture();
    await f.adapter.stopThread('persisted-t3');
    expect(f.call).toHaveBeenCalledWith('t3_thread_interrupt', { threadId: 'persisted-t3', stop: true });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('cancels its queued turn without interrupting the active UI turn', async () => {
    const f = fixture('queued');
    const run = f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'test', threadId: 'existing-t3' });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    await run.stop();
    expect(f.call).toHaveBeenCalledWith('t3_queue', { action: 'cancel', threadId: 'existing-t3', queuedRunId: 't3-run' });
    expect(f.call.mock.calls.some(([name]) => name === 't3_thread_interrupt')).toBe(false);
    f.call.mockImplementation(async () => ({ thread: {}, recentRuns: [{ runId: 't3-run', status: 'cancelled' }], items: [], hasMore: false, nextPosition: null }));
    await drain({ [Symbol.asyncIterator]: () => iterator });
  });
  it('queues images independently while a UI task runs, never acquiring its run id', async () => {
    const f = fixture('queued');
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => {
      const result = await original(name, args) as any;
      if (name === 't3_thread_read') result.thread.activeRunId = 'ui-run';
      return result;
    });
    const run = f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'image', threadId: 'existing-t3', images: ['/cache/image.png'] });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'system' });
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.call).toHaveBeenCalledWith('t3_thread_send', expect.objectContaining({ mode: 'queue', message: expect.stringContaining('/cache/image.png') }));
    await run.stop();
    expect(f.call).toHaveBeenCalledWith('t3_queue', { action: 'cancel', threadId: 'existing-t3', queuedRunId: 't3-run' });
    expect(f.call.mock.calls.some(([name]) => name === 't3_thread_send_attachments' || name === 't3_thread_interrupt')).toBe(false);
    await iterator.return?.();
  });
  it('returns a native proposed plan as its final output', async () => {
    const f = fixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => {
      const result = await original(name, args) as any;
      if (name === 't3_thread_read') result.items[0].type = 'proposed_plan';
      return result;
    });
    const events = await drain(f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'test' }).events);
    expect(events).toContainEqual({ type: 'final_text', content: 'hello' });
  });
  it('rejects an interaction mode changed in the T3 app', async () => {
    const f = fixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args) => {
      const result = await original(name, args) as any;
      if (name === 't3_thread_read') result.thread.runtimeMode = 'approval-required';
      return result;
    });
    const events = await drain(f.adapter.run({ runId: 'r', cwd: process.cwd(), threadId: 'old', prompt: 'test', sandbox: 'read-only' }).events);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('permission mode changed') });
  });
  it('reports failures and closes the MCP connection', async () => {
    const f = fixture('failed');
    const output = await drain(f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'test' }).events);
    expect(output.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('stops only its own T3 run, including a stop during launch', async () => {
    const f = fixture('interrupted');
    const run = f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'test' });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'system' });
    await run.stop();
    expect(f.call).toHaveBeenCalledWith('t3_thread_interrupt', { threadId: 't3-thread', runId: 't3-run', clientRequestId: 'r:stop' });
    await drain({ [Symbol.asyncIterator]: () => iterator });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('does not launch anything when stopped before event consumption', async () => {
    const f = fixture();
    const run = f.adapter.run({ runId: 'r', cwd: process.cwd(), prompt: 'test' });
    await run.stop();
    await drain(run.events);
    expect(f.call.mock.calls.some(([name]) => name === 't3_thread_launch')).toBe(false);
  });
  it('isolates persisted T3 mappings from Codex, other chats, directories and policies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-t3-catalog-'));
    const path = join(directory, 'catalog.json');
    const catalog = new SessionCatalog(path);
    const identity = { scopeId: 'chat', agentId: 't3' as const, cwdRealpath: '/repo', policyFingerprint: 'policy' };
    catalog.upsertActive({ ...identity, threadId: 't3-thread' });
    for (const change of [{ agentId: 'codex' as const }, { scopeId: 'other' }, { cwdRealpath: '/elsewhere' }, { policyFingerprint: 'changed' }]) {
      expect(catalog.activeFor({ ...identity, ...change })).toBeUndefined();
    }
    expect(catalog.activeFor(identity)?.threadId).toBe('t3-thread');
    await catalog.flush();
    const reloaded = new SessionCatalog(path);
    await reloaded.load();
    expect(reloaded.activeFor(identity)?.threadId).toBe('t3-thread');
    catalog.archiveActive(identity);
    expect(catalog.activeFor(identity)).toBeUndefined();
    await catalog.flush();
    await rm(directory, { recursive: true });
  });
});
