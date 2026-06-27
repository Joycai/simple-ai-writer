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
            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;

            // Set the app icon explicitly at runtime on the window (helps show custom icon on macOS Dock / Windows taskbar during `tauri dev`)
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
                window.set_icon(icon)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scaffold_project,
            commands::read_dir_recursive,
            commands::fs_write_binary_file,
            commands::fs_write_text_file,
            commands::fs_read_text_file,
            commands::fs_create_dir,
            commands::fs_exists,
            commands::fs_read_dir,
            commands::fs_remove_dir,
            commands::fs_remove_file,
        ]);

    protocol::register_asset_protocol(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
