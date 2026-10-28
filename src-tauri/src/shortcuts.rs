use std::{collections::HashMap, sync::Mutex};
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Registered shortcut id → the action the agent knows it by (summon, main, togglePet, newChat).
#[derive(Default)]
pub struct Bindings(Mutex<HashMap<u32, String>>);

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let action = app.state::<Bindings>().0.lock().unwrap().get(&shortcut.id()).cloned();
            if let Some(action) = action {
                crate::agent::menu_request(app, "shortcut:fire", &[serde_json::Value::String(action)]);
            }
        })
        .build()
}

/// Replace all global shortcuts; tells the agent which ones the system refused.
pub fn apply(app: &tauri::AppHandle, bindings: &HashMap<String, String>) {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let mut registered = HashMap::new();
    let mut failed = Vec::new();
    for (action, accelerator) in bindings {
        if accelerator.trim().is_empty() {
            continue;
        }
        let result = accelerator
            .parse::<Shortcut>()
            .map_err(|e| e.to_string())
            .and_then(|s| shortcuts.register(s).map(|_| s).map_err(|e| e.to_string()));
        match result {
            Ok(s) => {
                registered.insert(s.id(), action.clone());
            }
            Err(error) => failed.push(serde_json::json!({
                "action": action, "accelerator": accelerator, "error": error
            })),
        }
    }
    *app.state::<Bindings>().0.lock().unwrap() = registered;
    crate::agent::signal(app, serde_json::json!({"name": "shortcut-status", "failed": failed}));
}
