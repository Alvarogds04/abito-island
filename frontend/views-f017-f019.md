# Mount contract — #316 views F017, F018, F019

**Status:** delivered as tested modules only. Nothing here is mounted in the live island; mounting is a coordinator decision and needs the CSS and wiring below, plus approval.

## Modules (all NEW, all pure, no IPC)

| File | Inventory | Exposes | Test |
| --- | --- | --- | --- |
| `frontend/event-views.js` | F017 | `eventCardView`, `eventCardSpec`, `apply`, `sampleEvents` | `test-node/event-views-check.cjs` |
| `frontend/diff-model.js` | F018 | `fileName`, `fromEdit`, `fromNew`, `buildToolDiff`, `isTooLarge`, `diffLinesCount`, `sampleDiff`, `MAX_BYTES`, `MAX_LINES`, `MAX_CELLS`, `CONTEXT` | `test-node/diff-model-check.cjs` |
| `frontend/diff-views.js` | F018 | `diffCardSpec`, `apply` | `test-node/diff-views-check.cjs` |
| `frontend/file-open.js` | F019 | `isWorkspaceRelative`, `createOpenGate`, `DISPLAYED_MAX` | `test-node/file-open-check.cjs` |

The two renderers emit a closed **node-spec tree** (`{tag, class, text, aria, attrs, actionId, children}`); `apply(spec, doc)` walks it with `createElement` + `textContent` ONLY. No `innerHTML` anywhere (asserted by both check files). Each module is a classic script (`window.AbitoEventViews`, `window.AbitoDiffModel`, `window.AbitoDiffViews`, `window.AbitoFileOpen`) and a CommonJS module for the node checks.

## Attribution (MIT, logic only)

The diff engine and card layout are LOGIC ONLY re-expressions of Coucou's MIT code, cited per the docs conventions (`docs/coucou-parity-gaps.md:25`, `docs/design.md:581`):

- `frontend/diff-model.js` ← `windows/src/core/diff.ts:41-321`, `louis-cfm/coucou` commit `71b773f08101237e1ec950efdaee17a626c830e6` (size guards, LCS line diff, hunk context, count fallback).
- `frontend/diff-views.js` ← `windows/src/views/diff.ts:18-60`, same commit (head with back/counts/open, line rows, too-large/no-changes notes).
- `frontend/event-views.js` ← `windows/src/views/views.ts:650-727`, same commit (four distinct event cards).
- No upstream asset, icon, string, artwork or copy is used; names, shapes and UI copy are Abito's own (Spanish, voseo). Guard constants (`MAX_BYTES = 200*1024`, `MAX_LINES = 4000`, `MAX_CELLS = 1_000_000`, `CONTEXT = 3`) are upstream values carried over as logic, pinned by `test-node/diff-model-check.cjs`.

## F017 — event/result cards (`event-views.js`)

`eventCardView({kind, who, title, detail})` → `{kind, tone, icon, word, title, detail, aria, who, actions}`. Closed vocabulary: `error | finished | confused | note`; anything else is `null`.

| Kind | Tone (§1.1) | Icon | Visible word | Actions |
| --- | --- | --- | --- | --- |
| error | `red` | `triangle` | «Error» | `retry` «Reintentar» (primary), `open` «Abrir en el editor» (secondary) |
| finished | `neutral` | — | «Pi terminó» (never a check, never lime — §1.1) | `open` «Abrir» (primary), `dismiss` «Listo» (secondary) |
| confused | `sun` | `clock` | «Un segundo» | none (self-recovering) |
| note | `neutral` | — | «Nota» | none |

`eventCardSpec(view, hooks)` renders one button per action **only when its hook is a function** (`{retry, open, dismiss}`); with no hooks there are no dead buttons. `sampleEvents()` returns one documented fake sample per kind — the host has no producer for these events yet.

## F018 — diff model + diff card (`diff-model.js` / `diff-views.js`)

- `buildToolDiff(tool, input)` builds a diff from a closed tool vocabulary (`Edit`, `MultiEdit`, `Write`); anything else is `null`. `fromEdit`/`fromNew` are the two primitives. Oversized input (byte / line / O(m·n) guards) degrades to an honest count with `tooLarge: true` and NO hunks — the card says «Muy grande para mostrar» and keeps the real counts; it never renders a fake or partial diff.
- `diffCardSpec(diff, {dismiss, open})`: head = back (`aria` «Volver») + file name (last segment only) + `+N` / `−N` (shown only when > 0) + open (`aria` «Abrir en el editor»); body = one `diff-line {kind}` row per line with `diff-sym` (`+` / `−` / space — shape always accompanies colour, C5) and `diff-text`, or the `diff-note` honest states («Sin cambios», «Muy grande para mostrar»).
- `sampleDiff()` is the documented static fixture (a real 2-line edit).

## F019 — open file in editor (`file-open.js`)

**No opening happens in this module and no verb exists yet.** The module is the closed REQUEST side:

- `createOpenGate().display(diff)` remembers (bounded, last 8) the workspace-relative path of a diff the card actually rendered. Absolute paths are never remembered.
- `createOpenGate().request(path, ctx)` returns `{verb: 'open_file', path}` ONLY when: `path` is `isWorkspaceRelative` (no absolute/drive/UNC form, no `..`/`.`/empty segments, no control chars, no untrimmed whitespace, ≤512 chars) AND it is exactly a path the card displayed AND `ctx.event` is trusted, modifier-free, non-IME, non-repeat AND `ctx.typing` is false AND the screen is expanded + overview + no approval card covering it. Anything else is `null`.

**Required before wiring: a Rust verb with its own validation.** The page may not open anything by itself; a Tauri command (e.g. `open_file`) must be written and merged first, and it MUST revalidate independently of this module: accept exactly `{path}`, accept only workspace-relative paths resolved inside the workspace (deny absolute forms, traversal and control characters — re-derive, never trust the renderer), fail closed with a public Spanish reason, and open only through an allowlisted editor mechanism. This module is necessary but not sufficient; the mount is blocked until that verb exists.

## Mount contract (what a mount point still needs)

1. **Script tags** in `index.html` for the four modules (they register globals; no imports).
2. **CSS classes** in `style.css` (theme tokens only, light + dark): `.diff-card`, `.diff-head`, `.diff-back`, `.diff-name`, `.diff-count(-plus/-minus)`, `.diff-open`, `.diff-lines`, `.diff-line.added/.removed/.context` (colour from `--go`/`--red-11`/faint + symbol shape), `.diff-note`, `.event-card.tone-red/.tone-sun/.tone-neutral`, `.event-head`, `.event-ico.ico-triangle/.ico-clock`, `.event-word`, `.event-who`, `.event-title`, `.event-detail`, `.event-actions`, `.event-action.primary/.secondary`. All controls ≥44×44 px, `:focus-visible` ring, no hover-only meaning.
3. **Keyboard**: the spec buttons are real `<button type=button>`; action clicks must pass the same trusted/on-screen gate as `file-open.js`.
4. **Wiring**: F017 cards render from a future host event producer (none exists — use `sampleEvents()` for visual probes); F018 diffs come from tool-call events (#418 producer, when integrated) through `buildToolDiff`; F019's `request()` result goes to the future Rust verb, and only after it exists.
5. **Rejection rule**: rejected input leaves data and counters unchanged — every check asserts `null` returns and no partial state.
