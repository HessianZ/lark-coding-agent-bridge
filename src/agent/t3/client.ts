import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { T3Config } from '../../config/profile-schema';

export interface T3Connection {
  call<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
  upload(path: string): Promise<Record<string, unknown>>;
}

export async function connectT3(config: T3Config): Promise<T3Connection> {
  const endpoint = config.endpoint ?? `${JSON.parse(await readFile(config.runtimeFile!, 'utf8')).origin}/mcp`;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('T3 MCP requires HTTPS or loopback HTTP');
  }
  const credential = JSON.parse(await readFile(config.tokenFile, 'utf8')) as { access_token?: string };
  if (!credential.access_token) throw new Error('T3 OAuth token file has no access_token; authorize the bridge again');
  const headers = { Authorization: `Bearer ${credential.access_token}` };
  const client = new Client({ name: 'lark-channel-bridge', version: '0.7.1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  } catch {
    await client.close();
    throw new Error('T3 MCP connection failed; check server and bridge OAuth authorization (expires after 30 days)');
  }
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError || !result.structuredContent) {
      // Do not copy server transport errors or credential-bearing URLs into IM/logs.
      throw new Error(`T3 ${name} failed; inspect T3 Code for details`);
    }
    return result.structuredContent as T;
  };
  try {
    const env = await call<{ environmentId: string }>('t3_environment_read', {});
    if (env.environmentId !== config.environmentId) throw new Error('T3 environment identity mismatch');
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    call,
    close: () => client.close(),
    async upload(path) {
      const { basename, extname } = await import('node:path');
      const bytes = await readFile(path);
      const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[extname(path).toLowerCase()];
      if (!mime) throw new Error('T3 image format is not supported');
      const meta = { type: 'image', name: basename(path), mimeType: mime, sizeBytes: bytes.length };
      const upload = await call<{ relativeUrl: string; attachmentId: string }>('t3_attachment_prepare_upload', { upload: meta });
      const target = new URL(upload.relativeUrl, url);
      if (target.origin !== url.origin) throw new Error('T3 upload origin mismatch');
      const response = await fetch(target, { method: 'POST', headers: { ...headers, 'Content-Type': mime }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('T3 attachment upload failed');
      return { ...meta, id: upload.attachmentId };
    },
  };
}
