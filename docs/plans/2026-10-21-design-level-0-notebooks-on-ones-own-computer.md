# Design: running a level 0 notebook on one's own computer

**Status:** proposed, 2026-10-21, for the owner to accept or refuse. Nothing in it is built. It answers the owner's request of 2026-10-21 (project thread "Notebook local runtime"): a design run for option C, a local mode of the compute connector that lets a page of a level 0 open site run a notebook's cells on the visitor's own computer, which amends PRODUCT.md N6 and [ADR-0005](../adr/0005-notebook-compute-connector.md) before any code. Option A of the same request, a zip of the notebook with its data files under **Work on your computer**, is built ([open site design](../design/open-site.md) §4) and is what a level 0 site offers until this design is accepted and built.

If the owner refuses it, nothing changes: a level 0 site keeps saved outputs, the zip and Colab, and running cells in the page stays a level 1 feature.

## 1. What changes for a visitor

On a level 0 site, the Notebooks tab offers **Connect this computer** beside the **Saved outputs** label. The visitor:

1. Installs `parallax-connector` (the same release as level 1) and Jupyter Server 2 with a kernel.
2. Runs `parallax-connector open`. The terminal prints a local address and waits.
3. Chooses **Connect this computer** on the site. The terminal asks: `Allow https://course.example.org to run notebooks on this computer? Code 4821-7730. [y/N]`, and the page shows the same code. The visitor answers `y`.
4. The page shows "This computer · Python · Ready" only after the connector has started Jupyter and the kernel has answered, as at level 1.
5. Cells run in the page. **Save to computer** writes the notebook into the workspace folder. Nothing is handed in: there is no class.

Closing the terminal ends every session; the connector never runs in the background in this mode.

## 2. What runs where

```
 browser (site host page)  ──http://127.0.0.1:<P>──▶  parallax-connector open  ──▶  jupyter server (127.0.0.1, token)
 browser (sandboxed frames) ◀──http://localhost:<Q>──  output origin of the connector
```

- **No Parallax server.** The level 0 site stays plain files. The page talks to the connector on loopback only; the connector dials nothing outside the computer.
- **The Jupyter token stays in the connector**, as ADR-0005 requires today. The page never sees it and never talks to Jupyter directly.
- **The same Jupyter allowlist** (`connector/internal/jupyter/allowlist.go`) applies: status, kernelspecs, sessions, kernels and their channels, and contents under the workspace only.
- **Start mode only** at first: the connector starts its own Jupyter server in the workspace, so it owns and stops it. Attaching to a running server is a later question (§7).
- **Workspace.** `~/Parallax/<site host>/<notebook folder>`, created on first connect. The zip's files (the notebook and its data files) are written into it on connect, with the conflict dialog of level 1 when a different file is already there.

## 3. Trust and approval

- **Origin approval.** The connector accepts a request only when its `Origin` is one the visitor approved in the terminal, and only on `127.0.0.1`. Approved origins are kept in the state directory (`open-origins.json`) and listed and revoked with `parallax-connector open --list` and `--revoke <origin>`.
- **A code for each connect.** The page asks for a session with a random nonce; the connector shows a code derived from it and the origin; the visitor confirms in the terminal. The page receives a session key for that tab only and keeps it in memory, never in storage.
- **Who can reach it.** Only pages on an approved origin: the site's own shell and the site owner's pages (site design §3, N3). Untrusted content is on the content origin, which is never approved and is refused by the connector.
- **Browser rules.** Chrome's local network access prompt appears on first connect, and the visitor grants it. Mixed content to `http://127.0.0.1` is allowed by Chrome and Firefox. Safari's behaviour must be checked before the design is accepted (§7).

## 4. Outputs

At level 1, a live rich output is stored by the server and served from the content origin. At level 0 there is no server, so the connector takes that role:

- Text, streams and errors are shown in the page, as text.
- Images, SVG, HTML and Markdown outputs are served by the connector from a second loopback origin (`http://localhost:<Q>`, a different origin from `127.0.0.1:<P>`), framed with every sandbox restriction and a `Content-Security-Policy: sandbox` header, as the content origin does today.
- No rich output is rendered on the app origin, so no sanitiser runs in Go. Markdown outputs, which level 1 renders on the app origin after two sanitisers, are framed instead.
- JavaScript outputs are never served, as at every level.

## 5. Amendments this needs (the owner's decision)

| Document | Today | Proposed |
| --- | --- | --- |
| PRODUCT.md, Levels (N6) | Level 0: "anyone reads slides, readings and rendered notebooks". Level 1 "unlocks … connected notebooks". | Add: "At level 0 a visitor may also run a notebook on their own computer through the connector's open mode; nothing is saved on the site or handed in." |
| ADR-0005 | "The browser speaks only HTTPS/WSS to Parallax." | Amendment: in open mode, the browser speaks to the connector on loopback, from an origin the user approved in the connector's terminal. The token, the allowlist and start-mode ownership are unchanged. |
| ADR-0002, amendment "Open site (level 0)" | The shell fetches its data files and nothing else (A44 checks `onlyDataFiles`). | The shell also talks to the connector on loopback, only after the visitor chooses Connect this computer. |
| Open site design §6 | `NotebooksPanel` has no Connect, live notebook or submission. | It has Connect this computer and a live notebook with no submission. |

## 6. Units, if accepted

| Unit | What | Rough size |
| --- | --- | --- |
| C1 | Connector `open` command: loopback HTTP and WebSocket server, origin approval and codes, start-mode Jupyter in the workspace, the allowlisted relay, the output origin, Go tests with the fake Jupyter | about 1,500 lines with tests |
| C2 | Shell: Connect this computer, a client of the open mode that drives the existing live notebook views, Save to computer, the data files copy | about 1,200 lines with tests |
| C3 | End-to-end: a level 0 build, the connector in open mode and a real Jupyter in CI (`connector-e2e`); A44 updated for the new requests; scenario IDs for the new behaviour | about 500 lines |
| C4 | Guides: student guide "An open site", instructor guide, connector README | small |

## 7. Open questions

1. Does Safari allow a page on `https://` to reach `http://127.0.0.1`? If not: Safari visitors keep the zip, or the connector serves `https` with a certificate it makes and the visitor trusts (more setup).
2. A fixed port (`47821`) or a port the visitor types into the page? A fixed port is simpler; a busy port then needs `--port`.
3. Attach to a running Jupyter server, as level 1 offers? It saves a start but the connector would not own the server.
4. Should the connector also accept a `file://` copy of a site? This design says no: only `https` origins and loopback `http` origins.
5. Should level 1 move to the same in-browser connect for a computer that is the visitor's own, without pairing through the server? Out of scope here.
