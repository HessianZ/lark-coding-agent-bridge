# T3 Bridge implementation record

Execution choice: implement directly in this session, without a kanban card (explicit user instruction). Single development branch/worktree: `t3-backend`. Base: `589868119ce9a0a860aaf4936b5f9bac14e72681`.

Goal: preserve the original bot/profile and route runs to real T3 threads, then install and switch the original service with rollback. No npm publication or upstream PR.

Plan and verification:

1. Inspect runtime, backend boundary, access policy and official 0.1.9 schemas → verify the bundled host CLI and independent MCP OAuth.
2. Extend the existing adapter boundary and catalog namespace → unit/integration regressions, full tests, typecheck, build, diff review.
3. Pack into a stable release, back up config/plist, drain original bot and switch one job → actual T3 create/resume/read, image/stop checks, health and singleton registry.

Protected assets: original bot credentials, user/chat access policy, other profiles, active user tasks and local files. Untrusted input enters through existing Bridge access/attachment/run-policy checks. OAuth is stored outside Git, logs and prompts. No direct T3 database reads/writes, no agent-session credential reuse. Host project registration receives only the already-selected canonical working directory through argv.

Compatibility: adds `t3` to profile, lock/registry and session-catalog agent kinds; preserves old namespaces and profile fields. Runtime maps policy to T3 permission modes and rejects changed remote mode/project. Queue/card transport is reused. The public adapter optionally supports remote stop after restart. No stable/main branch integration is requested.

Verification results and deployment evidence are recorded after validation; private installation paths/backups remain in the local deployment record.

First PMQA review found six issues (configuration serialization, queued cancellation, image steering, proposed-plan rendering, interaction-mode validation and reset recovery). All six have targeted regression coverage and are fixed in the follow-up commit. The initial pre-switch build was not activated.
