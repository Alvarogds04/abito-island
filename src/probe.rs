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
    let x11win = abito_island::workarea::x11_find_window_by_title("Abito");
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
        "sequence": ["start", "simulated_drag_near_bottom", "release_snap_bottom", "expand", "collapse", "drag_to_top_snap", "facade_evidence", "frontend_evidence"],
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
    emit(&json!({
        "step": "facade_evidence",
        "expected_verbs": expected_json,
        "verbs_match_preload": observed_verbs.as_ref() == Some(&expected_json),
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
            let snapshot = crate::build_snapshot(&state);
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
            crate::build_snapshot(app.state::<AppState>().inner())
                .get("notices")
                .and_then(serde_json::Value::as_array)
                .map(|notices| notices.len())
                .unwrap_or(0)
        };
        let before = count_notices(app);
        let outcome = crate::dispatch_verb(app, &state, abito_island::bridge::Action::Dismiss);
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
