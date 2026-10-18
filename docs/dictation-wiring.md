# Dictation: wiring spec for the host (#467)

The `flow` and `speech` modules are UI-free. The host (`main.rs`, settings,
pill) wires them like this. Nothing below starts by itself: dictation is OFF
until `prefs.enabled`, the model is downloaded only on the user's click, and the
clean-up never runs unless `prefs.cleanup` is on AND a provider is configured.

## Enable (prefs.enabled becomes true)

```rust
speech::preload();                                   // loads the model if present
let store = Arc::new(Mutex::new(flow::store::Store::load()));
let dict = flow::Dictation::start(store.clone(), flow::System, notify);
let key  = flow::portal::listen(dict.sender(), "Hold to dictate", "CTRL+ALT+v");
// keep `dict` and `key` alive; dropping them disables dictation.
// key.status(): Pending | Active | Denied | Unsupported -> the Settings line.
```

`notify: flow::Notify = Arc<dyn Fn(flow::Update)>` receives:
- `Update::Phase(Idle|Listening|Locked|Thinking|Copied|Failed)` -> the pill,
- `Update::Bands([f32; 9])` -> the pill's dots (about 30 times a second),
- `Update::Note(NeedModel|NoMicrophone|ClipboardRefused)` -> a message:
  - `NeedModel`: "Download the voice model first, in Settings" with a button
    that calls `speech::download(|status| emit)`. Only that button may call it.
  - `Copied` phase: "Your words are copied: press Ctrl+V where you want them."

The pill's buttons map to `dict.send(KeyEvent::HandsFree | Finish | Cancel)`.

## Settings page needs

- `speech::status()` (`Missing | Downloading{fraction} | Ready | Failed`),
  `speech::download(cb)`, `speech::remove()`; size in `ModelsStatus.download_mb`.
- `flow::store::Prefs` (enabled, key, edge, mic, keepDays, cleanup, defaultStyle),
  `Store.words / snippets / app_styles / history / stats`, `audio::input_devices()`.
- A visible warning next to `cleanup`: the TEXT (never the audio) goes to the
  configured provider.

## Optional clean-up provider

Implement `flow::cleanup::CleanupProvider { fn clean(&self, &Request) -> Result<String,String> }`
(blocking, own timeout of a few seconds) with the real credential (secret_action
keys), and return it from `Backend::cleanup_provider` in a wrapper around
`flow::System`. `Request::system_prompt()` / `user_message()` give the Coucou
instructions. Without a provider `cleanup` is a no-op even if the pref is on.

## Known follow-ups

- Two GlobalShortcuts sessions (island + dictation) each show a bind dialog;
  merging needs a `hotkeyhost.rs` change.
- Paste is clipboard-only (`wl-copy`): no keystroke injection.
- The foreground app name is not known yet (`process` uses the default style);
  per-app styles need a focus source.
