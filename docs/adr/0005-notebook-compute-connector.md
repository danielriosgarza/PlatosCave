# ADR 0005 — Notebook compute connector and relay protocol

**Status:** Accepted, 2026-09-30

Refined by [docs/design/connector.md](../design/connector.md) (P3-01): wire schemas and fixtures in `connector/protocol/v1/`, pairing and link authentication (§3, §4.2), stage checks and the error catalogue (§5), the Jupyter allowlist, network scope and leases (§7–§9), the server's tables, endpoints and relay (§10), the OS matrix and MFA policy (§13, §5.3). Where it differs from the text below (paths under `/api/connector/v1`, the signed bytes, the message set, the allowlist, user-owned connections, the token in the environment or on standard input, asynchronous Test connection), §17 of the design lists each change and the design wins.

## Context

Notebook cells execute on a computer the learner is authorised to use: this computer, a LAN/lab machine, or an SSH server, optionally via a jump host (§10). The browser speaks only HTTPS/WSS to Parallax; an authorised **compute connector** performs SSH, runtime start/attach and the tunnel to a loopback Jupyter server, and Parallax relays only the authorised notebook session, not a raw TCP proxy (§10.2). Pairing uses a short-lived code and explicit device approval; **Test connection** reports each stage separately; Ready appears only after the notebook service and kernel are verified (§10.3); execution requests are bound to notebook revision, cell, code hash, kernel and message id; reconnect must not re-execute; leases govern idle sessions (§10.4); credentials and tokens never reach documents, URLs, browser storage or logs (§10.6). Scenarios A27–A36. This ADR fixes enough to plan and to test in CI; item P3-01 refines the wire schema and OS matrix.

## Decision

**Connector.** `connector/` is a Go module producing `parallax-connector` for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64. Commands: `pair --server URL --code XXXX-XXXX`, `run` (foreground service; `--allow-net CIDR` repeatable), `status`, `unpair`, `doctor`. State directory (`$XDG_CONFIG_HOME/parallax-connector`, `~/Library/Application Support/...`, `%APPDATA%\...`): `identity.key` (Ed25519, mode 0600), `config.json` (server, connector id, name), `known_hosts` (SSH trust store), `sessions.json` (leases, so limits are enforced even when the server is unreachable). SSH keys are referenced by path or taken from the local SSH agent; passphrases are prompted in the connector and never transmitted. Agent forwarding is off. The same binary in `--managed` mode (config from environment, secret store on disk) serves as the server-side connector for institutions later; it is not required for A27–A36.

**Pairing and authentication.** Web (`user` scope) → `POST /api/me/connectors/pairings` → `{ code, expiresAt }` (8 alphanumerics, 10 minutes, single use). CLI `pair` generates the key and calls `POST /connector/v1/pair { code, publicKey, name, os, arch, version }` → connector row `status = pending`. The web app lists the pending device (name, OS, key fingerprint) and the user clicks **Approve** → `active` (explicit device approval, §10.3). The link is `wss://…/connector/v1/link`: server sends `{ t: 'challenge', nonce }`; connector answers `{ t: 'auth', connectorId, ts, sig = Ed25519(nonce ‖ connectorId ‖ ts) }`; server verifies with `crypto.verify` against the stored public key and rejects `revoked`/`pending` connectors. Unpairing or account revocation closes the link and marks the row `revoked` (§10.6); it does not claim to revoke the person's SSH accounts.

**Wire protocol v1** (one WebSocket per connector; text frames are JSON control messages with `v: 1`, binary frames carry stream data prefixed by a 4-byte stream id and 1-byte flags):

| direction | message | purpose |
| --- | --- | --- |
| c→s | `hello { version, os, capabilities }` | after auth |
| s→c | `test_connection { requestId, target }` | stage checks, no side effects |
| c→s | `test_result { requestId, stages: [{ name, ok, detail, recovery? }] }` | stages: reachability, host_identity, ssh_auth, workspace, forwarding, runtime, notebook_auth, kernels |
| s→c | `open_session { sessionId, target, runtime, workspace, lease }` / `close_session { sessionId, stop }` | start or attach; detach vs stop |
| c→s | `session_state { sessionId, state, jupyterVersion, kernelspecs, lease, cause? }` | state ∈ starting, ready, running, disconnected, stopped; `cause` distinguishes sleep, VPN, SSH timeout, stopped service, expired allocation (A36) |
| s→c | `http { streamId, sessionId, method, path, headers }` + body stream; `ws_open { streamId, sessionId, path }`; `ws_close` | relayed Jupyter REST and kernel channels |
| c→s | `http_head { streamId, status, headers }` + body stream; `ws_event`; `stream_end`, `stream_reset` | |
| both | `ping`/`pong`, `heartbeat { sessions }` every 15 s | lease and link liveness |

`target` is `{ kind: 'local' }` or `{ kind: 'ssh', host, port, user, jump?: {host, port, user}, auth: { keyPath | agent }, workspace }`; no secrets travel from the server. The connector proxies only an allowlist of Jupyter paths for a session it opened: `/api/status`, `/api/kernelspecs`, `/api/sessions[/id]`, `/api/kernels[/id[/interrupt|restart|channels]]`, `/api/contents/<workspace>/…`. The server enforces the same allowlist before forwarding, so neither side alone can widen it (§10.2 "not an unrestricted TCP proxy").

**Runtime.** For `local`, the connector spawns `jupyter server --ServerApp.ip=127.0.0.1 --ServerApp.port=0 --IdentityProvider.token=<random>` (or attaches to a running server listed in `jupyter server list` when the user chooses attach) and keeps the token in memory. For `ssh`, it dials with `golang.org/x/crypto/ssh`, verifies the host key against `known_hosts` (unknown → stage `host_identity` returns the fingerprint for first-use confirmation; changed → hard stop, A30), optionally through a jump host (`ssh.Dial` over a channel of the first client), checks the workspace, starts or attaches Jupyter on the target via `exec`, and opens a local forward (`client.Dial("tcp", "127.0.0.1:<port>")`) per relayed request. `AllowTcpForwarding no`, missing Jupyter, or a bad token surface as their own failing stage and never reach Ready (A29). Sessions started by the connector are **owned**; attached ones are not, so `close_session{stop:true}` refuses to stop an unowned runtime (A32).

**Server relay (`apps/server` `relay` mode, `@fastify/websocket`).** `notebook_connections` (owner, connector id, non-secret target reference, trusted fingerprint, workspace, environment) and `notebook_sessions` (user, connection, class, resource revision, Jupyter session/kernel ids, state, lease expiry, last confirmed) are class-scoped rows (ADR-0002); a guessed session id is a 404 (A33). The browser connects to `/api/classes/:classId/notebook-sessions/:id/channels` (scoped route). For `execute_request`, the server assigns `msg_id`, records `cell_executions (session, cell_id, revision_id, code_hash, kernel_id, msg_id, state)`, then forwards; kernel messages are matched by `parent_header.msg_id`, and outputs for an unknown or superseded kernel are dropped and logged. The last 256 KiB of output per execution is buffered for replay on reconnect; beyond that the execution is marked `incomplete` and the UI offers rerun (A31). The relay never retries an `execute_request`.

**Leases.** Owned sessions carry `{ idleTimeoutMin: 30, gracePeriodMin: 5 }` shown before Connect; the connector enforces them from `sessions.json` even without the server; the server marks sessions `unconfirmed` when heartbeats stop, never `completed`.

**Testing.** Go unit tests spin an in-process `x/crypto/ssh` server and an `httptest` fake Jupyter, covering host-key states, jump routing, forwarding refusal and path allowlists without Docker. CI job `connector-e2e` (Phase 3) runs compose services `sshd-jupyter` (python:3.12-slim + openssh-server + jupyter-server 2.21.1 + ipykernel 7.4.0, one test user with an authorized key) and `jump` (openssh-server only), builds the connector, pairs it against the API with a test-only auto-approve flag, and drives A27/A28/A29/A30/A31 through Playwright.

## Consequences

- One binary, one protocol, three targets (local, SSH, SSH via jump); institution-managed connectors reuse it later.
- Ed25519 challenge auth avoids long-lived bearer tokens; losing the state directory means re-pairing.
- Kernel WebSocket traffic crosses two hops (browser→server→connector→Jupyter); latency is acceptable for interactive cells and the server sees message ids, which the binding requires.
- Windows/WSL routes, MFA (`keyboard-interactive`), HPC scheduler adapters and the managed-connector network policy were refined in P3-01 (`docs/design/connector.md` §5.3, §12, §13); scheduler adapters stay an extension.

## Alternatives considered

- **Browser-side SSH (WebAssembly)**: no way to reach LAN machines or hold keys safely.
- **Inbound tunnels / port forwarding on the learner's router**: rejected by §10.2; the connector always dials out.
- **Reverse proxying the whole Jupyter UI**: exposes an unrestricted surface and breaks the "Parallax keeps the notebook interface" requirement.
- **Connector in TypeScript**: see ADR-0001; single-binary distribution and `x/crypto/ssh` decide it.
