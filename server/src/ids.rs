//! Name validation — the security boundary of this server.
//!
//! Every path this process touches is built as `<data dir>/kbs/<kb>/entries/
//! <category>/<file>`, where `kb`, `category` and the entity id all arrive from
//! the network. Nothing else stands between a request and the filesystem, so
//! these functions are the whole defence: they run *before* any `PathBuf::push`,
//! and a rejected name never reaches `store`.
//!
//! The rules deliberately mirror the app's own, not a generic "safe filename"
//! notion — the server stores what the client already has on disk, and a name
//! the client can create but the server rejects would be an entry that can
//! never be backed up:
//!
//!   - **category** — `CATEGORY_ID_RE` in `src/lib/profile/model.ts`, i.e. an
//!     ASCII slug. Categories are folder names the app itself generates.
//!   - **entity id** — `slugifyEntityId` in `src/lib/lore/entity.ts`, which
//!     *preserves* Unicode letters and digits (a Chinese character name stays a
//!     Chinese directory name) and only strips what Windows refuses. So an id
//!     may not be matched against an ASCII pattern; it is checked against the
//!     same reserved set instead.
//!
//! A note on what is deliberately *not* solved here: Unicode normalization.
//! macOS stores directory names as NFD, Linux stores the bytes it was given, so
//! an id containing a composed character can come back from one machine spelled
//! differently than it went in from another. The app has that problem locally
//! already (both are its own `.ai-writer/lore` folders), and "fixing" it here by
//! normalizing would make the server's copy of a name differ from the client's,
//! which is worse. It is documented rather than papered over.

/// Characters no supported filesystem can store in a path component (the
/// Windows set, which is a superset of the others), plus the separators and
/// control characters. Same list as `FS_RESERVED_CHARS` in the app.
const RESERVED_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Names Windows resolves to legacy devices *regardless of extension*, so a
/// file called `con.zip` is not a file. Checked even though this server most
/// often runs on Linux: the point of a backup server is that the data outlives
/// the machine, and a data directory restored onto Windows must still be
/// readable. Rejecting on the way in is the only moment this is cheap.
const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Longest a single name may be, in bytes. Most filesystems cap a path
/// component at 255 bytes; entity ids are slugs of a display name and are far
/// shorter in practice. The margin leaves room for the `.<hash>.zip` suffix
/// `store` appends without ever producing a name the filesystem refuses.
const MAX_SEGMENT_BYTES: usize = 120;

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidName(pub String);

impl std::fmt::Display for InvalidName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn reject(what: &str, why: &str) -> InvalidName {
    InvalidName(format!("{what} {why}"))
}

/// Validate one path component that may legitimately be non-ASCII (an entity
/// id). Returns the name unchanged so call sites read as a conversion.
pub fn validate_segment(what: &str, name: &str) -> Result<(), InvalidName> {
    if name.is_empty() {
        return Err(reject(what, "must not be empty"));
    }
    if name.len() > MAX_SEGMENT_BYTES {
        return Err(reject(what, "is too long"));
    }
    // `.` and `..` are the traversal primitives; a name that is *only* dots is
    // never a real entity id and is rejected wholesale rather than special-cased.
    if name.chars().all(|c| c == '.') {
        return Err(reject(what, "must not consist only of dots"));
    }
    if name
        .chars()
        .any(|c| RESERVED_CHARS.contains(&c) || c.is_control())
    {
        return Err(reject(
            what,
            "must not contain path separators, control characters, or <>:\"|?*",
        ));
    }
    // Leading/trailing dots and spaces: Windows silently strips trailing ones,
    // so `foo ` and `foo` would become the same directory there and two
    // different ones on Linux — the entry would move between machines.
    if name.starts_with(' ') || name.ends_with(' ') || name.ends_with('.') {
        return Err(reject(what, "must not start or end with a space or a dot"));
    }
    // Compared on the stem so `con.zip` is caught, and lowercased because the
    // device names are case-insensitive.
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    if WINDOWS_DEVICE_NAMES.contains(&stem.as_str()) {
        return Err(reject(what, "is a reserved device name on Windows"));
    }
    Ok(())
}

/// An ASCII slug: knowledge-base ids and category ids both use this shape.
/// Mirrors the app's `CATEGORY_ID_RE` (`^[a-z0-9][a-z0-9_-]{0,39}$/i`), with a
/// longer cap for kb ids, which are derived from a display name.
fn validate_slug(what: &str, name: &str, max: usize) -> Result<(), InvalidName> {
    if name.is_empty() {
        return Err(reject(what, "must not be empty"));
    }
    if name.len() > max {
        return Err(reject(what, "is too long"));
    }
    let mut chars = name.chars();
    let first = chars.next().expect("checked non-empty");
    if !first.is_ascii_alphanumeric() {
        return Err(reject(what, "must start with a letter or a digit"));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(reject(
            what,
            "may only contain ASCII letters, digits, '_' and '-'",
        ));
    }
    Ok(())
}

pub fn validate_kb_id(id: &str) -> Result<(), InvalidName> {
    validate_slug("knowledge base id", id, 64)
}

pub fn validate_category(id: &str) -> Result<(), InvalidName> {
    validate_slug("category", id, 40)
}

pub fn validate_entity_id(id: &str) -> Result<(), InvalidName> {
    validate_segment("entity id", id)
}

/// Validate a client-supplied content hash.
///
/// The server never computes this: the client hashes the entry *directory's*
/// contents (see `docs/feature/knowledge-base/remote-knowledge-base-feasibility.md` §15), which is not
/// recoverable from the zip it uploads — zip bytes carry compression choices and
/// timestamps and are not deterministic for the same input. So the hash is an
/// opaque token here, and all this checks is that it is a plausible hex digest
/// and safe to embed in a filename (`store` puts it there).
pub fn validate_hash(hash: &str) -> Result<(), InvalidName> {
    if hash.len() < 32 || hash.len() > 128 {
        return Err(InvalidName(
            "content hash must be between 32 and 128 characters".into(),
        ));
    }
    if !hash
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    {
        return Err(InvalidName(
            "content hash must be lowercase hexadecimal".into(),
        ));
    }
    Ok(())
}

/// Derive a readable directory name for a new knowledge base from its display
/// name. Falls back to `kb` when the name has no ASCII-slug content at all — a
/// name like 「我的武侠世界」 is entirely legitimate and simply does not survive
/// slugification, so the display name is kept in `meta.json` and the directory
/// gets `kb-<six hex of the name's digest>`.
///
/// The digest suffix rather than a bare `kb`: three Chinese-named bases used to
/// become `kb`, `kb-2`, `kb-3`, which are indistinguishable in a URL, in a
/// backup listing and in the operator's shell — exactly the places the id exists
/// to be read in. Derived from the name, so the same name yields the same id on
/// any machine, and two different names never collide into a counter.
///
/// Deliberately *not* the app's `slugifyEntityId`, which preserves Unicode: a kb
/// id appears in URLs and in the operator's shell, and both are better off ASCII.
pub fn slug_for_kb_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !out.is_empty() && !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(48);
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(name.trim().as_bytes());
        format!("kb-{}", &format!("{digest:x}")[..6])
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_ids_may_be_unicode() {
        // slugifyEntityId keeps CJK verbatim, so the server must too — this is
        // the common case for this app, not an edge case.
        assert!(validate_entity_id("爱丽丝").is_ok());
        assert!(validate_entity_id("北境_城墙").is_ok());
        assert!(validate_entity_id("alice-2").is_ok());
    }

    #[test]
    fn traversal_and_separators_are_rejected() {
        for bad in ["..", ".", "../etc", "a/b", "a\\b", "..\\..\\x", "/"] {
            assert!(validate_entity_id(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn windows_hostile_names_are_rejected() {
        for bad in [
            "con",
            "CON",
            "nul.zip",
            "lpt1",
            "trailing.",
            "trailing ",
            " leading",
        ] {
            assert!(validate_entity_id(bad).is_err(), "accepted {bad:?}");
        }
        // A name that merely *contains* a device name is fine.
        assert!(validate_entity_id("console").is_ok());
    }

    #[test]
    fn control_characters_are_rejected() {
        assert!(validate_entity_id("a\0b").is_err());
        assert!(validate_entity_id("a\nb").is_err());
    }

    #[test]
    fn categories_are_ascii_slugs() {
        assert!(validate_category("characters").is_ok());
        assert!(validate_category("my-cat_2").is_ok());
        // Unicode is fine for an entity id but not for a category: the app's own
        // CATEGORY_ID_RE refuses it, so a category folder can never look like this.
        assert!(validate_category("人物").is_err());
        assert!(validate_category("-leading").is_err());
        assert!(validate_category("").is_err());
    }

    #[test]
    fn hashes_must_be_lowercase_hex() {
        assert!(validate_hash(&"a".repeat(64)).is_ok());
        assert!(validate_hash(&"A".repeat(64)).is_err());
        assert!(validate_hash("abc").is_err());
        assert!(validate_hash(&"z".repeat(64)).is_err());
        // A hash that reached a filename must not be able to escape it.
        assert!(validate_hash("../../etc/passwd").is_err());
    }

    #[test]
    fn kb_slugs_are_readable_or_generic() {
        assert!(validate_kb_id(&slug_for_kb_name("My Wuxia World")).is_ok());
        assert_eq!(slug_for_kb_name("My Wuxia World"), "my-wuxia-world");
        assert_eq!(slug_for_kb_name("  a  b  "), "a-b");
        // No ASCII content at all — the display name lives in meta.json instead.
        // A name with no ASCII at all keeps a readable, *distinct* id rather
        // than collapsing into a counter: `kb-2` and `kb-3` tell an operator
        // nothing, and which one is which changes with creation order.
        let wuxia = slug_for_kb_name("我的武侠世界");
        let donghai = slug_for_kb_name("东海奇谭");
        assert!(wuxia.starts_with("kb-"), "{wuxia}");
        assert_ne!(wuxia, donghai);
        assert_eq!(
            wuxia,
            slug_for_kb_name("我的武侠世界"),
            "same name, same id"
        );
        assert!(validate_kb_id(&wuxia).is_ok());
        assert!(validate_kb_id(&slug_for_kb_name("")).is_ok());
    }
}
