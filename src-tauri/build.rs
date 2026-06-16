fn main() {
    // Ensure the Windows resource (icon embedding) is rebuilt whenever icon files change.
    // tauri-build only tracks tauri.conf.json, not the icon files themselves.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    tauri_build::build()
}
