# Connector detailed design (P3-01)

**Status:** accepted with the merge of P3-01, 2026-10-03. Refines [ADR-0005](../adr/0005-notebook-compute-connector.md) for §10 of the [product specification](../product-spec.md); where this document differs from the ADR it says so in §17, and the ADR carries a pointer here. The normative machine-readable parts are in [`connector/protocol/v1/`](../../connector/protocol/v1/): three JSON Schemas, the error catalogue, signing and frame vectors, and example messages. This document explains them and fixes everything the schemas cannot: trust boundaries, pairing, stage checks, the Jupyter allowlist, network scope, leases, the server's tables, endpoints and relay, the OS matrix, the credential and MFA policy, and the CI fixtures. Items P3-02 … P3-11 in [the plan](../delivery/plan.md) implement it, were rewritten by this item, and name their tests from §16.

Terms. The **connector** is the Go program `parallax-connector`. The **link** is its one outbound WebSocket to the server. A **target** is where code runs: `local` (the connector's own computer), `ssh` (an account on another computer, optionally behind one jump host) or `managed` (a target defined in a managed connector's configuration). A **connection** is a saved, secret-free reference to a target. A **session** is one Jupyter Server process plus the tunnel to it, opened for one person and one notebook; it is **owned** when the connector started the process and **attached** when it only joined one somebody else started. A **kernel** is the Python or R process inside the Jupyter server. A **stage** is one step of Test connection. A **lease** is the idle and grace policy of an owned session. The **relay** is `apps/server` in `relay` mode.

## 1. Components and trust boundaries

```
 browser ──HTTPS/WSS (cookie session)──▶ apps/server, mode `relay`  ◀──wss, dialled OUTBOUND by the connector── parallax-connector
                                          │ Postgres (connectors, connections,                              │ state dir: identity.key, config.json,
                                          │ notebook_sessions, cell_executions …)                           │ known_hosts, sessions.json, runtime.json
                                          │                                                                 ├─ target local: jupyter server on 127.0.0.1:<port>
                                          │                                                                 └─ target ssh: x/crypto/ssh ▶ [jump] ▶ target:22
                                          │                                                                      └─ direct-tcpip 127.0.0.1:<port> ▶ Jupyter ▶ kernel
```

| Component | Trusts | Is trusted for |
| --- | --- | --- |
| Browser | nothing it did not get from its own scoped routes | showing state; it never names a Jupyter path, a host or a port to the connector (§7) |
| Relay (`apps/server`) | a connector only after approval and a valid Ed25519 signature; every connector message only after schema validation; the browser only through a resolved scope | authorisation (ADR-0002), execution binding, which operations may be sent to a connector, the stored non-secret target reference |
| Connector | the server's TLS identity and its own origin check; server messages only after schema validation, **and then still applies its own network scope, allowlists and fixed command templates** | SSH, host identity, secrets (keys, passphrases, one-time codes, the Jupyter token), process ownership, leases |
| Target computer | nothing | running the person's code with that account's privileges; Parallax does not sandbox it (spec §10.6) |
| Jupyter Server | the connector (token held in memory) | kernels and files under its root directory |

Neither side alone can widen what a connector does (§7, §8): the relay sends only typed operations it builds itself, and the connector refuses anything outside its allowlist and network scope even when the relay asks. **Honest limit:** the relay is trusted with the right to run code. A kernel executes whatever it is sent, so a compromised relay can start a session on any connection a person saved and run code there as that account, and on a `local` target that includes reading the connector's own files. The allowlist and scope do not prevent that; they prevent *everything else*: the relay cannot make the connector run a command of its own choosing, dial an address outside the approved scope, reach a kernel the session did not create, or learn a key, passphrase, one-time code or Jupyter token from the connector (§14). Compensating controls: the connector prints every session it opens (who asked, host, workspace) on its terminal and in its log, `run --confirm-sessions` makes it ask on that terminal before each `open_session` (recommended for a laptop that holds sensitive files), a hard session lifetime applies (§9), and Parallax's one relay process is a single audited component (§10.1).

## 2. Life of a notebook session

1. **Pair** the computer (§3). One time per computer.
2. **Create a connection.** `POST /api/me/connections` stores a target reference: kind, host, port, user, jump host, workspace, key *reference*, runtime choice. No secret is accepted: the schema has no field for one.
3. **Test connection.** `POST /api/me/connections/:id/test` sends `test_connection` over the connector's link. The connector answers `test_progress` per stage and a final `test_result`. A first-use host key ends the test with `needs_action` and the fingerprint; the person confirms it and tests again (§5.2). The outcome is `ready_to_start` when Jupyter can be started, `ready` when an attachable service was verified live, `failed` otherwise.
4. **Connect.** `POST /api/classes/:classId/notebook-sessions` under class scope. The server checks that the connection and connector belong to the caller, the connector is active and online, the notebook revision belongs to the class's release and no other session of this person is open for it. It inserts the row (`starting`) and sends `open_session` with the lease.
5. **Connector opens the runtime** (§6): dials (through the jump host if any), verifies the host, authenticates, starts or attaches Jupyter, opens the tunnel, checks `/api/status` with the token and `/api/kernelspecs`, then sends `session_state` `ready`. **Ready never means "SSH worked".**
6. **Browser attaches.** It opens the channel WebSocket (§10.5). The relay sends `presence { attached: true }`, starts the kernel the person chose (`POST /api/kernels`), opens one kernel channel stream to Jupyter that outlives the browser, and shows **Ready** only when the kernel reports `idle`.
7. **Run.** The browser sends `execute`; the relay binds it (§10.6) and sends the request on the kernel channel. Opening a notebook never runs a cell.
8. **Disconnect or close the tab.** The relay sends `presence { attached: false }`. The owned session now lives out its **grace period** (§9); an attached session is simply left alone.
9. **Reconnect.** A new channel whose `hello` carries `resume { epoch, afterEventSeq }` receives the buffered events. If the link or the kernel was lost, §10.6 says what the executions become; nothing is executed again.
10. **Stop session.** `POST …/close { stop: true }` → `close_session { stop: true }` → the connector stops the process it owns, confirms with `session_state` `stopped`, closes the tunnel. For an attached session the connector answers `not_owned` and the UI offers Disconnect only (A32).
11. **Loss.** Sleep, VPN loss, SSH timeout, a stopped service or an expired allocation produce `session_state` `disconnected` with a **cause** (§5.5). Edits and acknowledged outputs stay; execution is disabled; the server shows the last known kernel state as unconfirmed.

## 3. Pairing and approval

**Goal (spec §10.3):** a newly installed connector is tied to one account by a short-lived code and an explicit device approval, with no standing bearer token.

| Step | Request | Result |
| --- | --- | --- |
| 1 | Web: `POST /api/me/connectors/pairings` (scope `user`) | `201 { pairingId, code: "K7M2-Q9XD", expiresAt }`: 8 characters of Crockford base 32 (`0-9 A-Z` without `I L O U`), 40 bits, valid 10 minutes, single use. The server stores only `HMAC-SHA256(K, code)` with `K = HMAC-SHA256(SESSION_SECRET, "parallax-pairing-v1")`, so no new secret is configured. At most three live codes per person; a fourth supersedes the oldest |
| 2 | CLI: `parallax-connector pair --server https://… --code K7M2-Q9XD [--name "…"]` | generates `identity.key` (Ed25519, mode 0600) unless one exists, prints its fingerprint |
| 3 | CLI: `POST /api/connector/v1/pair` with `PairRequest` (code normalised: upper case, hyphen and spaces removed, `O`→`0`, `I`/`L`→`1`) | `201 PairResponse`: `connectorId`, `fingerprint`, `status: pending`, `approveBy` (15 minutes). The code is consumed. A bad, used or expired code is `404 { error: "not found" }` and counts against the caller's failure budget |
| 4 | Web: `GET /api/me/connectors` lists the pending device: name, OS, architecture, version, **fingerprint** | the person compares the fingerprint with the one the CLI printed |
| 5 | Web: `POST /api/me/connectors/:id/approve` (needs recent authentication, ADR-0002) | `status: active`, audit `connector.approved` |
| 6 | CLI polls `POST /api/connector/v1/pair/poll` with a signed `SignedRequest` every `pollAfterSeconds` (2) | `PollResponse` `pending` → `active` (CLI writes `config.json`, prints "Paired as … Run `parallax-connector run`") or `rejected` / `expired` |
| 7 | `parallax-connector run` | opens the link (§4.2). A connector that is still `pending` is refused with close code 4403 `pending`; `run` retries every 10 s and prints that approval is pending. One whose approval window lapsed is refused with 4403 `approval_expired`; `run` stops and tells the person to pair again |

The fingerprint is `SHA256:` plus the unpadded base64 of the SHA-256 of the **raw 32-byte public key**. It is not an OpenSSH fingerprint and is compared only between the CLI and the approval screen.

**Controls.** The pairing endpoints are public-scope routes registered with `registerRoute` (the structural guard of ADR-0002 applies) and rate limited: a client IP is blocked for 10 minutes after 10 failed attempts in 10 minutes; one connector may poll once per second; a person may create 5 codes an hour, hold 5 active connectors and 3 pending ones. A pairing code is useless without the CLI's key and is consumed on first use, so a leaked code lets an attacker create a *pending* device the owner would see and reject; it never yields an active one. Approval, rename and revoke require a real principal: `kind: 'preview'` users get 403 on every `/api/me/connector*` and `/api/me/connection*` route.

**Revoke and unpair.** `POST /api/me/connectors/:id/revoke` (also used to reject a pending device) sets `status: revoked`, closes the live link with code 4403 `revoked`, marks the person's open sessions on it `unconfirmed` with cause `connector_revoked` (the server can no longer ask the connector, and does not claim they stopped), and appends the audit event. A connector that receives 4403 `revoked` stops the sessions it owns, stops retrying and exits. `parallax-connector unpair` sends a signed `POST /api/connector/v1/unpair`, deletes `identity.key`, `config.json` and `sessions.json` locally (stopping owned sessions first) and prints that **this does not revoke the person's SSH accounts** (spec §10.6). If the server is unreachable it deletes locally and tells the person to revoke the device in the web app. Account deactivation (P4-09) calls the same `revokeUserConnectors(userId)` service function. The link re-reads the connector row every 60 seconds, so a revocation reaches a live link even if the closing message was lost.

**Lost state.** Losing the state directory means re-pairing; the old row stays until revoked. `pair` on a machine that already has an identity refuses unless `--force` (it replaces the identity and the person revokes the old row).

## 4. Protocol v1

Files: [`link.schema.json`](../../connector/protocol/v1/link.schema.json) (every control message; validate a server message against `#/$defs/ServerMessage` and a connector message against `#/$defs/ConnectorMessage`), [`pairing.schema.json`](../../connector/protocol/v1/pairing.schema.json) (the bodies under `/api/connector/v1`), [`state.schema.json`](../../connector/protocol/v1/state.schema.json) (`config.json`, `sessions.json`, `runtime.json`), [`errors.json`](../../connector/protocol/v1/errors.json) (the catalogue of §5.4), [`vectors/signing.json`](../../connector/protocol/v1/vectors/signing.json) and [`vectors/frames.json`](../../connector/protocol/v1/vectors/frames.json), and [`examples/`](../../connector/protocol/v1/examples/).

**How the files are used.** The Go module embeds them (`connector/protocol/embed.go`, package `parallax/connector/protocol`) and a test validates every fixture with `github.com/santhosh-tekuri/jsonschema/v6` (a test-only dependency; the binary does not link it). The server mirrors the schemas as zod in `packages/contracts/src/connector.ts` (`LinkServerMessage`, `LinkConnectorMessage`, `PairRequest` …, `validateTarget`, `ERROR_CODES` derived from `errors.json`) with a test that parses every file in `examples/`, rejects every file under `examples/invalid/` (fails the JSON Schema; the table in §4.4 names the rule each breaks) and rejects every file under `examples/rejected/` (passes the JSON Schema, breaks one semantic rule of §4.4). Each invalid or rejected fixture breaks exactly one rule, so a mirror that misses a rule fails on a named file. The file prefix selects the schema: `s2c-` ServerMessage, `c2s-` ConnectorMessage, `both-` both, `pairing-<Def>` and `state-<Def>` the definition of that name. Both languages also check that every `code` they emit or render is a key of `errors.json`. Any change to a schema is a protocol change (§4.6).

### 4.1 Transport

- `wss://<host>/api/connector/v1/link`, WebSocket subprotocol `parallax.connector.v1`. The connector dials out; it never listens. TLS is required; `http://` and `ws://` are accepted by the CLI only for `127.0.0.1`, `[::1]` and `localhost` (development and CI). `HTTPS_PROXY` is honoured for the link (not for SSH, §17). The read limit is raised to `max(maxControl, maxPayload + 5)` (`SetReadLimit`; the library default is 32 KiB), because `auth_ok` may set `maxPayload` above `maxControl`.
- One link per connector. A second link authenticating as the same connector closes the older one with 4409 `replaced`.
- **Text frames** carry one JSON control message each, at most `maxControl` (64 KiB) bytes, valid against `link.schema.json`. **Binary frames** carry stream data (§4.5). A frame that is not valid JSON, exceeds `maxControl`, or is a known message that fails its schema ends the link with 4400; a message whose `t` is unknown is answered `error unsupported_message` and ignored.
- The route is registered through `registerRoute` as a `public`-scope route (ADR-0002): authentication is the challenge below, and an unauthenticated socket is closed after 10 seconds.

### 4.2 Handshake and link authentication

```
connector                                              server
   │──── wss upgrade ───────────────────────────────────────────▶│  rate limit: 30 attempts/minute/IP
   │◀──────────── challenge { nonce, origin, ts } ──────────────│  nonce: 32 random bytes, single use, valid 30 s
   │──── auth { connectorId, ts, sig } ─────────────────────────▶│  verify (below)
   │◀──────────── auth_ok { heartbeatSeconds, limits, minVersion? }
   │──── hello { version, os, arch, mode, targets, features, networkScope }
   │──── heartbeat seq 0     (every session held, terminal ones too; the server reconciles from this)
   │──── session_state × n   (state notices, in no guaranteed relation to the list)
   │◀──▶ requests, streams, heartbeat every heartbeatSeconds (15)
```

`sig` is Ed25519 over exactly these bytes, so a signature is bound to one purpose, one connector, one server origin and one challenge:

| Offset | Bytes | Content |
| --- | --- | --- |
| 0 | 27 | `parallax-connector-link-v1` followed by one `0x00` |
| 27 | 32 | the nonce, decoded |
| 59 | 16 | `connectorId` as raw UUID bytes |
| 75 | 8 | `ts`, unix seconds, signed 64-bit big-endian |
| 83 | 2 | length *n* of the origin in bytes, unsigned big-endian |
| 85 | *n* | the server origin the connector was paired with: `scheme://host[:port]`, lower case, no trailing slash, the default port (443 for `https`, 80 for `http`) omitted; `pair` normalises `--server` this way before storing it in `config.json`, and the server compares the same form |

The poll request signs the same layout without the nonce under the label `parallax-connector-poll-v1\0`, and the unpair request under `parallax-connector-unpair-v1\0`. [`vectors/signing.json`](../../connector/protocol/v1/vectors/signing.json) holds the seed, public key, fingerprint, the three message byte strings and their signatures; Ed25519 is deterministic, so the Go and the TypeScript tests must both reproduce those signatures and verify them.

The server accepts the link when the connector row exists and is `active`, `|now − ts| ≤ 120 s`, the challenge is unexpired and unused, and `crypto.verify(null, message, publicKey, sig)` holds. Otherwise it closes with the code of §4.6 (`pending`, `approval_expired` and `revoked` are told apart so the CLI can say what to do; a bad signature or unknown id are both `bad_signature`, so ids cannot be probed). The challenge's `origin` lets a connector configured for another deployment stop with a clear message instead of an opaque signature failure; the connector signs *its own* configured origin, never the one in the message.

`hello.mode` must equal the row's `mode`; `hello.version` below `minVersion` closes with 4426. The server stores `os`, `arch`, `version`, `networkScope` and `last_seen_at` on the row (for display and for early rejection of literal addresses the connector would refuse, §8) and only then marks the link live.

Heartbeat: the connector sends `heartbeat { seq, ts, sessions }` every `heartbeatSeconds`; the server answers `heartbeat_ack { seq }` at once. Three missed acknowledgements (3 × `heartbeatSeconds`) and the connector closes and redials. The server treats 3 × `heartbeatSeconds` (45 s by default) without a heartbeat as a dead link: it closes with 4408 and marks the connector's sessions `unconfirmed` (cause `link_lost`), **never** `stopped` (spec §10.4).

Reconnect (connector): exponential backoff with full jitter, 1 s doubling to 60 s, reset after a link stays up for 60 s. 4403 `revoked`, 4403 `approval_expired` and 4401 `bad_signature` stop the retries and exit with an explanation; 4403 `pending`, 4429 and 4500 keep retrying.

### 4.3 Control messages

Every message has `v: 1` and `t`. Fields not listed are not allowed.

| `t` | Dir | Fields (besides `v`, `t`) | Meaning and reply |
| --- | --- | --- | --- |
| `challenge` | s→c | `nonce`, `origin`, `ts` | first message of a link |
| `auth` | c→s | `connectorId`, `ts`, `sig` | answers `challenge` |
| `auth_ok` | s→c | `heartbeatSeconds`, `limits{maxStreams, maxPayload, initialWindow, maxControl, maxSessions}`, `minVersion?` | link accepted |
| `hello` | c→s | `version`, `os`, `arch`, `mode`, `targets[]`, `features{tty, agent, wsl}`, `networkScope{cidrs[], hosts[]}` | what this connector can do and may reach |
| `test_connection` | s→c | `requestId`, `target`, `runtime`, `confirmations[]?` | run the stages of §5.1; no side effects |
| `test_progress` | c→s | `requestId`, `stage` | one finished stage, as soon as it finishes; or an `ssh_auth` stage with `status: 'running'` and `data.terminalPrompt: true` when the connector starts waiting for the person in its own terminal (§5.1). `running` never appears in `test_result` |
| `test_result` | c→s | `requestId`, `outcome`, `stages[]`, `kernelspecs[]?`, `attachable[]?`, `jupyterVersion?`, `environment?` | final answer; `outcome` ∈ `ready`, `ready_to_start`, `needs_action`, `failed` |
| `open_session` | s→c | `requestId`, `sessionId`, `target`, `runtime`, `lease` | start or attach; answered by `session_state` carrying the `requestId` |
| `session_state` | c→s | `sessionId`, `requestId?`, `state`, `owned`, `phase?`, `cause?`, `code?`, `detail?`, `jupyterVersion?`, `kernelspecs[]?`, `environment?`, `contentRoot?`, `leaseExpiresAt?`, `ts` | `state` ∈ `starting`, `ready`, `disconnected`, `stopping`, `stopped`, `failed`. `ready` only after the notebook service answered `/api/status` with the token and `/api/kernelspecs` listed a kernel. Sent on every change and for every held session after `hello`. `ready` carries `contentRoot`, the session's content root (§7), when the connector's own path rules can address it (P3-09b) |
| `close_session` | s→c | `requestId`, `sessionId`, `stop` | `stop: false` detaches; `stop: true` stops an owned process; answered by `session_state`, or `error not_owned` |
| `presence` | s→c | `sessionId`, `attached` | whether any browser is attached; drives the lease phase (§9) |
| `activity` | s→c | `sessionId` | a person ran, interrupted or restarted something; at most one per 10 s per session |
| `http` | s→c | `streamId`, `sessionId`, `purpose`, `method`, `path`, `headers`, `body`, `contentLength?` | one Jupyter REST call (§7); `purpose` ∈ `session`, `contents` |
| `http_head` | c→s | `streamId`, `status`, `headers`, `body` | response head; body follows as frames |
| `ws_open` | s→c | `streamId`, `sessionId`, `path`, `protocols[]?` | open a Jupyter WebSocket (kernel channels only) |
| `ws_opened` | c→s | `streamId`, `protocol?` | the WebSocket is open |
| `ws_close` | both | `streamId`, `code`, `reason?` | close it |
| `window` | both | `streamId`, `credit` | flow-control credit (§4.5) |
| `stream_reset` | both | `streamId`, `code`, `detail?` | abort a stream; `code` is a catalogue code |
| `heartbeat` | c→s | `seq`, `ts`, `sessions[]` (id, state, phase, lease expiry, kernels with execution state and last activity) | liveness and lease evidence |
| `heartbeat_ack` | s→c | `seq` | |
| `error` | both | `requestId?`, `sessionId?`, `streamId?`, `code`, `detail?` | a refused or failed request. An unknown `t` is answered `error unsupported_message` and ignored |

There is no `ping`/`pong`: WebSocket-level ping keeps proxies awake and `heartbeat` carries liveness. There is no `ws_event`: WebSocket payloads are binary frames, not base64 in JSON.

### 4.4 Targets and the semantic rules

`target` is one of three shapes (the schema's `oneOf`), and **never holds a secret**:

- `{ kind: 'local', workspace }`.
- `{ kind: 'ssh', host, port, user, auth, workspace, jump?: { host, port, user, auth? }, hostKeys?: [{ host, port, sha256 }], expectedEnd? }`. `auth` is a reference: `{ method: 'key', keyPath }` (a path on the connector's computer), `{ method: 'agent', hint? }`, or `{ method: 'managed_key', keyId }` (managed connectors only). `hostKeys` are the fingerprints the server remembers as trusted (§5.2). `expectedEnd` declares when a time-limited allocation ends (§5.5).
- `{ kind: 'managed', targetId, subject }`: reserved for managed connectors (§12); a personal connector answers `error unsupported_target`.

`runtime` is `{ mode: 'start', python?, login?, kernelName? }` or `{ mode: 'attach', port, pid?, kernelName? }`; `kernelName` is the kernelspec the person chose, saved with the connection, and the `kernels` stage checks that it exists (`kernelspec_not_found`).

**Semantic rules** (enforced by `validateTarget` in `packages/contracts` before the server sends, and by the connector on receipt, which answers `error invalid_target`):

| # | Rule | Fixture in `examples/rejected/` (prefix `s2c-test_connection-` unless shown) |
| --- | --- | --- |
| 1 | A host without `:` is a dotted-quad IPv4 (four decimal octets, no leading zeros) or a DNS name whose labels are 1–63 characters of `A-Z a-z 0-9 -`, not starting or ending with `-`, whose last label is neither all digits nor starting with `0x` or `0X`. A host with `:` parses as an IPv6 literal, with no zone. This closes decimal, hex, octal and short forms (`2852039166`, `0x7f000001`, `127.1`) that a system resolver may still accept | `…host-decimal-ip`, `…host-hex-ip`, `…host-hex-ip-upper`, `…host-short-ipv4` |
| 2 | A literal address (after unwrapping `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` to the embedded IPv4 address, the same as §8) may not be unspecified, multicast, broadcast or link-local (`169.254.0.0/16`, `fe80::/10`: cloud metadata lives there). Applies to the target and the jump host. These are never allowable by configuration (§8) | `…host-metadata-ip`, `…host-mapped-metadata`, `…host-link-local-v6` |
| 3 | `workspace` is absolute (`ssh`: starts with `/`; `local`: `/…` or `X:\…`/`X:/…`) and has no `..` segment | `…workspace-relative`, `…workspace-dotdot` |
| 4 | `auth.keyPath` is absolute or starts with `~/`, and has no `..` segment | `…keypath-relative` |
| 5 | `runtime.python` is absolute or starts with `~/` with no `..` segment; `login` is allowed for `ssh` only | `open_session-python-dotdot`, `open_session-login-on-local` |
| 6 | `hostKeys` has no two entries for one `host:port`, and each names the target or the jump host | `…hostkeys-duplicate` |
| 7 | A confirmation names the target or the jump host, and `replacing` differs from `sha256` | `…confirmation-replacing-itself` |
| 8 | The jump host is not the target | `…jump-is-target` |

Fixtures under `examples/invalid/` and the schema rule each breaks: `c2s-auth-short-signature` (`sig` length), `s2c-http-path-not-api` (`path` must start `/api/`), `s2c-open_session-unknown-property` (no `token` field exists), `s2c-test_connection-password-in-auth` (no `password` field exists), `c2s-session_state-unknown-state`, `c2s-session_state-content-root-dotdot` (a content root has no `..`, `.`, hidden or empty segment, §7), `c2s-hello-unknown-os`, `s2c-window-zero-credit`, `s2c-open_session-lease-below-bounds`, `s2c-http-method-trace`, `c2s-test_result-detail-too-long`, `s2c-challenge-version-2`, `s2c-test_connection-user-option` (a user name cannot start with `-`), `s2c-test_connection-user-backslash` (a user name has no backslash: `DOMAIN\user` belongs to Windows OpenSSH targets, out of scope for v1, §17), `s2c-http-stream-without-length` (`body: 'stream'` needs `contentLength`), `c2s-test_result-host_identity-ok-without-hops` (an `ok` `host_identity` stage reports its keys in `data.hops`, §5.2), `c2s-test_result-running-stage` (`running` exists only in `test_progress`), `both-error-code-shape`, `pairing-PairRequest-lowercase-code`, `state-Sessions-token`.

### 4.5 Streams, frames and flow control

- The **server** allocates stream ids (unsigned 32-bit, from 1, never reused within a link); the connector opens none in v1. A stream belongs to exactly one session: `http` and `ws_open` name it, and the connector refuses data for a stream it did not open (`stream_reset unknown_stream`).
- **Frame** = 4-byte big-endian stream id, 1-byte flags, payload of at most `maxPayload` (64 KiB). Flags: `0x01` END (last frame of an HTTP body or of a WebSocket message), `0x02` TEXT (the WebSocket message is text, set on every frame of it); other bits must be zero, stream id 0 is invalid. [`vectors/frames.json`](../../connector/protocol/v1/vectors/frames.json) holds valid and invalid frames for both codecs.
- **HTTP.** `http` with `body: 'none'` is a complete request. With `body: 'stream'` it announces `contentLength` bytes, sent as frames ending with END; a different total is `stream_reset invalid_message`. The response is `http_head` then, when `body: 'stream'`, frames ending with END. Redirects are not followed and `Location` is dropped.
- **WebSocket.** `ws_open` → `ws_opened` (or `stream_reset`), then frames in both directions, then `ws_close` from either side. In v1 only the kernel channel is opened this way (§7).
- **Flow control.** Every stream starts with a send window of `initialWindow` (256 KiB) in each direction. A sender may have at most that many unacknowledged payload bytes in flight; the receiver grants more with `window { streamId, credit }` as it hands data on (to Jupyter's socket, to the browser's socket). Sending beyond the window is `stream_reset limit_exceeded`. Back-pressure therefore stops a slow browser from stalling other streams on the link.
- **Limits** (from `auth_ok`): 32 concurrent streams, 4 sessions per connector, 64 KiB frames and control messages. Request bodies: 1 MiB for `purpose: session`, 64 MiB for `contents`. An HTTP exchange that makes no progress is reset after 60 s (`session`) or 300 s (`contents`); the whole request has a deadline of 30 s (`session`; kernel start 20 s of that) or 120 s (`contents`).

### 4.6 Close codes and versioning

| Code | Reason string | Sent by | Connector reaction |
| --- | --- | --- | --- |
| 1000 / 1001 | — | either | redial (1001 is a server restart) |
| 4400 | `protocol_error` | either | fix or update; retry with backoff |
| 4401 | `bad_signature` / `clock_skew` | server | `bad_signature`: stop; run `doctor`. `clock_skew`: retry every 30 s (a waking laptop's clock catches up) and say so |
| 4403 | `pending` / `approval_expired` / `revoked` / `mode_mismatch` | server | `pending`: retry every 10 s; `approval_expired` (still pending after its approval window): stop and say to pair again; `revoked`: stop and explain; `mode_mismatch`: stop and explain |
| 4408 | `heartbeat_timeout` | server | redial |
| 4409 | `replaced` | server | do not redial for 60 s (another instance of this connector is running) |
| 4426 | `upgrade_required` | server | stop and say which version is required |
| 4429 | `rate_limited` | server | back off |
| 4500 | `server_error` | server | redial |

**Versioning.** The WebSocket subprotocol names the major version. A change to any schema is a protocol change: add `v2` files beside `v1`, offer both subprotocols, keep serving `v1` until no active connector below the first `v2` version remains (`connectors.version`), and keep the old fixtures. (P3-09b added the optional `session_state.contentRoot` to v1 instead: no connector had been released, so no active connector below a `v2` could exist, and a server that does not receive it refuses file transfer for an attached session as before.) Schemas are strict (`additionalProperties: false`) on purpose: a field a secret could hide in cannot be added without a schema change that review sees.

## 5. Stage checks, host identity, authentication and the error catalogue

### 5.1 Stages

Test connection and Connect run the same stages in the same order. A stage reports `ok`, `failed`, `needs_action` or `skipped` (and, in `test_progress` only, `running` while `ssh_auth` waits on the connector's terminal, under **Deadlines** below); the first stage that is `failed` or `needs_action` makes every later stage `skipped` with `data.reason: 'blocked'` and `data.blockedBy`. A stage that is `skipped` with `data.reason: 'not_started'` (`notebook_auth` in start mode) blocks nothing, so `kernels` still runs. A `local` target lists only `workspace`, `runtime`, `notebook_auth`, `kernels`; an `ssh` target lists all eight.

| Stage | What it checks (and nothing more) | Codes |
| --- | --- | --- |
| `reachability` | validate the target (§4.4), resolve, check every answer against the network scope (§8), dial by IP with a 10 s timeout, read the SSH banner; the jump host first when there is one (`data.hop`) | `host_unresolved`, `connection_refused`, `connection_timeout`, `network_scope_denied`, `invalid_target`, `unsupported_target` |
| `host_identity` | key exchange; compare the presented key with the records using the table of §5.2 | `host_key_unknown` (`needs_action`), `host_key_changed`, `host_key_untrusted_managed` |
| `ssh_auth` | authenticate each hop as §5.3 says | `key_file_unreadable`, `key_passphrase_required`, `key_passphrase_wrong`, `agent_unavailable`, `agent_no_identity`, `auth_rejected`, `auth_method_unsupported`, `mfa_requires_terminal`, `mfa_failed` |
| `workspace` | the directory exists, is a directory and is writable (`test -d`, `test -w`; `stat` locally), and its canonical path (`cd -P`) is reported in `data.resolvedPath` so the panel can show the exact destination before any file is copied; **Creates nothing** | `remote_exec_denied` (the first exec of the connection), `workspace_missing`, `workspace_not_directory`, `workspace_not_writable` |
| `forwarding` | open a `direct-tcpip` channel to `127.0.0.1` and read why it fails: *administratively prohibited* is `forwarding_denied`; *connect failed* means forwarding works and nothing listens, which is `ok` here | `forwarding_denied`, `tunnel_unavailable` |
| `runtime` | start mode: exec is permitted, the host is POSIX (`uname -s`), the interpreter runs, `jupyter_server` imports and is at least 2.0; attach mode: find the servers (`jupyter server list --json`) or probe the chosen port and require a loopback listener whose `root_dir` contains the workspace (`workspace_outside_root`) | `shell_unsupported`, `environment_invalid`, `jupyter_missing`, `jupyter_incompatible`, `jupyter_start_failed`, `jupyter_start_timeout`, `attach_none_found`, `attach_port_unreachable`, `attach_not_loopback`, `workspace_outside_root` |
| `notebook_auth` | attach and Connect: `GET /api/status` through the tunnel with the token returns 200. Test connection in start mode: `skipped`, `data.reason: 'not_started'` | `token_unavailable`, `token_rejected`, `notebook_service_unreachable` |
| `kernels` | start mode before the server runs: `jupyter kernelspec list --json` (`data.source: 'cli'`); otherwise `GET /api/kernelspecs` (`'service'`); at least one kernel, and the chosen one exists | `no_kernelspec`, `kernelspec_not_found`, `kernel_start_failed` |

**Outcome.** `ready` when every stage is `ok` against a live attached server. `ready_to_start` when start mode is startable: every stage is `ok` except `notebook_auth`, which is `skipped` because nothing runs yet (spec §10.3: "reserving the live service/kernel checks for Connect"). `needs_action` when the first stage that is `failed` or `needs_action` is `needs_action`. `failed` otherwise. In start mode the result also lists the `attachable` servers it found, so the person can choose Attach instead. Testing does not install packages, start a server, execute a cell, write a file or change a record other than a host key the person confirmed.

**Deadlines.** A stage deadline applies to the stage as a whole and covers every hop it runs: on a jump route `reachability`, `host_identity` and `ssh_auth` handle the jump host and then the target inside one deadline each. 20 s per stage; `ssh_auth` 60 s, raised to 120 s for the stage once a terminal prompt starts (the connector is waiting for a passphrase or a second factor in its own terminal; on a jump route the prompts of both hops share those 120 s); `runtime` 45 s (Jupyter's own start poll is 30 s, §6). When `ssh_auth` starts waiting on the terminal during Test connection, the connector sends `test_progress` with the stage `{ name: 'ssh_auth', status: 'running', data: { hop, terminalPrompt: true } }`, so the panel can tell the person to answer in the connector's terminal; the finished `ssh_auth` report follows as usual. A stage that reaches its deadline reports a code of its own: `connection_timeout` (`reachability`, `host_identity`, `workspace`), `mfa_failed` for `ssh_auth` while a terminal prompt was pending and `connection_timeout` otherwise, `tunnel_unavailable` (`forwarding`), `jupyter_start_timeout` (`runtime`), `notebook_service_unreachable` (`notebook_auth`), `internal` (`kernels`). The catalogue's `stage` (§5.4) is the stage that usually reports a code, not the only one: these deadline codes may come from another stage, and the panel names the failing stage from the stage report, not from the catalogue. The stage deadlines add up to at most 20 + 20 + 120 + 20 + 20 + 45 + 20 + 20 = **285 s**, for one hop or two. The server's deadline for a whole test and for a session to leave `starting` is **300 s**, above that worst case, and neither is extended: a `running` report changes what the panel shows, not the deadline (Connect sends no stage reports, and reuses the tested SSH connection when it follows within 120 s, §5.3).

### 5.2 Host identity

The connector's own `known_hosts` file (OpenSSH format, written with `golang.org/x/crypto/ssh/knownhosts`; the person's `~/.ssh/known_hosts` is neither read nor written) and the server's `notebook_connections.trusted_host_keys` are two records of what the person trusted. Both are consulted; a presented key that matches neither record is a stop unless the person replaces the record they hold (rows 2 and 8). L = the connector's entry for `host:port`, S = the server's (`target.hostKeys`), C = a confirmation in this request, P = the key presented now.

| # | L | S | C | Result |
| --- | --- | --- | --- | --- |
| 1 | = P | any | — | `ok`; the hop is listed in `data.hops` with P |
| 2 | ≠ P | any | `sha256 = P`, `replacing = L` | replace: the old line stays as a comment `# replaced <time> <old fingerprint>`, the new key is written, `ok` |
| 3 | ≠ P | any | otherwise | **`failed` `host_key_changed`**, `data.expected = L`, `data.presented = P`. Hard stop |
| 4 | none | = P | — | trusted before (perhaps from another device): write L, `ok` |
| 5 | none | ≠ P | — | `failed` `host_key_changed` with `expected = S`: a different computer answers, or the key changed while this connector's record was lost |
| 6 | none | none | `sha256 = P` | trust on first use, confirmed by the person: write L, `ok` |
| 7 | none | none | none | `needs_action` `host_key_unknown`, `data.hop` and `data.fingerprint = P` |
| 8 | none | ≠ P | `sha256 = P`, `replacing = S` | the person replaces the key the server remembers (a new machine, a rotated host key): write L, `ok` |

**Report shape.** One rule for every `host_identity` report: each hop that passed (rows 1, 2, 4, 6 and 8) is listed in `data.hops` as `{ hop, fingerprint, address? }`, jump host first. That holds for a single hop too, and also on a stage that is `needs_action` or `failed` because the target stopped after the jump host passed. The singular `data.hop`, `data.fingerprint` and `data.algorithm` (row 7) and `data.expected` and `data.presented` (rows 3 and 5) describe only the hop that stopped the stage, and an `ok` stage carries none of them. `link.schema.json` enforces this (`$defs/stage`: an `ok` stage needs `data.hops` and nothing singular, `needs_action` needs `hop` and `fingerprint`, `host_key_changed` needs `hop`, `expected` and `presented`; only `host_identity` may carry these keys). `c2s-test_result-needs_action-jump.json` shows a jump host that passed while the target needs confirmation.

The negotiated algorithm is restricted to the key types already recorded for the host (the connector reads its own file and sets `ClientConfig.HostKeyAlgorithms`; `x/crypto` has no helper for it), so a server that offers an additional key type is not reported as changed. Fingerprints are OpenSSH's `SHA256:` form (`ssh.FingerprintSHA256`).

**Trust limit.** `confirmations` and `hostKeys` arrive in the relay's message, so the connector cannot itself tell that a person confirmed: a compromised relay could write a `known_hosts` entry (the same limit as §1). The connector therefore prints every trust write and replacement on its terminal and in its log, `--confirm-sessions` covers it, and the old line is always kept as history.

**Server side.** The server reads host keys only from `data.hops` of a `host_identity` stage (in `test_progress` or `test_result`, whatever the stage's status) and only for a `host:port` it sent as this connection's target or jump host. For each listed hop:

- the connection holds no record for that `host:port` → store it. Rows 1, 4, 6 and 8 all mean the person trusted that key, on this device or before. This covers a jump host confirmed in a test whose target still needed confirmation (on the next test that hop is row 1, unconfirmed in that request), and a host this connector already trusted through another connection or whose record a PATCH cleared. Without it, another device would see a changed key as row 7 (accept on first use) instead of row 5 (hard stop);
- the record equals the listed key → nothing changes;
- the record differs → it is replaced only by an accepted replacement confirmation in this request (`sha256` equal to the listed key, `replacing` checked as below); otherwise the record is kept (row 1 with records that have drifted apart, which the replace flow reconciles).

The singular fields of the hop that stopped are never stored, and a `host_key_changed` never alters a record. Replacing is a deliberate act: `POST /api/me/connections/:id/test` with `confirmations[{ …, replacing }]` where `replacing` equals `data.expected` of this connection's latest `host_key_changed` result for that `host:port` held by the server (row 3 reports the connector's record, row 5 the server's), whether or not the server holds a record of its own; this is what lets a connector-wide `known_hosts` entry and a per-connection record that have drifted apart be replaced in one step. It requires authentication within 15 minutes, and appends audit `connection.host_key_replaced` with both fingerprints. The panel (P3-07) shows both fingerprints, never retries on its own, and puts the replace action behind a confirmation that names the host (A30: the application neither silently accepts the new key nor discards the trust record).

### 5.3 Authentication and the MFA policy

Per hop (jump host, then target), in this order, stopping at the first success:

1. `method: 'agent'`: the identities of the connector computer's SSH agent (`SSH_AUTH_SOCK`; on Windows the OpenSSH agent pipe `\\.\pipe\openssh-ssh-agent`, opened as a file, so no extra dependency). `hint` selects by comment or fingerprint; the connector offers identities one at a time and a connection made from a class template must carry a `hint`, so a template host never sees every key in the agent. Hardware-backed keys (`sk-…`) work only through an agent.
2. `method: 'key'`: the key file at `keyPath`, with the certificate `<keyPath>-cert.pub` when it exists. An encrypted key's passphrase is read from the connector's own terminal without echo (`golang.org/x/term`) when `features.tty` is true, kept only for the duration of the call, and never sent anywhere.
3. A second factor, only when the host answers publickey with *partial success* and asks `keyboard-interactive`: the host's prompt text is shown in the connector's terminal after control characters and escape sequences are stripped, labelled with the host it came from, and the person types the answer there. Prompts and answers **never pass through Parallax**. Three wrong answers, or the `ssh_auth` deadline of §5.1 passing before an answer (120 s once a prompt starts, shared by both hops of a jump route), is `mfa_failed`.

**Not supported in v1:** password authentication (the protocol has no field for a password and the connector never asks for a login password), GSSAPI/Kerberos, `ProxyCommand`, agent forwarding (never requested), and storing passphrases in an OS keychain. A host that offers only those fails with `auth_method_unsupported` and the methods it offered in `detail`. Without a terminal (`run` started as a service) a passphrase or second factor fails with `key_passphrase_required` or `mfa_requires_terminal`, whose recovery is to run the connector in a terminal or load the key into an agent. The spec's "OS credential store" is the connector's own state directory (§13); it holds no SSH secrets.

One SSH connection per session is kept and multiplexed (a `direct-tcpip` channel per request, `keepalive@openssh.com` every 15 s). A connection that passed Test connection is kept for 120 s so that the Connect that follows for the same connection id reuses it: one second factor, not two.

### 5.4 Error catalogue

[`errors.json`](../../connector/protocol/v1/errors.json) is the source; this table is generated from it. The **Stage** column is the stage that usually reports a code; a stage deadline can report a code from another stage (§5.1). The web app renders copy per code (`apps/web/src/notebooks/connect/messages.ts`), and a test fails if a code has no copy. §14 of the specification asks for "reachability, host-key, authentication, tunnel, runtime, or kernel failure"; the **cause** column uses those words, plus `workspace` (spec §10.3 lists directory access separately), `policy` and `protocol`.

| Cause | Meaning |
| --- | --- |
| `reachability` | The connector cannot reach the host. |
| `host_key` | The host's identity is unknown or has changed. |
| `authentication` | The host or the notebook service refused the credentials. |
| `workspace` | The working directory is missing or not usable. |
| `tunnel` | SSH works but forwarding to the notebook service is not. |
| `runtime` | Jupyter is missing, incompatible or would not start. |
| `kernel` | No usable kernel. |
| `policy` | Parallax or the connector refuses this destination. |
| `protocol` | The link itself failed; not caused by the target. |

| Code | Stage | Cause (spec §14) | Retry | Recoveries (in order) | Meaning |
| --- | --- | --- | --- | --- | --- |
| `host_unresolved` | `reachability` | reachability | yes | check_address, check_network, retry | The host name did not resolve. |
| `connection_refused` | `reachability` | reachability | yes | check_address, contact_host_owner, retry | The host refused the connection on that port. |
| `connection_timeout` | `reachability` | reachability | yes | check_network, start_vpn, retry | The host did not answer in time. |
| `network_scope_denied` | `reachability` | policy | no | allow_network, pick_other_target | This connector is not allowed to reach that address. |
| `unsupported_target` | `reachability` | policy | no | pick_other_target, update_connector | This connector does not support that kind of target. |
| `invalid_target` | `reachability` | policy | no | check_address | The target fails Parallax's validation. |
| `host_key_unknown` | `host_identity` | host_key | no | verify_host_key | First connection to this host: confirm its fingerprint. |
| `host_key_changed` | `host_identity` | host_key | no | contact_host_owner, replace_host_key, pick_other_target | The host's key differs from the trusted one. Connection stopped. |
| `host_key_untrusted_managed` | `host_identity` | host_key | no | contact_host_owner | A managed connector only connects to hosts its operator has pinned. |
| `key_file_unreadable` | `ssh_auth` | authentication | no | choose_key, use_agent | The key file is missing or not readable by the connector. |
| `key_passphrase_required` | `ssh_auth` | authentication | no | run_in_terminal, use_agent | The key needs a passphrase and the connector has no terminal to ask in. |
| `key_passphrase_wrong` | `ssh_auth` | authentication | yes | unlock_key, retry | The passphrase did not unlock the key. |
| `agent_unavailable` | `ssh_auth` | authentication | no | use_agent, choose_key | The connector found no SSH agent. |
| `agent_no_identity` | `ssh_auth` | authentication | no | use_agent, choose_key | The agent holds no matching identity. |
| `auth_rejected` | `ssh_auth` | authentication | no | choose_key, contact_host_owner | The host rejected every credential offered. |
| `auth_method_unsupported` | `ssh_auth` | authentication | no | contact_host_owner, pick_other_target | The host accepts only methods the connector does not support (password, Kerberos). |
| `mfa_requires_terminal` | `ssh_auth` | authentication | no | run_in_terminal | The host asks for a second factor and the connector has no terminal to ask in. |
| `mfa_failed` | `ssh_auth` | authentication | yes | retry | The second factor was not accepted or not given in time. |
| `workspace_missing` | `workspace` | workspace | no | choose_workspace | The working directory does not exist. |
| `workspace_not_directory` | `workspace` | workspace | no | choose_workspace | The working directory path is not a directory. |
| `workspace_not_writable` | `workspace` | workspace | no | choose_workspace, contact_host_owner | The account cannot write to the working directory. |
| `workspace_outside_root` | `runtime` | workspace | no | choose_workspace | The attached server's root does not contain the working directory. |
| `forwarding_denied` | `forwarding` | tunnel | no | enable_forwarding, pick_other_target, download_notebook | The SSH server forbids port forwarding for this account. |
| `tunnel_unavailable` | `forwarding` | tunnel | yes | retry | The tunnel could not be opened. |
| `remote_exec_denied` | `workspace` | runtime | no | contact_host_owner, start_jupyter_then_attach, pick_other_target | The account may not run commands over SSH. |
| `shell_unsupported` | `runtime` | runtime | no | start_jupyter_then_attach | The host is not a POSIX host; start Jupyter there yourself and attach. |
| `environment_invalid` | `runtime` | runtime | no | choose_environment | The chosen Python interpreter does not exist or cannot run. |
| `jupyter_missing` | `runtime` | runtime | no | install_jupyter, choose_environment | Jupyter Server is not installed in that environment. |
| `jupyter_incompatible` | `runtime` | runtime | no | install_jupyter, choose_environment | Jupyter Server is older than 2.0. |
| `jupyter_start_failed` | `runtime` | runtime | yes | retry, choose_environment | Jupyter exited while starting. |
| `jupyter_start_timeout` | `runtime` | runtime | yes | retry, wait | Jupyter did not become ready within 30 seconds. |
| `attach_none_found` | `runtime` | runtime | no | start_jupyter_then_attach, choose_environment | No running Jupyter server was found to attach to. |
| `attach_port_unreachable` | `runtime` | runtime | yes | start_jupyter_then_attach, retry | Nothing answered on the port to attach to. |
| `attach_not_loopback` | `runtime` | policy | no | pick_other_target | Only a server listening on loopback may be attached. |
| `token_unavailable` | `notebook_auth` | authentication | no | start_jupyter_then_attach, choose_environment | The connector cannot read the server's token, so it cannot attach. |
| `token_rejected` | `notebook_auth` | authentication | no | choose_environment, contact_host_owner | Jupyter rejected the connector's token. |
| `notebook_service_unreachable` | `notebook_auth` | tunnel | yes | retry, start_jupyter_then_attach | The tunnel is up but nothing answers from Jupyter. |
| `no_kernelspec` | `kernels` | kernel | no | install_jupyter, choose_environment | Jupyter lists no kernel. |
| `kernelspec_not_found` | `kernels` | kernel | no | choose_environment | The chosen kernel is not installed. |
| `kernel_start_failed` | `kernels` | kernel | yes | retry, choose_environment | The kernel process would not start. |
| `unsupported_message` | — | protocol | no | update_connector | The peer sent a message type this side does not know. |
| `invalid_message` | — | protocol | no | update_connector | The peer sent a message that fails the protocol schema. |
| `unknown_session` | — | protocol | no | new_session | The session id is not known here. |
| `unknown_stream` | — | protocol | no | retry | The stream id is not open. |
| `not_owned` | — | policy | no | none | The session was attached, not started by Parallax, so it cannot be stopped. |
| `limit_exceeded` | — | protocol | yes | wait, retry | A connector limit (sessions, streams, size) was reached. |
| `path_not_allowed` | — | policy | no | none | The request is outside the connector's allowlist. |
| `body_too_large` | — | policy | no | none | The request or response body exceeds the limit for its kind. |
| `not_ready` | — | protocol | yes | wait, retry | The session or kernel is not ready to run a cell. |
| `rate_limited` | — | protocol | yes | wait | Too many requests; slow down. |
| `busy` | — | protocol | yes | wait, retry | The session is busy with a previous request. |
| `test_timeout` | — | protocol | yes | retry | The test did not finish in time. |
| `stream_cancelled` | — | protocol | yes | retry | The stream was cancelled by the peer. |
| `internal` | — | protocol | yes | retry | The connector failed unexpectedly; see its log. |

### 5.5 Losing a session: causes

When a session's transport or process disappears, the connector sends `session_state { state: 'disconnected', cause }` using the first rule below that holds (`stopped` instead of `disconnected` when it confirmed the process is gone). Recoveries are in the catalogue's `loss` section and always include a way to keep editing and, where it applies, reconnect or pick another target — never a promise that the old process or filesystem survived (spec §10.4, A36).

| # | Cause | Evidence |
| --- | --- | --- |
| 1 | `sleep` | two consecutive ticks of the connector's 1 s ticker are more than 15 s apart by the wall clock (`time.Now().Round(0)`, which carries no monotonic reading) since the last healthy check (a sleeping computer runs no ticks, whichever clock the platform's timers count; a clock step of that size is indistinguishable and is reported as sleep too) |
| 2 | `allocation_expired` | the target declared `expectedEnd`, now is within 5 minutes of it or later, and the transport closed with a disconnect message or reconnecting is refused or times out |
| 3 | `vpn` | an interface that looks like a VPN (names `tun*`, `utun*`, `wg*`, `ppp*`, `tap*`, `ipsec*`, `tailscale*`, `zt*`; on Windows adapter descriptions containing VPN, TAP, WireGuard, Tailscale, AnyConnect or GlobalProtect) that existed at the last healthy check is gone, or the interface carrying the route to the host changed |
| 4 | `network_change` | any other interface or address change since the last healthy check |
| 5 | `service_stopped` | the SSH transport is healthy and the owned process has exited, or an attached server stops answering while SSH answers |
| 6 | `host_unreachable` | the host was reachable before and every dial now fails |
| 7 | `ssh_timeout` | the keepalive went unanswered for 45 s and nothing above applies |
| — | `process_exited` | `local` target: the process ended on its own |

Reconnecting the SSH transport is automatic for as long as a lease is valid: after 2, 4, 8 and 16 s, then every 30 s for up to 10 minutes. When it succeeds and `/api/status` answers with the token, the connector reports `ready` again; the kernel may still be alive, and the relay finds out by asking Jupyter (A31, §10.6). Server-side causes that the connector never sends: `link_lost`, `connector_offline`, `connector_revoked`, `kernel_lost`.

| Cause | Set by | Recoveries | Meaning |
| --- | --- | --- | --- |
| `sleep` | connector | reconnect, new_session | This computer was asleep. Its processes were paused or ended. |
| `vpn` | connector | start_vpn, reconnect, pick_other_target | A VPN-like network interface went away or the route to the host moved. |
| `network_change` | connector | check_network, reconnect | The computer's network changed. |
| `ssh_timeout` | connector | reconnect, pick_other_target | The SSH connection stopped answering. |
| `service_stopped` | connector | new_session, reconnect | SSH works but the Jupyter service is no longer running. |
| `allocation_expired` | connector | pick_other_target, new_session | The time-limited allocation ended. |
| `host_unreachable` | connector | check_network, reconnect, pick_other_target | The host cannot be reached now. |
| `process_exited` | connector | new_session | The Jupyter process ended on its own. |
| `lease_idle` | connector | new_session | Stopped after the idle timeout. |
| `lease_grace` | connector | new_session | Stopped after the grace period with no browser attached. |
| `user_stop` | connector | new_session | Stopped by the person. |
| `connector_exit` | connector | new_session | The connector was stopped. |
| `connector_restarted` | server | new_session | The connector restarted and could not re-attach. Set by the server when a returning connector does not know the session. |
| `abandoned` | server | pick_other_target, new_session | The person gave up on an unreachable session. Server-side; says nothing about the process. |
| `max_lifetime` | connector | new_session | Stopped at the maximum session lifetime. |
| `link_lost` | server | reconnect | Parallax stopped hearing from the connector. Server-side cause; the connector never sends it. |
| `connector_offline` | server | reconnect | The connector is not connected to Parallax. Server-side cause. |
| `connector_revoked` | server | pick_other_target, new_session | The device was revoked or unpaired. Server-side cause. |
| `kernel_lost` | server | new_session | The kernel no longer exists; variables are gone. Server-side cause. |

### 5.6 What the interface may say

- **Ready** appears only when the session is `ready` (service verified with its token, kernels listed) **and** the selected kernel reports `idle`. **Connected** is never shown on SSH authentication alone (spec §10.1, §14).
- A mode label names the real state: `Saved outputs`, `Lab workstation · Python · Starting`, `… · Ready`, `… · Running`, `… · Waiting for input`, `… · Disconnected (this computer was asleep)`, `… · Unconfirmed` — never a state the server did not read.
- A disconnect is never described as completion. An execution with no confirmed reply is `Unconfirmed` or `Incomplete` (§10.6).
- Failure text comes from the catalogue by code and names the stage and the recovery; secrets never appear in it, and nor does raw tool output (the `detail` field is at most 512 characters of redacted text).

## 6. Runtime: start and attach

**Versions.** Jupyter Server 2.x (CI: 2.21.1) with ipykernel 6 or 7 (CI: 7.4.0); an older `jupyter_server` is `jupyter_incompatible`. R runs as an installed kernel (`IRkernel`, kernelspec `ir`); nothing in the connector is language specific.

**The token.** The connector generates 32 random bytes per session, hex-encoded, and holds them in memory. It is passed to Jupyter in the `JUPYTER_TOKEN` environment variable (`local`) or as the first line of the exec channel's standard input (`ssh`), **never** in an argument, a URL, a log line, `sessions.json` or a message, and the connector never writes it to a file. Jupyter itself writes `jpserver-<pid>.json` (mode 0600) to its runtime directory, which `jupyter server list` reads; the connector sets `JUPYTER_RUNTIME_DIR` to a private per-session directory (0700) that it removes when the session stops. Jupyter prints a URL containing the token when it starts: everything the connector reads from Jupyter's output goes through `redact()` (token query values and the token itself) before it is logged or put in a `detail`. An attached server's token is registered with `redact()` for every session attached to it, locally or over SSH, and stays redacted until the last of those sessions ends; text from Jupyter is also stripped of escape sequences, control and format characters before it reaches the terminal (the same sanitiser as host prompts, §5.3). Requests carry `Authorization: token <t>`. A restarted connector cannot recover the token of a session it started, which is why it stops such orphans (below).

**Fixed server flags.** `--ServerApp.ip=127.0.0.1 --ServerApp.port=<P> --ServerApp.port_retries=0 --ServerApp.open_browser=False --ServerApp.root_dir=<workspace> --ServerApp.allow_remote_access=False --ParallaxMarker.session=<sessionId>`. The last is a marker no Jupyter class reads (traitlets ignores configuration for unknown classes); it lets the connector prove that a pid is its own process before signalling it. If a future Jupyter rejects it, the template drops it and the proof falls back to matching the port and root directory in the process arguments. The kernel manager keeps the default `buffer_offline_messages`, which §7 relies on.

**`local` target.** Pick a free port (bind `127.0.0.1:0`, read it, close; retry up to 3 times on a bind race). Run `<python> -m jupyter_server …` (`runtime.python`) or `jupyter server …` from `PATH`, with the workspace as working directory and no stdin. Poll `/api/status` every 250 ms for up to 30 s; an exit before that is `jupyter_start_failed` with the last redacted lines. Children die with the connector where the OS can arrange it: `Pdeathsig` on Linux (the child is spawned from a goroutine locked to its OS thread, because the signal follows the spawning thread), a job object with kill-on-close on Windows. macOS has no such facility, so all platforms also sweep on start-up (below).

**`ssh` target.** After the stages up to `forwarding`: check `uname -s` (a POSIX host; anything else is `shell_unsupported`, attach mode only). Start with this fixed template; every argument is single-quoted by `shellQuote` (wrap in `'…'`, replace `'` with `'\''`), and the only variable parts are the validated workspace, interpreter, port and session id (a leading `~/` in the interpreter is sent as `"$HOME"/…`, because `~` is not expanded inside quotes):

```
sh -c 'cd -- "$1" || exit 70; IFS= read -r JUPYTER_TOKEN || exit 71; export JUPYTER_TOKEN; echo "PARALLAX_PID=$$"; shift; exec "$@"' sh WORKSPACE PYTHON -m jupyter_server <fixed flags>
```

With `login: true` the same script runs under `bash -lc`. The token is written to standard input, which is then closed. The script stays on one line because SSH hands the command to the account's login shell, and csh and tcsh reject a newline inside quotes. The pid arrives as a line starting `PARALLAX_PID=`, found by scanning the output (a login shell's profile may print banners first); `$$` becomes the Jupyter pid at `exec`. The port is random in 20000–59999, retried up to five times on "address already in use". The tunnel is `ssh.Client.Dial("tcp", "127.0.0.1:<P>")` per stream; the destination is fixed for the session (§8). A host without a POSIX shell, Windows OpenSSH included, is `shell_unsupported` for every operation in v1.

**Attach.** The connector lists servers with `jupyter server list --json` (locally, or by exec on the target), keeps those that listen on loopback and have a readable token, and reports them in `test_result.attachable` without tokens. `open_session { runtime: { mode: 'attach', port } }` must name one of them (or a port the list shows); a server it cannot read a token for is `token_unavailable` — in v1 no token is typed into Parallax or the connector. The workspace must lie within the attached server's `root_dir` (`workspace_outside_root`); contents calls are confined to it (§7).

**Ownership and stopping.** `owned` is true only for a process this connector started for this session. Stop = `POST /api/shutdown` through the tunnel, wait up to 10 s for the process (`local`: child exit; `ssh`: the exec channel ends), then `SIGTERM` to the recorded pid after proving the marker (`ps -o args= -p <pid>`), 5 s later `SIGKILL`. `stopped` is sent only after the process is confirmed gone, and the tunnel is closed. An attached session is never signalled: `close_session { stop: true }` is `error not_owned`, and its lease ends by closing the tunnel with `stopped` / `lease_grace` and `owned: false`, leaving the server running (A32).

**Connector exit.** Ctrl-C or SIGTERM stops owned sessions (10 s budget, cause `connector_exit`; the stop's waits are shortened to fit the budget, half for the shutdown request and a quarter for `SIGTERM`, so `SIGKILL` still runs, and a session still starting is cancelled and waited for). After a crash the next `run` reads `sessions.json`, and for each owned record proves the marker and kills the local process, or, for a remote one, tries a non-interactive connection (agent or unencrypted key, 20 s) to do the same; whatever it cannot reach is left in the list that `doctor` prints as "possibly orphaned". A `sessions.json` that cannot be read is salvaged before it is replaced: each record valid on its own is swept as above, and for every other session id the file mentions, a local process of the same user whose arguments carry that id's marker is killed (the remote process of an unreadable record cannot be reached and is only logged). The records are then removed and, if the server asks, `session_state stopped` / `connector_restarted` is sent.

## 7. The Jupyter proxy and its allowlist

The browser never names a Jupyter path, host or port. The relay exposes **typed operations** and builds each request itself from validated arguments (`apps/server/src/relay/jupyter.ts`: `status`, `kernelspecs`, `listKernels`, `startKernel(name)`, `kernelState(id)`, `interruptKernel(id)`, `restartKernel(id)`, `deleteKernel(id)`, `openChannel(id)`, and for file transfer `contents.list/get/put/delete`); the connector then checks the request again against the table below. A path or method not in the table is `error path_not_allowed`, whoever asked.

| `purpose` | Method | Path (after decoding) | Notes |
| --- | --- | --- | --- |
| `session` | GET | `/api/status`, `/api/kernelspecs`, `/api/kernels`, `/api/kernels/{uuid}` | |
| `session` | POST | `/api/kernels` | JSON body `{ "name": … }`, ≤ 1 KiB |
| `session` | DELETE | `/api/kernels/{uuid}` | |
| `session` | POST | `/api/kernels/{uuid}/interrupt`, `/api/kernels/{uuid}/restart` | |
| `session` | WebSocket | `/api/kernels/{uuid}/channels?session_id={uuid}` | the only WebSocket; no subprotocol, so Jupyter speaks its JSON text dialect |
| `contents` | GET, PUT | `/api/contents/{relpath}` | query keys `content`, `type`, `format`, `hash` only |
| `contents` | POST | `/api/contents/{reldir}` | |
| `contents` | DELETE | `/api/contents/{relpath}` | |

**Confinement.** The session records the kernel ids it created (`POST /api/kernels` answers) and the connector accepts a `{uuid}` only from that set, so in attach mode other people's kernels on the same server are out of reach (spec §10.4). A `POST /api/contents/{reldir}` body may hold only `type` and `ext`; `copy_from` and any other key are refused.

Not served, ever: `/api/sessions`, `/api/terminals`, `/api/shutdown` (used by the connector itself), `/api/config`, `/api/me`, `/api/nbconvert`, `/api/events`, `/lab`, `/tree`, `/files`, extensions and kernelspec resources. (ADR-0005 listed `/api/sessions`; the relay tracks kernels itself, so the surface is smaller.)

**Path rules.** Decode percent-escapes once; reject a path whose decoding changes again, and any NUL, backslash, `//`, `.` or `..` segment, segment starting with `.`, or length over 1024. Only the query keys in the table are allowed, with simple values; `token` and `_xsrf` are refused anywhere. A `relpath` must equal the session's content root or lie below it, compared **segment by segment** (root `parallax` admits `parallax/a.csv` and refuses `parallax-private/a.csv`); the content root is the workspace relative to the server's `root_dir`, empty for an owned session. The connector reports it with `session_state ready` (`contentRoot`), and the relay places every workspace path below it; a session without a reported root that the relay cannot infer (an attached one) gets no file transfer (`workspace_unknown`). Symbolic links inside the workspace are the account's business: the workspace is a convenience boundary, not a sandbox around the code that runs there (spec §10.5).

**Headers.** From the relay, only `content-type` and `accept` are accepted. The connector adds `Authorization: token <t>`, `Host: 127.0.0.1:<P>`, `Origin: http://127.0.0.1:<P>` on the WebSocket, and `Content-Length`; it forwards no cookie. Responses return `content-type`, `content-length`, `etag`, `last-modified`, `cache-control`; `Set-Cookie`, `Location`, `Server` and `X-*` are dropped. The connector's HTTP client follows no redirects, uses no proxy and can dial only the session's tunnel. Jupyter exempts token-authenticated requests from its XSRF check; P3-04's `httptest` fake and P3-11's fixture assert that this holds for the pinned version.

**One kernel channel per kernel.** The relay opens a single channel stream to a kernel when the kernel is created (or when the link returns), independent of any browser. It uses the notebook session's id as Jupyter's `session_id`, so Jupyter's offline buffer (`buffer_offline_messages`, on by default in Jupyter Server 2) replays what the kernel emitted while no client was connected: "restore only output actually retained by the runtime" (spec §10.4). Where that does not cover a gap, the execution is `incomplete` (§10.6). P3-11's A31 flow checks the replay on the pinned Jupyter version; if a version does not replay, §10.6 already says what the person sees. Output that arrives is untrusted: it reaches the browser only as nbformat outputs that the notebook renderer's sanitiser (P2-13, A09) already handles; live HTML or JavaScript output is rendered the same way stored output is, in the sandboxed frame on the content origin.

## 8. Network scope

Spec §10.6: permit only authorised target and port combinations; stop user-supplied destinations reaching application databases, metadata endpoints or unrelated internal services; allow private addresses only through the connector's explicitly approved scope; bind the intended target after resolution; validate the forwarding destination as well as the SSH endpoint.

| Class | Examples | Personal connector, default | Personal, `--allow-net` covers it | Managed connector |
| --- | --- | --- | --- | --- |
| Hard-denied | `0.0.0.0/8`, `::`, `224.0.0.0/4`, `ff00::/8`, `255.255.255.255`, `169.254.0.0/16`, `fe80::/10` | denied | **denied** | denied |
| Loopback | `127.0.0.0/8`, `::1` | denied for `ssh`; `local` dials nothing | allowed | denied (configuration refuses it) |
| Private or shared | `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, `100.64/10` | denied | allowed | only if `PARALLAX_ALLOW_NET` covers it |
| Global unicast | everything else | allowed | allowed | only if `PARALLAX_ALLOW_NET` or `PARALLAX_ALLOW_HOSTS` covers it |

IPv4-mapped (`::ffff:a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses are unwrapped to the embedded IPv4 address before classification. Loopback is allowable for a personal connector because a person often reaches a cluster through a tunnel they opened themselves (`ssh -L 2222:node:22 bastion`, target `127.0.0.1:2222`).

**Order of checks for every dial.** (1) `validateTarget` (§4.4). (2) A literal address is classified; a name is resolved by the system resolver and **every** answer must be allowed (a denied answer among allowed ones defeats mixed-answer rebinding). (3) The connector dials the first allowed address *by IP*, and a `net.Dialer.Control` hook classifies the address actually being connected, so a race between check and connect cannot redirect it. The name is resolved once per attempt; the host key is verified against the name as typed. (4) For a jump host the same applies to the jump host; the onward hop is dialled by the jump host, so the connector can classify it only when it is a literal, and for a name relies on the jump host's own policy (a personal connector) or on `PARALLAX_ALLOW_HOSTS` (a managed one). (5) **The forwarding destination is fixed:** `127.0.0.1:<P>` of the session, `direct-tcpip` only; no message after `open_session` can change a host or a port, and an attached port is validated at open (≥ 1024, loopback listener found by `jupyter server list`). (6) Ports: a personal connector allows any 1–65535; a managed one only `PARALLAX_ALLOW_PORTS` (default 22).

**Scope configuration.** `--allow-net CIDR` (repeatable) or `PARALLAX_ALLOW_NET=cidr,cidr` on `run`, never persisted by `pair`. It is reported in `hello.networkScope`, so the panel can say "This connector reaches public hosts and 10.20.0.0/16", and the server's `relay/netpolicy.ts` applies rules 1–2 of §4.4 and the class table above to a *literal* address when a connection is saved (public addresses pass; private or loopback ones only if the reported `cidrs` cover them; a connector that has never linked reports nothing, so only the hard-denied classes are refused) (`400 { error: 'target_not_allowed', code }`). The connector stays authoritative: it checks again on every open.

## 9. Sessions and leases

**Policy.** `lease = { idleTimeoutMin, gracePeriodMin }`, defaults 30 and 5, bounds 5–240 and 1–60, chosen per session (a class template may set them within the bounds, a person may change them in the panel) and shown before Connect in words: "Closing this tab keeps your kernel for 5 minutes. An open notebook with no activity stops after 30 minutes." The connector enforces it from `sessions.json`, with no server involved.

**Phases of an owned session.**

| Phase | When | Deadline |
| --- | --- | --- |
| `attached` | the server's last `presence` for the session is `attached: true` and the link is up | `lastActivityAt + idleTimeout` |
| `detached` | `presence { attached: false }`, **or the link is down** (without the relay no browser can be attached) | `detachedAt + gracePeriod`; a busy kernel does not extend it |

*Activity* resets the idle clock: an `activity` message; a kernel `execution_state` of `busy` seen in the connector's poll of `GET /api/kernels` (every heartbeat); a change of presence. Relayed streams do not count, because the relay's own polling would keep every session alive forever. When the deadline passes the connector stops the process (§6) and sends `stopped` with cause `lease_idle` or `lease_grace`. Deadlines are wall-clock instants. When the check that finds a deadline already passed runs at a wake-up (rule 1 of §5.5 holds), the cause is **`sleep`**, so a sleeping laptop gets its own true cause (spec §10.4); otherwise it is `lease_idle` or `lease_grace`. The lease text says that a passed deadline stops the session on wake-up.

An **attached** session is never stopped: when its detached deadline passes, the connector closes the tunnel and forgets the session (`stopped`, `lease_grace`, `owned: false`), leaving the person's server running.

**Maximum lifetime.** Whatever the relay says, an owned session is stopped 12 hours after it started (`hardDeadline`, cause `max_lifetime`), so a relay fault cannot keep a process alive indefinitely.

**`sessions.json`** (schema `state.schema.json#/$defs/Sessions`) records, per held session: ids, `owned`, the target (kind, host, port, user, workspace and the `auth`, jump host and `hostKeys` references the orphan sweep needs to reconnect), the ids of the kernels the session created, the process (`where`, pid, port, start time; owned only), the lease, `phase`, `lastActivityAt`, `detachedAt`, `expiresAt`, `state`. It never holds a token, key, passphrase or password. **Stopped while unreachable.** A session the connector stops while the link is down (grace passed during an outage, a deadline passed during a sleep, `max_lifetime`) stays in `sessions.json` as `state: stopped` with its `cause` and `stoppedAt` until a `session_state stopped` for it has been sent on a live link; the first heartbeat after `hello` lists these too. The server therefore learns the true cause (for a sleeping laptop, `sleep`, not `connector_restarted`).

It is written to a temporary file in the same directory and renamed, mode 0600, on every state or phase change and otherwise at most every 5 seconds.

**Server view.** `notebook_sessions.lease_expires_at` mirrors `leaseExpiresAt` for display. The server never stops a session itself. It marks a session `unconfirmed` (cause `link_lost`) when 45 s pass without a heartbeat, back to the connector-reported state when the link returns, and `stopped` only on the connector's word, with cause `connector_restarted` when a returning connector does not know the session, or with cause `membership_removed` when the person is removed from the class (ADR-0002 "Permission revoked"; an owned process is then stopped by the heartbeat clean-up of §10.7). It never marks one completed because a link closed (spec §10.4).

## 10. Server side (`apps/server`)

### 10.1 Process and modes

`main.ts` gains the mode `relay` (P3-02a). **`relay` serves everything `api` serves** and additionally the routes that need a live connector link: the link itself, Test connection, notebook sessions and the browser channel. Relay-only route modules live in `apps/server/src/http/relay/*.routes.ts`, loaded only in `relay` mode; the isolation matrix builds the app in that mode, so they are covered. The live-link registry is in memory, so **production runs exactly one `relay` process** (dev, e2e and the pilot do the same); several would need a registry in Postgres and sticky routing, which is not designed here. `pnpm dev` and the e2e server run `relay`. Everything else about the HTTP surface is unchanged: every route is registered through `registerRoute` with a contract that declares `scope` and `examples`.

WebSocket routes use `@fastify/websocket` 11.3.1 (ADR-0001). A contract may declare `websocket: true`; `registerRoute` then registers the upgrade handler *after* the scope resolver ran in `preValidation`, so a non-member gets the same HTTP 404 before any upgrade, and the matrix test replays the contract as a plain `GET`. Browser upgrades check `Origin` against `APP_ORIGIN` (403 otherwise: cross-site WebSocket hijacking), and a resolved class scope is re-validated every 60 s and on every message naming a resource (ADR-0002 "Jobs and sockets").

### 10.2 Tables

Migrations are added only by chain items: P3-02 (first four tables) and P3-06 (the rest). Names follow the plan (`NNNN_p3-02_connectors.sql`, `NNNN_p3-06_notebook_sessions.sql`).

**P3-02** (`db/schema/connectors.ts`):

| Table | Columns (all `NOT NULL` unless marked) |
| --- | --- |
| `connectors` | `id` uuid pk; `owner_user_id` → `users` (**nullable**; check `(mode = 'personal') = (owner_user_id IS NOT NULL)`, so a managed connector needs no later migration); `name` 1–60; `mode` (`personal`, `managed`); `status` (`pending`, `active`, `revoked`); `public_key` bytea, length 32; `fingerprint` text unique; `os`, `arch`, `version` text; `network_scope` jsonb (`{cidrs, hosts}`); `approve_by` (pending only); `approved_at`, `revoked_at`, `revoked_reason` (`user`, `unpair`, `account`, `expired`, `rejected`), `last_seen_at` nullable; `created_at`. Checks tie `status` to the timestamps. Index `(owner_user_id, status)` |
| `connector_pairings` | `id` pk; `owner_user_id` → `users`; `code_hash` bytea unique (§3); `expires_at`; `used_at`, `connector_id` → `connectors` nullable; `created_at`. Expired rows are purged by the maintenance job |
| `notebook_connections` | `id` pk; `owner_user_id` → `users`; `connector_id` → `connectors`; `name` 1–60 (unique per owner among unarchived, case-insensitive); `target` jsonb (the `target` of §4.4, validated, no secrets); `runtime` jsonb; `template_id` → `class_compute_templates` nullable; `trusted_host_keys` jsonb (`[{host, port, sha256, confirmedAt}]`); `created_at`, `updated_at`; `archived_at` nullable |
| `class_compute_templates` | `id` pk; `class_id` → `classes`; `name`, `description`; `target` jsonb (host, port, optional jump host, workspace pattern; **no user, no auth**); `runtime` jsonb; `isolation` (`account`, `container`, `allocation`); `lease` jsonb nullable; `host_owner_confirmed_by` → `users`, `host_owner_confirmed_at`; `created_by` → `users`; `created_at`; `archived_at` nullable. Class-scoped: listed in `classScopedTables` |

`connectors`, `connector_pairings` and `notebook_connections` are **user-owned**, not class data: they carry no `class_id`. `db/scoped.ts` gains `userOwnedTables` and `forUser(scope: UserScope, table)` (`WHERE owner_user_id = scope.user.id`), with an introspection test like the class one, and the raw-client lint covers them. The session below is the class-scoped record.

**P3-06** (`db/schema/notebook-sessions.ts`; every table has `class_id`, is class-scoped, and is added to `classScopedTables`):

| Table | Columns |
| --- | --- |
| `notebook_sessions` | `id` pk; `class_id`; `user_id`; `connection_id` → `notebook_connections`; `connector_id` → `connectors`; `resource_revision_id` → `resource_revisions`; `working_copy_id` nullable (P3-09); `state` (`starting`, `ready`, `disconnected`, `unconfirmed`, `stopping`, `stopped`, `failed`); `cause` text nullable; `owned` bool; `runtime` jsonb (mode, kernelspecs); `environment` jsonb nullable; `jupyter_version`; `lease` jsonb; `lease_expires_at` nullable; `kernel_id`, `kernel_name` nullable; `kernel_generation` int default 0; `last_heartbeat_at`, `last_confirmed_at` nullable; `created_at`, `stopped_at` nullable. Unique partial index on `(user_id, class_id, resource_revision_id)` where `state NOT IN ('stopped','failed')` (a session that cannot be reached is left with **Forget**, §10.7, so it never blocks a new one); index on `(connector_id)` for open sessions |
| `cell_executions` | `id` pk; `class_id`; `session_id`; `client_ref` uuid; `seq` bigint; `cell_id`; `resource_revision_id`; `working_copy_revision` int nullable; `code_hash` bytea (SHA-256); `kernel_id`; `kernel_generation`; `msg_id` uuid unique; `state` (`sent`, `running`, `ok`, `error`, `aborted`, `incomplete`, `unconfirmed`); `execution_count` nullable; `outputs_incomplete` bool; `sent_at`, `finished_at` nullable. Unique `(session_id, client_ref)` and `(session_id, seq)` |
| `notebook_working_copies` | `id` pk; `user_id`; `source_revision_id`; `current_revision` int; `created_at`, `updated_at`. Unique `(user_id, class_id, source_revision_id)` |
| `notebook_working_copy_revisions` | `(working_copy_id, revision)` pk; `class_id`; `storage_object_id`; `sha256`; `size`; `source` (`browser`, `import`, `server`); `created_at` |
| `file_transfers` | `id` pk; `class_id`; `session_id`; `user_id`; `direction` (`in`, `out`); `path` (relative to the workspace); `sha256`; `size`; `state` (`started`, `done`, `failed`, `conflict`); `storage_object_id` nullable; `conflict` jsonb nullable; `created_at`, `finished_at` |
| `notebook_submission_files` | `(submission_id, path)` pk; `class_id`; `file_transfer_id`; `sha256`; `size`; `storage_object_id` |

P3-06's migration also adds to `notebook_submissions` (created by P2-14) whichever of `working_copy_id`, `working_copy_revision`, `session_id` and `environment` it lacks; the implementer reads the merged P2-14 schema first.

**Audit** (`audit_events`, ADR-0002): `connector.paired`, `connector.approved`, `connector.revoked`, `connection.created`, `connection.updated`, `connection.archived`, `connection.host_key_trusted`, `connection.host_key_replaced`, `session.opened`, `session.stopped`, `template.published`, `template.archived`, `template.used`, `transfer.copied_in`, `transfer.copied_out`. Scope `user` for the first eight, `class` for the rest. Before/after summaries never contain keys, tokens or key paths beyond the connection's host and user.

### 10.3 Endpoints

HTTP routes are registered with `registerRoute` and WebSocket routes (the link and `…/channels`) with `registerWebSocketRoute` (ADR-0002); contracts live in `packages/contracts/src/routes/{connectors,connections,notebookSessions,...}.ts` with `examples`. `user` routes refuse a `kind: 'preview'` principal with 403. A row that is not the caller's is a 404 with the shared body, for the owner's own instructors too (A33).

| Method and path | Scope | Item | Notes |
| --- | --- | --- | --- |
| `POST /api/me/connectors/pairings` | user | P3-02 | §3 |
| `GET /api/me/connectors` | user | P3-02 | `[{ id, name, os, arch, version, fingerprint, status, mode, online, lastSeenAt, createdAt, approveBy, networkScope }]`; `online` from the live registry |
| `POST /api/me/connectors/:connectorId/approve` | user, recent auth | P3-02 | pending → active |
| `POST /api/me/connectors/:connectorId/revoke` | user | P3-02 | reject, unpair or revoke |
| `PATCH /api/me/connectors/:connectorId` | user | P3-02 | rename |
| `POST /api/connector/v1/pair`, `/pair/poll`, `/unpair` | public | P3-02 | §3; rate limited; signature or code is the credential |
| `GET /api/connector/v1/link` (WebSocket) | public | P3-02a | §4 |
| `GET/POST /api/me/connections`, `GET/PATCH/DELETE /api/me/connections/:connectionId` | user | P3-06 | create `{ name, connectorId, target, runtime, templateId? }` (connector must be the caller's and `active`); PATCH of host, port, user or jump clears the `trusted_host_keys` it no longer covers; DELETE archives, `409 in_use` while a session is open |
| `POST /api/me/connections/:connectionId/test` | user (recent auth when `confirmations[].replacing`) | P3-06 | body `{ confirmations?: [...] }` → `202 { testId }`; 409 `connector_offline` |
| `GET /api/me/connections/:connectionId/tests/:testId` | user | P3-06 | `{ state: 'running' \| 'done', stages, outcome?, kernelspecs?, attachable?, jupyterVersion?, environment? }`; `stages` holds the finished stages and, while the connector waits on its terminal, the `running` `ssh_auth` stage last; held in memory 10 minutes; the web polls every second |
| `GET/POST /api/classes/:classId/notebook-sessions`, `GET …/:sessionId` | class, any | P3-06 | create `{ connectionId, revisionId, runtime, lease? }` → `202 { sessionId, state }`; `409 connector_offline`, `409 session_exists` (with the open session's id) |
| `POST …/:sessionId/close` | class, any | P3-06 | `{ stop }` → `202`; `409 not_owned` |
| `POST …/:sessionId/forget` | class, any | P3-06 | gives up on a session that is `disconnected`, `unconfirmed` or `stopping` (a stop the connector has not confirmed, §10.7): state `stopped`, cause `abandoned`, nothing sent to the connector, and the interface says it does not know whether the process still runs. Lets the person pick another target (A36) |
| `POST/GET/DELETE …/:sessionId/kernel`, `POST …/kernel/interrupt`, `…/kernel/restart` | class, any | P3-06a | typed kernel operations; start `{ kernelName }` |
| `GET …/:sessionId/executions?afterSeq=` | class, any | P3-06a | reconcile after a reload |
| `POST …/:sessionId/outputs` | class, any | P3-08a | body `{ data, executionCount }`, the mime bundle of one `display_data` or `execute_result` that the browser received on the channel. The server sanitises it with the stored-output rules (§14), writes any HTML frame document or image under the session's area of class storage and answers `{ output, expiresAt }` with links on the content origin minted for the caller. Anyone but the session's owner gets the shared 404; `413` once the request body passes 8 MiB plus 64 KiB (the route's `bodyLimit`; nothing checks `data` on its own), `422 not_rendered` past the time or memory bound, `409` with `storage_limit` once a session has stored its share (100 MiB of objects not already stored, counted in memory in the relay process; a restart, or eviction of the session's entry once 2000 other sessions have stored new live output since, forgets the count, so it is not a hard cap) or `class_archived`, `429` beyond 120 a minute. The relay stores no outputs, so this is the only way live HTML, SVG or an image reaches the content origin |
| `GET …/:sessionId/channels` (WebSocket) | class, any | P3-06a | §10.5 |
| `GET/POST /api/classes/:classId/compute-templates`, `PATCH/DELETE …/:templateId` | class: any to read, instructor to write | P3-10 | §11 |
| `GET …/notebook-working-copies/:revisionId`, `PUT …/notebook-working-copies/:workingCopyId/revisions`, `POST …/notebook-working-copies/:workingCopyId/submit`, `GET …/notebook-sessions/:sessionId/files`, `POST` and `GET …/notebook-sessions/:sessionId/transfers`, `GET …/transfers/:transferId` | class, any | P3-09 | §11. `PUT …/revisions` takes `baseRevision` (`409 revision_conflict` carries the current copy) and a body up to 25 MiB (`bodyLimit`, declared `413`). `submit` takes `{ revision, sessionId, transferIds, submissionKey }` and works after the session ended. A session whose connector reported no usable content root (an older connector attached to a server) gets `409 workspace_unknown`; P3-09b (#299) added the `contentRoot` report with `ready` |
| `GET …/notebook-sessions/:sessionId/transfers/:transferId/download`, `GET /api/classes/:classId/notebook-submissions/:submissionId/files/:fileId/download` | class, any | P3-09 | not in the plan's original list. Routes beyond it, with the row above: `GET …/transfers` (the list, newest first, at most 200) and these two downloads. Each download answers `{ url, expiresAt }`, a link on the content origin served as an `application/octet-stream` attachment with `nosniff`; the second is the student's own snapshot file or any student's for an instructor, and asks nothing of the student's computer (A35). `GET …/notebook-submissions/:submissionId/download` (the snapshot itself) is P2-14's |

Rate limits, each enforced where named (`apps/server/src/http/budgets.ts` holds `WindowLimit`, `FailureBudget` and `Throttle`): connector pairing codes 5 an hour per person (`WindowLimit` in the handler); `pair` failures 10 per 10 minutes per IP (`FailureBudget` keyed on the request address, in `connectors.routes.ts`); `pair/poll` 1 a second per connector (`Throttle`); link attempts 30 a minute per IP (`LiveLinkRegistry`, `LINK_ATTEMPTS_PER_MINUTE` in `relay/links.ts`); tests 6 a minute per person and session creation 6 a minute per person (`WindowLimit` in the handlers); `execute` 30 a second per session (`EXECUTES_PER_SECOND` in `relay/kernel.ts`); live outputs (`POST …/outputs`) 120 a minute per person (`WindowLimit` in the handler). Among these routes, `@fastify/rate-limit` is used only for a per-address ceiling on three connector routes: `pair` 60 a minute, `pair/poll` 120 a minute and `unpair` 30 a minute.

### 10.4 The link registry and requests

`apps/server/src/relay/links.ts`: `LinkRegistry.get(connectorId)` returns the live `Link` or nothing; P3-02 ships the interface with an empty implementation (`online` is false), P3-02a the real one. A `Link` offers `request(message, { timeoutMs })` (matches the answer by `requestId`; a closed link rejects every pending request with `connector_offline`), `openStream(…)` (allocates the stream id, enforces `maxStreams` and the windows of §4.5), and `close(code)`. Only code that holds an `OwnedSession` or `OwnedConnection` (values returned by the `db/` functions that filter by the caller's scope) can name a connector, so a handler cannot message a connector it was not authorised for. The server drops, logs and counts a connector message that names a session or stream that is not on that connector's own list (`relay_unmatched_messages`).

### 10.5 Browser channel (P3-06a)

JSON text frames over the WebSocket, validated with zod in `packages/contracts/src/notebookChannel.ts`; `v: 1` on each.

| Dir | `t` | Fields |
| --- | --- | --- |
| c→s | `hello` | `resume?: { epoch, afterEventSeq }` |
| c→s | `execute` | `ref` (client uuid, the idempotency key), `cellId`, `workingCopyRevision?`, `code` (≤ 1 MiB) |
| c→s | `input_reply` | `executionId`, `value` |
| c→s | `interrupt` | — |
| s→c | `ready` | `epoch`, `eventSeq`, `session` (state, cause, owned, lease), `kernel` (id, name, state, generation) \| null |
| s→c | `execution` | `executionId`, `ref`, `cellId`, `seq`, `state`, `executionCount?`, `outputsIncomplete`, `generation` |
| s→c | `output` | `executionId`, `eventSeq`, `generation`, `kind` (`output`, `clear_output`, `input_request`), `output` (an nbformat output object: `stream`, `display_data`, `execute_result`, `error`; absent for the other kinds), `truncated?` |
| s→c | `kernel_state` | `state` (`starting`, `idle`, `busy`, `waiting_for_input`, `restarting`, `dead`, `unknown`), `generation` |
| s→c | `session_state` | `state`, `cause?`, `leaseExpiresAt?` |
| s→c | `error` | `code`, `detail?` (e.g. `not_ready`, `rate_limited`) |

`epoch` is a uuid per relay process life and session; a client that resumes with another epoch discards its position and treats missing output as incomplete.

### 10.6 Execution binding, reconnect and replay (A31)

**Binding.** On `execute` the relay (1) checks the session is `ready` and the kernel `idle` or `busy`; (2) in one transaction inserts the `cell_executions` row with `ON CONFLICT (session_id, client_ref) DO NOTHING`: **when the row already exists it answers with that row's state and sends nothing**, which is what makes a resent `execute` after a reconnect harmless; otherwise it assigns `seq`, `msg_id = randomUUID()`, the current `kernel_id` and `generation`, and `code_hash = SHA-256(code)`; (3) after commit writes the Jupyter `execute_request` (header `msg_id`, `session` = the notebook session id; `allow_stdin: true`, `stop_on_error: true`) on the kernel channel. **The relay never resends an `execute_request`**; if the write fails the execution becomes `unconfirmed` (it may or may not have reached the kernel).

**Matching.** Every kernel message is matched by `parent_header.msg_id` to an in-memory map rebuilt from the `sent`, `running` and `unconfirmed` rows. Messages with an unknown parent, from a channel whose kernel is not the session's current kernel, or with an old `generation` are dropped and counted, never shown. `status: busy` with a known parent moves the row to `running`; `execute_reply` moves it to `ok`, `error` or `aborted` and records `execution_count`; an `input_reply` is accepted only for the execution that owns the prompt.

**Restart and new kernel.** Restart calls the API, increments `kernel_generation`, moves every `sent`/`running`/`unconfirmed` execution to `aborted`, and announces `kernel_state restarting`; the outputs already shown carry their old `generation`, so the interface labels them as belonging to the previous kernel session (spec §10.4). Nothing is run again.

**Lost link, relay restart or kernel.** When the link to the connector drops, **or the relay process starts** (every non-terminal execution row is then treated the same way), `sent` and `running` executions become `unconfirmed`. When the link returns the relay asks Jupyter (`GET /api/kernels/{id}`): *404* → the session gets cause `kernel_lost`, the executions become `incomplete`, and the interface offers a new kernel with the warning that variables are gone; *busy* → it reopens the kernel channel with the same `session_id` so Jupyter replays what it buffered, the executions return to `running` with `outputs_incomplete = true` unless the replay closed the gap; *idle* with no `execute_reply` seen after the replay drains (2 s) → `incomplete`: the outcome is unknown and the person decides whether to run the cell again. A dropped **browser** socket changes nothing server-side: the relay keeps receiving and buffering; `resume` replays.

**Buffer.** Per execution the last 256 KiB of serialised `output` events (older ones dropped and `truncated` set), 8 MiB per session (finished executions are evicted oldest first). The relay stores no outputs durably: acknowledged outputs are those the browser saved to the working copy (P3-09).

### 10.7 Session state on the server

`nextSessionState(state, event)` is a pure function with a table-driven test.

| From | Event | To |
| --- | --- | --- |
| — | created, `open_session` sent | `starting` |
| `starting`, `disconnected`, `unconfirmed` | `session_state ready` | `ready` |
| `starting` | `session_state failed` | `failed` (`code` stored as cause) |
| `ready` | `session_state disconnected` | `disconnected` (connector's cause) |
| `ready`, `disconnected` | 45 s without a heartbeat, or the link closed | `unconfirmed` (`link_lost`) |
| any open state | `close` with `stop` accepted | `stopping` |
| `starting` | the connector answers `open_session` with `error` (`limit_exceeded`, `invalid_target`, `unsupported_target`, …) | `failed` (the error's code, not `test_timeout`) |
| `stopping` | the connector answers `close_session` with `error`, or 30 s pass without `stopped` | back to the last state the connector reported (`ready` or `disconnected`); the interface says the stop is unconfirmed and offers Stop again or Forget |
| any open state | `session_state stopped` | `stopped` |
| `unconfirmed` | the first `heartbeat` (seq 0) after `hello` lacks the session | `stopped` (`connector_restarted`) |
| `unconfirmed`, `ready`, `disconnected` | that heartbeat lists the session as `stopped` with a cause | `stopped` (the connector's cause: `lease_grace`, `sleep`, `max_lifetime` …) |
| `disconnected`, `unconfirmed`, `stopping` | the person chooses Forget | `stopped` (`abandoned`) |
| `unconfirmed` | the link returns and the connector reports `disconnected` | `disconnected` (the connector's cause) |
| `starting`, `stopping` | the link closes | `unconfirmed` (`link_lost`) |
| any open state | the connector is revoked | `unconfirmed` (`connector_revoked`) |
| any open state | the person is removed from the session's class (in the removing transaction, audited) | `stopped` (`membership_removed`); says nothing about the process, which the clean-up below stops at the next heartbeat when it is owned |
| any state | relay process start | every `sent`/`running` execution becomes `unconfirmed` (§10.6); sessions that were open become `unconfirmed` until their connector reports |

A heartbeat that lists an owned session the server has as `stopped` **or `failed`** (and whose own entry is not `stopped`) makes the server send `close_session { stop: true }` (clean-up of a leak), but never before the first heartbeat after `hello` has been processed. A session still `starting` after the 300 s of §5.1 becomes `failed` (`test_timeout`); a `ready` that arrives later is answered by that clean-up, so the process does not linger.

## 11. Files, working copies, transfer and submission (P3-09)

- **Working copy.** The course notebook is immutable (spec §10.5). The first Connect for (person, class, notebook revision) creates the working copy: revision 1 is the course notebook, tied to its resource revision. The browser saves with `PUT …/working-copies/:id/revisions { baseRevision, notebook }`; a stale `baseRevision` is `409 revision_conflict` carrying the current copy (the pattern of ADR-0003). **Saved to Parallax** is shown only after the `200`. Kernel memory is never saved, and the interface says so.
- **Declared files and copy-in.** Only the files the resource declares are copied into the workspace, and only after the person confirms "Copy N files to `<resolvedPath>`" (the exact destination from the `workspace` stage). For each file the server reads the remote one through `contents` (`purpose: 'contents'`): the same checksum is skipped; a different one is `conflict` and the person chooses *keep theirs*, *replace* or *save mine as `name (parallax).ext`* — nothing is overwritten unasked. The entire home directory is never listed or synchronised: listing is confined to the workspace.
- **Save to computer** exports the chosen revision as `.ipynb` into the workspace with the same checksum and conflict rules.
- **Import** reads a remotely edited `.ipynb`, validates it with the nbformat schema of P2-13 and stores it as a new working-copy revision (`source: 'import'`); it never replaces the current revision without the person's choice.
- **Output files** the code created are listed (name, size, modified); the person selects which to copy out. Copy-out stores them under `classes/{classId}/transfers/…` (25 MiB each, 200 MiB per session), and they are served only from the content origin as attachments (ADR-0002). Remote files that are not copied are not Parallax's: the interface says "stays on `<host>`".
- **Submit notebook** (`POST …/submit`) freezes a chosen **acknowledged** working-copy revision, the selected transferred files that are `done`, and the environment metadata from the session (`os`, `arch`, interpreter version) into `notebook_submissions` through P2-14's service, adding `notebook_submission_files` rows. Instructors review that snapshot from the existing submissions listing; no route lets an instructor reach a person's connection, connector or session (A35), and nothing from grading (hidden checks, answer keys) can reach a connector, because the only data that flows into a session is the cell code the person sends and the declared student-visible files. Outputs produced on a learner-controlled host are not trusted grades; assessments needing verified execution go to the runner (§11 of the specification).
- **Class host templates (P3-10).** An instructor publishes a template: name, description, target (host, port, optional jump host, and a workspace pattern in which `{user}` stands for the learner's own account name), runtime, isolation and optionally a lease, together with `host_owner_confirmed`, a required statement that the host owner permits this use. The learner picks the template, supplies **their own** account name and credential reference, and a `notebook_connections` row is created from it; the template carries no user, key, token or home directory. The connection screen states the template's isolation (`account`: an OS account per learner; `container`; `allocation`: an allocation service) in plain words, and states for a personal connection that it may reach that person's files with their privileges. Course membership grants no machine access, and instructors cannot see or operate students' connections. A template can only be used in its own class (checked when the session is created).

## 12. Managed mode

The same binary runs as `parallax-connector run --managed` where the institution operates a connector next to Parallax. It is **not required for A27–A36**. **Status (owner decision, 2026-10-08, issue #460): connector side only until the owner decides who operates managed connectors (spec §17).** P3-05b built the Go side, the registration script and the compose profile, and the schema and tables carry the mode (`mode`, `kind: 'managed'`, `auth.method: 'managed_key'`, `owner_user_id` nullable). Nothing in the server or the web app uses a managed connector yet: connections and class templates accept only `local` and `ssh` targets, and no item schedules `kind: 'managed'` targets there.

- **Configuration is environment only**, and nothing under it asks a question: `PARALLAX_SERVER`, `PARALLAX_CONNECTOR_ID`, `PARALLAX_IDENTITY_KEY_FILE` (a secret file; refused if group- or world-readable), `PARALLAX_ALLOW_NET`, `PARALLAX_ALLOW_HOSTS`, `PARALLAX_ALLOW_PORTS` (default `22`), `PARALLAX_KNOWN_HOSTS_FILE` (pinned by the operator, read-only), `PARALLAX_TARGETS_FILE` (`targetId` → host, port, optional jump, account rule, `keyId`, workspace rule, runtime) and `PARALLAX_KEYS_DIR` (key files named by `keyId`, read-only). The default scope is empty, i.e. nothing is reachable.
- **Differences from a personal connector:** no `local` target; no trust-on-first-use (an unpinned host is `host_key_untrusted_managed`); no terminal prompts (`key_passphrase_required` and `mfa_requires_terminal` are final); loopback and link-local are refused at configuration time; a target is named by `targetId`, so a learner cannot choose a host, a port or an account; leases are enforced exactly as in §9, including when the browser disappears.
- **Registration.** There is no instance-administrator role yet (plan §8, item 29), so a managed connector is registered by an operator script, `pnpm --filter @parallax/server connectors:register-managed --name … --public-key …`, which inserts an `active` row with `mode = 'managed'` and no owner and prints the connector id. Templates naming `kind: 'managed'` targets are the intended later step, not built: P3-10 templates are SSH only, and adding managed targets to templates and connections needs a new item once the owner decides who operates managed connectors.
- **Isolation of the process.** A separate network and credential boundary from the application (spec §10.6): the container has no database credentials and no application secrets, only its identity key and the key store; a read-only root file system, no capabilities, a non-root user; egress filtered at the network layer to the same scope the process enforces; ingress none (it dials the relay). `infra/compose.prod.yml` (P4-12) shows it on a network that has no route to Postgres or the object store.
- **What the allocation service must do.** A managed connector authenticates with the operator's key. Per-learner separation, one account or container per `subject`, is the host's allocation service's job (spec §10.3, §10.6), and a shared account is not isolation; the adapter for such services, and scheduler adapters for HPC login nodes, are extensions the specification already defers.

## 13. OS matrix, versions and distribution

Spec §17 asks for the tested connector and target matrix. "Supported" means fixed by tests that run in CI; "best effort" means the code path exists and `doctor` explains the limits.

| Connector computer | Architectures | Status | What CI runs |
| --- | --- | --- | --- |
| Linux (static binary, glibc or musl) | amd64, arm64 | supported | every PR: `go test` on `ubuntu-24.04` (amd64), cross-build of both |
| macOS 13 and later | arm64, amd64 | supported | every PR: cross-build; weekly `go test` on `macos-latest` |
| Windows 11 (10 22H2 best effort), native | amd64 | supported | every PR: cross-build and `GOOS=windows go vet`; weekly `go test` on `windows-latest` |
| Windows with WSL 2 | — | supported by running **the Linux connector inside the distribution**; its `local` target is the distribution, `features.wsl` is true. The Windows binary does not start WSL, SSH into it or reach `\\wsl$`. `doctor` detects WSL and prints this | the Linux tests |
| Windows arm64, 32-bit systems, BSDs | — | not built | — |

| SSH target | Start | Attach | CI |
| --- | --- | --- | --- |
| Linux with OpenSSH 8.0 or later and a POSIX `sh` | yes | yes | the `sshd-jupyter` fixture |
| macOS (Remote Login) | yes | yes | not exercised; same POSIX template |
| Windows OpenSSH Server | no | no (`shell_unsupported`: the checks need a POSIX shell) | not supported in v1 |
| Anything without a POSIX shell or without exec permission | no | `remote_exec_denied` | — |

**Software.** Jupyter Server 2.x (CI 2.21.1), ipykernel 6 or 7 (CI 7.4.0), nbformat 5.11.1, Python 3.9 – 3.13 (CI 3.12); the R kernel is a kernelspec like any other, covered in CI by a fake kernelspec listing only (an R fixture image can join the weekly job). Go `go 1.24` with `golang.org/x/crypto v0.48.0` (the newest whose `go.mod` allows 1.24; supplies `ssh`, `ssh/agent`, `ssh/knownhosts`), `golang.org/x/term v0.40.0`, `github.com/coder/websocket v1.8.15`, and the test-only `github.com/santhosh-tekuri/jsonschema/v6 v6.0.3` (read from the Go module proxy on 2026-10-03). The question of plan §8 item 19 is settled: stay on Go 1.24 until the session image ships Go 1.26 or later.

**State directory.** `$XDG_CONFIG_HOME/parallax-connector` (default `~/.config/…`), `~/Library/Application Support/parallax-connector`, `%APPDATA%\parallax-connector`; `PARALLAX_CONNECTOR_HOME` overrides it (CI and tests use a temporary one). Files: `identity.key` (Ed25519, PKCS #8 PEM, mode 0600; on Windows an owner-only DACL set with `golang.org/x/sys/windows`, verified by `doctor`), `config.json`, `known_hosts`, `sessions.json`, `runtime.json`, and `run.lock` (one `run` per state directory, `flock`/`LockFileEx`). Logs go to standard error as JSON lines; keys, passphrases, one-time answers, tokens and file contents are never logged, and `redact()` is applied to all child-process output.

**Distribution.** `.github/workflows/connector-release.yml` (P3-03a) runs on tags `connector-v*`: `CGO_ENABLED=0`, `-trimpath`, version and commit stamped with `-ldflags -X`, five binaries named `parallax-connector_<version>_<os>_<arch>[.exe]` and a `SHA256SUMS` file attached to the GitHub release. Binaries are unsigned; Authenticode and notarisation wait for the owner (plan §7). On macOS a binary downloaded by a browser carries a quarantine flag the person clears with `xattr -d com.apple.quarantine`; one fetched with `curl` does not. There is no automatic update: the server's `minVersion` closes a link from a connector that is too old (4426) and the web app says which version to install.

## 14. Threat model and controls

| Threat | Control | Verified by |
| --- | --- | --- |
| A pairing code is guessed or leaked | 40 bits, 10 minutes, single use, hashed at rest, per-IP failure budget; a paired device is only *pending* until the owner approves it after comparing fingerprints, and approval needs recent authentication | `connectors.itest`: expired, reused and wrong codes are indistinguishable 404s; rate-limit test |
| A signature is replayed or aimed at another server | server nonce (30 s, single use), `ts` window, label, connector id and origin inside the signed bytes | signing vectors; `link-auth.itest` |
| A stolen identity key | revocation closes the link within 60 s at most and refuses new ones; the key authenticates only to the server it was paired with; it is not an SSH key | `link-auth.itest` revoke while linked |
| The relay is compromised or buggy and asks a connector for something dangerous | fixed command templates, `validateTarget`, network scope, Jupyter allowlist, kernel-id confinement and fixed forwarding destination enforced **in the connector**; no message can carry a secret or an arbitrary command. It *can* run code through a kernel (§1): `--confirm-sessions`, the session log line and the lifetime cap limit and expose that | Go tests `TestA33_*`, `TestAllowlist*`, `TestCommandTemplates*`, `TestConfirmSessionsAsksFirst`, `TestKernelIdsConfinedToSession` |
| A user-supplied host reaches the database, cloud metadata or the LAN | rules 1–2 of §4.4, §8 classes, every resolved address checked and the connected address re-checked; destinations after `open_session` are fixed | `TestA33_ForbiddenDestinationsRejected` (40 addresses and encodings), `TestDialRechecksConnectedAddress`, server `netpolicy.test.ts` |
| DNS rebinding between check and use | dial by IP; `Control` hook; one resolution per attempt | `TestDialRechecksConnectedAddress` |
| A changed or spoofed host key is accepted | decision table of §5.2; the server's record and the connector's must agree; replace needs explicit confirmation and recent authentication; the old key stays in the file as a comment | `TestA30_HostKeyDecisionTable`, `TestA30_ChangedKeyIsAHardStop`, e2e A30 |
| The Jupyter token leaks | env or stdin only, held by the connector in memory (Jupyter's own 0600 runtime file sits in a private per-session directory removed at stop), redacted from every output, header auth only (never a query), never on the wire to Parallax or in `sessions.json` | `TestTokenNeverInArgvURLOrLog`, `TestRedactsTokenFromJupyterLog`, `TestSessionsFileNeverHoldsSecrets` |
| Command injection through a path or name | validated absolute paths, `shellQuote`, port and uuid forms, no other variable | `TestShellQuoteFuzz`, `TestCommandTemplates` |
| Another person's session is reached by guessing an id | every route filters by class and owner, 404 for the rest; stream ids are per link and checked against the session | `a33-notebook-isolation.itest`, matrix test |
| Instructors operate a student's machine | no route exists; templates carry no credentials | matrix test; `a35` itest |
| Notebook output from a remote kernel runs script in the app | live output passes the same sanitiser as stored output; HTML renders only in the sandboxed content-origin frame | A09 suite: `a09-live-output.itest.ts` (P3-08a), the component tests in `apps/web/src/notebooks/live/live.test.tsx`, and `e2e/tests/connector/a09-live-output.e2e.ts` (P3-AUD9) |
| A runaway or abandoned session keeps running | leases enforced by the connector from `sessions.json`; orphan sweep; process-death hooks | `TestA32_*`, `TestLeaseSurvivesRestart` |
| A silent re-execution after a network failure | `client_ref` idempotency; the relay never resends; reconnect only queries | `a31-execution-binding.itest`, e2e A31 |
| A dead link read as "done" | `unconfirmed`, never `completed`; causes from §5.5 | `TestA36_*` |
| Cross-site WebSocket hijack of the channel | `Origin` check and cookie session on upgrade | `channel.itest` |
| A tampered connector binary | published checksums; no auto-update; signing deferred (plan §7) | release workflow test |
| Resource exhaustion through the link | frame, stream, window, session and size limits; rate limits | `framing.test.ts`, `TestWindowEnforced` |

What the design does **not** protect against: a compromised relay running code on the computers people connected (§1); code run on the person's own computer or SSH account has that account's privileges (spec §10.6); a person who types their passphrase into a malicious connector binary; a malicious operator of the single relay, who could ask connectors to start Jupyter on the targets people configured (not run arbitrary commands, §1).

## 15. CI fixtures and end-to-end design

**No Docker in cloud sessions.** Everything that can be tested without a container is: Go unit tests use an in-process `x/crypto/ssh` server (host keys, rekeying, `keyboard-interactive`, jump routing, forwarding refusal, `AllowTcpForwarding no`) and an `httptest` fake Jupyter that mimics the allowlisted API and the kernel WebSocket. Server tests use a TypeScript fake connector (a WebSocket client that speaks the protocol) against a real Postgres.

**Fixtures** (P3-11), compose profile `connector`:

- `sshd-jupyter` (`infra/docker/sshd-jupyter.Dockerfile`): `python:3.12-slim` + `openssh-server` + `jupyter-server==2.21.1 ipykernel==7.4.0 nbformat==5.11.1`. Three sshd instances: port 22 (published `127.0.0.1:2222`, forwarding on), 2223 with `AllowTcpForwarding no` (A29), and the third reserved. Users: `student` (Jupyter on `PATH` via `PermitUserEnvironment`), `bare` (same key, no Jupyter, A29), `locked` (a Jupyter configuration that rejects the injected token, A29; P3-11 picks and verifies a configuration, and if none works the Go in-process test keeps that stage covered and the PR records why). Host keys are generated at container start into a named volume so A30 can rotate them (`rm /etc/ssh/ssh_host_*; ssh-keygen -A`, restart sshd).
- `jump` (`infra/docker/jump.Dockerfile`): `openssh-server` only, `AllowTcpForwarding yes`, `PermitOpen sshd-jupyter:22`, published `127.0.0.1:2225`. The onward hop is a name the jump host resolves.
- The client key pair is generated by `scripts/connector-fixture-keys.sh` into `.local/connector-fixtures/` (never committed) and mounted read-only; no key in the repository is ever used anywhere else.
- The connector under test runs **on the CI runner**, not in a container, with `PARALLAX_CONNECTOR_HOME` set to a temporary directory per test and `--allow-net 127.0.0.0/8` (the fixtures are published on loopback). The `local` target uses the runner's Python with `pip install jupyter-server==2.21.1 ipykernel==7.4.0`.
- **Pairing in tests.** There is no bypass flag in product code. Under `TEST_ROUTES=1` (refused in production, ADR-0006) `POST /api/test/connectors/:connectorId/approve` calls the same `approveConnector` service as the button; the A27 UI test clicks the real Approve button. `POST /api/test/connectors/:connectorId/drop-link` closes a live link (A31, A36).

**Job.** `.github/workflows/connector-e2e.yml` (P3-11) with `on: pull_request: paths:` `connector/**`, `apps/server/src/relay/**`, `apps/server/src/http/relay/**`, `apps/web/src/notebooks/**`, `packages/contracts/src/connector*`, `packages/contracts/src/notebookChannel.ts`, `infra/docker/{sshd-jupyter,jump}.Dockerfile`, `infra/connector-fixtures/**`, `e2e/tests/connector/**`, plus `workflow_dispatch` (abbreviated here; the workflow's `paths:` and its header comment are authoritative); `timeout-minutes: 15`; steps: build the connector, `docker compose --profile connector up -d --wait`, `go test -tags fixture ./...` (A28/A29/A30 against real sshd), build web, `pnpm test:e2e` for `e2e/tests/connector/`. The main `ci` workflow still runs on every pull request, so a path filter that does not match leaves the merge rule satisfied. A **weekly** schedule runs `go test ./...` on `macos-latest` and `windows-latest`, the full Playwright matrix of this directory, and the R fixture if present (the Actions budget of ADR-0006 is the reason these are not per-PR).

**Playwright flows** (`e2e/tests/connector/`): `a27-local-connector.e2e.ts` (pair, approve with the button, This computer, run `print(2 + 2)`, see `4` in the full-width notebook, assert every listening socket of the connector process is on loopback), `a28-ssh-connector.e2e.ts` (direct and through `jump`: host, account, workspace and kernel visible, no published Jupyter port), `a29-failing-stages.e2e.ts` (forbidden forwarding, missing Jupyter, token rejected: the failing stage is named, recovery shown, never Ready), `a30-host-key-change.e2e.ts` (trust, rotate the host key, reconnect stops, old record kept), `a31-reconnect.e2e.ts` (a cell sleeping 8 s; browser offline then online; link dropped; the execution count in the kernel and the `cell_executions` count are 1).

## 16. Tests by item

Names are the contract: a PR keeps the names it is given here (Go: `TestA30_…` pattern of ADR-0006; TypeScript titles start with the scenario ID).

- **P3-02** `connectors.itest`: pairing happy path; `A33 a foreign connector id is a 404 for approve, revoke, rename and list`; expired, reused and malformed codes answer one body; rate limits; recent auth required to approve; preview principal 403; revoke while pending; the matrix test covers every new contract. `pairing.test` (HMAC code hash, normalisation `O`→`0`).
- **P3-02a** `link-auth.itest` (valid signature; wrong key, old `ts`, replayed nonce, pending, revoked, wrong mode, unknown id all refused with the right close code); `link-heartbeat.itest` (fake time: acknowledgement, 45 s without a heartbeat closes with 4408); `framing.test` against `vectors/frames.json`; `connector.test` (zod mirror over every fixture; the named invalid and rejected files; `ERROR_CODES` equals `errors.json` keys, read from the file at test time).
- **P3-03** `TestPairWaitsForApproval`, `TestPairRefusesExistingIdentity`, `TestIdentityKeyMode0600`, `TestFingerprintVector`, `TestSigningVectors`, `TestStateDirPerOS`, `TestDoctorReports*`, `TestUnpairKeepsNothing`, `TestA27_PairingHalf`.
- **P3-03a** `TestSchemaFixtures` (valid / invalid / rejected over the embedded schemas), `TestFrameVectors`, `TestLinkAuthHandshake`, `TestReconnectBackoffWithJitter`, `TestRevokedStopsRetrying`, `TestHeartbeatMissCloses`, `TestWindowEnforced`, `TestOriginMismatchStops`; the release workflow is exercised with a dry run in the PR.
- **P3-04** `TestA33_ForbiddenDestinationsRejected`, `TestAddressClassification` (table), `TestDialRechecksConnectedAddress`, `TestAllowlist*` (paths, methods, query keys, encodings, `..`, hidden segments, `token=`), `TestHeadersFiltered`, `TestTokenNeverInArgvURLOrLog`, `TestRedactsTokenFromJupyterLog`, `TestLocalStartAndStatus`, `TestA27_LocalRunsCellThroughProxy` (against the `httptest` fake), `TestTestConnectionLocalStages`, `TestAttachListsLoopbackOnly`.
- **P3-04a** `TestA32_DisconnectKeepsOwnedUntilGrace`, `TestA32_IdleStopsAfterTimeout`, `TestA32_StopConfirmsTermination`, `TestA32_AttachedRuntimeIsNeverStopped`, `TestA32_LinkLossCountsAsDetach`, `TestLeaseSurvivesRestart`, `TestBusyKernelDoesNotExtendDetachedGrace`, `TestOrphanSweepKillsOnlyMarkedProcess`, `TestSessionsJSONAtomicAndPrivate`, `TestSessionsFileNeverHoldsSecrets`, `TestA36_CauseClassification` (one subtest per row of §5.5, fake clock and fake interface snapshots), `TestA36_SleepResumePastDeadlineStops` (expects cause `sleep`), `TestDeadlinePassedWithoutSleepUsesLeaseCause`, `TestRunStopsOwnedSessionsOnSIGTERM`, `TestRevokedLinkStopsOwnedSessions`, `TestStoppedWhileOfflineIsReportedWithItsCause`, `TestFirstHeartbeatListsEverySessionIncludingStopped`.
- **P3-05** `TestA30_HostKeyDecisionTable` (the eight rows), `TestA30_ChangedKeyIsAHardStop`, `TestA30_ReplaceNeedsConfirmationAndKeepsHistory`, `TestHostKeyAlgorithmRestriction`, `TestJumpRouting`, `TestJumpHopKeyChecked`, `TestAuthOrderAgentThenKey`, `TestPassphraseFromTerminalOnly`, `TestMFAKeyboardInteractive`, `TestMFANoTerminal`, `TestUnsupportedMethodsReported`, `TestA29_ForwardingDeniedStage`, `TestStagesBlockedAfterFailure`, `TestA28_StagesOverJump`, `TestHostIdentityReportsPassedHops` (single hop, jump route, and a jump host that passed before the target stopped), `TestTerminalPromptSendsRunningProgress`, `TestStageDeadlinesCoverEveryHop`.
- **P3-05a** `TestRemoteStartTemplate` (golden), `TestShellQuoteFuzz`, `TestCommandTemplates`, `TestRemoteTokenOnStdinOnly`, `TestA29_JupyterMissing`, `TestA29_JupyterTooOld`, `TestA29_NotebookAuthRejected`, `TestNonPosixHostUnsupported`, `TestStopShutdownThenKillWithMarker`, `TestTunnelDestinationFixed`, `TestSSHReconnectKeepsSession` (A31/A36 half), `TestTestedConnectionReusedForConnect`, `TestA28_AttachNeverStops`.
- **P3-06** `a33-notebook-isolation.itest` (`A33 two classmates on one template cannot read each other's sessions, kernels or files`, `A33 a guessed session id is a 404 even for the class instructor`, `A33 a forbidden forwarding destination is refused at save and at connect`), `connections.itest`, `session-state.test` (the table of §10.7, including Forget, refused opens and failed stops), `A36 a session stopped while the link was down gets the connector's cause, not connector_restarted`, `A36 a session is not stopped or cleaned up before the first heartbeat after hello`, `A36 an open_session refused with limit_exceeded fails with that code`, `A36 a failed stop returns to the last state and Forget works from stopping`, `netpolicy.test`, `test-connection.itest` (progress and result with the fake connector; host keys persisted from `data.hops` by the rules of §5.2, including a direct target's first-use key, a jump host confirmed while the target still needs confirmation, and a row-1 hop with no record; a `running` report shown in the poll without extending the 300 s), `a32-close.itest` (`A32 stop of an attached session is refused with not_owned`, `A32 detach keeps the session ready`), migration-chain and `scoped.test` updates.
- **P3-06a** `a31-execution-binding.itest` (`A31 a resent execute with the same ref sends one execute_request`, `A31 reconnect asks the kernel and never executes again`, `A31 output with an unknown parent is dropped`, `A31 output from a restarted kernel generation is dropped`, `A31 lost kernel needs an explicit new session`, `A31 an unrecoverable gap is incomplete`, `A31 a failed write leaves the execution unconfirmed`, `A31 a relay restart makes running executions unconfirmed`), `restart.itest` (generation bump), `buffer.test` (256 KiB, 8 MiB, replay), `channel.itest` (origin, scope re-validation, revocation closes the socket), `kernel-state.test`.
- **P3-07** component tests: panel states per stage and code; `A29 the failing stage is named and the recovery shown`, `A36 a lost session shows its cause, keeps the notebook editable and offers Forget`, `A27 Ready is not shown before the kernel is idle`; every catalogue code has copy; keyboard path, axe.
- **P3-08** component tests for the toolbar and output rendering; e2e A27 and A31 and A36 flows as §15; the A09 suite re-run on live output. (As built: P3-08 showed text, errors and the `text/plain` alternative of a rich output and named HTML, SVG and image outputs as not shown; live HTML became correct only in P3-08a, §10.3.)
- **P3-09** itest/e2e `A34 …` and `A35 …` (`A34 saving to Parallax does not claim the remote file was uploaded`, `A34 a conflicting remote revision is detected and not overwritten`, `A34 submission contains only acknowledged selected files`, `A35 the instructor opens the snapshot without any connector call`).
- **P3-10** `A33 a template carries no credentials and cannot be used in another class`, `template.itest` (instructor writes, student reads, confirmation required, audit).
- **P3-11** the fixtures and flows of §15, `A27`–`A31` e2e, the weekly matrix.

## 17. Decisions and deviations from ADR-0005

1. **Paths under `/api/connector/v1/…`** (the ADR said `/connector/v1/…`): every route then passes the structural scope guard of ADR-0002 and the dev and production proxies need no new prefix.
2. **Link signature** covers a label, the nonce, the connector id, the time **and the server origin** (the ADR listed nonce, id, time).
3. **`pair` waits for approval** by signed polling; the link refuses a `pending` connector as the ADR says.
4. **Message set:** `ping`/`pong` and `ws_event` are gone (WebSocket ping and binary frames); `auth_ok`, `test_progress`, `presence`, `activity`, `ws_opened`, `ws_close`, `window`, `stream_reset` and `error` are new; `http` gains `purpose`; flow control is by credit.
5. **`session_state`:** `running` is dropped (the kernel's state is Jupyter's, not the connector's), `stopping` and `failed` are added, and `cause` has a closed set.
6. **Allowlist:** `/api/sessions` removed (the relay tracks kernels itself); contents calls are a separate `purpose`; the browser never names a path; query parameters are allowlisted and `token` is refused.
7. **Connections are user-owned**, not class-scoped as the ADR put it: a person's saved computer is theirs across classes, which spec §10.3 and §13 describe ("Owner, approved device…"); the session, execution and transfer records stay class-scoped, and a template-derived connection is usable only in its template's class. Spec §10.3 calls the workspace one "for this user and class": a connection holds one workspace, a person who wants another per class keeps a connection per class, and the session records the workspace it used.
8. **The Jupyter token** travels in the environment (`local`) or on the exec channel's standard input (`ssh`), not in an argument as the ADR's example had it, because arguments are visible to other accounts on a shared host.
9. **Test connection is asynchronous** with a result per stage (the ADR had one `test_result`), so a second factor can be waited for and every failing stage reported separately.
10. **`relay` mode serves the full app** and production runs one process (§10.1).
11. **No auto-approve flag** exists in the product (the ADR proposed a test-only flag); tests use a `TEST_ROUTES` route that calls the real approval service (§15).
12. **Managed mode** is specified (§12). P3-05b built the connector side only; reaching it from templates and connections waits for the owner's decision on who operates managed connectors (spec §17).

New plan decisions (recorded in [`plan.md` §8](../delivery/plan.md)): OS and version matrix (§13); MFA and credential policy (§5.3); the Go 1.24 / `x/crypto` v0.48.0 question (§13); one relay process (§10.1).

**Out of scope for v1** (each is a documented limit, not an omission): password and GSSAPI authentication; `ProxyCommand` and SSH through an HTTP proxy; more than one jump host; OS keychain integration; attaching with a token typed by the person; Windows OpenSSH targets; HPC scheduler adapters; several relay processes; automatic connector updates and code signing; a persistent store of kernel output beyond the browser's acknowledged saves.
