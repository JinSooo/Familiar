//! In-app updates from GitHub Releases (tauri-plugin-updater). The shell checks 30 s after
//! launch and then once a day; the menu bar panel and 设置 › 通用 offer 更新到 x.y.z, which
//! downloads the signed archive, verifies it, replaces the app and restarts. Nothing installs
//! until the user asks. Debug builds never check on their own and cannot install.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// Windows that show the update and may ask for it.
const WINDOWS: [&str; 2] = ["panel", "settings"];

#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Update>>,
    checked: Mutex<Option<SystemTime>>,
    installing: AtomicBool,
}

#[derive(Clone, Serialize)]
pub struct UpdateState {
    current: String,
    available: Option<String>,
    installing: bool,
}

fn snapshot(app: &AppHandle) -> UpdateState {
    let updates = app.state::<Updates>();
    let available = updates
        .found
        .lock()
        .unwrap()
        .as_ref()
        .map(|u| u.version.clone());
    UpdateState {
        current: app.package_info().version.to_string(),
        available,
        installing: updates.installing.load(Ordering::SeqCst),
    }
}

fn broadcast(app: &AppHandle) {
    let state = snapshot(app);
    for window in WINDOWS {
        let _ = app.emit_to(window, "update:state", &state);
    }
}

fn allowed(window: &WebviewWindow) -> Result<(), String> {
    if WINDOWS.contains(&window.label()) {
        Ok(())
    } else {
        Err("Menu bar panel or settings window required".into())
    }
}

async fn check(app: &AppHandle) -> Result<UpdateState, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let updates = app.state::<Updates>();
    *updates.checked.lock().unwrap() = Some(SystemTime::now());
    let changed = {
        let mut found = updates.found.lock().unwrap();
        let before = found.as_ref().map(|u| u.version.clone());
        let after = update.as_ref().map(|u| u.version.clone());
        *found = update;
        before != after
    };
    if changed {
        broadcast(app);
    }
    Ok(snapshot(app))
}

/// Background checks: 30 s after launch, then whenever a day has passed by the wall clock
/// (looked at hourly, so a Mac that slept through the night still checks in the morning).
/// A failed check is retried at the next hourly look.
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        loop {
            let due = app
                .state::<Updates>()
                .checked
                .lock()
                .unwrap()
                .is_none_or(|t| t.elapsed().map_or(true, |e| e >= DAY));
            if due {
                if let Err(e) = tauri::async_runtime::block_on(check(&app)) {
                    eprintln!("Update check: {e}");
                }
            }
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

#[tauri::command]
pub fn update_state(window: WebviewWindow) -> Result<UpdateState, String> {
    allowed(&window)?;
    Ok(snapshot(window.app_handle()))
}

#[tauri::command]
pub async fn update_check(window: WebviewWindow) -> Result<UpdateState, String> {
    allowed(&window)?;
    check(window.app_handle())
        .await
        .map_err(|e| format!("检查更新失败：{e}"))
}

#[tauri::command]
pub async fn update_install(window: WebviewWindow) -> Result<(), String> {
    allowed(&window)?;
    if cfg!(debug_assertions) {
        return Err("开发版不能更新，请用打包好的 Familiar".into());
    }
    let app = window.app_handle().clone();
    let update = app.state::<Updates>().found.lock().unwrap().clone();
    let Some(update) = update else {
        return Err("没有可用的更新".into());
    };
    if app.state::<Updates>().installing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    broadcast(&app);
    match update.download_and_install(|_, _| {}, || {}).await {
        // ExitRequested and Exit still run, so window state is saved and the agent stops.
        Ok(()) => {
            app.request_restart();
            Ok(())
        }
        Err(e) => {
            app.state::<Updates>()
                .installing
                .store(false, Ordering::SeqCst);
            broadcast(&app);
            Err(format!("更新没有完成：{e}"))
        }
    }
}
