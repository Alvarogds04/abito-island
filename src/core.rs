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

/// Unit U1: overview <-> chat resize inside the SAME expanded island.
#[derive(Debug, PartialEq)]
pub struct ViewPlan {
    /// `true` = the chat view (LOGICAL_CHAT), `false` = the overview.
    pub chat: bool,
    pub size: (i32, i32),
    pub rect: Rect,
    pub edge: Edge,
}

/// Session state of the island: docked edge, open state, live pointer press.
#[derive(Debug, Default)]
pub struct Core {
    pub edge: Edge,
    pub expanded: bool,
    /// U1: the expanded island shows the chat view (only while expanded).
    pub chat: bool,
    press: Option<Press>,
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    /// Pointer down: remember the grab offset. Client coords are CSS px.
    pub fn press(&mut self, io: &dyn WindowIo, client: (f64, f64)) {
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
        let size = if self.expanded {
            geometry::scaled_size(geometry::LOGICAL_COMPACT, scale)
        } else {
            geometry::scaled_size(geometry::LOGICAL_OVERVIEW, scale)
        };
        let rect = geometry::anchor_toggle(self.edge, current, size, area);
        self.expanded = !self.expanded;
        // Collapsing always forgets the chat view: the next short click
        // opens the overview (M1 contract), never the chat directly.
        self.chat = false;
        if self.expanded {
            TogglePlan::Expand {
                size,
                rect,
                edge: self.edge,
            }
        } else {
            TogglePlan::Collapse {
                size,
                rect,
                edge: self.edge,
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
        let logical = if chat {
            geometry::LOGICAL_CHAT
        } else {
            geometry::LOGICAL_OVERVIEW
        };
        let size = geometry::scaled_size(logical, io.scale());
        let (x, y) = io.outer_position();
        let (w, h) = io.size();
        let rect = geometry::anchor_toggle(self.edge, Rect { x, y, w, h }, size, area);
        self.chat = chat;
        Some(ViewPlan {
            chat,
            size,
            rect,
            edge: self.edge,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{LOGICAL_CHAT, LOGICAL_COMPACT, LOGICAL_OVERVIEW};
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
        assert_eq!(r.y, 32); // top edge anchored: grows downward
        assert_eq!(r.w, 672);
        assert_eq!(r.h, 176);
        assert!(core.expanded);
        assert_eq!(core.edge, Edge::Top);
        // the 3px drift is the chosen X, centre-anchored: 811 -> 627
        assert_eq!(r.x, 811 + (LOGICAL_COMPACT.0 - 672) / 2);
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
        assert_eq!(r.bottom(), area().bottom(), "bottom edge stays anchored");
        assert_eq!(r.y, 1080 - 176);
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
    fn overview_to_chat_grows_to_the_chat_constant_and_back() {
        let (mut core, io) = expanded_top();
        let open = core.plan_view(&io, area(), true).expect("open chat");
        assert!(open.chat);
        assert_eq!(open.size, LOGICAL_CHAT);
        assert_eq!(open.rect.y, 32, "top-docked: grows downward");
        assert_eq!(open.rect.w, 672);
        assert!(core.chat && core.expanded);
        io.size.set(open.size);
        io.pos.set((open.rect.x, open.rect.y));
        // repeating is a no-op, never a second resize
        assert_eq!(core.plan_view(&io, area(), true), None);
        let back = core.plan_view(&io, area(), false).expect("back");
        assert!(!back.chat);
        assert_eq!(back.size, LOGICAL_OVERVIEW);
        assert!(!core.chat && core.expanded);
    }

    #[test]
    fn chat_at_the_bottom_grows_upward() {
        let io = FakeIo::compact_top();
        let mut core = Core::new();
        core.press(&io, (50.0, 20.0));
        core.drag(&io, area(), (152.0, 1008.0));
        core.release(&io, area(), (50.0, 20.0), false);
        let plan = core.toggle(&io, area());
        io.apply(&plan);
        let chat = core.plan_view(&io, area(), true).unwrap();
        assert_eq!(chat.rect.bottom(), area().bottom());
        assert_eq!(chat.rect.h, 256);
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
}
