mod commands;
mod docx;
mod instance;
mod lorehash;
mod pptx;
mod preview;
mod print;
mod protocol;
mod scope;
mod secrets;
mod sqltx;
mod transfer;
#[cfg(target_os = "macos")]
mod windowmenu;
mod xlsx;
mod xlsx_write;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
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

            // Multi-instance support (see instance.rs): the workspace locks
            // this window holds, the folder argv[1] may have named, and the
            // focus channel a sibling uses to bring this window forward when
            // the author re-opens a workspace this window already has.
            app.manage(instance::HeldLocks::default());
            app.manage(instance::LaunchProject::from_args());
            app.manage(instance::FocusPort(instance::start_focus_server(
                app.handle(),
            )));
            // The registry entry a sibling's 「Window」 menu lists. Here
            // rather than in the menu builder because that runs before
            // `setup` — the focus port would still be unknown. The frontend
            // renames this window as soon as it knows the project.
            instance::announce_instance(app.handle(), &app.package_info().name, None);

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
            instance::project_lock_acquire,
            instance::project_lock_release,
            instance::project_focus_existing,
            instance::launch_project_path,
            instance::spawn_new_instance,
            instance::set_window_title,
            secrets::secret_save,
            secrets::secret_load,
            secrets::secret_delete,
            secrets::secret_clear_all,
            sqltx::sqlite_transaction,
            transfer::zip_export_dialog,
            transfer::zip_import_dialog,
            transfer::zip_dir_to_path,
            transfer::unzip_from_path,
            commands::device_label,
            lorehash::lore_tree_hashes,
            lorehash::lore_entry_hash,
            transfer::save_text_file_dialog,
            transfer::open_text_file_dialog,
            xlsx::xlsx_to_markdown,
            xlsx_write::xlsx_write_workbook,
            docx::docx_read_layout,
            docx::docx_layout_from_bytes,
            pptx::pptx_to_markdown,
            pptx::pptx_read_slides,
            print::print_document,
            preview::preview_html_window,
        ]);

    // The window menu is macOS-only. There, replacing Tauri's default menu is
    // the whole point — the Window submenu has to be one AppKit does not claim
    // (see `windowmenu.rs`). On Windows/Linux Tauri installs no menu at all,
    // and a menu bar drawn inside this app's custom titlebar would be a
    // regression, not a feature.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(windowmenu::build)
        .on_menu_event(|app, event| windowmenu::on_menu_event(app, &event))
        .on_window_event(|window, event| {
            // Focus is exactly when the window list can have gone stale, and
            // exactly when the menu bar becomes reachable — see `windowmenu.rs`.
            if let tauri::WindowEvent::Focused(true) = event {
                use tauri::Manager;
                windowmenu::refresh(window.app_handle());
            }
        });

    let builder = protocol::register_asset_protocol(builder);
    let builder = preview::register_preview_protocol(builder);
    print::register_print_protocol(builder)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // `build` + `run(callback)` rather than the previous one-shot `run`:
        // exit is when this window's workspace locks come off disk, and the
        // frontend cannot be trusted to get there (window.destroy() skips it).
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                instance::release_all_locks(app);
                instance::retire_instance(app);
            }
        });
}
