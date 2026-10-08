//! Pure island geometry — M1a contract in one place, no window-system calls.
//!
//! Everything here is in **physical pixels** (the unit of X11 root coordinates
//! and of Tauri's `outer_position`/`inner_size` getters). The logical contract
//! sizes are converted with [`scaled_size`] at the boundary.
//!
//! Contract: compact native window 304x44 (visible island 288x32 r14),
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


/// Native window size per state, in logical px (approved contract).
pub const LOGICAL_COMPACT: (i32, i32) = (304, 44);
pub const LOGICAL_OVERVIEW: (i32, i32) = (672, 176);

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

/// Start position: top-centre of the work area.
pub fn initial_position(area: Rect, w: i32, h: i32) -> Rect {
    Rect {
        x: clamp_x(area.x + (area.w - w) / 2, w, area),
        y: area.y,
        w,
        h,
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
        assert_eq!(scaled_size(LOGICAL_COMPACT, 1.0), (304, 44));
        assert_eq!(scaled_size(LOGICAL_OVERVIEW, 1.0), (672, 176));
        assert_eq!(scaled_size(LOGICAL_COMPACT, 2.0), (608, 88));
        assert_eq!(scaled_size((304, 44), 1.25), (380, 55));
        // broken scale factors must not poison the sizes
        assert_eq!(scaled_size(LOGICAL_COMPACT, 0.0), (304, 44));
        assert_eq!(scaled_size(LOGICAL_COMPACT, f64::NAN), (304, 44));
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
}
