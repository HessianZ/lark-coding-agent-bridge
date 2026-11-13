# T3 Code backend

This fork adds `agentKind: "t3"`. Claude/Codex adapters and their existing profiles remain available. Tested against T3 Code 0.1.9's official host CLI and OAuth HTTP MCP interface, using the official MCP SDK (MIT).

## Configure

Use the CLI bundled with the running desktop version (`~/.t3/bin/t3` on this Mac), not an unrelated npm `t3`. Check `--version` outside a macOS GUI sandbox. The desktop launcher explicitly sets `ELECTRON_RUN_AS_NODE=1`.

Authorize a separate Bridge client on the host:

```sh
node bin/t3-authorize.mjs "$HOME/.t3/bin/t3" "$HOME/.t3/userdata/server-runtime.json" "$HOME/.lark-channel/t3/oauth.json"
```

This uses official OAuth registration, PKCE and a one-time pairing code from the host CLI. It grants `orchestration:read` and `orchestration:operate` with an `auto` execution ceiling. It never reads the T3 auth database or reuses an agent token. The OAuth file is 0600; do not commit, print or share it. T3 0.1.9 expires it after 30 days; rerun the same command to authorize again (no Bridge restart required). Revoke the old client under T3 Settings → Sharing & access.

Set the original profile's `agentKind` to `t3` and add:

```json
{
  "t3": {
    "binaryPath": "/absolute/path/to/.t3/bin/t3",
    "runtimeFile": "/absolute/path/to/.t3/userdata/server-runtime.json",
    "tokenFile": "/private/path/to/oauth.json",
    "environmentId": "expected-environment-id",
    "provider": "codex",
    "model": "gpt-6.1-sol"
  }
}
```

Alternatively use an HTTPS/loopback `endpoint` ending in `/mcp` instead of `runtimeFile`. The runtime file discovers changing local ports. The environment ID is checked on every connection. Keep access lists, bot credentials, workspaces and other profiles unchanged. T3 configuration supplies the model; the Bridge `/config` model selector stays on T3's configured model.

The existing run policy selects the permission mode: full → T3 `auto`, workspace → `auto-accept-edits`, read-only → supervised `approval-required` with `plan` interaction. These are T3 permission modes, not a claim of Codex OS sandbox equivalence. Pending approvals/questions must be answered in T3. Resuming a thread whose permission mode or project was changed in T3 is rejected; `/new` starts with the Bridge policy again.

## Behavior

The Bridge retains access checks, directory selection, queues, cards, local file cache and file paths in prompts. Images additionally use native T3 upload/attachments (up to 8 per T3 turn, 10 MiB each). Unsupported images or upload failures fail the turn; they are not silently dropped. The Bridge does not grant additional T3 file or settings scopes.

The selected exact directory is a T3 project. If absent, the official host `t3 project add <cwd>` registers that directory; this avoids granting persistent settings/source-control write permission to the MCP client. The configured CLI must belong to the same local T3 installation as `runtimeFile`. Existing T3 projects/settings are not edited.

Messages launch a visible `飞书 · …` thread, then queue subsequent messages onto the same thread. The session catalog keys include `t3`, chat/topic, canonical directory and policy fingerprint, so Codex IDs are never reused. `/new` archives the current mapping. `/resume` only offers the current authorized mapping, not arbitrary T3 history. A restart retains mappings; a message queues behind an existing T3 turn. `/stop` targets the Bridge's run; after restart it stops the mapped T3 thread, including its queue. T3 app messages remain in the same thread and are available to the next Bridge turn.

Responses stream from T3's assistant messages, then finalize through the existing renderer. Tool panel detail is not translated in this version. When T3 needs user input, the Bridge asks the user to respond in T3. It never interprets a question as completion.

## Build and validate

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
npm pack --ignore-scripts
```

The live test is opt-in and creates actual test threads/provider usage:

```sh
LARK_T3_LIVE=1 LARK_T3_RUNTIME=/path/to/server-runtime.json \
LARK_T3_TOKEN=/private/path/to/oauth.json LARK_T3_ENVIRONMENT=expected-id \
LARK_T3_CWD=/selected/workspace pnpm exec vitest run tests/integration/t3-live.test.ts
```

## Install and roll back

Install the packed artifact in a versioned, stable local release directory. Before replacing the existing launchd job, back up its plist, root config and profile session catalog with private permissions. Confirm the original profile has no active/queued run. Boot out only that job, update only that profile and the job's executable path, then bootstrap the same label. Never run old/new consumers simultaneously. Preserve the old npm cache for rollback.

On failure: boot out the new job, restore the backed-up config and plist, bootstrap the original plist. Keep the T3 catalog entries: their backend namespace makes them harmless to Codex. Verify connection and singleton process registry after either switch. Deployment-specific absolute paths and commands belong in the private installation record, not Git.

## Sync upstream

`origin` remains the user's fork; `upstream` remains `zarazhangrui/lark-coding-agent-bridge`. Fetch upstream, merge its default branch into a new update branch based on `t3-backend`, resolve the small adapter/config/catalog wiring changes, then rerun tests/typecheck/build and the opt-in live test before repacking. Do not edit installed npm cache files.

Official interface reference: https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md
