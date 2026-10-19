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

## dictation_action contract

The main island and settings window invoke `dictation_action` with `{payload: ...}`.
The sender URL/label gate and shared chat rate limiter apply to every action.
Unknown actions, extra/missing fields, and wrong types are rejected.

- `{action:"status"}` returns `{prefs,models,keys,hasClaudeKey:false,mics,platform:"linux",autostarted:false}`.
  `prefs` contains the seven stored fields below plus constants `summaryEngine:"off"`,
  `openAtLaunch:false`, `voice:false`, `voiceOutput:"off"`, `voiceGender:"female"`.
  `models` is `{parakeet:{state:"missing"|"downloading"|"ready"|"failed"},downloadMb}`;
  downloading adds `fraction`, failed adds `error`. `downloadMb` is available BEFORE downloading.
  `keys` is `ok|pending|denied|unsupported` from the live portal, or `ok` when disabled.
  `mics` is `[{name,default}]`, enumerated without opening a capture stream.
- `{action:"set_prefs",prefs:{enabled,key,edge,mic,keepDays,cleanup,defaultStyle}}`
  requires exactly these seven keys. `key`: `right_ctrl|right_alt|right_shift|left_ctrl_super`;
  `edge`: `bottom|left|right`; `defaultStyle`: `verbatim|natural|polished`;
  `keepDays`: `0|7|30|365|-1` (Coucou's exact UI set; **90 is rejected**).
  `mic` is empty (system default) or a current input-device name, at most 200 UTF-8 bytes;
  validation enumerates devices but never opens capture. `cleanup` MUST be false:
  no provider is configured, so true is rejected. Returns the seven persisted prefs.
  Enabling starts the engine/portal; disabling drops both and stops dictation.
  Same-enabled writes retain the running engine. The desktop owns the actual shortcut:
  the stored key enum does not replace the portal's `CTRL+ALT+v` preferred binding.
- `{action:"download_model"}` is explicit-click-only: starts `speech::download`, returns
  ModelsStatus, and emits download progress/completion through `dictation:models`.
- `{action:"remove_model"}` removes and unloads the model, returning ModelsStatus.
- `{action:"hands_free"}`, `{action:"finish"}`, `{action:"cancel"}` map to
  `KeyEvent::HandsFree|Finish|Cancel`. Return `{ok:true}` when running, `{ok:false}` otherwise.
  Of these command actions, **only hands_free may open the microphone**, after an explicit
  user click. A user-held portal shortcut may also open it. Status, setup, preference
  changes, finish and cancel never initiate capture. Delivery is clipboard-only (Ctrl+V).

### Local data actions (same gate and rate limiter)

All objects below require exactly the listed keys, including nested objects. Arrays
must contain only the documented element type. Limits count Unicode scalar values
(characters), except deletion IDs, which are ASCII. No data action copies, pastes,
opens a microphone, downloads, or accesses the network. Mutations return `{ok:true}`.

- `{action:"history"}` returns `[{id,date,text,app,words,seconds}]`: newest first,
  preserving Store insertion order, capped at 300. `date` is epoch milliseconds;
  `app` is a string or null. Returns `[]` whenever `prefs.keepDays == 0`.
- `{action:"delete_entry",id}`: non-empty ASCII `[A-Za-z0-9_-]` ID, at most 64
  characters. Missing IDs are a successful no-op.
- `{action:"clear_history",everything}`: strict boolean; false clears history only,
  true clears history and statistics (not dictionary, snippets, styles or prefs).
- `{action:"stats"}` returns `{week,month,all,daily,apps,streak}`. Each totals object
  is `{words,seconds,dictations,wordsPerMinute,minutesSaved}` using the shared text
  helpers. Week starts today minus 6 days, month today minus 29; all has no cutoff.
  `daily` has exactly 30 `["YYYY-MM-DD",words]` pairs, oldest first, zero-filled.
  `apps` maps app names to word counts; `streak` uses Store's today/yesterday rule.
- `{action:"words"}` returns `{words:[string],replacements:[{id,from,to}]}`.
  `{action:"set_words",words:{words,replacements}}` replaces both lists: at most
  500 words, each at most 80 characters and accepted by `text::is_plain_word`
  (at least two alphanumeric characters; only alphanumerics, spaces, hyphens and
  straight/curly apostrophes). At most 500 replacements; `id` ≤64, `from`/`to` ≤200.
- `{action:"snippets"}` returns `[{id,trigger,text}]`.
  `{action:"set_snippets",snippets:[{id,trigger,text}]}` replaces all snippets:
  at most 200; `id` ≤64, `trigger` ≤80, `text` ≤4000. Triggers must not be empty or
  whitespace-only and must be unique by exact string equality.
- `{action:"styles"}` returns `[{id,name,style}]`.
  `{action:"set_styles",styles:[{id,name,style}]}` replaces all styles: at most
  100; `id`/`name` ≤80; `style` is exactly `verbatim|natural|polished`.

Persistence calls run under the shared store mutex only, after releasing the host
mutex. Store saves currently log disk errors rather than returning them; `{ok:true}`
acknowledges the in-memory mutation, not guaranteed durable storage.

Events (emitted with `app.emit`, payload is the object itself, not a wrapper):

| Name | Exact payload | When |
| --- | --- | --- |
| `dictation:phase` | `{phase:"idle"|"listening"|"locked"|"thinking"|"copied"|"failed"}` | Engine phase changes; copied means clipboard ready, idle also follows stop/cancel. |
| `dictation:bands` | `{bands:[nine floats]}` | While recording, throttled by the engine (~30 Hz). |
| `dictation:note` | `{note:"needModel"|"noMicrophone"|"clipboardRefused"}` | Capture/model/clipboard requires user attention. |
| `dictation:models` | `{parakeet:{state,...},downloadMb}` (ModelsStatus above) | Download callback: start, progress, completion or failure. |

Startup loads one shared Store and restores only the user's saved enabled choice.
No setup download, network call, microphone capture, or cleanup provider is introduced.
Model removal returns its status directly; it does not emit a download-progress event.

## Known follow-ups

- Two GlobalShortcuts sessions (island + dictation) each show a bind dialog;
  merging needs a `hotkeyhost.rs` change.
- Paste is clipboard-only (`wl-copy`): no keystroke injection.
- The foreground app name is not known yet (`process` uses the default style);
  per-app styles need a focus source.
