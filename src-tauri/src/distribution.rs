//! A compile-time distribution boundary, independent of user configuration.
#[tauri::command]
pub fn distribution_channel() -> &'static str {
    if cfg!(feature = "app-store") {
        "app-store"
    } else {
        "direct"
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn channel_matches_compiled_capabilities() {
        assert_eq!(
            super::distribution_channel(),
            if cfg!(feature = "app-store") {
                "app-store"
            } else {
                "direct"
            }
        );
    }
}
