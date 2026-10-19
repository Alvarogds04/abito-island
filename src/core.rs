//! Core interaction handlers shared by the Tauri commands (driven by real
//! pointer events in the webview) and the read-back probe (driven
//! programmatically). All click-vs-drag, snapping, clamping and grow-anchoring
//! decisions delegate to the pure [`crate::geometry`] module; this module only
//! sequences them against a window through [`WindowIo`].

use crate::geometry::{self, Edge, Rect};

/// Minimal window surface the handlers need. Implemented by the Tauri window
/// in production and by a fake in the tests.
pub trait WindowIo {
    /// Outer position in physical px (what X11 reports).
    fn outer_position(&self) -> (i32, i32);
    /// Inner size in physical px.
    fn size(&self) -> (i32, i32);
    /// Display scale factor (CSS px -> physical px).
    fn scale(&self) -> f64;
    fn set_outer_position(&self, x: i32, y: i32);
}

/// Screen point under a client (CSS px) coordinate, using the live window origin.
pub fn screen_at(io: &dyn WindowIo, client: (f64, f64)) -> (f64, f64) {
    let (ox, oy) = io.outer_position();
    let s = io.scale();
    (ox as f64 + client.0 * s, oy as f64 + client.1 * s)
}

#[derive(Debug)]
struct Press {
    /// Grab offset inside the window at press time, physical px.
    grab: (f64, f64),
    /// Last observed screen point of the pointer, physical px.
    last: (f64, f64),
    /// Accumulated pointer travel in physical px (click-vs-drag input).
    movement: f64,
}

/// What a release decided. The caller applies the I/O side effects so that the
/// probe and the commands share one code path.
#[derive(Debug, PartialEq)]
pub enum ReleaseOutcome {
    /// Short click: toggle compact<->overview with this plan.
    Toggle(TogglePlan),
    /// Drag release: snapped to an edge, no toggle.
    Snapped { rect: Rect, edge: Edge },
    /// Pointer cancel: state reconciled to an edge, no toggle.
    Cancelled,
}

impl ReleaseOutcome {
    /// #264 (GD049): the origin this release decided for the island, when it
    /// decided one at all — that is, a deliberate drag release and nothing
    /// else. A short click only toggles (the dot never moved), a cancelled
    /// release reconciles to the edge without a placement, and a release with
    /// no press behind it is not the human putting the island anywhere.
    /// This is the ONLY value the host persists across launches.
    pub fn saved_position(&self) -> Option<(i32, i32)> {
        match self {
            ReleaseOutcome::Snapped { rect, .. } => Some((rect.x, rect.y)),
            ReleaseOutcome::Toggle(_) | ReleaseOutcome::Cancelled => None,
        }
    }
}

/// Size + position for a compact<->overview switch, already anchored and clamped.
#[derive(Debug, PartialEq)]
pub enum TogglePlan {
    Expand {
        size: (i32, i32),
        rect: Rect,
        edge: Edge,
    },
    Collapse {
        size: (i32, i32),
        rect: Rect,
        edge: Edge,
    },
}

impl TogglePlan {
    pub fn size(&self) -> (i32, i32) {
        match self {
            TogglePlan::Expand { size, .. } | TogglePlan::Collapse { size, .. } => *size,
        }
    }
    pub fn rect(&self) -> Rect {
        match self {
            TogglePlan::Expand { rect, .. } | TogglePlan::Collapse { rect, .. } => *rect,
        }
    }
    pub fn edge(&self) -> Edge {
        match self {
            TogglePlan::Expand { edge, .. } | TogglePlan::Collapse { edge, .. } => *edge,
        }
    }
    pub fn is_expand(&self) -> bool {
        matches!(self, TogglePlan::Expand { .. })
    }
}

/// Unit U1/#309: overview <-> chat resize inside the SAME expanded island.
#[derive(Debug, PartialEq)]
pub struct ViewPlan {
    /// `true` = the chat column, `false` = the overview.
    pub chat: bool,
    /// Final native window size (physical px) and rectangle.
    pub size: (i32, i32),
    pub rect: Rect,
    /// The window that holds BOTH views while the page animates (physical px): the per-axis
    /// maximum of the current and the final size, on the same docked edge. The host resizes to it
    /// first and settles on `rect` afterwards, so neither view is ever clipped mid-transition.
    pub stage: Rect,
    /// The VISIBLE view in logical px (what the page animates to). Rust owns it.
    pub visible: (i32, i32),
    pub edge: Edge,
}

/// The stage rectangle of a transition (see [`ViewPlan::stage`]). S10 (L24): an expanded view is the notch stuck to
/// the top edge and centred on the work area, so the stage is pinned there too (it only needs the larger size).
pub fn stage_rect(_edge: Edge, current: Rect, target: (i32, i32), _final: (i32, i32), area: Rect) -> Rect {
    geometry::pin_top_center(geometry::stage_size((current.w, current.h), target), area)
}

/// Session state of the island: docked edge, open state, live pointer press.
#[derive(Debug, Default)]
pub struct Core {
    pub edge: Edge,
    pub expanded: bool,
    /// U1: the expanded island shows the chat view (only while expanded).
    pub chat: bool,
    /// #408: Ajustes is open inside the chat, so the column has the Settings size (only with `chat`).
    pub settings: bool,
    /// The chat rectangle before Settings grew it; closing restores it exactly (when it still fits).
    settings_prev: Option<Rect>,
    press: Option<Press>,
    /// S10 (L35): the chat height the page last asked for (Coucou's `chatPromptHeight`), already clamped to 240..300. It starts at
    /// the minimum and is kept across view switches, so reopening the chat gives the conversation the height it had.
    chat_height: i32,
    /// S10 (L24): where the compact dot was (rect + docked edge) when it expanded into the top-edge notch;
    /// collapsing puts it back there. `None` before the first expansion (then the old anchoring applies).
    compact_home: Option<(Rect, Edge)>,
    /// #309: the (stage, final) rectangles of the last view plan, while the window has not reached
    /// the final size yet. The host applies a plan asynchronously (a set_size is only a request),
    /// so the getter can still report the PREVIOUS window; planning the next switch from it would
    /// shrink the stage under a view that is already on screen. Dropped when the getter reaches the
    /// final size, on a toggle and on a drag.
    in_flight: Option<(Rect, Rect)>,
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    /// Pointer down: remember the grab offset. Client coords are CSS px.
    pub fn press(&mut self, io: &dyn WindowIo, client: (f64, f64)) {
        self.in_flight = None; // the human takes the window: plan from where it really is
        let s = io.scale();
        let (sx, sy) = screen_at(io, client);
        self.press = Some(Press {
            grab: (client.0 * s, client.1 * s),
            last: (sx, sy),
            movement: 0.0,
        });
    }

    /// True while a pointer press is active: the work-area watcher must not
    /// re-clamp under a live drag (the release snap owns geometry then).
    pub fn press_active(&self) -> bool {
        self.press.is_some()
    }

    /// Pointer move while held: the window follows the pointer freely (X
    /// clamped into the work area, Y free until release). Returns the new
    /// window origin, or `None` when no press is active.
    pub fn drag(
        &mut self,
        io: &dyn WindowIo,
        area: Rect,
        client: (f64, f64),
    ) -> Option<(i32, i32)> {
        let p = self.press.as_mut()?;
        let (sx, sy) = screen_at(io, client);
        p.movement += ((sx - p.last.0).powi(2) + (sy - p.last.1).powi(2)).sqrt();
        p.last = (sx, sy);
        if self.expanded {
            return None; // S10 (L24): the expanded notch is stuck to the top edge; only the compact dot is dragged
        }
        let (w, _) = io.size();
        let x = geometry::clamp_x((sx - p.grab.0).round() as i32, w, area);
        let y = (sy - p.grab.1).round() as i32; // vertical is free while dragging
        io.set_outer_position(x, y);
        Some((x, y))
    }

    /// Pointer up. Movement below [`geometry::CLICK_THRESHOLD_PX`] is a short
    /// click: snap to the nearest edge (keeping the chosen X, clamped) and
    /// toggle. A drag release snaps the same way but must NOT toggle.
    /// `cancelled` (pointer cancel / focus loss) always skips the toggle.
    pub fn release(
        &mut self,
        io: &dyn WindowIo,
        area: Rect,
        client: (f64, f64),
        cancelled: bool,
    ) -> ReleaseOutcome {
        let Some(press) = self.press.take() else {
            return ReleaseOutcome::Cancelled;
        };
        let (sx, sy) = screen_at(io, client);
        // final segment: browsers may deliver pointerup without a last pointermove
        let segment = ((sx - press.last.0).powi(2) + (sy - press.last.1).powi(2)).sqrt();
        let movement = press.movement + segment;
        let (w, h) = io.size();
        if self.expanded {
            // S10 (L24): no drag, no snap while expanded. A short click still toggles (collapse); anything else is nothing.
            if cancelled || !geometry::is_click(movement, geometry::CLICK_THRESHOLD_PX) {
                return ReleaseOutcome::Cancelled;
            }
            let (x, y) = io.outer_position();
            let plan = self.plan_toggle(io, Rect { x, y, w, h }, area);
            return ReleaseOutcome::Toggle(plan);
        }
        // The window position is derived from the pointer (it was following it),
        // X clamped only; the snap then pins Y to the nearest vertical edge.
        let chosen = Rect {
            x: geometry::clamp_x((sx - press.grab.0).round() as i32, w, area),
            y: (sy - press.grab.1).round() as i32,
            w,
            h,
        };
        let (snapped, edge) = geometry::snap_vertical_edge(chosen, area);
        io.set_outer_position(snapped.x, snapped.y);
        self.edge = edge;
        if cancelled {
            return ReleaseOutcome::Cancelled;
        }
        if geometry::is_click(movement, geometry::CLICK_THRESHOLD_PX) {
            let plan = self.plan_toggle(io, snapped, area);
            ReleaseOutcome::Toggle(plan)
        } else {
            ReleaseOutcome::Snapped {
                rect: snapped,
                edge,
            }
        }
    }

    /// Plan a compact<->overview switch anchored to the docked edge. No window
    /// I/O here: the caller applies the plan (expand immediately; collapse
    /// after the frontend shrink animation).
    pub fn toggle(&mut self, io: &dyn WindowIo, area: Rect) -> TogglePlan {
        let (x, y) = io.outer_position();
        let (w, h) = io.size();
        self.plan_toggle(io, Rect { x, y, w, h }, area)
    }

    fn plan_toggle(&mut self, io: &dyn WindowIo, current: Rect, area: Rect) -> TogglePlan {
        let scale = io.scale();
        // F009: the size comes from the one view table, like every other view
        let view = if self.expanded { geometry::View::Compact } else { geometry::View::Overview };
        let size = geometry::scaled_size(geometry::view_sizes(view, area.w, area.h, scale).0, scale);
        // S10 (L24): expanding sticks the island to the top edge, centred; collapsing puts the dot back where it was.
        let rect = if self.expanded {
            match self.compact_home.take() {
                Some((home, _)) => {
                    // the remembered spot may be stale (a display change, a moved panel): it is used only while the whole
                    // dot still fits the CURRENT work area, else the default top-centre home wins (same rule as restore_position)
                    let wanted = Rect { x: home.x, y: home.y, w: size.0, h: size.1 };
                    if geometry::clamp_rect(wanted, area) == wanted {
                        wanted
                    } else {
                        self.edge = Edge::Top;
                        geometry::initial_position(area, size.0, size.1)
                    }
                }
                None => geometry::anchor_toggle(self.edge, current, size, area),
            }
        } else {
            self.compact_home = Some((current, self.edge));
            geometry::pin_top_center(size, area)
        };
        self.expanded = !self.expanded;
        self.in_flight = None;
        // Collapsing always forgets the chat view: the next short click
        // opens the overview (M1 contract), never the chat directly.
        self.chat = false;
        self.settings = false;
        self.settings_prev = None;
        // the page anchors the island to the TOP while it is expanded and while it shrinks back
        if self.expanded {
            TogglePlan::Expand {
                size,
                rect,
                edge: Edge::Top,
            }
        } else {
            TogglePlan::Collapse {
                size,
                rect,
                edge: Edge::Top,
            }
        }
    }

    /// U1: switch the expanded island between overview and chat. Only from
    /// the expanded island (never opens from compact), anchored to the
    /// docked edge like every other resize. `None` = no change.
    pub fn plan_view(&mut self, io: &dyn WindowIo, area: Rect, chat: bool) -> Option<ViewPlan> {
        if !self.expanded || self.chat == chat {
            return None;
        }
        let scale = io.scale();
        // F009: both sizes come from the one view table; the chat takes the height the page last asked for (L35)
        let view = if chat { geometry::View::Chat } else { geometry::View::Overview };
        let (mut logical, mut visible) = geometry::view_sizes(view, area.w, area.h, scale);
        if chat {
            logical = geometry::chat_window_for(area.h, scale, self.chat_height);
            visible = geometry::chat_visible_for(area.h, scale, self.chat_height);
        }
        self.settings = false; // any view change forgets the Settings size
        self.settings_prev = None;
        Some(self.resize(io, area, chat, logical, visible, None))
    }

    /// The chat height the page last asked for, already clamped (see [`Core::plan_chat_height`]).
    pub fn chat_height(&self) -> i32 {
        self.chat_height.clamp(geometry::CHAT_MIN_H, geometry::CHAT_MAX_H)
    }

    /// S10 (L35, «Alto de Coucou, crece con los mensajes»): the page reports the chat height it wants (Coucou's
    /// `chatPromptHeight` rule, computed from the message count Rust does not have). Whatever it sends is clamped to Coucou's
    /// 240..300 and to the room the work area leaves; only inside the chat view (and not under the Settings size). `None` =
    /// nothing to do (not in the chat, or the clamped height is the one already planned).
    pub fn plan_chat_height(&mut self, io: &dyn WindowIo, area: Rect, desired: i32) -> Option<ViewPlan> {
        let scale = io.scale();
        if !self.expanded || !self.chat || self.settings {
            return None; // a report from outside the chat view is stale: it is not remembered either
        }
        let clamped = geometry::clamp_chat_height(desired, area.h, scale);
        self.chat_height = clamped;
        let logical = geometry::chat_window_for(area.h, scale, clamped);
        let visible = geometry::chat_visible_for(area.h, scale, clamped);
        let size = geometry::scaled_size(logical, scale);
        let (w, h) = io.size();
        let planned = match self.in_flight { Some((_, fin)) => (fin.w, fin.h), None => (w, h) };
        if planned == size {
            return None;
        }
        Some(self.resize(io, area, true, logical, visible, None))
    }

    /// #408: grow the chat column to the Settings size (`open`) or give it back. Only inside the chat
    /// view; the window grows around its centre on the same docked edge and always stays inside the
    /// work area. Closing restores the previous rectangle exactly when it still fits that size.
    pub fn plan_settings(&mut self, io: &dyn WindowIo, area: Rect, open: bool) -> Option<ViewPlan> {
        if !self.expanded || !self.chat || self.settings == open {
            return None;
        }
        let scale = io.scale();
        let (logical, visible, restore) = if open {
            let (x, y) = io.outer_position();
            let (w, h) = io.size();
            // a stale in-flight plan means the getter is not the truth yet: remember the planned chat rect
            self.settings_prev = Some(match self.in_flight {
                Some((_, fin)) if (w, h) != (fin.w, fin.h) => fin,
                _ => Rect { x, y, w, h },
            });
            (geometry::settings_window(area.w, area.h, scale), geometry::settings_visible(area.w, area.h, scale), None)
        } else {
            // F009: the plain column again, from the one view table
            let (logical, visible) = geometry::view_sizes(geometry::View::Chat, area.w, area.h, scale);
            (logical, visible, self.settings_prev.take())
        };
        self.settings = open;
        Some(self.resize(io, area, true, logical, visible, restore))
    }

    /// The staged resize shared by every view change (see [`ViewPlan::stage`]).
    fn resize(&mut self, io: &dyn WindowIo, area: Rect, chat: bool, logical: (i32, i32), visible: (i32, i32), restore: Option<Rect>) -> ViewPlan {
        let scale = io.scale();
        let size = geometry::scaled_size(logical, scale);
        let (x, y) = io.outer_position();
        let (w, h) = io.size();
        let mut current = Rect { x, y, w, h };
        if let Some((held, fin)) = self.in_flight {
            if (w, h) == (fin.w, fin.h) {
                self.in_flight = None; // settled: the getter is the truth again
            } else {
                // not settled: the window is, or is about to be, the stage that holds both views
                current = held;
            }
        }
        let stage = stage_rect(self.edge, current, size, size, area);
        // S10 (L24): stage and final window are the same top-edge notch, centred: the island does not jump
        let mut rect = geometry::pin_top_center(size, area);
        if let Some(prev) = restore {
            if (prev.w, prev.h) == size {
                let held = geometry::clamp_rect(prev, area);
                if (held.w, held.h) == size {
                    rect = held;
                }
            }
        }
        self.chat = chat;
        self.in_flight = Some((stage, rect));
        ViewPlan {
            chat,
            size,
            rect,
            stage,
            visible,
            edge: Edge::Top,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{chat_visible, chat_window, settings_window, LOGICAL_COMPACT, LOGICAL_OVERVIEW};
    use std::cell::Cell;

    fn area() -> Rect {
        Rect {
            x: 0,
            y: 32,
            w: 1920,
            h: 1048,
        }
    }

    /// Fake window: applies position/size immediately (the WM keeps up) and
    /// records only through the `WindowIo` surface the handlers are allowed
    /// to use.
    #[derive(Debug)]
    struct FakeIo {
        pos: Cell<(i32, i32)>,
        size: Cell<(i32, i32)>,
        scale: f64,
    }
    impl FakeIo {
        fn compact_top() -> Self {
            FakeIo {
                pos: Cell::new((808, 32)),
                size: Cell::new(LOGICAL_COMPACT),
                scale: 1.0,
            }
        }
        fn apply(&self, plan: &TogglePlan) {
            let (w, h) = plan.size();
            let r = plan.rect();
            self.size.set((w, h));
            self.pos.set((r.x, r.y));
        }
    }
    impl WindowIo for FakeIo {
        fn outer_position(&self) -> (i32, i32) {
            self.pos.get()
        }
        fn size(&self) -> (i32, i32) {
            self.size.get()
        }
        fn scale(&self) -> f64 {
            self.scale
        }
        fn set_outer_position(&self, x: i32, y: i32) {
            self.pos.set((x, y));
        }
    }

    #[test]
    fn drag_without_press_is_ignored() {
        let mut core = Core::new();
        let io = FakeIo::compact_top();
        assert_eq!(core.drag(&io, area(), (10.0, 10.0)), None);
    }

    #[test]
    fn short_click_toggles_to_overview_anchored_at_top() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0)); // screen (858, 52)
        // tiny 3px pointer wobble (client shifts while the window is still put)
        core.drag(&io, area(), (53.0, 20.0)); // window follows to (811, 32)
        // pointerup after the window followed: client is back at the grab offset
        let outcome = core.release(&io, area(), (50.0, 20.0), false);
        let plan = match outcome {
            ReleaseOutcome::Toggle(plan) => plan,
            other => panic!("expected Toggle, got {other:?}"),
        };
        assert!(plan.is_expand());
        assert_eq!(plan.size(), LOGICAL_OVERVIEW);
        let r = plan.rect();
        assert_eq!(r.y, 32); // S10: stuck to the top edge of the work area
        assert_eq!(r.w, 672);
        assert_eq!(r.h, 208);
        assert!(core.expanded);
        assert_eq!(core.edge, Edge::Top);
        // S10 (L24): centred on the work area (1920 wide), not on the dot
        assert_eq!(r.x, (1920 - 672) / 2);
    }

    #[test]
    fn drag_release_snaps_to_bottom_keeping_x_and_never_toggles() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0)); // screen (858, 52)
        // pointer travels to near the bottom of the work area; window follows
        core.drag(&io, area(), (152.0, 1008.0)); // screen (960, 1040)
        // release while the window follows the pointer (client = grab offset)
        let outcome = core.release(&io, area(), (50.0, 20.0), false);
        let (rect, edge) = match outcome {
            ReleaseOutcome::Snapped { rect, edge } => (rect, edge),
            other => panic!("expected Snapped, got {other:?}"),
        };
        assert_eq!(edge, Edge::Bottom);
        assert_eq!(rect.y, 32 + 1048 - LOGICAL_COMPACT.1); // bottom-docked (the work area ends at 1080)
        assert_eq!(rect.x, 910); // chosen X kept (clamped only if outside)
        assert!(!core.expanded, "a drag release must NOT toggle");
        assert_eq!(core.edge, Edge::Bottom);
        assert_eq!(io.outer_position(), (910, 32 + 1048 - LOGICAL_COMPACT.1));
    }

    #[test]
    fn expand_at_bottom_grows_upward_collapse_restores_compact() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        // dock at the bottom via a drag release
        core.press(&io, (50.0, 20.0));
        core.drag(&io, area(), (152.0, 1008.0));
        core.release(&io, area(), (50.0, 20.0), false);

        let docked = io.outer_position();
        let expand = core.toggle(&io, area());
        assert!(expand.is_expand());
        assert_eq!(expand.size(), LOGICAL_OVERVIEW);
        let r = expand.rect();
        assert_eq!(r.y, area().y, "S10 (L24): the expanded notch sticks to the TOP edge even when the dot was docked at the bottom");
        assert_eq!(r.x, (1920 - 672) / 2, "centred on the work area");
        io.apply(&expand);

        let collapse = core.toggle(&io, area());
        assert!(!collapse.is_expand());
        assert_eq!(collapse.size(), LOGICAL_COMPACT);
        let r = collapse.rect();
        assert_eq!(r.y, 32 + 1048 - LOGICAL_COMPACT.1); // still bottom-docked after collapsing
        assert_eq!(r.x, docked.0, "X centre restored to where the dot was");
        io.apply(&collapse);
        assert_eq!(io.outer_position(), (910, 32 + 1048 - LOGICAL_COMPACT.1));
        assert_eq!(io.size(), LOGICAL_COMPACT);
    }

    #[test]
    fn a_stale_compact_home_falls_back_to_the_default_top_centre() {
        // the dot was docked bottom-right, then the work area shrank (a display change): the remembered spot no longer fits
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0));
        core.drag(&io, area(), (152.0, 1008.0));
        core.release(&io, area(), (50.0, 20.0), false);
        let expand = core.toggle(&io, area());
        io.apply(&expand);
        let small = Rect { x: 0, y: 32, w: 800, h: 600 };
        let collapse = core.toggle(&io, small);
        assert!(!collapse.is_expand());
        let r = collapse.rect();
        assert_eq!((r.w, r.h), LOGICAL_COMPACT);
        assert_eq!(r.y, small.y, "default home is the top of the CURRENT area");
        assert_eq!(r.x, small.x + (small.w - LOGICAL_COMPACT.0) / 2, "centred on the CURRENT area");
        assert_eq!(core.edge, Edge::Top, "the edge memory follows the fallback");
        // and a home that still fits is kept exactly (see expand_at_bottom_grows_upward_collapse_restores_compact)
    }

    #[test]
    fn cancelled_release_never_toggles() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0));
        core.drag(&io, area(), (53.0, 20.0)); // only 3px of movement
        let outcome = core.release(&io, area(), (50.0, 20.0), true);
        assert_eq!(outcome, ReleaseOutcome::Cancelled);
        assert!(!core.expanded);
        // window is reconciled back to its edge even without a toggle
        assert_eq!(io.outer_position().1, 32);
    }

    #[test]
    fn press_without_movement_and_cancelled_is_cancelled() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0));
        let outcome = core.release(&io, area(), (50.0, 20.0), true);
        assert_eq!(outcome, ReleaseOutcome::Cancelled);
        assert!(!core.expanded);
    }

    #[test]
    fn press_without_release_state_is_kept_for_the_next_move() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0));
        assert_eq!(core.press.is_some(), true);
        let moved = core.drag(&io, area(), (50.0, 60.0));
        assert_eq!(moved, Some((808, 72))); // X untouched, Y followed 40px
        assert!(!core.expanded);
    }

    // --- unit U1: overview <-> chat inside the same expanded island -------

    fn expanded_top() -> (Core, FakeIo) {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        let plan = core.toggle(&io, area());
        io.apply(&plan);
        (core, io)
    }

    #[test]
    fn chat_view_needs_the_overview_first() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        assert_eq!(core.plan_view(&io, area(), true), None);
        assert!(!core.chat);
    }

    #[test]
    fn overview_to_chat_becomes_the_column_and_back() {
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).expect("open chat");
        assert!(open.chat);
        assert_eq!(open.size, chat_window(area().h, 1.0));
        assert_eq!(open.size, (672, 256), "S10 L35: the chat starts at Coucou's minimum height");
        assert_eq!(open.visible, chat_visible(area().h, 1.0), "Rust owns the visible size the page animates to");
        assert_eq!(open.rect.y, 32, "top-docked: grows downward");
        assert_eq!(open.rect.w, 672);
        // the chat stays centred under the overview it replaces: 672 wide at x -> 672 wide at the same x
        assert_eq!(open.rect.x + open.rect.w / 2, io.pos.get().0 + 672 / 2);
        assert!(core.chat && core.expanded);
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        // repeating is a no-op, never a second resize
        assert_eq!(core.plan_view(&io, area(), true), None);
        let back = core.plan_view(&io, area(), false).expect("back");
        assert!(!back.chat);
        assert_eq!(back.size, LOGICAL_OVERVIEW);
        assert_eq!(back.visible, (640, 160));
        assert!(!core.chat && core.expanded);
    }

    #[test]
    fn a_view_switch_goes_through_a_stage_window_that_holds_both_views() {
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).unwrap();
        assert_eq!((open.stage.w, open.stage.h), (672, 256), "wide as the overview and as tall as the 256 chat window (208 overview)");
        assert_eq!(open.stage.y, 32, "same docked edge as the final window");
        // the final window sits inside the stage, centred on it
        assert!(open.rect.x >= open.stage.x && open.rect.right() <= open.stage.right());
        assert_eq!(open.rect.x + open.rect.w / 2, open.stage.x + open.stage.w / 2);
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        let back = core.plan_view(&io, area(), false).unwrap();
        assert_eq!((back.stage.w, back.stage.h), (672, 256), "closing also holds the chat until the page has shrunk");
        assert_eq!(back.stage.y, open.rect.y);
        // when nothing needs a stage, the stage IS the final window
        let same = Rect { x: 0, y: 0, w: 5, h: 5 };
        assert_eq!(stage_rect(Edge::Top, same, (5, 5), (5, 5), area()), stage_rect(Edge::Top, same, (5, 5), (5, 5), area()));
    }

    #[test]
    fn the_chat_fits_the_work_area_height() {
        for h in [1048, 768, 560, 300] {
            let a = Rect { x: 0, y: 32, w: 1920, h };
            let (mut core, io) = expanded_top();
            let open = core.plan_view(&io, a, true).unwrap();
            assert_eq!(open.size, chat_window(h, 1.0), "{h}");
            assert!(open.rect.bottom() <= a.bottom(), "{h}: the chat fits the screen");
        }
    }

    // --- S10 (L35): the page reports the chat height it wants; Rust clamps it to Coucou's 240..300 -----------------------

    #[test]
    fn the_chat_height_grows_with_what_the_page_reports_and_only_inside_the_chat() {
        let (mut core, io) = expanded_top();
        // no chat open: nothing to resize
        assert_eq!(core.plan_chat_height(&io, area(), 280), None);
        let open = core.plan_view(&io, area(), true).unwrap();
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        assert_eq!(open.visible.1, 240);
        let grown = core.plan_chat_height(&io, area(), 280).expect("a taller chat");
        assert!(grown.chat);
        assert_eq!((grown.visible, grown.size), ((640, 280), (672, 296)));
        assert_eq!(grown.rect.y, open.rect.y, "still hangs from the top edge");
        assert_eq!(grown.rect.x, open.rect.x, "same width: nothing shifts sideways");
        io.size.set(grown.size);
        // the same height again is not a second resize
        assert_eq!(core.plan_chat_height(&io, area(), 280), None);
        // the cap, whatever the page asks
        let capped = core.plan_chat_height(&io, area(), 9999).expect("capped");
        assert_eq!(capped.visible.1, 300);
        io.size.set(capped.size);
        assert_eq!(core.plan_chat_height(&io, area(), 300), None, "already at the cap");
        // and the floor
        let low = core.plan_chat_height(&io, area(), -1).expect("floor");
        assert_eq!(low.visible.1, 240);
    }

    #[test]
    fn the_wanted_height_survives_a_view_switch_and_a_short_screen_still_wins() {
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).unwrap();
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        let grown = core.plan_chat_height(&io, area(), 300).unwrap();
        io.size.set(grown.size);
        io.pos.set((grown.rect.x, grown.rect.y));
        let back = core.plan_view(&io, area(), false).unwrap();
        io.size.set(back.size);
        io.pos.set((back.rect.x, back.rect.y));
        let again = core.plan_view(&io, area(), true).unwrap();
        assert_eq!(again.visible.1, 300, "reopening the chat keeps the height the conversation had");
        // a short work area clamps it
        let short = Rect { x: 0, y: 32, w: 1920, h: 320 };
        let (mut core2, io2) = expanded_top();
        let o2 = core2.plan_view(&io2, short, true).unwrap();
        io2.size.set(o2.size);
        io2.pos.set((o2.rect.x, o2.rect.y));
        let g2 = core2.plan_chat_height(&io2, short, 300);
        assert!(g2.map_or(true, |p| p.rect.bottom() <= short.bottom() && p.visible.1 >= 240));
    }

    #[test]
    fn closing_before_the_stage_was_applied_still_holds_the_column() {
        // the verifier's race: the getter still reports the OVERVIEW (the stage resize was only
        // requested), and the human closes the chat. Planning from the getter gave a 672x176 stage:
        // the column, still on screen, was clipped.
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).unwrap();
        // NOTHING applied: io still says 672x176 at the overview origin
        let back = core.plan_view(&io, area(), false).expect("close");
        assert!(back.stage.w >= open.stage.w && back.stage.h >= open.stage.h, "stage {:?} must hold the in-flight stage {:?}", back.stage, open.stage);
        assert!(back.stage.h >= open.rect.h, "the column ({}) fits the stage ({})", open.rect.h, back.stage.h);
        assert!(back.rect.x >= back.stage.x && back.rect.right() <= back.stage.right());
        assert_eq!((back.size, back.visible), (LOGICAL_OVERVIEW, (640, 160)));
    }

    #[test]
    fn reopening_before_the_close_was_applied_also_holds_both_views() {
        let (mut core, io) = expanded_top();
        let a = core.plan_view(&io, area(), true).unwrap();
        let b = core.plan_view(&io, area(), false).unwrap();
        let c = core.plan_view(&io, area(), true).unwrap();
        for plan in [&b, &c] {
            assert!(plan.stage.w >= 672 && plan.stage.h >= a.stage.h, "{:?}", plan.stage);
        }
        assert_eq!(c.size, a.size);
    }

    #[test]
    fn a_settled_window_is_planned_from_the_getter_again() {
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).unwrap();
        // the window reached the FINAL size: the memory of the transition is dropped
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        let back = core.plan_view(&io, area(), false).unwrap();
        assert_eq!((back.stage.w, back.stage.h), (672, 256));
        assert_eq!((back.stage.x, back.stage.y), (open.rect.x, open.rect.y), "same width: the stage is the chat window");
        io.size.set(back.size);
        io.pos.set((back.rect.x, back.rect.y));
        let again = core.plan_view(&io, area(), true).unwrap();
        assert_eq!(again.size, open.size, "no stale memory changes a later plan");
    }

    #[test]
    fn a_drag_forgets_the_transition_in_flight() {
        let (mut core, io) = expanded_top();
        core.plan_view(&io, area(), true).unwrap();
        core.press(&io, (10.0, 10.0));
        io.size.set((672, 256));
        io.pos.set((300, 32));
        core.release(&io, area(), (10.0, 10.0), true);
        let back = core.plan_view(&io, area(), false).unwrap();
        // S10 (L24): the expanded notch is never dragged, so the stage is the top-edge, work-area-centred window
        assert_eq!(back.stage.y, 32);
        assert_eq!((back.stage.w, back.stage.h), (672, 256), "planned from the getter (the press dropped the in-flight memory)");
        assert_eq!(back.stage.x, (1920 - 672) / 2, "centred on the work area, wherever the stale getter says the window is");
    }

    #[test]
    fn chat_after_a_bottom_docked_dot_hangs_from_the_top_edge() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0));
        core.drag(&io, area(), (152.0, 1008.0));
        core.release(&io, area(), (50.0, 20.0), false);
        let plan = core.toggle(&io, area());
        io.apply(&plan);
        let chat = core.plan_view(&io, area(), true).unwrap();
        assert_eq!(chat.rect.y, area().y, "S10 (L24): the chat column also hangs from the top edge, whatever edge the dot was docked at");
        assert_eq!(chat.rect.h, 256);
        assert_eq!(chat.rect.x + chat.rect.w / 2, area().x + area().w / 2, "centred on the work area");
    }

    #[test]
    fn collapsing_from_chat_lands_compact_and_forgets_the_chat_view() {
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).unwrap();
        io.size.set(open.size);
        let collapse = core.toggle(&io, area());
        assert!(!collapse.is_expand());
        assert_eq!(collapse.size(), LOGICAL_COMPACT);
        assert!(!core.chat && !core.expanded);
        // the next short click opens the OVERVIEW (M1 contract), not the chat
        io.apply(&collapse);
        let again = core.toggle(&io, area());
        assert_eq!(again.size(), LOGICAL_OVERVIEW);
        assert!(!core.chat);
    }

    // --- #264 (GD049): only a deliberate drag release decides what the next
    // --- launch remembers ------------------------------------------------------

    #[test]
    fn only_a_drag_release_carries_the_position_to_persist() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        // drag to the bottom-right and release: this is the placement to save
        core.press(&io, (50.0, 20.0));
        core.drag(&io, area(), (152.0, 1008.0));
        let dragged = core.release(&io, area(), (50.0, 20.0), false);
        assert!(matches!(dragged, ReleaseOutcome::Snapped { .. }));
        assert_eq!(dragged.saved_position(), Some((910, 32 + 1048 - LOGICAL_COMPACT.1)));
        // a short click toggles the island; it does not re-place it
        core.press(&io, (50.0, 20.0));
        let clicked = core.release(&io, area(), (50.0, 20.0), false);
        assert!(matches!(clicked, ReleaseOutcome::Toggle(_)));
        assert_eq!(clicked.saved_position(), None);
        // a cancelled release reconciles to the edge but is no deliberate placement
        core.press(&io, (50.0, 20.0));
        let cancelled = core.release(&io, area(), (50.0, 20.0), true);
        assert_eq!(cancelled, ReleaseOutcome::Cancelled);
        assert_eq!(cancelled.saved_position(), None);
        // no press at all: nothing to remember either
        assert_eq!(core.release(&io, area(), (50.0, 20.0), false).saved_position(), None);
    }

    // ---- #408: the chat column grows to a Settings size while Ajustes is open ----------------------

    fn chat_open() -> (Core, FakeIo, ViewPlan) {
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).unwrap();
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        (core, io, open)
    }

    #[test]
    fn settings_size_needs_the_chat_view_first() {
        let (mut core, io) = expanded_top();
        assert_eq!(core.plan_settings(&io, area(), true), None, "overview: no settings size");
        let io = FakeIo::compact_top();
        assert_eq!(Core::new().plan_settings(&io, area(), true), None, "compact: never");
    }

    #[test]
    fn opening_settings_grows_the_column_to_the_settings_size_inside_the_work_area() {
        let (mut core, io, chat) = chat_open();
        let plan = core.plan_settings(&io, area(), true).expect("open settings");
        assert!(plan.chat, "still the chat view for the page");
        assert_eq!(plan.visible, (720, 680));
        assert_eq!(plan.size, settings_window(area().w, area().h, 1.0));
        assert_eq!(plan.size, (752, 696));
        assert_eq!(plan.rect.y, chat.rect.y, "same docked edge");
        assert_eq!(plan.rect.x + plan.rect.w / 2, chat.rect.x + chat.rect.w / 2, "grows around its centre");
        assert!(plan.rect.x >= area().x && plan.rect.right() <= area().right() && plan.rect.bottom() <= area().bottom());
        assert!(plan.stage.w >= plan.rect.w.max(chat.rect.w) && plan.stage.h >= plan.rect.h.max(chat.rect.h), "the stage holds both sizes");
        assert_eq!(core.plan_settings(&io, area(), true), None, "repeating is a no-op");
    }

    #[test]
    fn closing_settings_restores_the_previous_chat_rectangle_exactly() {
        let (mut core, io, chat) = chat_open();
        let open = core.plan_settings(&io, area(), true).unwrap();
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        let back = core.plan_settings(&io, area(), false).expect("close settings");
        assert_eq!(back.rect, chat.rect, "the same size AND placement as before");
        assert_eq!((back.size, back.visible), (chat.size, chat.visible));
        assert!(back.chat);
        assert_eq!(core.plan_settings(&io, area(), false), None);
    }

    #[test]
    fn settings_stays_inside_small_work_areas() {
        for (w, h) in [(1920, 1048), (1366, 600), (800, 560), (700, 400)] {
            let a = Rect { x: 0, y: 32, w, h };
            let (mut core, io, _) = {
                let (mut core, io) = expanded_top();
                let open = core.plan_view(&io, a, true).unwrap();
                io.size.set(open.size);
                io.pos.set((open.rect.x, open.rect.y));
                (core, io, open)
            };
            let plan = core.plan_settings(&io, a, true).unwrap();
            assert!(plan.rect.w <= w && plan.rect.h <= h, "{w}x{h}: {:?}", plan.rect);
            assert!(plan.rect.x >= a.x && plan.rect.right() <= a.right(), "{w}x{h} horizontally");
            assert!(plan.rect.y >= a.y && plan.rect.bottom() <= a.bottom(), "{w}x{h} vertically");
            assert!(plan.visible.1 >= 240, "{w}x{h}: never shorter than the chat minimum");
        }
    }

    #[test]
    fn leaving_the_chat_or_collapsing_forgets_the_settings_size() {
        let (mut core, io, _) = chat_open();
        core.plan_settings(&io, area(), true).unwrap();
        let back = core.plan_view(&io, area(), false).expect("back to the overview");
        assert_eq!((back.size, back.visible), (LOGICAL_OVERVIEW, (640, 160)));
        assert!(!core.settings);
        let (mut core, io, _) = chat_open();
        core.plan_settings(&io, area(), true).unwrap();
        core.toggle(&io, area());
        assert!(!core.settings && !core.chat);
    }

    #[test]
    fn opening_the_chat_after_settings_uses_the_plain_column() {
        let (mut core, io, chat) = chat_open();
        core.plan_settings(&io, area(), true).unwrap();
        core.plan_view(&io, area(), false).unwrap();
        let again = core.plan_view(&io, area(), true).unwrap();
        assert_eq!(again.size, chat.size);
    }
}
