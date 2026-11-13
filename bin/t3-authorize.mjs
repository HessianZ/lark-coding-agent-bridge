#!/usr/bin/env node
// Host-only OAuth setup. Never uses an agent session's MCP token.
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

const [cli, runtimeFile, tokenFile] = process.argv.slice(2);
if (!cli || !runtimeFile || !tokenFile) {
  console.error('Usage: node bin/t3-authorize.mjs /absolute/path/to/t3 /path/to/server-runtime.json /private/path/to/oauth.json');
  process.exit(1);
}
try {
  const { origin } = JSON.parse(await readFile(runtimeFile, 'utf8'));
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Host setup requires loopback HTTP');
  const post = async (path, value, form = false) => {
    const response = await fetch(new URL(path, origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(value) : JSON.stringify(value),
    });
    if (!response.ok) throw new Error('OAuth setup request failed');
    return response.json();
  };
  const redirect = 'http://127.0.0.1:18973/callback';
  const client = await post('/oauth/mcp/register', { client_name: 'Lark Channel Bridge', redirect_uris: [redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  const verifier = randomBytes(48).toString('base64url');
  const authorization = { response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: randomBytes(24).toString('base64url'), resource: `${origin}/mcp` };
  const pair = JSON.parse(execFileSync(cli, ['auth', 'pairing', 'create', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '5m', '--label', 'lark-channel-bridge-oauth', '--json'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const approval = await post('/oauth/mcp/decision', { authorization, decision: { _tag: 'pairing-code', access: 'auto', code: pair.credential } });
  const callback = new URL(approval.redirectTo);
  if (callback.searchParams.get('state') !== authorization.state || !callback.searchParams.get('code')) throw new Error('OAuth response mismatch');
  const token = await post('/oauth/mcp/token', { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirect, code: callback.searchParams.get('code'), code_verifier: verifier, resource: authorization.resource }, true);
  if (!token.access_token) throw new Error('No OAuth credential returned');
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const temporary = `${tokenFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...token, expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, tokenFile);
  await chmod(tokenFile, 0o600);
  console.log(`Bridge OAuth saved (auto ceiling, expires in ${token.expires_in} seconds).`);
} catch {
  console.error('T3 host OAuth setup failed. Check CLI version, running server and host authorization. No credential was printed.');
  process.exitCode = 1;
}
