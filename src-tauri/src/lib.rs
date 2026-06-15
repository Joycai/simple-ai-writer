mod commands;
mod protocol;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::scaffold_project,
            commands::read_dir_recursive,
        ]);

    protocol::register_asset_protocol(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
