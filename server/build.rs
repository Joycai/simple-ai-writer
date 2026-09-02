//! Windows only: stamps the two executables with their icons and a
//! `VERSIONINFO` block — what Explorer shows on the file, what Task Manager
//! and the Properties → Details tab print as the description.
//!
//! The icons are pre-rendered `.ico` files under `icons/` (`icons/build.py`
//! regenerates them from the design numbers; nothing at build time needs
//! Python). Resource ids: `1` is the exe's own icon on both binaries — the
//! lowest id is the one Explorer picks — and the tray binary additionally
//! carries its two state glyphs as `2` (running) and `3` (stopped), which
//! `src/bin/tray.rs` loads by id at the shell's small-icon size.
//!
//! On any other target this does nothing, and the ubuntu CI job never even
//! compiles the build dependency (it is host-gated). A Windows box without a
//! resource compiler (no Windows SDK `rc.exe`, no mingw `windres`) still
//! builds — it just ships plain exes and says so in a warning.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    #[cfg(windows)]
    windows::embed();
}

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};

    struct Bin {
        name: &'static str,
        description: &'static str,
        /// `(resource id, file under icons/)`, lowest id first.
        icons: &'static [(u16, &'static str)],
    }

    const BINS: &[Bin] = &[
        Bin {
            name: "aiw-kb-server",
            description: "Simple AI Writer 知识库服务端",
            icons: &[(1, "app.ico")],
        },
        Bin {
            name: "aiw-kb-tray",
            description: "Simple AI Writer 知识库服务端（托盘）",
            icons: &[
                (1, "app.ico"),
                (2, "tray-running.ico"),
                (3, "tray-stopped.ico"),
            ],
        },
    ];

    pub fn embed() {
        let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let icons = manifest_dir.join("icons");
        for bin in BINS {
            for (_, file) in bin.icons {
                println!("cargo:rerun-if-changed={}", icons.join(file).display());
            }
            let rc = out_dir.join(format!("{}.rc", bin.name));
            std::fs::write(&rc, resource_script(bin, &icons)).expect("write .rc");
            use embed_resource::CompilationResult as R;
            match embed_resource::compile_for(&rc, [bin.name], embed_resource::NONE) {
                R::Ok | R::NotWindows => {}
                R::NotAttempted(why) => println!(
                    "cargo:warning={}.exe is built without its icon and version info: {why}",
                    bin.name
                ),
                failed @ R::Failed(_) => panic!("{failed}"),
            }
        }
    }

    fn resource_script(bin: &Bin, icons: &Path) -> String {
        let v = |part: &str| std::env::var(format!("CARGO_PKG_VERSION_{part}")).unwrap();
        let (major, minor, patch) = (v("MAJOR"), v("MINOR"), v("PATCH"));
        let version = std::env::var("CARGO_PKG_VERSION").unwrap();
        // rc.exe takes the path as a C string literal: escape the backslashes.
        let quoted = |p: PathBuf| p.display().to_string().replace('\\', "\\\\");
        let mut rc = String::from("#pragma code_page(65001)\n");
        for (id, file) in bin.icons {
            rc += &format!("{id} ICON \"{}\"\n", quoted(icons.join(file)));
        }
        rc += &format!(
            r#"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "Simple AI Writer"
      VALUE "FileDescription", "{description}"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "{name}"
      VALUE "OriginalFilename", "{name}.exe"
      VALUE "ProductName", "Simple AI Writer Knowledge-Base Server"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#,
            description = bin.description,
            name = bin.name,
        );
        rc
    }
}
