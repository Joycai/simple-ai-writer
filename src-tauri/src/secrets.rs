//! API-key storage backed by the OS credential manager
//! (Windows Credential Manager / macOS Keychain / Linux Secret Service).
//!
//! Replaces both the earlier stronghold vault (whose Rust actor deadlocked on
//! some macOS setups) and the interim plaintext SQLite storage.
//!
//! The IPC surface is the same everywhere — save/load/delete one secret by id —
//! but the storage shape is not: macOS folds *every* secret into a single
//! keychain item, the other platforms keep one credential per id. Both `store`
//! modules below carry the reasoning for their own half.

use keyring::Entry;
use tauri::command;

/// Service name under which all provider keys are registered.
const SERVICE: &str = "com.simple-ai-writer.app";

/// Reject provider ids that can't name a credential, before any platform call.
///
/// Every command runs this first, and it deliberately touches nothing outside
/// this file so it stays unit-testable: as of keyring 4, `Entry::new` lazily
/// initialises the platform credential store on first use, which on a headless
/// Linux CI runner means dialling a Secret Service that isn't running. Argument
/// validation is ours to test; reachability of the user's keychain is not — and
/// an id rejected here must produce the same error either way.
fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    if provider_id.is_empty() {
        return Err("provider_id must not be empty".into());
    }
    // The macOS bundle lives under a reserved account name in the same service.
    // Provider ids are nanoids and the two other callers prefix theirs
    // (`kbsync:` / `cfgpwd:`), so nothing can reach this by accident — but an
    // id that collided would overwrite the item holding every other secret,
    // which is worth an enforced invariant rather than an argument.
    #[cfg(target_os = "macos")]
    if provider_id == store::BUNDLE_ACCOUNT {
        return Err(format!(
            "provider_id must not be {:?}",
            store::BUNDLE_ACCOUNT
        ));
    }
    Ok(())
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Run keychain work on the blocking pool instead of an async-runtime worker.
///
/// One call can block for as long as it takes the author to answer a macOS
/// Keychain dialog, and the one-time migration below answers a whole row of
/// them — that does not belong on a tokio worker shared with every other
/// command.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(e) => Err(e.to_string()),
    }
}

/// Save (or overwrite) the API key for a provider.
#[command]
pub async fn secret_save(provider_id: String, api_key: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    blocking(move || store::save(&provider_id, &api_key)).await
}

/// Load the API key for a provider. Returns `None` when no key is stored.
#[command]
pub async fn secret_load(provider_id: String) -> Result<Option<String>, String> {
    validate_provider_id(&provider_id)?;
    blocking(move || store::load(&provider_id)).await
}

/// Delete the API key for a provider. Missing entries are a no-op.
#[command]
pub async fn secret_delete(provider_id: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    blocking(move || store::delete(&provider_id)).await
}

/// One credential per id.
///
/// The shape every platform used before macOS grew a bundle, and still the
/// right one here: the Windows Credential Manager never prompts for a
/// credential its own user owns (and caps one credential's blob at 2560 bytes,
/// which a dozen API keys would overrun), and the Secret Service unlocks a
/// whole collection at a time rather than an item at a time. Neither has
/// anything to gain from a bundle and Windows has something to lose.
#[cfg(not(target_os = "macos"))]
mod store {
    use super::entry;

    pub fn save(provider_id: &str, api_key: &str) -> Result<(), String> {
        entry(provider_id)?
            .set_password(api_key)
            .map_err(|e| e.to_string())
    }

    pub fn load(provider_id: &str) -> Result<Option<String>, String> {
        match entry(provider_id)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(provider_id: &str) -> Result<(), String> {
        match entry(provider_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Every secret in **one** keychain item.
///
/// keyring's macOS backend writes into the file-based login keychain, where
/// each item carries its own ACL and the trust that ACL records is the
/// requesting binary's *code-signing identity*. This app ships ad-hoc
/// (linker-signed, `TeamIdentifier=not set`), so that identity is a hash of the
/// binary and changes with every build: after every update macOS re-asks for
/// the login password, once per item, and "始终允许" only ever covers the one
/// item the dialog was about. With a credential per provider that was one
/// dialog per configured provider — 18 on the author's machine, on every
/// update. One item makes it one dialog.
///
/// Signing the app with a stable Developer ID would remove the dialogs
/// altogether (the ACL would then record a requirement naming the bundle id and
/// the team, which survives a rebuild); this is the half that costs nothing and
/// also shrinks the *first* prompt after such a switch to a single item.
#[cfg(target_os = "macos")]
mod store {
    use std::collections::{BTreeMap, HashMap};
    use std::sync::Mutex;

    use super::{entry, validate_provider_id, SERVICE};

    /// Account name of the one item that holds them all.
    pub(super) const BUNDLE_ACCOUNT: &str = "all-secrets";

    /// id → secret. Ordered so the stored JSON doesn't churn between writes.
    type Bundle = BTreeMap<String, String>;

    /// Serialises this process's access to the one item, and carries whether the
    /// pre-bundle items have been folded in yet.
    ///
    /// Every write is a read-modify-write of one shared blob, so two of them at
    /// once — several sub-agents resolving their keys in parallel, say — could
    /// otherwise lose one. Holding the same lock across the migration is what
    /// makes it happen exactly once even under that concurrency.
    static ACCESS: Mutex<bool> = Mutex::new(false);

    fn read_bundle() -> Result<Bundle, String> {
        match entry(BUNDLE_ACCOUNT)?.get_password() {
            Ok(json) => serde_json::from_str(&json).map_err(|e| {
                // Deliberately an error rather than an empty bundle: treating
                // unreadable JSON as "no secrets" would let the next save
                // overwrite every key the author has.
                format!("the keychain item holding the API keys is not valid JSON: {e}")
            }),
            Err(keyring::Error::NoEntry) => Ok(Bundle::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write_bundle(bundle: &Bundle) -> Result<(), String> {
        let entry = entry(BUNDLE_ACCOUNT)?;
        if bundle.is_empty() {
            // An empty JSON object would be a keychain item holding nothing;
            // removing it keeps "no secrets stored" looking the same as it does
            // on a fresh install.
            return match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            };
        }
        let json = serde_json::to_string(bundle).map_err(|e| e.to_string())?;
        entry.set_password(&json).map_err(|e| e.to_string())
    }

    /// Read the bundle, folding the pre-bundle items in on the first call.
    ///
    /// A migration that can't read an item (the author dismissed its dialog)
    /// leaves that item where it is and reports the rest — it runs again on the
    /// next launch. Failing the caller instead would make an unreadable
    /// leftover break every key the author *can* read.
    fn with_bundle<T>(work: impl FnOnce(&mut Bundle) -> Result<T, String>) -> Result<T, String> {
        // The guarded value is a bool, so a panic elsewhere has nothing to
        // corrupt — recovering beats poisoning every later call.
        let mut migrated = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
        let mut bundle = read_bundle()?;
        if !*migrated {
            *migrated = true;
            if let Err(e) = migrate_into(&mut bundle) {
                eprintln!("[secrets] could not fold the pre-bundle keychain items in: {e}");
            }
        }
        work(&mut bundle)
    }

    /// Move every remaining per-provider item into `bundle` and delete it.
    ///
    /// `Entry::search` only loads attributes, so enumerating is silent; it is
    /// reading each item's password that costs one dialog. That is the price of
    /// the move, paid once — and it is why this enumerates rather than asking
    /// the frontend for the ids it knows: a provider the author deleted, or an
    /// id one of the three callers forgot to report, would otherwise be a
    /// secret silently left behind in a store nothing reads any more.
    fn migrate_into(bundle: &mut Bundle) -> Result<(), String> {
        // `read_bundle` above has already run, which is what initialises
        // keyring's default store — `Entry::search` needs one to exist.
        let spec = HashMap::from([("service", SERVICE)]);
        let found = keyring_core::Entry::search(&spec).map_err(|e| e.to_string())?;

        let mut moved = Vec::new();
        for item in found {
            let Some((_, account)) = item.get_specifiers() else {
                continue;
            };
            if account == BUNDLE_ACCOUNT {
                continue;
            }
            match item.get_password() {
                Ok(secret) => {
                    // The bundle is the newer store, so it wins: an old item
                    // carrying an id already in there can only be one an earlier
                    // pass wrote but could not delete.
                    bundle.entry(account).or_insert(secret);
                    moved.push(item);
                }
                Err(e) => eprintln!("[secrets] leaving {account:?} in its own keychain item: {e}"),
            }
        }
        if moved.is_empty() {
            return Ok(());
        }

        // Write before deleting, so an interruption at worst duplicates a secret
        // rather than destroying one.
        write_bundle(bundle)?;
        for item in moved {
            if let Err(e) = item.delete_credential() {
                eprintln!("[secrets] moved a key into the bundle but could not delete it: {e}");
            }
        }
        Ok(())
    }

    pub fn save(provider_id: &str, api_key: &str) -> Result<(), String> {
        validate_provider_id(provider_id)?;
        with_bundle(|bundle| {
            bundle.insert(provider_id.to_string(), api_key.to_string());
            write_bundle(bundle)
        })
    }

    pub fn load(provider_id: &str) -> Result<Option<String>, String> {
        validate_provider_id(provider_id)?;
        with_bundle(|bundle| Ok(bundle.get(provider_id).cloned()))
    }

    pub fn delete(provider_id: &str) -> Result<(), String> {
        validate_provider_id(provider_id)?;
        with_bundle(|bundle| {
            if bundle.remove(provider_id).is_none() {
                return Ok(());
            }
            write_bundle(bundle)
        })
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

    /// The guard must reject an empty id on its own, without reaching the
    /// platform store — otherwise it could be bypassed and the error the
    /// frontend sees would depend on whether a keychain happens to be available.
    #[test]
    fn guard_runs_before_any_platform_call() {
        match validate_provider_id("") {
            Err(message) => assert_eq!(message, "provider_id must not be empty"),
            Ok(()) => panic!("empty provider_id should not be accepted"),
        }
    }

    /// The one id that would overwrite every other secret on macOS.
    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_the_reserved_bundle_account() {
        assert!(validate_provider_id(store::BUNDLE_ACCOUNT).is_err());
    }
}
