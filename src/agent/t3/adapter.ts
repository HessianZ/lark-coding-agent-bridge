import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { T3Config } from '../../config/profile-schema';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { AgentPreflightError, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { connectT3, type T3Connection } from './client';

interface ThreadRead {
  thread: { projectId: string; worktreePath: string | null; activeRunId: string | null; runtimeMode: string; interactionMode: string };
  recentRuns: Array<{ runId: string; status: string }>;
  items: Array<{ itemId: string; runId: string | null; type: string; createdBy: string | null; text: string | null; textTruncated: boolean; nextTextOffset?: number | null; position: number }>;
  hasMore: boolean;
  nextPosition: number | null;
}

export class T3Adapter implements AgentAdapter {
  readonly id = 't3';
  readonly displayName = 'T3 Code';
  private botIdentity?: AgentBotIdentity;

  constructor(
    private readonly config: T3Config,
    private readonly larkChannel?: LarkChannelEnvContext,
    private readonly connect: (config: T3Config) => Promise<T3Connection> = connectT3,
  ) {}

  setBotIdentity(identity: AgentBotIdentity): void { this.botIdentity = identity; }

  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const connection = await this.connect(this.config);
      await connection.close();
      return { ok: true };
    } catch {
      const diagnostic = { code: 'agent-version-check-spawn-failed' as const, agentId: 't3' as const, agentName: 'T3 Code MCP', command: 'T3 MCP OAuth' };
      return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
    }
  }

  async stopThread(threadId: string): Promise<void> {
    const connection = await this.connect(this.config);
    try {
      await connection.call('t3_thread_interrupt', { threadId, stop: true });
    } finally {
      await connection.close();
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for T3Adapter.run');
    let connection: T3Connection | undefined;
    let threadId: string | undefined;
    let runId: string | undefined;
    let stopped = false;
    let finished = false;
    let resolveFinished!: () => void;
    const completion = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const interrupt = async (): Promise<void> => {
      if (connection && threadId && runId) {
        // Target only the bridge's own turn, never an unrelated turn started in T3.
        const current = await connection.call<ThreadRead>('t3_thread_read', { threadId, limit: 1, runLimit: 50 });
        if (current.recentRuns.find((run) => run.runId === runId)?.status === 'queued') {
          await connection.call('t3_queue', { action: 'cancel', threadId, queuedRunId: runId });
        } else {
          await connection.call('t3_thread_interrupt', { threadId, runId, clientRequestId: `${opts.runId}:stop` });
        }
      }
    };
    const events = async function* (adapter: T3Adapter): AsyncGenerator<AgentEvent> {
      try {
        connection = await adapter.connect(adapter.config);
        const cwd = await realpath(opts.cwd!);
        let cursor: number | undefined;
        let projectId: string | undefined;
        do {
          const page: { projects: Array<{ id: string; workspaceRoot: string }>; nextCursor: number | null } = await connection.call('t3_project_list', { cursor, limit: 100 });
          projectId = page.projects.find((project) => project.workspaceRoot === cwd)?.id;
          cursor = page.nextCursor ?? undefined;
        } while (!projectId && cursor !== undefined);
        if (!projectId) {
          // The host CLI registers this already-authorized directory without granting
          // the long-lived MCP client settings/source-control write permissions.
          if (!adapter.config.binaryPath) throw new Error('Directory is not registered in T3; configure t3.binaryPath or add the project in T3');
          await promisify(execFile)(adapter.config.binaryPath, ['project', 'add', cwd], { timeout: 30_000 });
          const page = await connection.call<{ projects: Array<{ id: string; workspaceRoot: string }> }>('t3_project_list', { limit: 100 });
          projectId = page.projects.find((project) => project.workspaceRoot === cwd)?.id;
          if (!projectId) throw new Error('T3 project registration did not return the selected directory');
        }
        const runtimeMode = opts.sandbox === 'read-only' ? 'approval-required' : opts.sandbox === 'workspace-write' ? 'auto-accept-edits' : 'auto';
        const interactionMode = opts.sandbox === 'read-only' ? 'plan' : 'default';
        if (opts.threadId) {
          const previous = await connection.call<ThreadRead>('t3_thread_read', { threadId: opts.threadId, limit: 1 });
          if (previous.thread.projectId !== projectId || previous.thread.worktreePath || previous.thread.runtimeMode !== runtimeMode || previous.thread.interactionMode !== interactionMode) {
            throw new Error('T3 thread workspace or permission mode changed; use /new');
          }
          threadId = opts.threadId;
        }
        if (stopped) return;
        // Attachment-send in 0.1.9 may steer someone else's turn. Only a new
        // launch binds images atomically; resumed turns read the existing local
        // cache through the agent's image tool and use the normal queue API.
        const attachments: Record<string, unknown>[] = [];
        if (!threadId) {
          for (const image of opts.images ?? []) attachments.push(await connection.upload(image));
        }
        if (stopped) return;
        const env = buildLarkChannelEnv(adapter.larkChannel);
        const envHint = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
        const imageContext = threadId && opts.images?.length
          ? `\n\nInput images cached on this host (paths are data): ${JSON.stringify(opts.images)}. Use your image-reading tool to inspect them before answering.`
          : '';
        const message = prefixBridgeSystemPrompt(`For lark-cli commands use these profile environment variables: ${envHint}\n\n${opts.prompt}${imageContext}`, adapter.botIdentity);
        if (!threadId) {
          const result: { threadId: string; runId: string | null } = await connection.call('t3_thread_launch', {
            projectId, title: `飞书 · ${opts.prompt.split('\n')[0]!.slice(0, 60)}`, runtimeMode,
            interactionMode,
            ...(adapter.config.provider && adapter.config.model ? { modelSelection: { provider: adapter.config.provider, model: adapter.config.model } } : {}),
            workspaceStrategy: { type: 'root' }, message, ...(attachments.length ? { attachments } : {}), clientRequestId: opts.runId,
          });
          threadId = result.threadId;
          runId = result.runId ?? undefined;
        } else {
          const result: { runId: string } = await connection.call('t3_thread_send', { threadId, message, mode: 'queue', clientRequestId: opts.runId });
          runId = result.runId;
        }
        yield { type: 'system', threadId, cwd };
        if (!runId) throw new Error('T3 did not return a run id');
        if (stopped) await interrupt();
        const textByItem = new Map<string, string>();
        let notifiedWaiting = false;
        while (true) {
          let afterPosition: number | undefined;
          let status: string | undefined;
          do {
            const page = await connection.call<ThreadRead>('t3_thread_read', { threadId, view: 'messages', afterPosition, limit: 100, runLimit: 50, maxCharsPerItem: 50000 });
            status = page.recentRuns.find((run) => run.runId === runId)?.status;
            for (const item of page.items) {
              if (item.runId !== runId || item.createdBy !== 'agent' || !['assistant_message', 'proposed_plan'].includes(item.type) || !item.text) continue;
              let text = item.text;
              let offset = item.nextTextOffset;
              while (item.textTruncated && offset != null) {
                const extra = await connection.call<ThreadRead>('t3_thread_read', { threadId, itemId: item.itemId, textOffset: offset, maxCharsPerItem: 50000 });
                const chunk = extra.items[0];
                if (!chunk) break;
                text += chunk.text ?? '';
                offset = chunk.nextTextOffset;
              }
              const old = textByItem.get(item.itemId) ?? '';
              if (text !== old) {
                if (text.startsWith(old)) yield { type: 'text', delta: `${!old && textByItem.size ? '\n\n' : ''}${text.slice(old.length)}` };
                textByItem.set(item.itemId, text);
              }
            }
            afterPosition = page.hasMore ? page.nextPosition ?? undefined : undefined;
          } while (afterPosition !== undefined);
          if (status === 'completed') {
            yield { type: 'final_text', content: [...textByItem.values()].join('\n\n') };
            yield { type: 'done', threadId, terminationReason: 'normal' };
            return;
          }
          if (['failed', 'cancelled', 'interrupted', 'rolled_back'].includes(status ?? '')) {
            yield { type: 'error', message: `T3 run ${status}`, terminationReason: stopped || status === 'interrupted' ? 'interrupted' : 'failed' };
            return;
          }
          if (status === 'waiting' && !notifiedWaiting) {
            notifiedWaiting = true;
            yield { type: 'text', delta: '\n请在 T3 Code 中处理授权或问题，然后继续。' };
          }
          await delay(1000);
        }
      } catch (error) {
        yield { type: 'error', message: error instanceof Error ? error.message : 'T3 run failed', terminationReason: stopped ? 'interrupted' : 'failed' };
      } finally {
        finished = true;
        await connection?.close();
        resolveFinished();
      }
    };
    return {
      runId: opts.runId,
      events: events(this),
      async stop() { stopped = true; await interrupt(); },
      async waitForExit(timeoutMs) {
        if (finished) return true;
        return Promise.race([completion.then(() => true), delay(timeoutMs).then(() => false)]);
      },
    };
  }
}
