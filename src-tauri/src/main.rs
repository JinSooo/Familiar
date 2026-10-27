mod agent;
mod hit;
mod protocol;
mod tray;
mod windows;
use tauri::Manager;
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
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
            let data = std::env::var_os("FAMILIAR_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(
                    app.path()
                        .home_dir()?
                        .join("Library/Application Support/Familiar"),
                );
            std::fs::create_dir_all(&data)?;
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
