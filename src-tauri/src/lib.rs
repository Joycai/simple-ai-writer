mod commands;
mod protocol;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            use tauri::Manager;
            let salt_path = app
                .path()
                .app_local_data_dir()
                .expect("could not resolve app local data path")
                .join("salt.txt");
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build()
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scaffold_project,
            commands::read_dir_recursive,
        ]);

    protocol::register_asset_protocol(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
