# Remote Codex Testing

## Purpose

Use this workflow to validate Kanna against a real Codex CLI on a remote Linux host without changing an existing Kanna deployment. Build the browser assets locally, sync into an isolated checkout, keep runtime output off the system disk, and expose a temporary port through an SSH reverse tunnel when browser testing is required.

## Prerequisites

- Bun 1.3.5 or newer on the target host.
- A working, authenticated Codex CLI on the target host.
- An isolated target checkout; do not overlay a dirty deployment checkout.
- A free target port and, if needed, a different free reverse-proxy port.
- The target's required proxy environment. A Codex app-server can initialize and list models while turns still hang if outbound model traffic bypasses the host proxy.

Set these placeholders for the examples below:

```bash
export JUMP_HOST=root@jump.example.com
export TARGET_HOST=developer@127.0.0.1
export TARGET_SSH_PORT=22022
export TARGET_REPO=/home/developer/projects/kanna-remote-test
export TARGET_OUTPUT=/data/outputs/kanna/remote-test
export CODEX_BINARY=/absolute/path/to/codex
export TARGET_PORT=12331
```

## Build and verify locally

Run the complete local checks before copying artifacts to a smaller or shared server:

```bash
KANNA_SYNC_CODEX_THREADS=0 bun run check
KANNA_SYNC_CODEX_THREADS=0 bun test
git diff --check
```

The root-host build step can be memory-intensive. Prefer syncing the locally verified `dist/` tree over rebuilding on a small relay host.

## Sync an isolated checkout

Create the destination first, then sync source and built assets without copying local platform-specific dependencies:

```bash
ssh -J "$JUMP_HOST" -p "$TARGET_SSH_PORT" "$TARGET_HOST" \
  "mkdir -p '$TARGET_REPO' '$TARGET_OUTPUT'"

rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules' \
  --exclude '.playwright-cli/' \
  --exclude 'output/' \
  -e "ssh -J $JUMP_HOST -p $TARGET_SSH_PORT" \
  ./ "$TARGET_HOST:$TARGET_REPO/"
```

Install dependencies on the target or link an existing compatible Linux dependency tree. Never copy macOS `node_modules` to Linux.

## Validate the real Codex protocol

Run the schema check with the exact binary Kanna will launch:

```bash
ssh -J "$JUMP_HOST" -p "$TARGET_SSH_PORT" "$TARGET_HOST" "bash -se" <<REMOTE
set -euo pipefail
cd "$TARGET_REPO"
export PATH="\$HOME/.bun/bin:\$PATH"
export KANNA_CODEX_BINARY="$CODEX_BINARY"
bun run check:codex-schema
REMOTE
```

Then run the P0/P1 integration suite:

```bash
KANNA_SYNC_CODEX_THREADS=0 \
KANNA_CODEX_BINARY="$CODEX_BINARY" \
bun test \
  src/server/codex-app-server.test.ts \
  src/server/agent.test.ts \
  src/server/ws-router.test.ts \
  src/server/auth.test.ts \
  src/server/uploads.test.ts \
  src/server/worktree-manager.test.ts
```

Keep real RPC checks separate from hermetic unit tests. On hosts with an authenticated Codex binary, server tests may update the process-wide model catalog and make unrelated fixed-catalog assertions order-dependent.

## Start an isolated Kanna service

Keep the test data and logs in the output volume. Set `CODEX_HOME` to the authenticated Codex home when the test `HOME` is isolated.

```bash
mkdir -p "$TARGET_OUTPUT/home"

systemd-run --user --unit=kanna-remote-test --collect \
  --property="WorkingDirectory=$TARGET_REPO" \
  --property=Restart=on-failure \
  --property=RestartSec=2 \
  --property="StandardOutput=append:$TARGET_OUTPUT/service.log" \
  --property="StandardError=append:$TARGET_OUTPUT/service.log" \
  --setenv="HOME=$TARGET_OUTPUT/home" \
  --setenv="CODEX_HOME=$HOME/.codex" \
  --setenv="KANNA_CODEX_BINARY=$CODEX_BINARY" \
  --setenv="KANNA_PASSWORD=<test-password>" \
  --setenv="KANNA_SYNC_CODEX_THREADS=0" \
  --setenv="HTTP_PROXY=http://127.0.0.1:7890" \
  --setenv="HTTPS_PROXY=http://127.0.0.1:7890" \
  --setenv="ALL_PROXY=socks5://127.0.0.1:7891" \
  "$HOME/.bun/bin/bun" run ./src/server/cli.ts \
  --remote --port "$TARGET_PORT" --strict-port --no-open
```

Omit proxy variables only when direct outbound Codex traffic is known to work. Use `KANNA_PASSWORD` instead of a password command-line argument so it is not exposed in the process list.

## Reverse tunnel and proxy

From the target host, expose only the selected test port on the relay host:

```bash
autossh -M 0 -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R "127.0.0.1:$TARGET_PORT:127.0.0.1:$TARGET_PORT" \
  "$JUMP_HOST"
```

If nginx terminates TLS on the relay host, proxy its public test listener to `http://127.0.0.1:<target-port>` and retain WebSocket upgrade headers and long read/send timeouts. Run `nginx -t` before reloading. Keep this test vhost separate from existing production ports.

## Verify

Check each layer independently:

```bash
systemctl --user is-active kanna-remote-test.service
curl -fsS "http://127.0.0.1:$TARGET_PORT/health"
curl -kfsS "https://<relay-address>:$TARGET_PORT/health"
```

In a browser:

1. Log in and confirm the connection indicator is `Connected`.
2. Confirm the sidebar contains only projects that were explicitly added. The New Project page may list discovered session directories as candidates, but refreshing discovery must not add those candidates to the sidebar.
3. Add a project that already has Codex sessions, refresh, and confirm its active and archived chats are imported without creating sibling projects from other session directories.
4. Select Codex and confirm the model list comes from `model/list`.
5. Confirm the defaults are `Workspace` and `Ask approval`.
6. Open Codex settings and confirm config, skills, MCP servers, marketplaces/plugins, and hooks load.
7. Send a no-file-change prompt and wait for an exact response.
8. Run an uncommitted-changes review in a disposable Git repository to verify native `review/start`.

## Stop and clean up

Stop only the isolated service and tunnel. Do not use broad process-name kills on a shared host:

```bash
systemctl --user stop kanna-remote-test.service kanna-remote-test-tunnel.service
```

Remove the matching nginx test vhost only after its listener and reverse tunnel are no longer needed. Preserve existing branches, deployment checkouts, and unrelated Codex app-server processes.

## Troubleshooting

- **Turn stays on `Running` while model/config RPCs work:** compare the service's proxy environment with a known-good Codex service. Restarting invalidates browser session cookies, so reload and log in again afterward.
- **SSH banner or HTTP becomes unresponsive on a small relay:** stop the isolated Kanna service and avoid remote frontend builds. Sync a locally verified `dist/` instead.
- **Git tests expect `main` but receive `master`:** run tests with an isolated Git config that sets `init.defaultBranch=main`; do not modify a shared user's global config just for a test.
- **PTY or browser-only unit tests differ on Linux:** run the focused server integration suite remotely and keep the full hermetic suite as a required local check. Investigate remote-only failures separately from Codex protocol failures.
- **Browser shows `Disconnected` after service restart:** reload the page so the auth screen can issue a new session cookie.
