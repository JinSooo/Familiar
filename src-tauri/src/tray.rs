//! Native application and tray menus. All actions go through the agent contract.
use serde_json::Value;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle,
};

const TRAY_ID: &str = "familiar";
const PET_PREFIX: &str = "pet-select:";
const SIZE_PREFIX: &str = "pet-size:";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let familiar = Submenu::with_items(
        app,
        "Familiar",
        true,
        &[
            &MenuItem::with_id(app, "settings:open", "设置…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:quit", "退出 Familiar", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &PredefinedMenuItem::close_window(app, Some("关闭"))?,
        ],
    )?;
    window.set_as_windows_menu_for_nsapp()?;
    app.set_menu(Menu::with_items(app, &[&familiar, &edit, &window])?)?;
    // App-level callbacks receive both menu-bar and tray actions, once per click.
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if let Some(pet) = id.strip_prefix(PET_PREFIX) {
            crate::agent::menu_request(app, "pets:select", &[Value::String(pet.to_owned())]);
        } else if let Some(size) = id.strip_prefix(SIZE_PREFIX) {
            crate::agent::menu_request(app, "pet:size-set", &[Value::String(size.to_owned())]);
        } else if matches!(
            id,
            "chat:toggle"
                | "chat:open"
                | "chat:history"
                | "session:new"
                | "settings:open"
                | "pets:import"
                | "app:quit"
        ) {
            crate::agent::menu_request(app, id, &[]);
        }
    });

    TrayIconBuilder::with_id(TRAY_ID)
        // Template icon drawn in icons/tray.svg, rendered at 2x so it stays sharp on Retina.
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Familiar")
        .show_menu_on_left_click(true)
        .build(app)?;
    rebuild(app, &[], "", "medium")
}

pub fn rebuild(
    app: &AppHandle,
    pets: &[crate::protocol::PetEntry],
    current_pet: &str,
    size: &str,
) -> tauri::Result<()> {
    let pet_menu = Submenu::new(app, "宠物", true)?;
    for pet in pets {
        pet_menu.append(&CheckMenuItem::with_id(
            app,
            format!("{PET_PREFIX}{}", pet.id),
            &pet.name,
            true,
            pet.id == current_pet,
            None::<&str>,
        )?)?;
    }
    let size_menu = Submenu::new(app, "大小", true)?;
    for (value, text) in [("small", "小"), ("medium", "中"), ("large", "大")] {
        size_menu.append(&CheckMenuItem::with_id(
            app,
            format!("{SIZE_PREFIX}{value}"),
            text,
            true,
            value == size,
            None::<&str>,
        )?)?;
    }
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "chat:open", "打开对话", true, None::<&str>)?,
            &MenuItem::with_id(app, "session:new", "新对话", true, None::<&str>)?,
            &MenuItem::with_id(app, "chat:history", "历史对话…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings:open", "设置…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &pet_menu,
            &size_menu,
            &MenuItem::with_id(
                app,
                "pets:import",
                "从 ChatGPT 导入宠物",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:quit", "退出", true, None::<&str>)?,
        ],
    )?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// Right-click on the pet: the conversation entry points. `x`/`y` are window-local logical
/// coordinates left of the pet's body: the pet panel sits above menus, so a menu at the cursor
/// would open underneath it.
#[tauri::command]
pub fn pet_menu(
    window: tauri::WebviewWindow,
    app: AppHandle,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("Pet window required".into());
    }
    let menu = Menu::with_items(
        &app,
        &[
            &MenuItem::with_id(&app, "chat:open", "打开对话", true, None::<&str>)
                .map_err(|e| e.to_string())?,
            &MenuItem::with_id(&app, "session:new", "新对话", true, None::<&str>)
                .map_err(|e| e.to_string())?,
            &MenuItem::with_id(&app, "chat:history", "历史对话…", true, None::<&str>)
                .map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &MenuItem::with_id(&app, "settings:open", "设置…", true, None::<&str>)
                .map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;
    window
        .popup_menu_at(&menu, tauri::LogicalPosition::new(x.max(0.), y.max(0.)))
        .map_err(|e| e.to_string())
}
