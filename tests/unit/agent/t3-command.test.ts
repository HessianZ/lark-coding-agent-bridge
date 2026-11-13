import { describe, expect, it, vi } from 'vitest';
import { runCommandHandler, type CommandContext } from '../../../src/commands';

describe('T3 recovery commands', () => {
  it('starts a new local mapping even if the old remote thread cannot be stopped', async () => {
    const send = vi.fn(async () => {});
    const archiveActive = vi.fn();
    const clear = vi.fn();
    const ctx = {
      scope: 'chat', msg: { chatId: 'chat', messageId: 'msg', senderId: 'owner' },
      channel: { send }, activeRuns: { interrupt: () => false },
      agent: { stopThread: async () => { throw new Error('remote unavailable'); } },
      sessionCatalogIdentity: { scopeId: 'chat', agentId: 't3', cwdRealpath: '/repo', policyFingerprint: 'policy' },
      sessionCatalog: { activeFor: () => ({ threadId: 'old-t3' }), archiveActive },
      sessions: { clear }, controls: { profileConfig: { access: { admins: [] } } },
    } as unknown as CommandContext;
    expect(await runCommandHandler('new', '', ctx)).toBe(true);
    expect(archiveActive).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith('chat');
    expect(send).toHaveBeenCalledWith('chat', expect.objectContaining({ markdown: expect.stringContaining('原 T3 任务未能停止') }), expect.anything());
  });
});
