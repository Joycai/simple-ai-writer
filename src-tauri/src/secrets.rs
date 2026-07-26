//! API-key storage backed by the OS credential manager
//! (Windows Credential Manager / macOS Keychain / Linux Secret Service).
//!
//! Replaces both the earlier stronghold vault (whose Rust actor deadlocked on
//! some macOS setups) and the interim plaintext SQLite storage.

use keyring::Entry;
use tauri::command;

/// Service name under which all provider keys are registered.
const SERVICE: &str = "com.simple-ai-writer.app";

/// Reject provider ids that can't name a credential, before any platform call.
///
/// Split out from [`entry`] so it stays unit-testable: as of keyring 4,
/// `Entry::new` lazily initialises the platform credential store on first use,
/// which on a headless Linux CI runner means dialling a Secret Service that
/// isn't running. Argument validation is ours to test; reachability of the
/// user's keychain is not.
fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    if provider_id.is_empty() {
        return Err("provider_id must not be empty".into());
    }
    Ok(())
}

fn entry(provider_id: &str) -> Result<Entry, String> {
    validate_provider_id(provider_id)?;
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
        assert!(validate_provider_id("").is_err());
    }

    #[test]
    fn accepts_valid_provider_id() {
        assert!(validate_provider_id("openai-default").is_ok());
    }

    /// `entry` must reject an empty id on its own, without reaching the platform
    /// store — otherwise the guard could be bypassed and the error the frontend
    /// sees would depend on whether a keychain happens to be available.
    /// Matched rather than unwrapped because keyring 4's `Entry` isn't `Debug`.
    #[test]
    fn entry_short_circuits_on_empty_id_before_touching_the_platform() {
        match entry("") {
            Err(message) => assert_eq!(message, "provider_id must not be empty"),
            Ok(_) => panic!("empty provider_id should not produce an entry"),
        }
    }
}
