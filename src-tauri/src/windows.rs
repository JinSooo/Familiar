use std::path::PathBuf;
use tauri::{
    window::{Effect, EffectState, EffectsBuilder},
    LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};

tauri_panel! {
    panel!(PetPanel { config: { can_become_key_window: true, is_floating_panel: true } })
    // Borderless NSWindows refuse key status, which swallowed first clicks and blocked typing.
    // Not main-capable: a non-activating panel that may become main spends a click on that.
    panel!(ChatPanel { config: { can_become_key_window: true } })
    // The menu bar panel. Not key-capable (with two key-capable panels the menu bar showed three
    // Familiar icons), so it never hears about losing focus; `hide_panel_on_outside_click` closes it.
    panel!(TrayPanel { config: { can_become_key_window: false } })
    // The quick-ask bar: key so its field takes typing.
    panel!(QuickPanel { config: { can_become_key_window: true } })
}

const PANEL_SIZE: (f64, f64) = (320., 520.);
/// The quick-ask bar: the field alone at first, then a box of a set height once there is a
/// conversation. Width and that height are the defaults until the user drags or resizes it.
const QUICK_SIZE: (f64, f64) = (680., 76.);
const QUICK_OPEN_HEIGHT: f64 = 520.;
const QUICK_MIN: (f64, f64) = (420., 240.);
/// Where the user left the bar: top-left corner, width, and the open height. Saved to
/// quick-window.json; without it the open box is centered on the screen in use.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct QuickFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
static QUICK_FRAME: std::sync::Mutex<Option<QuickFrame>> = std::sync::Mutex::new(None);
static QUICK_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Moves and resizes until this time (ms) are ours, not the user's, and are not remembered.
static QUICK_QUIET_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn quick_quiet() {
    QUICK_QUIET_UNTIL.store(now_ms() + 600, std::sync::atomic::Ordering::Relaxed);
}
/// When the menu bar panel last hid itself on losing focus, in ms since the epoch. A click on the
/// tray icon while the panel is open first takes its focus away; that click must not reopen it.
static PANEL_HIDDEN_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// When the menu bar panel last opened: the press that opened it is not a click elsewhere.
static PANEL_SHOWN_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// A mouse button was down on the last check, so only a new press counts.
static PANEL_PRESSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Called every frame (hit.rs): a mouse press outside the open menu bar panel hides it. The panel
/// is non-activating and not key-capable, so clicking back into the app that was already in front
/// never took focus from it and it stayed open (reported 2026-11-06). A press on the tray icon
/// hides it here too; the 300ms guard in `toggle_panel` keeps that click from reopening it.
pub fn hide_panel_on_outside_click(app: &tauri::AppHandle, mouse: tauri_nspanel::NSPoint) {
    use std::sync::atomic::Ordering::Relaxed;
    let pressed = tauri_nspanel::objc2_app_kit::NSEvent::pressedMouseButtons() != 0;
    let new_press = pressed && !PANEL_PRESSED.swap(pressed, Relaxed);
    if !pressed {
        PANEL_PRESSED.store(false, Relaxed);
    }
    if !new_press || now_ms().saturating_sub(PANEL_SHOWN_AT.load(Relaxed)) < 300 {
        return;
    }
    let Ok(panel) = app.get_webview_panel("panel") else {
        return;
    };
    let ns = panel.as_panel();
    if !ns.isVisible() || panel_holds(ns.frame(), mouse) {
        return;
    }
    PANEL_HIDDEN_AT.store(now_ms(), Relaxed);
    panel.hide();
}
fn panel_holds(frame: tauri_nspanel::NSRect, mouse: tauri_nspanel::NSPoint) -> bool {
    mouse.x >= frame.origin.x
        && mouse.x <= frame.origin.x + frame.size.width
        && mouse.y >= frame.origin.y
        && mouse.y <= frame.origin.y + frame.size.height
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Shows the menu bar panel under the tray icon, or hides it when it is already up.
pub fn toggle_panel(app: &tauri::AppHandle, icon: tauri::Rect) -> tauri::Result<()> {
    let Some(w) = app.get_webview_window("panel") else {
        return Ok(());
    };
    if w.is_visible()? {
        w.hide()?;
        return Ok(());
    }
    if now_ms().saturating_sub(PANEL_HIDDEN_AT.load(std::sync::atomic::Ordering::Relaxed)) < 300 {
        return Ok(());
    }
    // The icon's rect is in physical pixels of the screen it is on; that screen decides the scale.
    let at = icon.position.to_physical::<f64>(1.);
    let size = icon.size.to_physical::<f64>(1.);
    let monitor = w.available_monitors()?.into_iter().find(|m| {
        let p = m.position();
        let s = m.size();
        at.x >= p.x as f64
            && at.x < (p.x + s.width as i32) as f64
            && at.y >= p.y as f64
            && at.y < (p.y + s.height as i32) as f64
    });
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(2.);
    let x = (at.x + size.width / 2.) / scale - PANEL_SIZE.0 / 2.;
    let y = (at.y + size.height) / scale + 6.;
    // The page sizes the window to its content, so keep whatever height it set last.
    let height = w.outer_size()?.to_logical::<f64>(w.scale_factor()?).height;
    w.set_position(clamp(&w, x, y, PANEL_SIZE.0, height)?)?;
    PANEL_SHOWN_AT.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    match app.get_webview_panel("panel") {
        Ok(panel) => panel.show_and_make_key(),
        Err(_) => {
            w.show()?;
            w.set_focus()?;
        }
    }
    Ok(())
}

pub struct Paths {
    pub data: PathBuf,
    pub resources: PathBuf,
}

// Persist logical desktop coordinates, matching the Electron window-state contract.
pub fn persist(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("pet") else {
        return;
    };
    if let (Ok(p), Ok(scale)) = (w.outer_position(), w.scale_factor()) {
        let p = p.to_logical::<f64>(scale);
        persist_at(app, p.x, p.y);
    }
}

fn persist_at(app: &tauri::AppHandle, x: f64, y: f64) {
    let path = app.state::<Paths>().data.join("window-state.json");
    let result = std::fs::write(path, serde_json::json!({"x":x,"y":y}).to_string());
    if let Err(e) = result {
        eprintln!("Save window position: {e}");
    }
}

/// Set when the pet window was placed from the saved position. The saved position belongs to the
/// size the window had when it was saved, not to the default size it is created with.
static KEEP_ORIGIN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Where the pet window's top-left goes when it is resized: the bottom-right corner stays put,
/// except for the first resize after a restore, which keeps the saved top-left.
fn resized_origin(old: (f64, f64, f64, f64), new: (f64, f64), keep_origin: bool) -> (f64, f64) {
    let (x, y, w, h) = old;
    if keep_origin {
        (x, y)
    } else {
        (x + w - new.0, y + h - new.1)
    }
}

pub fn clamp(
    w: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> tauri::Result<LogicalPosition<f64>> {
    let monitors = w.available_monitors()?;
    let nearest = monitors.iter().min_by(|a, b| {
        let distance = |m: &tauri::Monitor| {
            let p = m.work_area().position.to_logical::<f64>(m.scale_factor());
            let s = m.work_area().size.to_logical::<f64>(m.scale_factor());
            (x - x.clamp(p.x, p.x + s.width)).powi(2) + (y - y.clamp(p.y, p.y + s.height)).powi(2)
        };
        distance(a).total_cmp(&distance(b))
    });
    if let Some(m) = nearest {
        let p = m.work_area().position.to_logical::<f64>(m.scale_factor());
        let s = m.work_area().size.to_logical::<f64>(m.scale_factor());
        Ok(LogicalPosition::new(
            x.clamp(p.x, p.x + (s.width - width).max(0.)),
            y.clamp(p.y, p.y + (s.height - height).max(0.)),
        ))
    } else {
        Ok(LogicalPosition::new(x, y))
    }
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let url = |label| WebviewUrl::App(format!("index.html?window={label}").into());
    let pet = WebviewWindowBuilder::new(app, "pet", url("pet"))
        .title("Familiar")
        .inner_size(460., 330.)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .visible(false)
        .build()?;
    let mut position = LogicalPosition::new(0., 0.);
    if let Some(m) = pet.primary_monitor()? {
        let p = m.work_area().position.to_logical::<f64>(m.scale_factor());
        let s = m.work_area().size.to_logical::<f64>(m.scale_factor());
        position = LogicalPosition::new(p.x + s.width - 460., p.y + s.height - 330.);
    }
    if let Ok(bytes) = std::fs::read(app.state::<Paths>().data.join("window-state.json")) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let (Some(x), Some(y)) = (v["x"].as_f64(), v["y"].as_f64()) {
                if x.is_finite() && y.is_finite() {
                    position = LogicalPosition::new(x, y);
                    KEEP_ORIGIN.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }
    }
    // A saved position is clamped after the first resize, with the size it was saved at.
    pet.set_position(if KEEP_ORIGIN.load(std::sync::atomic::Ordering::Relaxed) {
        position
    } else {
        clamp(&pet, position.x, position.y, 460., 330.)?
    })?;
    let panel = pet.to_panel::<PetPanel>()?;
    panel.set_level(PanelLevel::ScreenSaver.value());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .stationary()
            .value(),
    );
    panel
        .set_style_mask(
            StyleMask::empty()
                .borderless()
                .nonactivating_panel()
                .value(),
        )
        .map_err(|e| std::io::Error::other(format!("NSPanel style mask: {e:?}")))?;
    panel.set_has_shadow(false);
    pet.set_ignore_cursor_events(true)?;
    panel.show();
    let chat = WebviewWindowBuilder::new(app, "chat", url("chat"))
        .title("Familiar")
        // Files dragged in from Finder reach the page's drop handler; Tauri's own handler
        // takes every file drop and the composer never sees it.
        .disable_drag_drop_handler()
        .inner_size(380., 620.)
        .min_inner_size(360., 420.)
        .transparent(true)
        .decorations(false)
        .visible(false)
        .accept_first_mouse(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(16.)
                .build(),
        )
        .build()?
        .to_panel::<ChatPanel>()?;
    chat.set_collection_behavior(
        CollectionBehavior::new()
            .move_to_active_space()
            .full_screen_auxiliary()
            .value(),
    );
    // Like the pet panel: an activating panel spends the first click after the user was in
    // another app on activating Familiar, so buttons needed two clicks. Non-activating panels
    // become key without activating the app and take the click directly.
    chat.set_style_mask(
        StyleMask::empty()
            .borderless()
            .resizable()
            .nonactivating_panel()
            .value(),
    )
    .map_err(|e| std::io::Error::other(format!("Chat style mask: {e:?}")))?;
    WebviewWindowBuilder::new(app, "settings", url("settings"))
        .title("设置")
        .inner_size(760., 600.)
        .min_inner_size(680., 500.)
        .accept_first_mouse(true)
        .visible(false)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Sidebar)
                .state(EffectState::Active)
                .build(),
        )
        .build()?;
    WebviewWindowBuilder::new(app, "main", url("main"))
        .title("Familiar")
        // Files dragged in from Finder reach the page's drop handler; Tauri's own handler
        // takes every file drop and the composer never sees it.
        .disable_drag_drop_handler()
        .inner_size(1040., 760.)
        .min_inner_size(720., 520.)
        .accept_first_mouse(true)
        .visible(false)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Sidebar)
                .state(EffectState::Active)
                .build(),
        )
        .build()?;
    // Opening settings or the big window shows it on the current desktop instead of switching
    // to the desktop it was last on.
    for label in ["settings", "main"] {
        move_to_active_space(&app.get_webview_window(label).unwrap())?;
    }
    let quick = WebviewWindowBuilder::new(app, "quick", url("quick"))
        .title("Familiar")
        // Files dragged in from Finder reach the page's drop handler; Tauri's own handler
        // takes every file drop and the composer never sees it.
        .disable_drag_drop_handler()
        .inner_size(QUICK_SIZE.0, QUICK_SIZE.1)
        .min_inner_size(QUICK_MIN.0, QUICK_SIZE.1)
        .transparent(true)
        .decorations(false)
        .resizable(true)
        .skip_taskbar(true)
        .visible(false)
        .accept_first_mouse(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(18.)
                .build(),
        )
        .build()?
        .to_panel::<QuickPanel>()?;
    quick.set_level(PanelLevel::PopUpMenu.value());
    // Like the pet: on every Space, so switching desktops keeps the bar where it is.
    quick.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .stationary()
            .full_screen_auxiliary()
            .value(),
    );
    quick
        .set_style_mask(
            StyleMask::empty()
                .borderless()
                .resizable()
                .nonactivating_panel()
                .value(),
        )
        .map_err(|e| std::io::Error::other(format!("Quick panel style mask: {e:?}")))?;
    if let Ok(bytes) = std::fs::read(app.state::<Paths>().data.join("quick-window.json")) {
        if let Ok(f) = serde_json::from_slice::<QuickFrame>(&bytes) {
            if [f.x, f.y, f.width, f.height].iter().all(|v| v.is_finite())
                && f.width >= QUICK_MIN.0
                && f.height >= QUICK_MIN.1
            {
                *QUICK_FRAME.lock().unwrap() = Some(f);
            }
        }
    }
    let tray_panel = WebviewWindowBuilder::new(app, "panel", url("panel"))
        .title("Familiar")
        .inner_size(PANEL_SIZE.0, PANEL_SIZE.1)
        .transparent(true)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .accept_first_mouse(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(12.)
                .build(),
        )
        .build()?
        .to_panel::<TrayPanel>()?;
    tray_panel.set_level(PanelLevel::PopUpMenu.value());
    tray_panel.set_collection_behavior(
        CollectionBehavior::new()
            .move_to_active_space()
            .full_screen_auxiliary()
            .value(),
    );
    tray_panel
        .set_style_mask(
            StyleMask::empty()
                .borderless()
                .nonactivating_panel()
                .value(),
        )
        .map_err(|e| std::io::Error::other(format!("Tray panel style mask: {e:?}")))?;
    {
        let h = app.clone();
        app.get_webview_window("panel")
            .unwrap()
            .on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    if let Some(w) = h.get_webview_window("panel") {
                        if w.is_visible().unwrap_or(false) {
                            PANEL_HIDDEN_AT.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
                            let _ = w.hide();
                        }
                    }
                }
            });
    }
    for label in ["pet", "chat", "settings", "main", "quick"] {
        let w = app.get_webview_window(label).unwrap();
        let h = app.clone();
        w.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if label != "pet" => {
                api.prevent_close();
                if let Some(w) = h.get_webview_window(label) {
                    let _ = w.hide();
                }
                if label == "chat" {
                    chat_signal(&h);
                }
                if label == "main" {
                    leave_dock(&h);
                    main_signal(&h);
                }
            }
            tauri::WindowEvent::CloseRequested { .. } => h.exit(0),
            tauri::WindowEvent::Moved(_) if label == "chat" => settle_chat(&h),
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) if label == "quick" => {
                remember_quick(&h)
            }
            tauri::WindowEvent::Focused(focused) => {
                if !*focused && label != "settings" {
                    report_blur(&h);
                }
                if label == "chat" {
                    chat_signal(&h);
                }
                if label == "main" {
                    main_signal(&h);
                }
            }
            _ => {}
        });
    }
    Ok(())
}

/// Tell the agent the user went elsewhere: the pet or chat lost focus and, a beat later, none of
/// our windows has it. The delay lets focus move between our own windows (chat collapsing into
/// the capsule, opening settings) without counting as leaving.
fn report_blur(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let ours = ["pet", "chat", "settings", "main", "quick"].iter().any(|label| {
                main.get_webview_window(label)
                    .and_then(|w| w.is_focused().ok())
                    .unwrap_or(false)
            });
            if !ours {
                crate::agent::signal(&main, serde_json::json!({"name":"blurred"}));
            }
        });
    });
}

/// Pull the chat panel back on screen once a drag has stopped. Moved fires all through a drag,
/// so only the last event in a 400ms quiet window acts; clamping mid-drag would fight the hand.
fn settle_chat(app: &tauri::AppHandle) {
    static MOVES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seen = MOVES.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        if MOVES.load(std::sync::atomic::Ordering::Relaxed) != seen {
            return;
        }
        let main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(chat) = main.get_webview_window("chat") else {
                return;
            };
            let place = || -> tauri::Result<()> {
                let scale = chat.scale_factor()?;
                let p = chat.outer_position()?.to_logical::<f64>(scale);
                let s = chat.outer_size()?.to_logical::<f64>(scale);
                let to = clamp(&chat, p.x, p.y, s.width, s.height)?;
                if (to.x - p.x).abs() > 0.5 || (to.y - p.y).abs() > 0.5 {
                    chat.set_position(to)?;
                }
                Ok(())
            };
            if let Err(e) = place() {
                eprintln!("Keep chat on screen: {e}");
            }
        });
    });
}

pub fn chat_signal(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("chat") {
        crate::agent::signal(
            app,
            serde_json::json!({"name":"chat-window","visible":w.is_visible().unwrap_or(false),"focused":w.is_focused().unwrap_or(false)}),
        );
    }
}

pub fn main_signal(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        crate::agent::signal(
            app,
            serde_json::json!({"name":"main-window","visible":w.is_visible().unwrap_or(false),"focused":w.is_focused().unwrap_or(false)}),
        );
    }
}

/// Back to a Dock-less accessory app once the conversation window is closed.
fn leave_dock(app: &tauri::AppHandle) {
    if std::env::var_os("FAMILIAR_SHOW_DOCK").is_none() {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

pub fn action(app: &tauri::AppHandle, action: crate::protocol::UiAction) -> tauri::Result<()> {
    use crate::protocol::UiAction;
    match action {
        UiAction::ShowChat => {
            let pet = app.get_webview_window("pet").unwrap();
            let chat = app.get_webview_window("chat").unwrap();
            let scale = pet.scale_factor()?;
            let p = pet.outer_position()?.to_logical::<f64>(scale);
            let s = pet.outer_size()?.to_logical::<f64>(scale);
            let c = chat.outer_size()?.to_logical::<f64>(chat.scale_factor()?);
            chat.set_position(clamp(
                &chat,
                p.x + s.width - s.width * 192. * 0.73 / 460. - c.width - 8.,
                p.y + s.height - c.height,
                c.width,
                c.height,
            )?)?;
            // Make the panel key right away: the capsule in the non-activating pet panel usually
            // holds focus, and a non-key panel spends the first click on activation (approve
            // buttons needed two clicks).
            match app.get_webview_panel("chat") {
                Ok(panel) => panel.show_and_make_key(),
                Err(_) => {
                    chat.show()?;
                    chat.set_focus()?;
                }
            }
            chat_signal(app);
        }
        UiAction::HideChat => {
            app.get_webview_window("chat").unwrap().hide()?;
            chat_signal(app);
        }
        UiAction::ShowQuick => {
            let w = app.get_webview_window("quick").unwrap();
            let scale = w.scale_factor()?;
            let now = w.outer_size()?.to_logical::<f64>(scale);
            let saved = *QUICK_FRAME.lock().unwrap();
            // Where the user left it when that is on the screen in use; otherwise the open box
            // centered there, at the size the user gave it.
            let area = screen_in_use(app);
            let (width, open) = saved.map_or((QUICK_SIZE.0, QUICK_OPEN_HEIGHT), |f| (f.width, f.height));
            let place = match (saved, area) {
                (Some(f), Some(a)) if a.holds(f.x + f.width / 2., f.y + f.height / 2.) => {
                    Some((f.x, f.y, width, open))
                }
                (Some(f), None) => Some((f.x, f.y, width, open)),
                (_, Some(a)) => Some((
                    a.x + (a.width - width) / 2.,
                    a.y + ((a.height - open) / 2.).max(0.),
                    width,
                    open,
                )),
                (None, None) => None,
            };
            if let Some((x, y, width, open)) = place {
                quick_quiet();
                w.set_size(LogicalSize::new(width, now.height))?;
                // Kept on a screen with room for the open box, so opening never runs off the edge.
                w.set_position(clamp(&w, x, y, width, open)?)?;
            }
            if let Ok(panel) = app.get_webview_panel("quick") {
                panel.show_and_make_key();
            }
        }
        UiAction::HideQuick => {
            if let Ok(panel) = app.get_webview_panel("quick") {
                panel.hide();
            }
        }
        UiAction::FocusPet => {
            if let Ok(panel) = app.get_webview_panel("pet") {
                panel.make_key_window();
            }
        }
        UiAction::ShowMain => {
            // A regular app while the window is open: it gets a Dock icon and a place in ⌘Tab.
            app.set_activation_policy(tauri::ActivationPolicy::Regular)?;
            show_here(app, "main")?;
            main_signal(app);
        }
        UiAction::Shortcuts { bindings } => crate::shortcuts::apply(app, &bindings),
        UiAction::PetVisible { visible } => {
            if let Ok(panel) = app.get_webview_panel("pet") {
                if visible {
                    panel.show();
                } else {
                    panel.hide();
                }
            }
        }
        UiAction::ShowSettings => {
            show_here(app, "settings")?;
        }
        UiAction::PetSize { width, height } => {
            if !width.is_finite() || !height.is_finite() || width <= 0. || height <= 0. {
                return Ok(());
            }
            let w = app.get_webview_window("pet").unwrap();
            let scale = w.scale_factor()?;
            let p = w.outer_position()?.to_logical::<f64>(scale);
            let s = w.outer_size()?.to_logical::<f64>(scale);
            w.set_size(LogicalSize::new(width, height))?;
            let (x, y) = resized_origin(
                (p.x, p.y, s.width, s.height),
                (width, height),
                KEEP_ORIGIN.swap(false, std::sync::atomic::Ordering::Relaxed),
            );
            let at = clamp(&w, x, y, width, height)?;
            w.set_position(at)?;
            // set_position lands on the main queue after this call: save what was set, not what reads back.
            persist_at(app, at.x, at.y);
        }
        UiAction::Tray {
            pets,
            current_pet,
            size,
            perception,
        } => crate::tray::rebuild(app, &pets, &current_pet, &size, &perception)?,
        UiAction::PanelOpacity { value, windows } => {
            // The windows' own blur material sits under the page, so the window itself fades.
            if value.is_finite() {
                let value = value.clamp(0.5, 1.);
                for label in ["chat", "panel"] {
                    if let Ok(panel) = app.get_webview_panel(label) {
                        panel.set_alpha_value(value);
                    }
                }
            }
            if windows.is_finite() {
                set_window_alpha(app, windows.clamp(0.5, 1.));
            }
        }
        UiAction::Quit => app.exit(0),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::resized_origin;

    #[test]
    fn resize_keeps_the_bottom_right_corner() {
        assert_eq!(
            resized_origin((100., 200., 460., 330.), (316., 227.), false),
            (244., 303.)
        );
    }

    #[test]
    fn first_resize_after_restore_keeps_the_saved_origin() {
        assert_eq!(
            resized_origin((1222., 833., 460., 330.), (316., 227.), true),
            (1222., 833.)
        );
    }
}

/// The settings and big windows are ordinary NSWindows (not panels), so their alpha is set directly.
fn set_window_alpha(app: &tauri::AppHandle, value: f64) {
    use tauri_nspanel::objc2::msg_send;
    use tauri_nspanel::objc2_app_kit::NSWindow;
    for label in ["settings", "main"] {
        let Some(w) = app.get_webview_window(label) else {
            continue;
        };
        if let Ok(ptr) = w.ns_window() {
            // SAFETY: tauri hands back the live NSWindow of this webview; called on the main thread.
            let window = unsafe { &*(ptr as *const NSWindow) };
            let _: () = unsafe { msg_send![window, setAlphaValue: value] };
        }
    }
}

/// The quick-ask bar closed to its field or open to its box. Keeps the top edge where it is;
/// the open box grows downward with the system's window animation when the bar is on screen.
#[tauri::command]
pub fn quick_fit(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    collapsed: f64,
    open: bool,
    animate: bool,
) -> Result<(), String> {
    if window.label() != "quick" {
        return Err("Quick window required".into());
    }
    if !collapsed.is_finite() || !(40. ..=400.).contains(&collapsed) {
        return Err("Invalid height".into());
    }
    let main = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = fit_quick(&main, collapsed, open, animate) {
            eprintln!("Fit quick bar: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

fn fit_quick(app: &tauri::AppHandle, collapsed: f64, open: bool, animate: bool) -> tauri::Result<()> {
    use tauri_nspanel::objc2_foundation::{NSPoint, NSRect, NSSize};
    QUICK_OPEN.store(open, std::sync::atomic::Ordering::Relaxed);
    let w = app.get_webview_window("quick").unwrap();
    let height = if open {
        QUICK_FRAME.lock().unwrap().map_or(QUICK_OPEN_HEIGHT, |f| f.height)
    } else {
        collapsed
    };
    // Open: any height. Closed: the field's height only, so a drag at the edge changes the width.
    if open {
        w.set_max_size(None::<LogicalSize<f64>>)?;
        w.set_min_size(Some(LogicalSize::new(QUICK_MIN.0, QUICK_MIN.1)))?;
    } else {
        w.set_min_size(Some(LogicalSize::new(QUICK_MIN.0, 40.)))?;
        w.set_max_size(None::<LogicalSize<f64>>)?;
    }
    let Ok(panel) = app.get_webview_panel("quick") else {
        return Ok(());
    };
    let ns = panel.as_panel();
    let frame = ns.frame();
    if (frame.size.height - height).abs() >= 0.5 {
        // AppKit measures from the bottom: keeping the top means moving the origin down.
        let top = frame.origin.y + frame.size.height;
        let to = NSRect::new(
            NSPoint::new(frame.origin.x, top - height),
            NSSize::new(frame.size.width, height),
        );
        quick_quiet();
        ns.setFrame_display_animate(to, true, animate && w.is_visible()?);
    }
    if !open {
        w.set_min_size(Some(LogicalSize::new(QUICK_MIN.0, height)))?;
        w.set_max_size(Some(LogicalSize::new(100_000., height)))?;
    }
    Ok(())
}

/// The user moved or resized the bar: remember it, and write it once they stop.
fn remember_quick(app: &tauri::AppHandle) {
    if now_ms() < QUICK_QUIET_UNTIL.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Some(w) = app.get_webview_window("quick") else {
        return;
    };
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    let read = || -> tauri::Result<QuickFrame> {
        let scale = w.scale_factor()?;
        let p = w.outer_position()?.to_logical::<f64>(scale);
        let s = w.outer_size()?.to_logical::<f64>(scale);
        Ok(QuickFrame { x: p.x, y: p.y, width: s.width, height: s.height })
    };
    let Ok(now) = read() else {
        return;
    };
    {
        let mut saved = QUICK_FRAME.lock().unwrap();
        let open = QUICK_OPEN.load(std::sync::atomic::Ordering::Relaxed);
        let height = if open {
            now.height.max(QUICK_MIN.1)
        } else {
            saved.map_or(QUICK_OPEN_HEIGHT, |f| f.height)
        };
        *saved = Some(QuickFrame { height, ..now });
    }
    static CHANGES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seen = CHANGES.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let path = app.state::<Paths>().data.join("quick-window.json");
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        if CHANGES.load(std::sync::atomic::Ordering::Relaxed) != seen {
            return;
        }
        let frame = *QUICK_FRAME.lock().unwrap();
        if let Some(f) = frame {
            if let Ok(bytes) = serde_json::to_vec(&f) {
                if let Err(e) = std::fs::write(&path, bytes) {
                    eprintln!("Save quick bar place: {e}");
                }
            }
        }
    });
}

fn move_to_active_space(w: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri_nspanel::objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let ptr = w.ns_window()? as *const NSWindow;
    // SAFETY: Tauri hands back the live NSWindow of this webview window; setup runs on the main thread.
    if let Some(ns) = unsafe { ptr.as_ref() } {
        ns.setCollectionBehavior(
            ns.collectionBehavior() | NSWindowCollectionBehavior::MoveToActiveSpace,
        );
    }
    Ok(())
}

/// A screen's work area in top-left points, the space window positions use.
#[derive(Clone, Copy)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl Area {
    fn holds(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// The screen the user is working on: the one holding the front window of the frontmost app.
/// Read before Familiar activates. The pointer was not a good guide: with two displays it often
/// rests on the screen the user is not looking at. Without a front window, the primary screen.
fn screen_in_use(app: &tauri::AppHandle) -> Option<Area> {
    let monitors = app.available_monitors().ok()?;
    let area_of = |x: f64, y: f64| {
        monitors.iter().find_map(|m| {
            let scale = m.scale_factor();
            let p = m.position().to_logical::<f64>(scale);
            let s = m.size().to_logical::<f64>(scale);
            let screen = Area { x: p.x, y: p.y, width: s.width, height: s.height };
            screen.holds(x, y).then(|| {
                let p = m.work_area().position.to_logical::<f64>(scale);
                let s = m.work_area().size.to_logical::<f64>(scale);
                Area { x: p.x, y: p.y, width: s.width, height: s.height }
            })
        })
    };
    front_window_center()
        .and_then(|(x, y)| area_of(x, y))
        .or_else(|| {
            let m = app.primary_monitor().ok()??;
            let scale = m.scale_factor();
            let p = m.work_area().position.to_logical::<f64>(scale);
            let s = m.work_area().size.to_logical::<f64>(scale);
            Some(Area { x: p.x, y: p.y, width: s.width, height: s.height })
        })
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut std::ffi::c_void;
}

/// Center (top-left points) of the frontmost app's frontmost ordinary window. Window bounds and
/// owners are readable without screen recording permission; titles are not needed.
fn front_window_center() -> Option<(f64, f64)> {
    use tauri_nspanel::objc2::rc::Retained;
    use tauri_nspanel::objc2::runtime::AnyObject;
    use tauri_nspanel::objc2_app_kit::NSWorkspace;
    use tauri_nspanel::objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
    let pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()?
        .processIdentifier();
    // On-screen windows only, front to back, without the desktop.
    let raw = unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) };
    if raw.is_null() {
        return None;
    }
    // SAFETY: a CFArray of CFDictionary, toll-free bridged; the copy is ours to release.
    let list: Retained<NSArray<NSDictionary<NSString, AnyObject>>> =
        unsafe { Retained::from_raw(raw.cast())? };
    let number = |d: &NSDictionary<NSString, AnyObject>, key: &str| -> Option<f64> {
        let v = d.objectForKey(&NSString::from_str(key))?;
        Some(v.downcast::<NSNumber>().ok()?.as_f64())
    };
    for d in list.iter() {
        if number(&d, "kCGWindowOwnerPID")? as i32 != pid || number(&d, "kCGWindowLayer")? != 0. {
            continue;
        }
        let bounds = d.objectForKey(&NSString::from_str("kCGWindowBounds"))?;
        let bounds = bounds.downcast::<NSDictionary>().ok()?;
        // SAFETY: the bounds dictionary maps NSString keys to NSNumber values.
        let bounds: &NSDictionary<NSString, AnyObject> = unsafe { &*(&*bounds as *const NSDictionary).cast() };
        let (x, y) = (number(bounds, "X")?, number(bounds, "Y")?);
        let (w, h) = (number(bounds, "Width")?, number(bounds, "Height")?);
        if w < 100. || h < 100. {
            continue;
        }
        return Some((x + w / 2., y + h / 2.));
    }
    None
}

/// Opens a big window on the screen and desktop the user is on. A window already open on another
/// desktop is hidden and placed first, so showing it again brings it here (MoveToActiveSpace acts
/// only when a window comes on screen) instead of switching the user away.
fn show_here(app: &tauri::AppHandle, label: &'static str) -> tauri::Result<()> {
    let w = app.get_webview_window(label).unwrap();
    let area = screen_in_use(app);
    if w.is_visible()? && !on_active_space(&w)? {
        w.hide()?;
    }
    if let Some(area) = area {
        onto_screen(&w, area)?;
    }
    w.unminimize()?;
    w.show()?;
    w.set_focus()?;
    // The system can still nudge a window it has just brought over; put it back, whole.
    if let Some(area) = area {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = main.get_webview_window(label) {
                    if let Err(e) = onto_screen(&w, area) {
                        eprintln!("Keep {label} on screen: {e}");
                    }
                }
            });
        });
    }
    Ok(())
}

fn on_active_space(w: &tauri::WebviewWindow) -> tauri::Result<bool> {
    use tauri_nspanel::objc2_app_kit::NSWindow;
    let ptr = w.ns_window()? as *const NSWindow;
    // SAFETY: the live NSWindow of this webview window, used on the main thread.
    Ok(unsafe { ptr.as_ref() }.is_none_or(|ns| ns.isOnActiveSpace()))
}

/// Keeps a window where it is when it is already on this screen, else centers it there.
fn onto_screen(w: &tauri::WebviewWindow, area: Area) -> tauri::Result<()> {
    let scale = w.scale_factor()?;
    let p = w.outer_position()?.to_logical::<f64>(scale);
    let s = w.outer_size()?.to_logical::<f64>(scale);
    let (x, y) = if area.holds(p.x + s.width / 2., p.y + s.height / 2.) {
        (p.x, p.y)
    } else {
        (area.x + (area.width - s.width) / 2., area.y + (area.height - s.height) / 2.)
    };
    let to = LogicalPosition::new(
        x.clamp(area.x, area.x + (area.width - s.width).max(0.)),
        y.clamp(area.y, area.y + (area.height - s.height).max(0.)),
    );
    if (to.x - p.x).abs() > 0.5 || (to.y - p.y).abs() > 0.5 {
        w.set_position(to)?;
    }
    Ok(())
}
