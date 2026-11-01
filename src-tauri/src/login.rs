//! Open at login, through the system's own login items (SMAppService). Only the shell can
//! register the app bundle, so this lives here rather than in the agent.
use objc2_service_management::{SMAppService, SMAppServiceStatus};

/// "on", "off", or "approval" when the user has to allow it in System Settings › Login Items.
fn state() -> &'static str {
    let status = unsafe { SMAppService::mainAppService().status() };
    if status == SMAppServiceStatus::Enabled {
        "on"
    } else if status == SMAppServiceStatus::RequiresApproval {
        "approval"
    } else {
        "off"
    }
}

#[tauri::command]
pub fn login_item(window: tauri::WebviewWindow) -> Result<&'static str, String> {
    if window.label() != "settings" {
        return Err("Settings window required".into());
    }
    Ok(state())
}

#[tauri::command]
pub fn set_login_item(window: tauri::WebviewWindow, on: bool) -> Result<&'static str, String> {
    if window.label() != "settings" {
        return Err("Settings window required".into());
    }
    let service = unsafe { SMAppService::mainAppService() };
    let result = if on {
        unsafe { service.registerAndReturnError() }
    } else {
        unsafe { service.unregisterAndReturnError() }
    };
    result.map_err(|e| e.localizedDescription().to_string())?;
    Ok(state())
}
