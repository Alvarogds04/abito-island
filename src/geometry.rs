//! Pure island geometry — M1a contract in one place, no window-system calls.
//!
//! Everything here is in **physical pixels** (the unit of X11 root coordinates
//! and of Tauri's `outer_position`/`inner_size` getters). The logical contract
//! sizes are converted with [`scaled_size`] at the boundary.
//!
//! Contract: compact native window 78x78 (visible round dot, 66 px diameter),
//! overview native window 672x176 (visible island 640x160 r22), origin at the
//! top-center of the work area, clamp to the work area, drag release snaps to
//! the nearest vertical edge keeping the chosen X (only clamped), expanding
//! while docked at the bottom grows upward (bottom edge anchored) and at the
//! top grows downward (top edge anchored), X centre stays anchored.

/// Rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    /// Vertical centre; used to decide which edge is nearer.
    pub fn center_y(&self) -> f64 {
        self.y as f64 + self.h as f64 / 2.0
    }
}

/// Vertical edge of the work area the island docks to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[derive(Default)]
pub enum Edge {
    #[default]
    Top,
    Bottom,
}


/// #302: the resting island is a ROUND DOT. Diameter measured from gentle-dot
/// (MIT, read-only reference): its Dot window is 72x72 pt holding a 66 pt black
/// disc (`docs/design.md`, `DOT_SIZE` in `shell.rs`). Same visible size here.
pub const DOT_DIAMETER: i32 = 66;

/// Native window size per state, in logical px. Compact = the dot plus a 6 px
/// transparent margin on every side (the same edge gap the pill had), so
/// drag / snap / edge memory / centre-anchored growth keep working unchanged:
/// they only ever see a rectangle.
pub const LOGICAL_COMPACT: (i32, i32) = (DOT_DIAMETER + 12, DOT_DIAMETER + 12);
pub const LOGICAL_OVERVIEW: (i32, i32) = (672, 176);

/// Visible overview island (approved contract, 640x160 r22). Only used to
/// derive window margins; the overview itself is frozen.
pub const OVERVIEW_VISIBLE: (i32, i32) = (640, 160);

/// #309 — the chat is a vertical COLUMN (gentle-shell style): a fixed narrow width and a
/// height that follows the work area. These are the VISIBLE sizes, in logical px; the native
/// window adds the overview's margins (see [`chat_window`]).
pub const CHAT_COLUMN_W: i32 = 400;
/// Visible height when the screen allows it.
pub const CHAT_PREFERRED_H: i32 = 640;
/// Never shorter than the old horizontal chat (240): small screens keep a usable chat.
pub const CHAT_MIN_H: i32 = 240;
/// Logical px of air left between the far end of the window and the work-area edge it grows toward.
pub const CHAT_FAR_GAP: i32 = 40;

/// Window margins around any visible view (the overview's 672x176 around its 640x160).
const WINDOW_MARGIN: (i32, i32) = (
    LOGICAL_OVERVIEW.0 - OVERVIEW_VISIBLE.0,
    LOGICAL_OVERVIEW.1 - OVERVIEW_VISIBLE.1,
);

/// Work-area height (PHYSICAL px, as X11 reports it) in logical px; a broken scale reads as 1.0.
fn logical_area_h(area_h_phys: i32, scale: f64) -> i32 {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    (area_h_phys as f64 / s).floor() as i32
}

/// Visible chat size in logical px for a work area of `area_h_phys` physical px. Rust owns this
/// number: the frontend only ever receives it (`__islandSetView`), it never decides the height.
pub fn chat_visible(area_h_phys: i32, scale: f64) -> (i32, i32) {
    let room = logical_area_h(area_h_phys, scale) - CHAT_FAR_GAP - WINDOW_MARGIN.1;
    (CHAT_COLUMN_W, room.clamp(CHAT_MIN_H, CHAT_PREFERRED_H))
}

/// Native chat window in logical px: the visible column plus the overview's window margins.
pub fn chat_window(area_h_phys: i32, scale: f64) -> (i32, i32) {
    let (w, h) = chat_visible(area_h_phys, scale);
    (w + WINDOW_MARGIN.0, h + WINDOW_MARGIN.1)
}

/// The window that holds BOTH views of a transition. Width and height move in opposite
/// directions between the overview and the column (672x176 <-> 432x656), so resizing straight to
/// the target would clip the view that is still on screen; the stage is the per-axis maximum.
pub fn stage_size(from: (i32, i32), to: (i32, i32)) -> (i32, i32) {
    (from.0.max(to.0), from.1.max(to.1))
}

/// Pointer movement at or above this many physical px on release counts as a
/// drag (snap, no toggle). Below it the release is a short click (toggle).
pub const CLICK_THRESHOLD_PX: f64 = 6.0;

/// Convert a logical contract size to physical px for the current scale factor.
pub fn scaled_size(size: (i32, i32), scale: f64) -> (i32, i32) {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    (
        (size.0 as f64 * s).round() as i32,
        (size.1 as f64 * s).round() as i32,
    )
}

/// Intersection of two rectangles; `None` when they do not overlap.
pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let r = a.right().min(b.right());
    let bot = a.bottom().min(b.bottom());
    if r > x && bot > y {
        Some(Rect {
            x,
            y,
            w: r - x,
            h: bot - y,
        })
    } else {
        None
    }
}

/// Clamp a horizontal position so a `w`-wide window stays inside the area.
pub fn clamp_x(x: i32, w: i32, area: Rect) -> i32 {
    let max_x = (area.right() - w).max(area.x);
    x.max(area.x).min(max_x)
}

/// Clamp a whole window rect into the work area (port of Electron core.cjs
/// `clampBounds`, used by the monitor/work-area re-clamp in unit M1b): the
/// size is capped to the area first, then the position is clamped so the
/// window lies fully inside it. A window that cannot fit is shrunk to the
/// area — being on screen wins over being complete.
pub fn clamp_rect(rect: Rect, area: Rect) -> Rect {
    let w = rect.w.max(1).min(area.w);
    let h = rect.h.max(1).min(area.h);
    Rect {
        x: clamp_x(rect.x, w, area),
        y: rect
            .y
            .max(area.y)
            .min((area.y + area.h - h).max(area.y)),
        w,
        h,
    }
}

/// Work-area watcher decision (M1b re-clamp): the rect the window must move
/// to after the work area changed, or `None` when it already fits. The
/// window keeps its OWN width and height (FIX-A: the watcher used to pass
/// `h.min(w)` as the width, which asked a 304x44 compact window to become
/// 44x44 on any work-area change); only a window larger than the area is
/// shrunk, by `clamp_rect`.
pub fn reclamp_on_workarea_change(current: Rect, area: Rect) -> Option<Rect> {
    let safe = clamp_rect(current, area);
    (safe != current).then_some(safe)
}

/// Start position: top-centre of the work area.
pub fn initial_position(area: Rect, w: i32, h: i32) -> Rect {
    Rect {
        x: clamp_x(area.x + (area.w - w) / 2, w, area),
        y: area.y,
        w,
        h,
    }
}

/// #264 (GD049): the position the human last dragged the island to, or the
/// default placement when there is none or it no longer exists.
///
/// The saved origin is used VERBATIM only when the whole window still lies
/// inside the CURRENT work area (a monitor was removed, the resolution
/// changed, the point now sits under a panel or outside every screen → it
/// does not). Otherwise the existing top-centre default wins: the island is
/// never restored off-screen, and a half-valid rectangle is never guessed at.
pub fn restore_position(saved: Option<(i32, i32)>, area: Rect, w: i32, h: i32) -> Rect {
    let default = || initial_position(area, w, h);
    let Some((x, y)) = saved else { return default() };
    let wanted = Rect { x, y, w, h };
    // `clamp_rect` only returns the rect unchanged when it already fits whole,
    // and it also refuses a window larger than the area itself.
    if clamp_rect(wanted, area) == wanted {
        wanted
    } else {
        default()
    }
}

/// Which vertical edge is nearer to the window (distance from the window's
/// vertical centre to the top edge vs to the bottom edge of the work area).
/// Exact tie goes to the top.
pub fn nearest_vertical_edge(chosen: Rect, area: Rect) -> Edge {
    let top_gap = chosen.center_y() - area.y as f64;
    let bottom_gap = area.bottom() as f64 - chosen.center_y();
    if top_gap <= bottom_gap {
        Edge::Top
    } else {
        Edge::Bottom
    }
}

/// Snap to a given edge: Y is pinned to the edge, X is kept and only clamped.
pub fn snap_to_edge(chosen: Rect, area: Rect, edge: Edge) -> Rect {
    let y = match edge {
        Edge::Top => area.y,
        Edge::Bottom => area.y + area.h - chosen.h,
    };
    Rect {
        x: clamp_x(chosen.x, chosen.w, area),
        y,
        w: chosen.w,
        h: chosen.h,
    }
}

/// Snap to the nearest vertical edge, returning the edge chosen.
pub fn snap_vertical_edge(chosen: Rect, area: Rect) -> (Rect, Edge) {
    let edge = nearest_vertical_edge(chosen, area);
    (snap_to_edge(chosen, area, edge), edge)
}

/// Grow/shrink anchoring for a compact<->overview toggle:
/// - `Edge::Top`: the top edge stays put (the island grows downward).
/// - `Edge::Bottom`: the bottom edge stays put (the island grows upward).
/// - X stays centre-anchored (the window centre does not move) and everything
///   is clamped into the work area.
pub fn anchor_toggle(edge: Edge, current: Rect, target: (i32, i32), area: Rect) -> Rect {
    let (tw, th) = target;
    let x = clamp_x(current.x + (current.w - tw) / 2, tw, area);
    let y_raw = match edge {
        Edge::Top => current.y,
        Edge::Bottom => current.y + current.h - th,
    };
    let max_y = (area.y + area.h - th).max(area.y);
    let y = y_raw.max(area.y).min(max_y);
    Rect {
        x,
        y,
        w: tw,
        h: th,
    }
}

/// Click vs drag: movement strictly below the threshold is a short click.
/// (`NaN` is not below the threshold, so a broken measurement degrades to
/// "drag" — never to an accidental toggle.)
pub fn is_click(movement: f64, threshold: f64) -> bool {
    movement < threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Work area as X11 under GNOME reports it: top bar excluded (y=32),
    /// 1920x1080 screen -> 1048px of usable height, bottom at 1080.
    fn area() -> Rect {
        Rect {
            x: 0,
            y: 32,
            w: 1920,
            h: 1048,
        }
    }

    #[test]
    fn scaled_size_applies_scale_factor() {
        assert_eq!(scaled_size(LOGICAL_COMPACT, 1.0), (78, 78));
        assert_eq!(scaled_size(LOGICAL_OVERVIEW, 1.0), (672, 176));
        assert_eq!(scaled_size(LOGICAL_COMPACT, 2.0), (156, 156));
        assert_eq!(scaled_size(LOGICAL_COMPACT, 1.25), (98, 98));
        assert_eq!(scaled_size((304, 44), 1.25), (380, 55)); // an arbitrary size still scales per axis
        // broken scale factors must not poison the sizes
        assert_eq!(scaled_size(LOGICAL_COMPACT, 0.0), (78, 78));
        assert_eq!(scaled_size(LOGICAL_COMPACT, f64::NAN), (78, 78));
    }

    #[test]
    fn intersect_overlaps_and_rejects() {
        let a = Rect {
            x: 0,
            y: 0,
            w: 100,
            h: 100,
        };
        let b = Rect {
            x: 50,
            y: 50,
            w: 100,
            h: 100,
        };
        assert_eq!(
            intersect(a, b),
            Some(Rect {
                x: 50,
                y: 50,
                w: 50,
                h: 50
            })
        );
        let far = Rect {
            x: 200,
            y: 0,
            w: 10,
            h: 10,
        };
        assert_eq!(intersect(a, far), None);
        let inner = Rect {
            x: 10,
            y: 10,
            w: 50,
            h: 50,
        };
        assert_eq!(intersect(a, inner), Some(inner));
    }

    #[test]
    fn clamp_x_keeps_window_inside_work_area() {
        assert_eq!(clamp_x(500, 304, area()), 500);
        assert_eq!(clamp_x(1900, 304, area()), 1920 - 304);
        assert_eq!(clamp_x(-20, 304, area()), 0);
        // window wider than the area collapses to the area origin, never past it
        assert_eq!(clamp_x(9999, 4000, area()), 0);
    }

    #[test]
    fn clamp_rect_ports_electron_clamp_bounds() {
        // ported from legacy test/core.test.cjs: negative coordinates
        let area2 = Rect {
            x: -1920,
            y: -200,
            w: 1920,
            h: 1080,
        };
        assert_eq!(
            clamp_rect(
                Rect {
                    x: -4000,
                    y: -600,
                    w: 520,
                    h: 720,
                },
                area2
            ),
            Rect {
                x: -1920,
                y: -200,
                w: 520,
                h: 720,
            }
        );
        // oversize window on a tiny display: shrunk to the area, inside it
        let tiny = Rect {
            x: -20,
            y: -30,
            w: 80,
            h: 60,
        };
        assert_eq!(
            clamp_rect(
                Rect {
                    x: 1000,
                    y: 1000,
                    w: 520,
                    h: 720,
                },
                tiny
            ),
            tiny
        );
        // sweep: every result stays fully inside the area
        let mut width = 1;
        while width < 700 {
            let work = Rect {
                x: -1700,
                y: -100,
                w: width,
                h: width + 10,
            };
            let r = clamp_rect(
                Rect {
                    x: 500,
                    y: 900,
                    w: 520,
                    h: 720,
                },
                work,
            );
            assert!(r.x >= work.x && r.y >= work.y, "width {width}");
            assert!(r.right() <= work.right() && r.bottom() <= work.bottom(), "width {width}");
            width += 19;
        }
        // already inside: unchanged (idempotent)
        let inside = Rect {
            x: 100,
            y: 100,
            w: 304,
            h: 44,
        };
        assert_eq!(clamp_rect(inside, area()), inside);
    }

    #[test]
    fn initial_position_is_top_center() {
        let r = initial_position(area(), 304, 44);
        assert_eq!(r.x, (1920 - 304) / 2); // 808
        assert_eq!(r.y, 32); // work-area top, below the GNOME top bar
        assert_eq!((r.w, r.h), (304, 44));
    }

    #[test]
    fn nearest_edge_picks_closer_vertical_edge() {
        // window parked near the bottom of the work area
        let near_bottom = Rect {
            x: 500,
            y: 1000,
            w: 304,
            h: 44,
        };
        assert_eq!(nearest_vertical_edge(near_bottom, area()), Edge::Bottom);
        // window parked near the top
        let near_top = Rect {
            x: 500,
            y: 100,
            w: 304,
            h: 44,
        };
        assert_eq!(nearest_vertical_edge(near_top, area()), Edge::Top);
        // exact middle is a tie -> top
        let mid_y = 32 + (1048 - 44) / 2;
        let middle = Rect {
            x: 500,
            y: mid_y,
            w: 304,
            h: 44,
        };
        let to_top = middle.center_y() - area().y as f64;
        let to_bottom = area().bottom() as f64 - middle.center_y();
        if (to_top - to_bottom).abs() < 0.5 {
            assert_eq!(nearest_vertical_edge(middle, area()), Edge::Top);
        }
    }

    #[test]
    fn snap_pins_y_and_keeps_chosen_x_only_clamped() {
        // near bottom: y pinned to the bottom edge, x untouched
        let chosen = Rect {
            x: 500,
            y: 1000,
            w: 304,
            h: 44,
        };
        let (snapped, edge) = snap_vertical_edge(chosen, area());
        assert_eq!(edge, Edge::Bottom);
        assert_eq!(snapped.y, 32 + 1048 - 44); // 1036
        assert_eq!(snapped.x, 500);
        assert_eq!((snapped.w, snapped.h), (304, 44));
        // near top
        let chosen = Rect {
            x: 500,
            y: 100,
            w: 304,
            h: 44,
        };
        let (snapped, edge) = snap_vertical_edge(chosen, area());
        assert_eq!(edge, Edge::Top);
        assert_eq!(snapped.y, 32);
        assert_eq!(snapped.x, 500);
        // chosen X outside the area is clamped, not kept verbatim
        let chosen = Rect {
            x: 1900,
            y: 100,
            w: 304,
            h: 44,
        };
        let (snapped, _) = snap_vertical_edge(chosen, area());
        assert_eq!(snapped.x, 1920 - 304);
    }

    #[test]
    fn anchor_toggle_top_grows_downward_and_keeps_x_centre() {
        let current = Rect {
            x: 808,
            y: 32,
            w: 304,
            h: 44,
        };
        let target = anchor_toggle(Edge::Top, current, (672, 176), area());
        assert_eq!(target.y, 32); // top edge anchored: grows downward
        assert_eq!(target.x, 808 + (304 - 672) / 2); // centre anchored: 624
        assert_eq!((target.w, target.h), (672, 176));
    }

    #[test]
    fn anchor_toggle_bottom_grows_upward_bottom_edge_stays() {
        let current = Rect {
            x: 808,
            y: 1036, // bottom-docked compact: 1036 + 44 == 1080
            w: 304,
            h: 44,
        };
        let target = anchor_toggle(Edge::Bottom, current, (672, 176), area());
        assert_eq!(target.bottom(), area().bottom()); // bottom edge anchored
        assert_eq!(target.y, 1080 - 176); // 904
        assert_eq!(target.x, 624);
        // collapsing back from that overview restores the compact rect exactly
        let back = anchor_toggle(Edge::Bottom, target, (304, 44), area());
        assert_eq!(
            back,
            Rect {
                x: 808,
                y: 1036,
                w: 304,
                h: 44
            }
        );
    }

    #[test]
    fn anchor_toggle_clamps_result_into_work_area() {
        // current rect poking out on the right of the area
        let current = Rect {
            x: 1800,
            y: 32,
            w: 304,
            h: 44,
        };
        let target = anchor_toggle(Edge::Top, current, (672, 176), area());
        assert!(target.x + target.w <= area().right());
        assert!(target.x >= area().x);
        assert!(target.y >= area().y);
    }

    #[test]
    fn is_click_threshold_boundary() {
        assert!(is_click(0.0, CLICK_THRESHOLD_PX));
        assert!(is_click(5.99, CLICK_THRESHOLD_PX));
        assert!(!is_click(CLICK_THRESHOLD_PX, CLICK_THRESHOLD_PX));
        assert!(!is_click(42.0, CLICK_THRESHOLD_PX));
        // NaN movement degrades to drag, never to an accidental toggle
        assert!(!is_click(f64::NAN, CLICK_THRESHOLD_PX));
    }

    // --- #309: the chat is a vertical COLUMN whose height follows the work area ----------

    #[test]
    fn chat_column_width_is_fixed_and_the_window_adds_the_overview_margins() {
        // measured contract: a narrow column (gentle-shell style), 400 visible
        assert_eq!(CHAT_COLUMN_W, 400);
        let (vw, vh) = chat_visible(1048, 1.0);
        assert_eq!(vw, 400);
        // native = visible + the same window margins the overview uses (32 x 16)
        assert_eq!(chat_window(1048, 1.0), (vw + 32, vh + 16));
        assert_eq!(chat_window(1048, 1.0).0, 432);
    }

    #[test]
    fn chat_height_is_the_preferred_one_when_the_screen_allows_it() {
        assert_eq!(CHAT_PREFERRED_H, 640);
        assert_eq!(chat_visible(1048, 1.0).1, 640);
        assert_eq!(chat_visible(2000, 1.0).1, 640, "never taller than preferred, however big the screen");
    }

    #[test]
    fn chat_height_shrinks_with_the_work_area_and_leaves_air_at_the_far_edge() {
        for area_h in [900, 768, 700, 600, 500] {
            let (_, vh) = chat_visible(area_h, 1.0);
            let window_h = vh + 16;
            assert!(window_h <= area_h - CHAT_FAR_GAP || vh == CHAT_MIN_H, "{area_h}: window {window_h} leaves less than {CHAT_FAR_GAP}px");
            assert!(vh >= CHAT_MIN_H);
        }
        assert_eq!(chat_visible(600, 1.0).1, 600 - CHAT_FAR_GAP - 16, "a short screen shrinks the column");
        assert_eq!(chat_visible(768, 1.0).1, 640, "768 still fits the preferred height");
        // monotonic: a taller area never gives a shorter chat
        let mut last = 0;
        for h in (300..1300).step_by(7) {
            let v = chat_visible(h, 1.0).1;
            assert!(v >= last, "{h}");
            last = v;
        }
    }

    #[test]
    fn chat_is_never_shorter_than_the_old_horizontal_chat() {
        assert_eq!(CHAT_MIN_H, 240);
        for h in [0, 1, 100, 240, 300, 400] {
            assert_eq!(chat_visible(h, 1.0).1.max(CHAT_MIN_H), chat_visible(h, 1.0).1, "{h}");
        }
        assert_eq!(chat_visible(100, 1.0).1, 240);
    }

    #[test]
    fn chat_size_is_in_logical_px_whatever_the_scale() {
        // the work area arrives in PHYSICAL px; the contract is logical
        assert_eq!(chat_visible(2096, 2.0), chat_visible(1048, 1.0));
        assert_eq!(chat_visible(1310, 1.25), chat_visible(1048, 1.0));
        assert_eq!(scaled_size(chat_window(2096, 2.0), 2.0), (864, 1312));
        // a broken scale degrades to 1.0, never to a zero or absurd window
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(chat_visible(1048, bad), chat_visible(1048, 1.0), "{bad}");
        }
    }

    #[test]
    fn the_stage_window_holds_both_views_so_nothing_is_clipped_mid_transition() {
        // overview 672x176 <-> chat 432x656: opposite directions per axis
        assert_eq!(stage_size(LOGICAL_OVERVIEW, (432, 656)), (672, 656));
        assert_eq!(stage_size((432, 656), LOGICAL_OVERVIEW), (672, 656));
        assert_eq!(stage_size((100, 100), (100, 100)), (100, 100));
        assert_eq!(stage_size((100, 300), (200, 100)), (200, 300));
    }

    #[test]
    fn approved_overview_and_compact_are_untouched_by_the_chat_view() {
        assert_eq!(OVERVIEW_VISIBLE, (640, 160));
        assert_eq!(LOGICAL_OVERVIEW, (672, 176));
        // #302: the resting state is a ROUND DOT (gentle-dot's 66-point disc) in a 78x78
        // native window (6px transparent margin each side, the same edge gap as the pill).
        assert_eq!(LOGICAL_COMPACT, (78, 78));
        assert_eq!(DOT_DIAMETER, 66);
        assert_eq!((LOGICAL_COMPACT.0 - DOT_DIAMETER) / 2, 6);
        // it takes less room than the pill it replaces (288x32 visible)
        assert!(DOT_DIAMETER * DOT_DIAMETER < 288 * 32 && LOGICAL_COMPACT.0 < 304);
        // the chat column is NARROWER than the overview and much taller
        assert!(CHAT_COLUMN_W < OVERVIEW_VISIBLE.0 && CHAT_PREFERRED_H > OVERVIEW_VISIBLE.1);
    }

    #[test]
    fn chat_grows_upward_when_docked_at_the_bottom_and_stays_centred() {
        let a = area();
        let size = chat_window(a.h, 1.0);
        assert_eq!(size, (432, 656));
        let overview = Rect { x: 624, y: a.bottom() - 176, w: 672, h: 176 };
        let chat = anchor_toggle(Edge::Bottom, overview, size, a);
        assert_eq!(chat.bottom(), a.bottom());
        // the window centre does not move: 624 + 672/2 == x + 432/2
        assert_eq!((chat.x + chat.w / 2, chat.w, chat.h), (624 + 336, 432, 656));
        let top = Rect { x: 624, y: a.y, w: 672, h: 176 };
        let chat = anchor_toggle(Edge::Top, top, size, a);
        assert_eq!((chat.y, chat.h), (a.y, 656));
    }

    #[test]
    fn a_column_at_the_screen_side_is_clamped_inside_the_work_area() {
        let a = area();
        let size = chat_window(a.h, 1.0);
        let right = Rect { x: a.right() - 672, y: a.y, w: 672, h: 176 };
        let chat = anchor_toggle(Edge::Top, right, size, a);
        assert!(chat.x >= a.x && chat.right() <= a.right());
        let left = Rect { x: a.x, y: a.y, w: 672, h: 176 };
        let chat = anchor_toggle(Edge::Top, left, size, a);
        assert!(chat.x >= a.x && chat.right() <= a.right());
    }

    // --- FIX-A (spec lane 4aa7c63): watcher re-clamp must keep the width ----

    #[test]
    fn workarea_change_never_shrinks_the_compact_window_to_44x44() {
        let compact = Rect { x: 808, y: 32, w: 304, h: 44 };
        // dock autohide / monitor change: the area moves but the island fits
        let moved = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        assert_eq!(reclamp_on_workarea_change(compact, moved), None);
        // the area shrank under the island: it is MOVED, still 304x44
        let narrow = Rect { x: 1000, y: 32, w: 920, h: 1048 };
        let moved = reclamp_on_workarea_change(compact, narrow).expect("must move");
        assert_eq!((moved.x, moved.y, moved.w, moved.h), (1000, 32, 304, 44));
    }

    #[test]
    fn workarea_change_keeps_overview_and_chat_sizes() {
        for (w, h) in [LOGICAL_OVERVIEW, chat_window(1048, 1.0)] {
            let r = Rect { x: 100, y: 32, w, h };
            assert_eq!(reclamp_on_workarea_change(r, area()), None);
            let off = Rect { x: 1700, y: 32, w, h };
            let moved = reclamp_on_workarea_change(off, area()).unwrap();
            assert_eq!((moved.w, moved.h), (w, h));
            assert_eq!(moved.right(), area().right());
        }
    }

    #[test]
    fn workarea_smaller_than_the_window_still_shrinks_it_onto_the_screen() {
        let r = Rect { x: 0, y: 0, w: 432, h: 656 };
        let tiny = Rect { x: 0, y: 0, w: 300, h: 200 };
        let moved = reclamp_on_workarea_change(r, tiny).unwrap();
        assert_eq!((moved.w, moved.h), (300, 200));
    }

    // --- #264 (GD049): the remembered position, restored verbatim or forgotten ---

    #[test]
    fn a_saved_position_inside_the_current_work_area_is_restored_verbatim() {
        // dragged to the bottom-right of the work area and released there
        assert_eq!(
            restore_position(Some((1400, 1002)), area(), 78, 78),
            Rect { x: 1400, y: 1002, w: 78, h: 78 }
        );
        // still top-docked, below the GNOME top bar
        assert_eq!(
            restore_position(Some((100, 32)), area(), 78, 78),
            Rect { x: 100, y: 32, w: 78, h: 78 }
        );
        // an island that starts at the very corner is still inside
        assert_eq!(restore_position(Some((0, 32)), area(), 78, 78).x, 0);
        assert_eq!(restore_position(Some((1920 - 78, 1080 - 78)), area(), 78, 78).bottom(), 1080);
    }

    #[test]
    fn a_saved_position_that_no_longer_exists_falls_back_to_the_default_placement() {
        let default = initial_position(area(), 78, 78);
        // monitor removed, resolution changed or simply outside the work area:
        // the CURRENT default placement wins, never the stale coordinates.
        for saved in [
            (2000, 1002),  // right of a screen that is narrower now
            (1400, 1200),  // below the current work area
            (1400, -200),  // above it (y < area.y)
            (1400, 10),    // under the top bar: outside the WORK area
            (-3000, 100),  // left of every monitor present now
        ] {
            let restored = restore_position(Some(saved), area(), 78, 78);
            assert_eq!(restored, default, "{saved:?} is unusable: default placement");
            assert!(restored.x >= area().x && restored.right() <= area().right());
            assert!(restored.y >= area().y && restored.bottom() <= area().bottom());
        }
        // a window bigger than the area cannot be restored verbatim either: it
        // gets exactly the default placement it would have had with NO saved
        // position at all (`initial_position` for its own size — never a guess).
        assert_eq!(
            restore_position(Some((0, 32)), area(), 4000, 78),
            restore_position(None, area(), 4000, 78)
        );
        assert_eq!(restore_position(Some((0, 32)), area(), 4000, 78), initial_position(area(), 4000, 78));
    }

    #[test]
    fn without_a_saved_position_the_default_top_centre_placement_is_unchanged() {
        assert_eq!(restore_position(None, area(), 78, 78), initial_position(area(), 78, 78));
        let r = restore_position(None, area(), 78, 78);
        assert_eq!((r.x, r.y), ((1920 - 78) / 2, 32), "the M1a contract placement");
    }

    #[test]
    fn whatever_was_saved_the_island_never_lands_off_screen() {
        // sweep of remembered points, good and hostile: the result is ALWAYS
        // fully inside the current work area (spec: never place it off-screen).
        let mut x = -4000;
        while x < 4000 {
            for y in [-1000, -1, 0, 31, 32, 500, 1079, 1080, 5000] {
                let r = restore_position(Some((x, y)), area(), 78, 78);
                assert!(r.x >= area().x && r.right() <= area().right(), "x={x} y={y} -> {r:?}");
                assert!(r.y >= area().y && r.bottom() <= area().bottom(), "x={x} y={y} -> {r:?}");
                assert_eq!((r.w, r.h), (78, 78), "the compact size is never corrupted");
            }
            x += 271;
        }
    }
}
