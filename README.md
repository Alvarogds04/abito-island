# Abito island — Electron → Rust + Tauri, unit M1b (host/bridge)

Skeleton of the Abito desktop island as a normal Cargo project with Tauri v2
(`tauri-build` in `build.rs`, static `frontendDist`, **no npm, no
node_modules, no cargo-tauri CLI**). Transparent, undecorated, always-on-top
X11 window hosting the frozen R6 clay engine with free drag and edge docking.

Unit **M1b** adds the host/bridge layer on top of the M1a skeleton: the
`window.desktop.*` facade over Tauri invoke/events, the Electron validation
gate ported to Rust with unit tests, lifecycle (single instance, work-area
re-clamp, clean quit), a least-privilege capability and a strict CSP.

## Run

```sh
./run.sh                                # exports GDK_BACKEND=x11, runs `cargo run`
# or directly:
cargo run --manifest-path apps/desktop-tauri/Cargo.toml
# needs a display, e.g.:
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 ./run.sh
```

`main()` also forces `GDK_BACKEND=x11` when the variable is unset (before GTK
initialises), because the launcher alone cannot cover every entry point.

## Read-back probe

```sh
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 timeout 120 cargo run
# (equivalent: cargo run -- --probe)
```

The probe runs the scripted sequence **start → simulated drag near the bottom →
release/snap → expand → collapse → drag to the top → facade evidence →
frontend evidence** and,
after each step, waits for the window manager to apply, then prints one JSON
line per step with:

- `actual`: the real getters — `outer_position`, `inner_size`, `scale_factor`,
  `is_always_on_top`, `is_decorated`, `work_area` (+ `work_area_source`), and
- `requested`: the values Rust asked for, plus `match.position` / `match.size`
  so any discrepancy is visible in the line itself,
- every line carries `"pointer_input": "… the probe drives the same core
  handlers programmatically; no real pointer events are used"` — the probe
  never synthesises input events, it calls `Core::press/drag/release/toggle`,
  the exact handlers the webview's pointer commands call.
- the `frontend_evidence` line reports the SVG element count rendered by
  clay-engine and the canvas count (must be 0 — R6 is SVG-DOM),
- the `facade_evidence` line (M1b) is produced by the webview itself through
  the real `window.desktop` / `desktop_action` path: the 12 preload verbs,
  the snapshot returned by `snapshot`/`expand`/`close`, one typed rejection of
  an invalid call, a 40-call rate-limit burst with its typed rejections,
  `onState` event deliveries, and the `webview_label` / `webview_url` the
  command-side sender gate actually sees.

Exits only this app (`std::process::exit(0)`).

## Read-back findings (observed, not hidden)

The probe prints Tauri's getters (`actual.*`) **and** raw X11 truth
(`actual.x11_window`, `match_x11.*`). On this stack (Ubuntu 26.04, GNOME
Wayland + XWayland, Tauri 2.12.1, GTK 3.24.52, WebKitGTK 2.52.6):

1. **Placement is exact at the X-server level**: every `match_x11.position`
   and `match_x11.size` is `true` — start top-centre `[831,32]`, drag + snap
   bottom `[934,1036]` (chosen X kept), expand bottom-anchored `[750,904]`
   (904+176 = work-area bottom: grows upward), collapse back to `[934,1036]`,
   drag + snap top `[934,32]`. All sizes land exactly 304x44 / 672x176.
2. **Tauri's `outer_position` getter reports a constant Y offset of −37px**
   (X is correct, setters are correct). The drag math therefore reads the
   origin from the X server (`workarea::x11_window_origin`); the getter
   artifact stays visible in `actual.outer_position`, so `match.position`
   remains `false` on purpose — that is the discrepancy, reported not hidden.
3. **`is_always_on_top()` returns `false` while X11 reports
   `_NET_WM_STATE_ABOVE` set** (`net_wm_state_above: true` at every step):
   the window really is above others; the getter does not reflect it.
4. **WebKitGTK inflates the very first map** (304x81 instead of 304x44) and
   a plain `set_size(304,44)` is refused until the widget has been grown
   once. The app pins the contract geometry after page load with a silent
   height-only grow→shrink (the island is top-anchored and the width does not
   change, so nothing moves on screen); the probe waits for that settle
   before the `start` readback. The pin aborts on the first real pointer
   press or toggle.
5. **Monitor geometry is unusable before the window is mapped under
   XWayland** (`work_area_monitor_raw: null`); the clamp uses
   `_NET_WORKAREA = [47,32,1873,1048]` (Ubuntu left dock + top bar),
   intersected with the monitor when the latter is valid.
6. Frontend evidence line: `svg_elements_rendered_by_clay_engine: 18`,
   `canvas_elements: 0`, `clay_revision: "R6"`.

## What M1b proves (and what it does not)

Proven by the probe's `facade_evidence` read-back through the REAL webview
IPC path (observed 2026-10-09, this stack):

- **Facade**: `window.desktop` carries exactly the preload.cjs verb list —
  `snapshot, expand, close, hide, quit, dismiss, allow, deny, choose,
  animateAnyway, respectSystemMotion, onState` (`verbs_match_preload: true`).
- **Snapshot shape**: `snapshot`/`expand`/`close` return the exact 13-key
  Electron snapshot (`revision, state, view, anchor, request, motionOverride,
  branding, connections, unavailable, notices, bridgeStatus, card`), e.g.
  `{"revision":4,"state":"expanded","view":"island","anchor":"top",…}`.
- **Rejected invalid call**: `{"code":"denied","message":"Denied: unknown
  action"}` for an action outside the closed set.
- **Rate limit**: 40 concurrent valid calls → 10 rejected with
  `{"code":"rate-exceeded","message":"Rate exceeded"}` (30 per fixed 1 s
  window; validation runs before the gate, so invalid calls cost no budget).
- **Sender gate**: the command saw `webview_label: "main"` and
  `webview_url: "tauri://localhost"` — the exact allowlist entries in
  `bridge::page_url_allowed` (label/URL checked on every call).
- **Events**: `onState` received `desktop:state` deliveries with monotonic
  revisions (`state_events`, `last_event_revision` in the evidence line).
- **CSP**: all of the above runs under the strict CSP in `tauri.conf.json` —
  evidence arrived, so scripts/events/IPC work without `unsafe-eval` and
  without any inline script or style (index.html contains none; nothing to
  justify).
- **No M1a regression**: every geometry step still reports
  `match_x11.position/size: true` (304x44 / 672x176, snap keeps X, expand
  grows upward at the bottom) and `clay_revision: "R6"`, canvas 0,
  `clay-engine.js` sha256 unchanged.

### Verb mapping (Electron → Tauri)

| preload.cjs verb | Tauri path | status |
|---|---|---|
| `snapshot()` | `desktop_action {action:"snapshot"}` | wired — returns the 13-key snapshot |
| `expand()` | `desktop_action {action:"expand"}` | wired — same funnel as the short click (core toggle → apply_plan) |
| `close()` | `desktop_action {action:"close"}` | wired — collapses from expanded, no-op otherwise (Electron `transition`) |
| `hide()` | `desktop_action {action:"hide"}` | wired — window hide, state `hidden` |
| `quit()` | `desktop_action {action:"quit"}` | wired — clean exit through `RunEvent::Exit` |
| `dismiss()` | `desktop_action {action:"dismiss"}` | **not-yet-wired** — typed `not-yet-wired` error (M2: local UDS notice transport) |
| `allow()` / `deny()` | `desktop_action {action:"allow"\|"deny"}` | **not-yet-wired** — typed error (M3: approval HTTP bridge) |
| `choose(index)` | `desktop_action {action:"choose",index}` | **not-yet-wired** — typed error (M3: standing proposal request; while none stands Electron answers `Denied`) |
| `animateAnyway()` / `respectSystemMotion()` | `desktop_action …` | wired — one machine-wide `motionOverride`, persisted `motion.json` mode 0600, fail-closed read; the island animates only on an explicit `animateAnyway` snapshot |
| `onState(cb)` | `event listen "desktop:state"` | wired — Rust `publish()` with main.cjs dedupe + revision semantics |

### Validation gate (core.cjs67-76 + security.cjs + main.cjs), ported pure

`src/bridge.rs` (no window-system calls; tests written first, RED → GREEN):

- **payload**: size ≤ 512 B first, JSON object, `action` in the closed
  11-entry set, `choose` carries exactly one integer `index`, every other
  verb carries nothing else (a known action cannot smuggle a payload),
- **sender**: exact window label `main` + exact local page URL allowlist
  (`tauri://localhost`, `/`, `/index.html` — no prefix, query or fragment),
- **rate**: 30 calls per fixed 1 s window, rejected attempts keep consuming
  budget, validation runs BEFORE the gate (main.cjs order),
- rejections are typed `{code, message}` objects: `denied` (Electron
  `Denied`), `rate-exceeded` (`Rate exceeded`), `not-yet-wired`.

### Lifecycle, capabilities, CSP

- **Single instance** (`tauri-plugin-single-instance`, crates.io): a second
  launch hands its argv to the first instance, which restores (→ compact,
  clamp), shows and focuses the island; the second process exits before
  `Builder::run`. Observed: second instance exit 0 in 0.06 s, exactly one
  `abito-island` process remained.
- **Work-area re-clamp**: Tauri/Tao expose no display events, so
  `workarea::current` (same source Electron's `display-*` handlers used) is
  polled every second and a CHANGED rect re-clamps the window through the
  pure `geometry::clamp_rect` port of `clampBounds`; a live drag is never
  fought (the release snap owns geometry while pressed). The clamp itself is
  unit-tested; a live panel-move was NOT exercised (it would mean changing
  the user's GNOME setup — not done).
- **Clean quit**: `quit` verb, window close (`CloseRequested` →
  `prevent_close` + `app.exit(0)`), `RunEvent::Exit` releases the
  single-instance D-Bus name; the probe calls `single_instance::destroy`
  before `process::exit` so a later launch is never mistaken for a live one.
  No signal handlers yet (nothing to clean up before M2 adds the socket).
- **Capabilities** (`capabilities/main.json`): `core:default` dropped; the
  webview may only `core:event:allow-listen` / `allow-unlisten`. Host actions
  go through the app's own commands, which Tauri gates by origin (a remote
  origin cannot reach them — enforced by Tauri's ACL, not by us).
- **CSP** (`tauri.conf.json`): `default-src 'self'` plus explicit
  `script-src/style-src/img-src/font-src 'self'`,
  `connect-src 'self' ipc: http://ipc.localhost` (Tauri IPC), `object-src
  'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`. No remote
  origins, no `unsafe-eval`, **no inline script or style at all** (the page
  has none, so no inline exception had to be justified).
- **Navigation**: the `navigation-lock` plugin cancels every top-level
  navigation not on the exact local app page (security.cjs `will-navigate`
  counterpart); no new-window handler is installed, so `window.open` /
  `target=_blank` create nothing.

Not in this unit (later sessions): UDS transport receiver with
`notices`/`connections`/`unavailable:false` (M2), approval HTTP with live
`request`/`card`/`bridgeStatus` (M3), packaging and replacement of the
installed Preview (M4, needs separate human authorisation).

## What M1a proves (and what it does not)

Proven by the probe's read-back, not by intention:

- native geometry per state: compact **304x44**, overview **672x176**
  (visible island 288x32 r14 / 640x160 r22 inside those windows),
- origin at the **top-centre of the work area**, clamp to the work area
  (X11 `_NET_WORKAREA` intersected with the monitor, scale-aware), X kept on
  snap (clamped only),
- **grow direction**: expanding while docked at the bottom keeps the bottom
  edge anchored (grows upward); at the top it grows downward; X centre anchored,
- window attributes: transparent, undecorated, always-on-top, skip-taskbar, no
  shadow, not resizable (the probe prints `is_always_on_top` / `is_decorated`),
- drag release never toggles; a short click (< 6 physical px movement) toggles
  compact↔overview — threshold and snapping live in the pure `geometry` module
  with unit tests (`cargo test`, test-first: RED → GREEN),
- frozen R6 rendered as SVG-DOM in WebKitGTK (`clay-engine.js` sha256
  `e2dc5db38832d7f162b7991e5ea0518f7743d20a48d9a557347c507afe9a2ad8`, unchanged).

Not in this unit (later sessions): `window.desktop.*` bridge (M1b),
capabilities/CSP hardening (M1b), UDS transport (M2), approval HTTP (M3),
packaging/replacement of the installed Preview (M4, needs separate human
authorisation).

## Verifying M1b

```sh
# unit tests (bridge validation, snapshot/transition, geometry, core)
cargo test --manifest-path apps/desktop-tauri/Cargo.toml

# read-back probe: geometry + facade verbs + typed rejections + rate limit
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 timeout 120 cargo run
# → check the `facade_evidence` line: verbs_match_preload true,
#   invalid_call.rejected true with code "denied",
#   rate.rejections == 10 of 40 with code "rate-exceeded"

# single instance
DISPLAY=:0 XAUTHORITY=… GDK_BACKEND=x11 nohup ./target/debug/abito-island &
DISPLAY=:0 XAUTHORITY=… GDK_BACKEND=x11 ./target/debug/abito-island  # exits 0 at once
pgrep -c -x abito-island   # → 1
```

## Behaviour notes

- **Drag**: pointer tracked inside the webview; `drag_press/drag_move/
  drag_release` commands call the Rust core handlers. No global input hooks.
- **Motion**: grow = spring response 0.5 s, damping 0.72; shrink = 340 ms
  `cubic-bezier(.45,0,.2,1)` (the native window resize waits ~400 ms for it);
  `prefers-reduced-motion` snaps both directions. **Silence: no sounds at all.**
- **Click vs drag**: movement `< 6` physical px on release = click (toggle);
  otherwise a drag (snap to the nearest vertical edge, no toggle).

## Wayland limitations (why X11 is forced)

Under Wayland, per official Tao documentation:

- `set_outer_position` / absolute positioning: **not supported**,
- `set_always_on_top`: **not supported**,
- `cursor_position`: returns `0,0`,
- `_NET_WORKAREA` does not exist (no EWMH), so panel-aware clamping is
  impossible — only full monitor geometry would be available.

Without X11/XWayland the island cannot dock to a chosen edge, cannot be kept
above other windows, and cannot be clamped to the usable work area. The
`GDK_BACKEND=x11` launcher and the in-`main()` fallback are therefore load
bearing, not cosmetic.

## Layout

```
apps/desktop-tauri/
├── Cargo.toml            # normal crate; tauri v2 + single-instance plugin + x11rb
├── build.rs              # tauri_build::build()
├── tauri.conf.json       # window contract, static frontendDist, strict CSP (M1b)
├── capabilities/main.json# least privilege: core:event listen/unlisten only (M1b)
├── run.sh                # GDK_BACKEND=x11 + cargo run
├── src/
│   ├── bridge.rs         # PURE: payload/sender/rate gate + typed errors (+tests, RED→GREEN)
│   ├── desktop.rs        # PURE: transition + snapshot shape (+tests)
│   ├── geometry.rs       # PURE: sizes, clamp, snap, grow anchor, click threshold (+tests)
│   ├── core.rs           # press/drag/release/toggle handlers shared by commands + probe (+tests)
│   ├── workarea.rs       # X11 _NET_WORKAREA ∩ monitor, fallbacks
│   ├── probe.rs          # ABITO_PROBE read-back script (geometry + facade evidence)
│   └── main.rs           # wiring, commands, publish, lifecycle, plugins, setup placement
└── frontend/
    ├── index.html        # island markup
    ├── style.css         # reused island tokens
    ├── desktop.js        # window.desktop facade over invoke/events (M1b)
    ├── island.js         # motion, pointer forwarding, facade motion override, evidence
    └── clay-engine.js    # frozen R6, byte-for-byte, DO NOT EDIT
```
