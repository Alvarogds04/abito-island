# visual-compare (#467, S10)

Reference-only tool: renders **Coucou** (the MIT reference tree) and **Abito** (this `frontend/`) side by side, state by
state, with the **same fixtures**, at Coucou's window size, and measures how different they are. It is never shipped:
it lives outside `frontend/`, and `packaging/lib.cjs` does not list it. Screenshots stay in `/tmp`, never in the repo.

## Run

```sh
node apps/desktop-tauri/tools/visual-compare/run.mjs            # all states -> /tmp/visual-compare/report/index.html
node .../run.mjs --only approval,settings-pills                 # a subset (note: index.html then lists only those)
node .../run.mjs --eval ~/Apps/abito-next/eval/windows --out /tmp/x --port 9222
```

Needs only Node >= 22 and the shared headless Chromium of the `chrome-devtools` MCP (`127.0.0.1:9222`,
`chrome-devtools-shared.service`). It opens its own pages and closes them; it never launches or stops a browser.
Coucou is served by the Vite of the eval tree (loopback `:14421`); Abito by a tiny static server (`:14422`).
The pixel diff is pure JS (`png.mjs`, zlib only): a pixel differs when a channel moves by more than 24/255.

## Pieces

| File | Role |
| --- | --- |
| `run.mjs` | serves both apps, injects the mock, captures, diffs, writes the report |
| `states.mjs` | the states, and how each side is driven into them |
| `fixtures.json` | the shared data (agents, approval, question, finished notice, Spotify track) |
| `mock-core.js` | fake `__TAURI_INTERNALS__` (invoke, callbacks, events) injected before the page scripts |
| `mock-coucou.js` / `mock-abito.js` | per-app command answers (Coucou: `boot`, hooks; Abito: host snapshots, `question_action`, ...) |
| `coucou-dev/` | harness page copied into `eval/windows/dev/` during the run and removed afterwards |
| `cdp.mjs`, `png.mjs` | minimal CDP client (incl. trusted clicks) and PNG decode/encode/diff |

## Reading the report

* `mismatch` is the share of differing pixels of the whole capture, so an offset (Abito's island sits 8 px lower) also counts.
* A row marked "missing abito/coucou" has no counterpart page on that side (100 %): it is a missing feature, not a styling delta.
* Compact: Abito keeps its 32 px disc by owner decision; the row is an expected difference.
* Coucou has no light theme, so only dark is compared. Abito's theme follows `prefers-color-scheme` (emulated dark).
* Settings mapping is by intent: Chat/Providers and Integrations both map to Abito's *Conexiones* tab, Pills to *Blobs*.
* Coucou's wardrobe/season may dress Mochi (hat, scarf); that is part of the reference, not a bug of the tool.

Coucou code is only executed locally for comparison (MIT, Copyright (c) 2026 Louis Raillé); none of it, nor Mochi,
icons or sounds, is copied here.
