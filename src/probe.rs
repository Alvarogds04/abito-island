//! `ABITO_PROBE=1` (or `--probe`) read-back script for unit M1a.
//!
//! The probe drives the SAME core handlers the pointer commands use — press,
//! drag, release/snap, toggle — programmatically. It is NOT a real pointer:
//! every line printed here says so. After each step it waits for the window
//! manager to apply the change, then prints a JSON line with the ACTUAL
//! getters (outer_position, inner_size, scale_factor, is_always_on_top,
//! is_decorated, work area) next to the values we REQUESTED, plus frontend
//! evidence (SVG element count rendered by clay-engine, zero canvas).
//! Exits only this process.

use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager};

use abito_island::core::{screen_at, ReleaseOutcome, WindowIo};
use abito_island::geometry;
use crate::{apply_plan, main_window, refresh_work_area, store_requested, AppState, TauriIo};

const NO_POINTER: &str =
    "none — the probe drives the same core handlers programmatically; no real pointer events are used";

fn emit(value: &serde_json::Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// Wait until the WM reports the requested inner size, bounded.
fn wait_for_size(app: &AppHandle, want: (i32, i32), timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let win = main_window(app);
        let got = win
            .inner_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or((0, 0));
        if got == want {
            return true;
        }
        sleep(Duration::from_millis(50));
    }
    false
}

fn readback(app: &AppHandle, step: &str) {
    let win = main_window(app);
    let state = app.state::<AppState>();
    let wa = abito_island::workarea::current(&win);
    let pos = win.outer_position().ok().map(|p| (p.x, p.y));
    let size = win.inner_size().ok().map(|s| (s.width as i32, s.height as i32));
    let scale = win.scale_factor().ok();
    let always_on_top = win.is_always_on_top().ok();
    let decorated = win.is_decorated().ok();
    let (rpos, rsize, raction) = {
        let req = state.requested.lock().expect("requested lock");
        (req.pos, req.size, req.action.clone())
    };
    // Raw X11 ground truth for our own window (read-only): disambiguates the
    // Tauri getters from what the WM actually applied.
    // FIX-B: identified by _NET_WM_PID == our pid (title secondary); a
    // failure is printed as `x11_window_error`, never replaced by a guess.
    let found = abito_island::workarea::x11_find_own_window("Abito");
    let x11_error = found.as_ref().err().map(|e| e.as_str());
    let x11win = found.ok();
    let x11json = x11win.as_ref().map(|w| {
        json!({
            "id": format!("0x{:x}", w.id),
            "geometry": [w.x, w.y, w.w, w.h],
            "border": w.border,
            "gtk_frame_extents": w.frame_extents,
            "net_wm_state_above": w.wm_state_above,
            "wm_class": w.wm_class,
        })
    });
    emit(&json!({
        "step": step,
        "pointer_input": NO_POINTER,
        "actual": {
            "outer_position": pos.map(|p| [p.0, p.1]),
            "inner_size": size.map(|s| [s.0, s.1]),
            "scale_factor": scale,
            "is_always_on_top": always_on_top,
            "is_decorated": decorated,
            "work_area": [wa.rect.x, wa.rect.y, wa.rect.w, wa.rect.h],
            "work_area_source": wa.source,
            "work_area_x11_raw": wa.x11.map(|r| [r.x, r.y, r.w, r.h]),
            "work_area_monitor_raw": wa.monitor.map(|r| [r.x, r.y, r.w, r.h]),
            "x11_window": x11json,
            "x11_window_error": x11_error,
            "x11_window_match": "_NET_WM_PID == own pid, title secondary",
        },
        "requested": {
            "position": rpos.map(|p| [p.0, p.1]),
            "size": rsize.map(|s| [s.0, s.1]),
            "action": raction,
        },
        "match": {
            "position": pos.is_some() && pos == rpos,
            "size": size.is_some() && size == rsize,
        },
        // X-server truth: what mutter actually applied for our request.
        "match_x11": {
            "position": x11win.as_ref().map_or(serde_json::Value::Null, |w| {
                serde_json::Value::from(Some((w.x, w.y)) == rpos)
            }),
            "size": x11win.as_ref().map_or(serde_json::Value::Null, |w| {
                serde_json::Value::from(Some((w.w, w.h)) == rsize)
            }),
        },
    }));
}

/// Move the pointer (as a screen point) from its current position to `target`
/// in 10 simulated steps, going through `Core::drag` each time — exactly the
/// handler the webview's `drag_move` command calls.
fn simulated_drag(app: &AppHandle, area: geometry::Rect, target: (f64, f64)) {
    let state = app.state::<AppState>();
    let win = main_window(app);
    let io = TauriIo(&win);
    let scale = io.scale();
    for i in 1..=10 {
        // The window follows the pointer, so the pointer's screen point is
        // outer origin + grab offset; interpolate toward the target from there
        // and convert back to a client coordinate for the shared handler.
        let (ox, oy) = io.outer_position();
        let start = screen_at(&io, (50.0, 20.0));
        let t = i as f64 / 10.0;
        let screen = (
            start.0 + (target.0 - start.0) * t,
            start.1 + (target.1 - start.1) * t,
        );
        let client = ((screen.0 - ox as f64) / scale, (screen.1 - oy as f64) / scale);
        let moved = {
            let mut core = state.core.lock().expect("core lock");
            core.drag(&io, area, client)
        };
        if let Some(pos) = moved {
            store_requested(&state, "drag", Some(pos), None);
        }
        sleep(Duration::from_millis(40));
    }
}

pub fn run(app: AppHandle) {
    emit(&json!({
        "probe": "abito M1b geometry/state + bridge read-back",
        "pointer_input": NO_POINTER,
        "sequence": ["start", "simulated_drag_near_bottom", "release_snap_bottom", "expand", "collapse", "drag_to_top_snap", "facade_evidence", "frontend_evidence", "transport_evidence", "overview_visual_evidence", "approval_evidence", "a11y_evidence", "chat_open", "chat_evidence", "models_evidence", "chat_back_to_overview", "chat_collapse"],
        "gdk_backend": std::env::var("GDK_BACKEND").unwrap_or_else(|_| "unset".into()),
    }));

    let state = app.state::<AppState>();

    // Wait for the webview's evidence command (clay-engine rendered, no canvas).
    let mut evidence = None;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Some(e) = state.evidence.lock().expect("evidence lock").clone() {
            evidence = Some(e);
            break;
        }
        sleep(Duration::from_millis(100));
    }
    sleep(Duration::from_millis(100));

    // 1. start: wait for the initial geometry to settle first — WebKitGTK
    //    inflates the very first allocation and the app re-pins 304x44 right
    //    after page load (same "wait for the WM to apply" discipline as every
    //    later step), then read the honest getters.
    let scale0 = main_window(&app).scale_factor().unwrap_or(1.0);
    let compact = geometry::scaled_size(geometry::LOGICAL_COMPACT, scale0);
    let overview = geometry::scaled_size(geometry::LOGICAL_OVERVIEW, scale0);
    let settled = wait_for_size(&app, compact, Duration::from_secs(6));
    if !settled {
        emit(&json!({"step": "start", "warning": "compact size did not settle within 6s"}));
    }
    sleep(Duration::from_millis(200));
    readback(&app, "start");

    // 2. simulated drag to a point near the bottom of the work area.
    let area = refresh_work_area(&app, &state);
    let win = main_window(&app);
    let io = TauriIo(&win);
    let press_client = (50.0, 20.0);
    {
        let mut core = state.core.lock().expect("core lock");
        core.press(&io, press_client);
    }
    let target = (
        area.x as f64 + area.w as f64 / 2.0,
        area.bottom() as f64 - 24.0,
    );
    simulated_drag(&app, area, target);
    sleep(Duration::from_millis(200)); // WM applies the last move
    readback(&app, "simulated_drag_near_bottom");

    // 3. release: the core decides snap (drag) — must NOT toggle.
    let client = {
        let (ox, oy) = io.outer_position();
        let s = io.scale();
        ((target.0 - ox as f64) / s, (target.1 - oy as f64) / s)
    };
    let outcome = {
        let mut core = state.core.lock().expect("core lock");
        core.release(&io, area, client, false)
    };
    match &outcome {
        ReleaseOutcome::Snapped { rect, edge } => {
            store_requested(
                &state,
                &format!("snap_{:?}", edge).to_lowercase(),
                Some((rect.x, rect.y)),
                None,
            );
        }
        other => emit(&json!({"step": "release_snap_bottom", "unexpected": format!("{other:?}") })),
    }
    sleep(Duration::from_millis(300));
    readback(&app, "release_snap_bottom");

    // 4. expand: docked at the bottom -> must grow upward (bottom anchored).
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(&app, &state, plan);
    let applied = wait_for_size(&app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(&app, "expand");
    if !applied {
        emit(&json!({"step": "expand", "warning": "window did not reach overview size within 3s"}));
    }

    // 5. collapse: frontend animates first, native resize follows (~400ms).
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(&app, &state, plan);
    let applied = wait_for_size(&app, compact, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(&app, "collapse");
    if !applied {
        emit(&json!({"step": "collapse", "warning": "window did not return to compact size within 3s"}));
    }

    // 6. drag to the top and release -> snaps to the top edge keeping X.
    let area = refresh_work_area(&app, &state);
    {
        let mut core = state.core.lock().expect("core lock");
        core.press(&io, press_client);
    }
    let target = (
        area.x as f64 + area.w as f64 / 2.0,
        area.y as f64 + 12.0,
    );
    simulated_drag(&app, area, target);
    let client = {
        let (ox, oy) = io.outer_position();
        let s = io.scale();
        ((target.0 - ox as f64) / s, (target.1 - oy as f64) / s)
    };
    let outcome = {
        let mut core = state.core.lock().expect("core lock");
        core.release(&io, area, client, false)
    };
    match &outcome {
        ReleaseOutcome::Snapped { rect, edge } => {
            store_requested(
                &state,
                &format!("snap_{:?}", edge).to_lowercase(),
                Some((rect.x, rect.y)),
                None,
            );
        }
        other => emit(&json!({"step": "drag_to_top_snap", "unexpected": format!("{other:?}") })),
    }
    sleep(Duration::from_millis(300));
    readback(&app, "drag_to_top_snap");

    // 7. facade evidence: exercise `window.desktop` through the REAL webview
    //    IPC path — verbs list, one typed rejection of an invalid call, a
    //    rate-limit rejection burst, onState event delivery, and the page
    //    URL/label the command-side sender gate actually sees. The JS reports
    //    back through record_facade_evidence; nothing here is synthesised.
    if let Err(e) = win.eval(FACADE_JS) {
        emit(&json!({"step": "facade_evidence", "eval_failed": e.to_string()}));
    }
    let mut facade: Option<serde_json::Value> = None;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(v) = state.facade.lock().expect("facade lock").clone() {
            facade = Some(v);
            break;
        }
        sleep(Duration::from_millis(100));
    }
    let mut expected_verbs: Vec<&str> = abito_island::bridge::ACTIONS.to_vec();
    expected_verbs.push("onState"); // the one facade-only subscription verb
    expected_verbs.sort_unstable();
    let expected_json = serde_json::json!(expected_verbs);
    let observed_verbs = facade.as_ref().and_then(|f| f.get("verbs")).cloned();
    // M3: `choose` must be WIRED — its rejection while no request stands is
    // the typed `denied` (Electron's `Denied`), never `not-yet-wired`.
    let choose_wired_denied = facade.as_ref()
        .and_then(|f| f.get("choose"))
        .and_then(|choice| choice.get("code"))
        == Some(&serde_json::json!("denied"));
    emit(&json!({
        "step": "facade_evidence",
        "expected_verbs": expected_json,
        "verbs_match_preload": observed_verbs.as_ref() == Some(&expected_json),
        "choose_wired_denied": choose_wired_denied,
        "timed_out": facade.is_none(),
        "evidence": facade,
    }));

    // 8. frontend evidence from the webview command.
    emit(&json!({
        "step": "frontend_evidence",
        "pointer_input": "produced by the webview itself via the record_frontend_evidence command",
        "svg_elements_rendered_by_clay_engine": evidence.as_ref().map(|e| e.svgs),
        "canvas_elements": evidence.as_ref().map(|e| e.canvases),
        "clay_revision": evidence.as_ref().map(|e| e.revision.as_str()),
        "received": evidence.is_some(),
    }));

    // 9. transport evidence (M2): the probe itself acts as the Pi producer
    //    against OUR OWN receiver (default `.runtime` or the ABITO_SOCKET_DIR
    //    override this process owns): hello → ready → ONE settled frame, then
    //    the notice count read back through the real snapshot path. The
    //    installed Preview's reserved socket roots are DETECTED read-only —
    //    never connected, never unlinked.
    transport_evidence(&app);

    // 9b. overview visual evidence (UI.1): PNGs of the overview scenes on a
    //     known background (opt-in: ABITO_PROBE_VISUAL=1). Driven through the
    //     same host paths the real lanes use; nothing here approves by itself.
    overview_visual_evidence(&app);

    // 10. approval evidence (M3): the lane already runs against the
    //     in-process fake backend (env override set at startup), so this
    //     performs the human's explicit choice and reads card/bridgeStatus
    //     back through the REAL snapshot path before and after.
    //     With ABITO_PROBE_VISUAL=1 the visual scenes already consumed the
    //     (sticky) card, so approval/a11y are skipped there: they have their
    //     own non-visual run, and this keeps the visual run reaching chat/models.
    let visual_run = std::env::var("ABITO_PROBE_VISUAL").as_deref() == Ok("1");
    if !visual_run {
        approval_evidence(&app);
    }

    // 10b. accessibility (Q1): the overview's controls measured in the
    //      webview, the notice live region, and keyboard focus: the window
    //      must NOT be focused by start or restore (no focus stealing).
    if !visual_run {
        a11y_evidence(&app);
    }

    // 11. chat (U1): overview -> chat in the SAME window (672x256 read back
    //     from the X server), one turn through the REAL `chat_action` IPC
    //     against an in-process FAKE local router (the real router and any
    //     provider are never contacted by the probe), then an unreachable
    //     target to prove the honest "unavailable" with no fallback, then
    //     back to the overview and collapse.
    chat_evidence(&app);

    // Close the receiver before the hard exit: identity-checked unlink of the
    // socket this process created (never a foreign path).
    crate::close_transport(&app);
    // Release the single-instance D-Bus name before skipping RunEvent::Exit
    // via process::exit, so a later instance is never mistaken for a live one.
    tauri_plugin_single_instance::destroy(&app);
    std::process::exit(0); // exits only this app
}

/// M2 transport read-back: one real UnixStream round trip to the receiver
/// this process bound, plus the snapshot state it produced. Prints one JSON
/// line (`transport_evidence`).
fn transport_evidence(app: &AppHandle) {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let state = app.state::<AppState>();
    let scans = abito_island::transport::preview_scan();
    let endpoint = state
        .transport
        .lock()
        .expect("transport lock")
        .as_ref()
        .map(|transport| transport.endpoint().to_path_buf());
    let mut line = json!({
        "step": "transport_evidence",
        "pointer_input": NO_POINTER,
        "socket_dir_env": std::env::var(abito_island::transport::SOCKET_DIR_ENV).ok(),
        "endpoint": endpoint.as_ref().map(|path| path.display().to_string()),
        "socket_dir_owned_by_this_process": true,
        "project": state.project.clone(),
        "unavailable": state.unavailable.load(std::sync::atomic::Ordering::SeqCst),
        "preview_roots_detected_only": scans.iter().map(|scan| json!({
            "root": scan.root,
            "sockets_detected": scan.sockets,
            "connected_or_removed": false,
        })).collect::<Vec<_>>(),
        "frames_sent": 0,
        "ready_ok": false,
        "notice_count": 0,
        "connections_while_connected": serde_json::Value::Null,
        "connections_after_disconnect": serde_json::Value::Null,
        "error": serde_json::Value::Null,
    });
    let Some(endpoint) = endpoint else {
        line["error"] = json!("receiver unavailable (see startup log)");
        emit(&line);
        return;
    };
    let attempt = (|| -> Result<(u32, bool, usize, Option<u32>, Option<u32>), String> {
        let mut stream =
            UnixStream::connect(&endpoint).map_err(|error| format!("connect: {error}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|error| format!("read timeout: {error}"))?;
        let project = state.project.clone();
        let hello = json!({"v":1, "type":"hello", "project":project,
                           "sessionId":"probe-session", "at": crate::now_ms() as u64});
        let mut frames = 0u32;
        stream
            .write_all(format!("{hello}\n").as_bytes())
            .map_err(|error| format!("write hello: {error}"))?;
        frames += 1;
        let mut buffer = [0u8; 128];
        let ready_ok = match stream.read(&mut buffer) {
            Ok(count) => &buffer[..count] == abito_island::protocol::READY_LINE,
            Err(error) => return Err(format!("read ready: {error}")),
        };
        if !ready_ok {
            return Ok((frames, false, 0, None, None));
        }
        let settled = json!({"v":1, "type":"settled", "project":project,
                             "sessionId":"probe-session", "at": crate::now_ms() as u64,
                             "id":"probe-1"});
        stream
            .write_all(format!("{settled}\n").as_bytes())
            .map_err(|error| format!("write settled: {error}"))?;
        frames += 1;
        let while_connected = state.connections.load(std::sync::atomic::Ordering::SeqCst);
        // Read the notice back through the REAL snapshot path (same function
        // every desktop:state event and the `snapshot` verb use).
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut notice_count;
        loop {
            let snapshot = crate::build_snapshot(app, &state);
            notice_count = snapshot
                .get("notices")
                .and_then(serde_json::Value::as_array)
                .map(|notices| notices.len())
                .unwrap_or(0);
            if notice_count >= 1 || Instant::now() >= deadline {
                break;
            }
            sleep(Duration::from_millis(50));
        }
        drop(stream);
        // The disconnect is reported asynchronously by the receiver thread.
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut after = state.connections.load(std::sync::atomic::Ordering::SeqCst);
        while after != 0 && Instant::now() < deadline {
            sleep(Duration::from_millis(50));
            after = state.connections.load(std::sync::atomic::Ordering::SeqCst);
        }
        Ok((frames, ready_ok, notice_count, Some(while_connected), Some(after)))
    })();
    match attempt {
        Ok((frames, ready_ok, notice_count, while_connected, after)) => {
            line["frames_sent"] = json!(frames);
            line["ready_ok"] = json!(ready_ok);
            line["notice_count"] = json!(notice_count);
            line["connections_while_connected"] = json!(while_connected);
            line["connections_after_disconnect"] = json!(after);
        }
        Err(error) => line["error"] = json!(error),
    }
    // The `dismiss` verb (wired with M2): run the same dispatch the command
    // funnel uses after validation, and read the count back. Wired means the
    // first notice disappears — a not-yet-wired rejection would show here.
    if line
        .get("notice_count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
        >= 1
    {
        let count_notices = |app: &AppHandle| {
            crate::build_snapshot(app, app.state::<AppState>().inner())
                .get("notices")
                .and_then(serde_json::Value::as_array)
                .map(|notices| notices.len())
                .unwrap_or(0)
        };
        let before = count_notices(app);
        let outcome =
            crate::dispatch_verb(app, &state, abito_island::bridge::Action::Dismiss, None);
        let after = count_notices(app);
        line["dismiss"] = json!({
            "dispatched_ok": outcome.is_ok(),
            "error": outcome.as_ref().err().map(|error| serde_json::to_value(error).unwrap_or_default()),
            "notices_before": before,
            "notices_after": after,
        });
    } else {
        line["dismiss"] = json!({ "skipped": "no notice to dismiss" });
    }
    emit(&line);
}

/// UI.1 visual read-back: the five OVERVIEW scenes on a known background.
/// State is driven through the REAL host paths (transport receiver, fake
/// backend + dispatch funnel the webview's `allow` verb reaches) — never
/// synthesised frontend text. Sequence:
///   sinpi               connections 0, notices 0, no card
///   conectado           one live producer connection (hello → ready)
///   aviso               ONE settled notice from that connection
///   tarjeta-pendiente   healthy bridge + pending card (fresh proposal)
///   tarjeta-resuelta    the human's explicit Allow through dispatch_verb
/// A fresh pending proposal is left served so the later approval_evidence
/// step still exercises its own decision.
fn overview_visual_evidence(app: &AppHandle) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return; // opt-in: the default probe flow is unchanged
    }
    let state = app.state::<AppState>();
    let card_state = |snapshot: &serde_json::Value| -> String {
        snapshot
            .get("card")
            .and_then(|card| card.get("state"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("none")
            .to_string()
    };

    let mut line = json!({
        "step": "overview_visual_evidence",
        "pointer_input": NO_POINTER,
        "mode": serde_json::Value::Null,
        "states": [],
        "error": serde_json::Value::Null,
    });
    let fake = state.probe_fake.lock().expect("probe fake").clone();
    // Two complementary runs (the lane's selected candidate is STICKY — a
    // served proposal can never legally un-serve, so a clean no-card overview
    // is only reachable when the bridge never became healthy):
    //   no fake  (ABITO_BRIDGE_BASE set from outside → dead origin):
    //             sinpi / conectado / aviso, card is null all run.
    //   fake     (default probe backend): tarjeta-pendiente / -resuelta.
    let card_scenes = fake.is_some();
    line["mode"] = json!(if card_scenes { "card" } else { "sin-tarjeta" });

    let win = main_window(app);
    let area = refresh_work_area(app, state.inner());
    let io = TauriIo(&win);
    let scale = io.scale();
    let overview = geometry::scaled_size(geometry::LOGICAL_OVERVIEW, scale);
    let compact = geometry::scaled_size(geometry::LOGICAL_COMPACT, scale);

    // Expand (same core toggle the pointer uses) and let the spring settle.
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, state.inner(), plan);
    wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(900));

    if !card_scenes {
        // sin Pi: no connections, no notices, and (this run) no card.
        let snapshot = crate::build_snapshot(app, state.inner());
        if card_state(&snapshot) != "none" {
            line["error"] = json!("expected no card without a reachable bridge");
        }
        sleep(Duration::from_millis(200));
        capture_visual(app, "overview-sinpi");
        // i-abierto: the «i» detail open (a real click on the real button).
        let _ = main_window(app).eval("document.getElementById('notice-info').click()");
        sleep(Duration::from_millis(300));
        capture_visual(app, "overview-i-abierto");
        let _ = main_window(app).eval("document.getElementById('notice-info').click()");
        sleep(Duration::from_millis(300));
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": "sinpi",
            "connections": state.connections.load(std::sync::atomic::Ordering::SeqCst),
            "card": card_state(&snapshot),
        }));

        // conectado: a REAL hello → ready round trip against OUR receiver; the
        // connection count stays 1 while the stream stays open.
        let connected = (|| -> Result<bool, String> {
            use std::io::{Read, Write};
            use std::os::unix::net::UnixStream;
            let endpoint = state
                .transport
                .lock()
                .expect("transport lock")
                .as_ref()
                .map(|transport| transport.endpoint().to_path_buf())
                .ok_or("receiver unavailable")?;
            let mut stream =
                UnixStream::connect(&endpoint).map_err(|error| format!("connect: {error}"))?;
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .map_err(|error| format!("read timeout: {error}"))?;
            let project = state.project.clone();
            let hello = json!({"v":1, "type":"hello", "project":project,
                               "sessionId":"probe-visual", "at": crate::now_ms() as u64});
            stream
                .write_all(format!("{hello}\n").as_bytes())
                .map_err(|error| format!("write hello: {error}"))?;
            let mut buffer = [0u8; 128];
            let count = stream
                .read(&mut buffer)
                .map_err(|error| format!("read ready: {error}"))?;
            if &buffer[..count] != abito_island::protocol::READY_LINE {
                return Ok(false);
            }
            // Keep the stream open across BOTH captures: connected first, then
            // the settled frame for the notice scene.
            sleep(Duration::from_millis(400));
            capture_visual(app, "overview-conectado");
            let settled = json!({"v":1, "type":"settled", "project":project,
                                 "sessionId":"probe-visual", "at": crate::now_ms() as u64,
                                 "id":"probe-visual-1"});
            stream
                .write_all(format!("{settled}\n").as_bytes())
                .map_err(|error| format!("write settled: {error}"))?;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let snapshot = crate::build_snapshot(app, state.inner());
                if snapshot["notices"].as_array().map(|n| n.len()).unwrap_or(0) >= 1 {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("notice did not arrive within 3s".into());
                }
                sleep(Duration::from_millis(50));
            }
            sleep(Duration::from_millis(300));
            capture_visual(app, "overview-aviso");
            drop(stream);
            Ok(true)
        })();
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": "conectado+aviso",
            "ok": connected,
        }));
    } else {
        // tarjeta-pendiente: serve a FRESH pending proposal (same payload_hash
        // the fake accepts), wait for the REAL snapshot to project it.
        // ABITO_PROBE_VISUAL_DECISION=sent: keep serving the SAME proposal id
        // the lane already selected (sticky), so the fake answers the
        // decision with a real 2xx → the lane's own `Decisión enviada.`
        // (tarjeta-enviada). Default: a different id → 404 → `Sin confirmar`.
        let sent_run = std::env::var("ABITO_PROBE_VISUAL_DECISION").as_deref() == Ok("sent");
        let pending = serde_json::json!({
            "id": format!("proposal_{}", if sent_run { "a" } else { "c" }.repeat(32)),
            "payload_hash": "b".repeat(64),
            "operation": "Prueba M3: propuesta servida por el backend falso",
            "status": "pending",
            "expires_at": "2999-12-31T23:59:59Z",
            "principal": "probe",
            "payload": { "probe": true },
        });
        fake.as_ref().expect("fake").set_proposals(vec![pending]);
        let mut pending_ok = false;
        {
            let deadline = Instant::now() + Duration::from_secs(14);
            while Instant::now() < deadline {
                if card_state(&crate::build_snapshot(app, state.inner())) == "pending" {
                    pending_ok = true;
                    break;
                }
                sleep(Duration::from_millis(100));
            }
        }
        sleep(Duration::from_millis(200));
        capture_visual(app, "overview-tarjeta-pendiente");
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": "tarjeta-pendiente",
            "ok": pending_ok,
        }));

        // tarjeta-resuelta: the human's explicit choice through the SAME
        // dispatch funnel the webview's `allow` verb reaches.
        let outcome =
            crate::dispatch_verb(app, state.inner(), abito_island::bridge::Action::Allow, None);
        let resolved_ok = outcome.is_ok();
        {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let snapshot = crate::build_snapshot(app, state.inner());
                if snapshot["card"]["reason"] == "Decisión enviada." {
                    break;
                }
                sleep(Duration::from_millis(100));
            }
        }
        sleep(Duration::from_millis(200));
        capture_visual(
            app,
            if sent_run {
                "overview-tarjeta-enviada"
            } else {
                "overview-tarjeta-resuelta"
            },
        );
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": if sent_run { "tarjeta-enviada" } else { "tarjeta-resuelta" },
            "dispatched_ok": resolved_ok,
            "error": outcome.as_ref().err().map(|error| serde_json::to_value(error).unwrap_or_default()),
        }));

        // Leave a FRESH pending proposal served so the later
        // approval_evidence step still finds healthy+pending.
        let next = serde_json::json!({
            "id": format!("proposal_{}", "d".repeat(32)),
            "payload_hash": "b".repeat(64),
            "operation": "Prueba M3: propuesta servida por el backend falso",
            "status": "pending",
            "expires_at": "2999-12-31T23:59:59Z",
            "principal": "probe",
            "payload": { "probe": true },
        });
        fake.as_ref().expect("fake").set_proposals(vec![next]);
    }
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, state.inner(), plan);
    wait_for_size(app, compact, Duration::from_secs(3));
    sleep(Duration::from_millis(300));
    emit(&line);
}

/// M3 approval read-back: the lane was started at `setup` against the
/// in-process fake backend (`ABITO_BRIDGE_BASE` override), so this drives
/// the LEGAL gates — expand (legacy requires an open overlay), wait for
/// `healthy` + `pending` — then performs the human's explicit choice
/// through the SAME dispatch funnel the webview's `allow` verb reaches,
/// and reads `card` + `bridgeStatus` back through the REAL snapshot path
/// before and after. The fake's request log proves that NOTHING was
/// written before that click (a notice can never approve) and that
/// `/execute` carried exactly the card's `payload_hash`.
fn approval_evidence(app: &AppHandle) {
    let state = app.state::<AppState>();
    let fake = state.probe_fake.lock().expect("probe fake").clone();
    let mut line = json!({
        "step": "approval_evidence",
        "pointer_input": NO_POINTER,
        "base_origin_env": std::env::var(abito_island::approval::BASE_ENV).ok(),
        "fake_backend_spawned": fake.is_some(),
        "decision": serde_json::Value::Null,
        "error": serde_json::Value::Null,
    });
    let Some(fake) = fake else {
        line["error"] = json!(
            "ABITO_BRIDGE_BASE was set from outside: the probe reads snapshots \
             but NEVER decides against a non-probe backend"
        );
        emit(&line);
        return;
    };
    // Legacy gates for an actionable card: open overlay + visible window.
    let win = main_window(app);
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, &state, plan); // expand
    let mut before = None;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let snapshot = crate::build_snapshot(app, &state);
        if snapshot["bridgeStatus"]["state"] == "healthy"
            && snapshot["card"]["state"] == "pending"
        {
            before = Some(snapshot);
            break;
        }
        sleep(Duration::from_millis(100));
    }
    let Some(before) = before else {
        line["error"] = json!("bridge did not reach healthy+pending within 8s");
        line["last_snapshot"] = crate::build_snapshot(app, &state);
        line["requests"] = json!(fake
            .log()
            .iter()
            .map(|entry| json!({"method": entry.method, "path": entry.path}))
            .collect::<Vec<_>>());
        emit(&line);
        return;
    };
    line["bridge_status_before"] = before["bridgeStatus"].clone();
    line["card_before"] = before["card"].clone();
    let posts_before = fake.posts().len();
    line["posts_before_choice"] = json!(posts_before);
    // The human's explicit choice — the same dispatch funnel the webview's
    // `allow` verb reaches after the IPC gate. The probe is neither a
    // pointer nor the renderer: it drives the host handler
    // programmatically, which is exactly what makes "nothing approves by
    // itself" provable (posts_before_choice must be 0).
    let outcome = crate::dispatch_verb(app, &state, abito_island::bridge::Action::Allow, None);
    line["decision"] = json!({
        "dispatched_ok": outcome.is_ok(),
        "error": outcome.as_ref().err().map(|error| serde_json::to_value(error).unwrap_or_default()),
    });
    let after = crate::build_snapshot(app, &state);
    line["bridge_status_after"] = after["bridgeStatus"].clone();
    line["card_after"] = after["card"].clone();
    let log: Vec<serde_json::Value> = fake
        .log()
        .iter()
        .map(|entry| {
            json!({
                "method": entry.method,
                "path": entry.path,
                "session_cookie": entry.session_cookie,
                "x_sb_request": entry.x_sb_request,
                "payload_hash": entry.payload_hash,
            })
        })
        .collect();
    line["requests"] = json!(log);
    let posts_after = fake.posts();
    line["posts_after_choice"] = json!(posts_after.len());
    let card_hash = "b".repeat(64);
    line["execute_payload_hash_matches_card"] = json!(posts_after.iter().any(|entry| {
        entry.path.ends_with("/execute")
            && entry.payload_hash.as_deref() == Some(card_hash.as_str())
    }));
    // collapse back: the probe leaves the island at rest
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, &state, plan);
    emit(&line);
}

/// Driven inside the webview by the probe (step 7). Every call goes through
/// the real `window.desktop` facade / `desktop_action` command path; the
/// report is typed back through `record_facade_evidence`.
const FACADE_JS: &str = r#"(async () => {
  const ev = { verbs: null, snapshot: null, snapshot_error: null, invalid_call: null,
    expand: null, close: null, state_events: 0, last_event_revision: null, rate: null,
    webview_url: location.href,
    webview_label: (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata
      && window.__TAURI_INTERNALS__.metadata.currentWebview
      && window.__TAURI_INTERNALS__.metadata.currentWebview.label) || null };
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  try {
    ev.verbs = window.desktop ? Object.keys(window.desktop).sort() : null;
    if (window.desktop && typeof window.desktop.onState === 'function') {
      window.desktop.onState(s => { ev.state_events += 1; ev.last_event_revision = s.revision; });
    }
  } catch (e) { ev.verbs_error = String(e); }
  try { ev.snapshot = await window.desktop.snapshot(); } catch (e) { ev.snapshot_error = e; }
  await new Promise(r => setTimeout(r, 150)); // let the onState listener land
  try {
    await invoke('desktop_action', { payload: { action: 'approve-everything' } });
    ev.invalid_call = { rejected: false };
  } catch (e) { ev.invalid_call = { rejected: true, error: e }; }
  try { ev.expand = await window.desktop.expand(); } catch (e) { ev.expand_error = e; }
  await new Promise(r => setTimeout(r, 150));
  try { ev.close = await window.desktop.close(); } catch (e) { ev.close_error = e; }
  // M3: choose is wired — with no standing request it must answer the
  // typed `denied`, not `not-yet-wired` (and it never reaches HTTP).
  try { await window.desktop.choose(0); ev.choose = { rejected: false }; }
  catch (e) { ev.choose = { rejected: true, code: e && e.code, message: e && e.message }; }
  await new Promise(r => setTimeout(r, 1100)); // fresh fixed 1s rate window
  const results = await Promise.all(Array.from({ length: 40 }, () =>
    window.desktop.snapshot().then(() => null, e => e)));
  const rejections = results.filter(r => r !== null);
  ev.rate = { attempts: 40, rejections: rejections.length, first_error: rejections[0] || null };
  try { await invoke('record_facade_evidence', { evidence: ev }); }
  catch (e) { /* probe reports the timeout */ }
})().catch(async e => {
  try {
    const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
      || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
    await invoke('record_facade_evidence', { evidence: { script_error: String(e) } });
  } catch { /* probe reports the timeout */ }
});"#;

/// Wait for the webview to report `n` chat evidence lines.
fn wait_chat_lines(app: &AppHandle, n: usize, timeout: Duration) -> Vec<serde_json::Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let lines = app.state::<AppState>().chat_probe.lock().expect("chat probe lock").clone();
        if lines.len() >= n || Instant::now() >= deadline {
            return lines;
        }
        sleep(Duration::from_millis(100));
    }
}

fn chat_evidence(app: &AppHandle) {
    use abito_island::chatlane::{self, Target};
    use abito_island::fakemodel::{closed_port, FakeModel, FakeModelConfig, Reply};
    use abito_island::localmodel::LocalEndpoint;

    let state = app.state::<AppState>();
    let fake = FakeModel::start(FakeModelConfig {
        reply: Reply::Stream {
            reasoning: true,
            pieces: vec!["Hola, ".into(), "soy Abito ".into(), "(modelo local falso del probe).".into()],
            finish: "stop",
            gap_ms: 60,
        },
        ..Default::default()
    });
    let fake_target = |origin: &str| Target {
        endpoint: LocalEndpoint::parse(origin).expect("loopback origin"),
        alias: "Abito-gpt".into(),
        profile: chatlane::default_target().profile,
        max_output: 128,
    };
    // Probe-only registry: the verified local route is replaced by the
    // in-process fake (same profile id/alias), so the U2 gate admits it and
    // the real router is never contacted by the probe.
    let fake_origin: &'static str = Box::leak(fake.origin().into_boxed_str());
    let original_registry = state.models_registry.lock().expect("models registry lock").clone();
    *state.models_registry.lock().expect("models registry lock") = original_registry
        .iter()
        .map(|e| if e.profile_id == "local-abito-gpt" {
            abito_island::models::Entry { origin: fake_origin, ..*e }
        } else { *e })
        .collect();
    *state.chat_target.lock().expect("chat target lock") = Some(fake_target(&fake.origin()));

    let win = main_window(app);
    let io = TauriIo(&win);
    let scale = io.scale();
    let overview = geometry::scaled_size(geometry::LOGICAL_OVERVIEW, scale);
    let chat_size = geometry::scaled_size(geometry::LOGICAL_CHAT, scale);
    let compact = geometry::scaled_size(geometry::LOGICAL_COMPACT, scale);

    // expand (overview), then the `open` verb of the chat lane
    let area = refresh_work_area(app, &state);
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(400));
    crate::chathost::switch_view(app, &state, true);
    let opened = wait_for_size(app, chat_size, Duration::from_secs(3));
    sleep(Duration::from_millis(900)); // spring settles; availability check lands
    readback(app, "chat_open");
    if !opened {
        emit(&json!({"step": "chat_open", "warning": "window did not reach the chat size within 3s"}));
    }

    if let Err(e) = win.eval(CHAT_JS_SEND) {
        emit(&json!({"step": "chat_evidence", "eval_failed": e.to_string()}));
    }
    let lines = wait_chat_lines(app, 1, Duration::from_secs(20));
    // now an unreachable local target: honest unavailable, no fallback
    let completions_before = fake.completions();
    // the registered local route goes down (registry + target follow it)
    let down_origin: &'static str =
        Box::leak(format!("http://127.0.0.1:{}", closed_port()).into_boxed_str());
    *state.models_registry.lock().expect("models registry lock") = original_registry
        .iter()
        .map(|e| if e.profile_id == "local-abito-gpt" {
            abito_island::models::Entry { origin: down_origin, ..*e }
        } else { *e })
        .collect();
    *state.chat_target.lock().expect("chat target lock") = Some(fake_target(down_origin));
    if let Err(e) = win.eval(CHAT_JS_DOWN) {
        emit(&json!({"step": "chat_evidence", "eval_failed": e.to_string()}));
    }
    let lines = if !lines.is_empty() { wait_chat_lines(app, 2, Duration::from_secs(20)) } else { lines };
    let seen: Vec<_> = fake.seen().iter().map(|s| json!({"method": s.method, "path": s.path})).collect();
    emit(&json!({
        "step": "chat_evidence",
        "pointer_input": "the webview drives the REAL chat_action IPC itself; no pointer events",
        "chat_visible_constant": [geometry::CHAT_VISIBLE.0, geometry::CHAT_VISIBLE.1],
        "chat_native_constant": [geometry::LOGICAL_CHAT.0, geometry::LOGICAL_CHAT.1],
        "fake_local_router": fake.origin(),
        "fake_requests": seen,
        "fake_requests_detail": "the GETs before the POST are the open-chat availability check and the turn preflight; no inference besides the one POST",
        "fake_completions_total": fake.completions(),
        "fake_completions_while_target_down": fake.completions() - completions_before,
        "webview": lines,
        "timed_out": lines.len() < 2,
    }));

    // models step reads the fake router again (registry points at it)
    *state.models_registry.lock().expect("models registry lock") = original_registry
        .iter()
        .map(|e| if e.profile_id == "local-abito-gpt" {
            abito_island::models::Entry { origin: fake_origin, ..*e }
        } else { *e })
        .collect();
    // One source of truth for the port: the target (header/aria) follows the
    // registry the listing is built from again, so both show the SAME origin
    // (the old PNG mixed the dead `down` port with the live fake).
    *state.chat_target.lock().expect("chat target lock") = Some(fake_target(fake_origin));
    let models_seen_before = fake.seen().len();
    // 12. models (U2): the picker panel of the same chat view, driven by the
    //     webview through the REAL models_action IPC. `refresh` reads only
    //     metadata (/health, /v1/models, /props, /slots) from the registry's
    //     selectable LOCAL router — never inference, never a diagnostic port.
    //     The probe keeps the selection in memory (no config file written).
    state.chat_probe.lock().expect("chat probe lock").clear();
    let visual = std::env::var("ABITO_PROBE_VISUAL").as_deref() == Ok("1");
    if visual {
        let _ = win.eval("window.__abitoProbeHold = 3500");
    }
    if let Err(e) = win.eval(MODELS_JS) {
        emit(&json!({"step": "models_evidence", "eval_failed": e.to_string()}));
    }
    if visual {
        sleep(Duration::from_millis(2200)); // panel open + listing rendered, before JS closes it
        capture_visual(app, "modelos-elegido");
    }
    let lines = wait_chat_lines(app, 1, Duration::from_secs(20));
    emit(&json!({
        "step": "models_evidence",
        "pointer_input": "the webview drives the REAL models_action IPC itself; no pointer events",
        "persisted_config_dir": crate::modelshost::config_dir(app).map(|d| d.display().to_string()),
        "fake_requests_during_models": fake.seen()[models_seen_before..]
            .iter().map(|s| format!("{} {}", s.method, s.path)).collect::<Vec<_>>(),
        "fake_completions_total": fake.completions(),
        "webview": lines,
        "timed_out": lines.is_empty(),
    }));

    // back to the overview (same window shrinks to 672x176), then collapse
    crate::chathost::switch_view(app, &state, false);
    let back = wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(app, "chat_back_to_overview");
    if !back {
        emit(&json!({"step": "chat_back_to_overview", "warning": "did not return to the overview size within 3s"}));
    }
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, compact, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(app, "chat_collapse");
    // restore the production target for the (exiting) process
    *state.models_registry.lock().expect("models registry lock") = original_registry;
    *state.chat_target.lock().expect("chat target lock") = Some(chatlane::default_target());
    fake.shutdown();
}

/// Webview side of the chat step, phase 1: measure the visible chat and its
/// controls, submit one message through `chat_action`, read the view until
/// the turn ends, and report.
const CHAT_JS_SEND: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const rect = id => { const el = document.getElementById(id); if (!el) return null;
    const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const ev = { phase: 'send' };
  try {
    const island = document.getElementById('island').getBoundingClientRect();
    ev.island_visible = [Math.round(island.width), Math.round(island.height)];
    ev.island_radius = getComputedStyle(document.getElementById('island')).borderTopLeftRadius;
    ev.view_attr = document.getElementById('capsule').dataset.view;
    ev.chat_hidden = document.getElementById('chat').hidden;
    ev.controls = { back: rect('chat-back'), send: rect('chat-send'), input: rect('chat-input') };
    ev.reduced_motion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    ev.audio_elements = document.querySelectorAll('audio, video').length;
    ev.focus_in_composer_before_typing = document.activeElement === document.getElementById('chat-input');
    const before = await invoke('chat_action', { payload: { action: 'view' } });
    ev.availability_before = before.availability;
    ev.target = before.target;
    ev.producer = before.producer;
    try { await invoke('chat_action', { payload: { action: 'submit', text: 'hola', client_request_id: 'req-probe-0001', model: 'gpt-4' } });
      ev.smuggled_model_rejected = false; } catch (e) { ev.smuggled_model_rejected = e && e.code; }
    ev.accepted = await invoke('chat_action', { payload: { action: 'submit', text: '¿Quién sos?', client_request_id: 'req-probe-0001' } });
    ev.duplicate = await invoke('chat_action', { payload: { action: 'submit', text: '¿Quién sos?', client_request_id: 'req-probe-0001' } });
    const states = [];
    let last = null;
    for (let i = 0; i < 150; i++) {
      last = await invoke('chat_action', { payload: { action: 'view' } });
      const t = last.turns[last.turns.length - 1];
      if (t && states[states.length - 1] !== t.state) states.push(t.state);
      if (t && ['completed', 'error', 'cancelled'].includes(t.state)) break;
      await new Promise(r => setTimeout(r, 40));
    }
    await new Promise(r => setTimeout(r, 200));
    const turn = last.turns[last.turns.length - 1];
    ev.observed_states = states;
    ev.final = { state: turn.state, reply: turn.reply, finish_reason: turn.finish_reason, error: turn.error };
    ev.log_text = document.getElementById('chat-log').textContent;
    ev.status_text = document.getElementById('chat-status').textContent;
    ev.live_text = document.getElementById('chat-live').textContent;
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

/// Phase 2: the local target is unreachable — `check` must say so, Send must
/// be disabled, and a submit must end `local_model_unavailable`.
const CHAT_JS_DOWN: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const ev = { phase: 'target_down' };
  try {
    const checked = await invoke('chat_action', { payload: { action: 'check' } });
    ev.availability = checked.availability;
    await new Promise(r => setTimeout(r, 200));
    const input = document.getElementById('chat-input');
    input.value = 'hola';
    input.dispatchEvent(new Event('input'));
    ev.send_disabled_with_draft = document.getElementById('chat-send').disabled;
    ev.status_text = document.getElementById('chat-status').textContent;
    await invoke('chat_action', { payload: { action: 'submit', text: 'hola', client_request_id: 'req-probe-0002' } });
    let last = null;
    for (let i = 0; i < 100; i++) {
      last = await invoke('chat_action', { payload: { action: 'view' } });
      const t = last.turns[last.turns.length - 1];
      if (t && ['completed', 'error', 'cancelled'].includes(t.state)) break;
      await new Promise(r => setTimeout(r, 40));
    }
    const t = last.turns[last.turns.length - 1];
    ev.final = { state: t.state, reply: t.reply, error: t.error };
    input.value = '';
    input.dispatchEvent(new Event('input'));
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

/// Webview side of the models step.
const MODELS_JS: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const ev = { phase: 'models' };
  const code = async payload => { try { await invoke('models_action', { payload }); return 'accepted'; }
    catch (e) { return e && e.code; } };
  try {
    document.getElementById('chat-models').click();
    let listing = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100));
      listing = await invoke('models_action', { payload: { action: 'list' } });
      if (listing.revision > 0) break;
    }
    await new Promise(r => setTimeout(r, 200));
    // Visual evidence only (opt-in): hold the panel open while Rust grabs it.
    if (window.__abitoProbeHold) await new Promise(r => setTimeout(r, window.__abitoProbeHold));
    ev.panel_visible = !document.getElementById('models').hidden;
    ev.transcript_hidden = getComputedStyle(document.getElementById('chat-body')).display === 'none';
    ev.choice_note = listing.choice_note;
    ev.remote = listing.remote;
    ev.resources_text = listing.resources_text;
    ev.selected = listing.selected;
    ev.profiles = listing.profiles.map(p => ({ profile_id: p.profile_id, origin: p.origin, alias: p.alias,
      selectable: p.selectable, gate: p.gate, context_tokens: p.context_tokens,
      max_output_tokens: p.max_output_tokens, size_bytes: p.size_bytes, vision: p.vision }));
    ev.rendered_rows = Array.from(document.querySelectorAll('#models-list li')).map(li => ({
      text: li.querySelector('.model-text').textContent,
      button: li.querySelector('button').textContent,
      disabled: li.querySelector('button').disabled,
      size: [Math.round(li.querySelector('button').getBoundingClientRect().width),
             Math.round(li.querySelector('button').getBoundingClientRect().height)] }));
    ev.select_diagnostic = await code({ action: 'select', profile_id: 'diag-11014' });
    ev.select_unknown = await code({ action: 'select', profile_id: 'cloud-gpt' });
    ev.smuggled_origin = await code({ action: 'select', profile_id: 'local-abito-gpt', origin: 'http://api.openai.com:80' });
    ev.set_key = await code({ action: 'set_key', key: 'sk-test' });
    const chosen = await invoke('models_action', { payload: { action: 'select', profile_id: 'local-abito-gpt' } });
    ev.selected_after = chosen.selected;
    ev.persisted_after = chosen.persisted;
    const chat = await invoke('chat_action', { payload: { action: 'view' } });
    ev.chat_target_after = chat.target;
    document.getElementById('models-close').click();
    ev.panel_closed = document.getElementById('models').hidden;
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

fn a11y_evidence(app: &AppHandle) {
    let state = app.state::<AppState>();
    let win = main_window(app);
    let focused_at_start = win.is_focused().ok();
    crate::restore(app); // the second-instance path, minus the process
    sleep(Duration::from_millis(400));
    let focused_after_restore = win.is_focused().ok();
    let io = TauriIo(&win);
    let area = refresh_work_area(app, &state);
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    let scale = io.scale();
    wait_for_size(app, geometry::scaled_size(geometry::LOGICAL_OVERVIEW, scale), Duration::from_secs(3));
    sleep(Duration::from_millis(900));
    state.chat_probe.lock().expect("chat probe lock").clear();
    if let Err(e) = win.eval(A11Y_JS) {
        emit(&json!({"step": "a11y_evidence", "eval_failed": e.to_string()}));
    }
    let lines = wait_chat_lines(app, 1, Duration::from_secs(10));
    state.chat_probe.lock().expect("chat probe lock").clear();
    let focused_after_expand = win.is_focused().ok();
    emit(&json!({
        "step": "a11y_evidence",
        "window_focused_at_start": focused_at_start,
        "window_focused_after_restore": focused_after_restore,
        "window_focused_after_expand": focused_after_expand,
        "focus_note": "tauri.conf focus:false; restore() shows without set_focus; only `--chat` focuses",
        "webview": lines,
        "timed_out": lines.is_empty(),
    }));
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, geometry::scaled_size(geometry::LOGICAL_COMPACT, scale), Duration::from_secs(3));
    sleep(Duration::from_millis(200));
}

const A11Y_JS: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const size = el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
  const ev = { phase: 'a11y' };
  for (let i = 0; i < 40 && document.getElementById('capsule').dataset.phase !== 'expanded'; i++)
    await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 250)); // opacity transition
  try {
    ev.view = document.getElementById('capsule').dataset.view;
    ev.phase_attr = document.getElementById('capsule').dataset.phase;
    const visible = Array.from(document.querySelectorAll('button')).filter(b => {
      const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
      return !b.hidden && cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 1 && r.height > 1 &&
        !b.closest('[hidden]') && getComputedStyle(b.closest('section, div, main')).visibility !== 'hidden';
    });
    ev.visible_buttons = visible.map(b => ({ id: b.id, text: b.textContent, size: size(b) }));
    ev.all_visible_at_least_44 = visible.every(b => { const [w, h] = size(b); return w >= 44 && h >= 44; });
    ev.open_chat = { size: size(document.getElementById('open-chat')), rect: rect(document.getElementById('open-chat')) };
    ev.notices_rect = rect(document.getElementById('notices'));
    ev.permission_rect = rect(document.getElementById('permission'));
    ev.dismiss_size = size(document.getElementById('notice-dismiss'));
    ev.notice_live = { role: document.getElementById('notice-live').getAttribute('role'),
      aria_live: document.getElementById('notice-live').getAttribute('aria-live'),
      text: document.getElementById('notice-live').textContent };
    ev.island_toggle = { text: document.getElementById('island-toggle').textContent,
      aria_expanded: document.getElementById('island-toggle').getAttribute('aria-expanded') };
    ev.active_element = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null;
    ev.document_has_focus = document.hasFocus();
    ev.audio_elements = document.querySelectorAll('audio, video').length;
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

/// `YYYYMMDD-HHMMSS` stamp (UTC) for visual filenames — no chrono
/// dependency: civil-from-days (Howard Hinnant's algorithm) on top of
/// `SystemTime`.
fn visual_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let (y, m) = if m <= 2 { (y + 1, m) } else { (y, m) };
    let sod = secs.rem_euclid(86_400);
    let (h, rem) = (sod / 3600, sod % 3600);
    let (mnt, sec) = (rem / 60, rem % 60);
    format!("{y:04}{m:02}{d:02}-{h:02}{mnt:02}{sec:02}")
}

/// Opt-in visual evidence (`ABITO_PROBE_VISUAL=1` + `ABITO_SOCKET_DIR`):
/// one PNG of OUR window only. ffmpeg `x11grab -window_id <wid>` reads the
/// island window's own drawable (found by `_NET_WM_PID`, FIX-B) — never the
/// root window, the desktop or another client; no pointer drawn; one frame.
/// Files: `<ABITO_SOCKET_DIR>/visual/<name>-<YYYYMMDD-HHMMSS>.png`
/// (gitignored `.runtime*`).
///
/// Known-background contract (UI.1 review): during the grab ONLY, the body
/// gets a solid sand class (`probe-capture-bg`, declared in style.css) so
/// radius, margins and the island contour are visible in the PNG; the class
/// is removed right after and production rendering never carries it.
fn capture_visual(app: &AppHandle, name: &str) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let Some(root) = std::env::var_os("ABITO_SOCKET_DIR") else {
        emit(
            &json!({"step": "visual", "name": name, "error": "ABITO_SOCKET_DIR unset: nowhere private to write"}),
        );
        return;
    };
    let _ = app;
    let page = main_window(app); // WebviewWindow, for the body class only
    let win = match abito_island::workarea::x11_find_own_window("Abito") {
        Ok(w) => w,
        Err(e) => {
            emit(&json!({"step": "visual", "name": name, "error": e.as_str()}));
            return;
        }
    };
    // Optional private output dir (UI.1 evidence); default stays `<root>/visual`.
    let dir = match std::env::var_os("ABITO_PROBE_VISUAL_DIR") {
        Some(custom) => std::path::PathBuf::from(custom),
        None => std::path::Path::new(&root).join("visual"),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        emit(&json!({"step": "visual", "name": name, "error": e.to_string()}));
        return;
    }
    let out = dir.join(format!("{name}-{}.png", visual_stamp()));
    // Known background behind the island for THIS frame only: probe-only
    // body class (declared in style.css), never present in production.
    let _ = page.eval("document.body.classList.add('probe-capture-bg')");
    sleep(Duration::from_millis(250)); // repaint before the grab
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "x11grab",
            "-draw_mouse",
            "0",
        ])
        .args(["-window_id", &win.id.to_string()])
        .args(["-i", &display, "-frames:v", "1"])
        .arg(&out)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .output();
    let (ok, stderr) = match status {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
        ),
        Err(e) => (false, e.to_string()),
    };
    let _ = page.eval("document.body.classList.remove('probe-capture-bg')");
    sleep(Duration::from_millis(150)); // repaint back to production look
    emit(&json!({
        "step": "visual",
        "name": name,
        "ok": ok,
        "path": out.display().to_string(),
        "window_id": format!("0x{:x}", win.id),
        "window_geometry": [win.x, win.y, win.w, win.h],
        "source": "x11grab -window_id (own window drawable only, matched by _NET_WM_PID)",
        "error": (!stderr.is_empty()).then_some(stderr),
    }));
}
