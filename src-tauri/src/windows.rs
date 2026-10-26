use std::path::PathBuf;
use tauri::{
    window::{Effect, EffectState, EffectsBuilder},
    LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};

tauri_panel! {
    panel!(PetPanel { config: { can_become_key_window: true, is_floating_panel: true } })
    // Borderless NSWindows refuse key status, which swallowed first clicks and blocked typing.
    panel!(ChatPanel { config: { can_become_key_window: true, can_become_main_window: true } })
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
        let path = app.state::<Paths>().data.join("window-state.json");
        let result = std::fs::write(path, serde_json::json!({"x":p.x,"y":p.y}).to_string());
        if let Err(e) = result {
            eprintln!("Save window position: {e}");
        }
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
                }
            }
        }
    }
    pet.set_position(clamp(&pet, position.x, position.y, 460., 330.)?)?;
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
    WebviewWindowBuilder::new(app, "chat", url("chat"))
        .title("Familiar")
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
        .to_panel::<ChatPanel>()?
        .set_collection_behavior(
            CollectionBehavior::new()
                .move_to_active_space()
                .full_screen_auxiliary()
                .value(),
        );
    WebviewWindowBuilder::new(app, "settings", url("settings"))
        .title("设置")
        .inner_size(760., 600.)
        .min_inner_size(680., 500.)
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
    for label in ["pet", "chat", "settings"] {
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
            }
            tauri::WindowEvent::CloseRequested { .. } => h.exit(0),
            tauri::WindowEvent::Focused(focused) => {
                if *focused {
                    crate::agent::signal(&h, serde_json::json!({"name":"app-activated"}));
                }
                if label == "chat" {
                    chat_signal(&h);
                }
            }
            _ => {}
        });
    }
    Ok(())
}

pub fn chat_signal(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("chat") {
        crate::agent::signal(
            app,
            serde_json::json!({"name":"chat-window","visible":w.is_visible().unwrap_or(false),"focused":w.is_focused().unwrap_or(false)}),
        );
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
        UiAction::ShowSettings => {
            let w = app.get_webview_window("settings").unwrap();
            w.show()?;
            w.set_focus()?;
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
            w.set_position(clamp(
                &w,
                p.x + s.width - width,
                p.y + s.height - height,
                width,
                height,
            )?)?;
            persist(app);
        }
        UiAction::Tray {
            pets,
            current_pet,
            size,
        } => crate::tray::rebuild(app, &pets, &current_pet, &size)?,
        UiAction::Quit => app.exit(0),
    }
    Ok(())
}
