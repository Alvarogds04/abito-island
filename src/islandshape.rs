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
            use abito_island::geometry;
            let win = crate::main_window(&handle);
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
            let (x, y, w, h) = geometry::island_shape_rect(shape, window);
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
