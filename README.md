# Abito island — Electron → Rust + Tauri, unit M1a

Skeleton of the Abito desktop island as a normal Cargo project with Tauri v2
(`tauri-build` in `build.rs`, static `frontendDist`, **no npm, no
node_modules, no cargo-tauri CLI**). Transparent, undecorated, always-on-top
X11 window hosting the frozen R6 clay engine with free drag and edge docking.

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
release/snap → expand → collapse → drag to the top → frontend evidence** and,
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
  clay-engine and the canvas count (must be 0 — R6 is SVG-DOM).

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
├── Cargo.toml            # normal crate; tauri v2 + x11rb + serde_json
├── build.rs              # tauri_build::build()
├── tauri.conf.json       # window contract, static frontendDist, csp null (M1b)
├── capabilities/main.json# minimal core:default for the main window (full owner: M1b)
├── run.sh                # GDK_BACKEND=x11 + cargo run
├── src/
│   ├── geometry.rs       # PURE: sizes, clamp, snap, grow anchor, click threshold (+tests)
│   ├── core.rs           # press/drag/release/toggle handlers shared by commands + probe (+tests)
│   ├── workarea.rs       # X11 _NET_WORKAREA ∩ monitor, fallbacks
│   ├── probe.rs          # ABITO_PROBE read-back script
│   └── main.rs           # wiring, TauriIo adapter, commands, setup placement
└── frontend/
    ├── index.html        # island markup
    ├── style.css         # reused island tokens
    ├── island.js         # motion, pointer forwarding, evidence command
    └── clay-engine.js    # frozen R6, byte-for-byte, DO NOT EDIT
```
