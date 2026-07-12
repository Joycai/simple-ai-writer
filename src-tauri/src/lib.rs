mod commands;
mod protocol;
mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            use tauri::Manager;

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
            commands::fs_append_text_file,
            commands::fs_create_dir,
            commands::fs_exists,
            commands::fs_read_dir,
            commands::fs_remove_dir,
            commands::fs_remove_file,
            commands::fs_rename,
            secrets::secret_save,
            secrets::secret_load,
            secrets::secret_delete,
        ]);

    protocol::register_asset_protocol(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
