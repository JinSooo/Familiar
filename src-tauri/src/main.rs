mod agent;
mod hit;
mod protocol;
mod shortcuts;
mod tray;
mod windows;
use tauri::Manager;
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(shortcuts::plugin())
        .manage(shortcuts::Bindings::default())
        .manage(agent::Agent::default())
        .manage(hit::Hit::default())
        .invoke_handler(tauri::generate_handler![
            agent::familiar_invoke,
            hit::pet_hit,
            hit::pet_drag_start,
            tray::pet_menu
        ])
        .register_uri_scheme_protocol("familiar-pet", |ctx, request| {
            let paths = ctx.app_handle().state::<windows::Paths>();
            protocol::serve(&paths.resources, &paths.data, &request.uri().to_string())
        })
        .setup(|app| {
            if std::env::var_os("FAMILIAR_SHOW_DOCK").is_none() {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let data = match std::env::var_os("FAMILIAR_DATA_DIR") {
                Some(dir) => std::path::PathBuf::from(dir),
                None => {
                    let home = app.path().home_dir()?;
                    let data = home.join(".familiar");
                    migrate(&home.join("Library/Application Support/Familiar"), &data);
                    data
                }
            };
            std::fs::create_dir_all(&data)?;
            // Owner-only, like ~/.ssh: mcp.json may hold tokens.
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700));
            }
            let resources = if cfg!(debug_assertions) {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources")
            } else {
                app.path().resource_dir()?
            };
            app.manage(windows::Paths { data, resources });
            windows::setup(app.handle())?;
            tray::setup(app.handle())?;
            agent::start(app.handle());
            hit::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Familiar startup failed");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { .. } => windows::persist(app),
        tauri::RunEvent::Exit => agent::stop(app),
        _ => {}
    });
}

/// One-time move of Familiar's own files from the old Application Support folder to
/// ~/.familiar (like ~/.codex). Leftovers from the Electron prototype (caches, cookies) stay
/// behind. Runs only while ~/.familiar does not exist yet.
fn migrate(old: &std::path::Path, new: &std::path::Path) {
    if new.exists() || !old.is_dir() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(new) {
        eprintln!("Create {}: {e}", new.display());
        return;
    }
    let ours = [
        "settings.json",
        "mcp.json",
        "window-state.json",
        "pet-greeting.txt",
        "reflected.json",
        "pets",
        "evals",
        "skills",
    ];
    for name in ours {
        let from = old.join(name);
        if from.exists() {
            if let Err(e) = std::fs::rename(&from, new.join(name)) {
                eprintln!("Move {}: {e}", from.display());
            }
        }
    }
    // The search index is a cache; the agent rebuilds it in the new place.
}

