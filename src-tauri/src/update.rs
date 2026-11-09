//! In-app updates from GitHub Releases (tauri-plugin-updater). The shell checks 30 s after
//! launch and then once a day; the menu bar panel and 设置 › 通用 offer 更新到 x.y.z, which
//! downloads the signed archive, verifies it, replaces the app and restarts. Nothing installs
//! until the user asks. While it runs, the windows get the bytes received so far, then a
//! separate 「正在安装」 step. Debug builds never check on their own and cannot install.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// Bytes downloaded so far and the archive size (0 while unknown).
    received: AtomicU64,
    total: AtomicU64,
    /// The download is done; the archive is being verified and the app replaced.
    unpacking: AtomicBool,
}

#[derive(Clone, Serialize)]
pub struct UpdateState {
    current: String,
    available: Option<String>,
    installing: bool,
    received: u64,
    total: Option<u64>,
    unpacking: bool,
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
        received: updates.received.load(Ordering::SeqCst),
        total: Some(updates.total.load(Ordering::SeqCst)).filter(|&t| t > 0),
        unpacking: updates.unpacking.load(Ordering::SeqCst),
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
    let updates = app.state::<Updates>();
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    updates.received.store(0, Ordering::SeqCst);
    updates.total.store(0, Ordering::SeqCst);
    updates.unpacking.store(false, Ordering::SeqCst);
    broadcast(&app);
    // Tell the windows at each whole percent (each MB when the size is unknown), not per chunk.
    let mut shown = 0;
    let on_chunk = |chunk: usize, total: Option<u64>| {
        let updates = app.state::<Updates>();
        let received = updates.received.fetch_add(chunk as u64, Ordering::SeqCst) + chunk as u64;
        updates.total.store(total.unwrap_or(0), Ordering::SeqCst);
        let step = match total {
            Some(t) if t > 0 => received * 100 / t,
            _ => received >> 20,
        };
        if step != shown {
            shown = step;
            broadcast(&app);
        }
    };
    let on_finish = || {
        app.state::<Updates>()
            .unpacking
            .store(true, Ordering::SeqCst);
        broadcast(&app);
    };
    match update.download_and_install(on_chunk, on_finish).await {
        // ExitRequested and Exit still run, so window state is saved and the agent stops.
        Ok(()) => {
            app.request_restart();
            Ok(())
        }
        Err(e) => {
            let updates = app.state::<Updates>();
            updates.installing.store(false, Ordering::SeqCst);
            updates.unpacking.store(false, Ordering::SeqCst);
            broadcast(&app);
            Err(format!("更新没有完成：{e}"))
        }
    }
}
