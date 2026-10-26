use std::{sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};
use tauri_nspanel::{objc2_app_kit::NSEvent, ManagerExt, NSPoint};

/// Manual drag: `start_dragging` needs the original mouse-down event, but the webview only
/// decides it is a drag after 4px of movement, so the panel is moved here instead.
struct Drag {
    offset_x: f64,
    offset_y: f64,
    last_x: f64,
}

#[derive(Default)]
pub struct Hit {
    dragging: Mutex<Option<Drag>>,
    cursor: Mutex<Option<(f64, f64)>>,
    last_emit: Mutex<Option<std::time::Instant>>,
}
#[tauri::command]
pub fn pet_hit(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    inside: bool,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("Pet window required".into());
    }
    if app.state::<Hit>().dragging.lock().unwrap().is_none() {
        window
            .set_ignore_cursor_events(!inside)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn pet_drag_start(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("Pet window required".into());
    }
    let panel = app.get_webview_panel("pet").map_err(|e| format!("{e:?}"))?;
    let ns = panel.as_panel();
    let frame = ns.frame();
    let mouse = NSEvent::mouseLocation();
    ns.setIgnoresMouseEvents(false);
    *app.state::<Hit>().dragging.lock().unwrap() = Some(Drag {
        offset_x: mouse.x - frame.origin.x,
        offset_y: mouse.y - frame.origin.y,
        last_x: frame.origin.x,
    });
    Ok(())
}

pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(16));
        let h = app.clone();
        if app.run_on_main_thread(move || tick(&h)).is_err() {
            break;
        }
    });
}
fn tick(app: &tauri::AppHandle) {
    let Ok(panel) = app.get_webview_panel("pet") else {
        return;
    };
    let ns = panel.as_panel();
    let frame = ns.frame();
    let mouse = NSEvent::mouseLocation();
    let x = mouse.x - frame.origin.x;
    let y = frame.size.height - (mouse.y - frame.origin.y);
    let state = app.state::<Hit>();
    let mut dragging = state.dragging.lock().unwrap();
    if let Some(drag) = dragging.as_mut() {
        let origin = NSPoint::new(mouse.x - drag.offset_x, mouse.y - drag.offset_y);
        ns.setFrameOrigin(origin);
        let dx = origin.x - drag.last_x;
        if dx != 0. {
            crate::agent::signal(
                app,
                serde_json::json!({"name":"pet-drag","phase":"move","dx":dx}),
            );
        }
        drag.last_x = origin.x;
        if NSEvent::pressedMouseButtons() == 0 {
            *dragging = None;
            ns.setIgnoresMouseEvents(true);
            crate::agent::signal(
                app,
                serde_json::json!({"name":"pet-drag","phase":"end","dx":0}),
            );
            crate::windows::persist(app);
        }
        return;
    }
    let mut cursor = state.cursor.lock().unwrap();
    let mut last_emit = state.last_emit.lock().unwrap();
    if x >= 0. && y >= 0. && x < frame.size.width && y < frame.size.height {
        // Re-send periodically even when the cursor is still: the webview may have missed the
        // first event (not yet listening) or the panel may have been reset to click-through
        // after a drag. The webview corrects `ignoring` whenever it disagrees with its hit test.
        let stale = last_emit.is_none_or(|t| t.elapsed() > Duration::from_millis(200));
        if *cursor != Some((x, y)) || stale {
            let _ = app.emit_to(
                "pet",
                "pet:cursor",
                serde_json::json!({"x":x,"y":y,"ignoring":ns.ignoresMouseEvents()}),
            );
            *cursor = Some((x, y));
            *last_emit = Some(std::time::Instant::now());
        }
    } else {
        ns.setIgnoresMouseEvents(true);
        *cursor = None;
        *last_emit = None;
    }
}
