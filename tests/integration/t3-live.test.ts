import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { T3Adapter } from '../../src/agent/t3/adapter';
import type { AgentEvent } from '../../src/agent/types';

// Explicit opt-in: creates real T3 test threads and incurs provider usage.
describe.skipIf(!process.env.LARK_T3_LIVE)('T3 host integration', () => {
  it('creates and continues the same real thread', async () => {
    const adapter = new T3Adapter({
      binaryPath: '/Users/hessian/.t3/bin/t3', runtimeFile: process.env.LARK_T3_RUNTIME!, tokenFile: process.env.LARK_T3_TOKEN!,
      environmentId: process.env.LARK_T3_ENVIRONMENT!, provider: 'codex', model: 'gpt-6.1-sol',
    });
    const cwd = process.env.LARK_T3_CWD!;
    const events: AgentEvent[] = [];
    for await (const event of adapter.run({ runId: `bridge-live-${Date.now()}`, cwd, images: process.env.LARK_T3_IMAGE ? [process.env.LARK_T3_IMAGE] : undefined, prompt: '这是飞书 Bridge 接入自测。不要使用工具、创建文件或联系任何人。只回复 BRIDGE_T3_FIRST_OK。', sandbox: 'workspace-write' }).events) events.push(event);
    await writeFile('/private/tmp/lark-t3-live-result.json', JSON.stringify(events, null, 2));
    expect(events.at(-1)?.type).toBe('done');
    const system = events.find((event) => event.type === 'system');
    if (!system || system.type !== 'system' || !system.threadId) throw new Error('no T3 identity');
    const resumed: AgentEvent[] = [];
    for await (const event of adapter.run({ runId: `bridge-resume-${Date.now()}`, cwd, threadId: system.threadId, prompt: '继续接入自测。不要使用工具。回复上一条自测要求的标记，并加上 RESUME_OK。', sandbox: 'workspace-write' }).events) resumed.push(event);
    await writeFile('/private/tmp/lark-t3-live-result.json', JSON.stringify({ events, resumed }, null, 2));
    expect(resumed.at(-1)?.type).toBe('done');
    expect(resumed.find((event) => event.type === 'final_text')).toMatchObject({ content: expect.stringContaining('RESUME_OK') });
    if (process.env.LARK_T3_IMAGE) {
      const imageEvents: AgentEvent[] = [];
      for await (const event of adapter.run({ runId: `bridge-image-${Date.now()}`, cwd, threadId: system.threadId, images: [process.env.LARK_T3_IMAGE], prompt: '图片输入自测。用图片读取工具查看输入的缓存图片，只回复 IMAGE_OK 和图片主色。不要修改文件或联系任何人。', sandbox: 'workspace-write' }).events) imageEvents.push(event);
      expect(imageEvents.at(-1)?.type).toBe('done');
      expect(imageEvents.find((event) => event.type === 'final_text')).toMatchObject({ content: expect.stringContaining('IMAGE_OK') });
      const stopRun = adapter.run({ runId: `bridge-stop-${Date.now()}`, cwd, threadId: system.threadId, prompt: '停止按钮自测。不要使用工具。列出 1 到 2000 的整数。', sandbox: 'workspace-write' });
      const iterator = stopRun.events[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: 'system' });
      await stopRun.stop();
      const stopped: AgentEvent[] = [];
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) stopped.push(event);
      expect(stopped.at(-1)).toMatchObject({ type: 'error', terminationReason: 'interrupted' });
      await writeFile('/private/tmp/lark-t3-live-result.json', JSON.stringify({ events, resumed, imageEvents, stopped }, null, 2));
    }
  }, 180000);
});
