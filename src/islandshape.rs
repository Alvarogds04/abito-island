//! Closed input-shape reports for the fixed island window.
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Report { pub w: i32, pub h: i32, pub settled: bool }

pub(crate) fn parse(payload: &Value) -> Option<Report> {
    let object = payload.as_object()?;
    if object.len() != 3 { return None; }
    Some(Report {
        w: i32::try_from(object.get("w")?.as_i64()?).ok()?,
        h: i32::try_from(object.get("h")?.as_i64()?).ok()?,
        settled: object.get("settled")?.as_bool()?,
    })
}

/// `{"h": <integer>}` and nothing else: the page asks for a height, Rust decides the size (geometry::clamp_window_height).
pub(crate) fn parse_window_height(payload: &Value) -> Option<i32> {
    let object = payload.as_object()?;
    if object.len() != 1 { return None; }
    i32::try_from(object.get("h")?.as_i64()?).ok()
}

// Only the compact strip may be shorter than the normal compact bar.
fn input_rect(report: Report, window: (i32, i32), protected: bool) -> (i32,i32,i32,i32) {
    // The hidden strip (S1): only the compact pill's two widths, 288 or 440 (session rows / a pending ask), can be one.
    if !protected && abito_island::geometry::COMPACT_WIDTHS.contains(&report.w) && (4..32).contains(&report.h) && report.settled {
        let w = report.w.min(window.0.max(0));
        return ((window.0-w)/2, 0, w, report.h.min(window.1.max(0)));
    }
    abito_island::geometry::island_shape_rect((report.w,report.h), window)
}

#[cfg(unix)]
static SHAPE: std::sync::Mutex<((i32, i32), Report)> = std::sync::Mutex::new(
    ((288, 32), Report { w: 288, h: 32, settled: true }));

/// GDK consumes logical pixels and must only be called on GTK's event thread.
/// An idle follows nativewindow's queued size request; realize before obtaining GdkWindow.
#[cfg(unix)]
pub(crate) fn apply(app: &tauri::AppHandle, report: Option<Report>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        gtk::glib::idle_add_local_once(move || {
            use gtk::prelude::*;
            use tauri::Manager;
            use abito_island::geometry;
            let Some(win) = crate::main_window(&handle) else { return };
            let Ok(gtk_win) = win.gtk_window() else { return };
            gtk_win.realize();
            let Some(gdk) = gtk_win.window() else { return };
            let window = gtk_win.size();
            let mut state = SHAPE.lock().expect("island shape lock");
            if let Some(report) = report { state.1 = report; }
            let report = state.1;
            let destination = geometry::clamp_island_shape(report.w, report.h, window);
            let shape = if report.settled {
                state.0 = destination;
                destination
            } else { geometry::transition_shape(state.0, destination, window) };
            let state = handle.state::<crate::AppState>();
            let snap = crate::build_snapshot(&handle, &state);
            let question = crate::questionhost::question_view(&state);
            let protected = !snap["request"].is_null() || snap["card"]["state"] == "pending" || !question["pending"].is_null();
            let (x, y, w, h) = input_rect(if report.settled { report } else { Report { w:shape.0,h:shape.1,settled:false } }, window, protected);
            let region = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(x, y, w, h));
            gdk.input_shape_combine_region(&region, 0, 0);
        });
    });
}

#[cfg(not(unix))]
pub(crate) fn apply(_app: &tauri::AppHandle, _report: Option<Report>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn window_height_payload_is_exactly_one_integer_named_h() {
        assert_eq!(parse_window_height(&json!({"h":600})), Some(600));
        assert_eq!(parse_window_height(&json!({"h":-5})), Some(-5), "Rust clamps; the parser only checks the shape");
        for bad in [json!(null), json!({}), json!(600), json!({"h":600.5}), json!({"h":"600"}), json!({"h":null}),
            json!({"h":600,"w":672}), json!({"height":600}), json!({"h":2147483648_i64}), json!([600])] {
            assert_eq!(parse_window_height(&bad), None, "{bad}");
        }
    }
    #[test]
    fn reports_are_exactly_two_integers_and_a_boolean() {
        assert_eq!(parse(&json!({"w":640,"h":160,"settled":false})), Some(Report { w:640,h:160,settled:false }));
        assert_eq!(parse(&json!({"w":-1,"h":i32::MAX,"settled":true})), Some(Report { w:-1,h:i32::MAX,settled:true }));
        for bad in [json!(null), json!({}), json!({"w":640,"h":160}),
            json!({"w":640.5,"h":160,"settled":true}), json!({"w":640,"h":"160","settled":true}),
            json!({"w":640,"h":160,"settled":1}), json!({"w":640,"h":160,"settled":true,"x":0}),
            json!({"w":2147483648_i64,"h":160,"settled":true})] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }
}

#[cfg(test)]
#[test]
fn edge_input_tracks_four_pixel_strip_and_protected_cards_refuse_it() {
    let strip = Report { w:288, h:4, settled:true };
    assert_eq!(input_rect(strip, (752,340), false), (232,0,288,4));
    assert_eq!(input_rect(strip, (752,340), true), (232,0,288,32));
    assert_eq!(input_rect(Report {h:-1,..strip}, (752,340), false), (232,0,288,32));
}

#[cfg(test)]
#[test]
fn the_hidden_strip_input_zone_is_the_drawn_8px_at_every_compact_width_and_never_wider_than_the_pill() {
    // S1: the hidden strip is 24 px up, leaving an 8 px activation zone. The pill is 288 wide, or 440 once there are session rows or a
    // pending ask (COMPACT_WIDE), or 560 for the «Responder» pill (COMPACT_ASK), so the zone must be 8 px tall at BOTH widths (it used to be 32 at 440).
    for w in abito_island::geometry::COMPACT_WIDTHS {
        let strip = Report { w, h: 8, settled: true };
        let (x, y, rw, rh) = input_rect(strip, (752, 340), false);
        assert_eq!((rw, rh), (w, 8), "zone {w} wide, 8 px tall");
        assert_eq!((x, y), ((752 - w) / 2, 0), "centred, at the very top");
        assert_eq!(input_rect(strip, (752, 340), true), (x, 0, w, 32), "a protected ask refuses the thin strip at {w} too");
        assert_eq!(input_rect(Report { settled: false, ..strip }, (752, 340), false).3, 32, "moving: never the thin zone");
    }
    // a pill or card that is NOT a strip keeps today's rule
    assert_eq!(input_rect(Report { w: 440, h: 32, settled: true }, (752, 340), false), (156, 0, 440, 32));
    assert_eq!(input_rect(Report { w: 560, h: 8, settled: true }, (752, 340), false), (96, 0, 560, 8), "the ask pill is a strip too (hidden)");
    assert_eq!(input_rect(Report { w: 560, h: 8, settled: true }, (752, 340), true), (96, 0, 560, 32), "but with a protected ask pending it refuses the thin zone");
    assert_eq!(input_rect(Report { w: 720, h: 8, settled: true }, (752, 340), false).3, 32, "only compact widths can be a strip");
    assert_eq!(input_rect(Report { w: 300, h: 8, settled: true }, (752, 340), false).3, 32, "an unknown width is not a strip");
}

#[cfg(test)]
#[test]
fn the_input_region_covers_exactly_what_is_drawn_for_every_native_size_of_the_island() {
    // The island's full size list (logical px, inside the fixed 752x340 window): compact pill 288/440/560 x 32; hidden strip: same
    // widths x 8; expanded 720x184, 720x220 with the «terminó»/problem band; question 224; recap 208; chat 720 x 240..300.
    let window = (752, 340);
    let centred = |w: i32| (window.0 - w) / 2;
    for w in abito_island::geometry::COMPACT_WIDTHS {
        assert_eq!(input_rect(Report { w, h: 32, settled: true }, window, false), (centred(w), 0, w, 32), "compact {w}x32");
        assert_eq!(input_rect(Report { w, h: 8, settled: true }, window, false), (centred(w), 0, w, 8), "hidden strip {w}x8");
        // a click just BELOW the drawn strip (y = 8) is outside the region, so it passes through to the app underneath
        let (_, y, _, h) = input_rect(Report { w, h: 8, settled: true }, window, false);
        assert!(8 >= y + h, "y=8 is below the {w} strip's zone");
    }
    for (w, h) in [(720, 184), (720, 220), (720, 224), (720, 208), (720, 240), (720, 270), (720, 300)] {
        assert_eq!(input_rect(Report { w, h, settled: true }, window, false), (centred(w), 0, w, h), "expanded {w}x{h} is fully clickable and nothing more");
        assert_eq!(input_rect(Report { w, h, settled: true }, window, true), (centred(w), 0, w, h), "a protected ask changes nothing for a drawn card");
    }
    // whatever the page reports is clamped into the window: never an input region bigger than the native window
    assert_eq!(input_rect(Report { w: 10_000, h: 10_000, settled: true }, window, false), (0, 0, 752, 340));
    // placement: the logical window is 752x340 at every scale, the input region is in LOGICAL px (GDK scales it with the window)
    for (scale, monitor_w) in [(1.0, 1920), (2.0, 3072), (2.0, 3840)] {
        let monitor = abito_island::geometry::Rect { x: 0, y: 0, w: monitor_w, h: monitor_w * 9 / 16 };
        let r = abito_island::geometry::island_window_rect_for(Some(monitor), monitor, scale, 340).unwrap();
        assert_eq!((r.w as f64 / scale, r.h as f64 / scale), (752.0, 340.0), "scale {scale}");
        assert_eq!(r.x + r.w / 2, monitor_w / 2, "centred at scale {scale}");
    }
}
