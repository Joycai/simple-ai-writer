//! The macOS 「Window」 menu.
//!
//! macOS builds the Window menu from `NSApp.windowsMenu`, which AppKit fills
//! from *that process's* `NSApp.windows` — and every window here is its own
//! process (see `instance.rs`). Tauri already hands its default Window submenu
//! to AppKit (`tauri::app::init_app_menu`), so the native mechanism is wired
//! up and simply has one window to list. The list the author wants exists
//! nowhere in AppKit's reach, so this module renders it from the instance
//! registry in `instance.rs`, and switches by connecting to the target's
//! focus-channel port — the channel that module already opens, where
//! connecting *is* the whole message. No new protocol, and nothing granted
//! that a local process did not already have.
//!
//! ## Why our own submenu instead of AppKit's
//!
//! Keeping Tauri's `WINDOW_SUBMENU_ID` would make AppKit append its own list
//! (this process's single window) *after* whatever we add, and there is no API
//! to take `windowsMenu` back. So the submenu here carries its own id, AppKit
//! never claims it, and we render the complete list — the current window
//! included, checked. The payoff is that every instance shows the **same list
//! in the same order**, rather than each one showing itself in a different
//! place. Nothing is lost by giving up `windowsMenu`: its whole value is the
//! automatic list, which is exactly what cannot work here. The cost is that
//! installing our own menu means owning the rest of the default one too
//! (app / File / Edit / View / Help), reproduced in `build` below.
//!
//! ## Why refreshing on focus is enough
//!
//! A sibling cannot push "I opened" to us — the focus channel reads nothing by
//! design, and widening it would trade that invariant for a menu that is at
//! most a few hundred milliseconds fresher. It doesn't need to be: **the menu
//! bar belongs to the frontmost app**, so the author must focus this window
//! before the menu can be opened at all, and focus is where the rebuild
//! happens. The window that spawned a sibling, and the window whose sibling
//! just quit, both regain focus on the way to their own menu bar. This is the
//! same argument `usePrefsFocusSync` makes for preferences, and here it is not
//! an approximation but the exact bound.

use tauri::{AppHandle, Manager, Runtime};

// ── The menu ────────────────────────────────────────────────────────────────

/// Our Window submenu's id — deliberately *not* Tauri's `WINDOW_SUBMENU_ID`,
/// so `init_app_menu` does not hand it to AppKit (see the module doc).
pub const WINDOW_MENU_ID: &str = "saw:window-menu";

/// Prefix of a window item's id; the rest is the target pid.
const ITEM_PREFIX: &str = "saw:window:";

/// The app menu: Tauri's default, with our own Window submenu in place of the
/// one AppKit would claim. Installed via `Builder::menu`, which runs before
/// `setup` — so the list starts empty here and `refresh` fills it once the
/// focus channel exists.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID};

    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // The static head. What follows it is the window list, appended by
    // `refresh` and recognisable there by `ITEM_PREFIX` — no count of these
    // items is written down anywhere, so adding one here cannot silently make
    // a refresh eat it.
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_MENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

/// Rebuild the window list. Cheap (a directory read and a handful of menu
/// items) and safe to call from the event loop: Tauri's menu calls run inline
/// when they are already on the main thread.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    use tauri::menu::CheckMenuItem;

    let Some(menu) = app.menu() else { return };
    let Some(kind) = menu.get(WINDOW_MENU_ID) else {
        return;
    };
    let Some(submenu) = kind.as_submenu() else {
        return;
    };

    // Drop the previous list — by id, not by position. A remembered "the
    // first N items are static" would be a number two functions apart from the
    // menu it describes, and getting it wrong deletes 关闭窗口 rather than
    // failing.
    for item in submenu.items().unwrap_or_default() {
        if item.id().as_ref().starts_with(ITEM_PREFIX) {
            let _ = submenu.remove(&item);
        }
    }

    let self_pid = std::process::id();
    for info in crate::instance::live_instances(app) {
        // A check item even when unchecked: macOS reserves the state column
        // for the whole menu, so mixing plain items would misalign the list.
        let Ok(item) = CheckMenuItem::with_id(
            app,
            format!("{ITEM_PREFIX}{}", info.pid),
            &info.title,
            true,
            info.pid == self_pid,
            None::<&str>,
        ) else {
            continue;
        };
        let _ = submenu.append(&item);
    }
}

/// A click on a window item: raise the instance it names. Ids that are not
/// ours (every other menu item) fall straight through.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: &tauri::menu::MenuEvent) {
    let Some(pid) = event
        .id
        .as_ref()
        .strip_prefix(ITEM_PREFIX)
        .and_then(|s| s.parse::<u32>().ok())
    else {
        return;
    };

    if pid == std::process::id() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    } else if let Some(port) = crate::instance::live_instances(app)
        .into_iter()
        .find(|i| i.pid == pid)
        .and_then(|i| i.port)
    {
        // Bounded like `project_focus_existing`: a wedged sibling costs half a
        // second, never a hung menu.
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let _ = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500));
    }

    // Unconditionally, for two reasons that happen to want the same call.
    // AppKit toggles a check item's own mark on click, so the list has to be
    // re-rendered from the registry or the ✓ ends up on whichever entry was
    // clicked last — and clicking the *current* window is the case no focus
    // change would ever come along to repair. And an entry that could not be
    // reached was stale (a recycled PID; see the module doc), which this same
    // pass sweeps.
    refresh(app);
}
