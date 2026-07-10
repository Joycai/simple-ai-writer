//! API-key storage backed by the OS credential manager
//! (Windows Credential Manager / macOS Keychain / Linux Secret Service).
//!
//! Replaces both the earlier stronghold vault (whose Rust actor deadlocked on
//! some macOS setups) and the interim plaintext SQLite storage.

use keyring::Entry;
use tauri::command;

/// Service name under which all provider keys are registered.
const SERVICE: &str = "com.simple-ai-writer.app";

fn entry(provider_id: &str) -> Result<Entry, String> {
    if provider_id.is_empty() {
        return Err("provider_id must not be empty".into());
    }
    Entry::new(SERVICE, provider_id).map_err(|e| e.to_string())
}

/// Save (or overwrite) the API key for a provider.
#[command]
pub async fn secret_save(provider_id: String, api_key: String) -> Result<(), String> {
    entry(&provider_id)?
        .set_password(&api_key)
        .map_err(|e| e.to_string())
}

/// Load the API key for a provider. Returns `None` when no key is stored.
#[command]
pub async fn secret_load(provider_id: String) -> Result<Option<String>, String> {
    match entry(&provider_id)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete the API key for a provider. Missing entries are a no-op.
#[command]
pub async fn secret_delete(provider_id: String) -> Result<(), String> {
    match entry(&provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_provider_id() {
        assert!(entry("").is_err());
    }

    #[test]
    fn builds_entry_for_valid_provider_id() {
        assert!(entry("openai-default").is_ok());
    }
}
