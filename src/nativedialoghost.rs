//! #387 host: the gated `native_dialog_action` command plus the real
//! presenters. GTK is touched ONLY on the main thread (`run_on_main_thread`,
//! the nativeaudit.rs pattern) and the command never blocks the IPC caller
//! past the dialog timeout: the worker waits bounded and the modal itself is
//! closed by the same timeout.
//!
//! NOTHING calls this command yet — there is no computer-control or
//! connector producer of approval requests at the moment, so the command is
//! dormant until its callers land. No caller is invented here.
use crate::{main_window, now_ms, AppState};
use abito_island::bridge;
use abito_island::nativedialog::{
    decision_json, decide, parse_request, Decision, DialogRequest, Presenter, PresenterOutcome,
    ValidatedDialog,
};
use serde_json::Value;
use std::sync::mpsc;
use std::time::Duration;

fn error(code: &str) -> crate::bridge::BridgeError {
    crate::bridge::BridgeError {
        code: code.into(),
        message: "No se pudo mostrar el diálogo de aprobación.".into(),
    }
}

/// Sender gate → rate limit → closed parse → injected presenter → closed
/// decision. The decision path (parse/validate/present mapping) is unit
/// tested in `nativedialog.rs`; this wrapper only gates and marshals.
#[tauri::command]
pub async fn native_dialog_action(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    payload: Value,
) -> Result<Value, crate::bridge::BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state
        .rate
        .lock()
        .expect("rate lock")
        .check(now_ms())?;
    let request = parse_request(&payload).map_err(|()| error("invalid_request"))?;
    let presenter = platform_presenter(app);
    // Bounded: the presenter answers within the dialog timeout (it closes
    // itself), so this never blocks the IPC thread forever.
    let decision = tauri::async_runtime::spawn_blocking(move || decide(&request, presenter.as_ref()))
        .await
        .map_err(|_| error("dialog_aborted"))?;
    Ok(decision_json(&decision))
}

/// Linux first: the GTK presenter built on what is already compiled in
/// (tauri's own gtk/glib). Everywhere else an honest stub that reports
/// NoDisplay — absent display = safe deny, never a silent approval.
pub fn platform_presenter(app: tauri::AppHandle) -> Box<dyn Presenter> {
    #[cfg(target_os = "linux")]
    {
        Box::new(GtkPresenter { app })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Box::new(UnavailablePresenter)
    }
}

#[cfg(target_os = "linux")]
struct GtkPresenter {
    app: tauri::AppHandle,
}

#[cfg(target_os = "linux")]
impl Presenter for GtkPresenter {
    fn present(&self, dialog: &ValidatedDialog, timeout_ms: u64) -> PresenterOutcome {
        let (tx, rx) = mpsc::channel();
        let app = self.app.clone();
        let title = dialog.title().to_owned();
        // Fixed prompt line + bounded caller body; plain text only.
        let text = format!("{}\n\n{}", dialog.kind().prompt_line(), dialog.body());
        let dispatched = self.app.run_on_main_thread(move || {
            show_modal(&app, &title, &text, timeout_ms, tx);
        });
        if dispatched.is_err() {
            return PresenterOutcome::NoDisplay; // no main thread / no app → deny
        }
        // GTK owns the main thread; the worker waits bounded. The modal is
        // closed by the same timeout, so this bound is never a hang.
        match rx.recv_timeout(Duration::from_millis(timeout_ms.saturating_add(2_000))) {
            Ok(outcome) => outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => PresenterOutcome::TimedOut,
            Err(_) => PresenterOutcome::Failed, // main-thread closure panicked
        }
    }
}

/// One modal GtkMessageDialog on the main thread: Aprobar / Denegar (Spanish
/// copy), plain text, deny as the safe default, timeout → deny. Blocks THIS
/// closure only (nested main loop — the standard GTK modal pattern), never
/// the IPC thread.
#[cfg(target_os = "linux")]
fn show_modal(
    app: &tauri::AppHandle,
    title: &str,
    text: &str,
    timeout_ms: u64,
    tx: mpsc::Sender<PresenterOutcome>,
) {
    use gtk::prelude::*;
    let Ok(gtk_win) = main_window(app).gtk_window() else {
        let _ = tx.send(PresenterOutcome::NoDisplay); // no window → deny
        return;
    };
    let dialog = gtk::MessageDialog::new(
        Some(&gtk_win),
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Question,
        gtk::ButtonsType::None,
        text,
    );
    dialog.set_title(title);
    dialog.add_button("Aprobar", gtk::ResponseType::Apply);
    dialog.add_button("Denegar", gtk::ResponseType::Reject);
    dialog.set_default_response(gtk::ResponseType::Reject); // safe default
    // Plain text only: markup interpretation stays off (the GtkLabel default).
    let clicked = tx.clone();
    dialog.connect_response(move |_, response| {
        let outcome = match response {
            gtk::ResponseType::Apply => PresenterOutcome::Approved,
            gtk::ResponseType::None => PresenterOutcome::TimedOut,
            _ => PresenterOutcome::Denied, // close/Deny/escape → deny
        };
        let _ = clicked.send(outcome);
    });
    let on_timeout = dialog.clone();
    gtk::glib::timeout_add_local_once(Duration::from_millis(timeout_ms), move || {
        // Ends the nested run loop through the response handler above.
        on_timeout.response(gtk::ResponseType::None);
    });
    dialog.show_all();
    let _ = dialog.run();
    // Safe: run() has returned, the dialog was created and shown by THIS
    // closure on the main thread, and no other reference outlives it.
    unsafe { dialog.destroy() };
}

#[cfg(not(target_os = "linux"))]
struct UnavailablePresenter;

#[cfg(not(target_os = "linux"))]
impl Presenter for UnavailablePresenter {
    fn present(&self, _: &ValidatedDialog, _: u64) -> PresenterOutcome {
        PresenterOutcome::NoDisplay // honest: no native dialog on this platform yet
    }
}

// The Decision type is re-exported for callers that pattern-match the
// command's result type in tests/probes; nothing else uses it here.
#[allow(unused_imports)]
use abito_island::nativedialog::Decision as _Decision;

// DialogRequest/Decision appear only in signatures of the lib API the host
// forwards to; silence unused-import noise if the platform cfgs drop them.
#[allow(dead_code)]
fn _type_witness(_: Option<DialogRequest>, _: Option<Decision>) {}
