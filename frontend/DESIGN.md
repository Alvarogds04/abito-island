# Coucou production integration provenance

This is the integration record, not a replacement for the frozen approved preview DESIGN.
TaskView #328 / phase #323. Uncommitted isolated candidate; no install/runtime authority.

## Approved presentation inputs

| Input | SHA-256 |
| --- | --- |
| Preview CSS | c2b52bfbbb79e562bed5d7a3e264d41c445057d5a8a92f19db3ea5cb524e349a |
| Preview HTML | f76478aa4d4819eabe30d507da79f5c8d77035be26a92f30094d5a6224730bc6 |
| Preview JS | d04d995a5aff76e2d928972752bbbd087806c041afd2f7ee36316c1c9af0ec76 |
| Frozen preview DESIGN (including §43) | 3496aaaebe43c6448ec5c785eeb00bc5dd82c9bf43212978a62b19ceaa521d85 |
| Preview tests | d541a931e1fce002cff1cda0abce4f3a392826c810e27d617f5bf68d057f317f |
| R7 clay engine (#347 authorized extension, seven legacy poses preserved) | 6534f543b34d7fce3c460f6aae65867b8e40234ac4cf15e289183c91fc9d9c52 |

## R7 character amendment (#347)

Coordinator 01a13c61 approved T0/D1–D4 on 2026-10-14. Only the Tauri engine freeze is lifted:
seven public R6 names/order and poses stay, eight own clay semantics are appended. Human
pending requests outrank existing chat/error facts; new finished presentation is neutral,
never success. Preserve #304 effective motion policy and #384 independent identity colors.
MIT Coucou mechanics only, no Mochi shapes/expressions/media/sounds/hands or new dependencies.
`character-motion.js` observes existing producer snapshots and owns one cancellable deadline;
far-future expiry is capped/rechecked rather than overflowing browser timers. Debug preview
is test-only, no IPC/persisted changes. Per-unit suites and commits live in the #347 task log;
no native rendering/CPU, install, delivery or shared runtime acceptance is implied.

## Sileo reconciliation

Base: `6ad9ae159d8f87be4f3139a575607a04d633bea4`.
Parent amended the original eight-file scope to nine tracked files plus the reveal check.
Full imported tracked diff SHA-256: `fa9b3fc05d1d3bc9df4bf44a185b7b6e7dc61186b8e61ec3e8ed0fd3bce295e7`.
Reveal check SHA-256: `a574498f40bdeda7775a4db835047131b49849a42914760469662299ff32a860`.
Owner confirmed every imported file against both retained before/after manifests.
The imported route is arrival-only; it does not meet the new click identity contract by itself.
Reveal test overlay on pinned base: RED exit 1 (`createRevealGate` undefined).
Full import: Node GREEN, reveal 16 and notify view 20. The retained Sileo Cargo baseline
is recorded in task log L5; Unit A's new integration checks are recorded separately in L12.
Historical focus RED was invalid and withdrawn; it is not reused as evidence.

## Parent-approved click amendment

The existing `desktop_action` receives exact `{action:'click', id, kind}` frames.
A separate typed parser validates the 512-byte cap, exact keys, lowercase canonical UUIDv4,
and `kind` in the closed set `question | finished`. Existing legacy action parsing is unchanged.
Sender/origin validation remains first, structural validation second, the same desktop rate gate third.
Missing/unknown kinds and malformed IDs fail closed with safe reason-only logs; no payload text is logged.

- A question click opens only the current host-owned question view. Pi approval-kind questions remain question views, never backend authorization.
- A finished click opens only the current `notices[0]`, with strict expiry. Queued IDs require prior host selection (not added here). Duplicate IDs across sessions are ambiguous and rejected; the click payload intentionally has no sessionId.
- Opening never answers, declines, executes, dismisses, or promotes an unrelated approval card.
- Existing trusted `answer{id,index}` / `decline{id}` and transport liveness/expiry enforcement remain independent.
- Dismiss remains its own unchanged control; dismiss is not decline.
- Legacy NoticeStore protocol-string IDs may display but are not click-routable through this strict boundary. Generic expand remains a separate existing operation, never an invalid-click fallback. Complete finished click routing requires UUID-carrying upstream notices.
- Focus handback is best effort; it is not a never-focus guarantee or acceptance criterion.

## Allowed adapter additions

`src/bridge.rs`: separate typed click parser/resolver and their tests only; do not change legacy
`validate_payload`, sender/origin checks or existing action paths.
`frontend/desktop.js`: typed click facade over the existing command only.
`src/transport.rs` and `src/questionhost.rs`: parent authorized a narrow click-only atomic active-question ID/expiry guard. Lock order is transport → questions → core/phase; no publication or transport reentry inside the callback. The callback produces the native opening plan under the identity guard; application/publication happens after guards release. Legacy paths stay unchanged.
Click uses its own native open arm, never legacy Expand's approval promotion.
This `frontend/DESIGN.md` records integration deltas; the sibling preview DESIGN stays frozen.

## Frontend integration contract (Unit A → Unit B)

The live opener calls **`window.desktop.click({id, kind})`**, where `kind` is
`'question' | 'finished'`. The frozen facade sends only `{action:'click', id, kind}`
to the existing `desktop_action` command; extra renderer properties are not forwarded.
It preserves the host's typed rejection and promise result. It does not eagerly change
views, answer, decline, dismiss, approve or fall back to generic expand on rejection.
Rust owns UUIDv4/kind/current-first validation; legacy IDs stay display-only.

A successful guarded native open emits **`desktop:notice-open` with `{id, kind}`**
through the existing Tauri event channel. Unit B consumes that event in `island.js`
and selects only the matched question or finished lane, suppressing unrelated approval
presentation without mutating its host state. A rejected click emits no opener event.
The event is display intent, not a new answer/approval capability. Dismiss remains its
separate sibling control and invokes only the unchanged `desktop.dismiss()` facade.

`main.rs` handles click separately after the existing sender/origin gate and before
legacy `validate_payload`; malformed click shapes are rejected before the desktop rate
gate. Validly shaped clicks share the existing rate gate. Guarded planning/application
runs on the native main thread. Native getter measurements are captured before acquiring
the identity guards. Question snapshot routing is followed by the atomic active ID+expiry
recheck; finished snapshot routing and open planning hold the same notice-store guard.
Both reserve the shared native generation inside the planning transaction. All native
writes, desktop/chat publication and opener event emission happen after guard release.
The deferred overview resize checks generation **and Expanded phase** on the native
thread; an intervening Hide or newer plan prevents stale settlement. No approval epoch,
selection, execution or decision call occurs in the click arm. Generic expand, dismissal,
answer-time validation, pending-collapse and native resize-barrier paths remain unchanged.

The initially misrouted `test-node/notice-click-check.cjs` was deliberately adopted.
Its VM exercise uses only the public facade (valid kinds, exact emitted frame, typed
rejection and unchanged dismiss/expand/choose calls). Serialization equality replaces
cross-VM JSON parsing. RED: exit 1, missing `desktop.click`; GREEN: exit 0, 6 facade
groups plus explicit native wiring readback (parser/rate ordering, atomic guard, no
legacy authority arm, post-publication event and deferred generation fence).
This is bridge/structural evidence, not a native/DOM rendering or focus guarantee.

## Pending gates

Owner co-review of adapter shape, presentation port, geometry reconciliation,
independent verification, and explicit parent/human runtime gate.
Cargo test/build receipts for this unit belong to task log L12, not inferred approval.
Node or Cargo results do not prove WebKit/native rendering, transport roundtrip or live focus.

## Geometry ruling (parent, 2026-10-13)

Preview geometry was adapted to native dimensions during the port: 66px compact dot, 640×160 overview, 400×640 work-area chat (native-owned; resize/geometry guards own these numbers). Model and settings render as chat-internal tall vertical panels. Real host-backed models/accounts replace preview demo groups. The tall-column and vertical-account INTENT carries over; exact preview px values are not authority here. A 72px right safety gutter for notices and the native R6 ~128px were retained rather than breaking the existing overview contract.
