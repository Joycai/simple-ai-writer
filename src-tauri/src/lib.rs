mod commands;
mod preview;
mod print;
mod protocol;
mod scope;
mod secrets;
mod sqltx;
mod transfer;
mod xlsx;

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

            // Path scope for the custom fs_* commands: seed with the app's own
            // data/log dirs; project roots are added via the project_open_dialog
            // / project_register_root commands (see scope.rs).
            let fs_scope = scope::FsScope::new();
            if let Ok(dir) = app.path().app_data_dir() {
                fs_scope.allow(&dir);
            }
            if let Ok(dir) = app.path().app_log_dir() {
                fs_scope.allow(&dir);
            }
            app.manage(fs_scope);

            // Holds the document handed to the print window (see print.rs).
            app.manage(print::PendingPrint::default());

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
            commands::fs_copy,
            commands::fs_create_dir,
            commands::fs_exists,
            commands::fs_read_dir,
            commands::fs_remove_dir,
            commands::fs_remove_file,
            commands::fs_rename,
            commands::open_with_default_app,
            scope::project_open_dialog,
            scope::project_register_root,
            secrets::secret_save,
            secrets::secret_load,
            secrets::secret_delete,
            sqltx::sqlite_transaction,
            transfer::zip_export_dialog,
            transfer::zip_import_dialog,
            transfer::save_text_file_dialog,
            transfer::open_text_file_dialog,
            xlsx::xlsx_to_markdown,
            print::print_document,
            preview::preview_html_window,
        ]);

    let builder = protocol::register_asset_protocol(builder);
    let builder = preview::register_preview_protocol(builder);
    print::register_print_protocol(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
