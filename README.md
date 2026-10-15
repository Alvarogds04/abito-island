# Abito island — Electron → Rust + Tauri, units M1b (host/bridge) + M2 (Pi transport) + M3 (approval lane)

Skeleton of the Abito desktop island as a normal Cargo project with Tauri v2
(`tauri-build` in `build.rs`, static `frontendDist`, **no npm, no
node_modules, no cargo-tauri CLI**). Transparent, undecorated, always-on-top
X11 window hosting Abito's own R7 clay character with free drag and edge docking.

## R7 character states (#347)

The seven R6 public names/order and existing looks remain, with eight own clay states appended
(15 total). Real pending approvals/questions outrank active chat, existing errors, a neutral
1800 ms new-turn-finished presentation, and 60 s idle sleep. Sending a decision is never success.
`working/searching/ratelimit` are preview-only until real producers exist. #304's explicit
opt-in system-motion preference remains; honored reduction shows the correct static pose.
See [state/producer contract](../../docs/r6-states-mapping.md) and the coordinator-owned T6
native evidence gate. No Mochi assets/design/sounds, new dependencies or native drag edits.

Focused check: `node test-node/character-states-check.cjs`. Debug-only browser preview:
`tests/character-preview.html` (not shipped); use its manual next-frame control or each static pose.
Node tests are not native clipping, motion/CPU or real producer-roundtrip proof.

Unit **M1b** adds the host/bridge layer on top of the M1a skeleton: the
`window.desktop.*` facade over Tauri invoke/events, the Electron validation
gate ported to Rust with unit tests, lifecycle (single instance, work-area
re-clamp, clean quit), a least-privilege capability and a strict CSP.

Unit **M2** adds the Pi → desktop notice transport: the Unix-domain-socket
receiver ported from `transport.cjs`/`core.cjs` with the SAME wire format and
limits, tested first (RED → GREEN) and integration-tested over real sockets,
the now-wired `dismiss` verb, and display-only Sileo-style notice text in the
island. The Node producer (`pi-extension.ts`/`adapter.cjs`) is unchanged.

Unit **M3** ports the approval lane — Electron's `main.cjs` HTTP authority —
to Rust: the `bridge.json` credential read, the in-memory session cookie, the
5 s-deadline HTTP client with manual redirects and abort-on-quit, the
"only known rejected requests may be retried, never a network failure"
auth ladder, polling (health + proposals), the pinned proposal card, and the
wired `allow`/`deny`/`choose` verbs. The WebView only ever sends the human's
click; Rust re-validates card id, expiry and `payload_hash` before `/execute`.

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
frontend evidence → transport evidence → approval evidence** and,
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
  command-side sender gate actually sees,
- the `transport_evidence` line (M2) is the probe acting as the Pi producer
  against the receiver this process owns: one `hello` frame, the byte-exact
  `ready` line, one `settled` frame, then `notice_count` read back through
  the REAL snapshot path, with `connections_while_connected` →
  `connections_after_disconnect`. `preview_roots_detected_only` lists the
  installed Preview's reserved socket roots READ-ONLY — detected and
  reported, never connected, never unlinked (an `ABITO_SOCKET_DIR` override
  keeps the probe in its own directory).

Exits only this app (`std::process::exit(0)`).

## Read-back findings (observed, not hidden)

The probe prints Tauri's getters (`actual.*`) **and** raw X11 truth
(`actual.x11_window`, `match_x11.*`). On this stack (Ubuntu 26.04, GNOME
Wayland + XWayland, Tauri 2.12.1, GTK 3.24.52, WebKitGTK 2.52.6):

1. **Placement is exact at the X-server level**: every `match_x11.position`
   and `match_x11.size` is `true` — start top-centre `[831,32]`, drag + snap
   bottom `[934,1036]` (chosen X kept), expand bottom-anchored `[750,904]`
   (904+176 = work-area bottom: grows upward), collapse back to `[934,1036]`,
   drag + snap top `[934,32]`. All sizes land exactly 78x78 (the round dot, #302; it was 304x44) / 672x176.
2. **Tauri's `outer_position` getter reports a constant Y offset of −37px**
   (X is correct, setters are correct). The drag math therefore reads the
   origin from the X server (`workarea::x11_window_origin`); the getter
   artifact stays visible in `actual.outer_position`, so `match.position`
   remains `false` on purpose — that is the discrepancy, reported not hidden.
3. **`is_always_on_top()` returns `false` while X11 reports
   `_NET_WM_STATE_ABOVE` set** (`net_wm_state_above: true` at every step):
   the window really is above others; the getter does not reflect it.
4. **WebKitGTK inflates the very first map** (it was 304x81 instead of 304x44
   for the old pill; the compact window is now 78x78) and
   a plain `set_size(78,78)` is refused until the widget has been grown
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
  `match_x11.position/size: true` (78x78 / 672x176; 304x44 before #302, snap keeps X, expand
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
| `dismiss()` | `desktop_action {action:"dismiss"}` | wired (M2) — drops the FIRST notice (id + sessionId, `main.cjs:461` semantics), publishes and returns the fresh snapshot; a dismissal never approves or decides anything |
| `allow()` / `deny()` | `desktop_action {action:"allow"\|"deny"}` | **wired (M3)** — the explicit human choice; the lane re-validates card id/expiry/`payload_hash` host-side, then `POST /api/proposals/{id}/execute` (body `{"payload_hash":…}`) or `/reject`. Returns the fresh snapshot; the outcome lives in the sticky card reason (`Decisión enviada.` / `No se pudo confirmar la decisión.`) |
| `choose(index)` | `desktop_action {action:"choose",index}` | **wired (M3)** — read-and-consume of the standing request in one synchronous step; no producer of requests exists yet (same as legacy), so every choice answers the typed `denied` (`no standing request`) and nothing is consumed |
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
  `Denied`), `rate-exceeded` (`Rate exceeded`). No verb is `not-yet-wired`
  since M3 (that code remains in the error type, unused).

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
  SIGINT/SIGTERM handlers landed with M2: they run the same cleanup (socket
  first, then exit) — see *What M2 proves*.
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

Not in this unit (later sessions): packaging and replacement of the
installed Preview (M4, needs separate human authorisation). The UDS
transport receiver is no longer "later" — it landed in M2, below; the
approval HTTP lane landed in M3, below.

## What M2 proves (and what it does not)

**Same wire, same limits — parity table.** Legacy values come from the
committed read-only Electron source (`worktrees/legacy-electron/apps/desktop`),
Rust values from this crate; every rule is the same rule, not a
re-interpretation (the receiver tests were written first: RED → GREEN):

| contract | legacy value (file:line) | Rust value (file:line) |
|---|---|---|
| frame size cap | `frameBytes: 512` — `core.cjs:3` | `FRAME_BYTES = 512` — `src/protocol.rs:32` |
| freshness window (no future, no stale) | `freshMs: 15000` — `core.cjs:3` | `FRESH_MS = 15_000` — `src/protocol.rs:33` |
| notice expiry | `expiryMs: 60000` — `core.cjs:3` | `EXPIRY_MS = 60_000` — `src/protocol.rs:34` |
| notice queue bound | `queue: 8` — `core.cjs:3` | `QUEUE = 8` — `src/protocol.rs:35` |
| dedupe entries | `dedupe: 256` — `core.cjs:3` | `DEDUPE = 256` — `src/protocol.rs:36` |
| connection quota | `connections: 4` — `core.cjs:3` | `CONNECTIONS = 4` — `src/protocol.rs:37` |
| frame rate per connection | `framesPerMinute: 120` — `core.cjs:3` | `FRAMES_PER_MINUTE = 120` — `src/protocol.rs:38` |
| handshake deadline | `handshakeMs: 3000` — `core.cjs:3` | `HANDSHAKE_MS = 3_000` — `src/protocol.rs:39` |
| idle deadline (valid frames only) | `idleMs: 30000` — `core.cjs:3` | `IDLE_MS = 30_000` — `src/protocol.rs:40` |
| batch cap | `frameBytes * 8` — `transport.cjs:66` | `BATCH_FACTOR = 8` — `src/protocol.rs:43` |
| ready answer (byte-exact) | `'{"v":1,"type":"ready"}\n'` — `transport.cjs:81` | `READY_LINE` — `src/protocol.rs:48` |
| project id = sha256(realpath) | `core.cjs:5` | `project_id` — `src/protocol.rs:54` |
| session label / event id patterns | `core.cjs:6-7` | `session_token`/`token` — `src/protocol.rs:67,82` |
| frame decode + scope/identity checks | `decode` — `core.cjs:10-33` | `decode`/`validate` — `src/protocol.rs:156,212` |
| notice store (prune/dedupe/queue/dismiss) | `NoticeStore` — `core.cjs:35-60` | `src/protocol.rs:417` (`accept:441`, `snapshot:481`, `dismiss:488`) |
| line framing: split, tail gate | `transport.cjs:69,86` | `Framer::push` — `src/protocol.rs:323` |
| per-connection fixed-minute quota | `transport.cjs:73-75` | `FrameQuota::check` — `src/protocol.rs:379` |
| endpoint naming `<runtime>/p-XXXXXX/s` | `transport.cjs:49,114-115` | `mkdtemp` — `src/transport.rs:557` |
| dir chain: dir, no symlink, root/us, not world-writable | `directoryChain` — `transport.cjs:11-20` | `directory_chain` — `src/transport.rs:239` |
| private dir = exactly 0700 + ours | `transport.cjs:22-26` | `private_directory` — `src/transport.rs:266` |
| endpoint verify (shape/0600/uid/socket/no symlink) | `verifyEndpoint` — `transport.cjs:34-44` | `verify_endpoint` — `src/transport.rs:290` |
| socket chmod 0600 after bind | `transport.cjs:117` | `create_transport` — `src/transport.rs:664` |
| sockaddr_un ≤ 107 bytes | `transport.cjs:112` | `src/transport.rs:640` |
| handshake/idle timers, rate check before decode | `transport.cjs:60-61,74-75` | `handle_connection` — `src/transport.rs:801` |
| connections = handshaked clients only | `transport.cjs:57,82` | `Inner::report` — `src/transport.rs:426` |
| cleanup: dir+socket inode identity, foreign paths untouched | `transport.cjs:91-106` | `cleanup` — `src/transport.rs:508` |
| owner check | file uid + 0600 only — `transport.cjs:34-44` | `SO_PEERCRED` same-uid — `src/transport.rs:588` |
| `onNotice` gated by a store before the app | `transport.cjs:83` | `Inner.store` — `src/transport.rs:801` handler |
| `dismiss` drops the first notice | `main.cjs:461-463` | `main.rs:752` |
| transport wiring + callbacks + publish | `main.cjs:488-491` | `start_transport` — `main.rs:138` |
| `ABITO_DESKTOP_SOCKET=…` stdout line | `main.cjs:493` | `main.rs:182` |
| `unavailable = true` only when the receiver fails to start | `main.cjs:495-497` | `start_transport` — `main.rs:138` |
| cleanup refusal line on quit | `main.cjs:383-384` | `main.rs:108,119` |
| SIGINT/SIGTERM run the clean quit | `main.cjs:393` | `install_shutdown_handlers` — `main.rs:71` |

Deliberate, documented deltas (no wire change):

- **Owner check on the wire**: the legacy receiver trusted the 0600 socket
  file; the Rust receiver additionally requires the connecting peer's uid to
  be ours via `SO_PEERCRED` (otherwise the connection is dropped before it is
  counted). Strictly tighter admission, same protocol.
- **`Linux identity required`** (legacy fails closed when `process.getuid`
  is absent) has no Rust counterpart: `libc::getuid` always answers on
  Linux, so the branch cannot exist — documented, not silently dropped.
- **Reserved Preview roots**: `packaged.cjs` maps `com.abitog.Abito` →
  `/run/user/<uid>/abito-desktop`. This receiver REFUSES any runtime root
  that is or contains that directory or `…-preview`
  (`runtime_allowed`, `src/transport.rs:186`): it never binds, unlinks or
  connects there. Detection is read-only (`read_dir` + `lstat`, never a
  connect) and the probe only reports what those roots hold.

### Socket path contract (M2)

- Default runtime root: `apps/desktop-tauri/.runtime` — the dev layout
  `apps/desktop/.runtime` had — created 0700; endpoint
  `<root>/p-XXXXXX/s` (`XXXXXX` = six alphanumerics per launch), generated
  dir 0700, socket 0600. Startup prints `ABITO_DESKTOP_SOCKET=<endpoint>`
  (`main.rs:182`), byte-for-byte the legacy line.
- Override: `ABITO_SOCKET_DIR=<absolute, normalized dir>` for tests/probe.
  Relative or unnormalized paths fail closed; anything resolving into the
  installed Preview's reserved roots is refused (`resolve_runtime_from`,
  `src/transport.rs:199`). **A socket this process did not create is never
  removed**: cleanup verifies dir + socket dev/ino and `is_socket` first,
  and a non-empty directory aborts it (legacy `close()` semantics).
  Stale `p-XXXXXX` leftovers from earlier runs are never swept — exactly
  like the legacy receiver.
- Cleanup runs on: `quit` verb, window close, SIGINT, SIGTERM, and before
  the probe's hard exit.

### Notices are display text only (M2)

Transport callback → `notices.accept` → snapshot fields `notices`,
`connections`, `unavailable` (fed independently of `bridgeStatus`, which
stays M3's `disabled` — legacy keeps health-failure and Pi-connection state
separate too). The island renders them in the overview as Sileo-style text
(own code, total silence): generic title `Pi terminó su turno`, the generic
detail (never "the task went well", never "tests passed"), the count line,
and a `Descartar aviso` button wired to `dismiss`. **A notice never decides,
approves, focuses, expands or restores anything**; a snapshot never opens the
island by itself. Since M3, `allow`/`deny`/`choose` are wired through the
approval lane — a notice still never decides anything.

### Unchanged Node producer against the Rust receiver (observed)

Integration test `unchanged_node_producer_connects_and_settles` spawns the
committed `adapter.cjs` + `core.cjs` + `transport.cjs` (read-only, plain
`node`, no npm install, no network, no writes) through
`test-node/producer-check.cjs` against a receiver bound in a private temp
dir: a real `hello → ready → settled` handshake, the adapter's `projectId`
sha256 equals the receiver's, the connection is counted, and the settlement
becomes exactly one notice. `pi-extension.ts` and `adapter.cjs` are
unmodified. (The adapter's own opt-in loader would only accept the legacy
`.runtime` or the Preview's root; the harness passes the runtime explicitly,
which is what a Pi session wiring would do through `ABITO_DESKTOP_SOCKET`.)

## What M3 proves (and what it does not)

The approval lane is a behaviour-equivalent port of the Electron host's HTTP
authority. Legacy values come from the committed read-only Electron source
(`worktrees/legacy-electron/apps/desktop`) and the read-only backend contract
(`src/sb_bridge/api.py`, `webapp.py`); Rust values from this crate. The pure
modules were written test-first (RED → GREEN) and the lane is
integration-tested against an **in-process fake backend** (`fakebridge.rs`,
`127.0.0.1:0`, std-only) — no real backend and no provider is ever contacted
by the tests or the probe.

### Parity table (M3)

| contract | legacy value (file:line) | Rust value (file) |
|---|---|---|
| bridge origin | `http://127.0.0.1:11003` — `security.cjs:13` | `requests.rs` `BRIDGE_ORIGIN` (env override below) |
| route allowlist (`GET /`, `/api/health`, `/api/proposals(?status=pending)`, `POST …/proposal_[0-9a-f]{32}/execute\|reject`) | `bridgeAllows` — `security.cjs:14-23` | `requests.rs bridge_allows` |
| credential file `<stateRoot>/bridge.json`, descriptor-safe (O_NOFOLLOW, our uid, not group/world-writable, 1..=2048 B, dev/ino/size/mode/mtime/ctime re-read) | `readBridgeLogin` — `main.cjs:87-108` | `approval.rs read_bridge_login` |
| login schema `{v:1, login}` + `^[a-z0-9][a-z0-9@._+\-]*$`, no whitespace/controls | `main.cjs:100-106` | `requests.rs validate_login_bytes` |
| auth modes `jar`/`explicit`/`none`, printed as the bare mode name | `mode()` — `main.cjs:110` | `retry.rs AuthLadder::set_mode` + the `log` hook |
| `bridgeStatus` transitions (`starting`/`healthy`/`unhealthy`/`stopped`/`disabled`) + `REASON` texts | `main.cjs:77-84,115` | `card.rs Reason`, `approval.rs set_status`/`stop_auth` |
| session cookie: value charset `\x21\x23-\x2b…` ≤4096, `Path=/`, domain `127.0.0.1`, expiry, **memory only** | `sessionCookie` — `main.cjs:125-136` | `approval.rs cookie_value_valid`/`parse_set_cookie` |
| one request: exact headers (`tailscale-user-login`, `X-SB-Request: 1` on POST, `Content-Type` only with a body, `Cookie` only as jar/explicit dictate), `redirect: manual`, 5 s absolute deadline covering the body, 401/3xx → stop auth, body discard, 1 MiB strict-UTF-8+strict-JSON cap | `request` — `main.cjs:138-192` | `approval.rs request` + `http.rs send` (`REQUEST_DEADLINE_MS=5000`, `MAX_BODY_BYTES=1 MiB`) |
| abort-on-quit of every active request | `activeRequests`/`quit` — `main.cjs:56,380` | `http.rs ActiveRequests::abort_all`, `approval.rs abort_lane` (wired into `quit_clean` + SIGINT/SIGTERM) |
| `mint`: ≤2 per process, `GET /`, jar must hold a valid cookie after, every failure stops auth | `mint` — `main.cjs:194-202` | `approval.rs mint` + `retry.rs try_mint` (`MAX_MINTS=2`) |
| the ladder: "only known rejected requests may be retried, never a network failure" — 403→explicit→remint→stop; a transport failure never touches the ladder | `authenticated` — `main.cjs:204-218` | `approval.rs authenticated` + `retry.rs classify`/`recovery_after_403` |
| proposals list: ≤100 entries, `pending` only, id `proposal_[a-f0-9]{32}`, hash 64 lowercase hex, operation ≤120 UTF-16 units/no controls, exact ISO-8601 expiry (leap-aware), duplicate ids fail closed, oldest-expiry sort with id tiebreak | `parseProposals`/`validExpiry` — `main.cjs:221-248` | `card.rs parse_proposals`/`valid_expiry` |
| pinned card semantics (open overlay pins, close/re-expand swaps, same-id refresh, changed hash → inert, expiry sticky on every projection, empty overlay never acquires) | `receiveCandidate` — `main.cjs:250-262` | `card.rs receive_candidate` |
| `cardReason` order: quitting → sticky → expiry → health → busy → compact → invisible | `main.cjs:265-274` | `card.rs card_reason` |
| card projection keys `{operation, expires_at, state, reason}`; `request` always the standing-request value (null today) | `projectedCard`/`snapshot` — `main.cjs:276-280,330` | `card.rs project_card`, `approval.rs snapshot_fields` |
| poll: health (`ok===true`) → proposals → receive; 10 s cadence; one in-flight; failure → unhealthy unless stopped | `poll`/`startBridge` — `main.cjs:282-303` | `approval.rs poll_once`/`run_bridge` (`POLL_MS=10000`) |
| `decide`: synchronous lock first, gate re-validated before EVERY send, `/execute` body exactly `{"payload_hash":…}`, `/reject` bodyless, 2xx→`Decisión enviada.` else `No se pudo confirmar la decisión.`, quit → nothing is claimed | `decide` — `main.cjs:305-328` | `approval.rs decide` |
| overlay epoch bumps on every phase transition; expand promotes the pinned queue | `main.cjs:375,466-467` | `approval.rs bump_epoch`/`promote_selection`, called from `main.rs` `restore`/`dispatch_verb` |
| `choose`: read-and-consume in ONE synchronous step; no request stands → `Denied` | `main.cjs:444-449`, `core.cjs:89` | `approval.rs choose` + `card.rs choose_request` |
| the three verbs run behind the same validation+rate gate | `main.cjs:452-456` | `main.rs desktop_action` (async since M3; allow/deny run on the blocking pool) |

### What the approval evidence shows (probe, `approval_evidence` line)

- The lane starts against the **in-process fake backend** through the
  `ABITO_BRIDGE_BASE` override (set before the lane is built): the probe
  never talks to a real backend, and when `ABITO_BRIDGE_BASE` was set from
  OUTSIDE, the probe reads snapshots but refuses to decide.
- `posts_before_choice: 0` — nothing (notice, snapshot, poll) ever writes;
  only the explicit `allow` dispatch reaches `/execute`, and then
  `execute_payload_hash_matches_card: true` with `session_cookie: true` and
  `x_sb_request: true` on the POST. `bridge_status_before/after` and
  `card_before/after` are read through the REAL snapshot path
  (`pending` + `healthy` → `inert` + `Decisión enviada.`).
- `facade_evidence.choose_wired_denied: true` — through the real webview
  IPC, `choose(0)` answers the typed `denied`, not `not-yet-wired`.

### Secrets and storage contract

- The session cookie exists **only in the Rust process memory** of the lane
  (`Approval.cookie`): never localStorage, never any value the WebView can
  read, never written to a file, never logged — the only auth diagnostic is
  the bare mode name (`jar`/`explicit`/`none`), exactly like legacy.
- The credential is the `bridge.json` **login** (a Tailscale identity), read
  from the state root with the legacy descriptor discipline. It is never
  printed and never committed (`.runtime*/` is gitignored).

## What U1 proves — chat inside the island, answered by the LOCAL model

**Same island, a vertical column (#309).** A short click on the compact island still
opens the approved **640×160 overview** (M1 contract, untouched). Its most
prominent control, **Conversar** (≥44 px, also `Enter` in the overview),
switches the SAME window to the **chat column: visible 400 wide, native 432
wide, r22**, gentle-shell style (history, composer, a strip for the agent
state). Its height follows the work area: `geometry::chat_visible` gives
**640 when the screen allows it, otherwise work-area height − 40 px of air,
never below 240**; native adds the overview's 32×16 margins (432×656 on a
1048 px work area). Rust owns every number and pushes the visible size to the
page (`__islandSetView`); the frontend never decides the height. The column is
centred under the overview it replaces and keeps the docked edge (grows
upward from the bottom). Overview (672×176) and column move in opposite
directions per axis, so the window first becomes a **stage** that holds both
(`geometry::stage_size`, per-axis maximum, 672×656), the page animates inside
it with the R6 contract, and the window settles on the final rectangle
afterwards (700 ms opening, 400 ms closing, generation-guarded like every
deferred resize). `Volver` returns to the
overview (the draft stays in page memory, never on disk); `Escape` leaves
the composer, a second `Escape` collapses the island; a collapse always
forgets the chat view so the next click opens the overview again.

**Local model only — never a silent fallback.** The chat lane
(`chatlane.rs`) talks to the selected local target, today
`http://127.0.0.1:11002` alias `Abito-gpt`, through `localmodel.rs`:

- `LocalEndpoint` accepts only literal loopback (`127.0.0.1` / `[::1]`), plain
  HTTP, origin only — `localhost`, LAN, tailnet, TLS and cloud hosts are
  refused by construction (no DNS lookup can redirect the request),
- per turn: a metadata preflight (`/health`, `/props`, `/slots`,
  `/v1/models` — no inference), then **exactly one** streamed
  `POST /v1/chat/completions` naming only the alias; no tools, no key, no
  retry, redirects never followed,
- router down → `local_model_unavailable`: *“El modelo local no responde: el
  chat no está disponible. No se usó ningún otro modelo.”* Opening the chat
  runs the same metadata check, so the chat says it before anyone types and
  `Enviar` stays disabled,
- model asleep (`/props is_sleeping`) → `resource_authorization_required`:
  sending would make the router load ~18 GB, so nothing is sent and nothing is
  loaded; another alias loaded → unavailable, never substituted; slot busy →
  visible “espera en su cola”, one request,
- history trimmed against the model's REAL context (`/slots n_ctx`) and shown
  (“se dejaron afuera N mensajes”), never a bigger context; the 32,000-scalar
  response cap ends with an explicit limit note; cancel is terminal and
  shuts the socket down.

**Contract (`chat.rs`, pure, RED → GREEN):** the `abito.chat.v1` subset a
local model can honestly produce — native ids, duplicate client id → same
turn, one running turn (`queue_full`), monotonic `seq` (gap/regression/
after-terminal rejected), states `queued|thinking|streaming|waiting_approval|
completed|cancelled|error`, safe typed errors, draft ≤8,000 scalars, cache
≤100 turns / 256 KiB. `waiting_approval` exists in the machine but nothing
can enter it: **there is no Pi chat producer on the desktop yet**; the view
says so (`producer.pi: "not_connected"`). That adapter is a marked future
dependency, not simulated.

**IPC:** one new command, `chat_action`, behind the same sender gate as
`desktop_action`, its own 30/s rate budget, a 33 KiB payload cap and the
closed set `view|open|back|check|submit|cancel` with exact keys — a page
cannot name an endpoint, model, key or approval (the probe proves a
smuggled `model` field is rejected). Events: `chat:state`. The
`desktop:state` 13-key snapshot is unchanged; no new capability or CSP
origin was added (the WebView never talks HTTP; Rust does).

**Accessibility/motion/silence:** named controls ≥44 px (probe-measured),
text status independent of R6, polite live region once per state change or
finished answer (never per token), plain text via `textContent`, the
composer's Enter guard consumes only the identity signals an IME exposes
(`isComposing` and the legacy 229 sentinel) and its known gap is written out
in «Verifying U1» below, focus moves to the composer only on a deliberate
keyboard open or a click; overview↔chat uses the contract spring/340 ms curve and snaps under
`prefers-reduced-motion`; no audio elements, no sound. Drag never attaches
to the transcript or composer. R6 is only scaled/positioned (sha256
unchanged).

**The empty-chat greeting (F027 / TaskView342).** With no message yet the column shows
what §2.3 shipped: the lock `local` + eye-off pair, centred, and the whole sentence in
`aria` (*«Escribile a Abito. Responde el modelo local de esta máquina; no ve tu pantalla
ni ejecuta nada.»*). An **explicit** display name in the `chat:state` payload
(`display_name`, a string) adds one visible line under the pair — **«Hola, <nombre>.»** —
and prefixes the same sentence in `aria`. The name is never guessed: no OS user, no
account, no provider, no branding, no profile lookup. It is text the person typed, so it
is cleaned and bounded in `chat-view.js` (`emptyGreeting` / `cleanDisplayName`): a
non-string or a blank/control-characters-only value reads as **no name**, control
characters become spaces, and the value is cut to **80 Unicode scalars** (never splitting
a surrogate pair) — the same bound as the local preference validator. Absent or blank keeps
the shipped state **byte for byte** (icons only, sentence in `aria`), and the row is
redrawn when a name arrives on a later push instead of staying stale. The greeting is
written with `textContent`; the greeting renderer has no HTML write. Existing
closed-registry icon writes elsewhere are unchanged.

**Explicit local preference (v1, no onboarding/profile inference).** `prefs_action`
accepts exactly `{"action":"set_display_name","display_name":"Ana"}`. The string must
contain at most 80 Unicode scalars and no control characters; leading/trailing
whitespace is trimmed, and an empty/whitespace-only string clears it. Extra keys,
non-strings, controls and overlength values return `invalid_schema`. The persisted
`prefs.json` stays **v1** with optional `display_name`, omitted when anonymous.
Missing/invalid name on load defaults to anonymous without losing `sound`.
Sound toggles clone current preferences and change only sound; setting/clearing the
name changes only the name. No-op/view commands do not write. A failed save returns
`save_failed` without installing or publishing the requested value. Settings responses
and `prefs:state` carry `displayName` (string or null); `chathost.rs::chat_view` supplies
`display_name` to chat, including startup reads and pushes after successful changes.
`prefs::transact` holds a shared command gate through persistence, installation and
publication: the next preference command cannot overtake the current event. The
state mutex is released before publication, so chat can re-read the committed name.
Publish callbacks must not recursively call `transact`. The response/event uses the
committed snapshot rather than an unlocked later read. This orders preference-command
publications, not every unrelated chat producer in the application.

Reproduce concurrent **real fields** (`sound` and `display_name`) and failed-save
checks without a display or provider call:

```sh
CARGO_TARGET_DIR="$PWD/evidence/integration-327-342-384/cargo-target" \
  cargo test --offline --locked --manifest-path apps/desktop-tauri/Cargo.toml \
  --lib prefs::tests::concurrent
```

These tests use the public transaction seam used by `settingshost`, concurrent
threads released by a barrier, serialized JSON readback and publication callbacks.
They assert the gate remains held until publication, the state mutex is released,
event order equals commit order, both fields survive, and failed persistence neither
replaces the prior name nor emits an event. Persistence failure is injected at the
callback boundary; this is not an OS write-failure or live Tauri event-delivery test.

**Optional name in Ajustes:** under Saludo, **Tu nombre (opcional)** explains the
80-character limit and anonymous fallback. **Guardar nombre** (or Enter) sends the
explicit preference command. Clear the input and save to return to anonymous. The
form validates scalar count and controls, preserves drafts across preference pushes,
and retains the text, focus and an actionable error after a failed save. It announces
success only after IPC resolves; the backend remains validation authority.

### Verifying U1

```sh
cargo test --manifest-path apps/desktop-tauri/Cargo.toml
#   lib 147 (+chat 30, localmodel 13, chatlane 9, geometry 3, core 4)
#   chat_local_model 14 (in-process fake router; 1 opt-in real smoke)
#   frontend_chat_view 1 (runs test-node/chat-view-check.cjs, 8 checks)
#   frontend_chat_composer 1 (runs tests/composer-ime-check.cjs, 10 checks + limits probe)
node apps/desktop-tauri/test-node/chat-view-check.cjs

# composer keyboard contract (#372): drives the REAL frontend/chat.js over a fake DOM
# with plain node (no browser, no npm, no network). Proves Enter sends (one submit with
# the draft, cleared), Shift+Enter keeps the textarea's own newline and sends nothing,
# `isComposing` sends nothing, the legacy 229 sentinel sends nothing, and an intentional
# Enter shortly after a composition still sends. It then PRINTS a limits probe: where the
# engine delivers the candidate-confirming keydown AFTER `compositionend` with a plain
# `keyCode` 13 (WebKit bug 165004, older reports), that keydown carries no signal that
# tells it apart from an intentional Enter, so it sends — this is a known gap, not an
# IME-safety guarantee. A time window is deliberately NOT used for it: it swallows real
# Enters (TaskView #372, parent decision 2026-10-13). Real WebKitGTK/IME ordering is NOT
# exercised here: no IME, no engine drive, no browser.
node apps/desktop-tauri/tests/composer-ime-check.cjs

# opt-in: one short real turn against 127.0.0.1:11002 (local, free)
ABITO_REAL_LOCAL_MODEL=1 cargo test --manifest-path apps/desktop-tauri/Cargo.toml \
  --test chat_local_model real_local -- --nocapture

# probe: adds chat_open (672x256 from the X server), chat_evidence (one turn
# via the REAL chat_action IPC against an in-process FAKE router, then an
# unreachable target), chat_back_to_overview (672x176), chat_collapse
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_SOCKET_DIR="$PWD/.runtime-probe" \
  timeout 200 cargo run
```

## What U2 proves — choosing a self-hosted model (local only, no keys)

The chat header's **Modelo** button opens an internal panel of the SAME chat
view (the transcript is replaced while it is open). It lists the verified
local inventory (`models::REGISTRY`, a reviewed code constant):

| entry | state | selectable |
|---|---|---|
| `http://127.0.0.1:11002` · `Abito-gpt` | live metadata + gate | yes (the only one) |
| `127.0.0.1:11014` | `unknown` — 404 at root, identity unverified (inventory 2026-10-08) | no, never contacted |
| `127.0.0.1:11017` | `unavailable` — did not answer (inventory) | no, never contacted |
| any other alias the router lists | shown “no verificado” | no |

Visible metadata per row: endpoint, alias, context (`/slots n_ctx`), output
cap (1,024), size in memory, parameters, quantization, vision yes/no — read
by four bounded GETs (`/health`, `/v1/models`, `/props`, `/slots`) on
**Actualizar** or on opening the panel; never an inference to fill a picker.
The UI says plainly: *“Hoy hay un solo modelo local verificado: una sola
opción no es una elección.”* and *“Sin nube y sin claves.”*

**Resource gate, not cost:** `models::gate` separates `ready` (loaded,
awake, idle), `queue` (slot busy — a send waits, shown), `needs_load`
(asleep, or listed but not the loaded alias — shows the size to load and the
available RAM; **Abito never loads, downloads or evicts**), `unknown`
(state unreadable — nothing is sent) and `unavailable` (router down / alias
gone — never substituted). The resource line shows RAM
(`/proc/meminfo`) and GPU VRAM/GTT (amdgpu sysfs counters), read-only, no
privileges. Before every dispatch `main.rs model_gate` requires the frozen
target to still be a registered selectable profile at the same revision,
origin and alias; the per-turn preflight then applies the resource half.

**Selection:** IPC `models_action` with the closed set
`list|refresh|select{profile_id}` (same sender gate + rate limit). There is
no add-endpoint, no key entry and no origin field (the probe proves
`set_key`/smuggled `origin` → `invalid_input`, a diagnostic or unknown id →
`profile_missing`). A selection applies from the next message; a running
turn keeps its frozen target. It is persisted as
`<app config dir>/models-selection.json` = `{"v":1,"selected":"…"}` (dir
0700, file 0600, atomic temp+rename, read with `O_NOFOLLOW` + owner/mode
checks). Absent → the approved initial `local-abito-gpt`; corrupt, foreign
or unknown → **no model selected** (the chat says so, nothing substituted).
The probe never writes it (`persisted_config_dir: null`); tests use a temp
dir; `ABITO_MODELS_CONFIG_DIR=<abs dir>` overrides.

### Verifying U2

```sh
cargo test --manifest-path apps/desktop-tauri/Cargo.toml
#   lib models 19 (registry, parsing, gate, listing, IPC, saved file)
#   models_selection 5 (fake routers: metadata only, diagnostics never
#   contacted, sleeping = needs_load with 0 completions, 0600/0700, symlink
#   and world-writable dir refused)
# probe: models_evidence — rows rendered with 44 px buttons, gates
#   ready/unknown/unavailable, select diag/unknown refused, set_key and
#   smuggled origin refused, selection effective, fake router saw only GETs
```

## #327 — manual specialists (roles the human creates and chooses)

A specialist is a role the human creates by hand and picks explicitly: a
display name, the instructions that specialise it and, optionally, one of the
verified LOCAL models. It never delegates, spawns, schedules, widens a
permission or reaches another backend: choosing a role only changes what the
NEXT turn asks for and which local model answers it.

**Store:** `<app config dir>/specialists.json` = `
{"v":1,"active":<id|null>,"specialists":[{"id","name","instructions","model"}]}`
(dir 0700, file 0600, atomic temp+rename, read with `O_NOFOLLOW` + owner/mode
tests). Only a genuinely absent file loads as a healthy empty store. Existing
corrupt, unreadable, wrongly versioned, oversized or invalid-record data returns
an explicit load failure. No partial list is advertised as successfully loaded.
The host latches `load_error: true`, sets `persisted: false` and rejects **all**
mutations with code `load_error` and message
`No se pudieron cargar los especialistas; no se cambió nada.`
`view` still returns state with that flag, without paths or stored content.
No success event, auto-reset, repair, quarantine or overwrite occurs; recovery
is outside this feature and requires an explicit decision. Moving a bad file
after startup does not clear the latch. `active: null` IS the principal (Abito).
`ABITO_SPECIALISTS_CONFIG_DIR=<abs dir>` overrides; without that override,
the probe keeps it in memory only. Unix permissions/owner checks are not a
verified Windows security guarantee.

**Identity:** the id is opaque, lowercase ASCII,
`^[a-z0-9][a-z0-9._-]{0,31}$`, generated ONCE at creation and stable across
renames — never derived from the name, the provider or a CLI id. The reserved
identities (`abito` the principal, `pi`/`claude-code`/`codex`/`opencode`, the
prototype keys) are refused, so a specialist can never impersonate the
principal. **No colour lives here:** the avatar panel resolves it for the SAME
id (`avatar_colors` owns assignment and overrides).

**Bounds:** name 1..40 and instructions 1..2000 characters. Instructions keep
normal line breaks and tabs (a prompt section is genuinely multiline); other
C0/C1 controls and DEL are refused, in the raw text, before trimming.
Capacity remains **24 roles**. The persisted byte bound is derived from the
maximum compact v1 JSON: outer syntax + active ID (32 ASCII bytes), 24 records
(each including syntax, ID32, model64, name40×4 and instructions2000×4 bytes),
and 23 separating commas. UTF-8 uses at most4 bytes per scalar; the permitted
JSON escapes use at most2. Reads check both metadata and the final bounded
buffer; writes reject oversized or non-round-trippable candidates before any
filesystem mutation and refuse to replace an unreadable existing store.

**IPC:** `specialists_action` with the closed set
`view | create{id,name,instructions,model} | update{…} | delete{id} | select{id|null}`
(same sender gate + rate limit as the rest of the island). A named model must
be a SELECTABLE entry of the verified local registry — today exactly one
(`local-abito-gpt`), which the section says out loud instead of pretending to
choose. Creating is not choosing: a new role does not become the active one.

**Coherence:** one transaction lock serializes read/validate/write/commit/event
publication. The file is written FIRST and memory is committed only when the
write succeeded; a failed save leaves the previous roles (and the role in use)
exactly as they were and reports it, so the panel can never announce a role
that was not saved. Nowhere to persist (probe) is a memory-only change that
says so.

**One turn:** the effective system message is the base `chatlane::SYSTEM_PROMPT`
plus the role (base policy first, guard rails restated, no capability gained);
the effective target is the role's model when it names one, else the model
picker's selection — and a role whose model is no longer selectable REFUSES the
send instead of substituting another model. Both are frozen at submit, so
choosing another specialist while a turn runs changes the next turn, never the
one in flight. With `active: null` the system message is byte for byte the base
one.

**UI:** a section inside Ajustes (no new screen, no new icon) where the human
creates, edits, chooses and goes back to the principal, plus a display-only
role chip in the chat header. Plain text only; only trusted gestures change
anything. Arrow keys (wrapping), Home and End choose through the same selection
path after a trusted keydown, never a synthetic click; focus returns after the
IPC result. Save failures retain the draft/error until successful retry.
`load_error` shows a persistent unavailability notice, hides healthy role choices
and disables mutations; no reset is offered. A draft already open is retained.
Isolated Chromium/CDP with explicit mock IPC checks these paths; it is not native
Tauri proof. UI/native acceptance remains with the parent. Scripted `dispatchEvent`
cannot replace trusted input. Do not bypass the gesture guard.

### Verifying #327

```sh
cargo test --manifest-path apps/desktop-tauri/Cargo.toml --bin abito-island specialists
#   Store/host contracts: opaque/reserved ids, bounds and controls, fail-closed
#   store, closed command set, invalid input never mutates, principal prompt
#   unchanged, 0600/O_NOFOLLOW/atomic file, failed write keeps the store,
#   concurrent update/event ordering, stale model rejection, coherent frozen role,
#   maximum Unicode+IDs+models roundtrip, escaped JSON and exact/over-limit bytes,
#   corrupt/oversized startup mutation block, original bytes preserved, absence
cargo test --manifest-path apps/desktop-tauri/Cargo.toml --test frontend_specialists
node apps/desktop-tauri/test-node/specialists-view-check.cjs   # 21 checks
# Previous visual probe produced neither settings_section evidence nor PNGs.
# It was stopped; visual acceptance belongs to the frontend review.
```

## Q1 — island accessibility (observed)

- **No focus stealing:** `tauri.conf.json` window `focus: false`; `restore()`
  (second launch) shows the island without `set_focus`. Probe
  `a11y_evidence`: `window_focused_at_start/after_restore/after_expand:
  false`, `document_has_focus: false`. The ONLY focusing path is the
  deliberate second launch `abito-island --chat` (exact argv, pure
  `desktop::launch_intent`, tested): opens the chat and puts the caret in the
  composer — bind it to a GNOME shortcut yourself; Abito installs no global
  hook.
- **Keyboard:** once the human focuses the island, Tab reaches
  `#island-toggle` (“Abrir/Cerrar Abito”, `aria-expanded`, focus ring drawn
  on the island); Enter/Space opens the overview and focus moves to
  **Conversar**; Escape steps out of the composer, then collapses and
  returns focus to the island control.
- **44 px:** every visible control measured in the probe ≥44×44
  (`all_visible_at_least_44: true`: Conversar 132×44, Permitir 82×44,
  Denegar 83×44; Descartar aviso, chat and model controls likewise). The
  overview columns were narrowed (notices 236 px, card 228 px, both
  scrollable) so nothing overlaps the bottom-centre Conversar slot.
- **Screen readers:** notices are announced once per NEW notice in a polite
  `role=status` region (`Aviso: <title>. <detail>`), never on dismissal;
  the chat has its own polite region (per state change, not per token).

## Configuration: pointing at the real backend later

Nothing to do for the shipped default: the lane targets
`http://127.0.0.1:11003` (`security.cjs BRIDGE_ORIGIN`) and reads
`<stateRoot>/bridge.json` — the dev state root is `apps/desktop-tauri/.runtime`
(`ABITO_SOCKET_DIR` overrides the whole state root, as for M2). To enable the
real lane:

1. Create `.runtime/bridge.json` (mode **0600** — the descriptor gate
   refuses group/world-writable files, exactly like legacy) containing
   `{"v":1,"login":"your-login@tailnet.ts.net"}` — the same tailnet login
   the backend allows.
2. Start the Second Brain bridge on `127.0.0.1:11003`. If it lives
   elsewhere, set `ABITO_BRIDGE_BASE=http://127.0.0.1:<port>` (origin shape
   only: `http://host:port`, no path/query/fragment). **Only point this at a
   backend you intend the app to drive** — it is the approval authority.
3. Without `bridge.json` the lane reports `bridgeStatus: disabled` and makes
   zero requests (fail closed), which is also what the tests and the probe
   rely on.

## Verifying M3

```sh
# all tests: 88 unit (50 pre-M3 unchanged + 34 M3 pure RED→GREEN + 4 M3
# unit) + 17 approval integration (in-process fake backend) + 8 M2 = 113
cargo test --manifest-path apps/desktop-tauri/Cargo.toml
cargo build --manifest-path apps/desktop-tauri/Cargo.toml
sha256sum apps/desktop-tauri/frontend/clay-engine.js   # R6 frozen, unchanged

# probe WITH the socket override; the approval step spawns its own fake
# backend and sets ABITO_BRIDGE_BASE itself (in-process, loopback only):
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_SOCKET_DIR="$PWD/.runtime-probe" \
  timeout 150 cargo run
# → approval_evidence line:
#     base_origin_env "http://127.0.0.1:<fake>", fake_backend_spawned true,
#     posts_before_choice 0, card_before.state "pending" →
#     card_after.reason "Decisión enviada.",
#     execute_payload_hash_matches_card true,
#     bridge_status_before/after "healthy"
# → facade_evidence: choose_wired_denied true
# → stdout also prints the bare auth mode line `jar` (legacy parity)
```

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
- original M1a R6 rendered as SVG-DOM in WebKitGTK (historical evidence).
  #347 now pins its own R7 engine at SHA-256
  `6534f543b34d7fce3c460f6aae65867b8e40234ac4cf15e289183c91fc9d9c52`;
  that source update is not a claim of new native acceptance.

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

## Verifying M2

```sh
# all tests: 9 protocol unit (RED→GREEN) + 3 transport policy unit +
# 37 M1b tests (unchanged) + 8 receiver integration tests over real sockets
cargo test --manifest-path apps/desktop-tauri/Cargo.toml

cargo build --manifest-path apps/desktop-tauri/Cargo.toml
sha256sum apps/desktop-tauri/frontend/clay-engine.js   # R6 frozen, unchanged

# probe WITH the socket override (its own dir — never the Preview's root):
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_SOCKET_DIR="$PWD/.runtime-probe" \
  timeout 120 cargo run
# → transport_evidence line:
#     ready_ok true, frames_sent 2, notice_count 1,
#     connections_while_connected 1 → connections_after_disconnect 0,
#     preview_roots_detected_only[].connected_or_removed false
# → stdout also prints ABITO_DESKTOP_SOCKET=<endpoint> (legacy line)
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

## #384 — the Dot's avatar colours (frontend candidate)

`frontend/avatar-colors.js` is the pure contract for the Dot's colour, from the human

> «colores en ajustes por si alguien lo quiere cambiar, pero fijo el verde y los sub abitos especializados de difrentes colores»

- **The principal Abito is green by default.** No pose, activity, host condition, connected agent,
  notice or card is an input: `resolveColor(identity, overrides)` takes exactly those two arguments and
  ignores anything else a caller passes. An explicit human choice in Ajustes is the only thing that
  changes it — an explicit preference is not an identity and not an active agent, so refusing it would
  be inventing a prohibition nobody asked for. The default green is the frozen R6 engine's own skin
  gradient; the module never touches the engine, the island markup, CSS geometry or transparency.
- **A specialised sub-Abito has a stable identity color** over blue/mint/orange/purple:
  `defaultColor(identity)` uses FNV-1a/32 over the canonical id, independent of set membership.
  Adding or removing another specialist never repaints it. Repeated defaults and overrides are
  valid; names distinguish identities. There is no four-specialist cap or duplicate warning.
- **Each Settings option has a visible color name before selection and a 44px minimum target.**
  Radio semantics, one tab stop, arrow keys, Home/End and Space support keyboard use; selection
  and visible focus have separate rings. A successful save restores focus after rerender.
- **The Ajustes overrides are a validated closed schema** (`sanitizeOverrides`): only a customizable
  identity (the principal, or a real sub-Abito) may be keyed, and only the five palette colours may be
  values. Everything else — a provider/CLI slug, `__proto__`/`constructor`, a wrong type, an unknown
  colour name — is dropped: never applied, never thrown.
- **No specialist list is invented.** `settingsRows` returns no specialist row while no real sub-Abito
  exists, and `pi`/`claude-code`/`codex`/`opencode` are the connectors/providers the island already
  names, never sub-Abito identities.
- Checks: `node test-node/avatar-colors-check.cjs` (18), also run by `cargo test` through
  `tests/frontend_avatar_colors.rs`; the panel's model is covered by `test-node/settings-view-check.cjs`.

**How a choice reaches the Dot.** Ajustes writes it through the existing preferences command
(`prefs_action {action:"set_avatar_color",identity,color}`, validated in `src/prefs.rs` and applied by
`src/settingshost.rs` through the shared `prefs::transact` gate), `prefs.json` keeps `v: 1` and its `sound` untouched, and
the Settings controls and principal island consumer read it at boot and on every `prefs:state`.
The parent-authorized 16-line `island.js` transplant resolves only the principal preference,
never the active specialist. It sets `data-dot-color` for non-green overrides; CSS tints
only the three skin stops, retaining R6 bytes, poses and geometry. T2 reads the sole
specialist owner's immutable `identityView()` projection (`kind`, stable `id`, display `name`)
and its `abito:specialist-identities` notification; Settings never fetches/copies role
instructions or models. Actual role rows and the existing chat user icon show each identity's
color. Loading/unavailable identities have an explicit notice, not a healthy-empty claim.
Only while the specialist chip is visible, the header gives identity labels a second row
and retains all five named 44px controls in the first row at 400px and 320px. Settings
starts below both rows; principal-only header layout, island geometry and R6 stay unchanged.
A failed write is
reported beside the color controls with visible inline text and the existing aria-live announcement;
it keeps the previous colour (`save_failed`). The explanation survives rerenders, rejected retries and
pending retries, and clears only after a successful save response. The panel never announces a stored
choice it did not store.

**Verification boundary.** T2 specialist rows use the actual #327 owner projection; absent
identities are not rendered and their stored overrides remain untouched. Focus, caret and
drafts survive unrelated owner/prefs pushes. T2 checks and whole-layout screenshots are in
`evidence/integration-327-342-384/t2/` (run `node .../identity-check.cjs` and
`node .../browser-check.cjs <evidence-label>` from this worktree). The separate
`header-check.cjs <unique-label>` preserves the prior 9/10 failure and captures
320/400px top/middle/bottom before asserting containment. Its chat mock returns
`display_name`; real shipped greeting DOM is checked before and after page reload. The browser fixture serves
shipped markup/CSS and Settings/specialists modules at the default 400×640 chat geometry;
it loads all shipped scripts, opens the existing host seam with
`__islandSetState('overview')` / `__islandSetView('chat',400,640)`, and supplies IPC mocks
and trusted CDP input, not an application endpoint or model call. Reload storage is the
fixture's isolated `sessionStorage` adapter, not production `prefs.json` proof.
Chromium/CDP evidence uses an explicitly mocked IPC host,
not native Tauri/WebKitGTK or CSP proof. T1 integrates #342's preference serial gate with sound, display_name and avatar_colors.
Combined command and extracted production disk-helper checks are under
`evidence/integration-327-342-384/`; the latter adapt only AppHandle/path resolution, not
Tauri IPC or native delivery. They cover name→sound→color→reload, concurrent three-field
commits, rejected/no-op commands and failed rename without false publication. Donor browser outcomes
are not integrated/native acceptance. T2 connects identity colors, T3 handles native validation,
and T4 owns independent integrated review. No real model calls belong to T1 checks.

## Layout

```
apps/desktop-tauri/
├── Cargo.toml            # normal crate; tauri v2 + single-instance + x11rb + libc/sha2 (M2)
├── build.rs              # tauri_build::build()
├── tauri.conf.json       # window contract, static frontendDist, strict CSP (M1b)
├── capabilities/main.json# least privilege: core:event listen/unlisten only (M1b)
├── run.sh                # GDK_BACKEND=x11 + cargo run
├── .gitignore            # /target/ + /.runtime*/ (M2 socket dirs, never committed)
├── tests/
│   ├── transport_receiver.rs # M2 integration: real UDS receiver + clients (+ Node producer)
│   └── approval_bridge.rs    # M3 integration: approval lane vs in-process fake backend
├── test-node/
│   └── producer-check.cjs    # drives the UNCHANGED legacy adapter.cjs (read-only) in tests
├── src/
│   ├── lib.rs            # lib target: bridge/core/desktop/geometry/workarea/protocol/transport/approval…
│   ├── bridge.rs         # PURE: payload/sender/rate gate + typed errors (+tests, RED→GREEN)
│   ├── card.rs           # PURE M3: expiry/proposals/card reason/projection/choose (+tests, RED→GREEN)
│   ├── requests.rs       # PURE M3: origin + route allowlist + login schema (+tests, RED→GREEN)
│   ├── retry.rs          # PURE M3: auth ladder — known rejections only (+tests, RED→GREEN)
│   ├── desktop.rs        # PURE: transition + snapshot shape (+tests)
│   ├── geometry.rs       # PURE: sizes, clamp, snap, grow anchor, click threshold (+tests)
│   ├── core.rs           # press/drag/release/toggle handlers shared by commands + probe (+tests)
│   ├── protocol.rs       # PURE M2: framing/validation/quota/dedupe/expiry (+tests, RED→GREEN)
│   ├── approval.rs       # M3: the lane (login read, cookie, request/authenticated/mint/poll/decide)
│   ├── http.rs           # M3: loopback HTTP/1.1 client (deadline, discard, 1 MiB, abort registry)
│   ├── fakebridge.rs     # M3: in-process fake api.py backend (tests + probe only)
│   ├── transport.rs      # M2: UDS receiver (perms, owner, quotas, cleanup) (+policy tests)
│   ├── workarea.rs       # X11 _NET_WORKAREA ∩ monitor, fallbacks
│   ├── chat.rs           # PURE U1: abito.chat.v1 turn machine, limits, prompt budget, IPC commands (+tests)
│   ├── localmodel.rs     # U1: loopback-only endpoint, SSE/chunked decoders, one-request streaming client
│   ├── chatlane.rs       # U1: preflight (no-load/no-substitute), one turn, cancel, availability
│   ├── chathost.rs       # U1: chat_action command, chat:state, overview<->chat resize
│   ├── fakemodel.rs      # U1: in-process fake llama.cpp router (tests + probe only)
│   ├── models.rs         # PURE U2: verified local registry, metadata, resource gate, listing, saved selection
│   ├── modelshost.rs     # U2: models_action command, models:state, selection → chat target
│   ├── probe.rs          # ABITO_PROBE read-back script (geometry + facade + transport + approval + chat)
│   └── main.rs           # wiring, commands, publish, lifecycle, transport/signal, approval, placement
└── frontend/
    ├── index.html        # island markup + M3 approval card (display-only)
    ├── style.css         # reused island tokens
    ├── desktop.js        # window.desktop facade over invoke/events (M1b)
    ├── island.js         # motion, pointer forwarding, notices + approval card (M2/M3), chat view motion (U1)
    ├── chat-view.js      # PURE U1 helpers (labels, send gate, announcements) — node-tested
    ├── chat.js           # U1 chat surface (composer, transcript, live region)
    ├── models.js         # U2 model picker panel (inside the chat view)
    └── clay-engine.js    # frozen R6, byte-for-byte, DO NOT EDIT
```

## M4 format A — user-local package (staged only)

Contract: `docs/desktop-packaging-plan.md`. Nothing here installs, replaces or
launches an installed app.

```sh
node packaging/build.cjs --out "$PWD/dist"   # offline release build + stage + receipt
node packaging/verify.cjs dist/abito-island/<version>   # re-hash vs receipt, no launch
```

- Build: `cargo build --release --locked --offline --features tauri/custom-protocol`
  (`custom-protocol` makes Tauri a real release: without it the binary embeds
  the build-tree path as a dev build). Gates before building: engine pin (public `checkR6`, now R7)
  (`6534f543…`), curated `frontend/` list, CSP without remote/unsafe sources,
  capabilities = listen/unlisten only, no `devtools`/shell/fs/http features.
- Stage: `abito-island` (release binary), `abito-island-launcher` (no args;
  refuses the whole `LD_*` family, `GDK_DEBUG`/`GTK_*` debug, WebKit inspector vars and every `ABITO_*` knob except `ABITO_PROJECT_ROOT`; forces X11),
  `com.abitog.AbitoTauri.desktop` (template, `@INSTALL_DIR@`), `receipt.json`
  (sha256 of every file, `Cargo.lock`, config, frontend, rustc, git HEAD and a
  clean-tree attestation). `build.cjs` REFUSES to build when the product paths
  have uncommitted or untracked changes: build from a clean checkout
  (`git worktree add ../abito-m4-clean <commit>`).
- Identity: `com.abitog.AbitoTauri`; installed runtime root
  `$XDG_RUNTIME_DIR/abito-island` (never `abito-desktop*`); the project root of
  an installed build comes only from `ABITO_PROJECT_ROOT` (absolute,
  normalized, existing dir) — otherwise the transport reports unavailable.
  Debug builds keep the dev layout. Tests: `tests/install_root.rs`
  (also under `cargo test --release`), `test-node/packaging-check.cjs`.
- Verified here: release build offline; identical binary hash on a rebuild at
  the same path; the verifier rejects a binary that embeds the source-tree
  path or devtools markers; a smoke run of the release binary (probe, private
  roots) reached `ready_ok: true`, 18 SVG R6 elements, exit 0. Smoke script
  (`packaging/smoke.sh <stage-dir>`) is versioned: it runs the binary with
  `ABITO_PROBE=1 ABITO_PROJECT_ROOT=<private dir> ABITO_SOCKET_DIR=<private dir>/sock`
  directly (not through the launcher, which refuses those knobs).
- NOT verified: reproducibility across different checkout paths; behaviour
  of an actually installed copy; Pi session against the new root.

## N9 — one-command install (user-local)

```sh
sh packaging/install.sh artifacts/abito-island-0.1.0-<commit>   # or dist/abito-island/<version>
sh packaging/install.sh --uninstall
```

Verifies EVERY file against `receipt.json` first (any mismatch, extra file, symlink,
non-clean provenance or foreign identity aborts without touching anything), then
installs binary + launcher + icon (+ template and receipt) into
`~/.local/share/abito-island` (`--prefix` to override) via temp-file + rename (a
running binary can be replaced), and writes
`~/.local/share/applications/com.abitog.AbitoTauri.desktop` with
`Exec=env ABITO_PROJECT_ROOT=<root> "<launcher>"`. Default project root:
`$HOME/Apps/sb-second-brain` (`--project-root` to change). Idempotent; `--uninstall`
removes exactly our files and the entry. Tests: `test-node/install-check.cjs`
(11, toy stage in temp dirs). Never touches `com.abitog.Abito*` roots.
