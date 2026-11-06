//! Tucking the pet into a screen edge (docs/design.md §9, 贴边藏起): dropped against the outer
//! left or right edge of a screen, it slides in until only part of it shows and plays its peeking
//! row. The cursor coming near, or the pet having something to show (the page says so through
//! `pet_edge_hold`), brings it out; it slides back in a little after both are gone. Body play
//! only: it stays in the shell and never reaches the agent.
use std::{sync::Mutex, time::Instant};
use tauri::{Emitter, Manager};
use tauri_nspanel::{objc2_app_kit::NSScreen, objc2_foundation::MainThreadMarker, NSPoint, NSRect};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Side {
    Left,
    Right,
}

#[derive(Default)]
pub struct Edge {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    side: Option<Side>,
    /// The visible frame of the screen it is tucked into.
    screen: Option<NSRect>,
    /// The page has something on show (bubble, capsule, a request, a missed line).
    hold: bool,
    out: bool,
    /// When the cursor last was near; it slides back in a while after.
    near_at: Option<Instant>,
    /// The cursor has left the pet since it was dropped. Right after the drop the cursor is still
    /// on it, and counting that as "near" popped it straight back out, away from the edge.
    armed: bool,
    /// Last (side, out) the page was told.
    told: Option<(Option<Side>, bool)>,
}

/// How much of the pet stays on screen while tucked.
const SHOWN: f64 = 0.4;
/// Cursor this close (points) to the pet's visible part brings it out.
const NEAR: f64 = 28.;
const BACK_AFTER_MS: u128 = 1200;
/// The pet is drawn at the window's bottom right, 8pt in (style.css `.overlay > .pet`).
const INSET: f64 = 8.;

/// The pet's width inside a pet window `width` wide (shared `petDimensions`: 460pt at 0.73).
fn pet_width(window_width: f64) -> f64 {
    192. * window_width * 0.73 / 460.
}

/// Where the window's left goes for a side, tucked or out.
pub fn target_x(side: Side, screen: NSRect, window_width: f64, out: bool, hold: bool) -> f64 {
    let pet = pet_width(window_width);
    let left_of_pet = window_width - INSET - pet;
    let (min, max) = (screen.origin.x, screen.origin.x + screen.size.width);
    match (side, out) {
        (Side::Right, false) => max - SHOWN * pet - left_of_pet,
        // Out, the pet sits flush with the edge it came from (the window's 8pt inset goes past it).
        (Side::Right, true) => max - window_width + INSET,
        // Out with something to show, the whole window comes on screen: the capsule and bubbles
        // open to the pet's left.
        (Side::Left, true) if hold => min,
        (Side::Left, true) => min - left_of_pet,
        (Side::Left, false) => min + SHOWN * pet - pet - left_of_pet,
    }
}

/// Which outer edge a pet dropped at `pet` (its rect, screen coordinates) was pushed against.
pub fn pushed_side(pet: NSRect, screen: NSRect, others: &[NSRect]) -> Option<Side> {
    let y = pet.origin.y + pet.size.height / 2.;
    let beyond = |x: f64| {
        others.iter().any(|s| {
            x >= s.origin.x
                && x <= s.origin.x + s.size.width
                && y >= s.origin.y
                && y <= s.origin.y + s.size.height
        })
    };
    let right = screen.origin.x + screen.size.width;
    if pet.origin.x + pet.size.width >= right - 2. && !beyond(right + 10.) {
        Some(Side::Right)
    } else if pet.origin.x <= screen.origin.x + 2. && !beyond(screen.origin.x - 10.) {
        Some(Side::Left)
    } else {
        None
    }
}

/// The pet's own rect inside a pet window `frame`, screen coordinates.
pub(crate) fn pet_rect(frame: NSRect) -> NSRect {
    let w = pet_width(frame.size.width);
    let h = w * 208. / 192.;
    NSRect::new(
        NSPoint::new(
            frame.origin.x + frame.size.width - INSET - w,
            frame.origin.y + INSET,
        ),
        tauri_nspanel::NSSize::new(w, h),
    )
}

/// After a drag: tuck in when the pet was pushed against an outer edge.
pub fn dropped(app: &tauri::AppHandle, frame: NSRect) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let pet = pet_rect(frame);
    let center = NSPoint::new(
        pet.origin.x + pet.size.width / 2.,
        pet.origin.y + pet.size.height / 2.,
    );
    let screens: Vec<(NSRect, NSRect)> = NSScreen::screens(mtm)
        .iter()
        .map(|s| (s.frame(), s.visibleFrame()))
        .collect();
    let distance = |r: &NSRect| {
        let dx = (center.x - center.x.clamp(r.origin.x, r.origin.x + r.size.width)).abs();
        let dy = (center.y - center.y.clamp(r.origin.y, r.origin.y + r.size.height)).abs();
        dx * dx + dy * dy
    };
    let Some(index) = (0..screens.len())
        .min_by(|&a, &b| distance(&screens[a].0).total_cmp(&distance(&screens[b].0)))
    else {
        return;
    };
    let visible = screens[index].1;
    let others: Vec<NSRect> = screens
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, s)| s.0)
        .collect();
    let edge = app.state::<Edge>();
    let mut s = edge.state.lock().unwrap();
    s.side = pushed_side(pet, visible, &others);
    s.screen = s.side.map(|_| visible);
    s.out = false;
    s.near_at = None;
    s.armed = false;
}

/// Something on show, or tucked into an edge: no walking about (walk.rs).
pub fn busy(app: &tauri::AppHandle) -> bool {
    let edge = app.state::<Edge>();
    let s = edge.state.lock().unwrap();
    s.hold || s.side.is_some()
}

/// A drag started: whatever edge it was in, it is in the hand now.
pub fn picked_up(app: &tauri::AppHandle) {
    let edge = app.state::<Edge>();
    let mut s = edge.state.lock().unwrap();
    s.side = None;
    s.screen = None;
    s.out = false;
    drop(s);
    tell(app);
}

#[tauri::command]
pub fn pet_edge_hold(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    hold: bool,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("Pet window required".into());
    }
    app.state::<Edge>().state.lock().unwrap().hold = hold;
    Ok(())
}

/// Every frame while not dragging: decide in or out, and ease the window toward it.
/// Returns the new origin when the window should move.
pub fn tick(app: &tauri::AppHandle, frame: NSRect, mouse: NSPoint) -> Option<NSPoint> {
    let edge = app.state::<Edge>();
    let mut s = edge.state.lock().unwrap();
    let (side, screen) = (s.side?, s.screen?);
    let pet = pet_rect(frame);
    let visible_left = pet.origin.x.max(screen.origin.x);
    let visible_right = (pet.origin.x + pet.size.width).min(screen.origin.x + screen.size.width);
    let near = mouse.x >= visible_left - NEAR
        && mouse.x <= visible_right + NEAR
        && mouse.y >= pet.origin.y - NEAR
        && mouse.y <= pet.origin.y + pet.size.height + NEAR;
    s.out = next_out(&mut s, near, Instant::now());
    let target = target_x(side, screen, frame.size.width, s.out, s.hold);
    drop(s);
    tell(app);
    let dx = target - frame.origin.x;
    if dx.abs() < 0.5 {
        return None;
    }
    let step = if dx.abs() < 1.5 { dx } else { dx * 0.3 };
    Some(NSPoint::new(frame.origin.x + step, frame.origin.y))
}

/// In or out this frame: out while holding, or while the cursor is near (once it has left the
/// pet after the drop), and for a moment after it goes.
fn next_out(s: &mut State, near: bool, now: Instant) -> bool {
    if !near {
        s.armed = true;
    }
    let hover = near && s.armed;
    if hover {
        s.near_at = Some(now);
    }
    let recently = s
        .near_at
        .is_some_and(|t| now.duration_since(t).as_millis() < BACK_AFTER_MS);
    s.hold || hover || (s.out && recently)
}

/// Tells the page whether to play the peeking row, and facing which way.
fn tell(app: &tauri::AppHandle) {
    let edge = app.state::<Edge>();
    let mut s = edge.state.lock().unwrap();
    let now = (s.side, s.out);
    if s.told == Some(now) {
        return;
    }
    s.told = Some(now);
    drop(s);
    let side = match now.0 {
        Some(Side::Left) => "left",
        Some(Side::Right) => "right",
        None => "",
    };
    let _ = app.emit_to(
        "pet",
        "pet:edge",
        serde_json::json!({"side": side, "tucked": now.0.is_some() && !now.1}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_nspanel::NSSize;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    }

    #[test]
    fn tucks_only_at_outer_edges() {
        let screen = rect(0., 0., 1440., 900.);
        let pet = |x: f64| rect(x, 100., 140., 150.);
        assert_eq!(pushed_side(pet(1302.), screen, &[]), Some(Side::Right));
        assert_eq!(pushed_side(pet(1200.), screen, &[]), None);
        assert_eq!(pushed_side(pet(-20.), screen, &[]), Some(Side::Left));
        // A second screen to the right: that edge leads on, not out.
        let other = rect(1440., 0., 1920., 1080.);
        assert_eq!(pushed_side(pet(1302.), screen, &[other]), None);
    }

    #[test]
    fn tucked_leaves_part_of_the_pet_on_screen() {
        let screen = rect(0., 0., 1440., 900.);
        let width = 460.;
        let pet = pet_width(width);
        let x = target_x(Side::Right, screen, width, false, false);
        let pet_left = x + width - INSET - pet;
        assert!((1440. - pet_left - SHOWN * pet).abs() < 0.01);
        let x = target_x(Side::Left, screen, width, false, false);
        let pet_right = x + width - INSET;
        assert!((pet_right - SHOWN * pet).abs() < 0.01);
        // Out with a bubble at the left edge: the whole window is on screen.
        assert_eq!(target_x(Side::Left, screen, width, true, true), 0.);
        // Out without one, the pet touches the edge instead of stopping short of it.
        let x = target_x(Side::Right, screen, width, true, false);
        assert!((x + width - INSET - 1440.).abs() < 0.01);
        let x = target_x(Side::Left, screen, width, true, false);
        assert!((x + width - INSET - pet).abs() < 0.01);
    }

    // Reported 2026-11-06: dropped at the edge, the pet jumped back inward because the cursor
    // that just let go of it counted as coming near.
    #[test]
    fn the_hand_that_dropped_it_does_not_bring_it_out() {
        let now = Instant::now();
        let mut s = State::default();
        let step = |s: &mut State, near: bool| s.out = next_out(s, near, now);
        assert!(
            !next_out(&mut s, true, now),
            "cursor still on it after the drop"
        );
        step(&mut s, false);
        assert!(!s.out, "cursor moved away");
        step(&mut s, true);
        assert!(s.out, "cursor came back");
        assert!(
            next_out(&mut s, false, now),
            "stays out for a moment after it goes"
        );
        s.hold = true;
        s.armed = false;
        assert!(
            next_out(&mut s, true, now),
            "something to show keeps it out"
        );
    }
}
