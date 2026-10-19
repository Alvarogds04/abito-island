//! Desktop character window (#486, NotchBuddy feature 1).
//!
//! Adapted from Coucou windows/src-tauri/src/desktop.rs @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
//! The character lives in its own transparent, undecorated, always-on-top window (the island
//! already runs as an XWayland window, so this one is placed with `set_outer_position`).
//! Rust owns where it is; the page only draws Abito's clay character and forwards the pointer.
//! Closed commands: no label, URL or size ever comes from a page.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use abito_island::characterwin::{self as cw, Display, Rect};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
struct Inner {
    /// Top-left of the window, physical px.
    pos: (f64, f64),
    /// Pointer (screen css px) and window origin (physical) at the press of a drag.
    drag: Option<((f64, f64), (f64, f64))>,
}

#[derive(Default)]
pub struct Character {
    inner: Mutex<Inner>,
    /// Bumped by every flight: an older one still running stops moving the window.
    flight: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    mode: &'static str,
    on_desktop: bool,
}

#[derive(Serialize, Clone)]
struct Dropped {
    from: &'static str,
    home: bool,
}

pub fn manage(app: &AppHandle) {
    app.manage(Arc::new(Character::default()));
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(cw::LABEL)
}

fn ensure_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = window(app) {
        return Some(w);
    }
    WebviewWindowBuilder::new(app, cw::LABEL, WebviewUrl::App(cw::PAGE.into()))
        .title("Abito")
        .inner_size(cw::SIZE, cw::SIZE)
        // GTK will not size a non-resizable window below its natural size.
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .focusable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(false)
        .build()
        .map_err(|e| eprintln!("desktop character window failed: {e}"))
        .ok()
}

fn displays(app: &AppHandle) -> Vec<Display> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let (p, s, wa) = (m.position(), m.size(), m.work_area());
            Display {
                frame: Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 },
                work: Rect {
                    x: wa.position.x as f64,
                    y: wa.position.y as f64,
                    w: wa.size.width as f64,
                    h: wa.size.height as f64,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// The island window's rectangle and its scale, physical px.
fn island_rect(app: &AppHandle) -> Option<(Rect, f64)> {
    let win = app.get_webview_window("main")?;
    let (p, s) = (win.outer_position().ok()?, win.outer_size().ok()?);
    let rect = Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 };
    Some((rect, win.scale_factor().unwrap_or(1.0)))
}

fn island_origin(app: &AppHandle) -> Option<(f64, f64)> {
    let (r, scale) = island_rect(app)?;
    Some(cw::island_spot(r.x + r.w / 2.0, r.y, cw::SIZE, scale))
}

fn place(win: &WebviewWindow, c: &Character, pos: (f64, f64)) {
    c.inner.lock().unwrap().pos = pos;
    let _ = win.set_position(PhysicalPosition::new(pos.0.round() as i32, pos.1.round() as i32));
}

/// Moves the window from `from` to `to` over `ms`; false when a newer flight took over.
async fn fly(win: &WebviewWindow, c: &Character, from: (f64, f64), to: (f64, f64), ms: u64, ease: fn(f64) -> f64) -> bool {
    let id = c.flight.fetch_add(1, Ordering::SeqCst) + 1;
    let steps = (ms / cw::TICK_MS).max(1);
    for i in 1..=steps {
        if c.flight.load(Ordering::SeqCst) != id {
            return false;
        }
        place(win, c, cw::lerp(from, to, ease(i as f64 / steps as f64)));
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(cw::TICK_MS))).await;
    }
    c.flight.load(Ordering::SeqCst) == id
}

fn remember(app: &AppHandle, on: bool, spot: Option<(f64, f64)>) {
    crate::settingshost::save_desktop_character(app, on, spot.map(cw::spot_to_pref));
}

/// Where the character settles when it flies out: its saved spot if a display still holds it;
/// otherwise the first-visit corner when `anywhere`, else nowhere (it stays in the island).
fn target_spot(app: &AppHandle, anywhere: bool) -> Option<(f64, f64)> {
    let d = displays(app);
    let saved = crate::settingshost::desktop_character(app).and_then(|c| c.spot).map(cw::pref_to_spot);
    if let Some(spot) = saved {
        if let Some(p) = cw::restore_spot(spot, &d, cw::SIZE, cw::MARGIN) {
            return Some(p);
        }
    }
    if saved.is_some() && !anywhere {
        return None;
    }
    let (r, _) = island_rect(app)?;
    let near = d.iter().find(|x| x.frame.contains(r.center())).or(d.first())?;
    Some(cw::default_spot(near, cw::SIZE, cw::MARGIN))
}

#[tauri::command]
pub fn character_info(webview: tauri::Webview, app: AppHandle) -> Option<Info> {
    crate::settingswindow::main_window_only(webview.label()).ok()?;
    let on = crate::settingshost::desktop_character(&app).is_some_and(|c| c.on);
    Some(Info { mode: "window", on_desktop: on })
}

/// Island → desktop: shows the window under the island and flies it to its spot.
#[tauri::command]
pub async fn character_fly_out(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, anywhere: Option<bool>) -> Result<bool, ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    Ok(fly_out(&app, &c, anywhere.unwrap_or(false)).await)
}

async fn fly_out(app: &AppHandle, c: &Character, anywhere: bool) -> bool {
    let (Some(to), Some(from)) = (target_spot(app, anywhere), island_origin(app)) else { return false };
    let Some(win) = ensure_window(app) else { return false };
    place(&win, c, from);
    let _ = win.show();
    if fly(&win, c, from, to, cw::FLIGHT_MS, cw::ease_in_out).await {
        remember(app, true, Some(to));
    }
    true
}

/// Launch: the character goes back to its spot if that is where it lived (Coucou `launchFlyIfNeeded`).
pub fn restore_on_launch(app: &AppHandle) {
    if !crate::settingshost::desktop_character(app).is_some_and(|c| c.on) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let c = app.state::<Arc<Character>>().inner().clone();
        // The island must be placed first; a spot on a display that is gone leaves it home.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if !fly_out(&app, &c, false).await {
            remember(&app, false, None);
        }
    });
}

/// Desktop → island: flies back under the island and hides. `forget` = it lives in the island again.
#[tauri::command]
pub async fn character_fly_home(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, forget: bool) -> Result<bool, ()> {
    crate::settingswindow::main_window_only(webview.label()).map_err(|_| ())?;
    Ok(go_home(&app, &c, forget).await)
}

async fn go_home(app: &AppHandle, c: &Character, forget: bool) -> bool {
    let Some(win) = window(app) else { return true };
    if let Some(to) = island_origin(app) {
        let from = c.inner.lock().unwrap().pos;
        fly(&win, c, from, to, cw::FLIGHT_MS, cw::ease_in_out).await;
    }
    let _ = win.hide();
    if forget {
        remember(app, false, None);
    }
    true
}

// ---- drag, from the character's own page ----

fn from_character(webview: &tauri::Webview) -> bool {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    cw::character_sender_ok(webview.label(), &url).is_ok()
}

#[tauri::command]
pub fn character_drag_begin(webview: tauri::Webview, c: State<'_, Arc<Character>>, x: f64, y: f64) -> bool {
    let (true, Some(press)) = (from_character(&webview), cw::valid_point(x, y)) else { return false };
    c.flight.fetch_add(1, Ordering::SeqCst);
    let mut inner = c.inner.lock().unwrap();
    let origin = inner.pos;
    inner.drag = Some((press, origin));
    true
}

#[tauri::command]
pub fn character_drag_move(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>, x: f64, y: f64) {
    let (true, Some(now)) = (from_character(&webview), cw::valid_point(x, y)) else { return };
    let (Some(win), Some((press, origin))) = (window(&app), c.inner.lock().unwrap().drag) else { return };
    let dpr = win.scale_factor().unwrap_or(1.0);
    place(&win, &c, cw::drag_top_left(origin, now, press, dpr));
}

/// The button went up: dropped on the island = home; anywhere else it settles inside a work area.
#[tauri::command]
pub async fn character_drag_end(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>) -> Result<(), ()> {
    if !from_character(&webview) {
        return Err(());
    }
    let (Some(win), true) = (window(&app), c.inner.lock().unwrap().drag.take().is_some()) else { return Ok(()) };
    let pos = c.inner.lock().unwrap().pos;
    let centre = (pos.0 + cw::SIZE * win.scale_factor().unwrap_or(1.0) / 2.0, pos.1 + cw::SIZE * win.scale_factor().unwrap_or(1.0) / 2.0);
    if island_rect(&app).is_some_and(|(r, _)| cw::is_home_drop(centre, r)) {
        let _ = app.emit_to("main", "desktop-character-dropped", Dropped { from: "desktop", home: true });
        go_home(&app, &c, true).await;
        return Ok(());
    }
    let to = cw::settle(pos, &displays(&app), cw::SIZE, cw::MARGIN);
    if fly(&win, &c, pos, to, cw::SNAP_MS, cw::ease_out_back).await {
        remember(&app, true, Some(to));
    }
    Ok(())
}

/// Double click on the character: home for good.
#[tauri::command]
pub async fn character_home(webview: tauri::Webview, app: AppHandle, c: State<'_, Arc<Character>>) -> Result<(), ()> {
    if !from_character(&webview) {
        return Err(());
    }
    let _ = app.emit_to("main", "desktop-character-dropped", Dropped { from: "desktop", home: true });
    go_home(&app, &c, true).await;
    Ok(())
}
