//! Windows tray launcher (`aiw-kb-tray`).
//!
//! The same server as `aiw-kb-server`, run **in-process** behind a tray icon:
//! no console window, start/stop from the menu, run-at-login via the HKCU Run
//! key, and the first-run credentials shown in a dialog instead of printed to
//! a console nobody is watching. Everything more complicated than that — config
//! editing, tokens, logs — is a menu item away in the `/admin` console, which
//! is why this file stays small.
//!
//! Design and the rejected alternatives:
//! `docs/feature/knowledge-base/kb-server-tray.md`.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    // Compiled on every platform so the ubuntu CI job's `clippy --all-targets`
    // covers the file; useful on none but Windows.
    eprintln!(
        "aiw-kb-tray 只在 Windows 上提供（托盘 + 开机自启）。\n\
         在这个平台上请直接运行 aiw-kb-server，部署方式见 server/DEPLOY.md。"
    );
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    app::run();
}

#[cfg(windows)]
mod app {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::path::{Path, PathBuf};

    use aiw_kb_server::confedit::{self, Setting};
    use aiw_kb_server::config::{self, Config, Source};
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
    use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{TrayIcon, TrayIconBuilder, TrayIconEvent};

    #[derive(Debug)]
    enum UserEvent {
        Menu(MenuEvent),
        /// Any interaction with the icon itself — used to re-read the Run key
        /// right before the menu shows, so a key deleted elsewhere doesn't
        /// leave a lying checkmark.
        Tray,
        /// The serve task ended with an error while we thought it was running.
        /// Carries the generation so a report from an already-replaced run is
        /// recognised as stale and dropped.
        Died {
            gen: u64,
            error: String,
        },
    }

    struct Ui {
        tray: TrayIcon,
        toggle: MenuItem,
        admin: MenuItem,
        status: MenuItem,
        datadir: MenuItem,
        autostart: CheckMenuItem,
        quit: MenuItem,
    }

    struct Running {
        shutdown: tokio::sync::oneshot::Sender<()>,
        done: tokio::task::JoinHandle<Result<(), String>>,
        gen: u64,
        bind: SocketAddr,
    }

    struct App {
        rt: tokio::runtime::Runtime,
        argv: Vec<String>,
        proxy: EventLoopProxy<UserEvent>,
        /// The configuration the current (or last) run was started with. Kept
        /// for the status dialog; reloaded from disk on every start so a
        /// stop/start cycle picks up edits made in the admin console.
        config: Option<Config>,
        running: Option<Running>,
        gen: u64,
        ui: Option<Ui>,
        log_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
    }

    pub fn run() {
        // A GUI-subsystem process has no stderr, so a panic would otherwise
        // vanish without a trace.
        std::panic::set_hook(Box::new(|info| {
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("aiw-kb-tray")
                .set_description(format!("aiw-kb-tray 崩溃了：{info}"))
                .show();
        }));

        // The config's default data_dir ("./data") and the exe-dir config file
        // lookup are both only sane relative to the executable — and a Run-key
        // launch starts us in a system directory, not beside the exe. Pin the
        // working directory first so double-click and login-autostart agree on
        // where everything lives.
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_owned()))
        {
            let _ = std::env::set_current_dir(dir);
        }

        let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
        {
            let proxy = event_loop.create_proxy();
            MenuEvent::set_event_handler(Some(move |e| {
                let _ = proxy.send_event(UserEvent::Menu(e));
            }));
        }
        {
            let proxy = event_loop.create_proxy();
            TrayIconEvent::set_event_handler(Some(move |_e: TrayIconEvent| {
                let _ = proxy.send_event(UserEvent::Tray);
            }));
        }

        let mut app = App {
            rt: tokio::runtime::Runtime::new().expect("tokio runtime"),
            argv: std::env::args().collect(),
            proxy: event_loop.create_proxy(),
            config: None,
            running: None,
            gen: 0,
            ui: None,
            log_guard: None,
        };

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                // The tray icon must be created on the event-loop thread once
                // the loop is live — this is the earliest such moment.
                Event::NewEvents(StartCause::Init) => {
                    app.build_tray();
                    app.start();
                }
                Event::UserEvent(ev) => {
                    if app.handle(ev) {
                        *control_flow = ControlFlow::Exit;
                    }
                }
                _ => {}
            }
        });
    }

    impl App {
        fn build_tray(&mut self) {
            let toggle = MenuItem::new("启动服务器", true, None);
            let admin = MenuItem::new("打开管理后台", false, None);
            let status = MenuItem::new("服务器状态…", true, None);
            let datadir = MenuItem::new("数据目录…", true, None);
            let autostart = CheckMenuItem::new("开机自启", true, autostart::enabled(), None);
            let quit = MenuItem::new("退出", true, None);
            let menu = Menu::new();
            menu.append_items(&[
                &toggle,
                &admin,
                &status,
                &PredefinedMenuItem::separator(),
                &datadir,
                &autostart,
                &PredefinedMenuItem::separator(),
                &quit,
            ])
            .expect("assemble tray menu");
            let tray = TrayIconBuilder::new()
                .with_menu(Box::new(menu))
                .with_tooltip("aiw-kb-server · 已停止")
                .with_icon(icon(false))
                .build()
                .expect("create tray icon");
            self.ui = Some(Ui {
                tray,
                toggle,
                admin,
                status,
                datadir,
                autostart,
                quit,
            });
        }

        /// Returns true when the app should exit.
        fn handle(&mut self, ev: UserEvent) -> bool {
            match ev {
                UserEvent::Menu(e) => {
                    let Some(ui) = &self.ui else { return false };
                    if e.id() == ui.toggle.id() {
                        if self.running.is_some() {
                            self.stop();
                        } else {
                            self.start();
                        }
                    } else if e.id() == ui.admin.id() {
                        self.open_admin();
                    } else if e.id() == ui.status.id() {
                        self.show_status();
                    } else if e.id() == ui.datadir.id() {
                        self.change_data_dir();
                    } else if e.id() == ui.autostart.id() {
                        // A CheckMenuItem toggles itself before the event
                        // arrives; is_checked() is already the desired state.
                        let want = ui.autostart.is_checked();
                        if let Err(err) = autostart::set(want) {
                            ui.autostart.set_checked(!want);
                            error_dialog("开机自启", &format!("写注册表失败：{err}"));
                        }
                    } else if e.id() == ui.quit.id() {
                        self.stop();
                        return true;
                    }
                }
                UserEvent::Tray => {
                    if let Some(ui) = &self.ui {
                        ui.autostart.set_checked(autostart::enabled());
                    }
                }
                UserEvent::Died { gen, error } => {
                    // Only current: a graceful stop consumes `running` before
                    // this event could arrive, and a stale generation means
                    // the run was already replaced.
                    if self.running.as_ref().map(|r| r.gen) == Some(gen) {
                        self.running = None;
                        self.apply_state();
                        error_dialog("服务器已停止", &format!("服务器意外退出：{error}"));
                    }
                }
            }
            false
        }

        fn start(&mut self) {
            if self.running.is_some() {
                return;
            }
            // Reloaded every time: the admin console edits the file, and a
            // stop/start from the menu must pick the edits up.
            let config = match Config::load(&self.argv) {
                Ok(c) => c,
                Err(e) => {
                    error_dialog("无法读取配置", &e);
                    return;
                }
            };
            self.init_logging(&config);
            let first_run = config.file_created;
            let bind_addr = config.server.bind;
            self.config = Some(config.clone());

            let bound = match self
                .rt
                .block_on(aiw_kb_server::bind(config, self.argv.clone()))
            {
                Ok(b) => b,
                Err(e) => {
                    // The reason `bind` exists as its own step: this dialog.
                    error_dialog("启动失败", &e);
                    self.apply_state();
                    return;
                }
            };

            self.gen += 1;
            let gen = self.gen;
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let proxy = self.proxy.clone();
            let done = self.rt.spawn(async move {
                let result = bound
                    .run(async {
                        let _ = rx.await;
                    })
                    .await;
                if let Err(e) = &result {
                    let _ = proxy.send_event(UserEvent::Died {
                        gen,
                        error: e.clone(),
                    });
                }
                result
            });
            tracing::info!("tray: server started on {bind_addr}");
            self.running = Some(Running {
                shutdown: tx,
                done,
                gen,
                bind: bind_addr,
            });
            self.apply_state();
            if first_run {
                self.show_credentials();
            }
        }

        fn stop(&mut self) {
            let Some(running) = self.running.take() else {
                return;
            };
            let _ = running.shutdown.send(());
            // Bounded wait: draining lets in-flight writes finish their
            // stage-then-rename commit; ten seconds is generous for that.
            let _ = self.rt.block_on(async {
                tokio::time::timeout(std::time::Duration::from_secs(10), running.done).await
            });
            tracing::info!("tray: server stopped");
            self.apply_state();
        }

        fn apply_state(&self) {
            let Some(ui) = &self.ui else { return };
            let running = self.running.as_ref();
            ui.toggle.set_text(if running.is_some() {
                "停止服务器"
            } else {
                "启动服务器"
            });
            ui.admin.set_enabled(running.is_some());
            let _ = ui.tray.set_icon(Some(icon(running.is_some())));
            let tip = match running {
                Some(r) => format!("aiw-kb-server · 运行中 · {}", r.bind),
                None => "aiw-kb-server · 已停止".to_string(),
            };
            let _ = ui.tray.set_tooltip(Some(tip));
        }

        fn open_admin(&self) {
            if let Some(r) = &self.running {
                let _ = open::that(admin_url(r.bind));
            }
        }

        fn show_status(&self) {
            let mut lines = Vec::new();
            match &self.running {
                Some(r) => {
                    lines.push("状态：运行中".to_string());
                    lines.push(format!("监听地址：{}", r.bind));
                    lines.push(format!("管理后台：{}", admin_url(r.bind)));
                }
                None => lines.push("状态：已停止".to_string()),
            }
            if let Some(c) = &self.config {
                lines.push(format!("数据目录：{}", c.server.data_dir.display()));
                lines.push(format!("配置文件：{}", c.file_path.display()));
                if let Some(err) = &c.file_error {
                    lines.push(format!("⚠ 配置文件解析失败，正运行在默认值上：{err}"));
                }
                if c.server.allow_anonymous {
                    lines.push("⚠ allow_anonymous 已开启——同步 API 不需要 token".to_string());
                }
            }
            lines.push(format!("版本：{}", env!("CARGO_PKG_VERSION")));
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Info)
                .set_title("服务器状态")
                .set_description(lines.join("\n"))
                .show();
        }

        /// Move the data directory: pick a folder, optionally copy the current
        /// data over, write `server.data_dir` back through `confedit` (the same
        /// comment-preserving writer the admin console uses), restart.
        ///
        /// Every question is asked *before* the server stops, so a 取消 at any
        /// point leaves a running server running. The copy never deletes the
        /// old directory — a migration that ends with "and then it removed the
        /// only copy" is not a migration anyone asked for.
        fn change_data_dir(&mut self) {
            let config = match Config::load(&self.argv) {
                Ok(c) => c,
                Err(e) => {
                    error_dialog("无法读取配置", &e);
                    return;
                }
            };
            if let Some(err) = &config.file_error {
                error_dialog(
                    "数据目录",
                    &format!(
                        "配置文件解析失败，先修好它再改数据目录（管理后台或手工编辑）：\n{err}"
                    ),
                );
                return;
            }
            if config.source_of("server.data_dir") == Source::Env {
                // Writing the file would succeed and change nothing — the
                // provenance model exists precisely to catch this lie early.
                error_dialog(
                    "数据目录",
                    "数据目录当前由环境变量 AIW_KB_DATA_DIR 指定，改配置文件不会生效。\n\
                     先去掉那个环境变量，或直接改它。",
                );
                return;
            }

            let current = absolute(&config.server.data_dir);
            let start_in = if current.exists() {
                current.clone()
            } else {
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            };
            let Some(picked) = rfd::FileDialog::new()
                .set_title("选择新的数据目录")
                .set_directory(start_in)
                .pick_folder()
            else {
                return;
            };
            if same_path(&picked, &current) {
                rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Info)
                    .set_title("数据目录")
                    .set_description(format!("已经是这个目录了：\n{}", current.display()))
                    .show();
                return;
            }

            let old_has_data = dir_has_entries(&current);
            let target_clean = !dir_has_entries(&picked);
            let migrate = if old_has_data && target_clean {
                let result = rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Warning)
                    .set_title("数据目录")
                    .set_description(format!(
                        "把数据目录改为：\n{}\n\n现有数据在：\n{}\n\n\
                         「搬运并切换」：复制现有数据到新目录再切换，原目录保留，\
                         确认无误后可自行删除。\n\
                         「只切换」：直接指向新目录，原数据留在原处（服务器将看不到它们）。",
                        picked.display(),
                        current.display(),
                    ))
                    .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
                        "搬运并切换".to_string(),
                        "只切换".to_string(),
                        "取消".to_string(),
                    ))
                    .show();
                match result {
                    rfd::MessageDialogResult::Custom(ref s) if s == "搬运并切换" => true,
                    rfd::MessageDialogResult::Yes => true,
                    rfd::MessageDialogResult::Custom(ref s) if s == "只切换" => false,
                    rfd::MessageDialogResult::No => false,
                    _ => return,
                }
            } else {
                let note = if old_has_data {
                    // A non-empty target is not a copy destination: merging two
                    // data trees silently is how entries get half-overwritten.
                    "目标目录已有内容，不做搬运——现有数据留在原处。"
                } else {
                    "当前数据目录是空的，直接切换。"
                };
                let result = rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Info)
                    .set_title("数据目录")
                    .set_description(format!("把数据目录改为：\n{}\n\n{note}", picked.display()))
                    .set_buttons(rfd::MessageButtons::OkCancelCustom(
                        "切换".to_string(),
                        "取消".to_string(),
                    ))
                    .show();
                let ok = matches!(result, rfd::MessageDialogResult::Ok)
                    || matches!(result, rfd::MessageDialogResult::Custom(ref s) if s == "切换");
                if !ok {
                    return;
                }
                false
            };

            let was_running = self.running.is_some();
            self.stop();
            if migrate {
                if let Err(e) = copy_tree(&current, &picked) {
                    error_dialog(
                        "搬运失败",
                        &format!("复制数据时出错，配置未改动：{e}\n目标目录可能残留半份拷贝。"),
                    );
                    if was_running {
                        self.start();
                    }
                    return;
                }
            }
            let value = picked.to_string_lossy().replace('\\', "/");
            if let Err(e) =
                confedit::apply(&config.file_path, &[Setting::Str("server.data_dir", value)])
            {
                error_dialog("数据目录", &format!("写配置文件失败，未切换：{e}"));
                if was_running {
                    self.start();
                }
                return;
            }
            if was_running {
                self.start();
            } else if let Ok(c) = Config::load(&self.argv) {
                self.config = Some(c);
            }
            // The log file follows the data directory, but tracing was pinned
            // to the old location when this process initialised it — worth one
            // honest line instead of a mystery.
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Info)
                .set_title("数据目录")
                .set_description(format!(
                    "数据目录已改为：\n{}\n\n{}日志文件（tray.log）在下次启动 aiw-kb-tray 后跟过去。",
                    picked.display(),
                    if migrate {
                        "数据已复制，原目录保留。\n"
                    } else {
                        ""
                    },
                ))
                .show();
        }

        /// The tray-side twin of `main.rs`'s `announce_new_config`: the one
        /// moment the generated password exists anywhere a person can read it,
        /// shown where a tray user actually looks.
        fn show_credentials(&self) {
            let Some(config) = &self.config else { return };
            let username = config
                .admin
                .as_ref()
                .map(|a| a.username.as_str())
                .unwrap_or("admin");
            let password = config
                .admin
                .as_ref()
                .map(|a| a.password.as_str())
                .unwrap_or("(未生成)");
            let token = config
                .tokens
                .first()
                .map(|t| t.value.as_str())
                .unwrap_or("(未生成)");
            let text = format!(
                "已生成配置文件：{}\n\n\
                 管理后台   {}\n\
                 用户名     {username}\n\
                 密码       {password}\n\n\
                 app 里填的同步 token：\n{token}\n\n\
                 这些值也躺在配置文件里，随时可以改（管理后台里就能改）。",
                config.file_path.display(),
                admin_url(config.server.bind),
            );
            let result = rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Info)
                .set_title("aiw-kb-server 已就绪")
                .set_description(text)
                .set_buttons(rfd::MessageButtons::OkCancelCustom(
                    "打开管理后台".to_string(),
                    "知道了".to_string(),
                ))
                .show();
            let open_it = matches!(result, rfd::MessageDialogResult::Ok)
                || matches!(result, rfd::MessageDialogResult::Custom(ref s) if s == "打开管理后台");
            if open_it {
                self.open_admin();
            }
        }

        /// Once, on the first successful config load: a GUI-subsystem process
        /// has no stderr, so tracing goes to `<data_dir>/tray.log` instead.
        fn init_logging(&mut self, config: &Config) {
            if self.log_guard.is_some() {
                return;
            }
            let dir = &config.server.data_dir;
            let _ = std::fs::create_dir_all(dir);
            let appender = tracing_appender::rolling::never(dir, "tray.log");
            let (writer, guard) = tracing_appender::non_blocking(appender);
            let filter = tracing_subscriber::EnvFilter::try_new(&config.server.log)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(config::DEFAULT_LOG));
            if tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_writer(writer)
                .with_ansi(false)
                .try_init()
                .is_ok()
            {
                self.log_guard = Some(guard);
            }
        }
    }

    /// Resolve a possibly-relative path against the working directory — which
    /// `run()` pinned to the exe's directory, so "./data" means the same thing
    /// here as it does to the server.
    fn absolute(p: &Path) -> PathBuf {
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(p))
                .unwrap_or_else(|_| p.to_path_buf())
        }
    }

    /// "Is this the directory we already use" — for a no-op guard, not for
    /// security, so a lossy case-insensitive compare of the absolute forms is
    /// the right amount of effort on a case-insensitive filesystem.
    fn same_path(a: &Path, b: &Path) -> bool {
        let norm = |p: &Path| {
            absolute(p)
                .to_string_lossy()
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_lowercase()
        };
        norm(a) == norm(b)
    }

    fn dir_has_entries(p: &Path) -> bool {
        std::fs::read_dir(p)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
    }

    /// Copy `src` into `dst` recursively. Never deletes anything: the caller's
    /// migration story is copy-verify-switch, with the old tree left as the
    /// fallback it is.
    fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let target = dst.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_tree(&entry.path(), &target)?;
            } else {
                std::fs::copy(entry.path(), &target)?;
            }
        }
        Ok(())
    }

    /// The address a browser should open — an unspecified bind (0.0.0.0)
    /// listens everywhere but is not itself somewhere to navigate to.
    fn admin_url(addr: SocketAddr) -> String {
        let shown = if addr.ip().is_unspecified() {
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), addr.port())
        } else {
            addr
        };
        format!("http://{shown}/admin")
    }

    fn error_dialog(title: &str, message: &str) {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title(title)
            .set_description(message.to_string())
            .show();
    }

    fn icon(running: bool) -> tray_icon::Icon {
        let (rgba, size) = icon_rgba(running);
        tray_icon::Icon::from_rgba(rgba, size, size).expect("tray icon rgba")
    }

    /// Drawn procedurally so the state can live in the icon (filled core =
    /// running, ring only = stopped) without shipping image assets or a
    /// decoder: a ring, plus a core disc when running, in the app's sienna.
    fn icon_rgba(running: bool) -> (Vec<u8>, u32) {
        const S: u32 = 32;
        let mut buf = vec![0u8; (S * S * 4) as usize];
        let c = (S as f32 - 1.0) / 2.0;
        let (r, g, b) = (196u8, 116u8, 62u8);
        for y in 0..S {
            for x in 0..S {
                let dx = x as f32 - c;
                let dy = y as f32 - c;
                let d = (dx * dx + dy * dy).sqrt();
                let ring = coverage(d, 10.5, 14.5);
                let core = if running { coverage(d, -1.0, 7.5) } else { 0.0 };
                let a = (ring.max(core) * 255.0).round() as u8;
                let i = ((y * S + x) * 4) as usize;
                buf[i] = r;
                buf[i + 1] = g;
                buf[i + 2] = b;
                buf[i + 3] = a;
            }
        }
        (buf, S)
    }

    /// Pixel coverage of the annulus [lo, hi] at distance `d`, with a one-pixel
    /// linear edge on both sides — cheap anti-aliasing.
    fn coverage(d: f32, lo: f32, hi: f32) -> f32 {
        let outer = (hi + 0.5 - d).clamp(0.0, 1.0);
        let inner = (d - (lo - 0.5)).clamp(0.0, 1.0);
        outer.min(inner)
    }

    /// Run-at-login via the per-user Run key: no elevation, follows the user's
    /// login, deleting the value is the whole uninstall story. A stored command
    /// that doesn't match the current exe path counts as *disabled*, so a moved
    /// binary shows unchecked and re-checking repairs the path.
    mod autostart {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
        use winreg::RegKey;

        const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
        const VALUE: &str = "aiw-kb-tray";

        fn command() -> Option<String> {
            let exe = std::env::current_exe().ok()?;
            Some(format!("\"{}\"", exe.display()))
        }

        pub fn enabled() -> bool {
            let Some(cmd) = command() else { return false };
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE)
                .and_then(|k| k.get_value::<String, _>(VALUE))
                .map(|v| v == cmd)
                .unwrap_or(false)
        }

        pub fn set(on: bool) -> std::io::Result<()> {
            let key = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
            if on {
                let cmd = command()
                    .ok_or_else(|| std::io::Error::other("could not resolve the exe path"))?;
                key.set_value(VALUE, &cmd)
            } else {
                match key.delete_value(VALUE) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    other => other,
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn icon_buffer_is_a_full_rgba_square() {
            let (on, s) = icon_rgba(true);
            let (off, _) = icon_rgba(false);
            assert_eq!(on.len(), (s * s * 4) as usize);
            assert_eq!(off.len(), on.len());
            // The two states must actually look different.
            assert_ne!(on, off);
        }

        #[test]
        fn copy_tree_copies_nested_files_and_leaves_the_source() {
            let src = tempfile::tempdir().unwrap();
            let dst = tempfile::tempdir().unwrap();
            let dst_root = dst.path().join("data");
            std::fs::create_dir_all(src.path().join("kbs/k1/entries")).unwrap();
            std::fs::write(src.path().join("kbs/k1/meta.json"), b"{}").unwrap();
            std::fs::write(src.path().join("audit.log"), b"line").unwrap();

            copy_tree(src.path(), &dst_root).unwrap();

            assert_eq!(
                std::fs::read(dst_root.join("kbs/k1/meta.json")).unwrap(),
                b"{}"
            );
            assert!(dst_root.join("kbs/k1/entries").is_dir());
            assert_eq!(std::fs::read(dst_root.join("audit.log")).unwrap(), b"line");
            // The source is untouched — copy, never move.
            assert!(src.path().join("kbs/k1/meta.json").exists());
        }

        #[test]
        fn same_path_ignores_case_and_separators() {
            assert!(same_path(
                Path::new("C:\\Data\\KB"),
                Path::new("c:/data/kb/")
            ));
            assert!(!same_path(Path::new("C:\\Data\\KB"), Path::new("C:\\Data")));
        }

        #[test]
        fn admin_url_replaces_unspecified_bind_with_loopback() {
            assert_eq!(
                admin_url("0.0.0.0:8787".parse().unwrap()),
                "http://127.0.0.1:8787/admin"
            );
            assert_eq!(
                admin_url("192.168.1.5:9000".parse().unwrap()),
                "http://192.168.1.5:9000/admin"
            );
        }
    }
}
