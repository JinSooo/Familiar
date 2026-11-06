//! Walking on its own (docs/design.md §9, 沿屏幕边缘走): idle and awake, every 3–6 minutes the
//! pet walks 80–200pt to one side at its height, stops a moment and walks back to where the user
//! put it. The page says when it may (`pet_rest`: walking on, idle, not sleepy, not night). Anything
//! on show, edge tucking or the cursor on it stops it where it is; once free it walks home. Body
//! play only: it stays in the shell and never reaches the agent.
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_nspanel::{objc2_app_kit::NSScreen, objc2_foundation::MainThreadMarker, NSPoint, NSRect};

#[derive(Default)]
pub struct Walk {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    rest: bool,
    /// When the next walk starts; set when the pet becomes free, cleared whenever it is not.
    next_at: Option<Instant>,
    trip: Option<Trip>,
    last_tick: Option<Instant>,
    /// Last direction the page was told: -1 left, 0 standing, 1 right.
    told: i8,
}

/// Positions are the pet's right edge: the pet is drawn at the window's bottom right, so this
/// stays put when the window is resized around it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Trip {
    /// Where it is now. Kept here, not read back from the window, which the system rounds to
    /// the pixel grid: walking left lost more to that than walking right, so the two speeds
    /// differed (seen 2026-11-06: ~90 vs ~53 pt/s).
    at: f64,
    home: f64,
    away: f64,
    back: bool,
    pause_until: Option<Instant>,
}

/// Points per second, about a stroll for a pet ~140pt tall.
const SPEED: f64 = 60.;
/// Cursor this close (points) to the pet stops it.
const NEAR: f64 = 28.;

#[tauri::command]
pub fn pet_rest(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    rest: bool,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("Pet window required".into());
    }
    app.state::<Walk>().state.lock().unwrap().rest = rest;
    Ok(())
}

/// A drag started: where it lands is the new home, so any walk is over.
pub fn picked_up(app: &tauri::AppHandle) {
    let walk = app.state::<Walk>();
    let mut s = walk.state.lock().unwrap();
    s.trip = None;
    s.next_at = None;
    drop(s);
    tell(app, 0);
}

/// Every frame while not dragging. Returns the new window origin when the pet should move.
pub fn tick(
    app: &tauri::AppHandle,
    frame: NSRect,
    mouse: NSPoint,
    visible: bool,
) -> Option<NSPoint> {
    let pet = crate::edge::pet_rect(frame);
    let near = mouse.x >= pet.origin.x - NEAR
        && mouse.x <= pet.origin.x + pet.size.width + NEAR
        && mouse.y >= pet.origin.y - NEAR
        && mouse.y <= pet.origin.y + pet.size.height + NEAR;
    let busy = crate::edge::busy(app);
    let walk = app.state::<Walk>();
    let mut s = walk.state.lock().unwrap();
    let now = Instant::now();
    let dt = s
        .last_tick
        .map_or(0., |t| now.duration_since(t).as_secs_f64().min(0.1));
    s.last_tick = Some(now);
    let right = pet.origin.x + pet.size.width;
    if !s.rest || !visible || busy || near {
        s.next_at = None;
        // Interrupted: once free again it heads straight home.
        if let Some(trip) = s.trip.as_mut() {
            trip.back = true;
            trip.pause_until = None;
        }
        drop(s);
        tell(app, 0);
        return None;
    }
    if let Some(mut trip) = s.trip {
        let before = trip.at;
        let (direction, done) = advance(&mut trip, dt, now, pause());
        s.trip = (!done).then_some(trip);
        drop(s);
        tell(app, direction);
        return (trip.at != before)
            .then(|| NSPoint::new(frame.origin.x + trip.at - right, frame.origin.y));
    }
    let next = *s
        .next_at
        .get_or_insert_with(|| now + Duration::from_secs_f64(180. + 180. * random()));
    if now < next {
        return None;
    }
    s.next_at = None;
    let screen = screen_of(pet)?;
    let offset = plan(
        (pet.origin.x, right),
        (screen.origin.x, screen.origin.x + screen.size.width),
        80. + 120. * random(),
        random() < 0.5,
    )?;
    s.trip = Some(Trip {
        at: right,
        home: right,
        away: right + offset,
        back: false,
        pause_until: None,
    });
    None
}

/// How far a walk goes: `distance` to the chosen side, else the other, keeping the whole pet on
/// the screen. None when neither side has room.
fn plan(pet: (f64, f64), screen: (f64, f64), distance: f64, rightward: bool) -> Option<f64> {
    let fits = |d: f64| pet.0 + d >= screen.0 && pet.1 + d <= screen.1;
    let first = if rightward { distance } else { -distance };
    [first, -first].into_iter().find(|&d| fits(d))
}

/// One frame of a trip: out, a pause there, then home. Moves `trip.at`; returns which way the pet
/// faces (0 standing) and whether it is home.
fn advance(trip: &mut Trip, dt: f64, now: Instant, pause: Duration) -> (i8, bool) {
    if let Some(until) = trip.pause_until {
        if now < until {
            return (0, false);
        }
        trip.pause_until = None;
        trip.back = true;
    }
    let target = if trip.back { trip.home } else { trip.away };
    let dx = target - trip.at;
    if dx.abs() <= SPEED * dt + 0.01 {
        trip.at = target;
        if !trip.back {
            trip.pause_until = Some(now + pause);
        }
        return (0, trip.back);
    }
    trip.at += SPEED * dt * dx.signum();
    (dx.signum() as i8, false)
}

/// The visible frame of the screen the pet stands on.
fn screen_of(pet: NSRect) -> Option<NSRect> {
    let mtm = MainThreadMarker::new()?;
    let (x, y) = (
        pet.origin.x + pet.size.width / 2.,
        pet.origin.y + pet.size.height / 2.,
    );
    NSScreen::screens(mtm)
        .iter()
        .map(|s| s.visibleFrame())
        .find(|r| {
            x >= r.origin.x
                && x <= r.origin.x + r.size.width
                && y >= r.origin.y
                && y <= r.origin.y + r.size.height
        })
}

fn pause() -> Duration {
    Duration::from_secs_f64(1.5 + 1.5 * random())
}

/// Enough randomness for when and where to stroll (xorshift, seeded from the clock).
fn random() -> f64 {
    static SEED: AtomicU64 = AtomicU64::new(0);
    let mut x = SEED.load(Ordering::Relaxed);
    if x == 0 {
        x = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(1, |d| d.as_nanos() as u64)
            | 1;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    SEED.store(x, Ordering::Relaxed);
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// Tells the page to play the running row while it walks, facing the way it goes.
fn tell(app: &tauri::AppHandle, direction: i8) {
    let walk = app.state::<Walk>();
    let mut s = walk.state.lock().unwrap();
    if s.told == direction {
        return;
    }
    s.told = direction;
    drop(s);
    let value = match direction {
        -1 => "left",
        1 => "right",
        _ => "none",
    };
    let _ = app.emit_to("pet", "pet:walk", value);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_the_other_way_when_one_side_has_no_room() {
        let screen = (0., 1440.);
        assert_eq!(plan((1250., 1390.), screen, 100., true), Some(-100.));
        assert_eq!(plan((500., 640.), screen, 100., true), Some(100.));
        assert_eq!(plan((10., 150.), screen, 100., false), Some(100.));
        assert_eq!(plan((0., 140.), (0., 200.), 100., true), None);
    }

    #[test]
    fn goes_out_stops_and_comes_back_home() {
        let start = Instant::now();
        let mut trip = Trip {
            at: 500.,
            home: 500.,
            away: 560.,
            back: false,
            pause_until: None,
        };
        let pause = Duration::from_secs(2);
        let mut now = start;
        let mut faced = vec![];
        let (mut out, mut back) = (0, 0);
        for _ in 0..1000 {
            now += Duration::from_millis(16);
            let (direction, done) = advance(&mut trip, 0.016, now, pause);
            match direction {
                1 => out += 1,
                -1 => back += 1,
                _ => {}
            }
            if faced.last() != Some(&direction) {
                faced.push(direction);
            }
            if done {
                break;
            }
        }
        assert_eq!(trip.at, 500.);
        assert_eq!(faced, vec![1, 0, -1, 0], "right, a pause, left, home");
        assert!(now - start > pause, "it stopped at the far end");
        assert_eq!(out, back, "same speed both ways");
    }
}
