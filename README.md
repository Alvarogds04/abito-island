# Abito island — Electron → Rust + Tauri, units M1b (host/bridge) + M2 (Pi transport) + M3 (approval lane)

Skeleton of the Abito desktop island as a normal Cargo project with Tauri v2
(`tauri-build` in `build.rs`, static `frontendDist`, **no npm, no
node_modules, no cargo-tauri CLI**). Transparent, undecorated, always-on-top
X11 window hosting the frozen R6 clay engine with free drag and edge docking.

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
│   ├── probe.rs          # ABITO_PROBE read-back script (geometry + facade + transport + approval)
│   └── main.rs           # wiring, commands, publish, lifecycle, transport/signal, approval, placement
└── frontend/
    ├── index.html        # island markup + M3 approval card (display-only)
    ├── style.css         # reused island tokens
    ├── desktop.js        # window.desktop facade over invoke/events (M1b)
    ├── island.js         # motion, pointer forwarding, notices + approval card (M2/M3)
    └── clay-engine.js    # frozen R6, byte-for-byte, DO NOT EDIT
```
