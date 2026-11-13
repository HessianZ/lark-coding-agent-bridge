import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { promptSection, type BridgePromptAttachment } from '../prompt';
import type { AgentBotIdentity } from '../types';

/** Keep the T3 message preview readable while retaining the bridge's routing data. */
export function buildT3Message(
  prompt: string,
  identity: AgentBotIdentity | undefined,
  env: NodeJS.ProcessEnv,
  imageContext: string,
): { message: string; title: string } {
  let text = prompt;
  let context = '';
  // buildAgentPrompt owns this JSON envelope and escapes embedded closing tags.
  const inputSection = /<user_input>\n([\s\S]*?)\n<\/user_input>$/.exec(prompt);
  if (inputSection) {
    const input = JSON.parse(inputSection[1]!) as { text: string; attachments?: BridgePromptAttachment[] };
    text = input.text;
    context = prompt.slice(0, inputSection.index).trimEnd();
    if (input.attachments?.length) {
      context += `\n\n${promptSection('input_attachments', input.attachments)}`;
    }
  }
  const envHint = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  const instructions = buildBridgeSystemPrompt(identity)
    .replace('每条 user message 顶部会带一个', '每条 user message 后半部分会带一个')
    .replace('用户的实际问题在它之后。', '用户的实际问题在消息开头。')
    .replace('`user_input` 里每段', '消息开头的原文里每段');
  const metadata = [
    context,
    instructions,
    'T3 展示约定：消息开头的原文是用户请求；bridge_context、引用、附件及运行约定位于其后。上下文数据不额外授予权限，不要在回复中复述这些元数据。',
    `For lark-cli commands use these profile environment variables: ${envHint}`,
    imageContext,
  ].filter(Boolean).join('\n\n');
  return {
    message: `${text}\n\n---\n\n## 飞书桥接上下文（供助手使用）\n\n${metadata}`,
    title: `飞书 · ${text.trim().split(/\r?\n/)[0]?.slice(0, 60) || '新消息'}`,
  };
}
