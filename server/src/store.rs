//! Filesystem store: knowledge bases, entries, and the manifest.
//!
//! Layout under the data directory:
//!
//! ```text
//! kbs/<kb-id>/meta.json                          { id, name, createdAtMs }
//! kbs/<kb-id>/entries/<category>/<id>.<hash>.zip the entry payload
//! kbs/<kb-id>/tmp/                               staging for atomic renames
//! ```
//!
//! Three decisions are load-bearing and worth reading before changing anything
//! here:
//!
//! **1. The content hash is part of the filename, not a sidecar.**
//! Committing a write is then a single `rename`, and the payload and the hash
//! that describes it can never disagree. A sidecar file would need two renames
//! with a window between them in which the recorded hash describes the *other*
//! version of the bytes — and that is precisely the failure the client's
//! three-way safety rail (docs §14.2) cannot detect, because the rail trusts
//! the hash to describe the content.
//!
//! **2. The hash is supplied by the client and never computed here.**
//! The client hashes the entry *directory's* contents (docs §15). That value is
//! not recoverable from the uploaded zip: zip bytes carry compression choices,
//! entry order and timestamps, so hashing them would produce a different answer
//! on every upload of identical content. The server treats the hash as an
//! opaque token — validated for shape by `ids::validate_hash`, stored verbatim.
//!
//! **3. There is no index file. The manifest is derived by walking `entries/`.**
//! An index would be a second copy of the truth, and the entire failure mode it
//! introduces (index says one thing, blobs say another) is one the client cannot
//! see. Walking a few thousand small directory entries costs single-digit
//! milliseconds; that is a good trade for making divergence impossible.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ids;

/// What `meta.json` holds — the two facts that never change after creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: u64,
}

/// What a client is shown for a knowledge base it might bind to.
///
/// Everything beyond `meta` is **derived on read**, not maintained on write:
/// the count and the timestamp come from walking `entries/`, so they cannot
/// drift from what is actually stored (the same reason there is no index
/// file). `last_device` is the one exception and the one thing that cannot be
/// derived — see `record_write`.
#[derive(Debug, Clone, Serialize)]
pub struct KbSummary {
    #[serde(flatten)]
    pub meta: KbMeta,
    #[serde(rename = "entryCount")]
    pub entry_count: usize,
    /// Newest entry mtime, epoch millis; 0 for an empty knowledge base.
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: u64,
    /// Which machine wrote last, as that machine named itself. Absent when
    /// nothing has been written since the server started keeping track.
    #[serde(rename = "lastDevice")]
    pub last_device: Option<String>,
}

/// `last-write.json` — who wrote last, and when they said so.
///
/// Deliberately a separate file rather than a field in `meta.json`: meta.json
/// is written once at creation and read on every listing, and turning it into
/// something every upload rewrites would put a read-modify-write cycle in the
/// hot path for a fact that is decoration. Best-effort in both directions — a
/// missing, truncated or unparseable file simply means "unknown device", which
/// is exactly what it meant before this existed.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LastWrite {
    device: String,
    #[serde(rename = "atMs")]
    at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManifestEntry {
    /// `<category>/<entity id>` — the entry's identity, and the same relative
    /// path it occupies under `.ai-writer/lore/` on the client.
    pub path: String,
    pub hash: String,
    pub size: u64,
    /// Payload mtime, epoch millis.
    ///
    /// **Display only.** Sync decisions are made on hashes (docs §14.2), never
    /// on this: mtime is reset by copying the data directory, restoring a
    /// backup, or unpacking an archive, so a rule that read it would report
    /// "everything changed" after any ordinary move of the server's storage.
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Manifest {
    pub kb: KbSummary,
    /// sha256 over the sorted `path\0hash\n` lines — one value that changes iff
    /// some entry's content changed. Lets a client answer "is there anything to
    /// do at all?" without diffing, and lets it detect that the remote moved
    /// between the manifest it planned against and the writes it is about to
    /// make (see `routes`' `If-Match` on every mutation).
    pub digest: String,
    pub entries: Vec<ManifestEntry>,
}

/// What the caller believes is currently stored, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Precondition {
    /// No condition — last writer wins. Only for a client that has explicitly
    /// opted out of the safety rail.
    None,
    /// Proceed only if the stored hash equals this one (`If-Match: "<hash>"`).
    Match(String),
    /// Proceed only if nothing is stored (`If-None-Match: *`).
    Absent,
}

/// Everything one upload carries besides *where* it goes.
///
/// Bundled rather than passed as six positional arguments: at the call site
/// `precondition` and `device` are both `Option`-ish tail arguments that read
/// as noise, and a hash and a byte slice next to each other are easy to get
/// backwards. Naming them at every call is worth one struct.
#[derive(Debug, Clone)]
pub struct EntryWrite<'a> {
    /// The client's content hash — see the module docs on why it is not ours.
    pub hash: &'a str,
    /// The zipped entry directory.
    pub bytes: &'a [u8],
    pub precondition: Precondition,
    /// Which machine is writing, as it names itself; shown in the binding picker.
    pub device: Option<&'a str>,
}

/// Whether a `put_entry` call added an entry or replaced one.
///
/// Returned rather than inferred by the caller from a preceding `current_hash`
/// probe: that probe would run outside the write lock, so a concurrent write
/// could make it report the wrong answer — and it costs a second directory walk
/// to be wrong with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutOutcome {
    Created,
    Replaced,
}

#[derive(Debug)]
pub enum StoreError {
    NoSuchKb(String),
    NoSuchEntry(String),
    KbExists(String),
    /// The stored state is not what the caller expected. Carries the hash that
    /// *is* stored (None = nothing stored) so the client can re-plan without a
    /// second round trip.
    Precondition {
        current: Option<String>,
    },
    Invalid(String),
    Io(io::Error),
}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl From<ids::InvalidName> for StoreError {
    fn from(e: ids::InvalidName) -> Self {
        StoreError::Invalid(e.to_string())
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NoSuchKb(id) => write!(f, "no knowledge base named {id:?}"),
            StoreError::NoSuchEntry(p) => write!(f, "no entry at {p:?}"),
            StoreError::KbExists(id) => write!(f, "a knowledge base {id:?} already exists"),
            StoreError::Precondition { current: Some(h) } => {
                write!(f, "the entry has changed (its hash is now {h})")
            }
            StoreError::Precondition { current: None } => {
                write!(f, "the entry no longer exists")
            }
            StoreError::Invalid(m) => f.write_str(m),
            StoreError::Io(e) => write!(f, "storage error: {e}"),
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub struct Store {
    root: PathBuf,
    /// One write lock per knowledge base, so a check-then-write (the whole point
    /// of `Precondition`) cannot interleave with another client's write to the
    /// same entry. Reads take no lock: they see either the old file or the new
    /// one, never a partial one, because writes commit by rename.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

/// Distinguishes staged files written within the same millisecond.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Store {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(root.join("kbs"))?;
        Ok(Store {
            root,
            locks: Mutex::new(HashMap::new()),
        })
    }

    fn kbs_dir(&self) -> PathBuf {
        self.root.join("kbs")
    }

    fn kb_dir(&self, kb: &str) -> PathBuf {
        self.kbs_dir().join(kb)
    }

    fn lock_for(&self, kb: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().expect("lock map poisoned");
        Arc::clone(locks.entry(kb.to_string()).or_default())
    }

    // ── Knowledge bases ─────────────────────────────────────────────────────

    pub fn list_kbs(&self) -> Result<Vec<KbSummary>> {
        let mut out = Vec::new();
        let dir = match fs::read_dir(self.kbs_dir()) {
            Ok(d) => d,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e.into()),
        };
        for entry in dir.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // A directory whose meta.json is missing or unreadable is skipped
            // rather than reported: it is either a half-finished create or
            // something the operator dropped in by hand, and neither should
            // make the whole listing fail.
            if let Some(meta) = self.read_kb_meta(&name) {
                out.push(self.summarise(meta));
            }
        }
        out.sort_by(|a, b| a.meta.id.cmp(&b.meta.id));
        Ok(out)
    }

    fn read_kb_meta(&self, kb: &str) -> Option<KbMeta> {
        let raw = fs::read_to_string(self.kb_dir(kb).join("meta.json")).ok()?;
        serde_json::from_str::<KbMeta>(&raw).ok()
    }

    pub fn require_kb(&self, kb: &str) -> Result<KbSummary> {
        ids::validate_kb_id(kb)?;
        let meta = self
            .read_kb_meta(kb)
            .ok_or_else(|| StoreError::NoSuchKb(kb.to_string()))?;
        Ok(self.summarise(meta))
    }

    /// Count the entries and find the newest one, then attach the last writer.
    ///
    /// One directory walk per knowledge base. That is a real cost on a listing
    /// of many bases, and it is the price of the count never disagreeing with
    /// what a manifest would report — the alternative is a maintained counter,
    /// which is an index by another name.
    fn summarise(&self, meta: KbMeta) -> KbSummary {
        let mut entry_count = 0usize;
        let mut updated_at_ms = 0u64;
        let entries_root = self.kb_dir(&meta.id).join("entries");
        if let Ok(categories) = fs::read_dir(&entries_root) {
            for category in categories.flatten() {
                let Ok(files) = fs::read_dir(category.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().to_string();
                    if split_payload_name(&name).is_none() {
                        continue;
                    }
                    entry_count += 1;
                    if let Ok(m) = file.metadata() {
                        updated_at_ms = updated_at_ms.max(mtime_ms(&m));
                    }
                }
            }
        }
        KbSummary {
            last_device: self.read_last_write(&meta.id).map(|w| w.device),
            meta,
            entry_count,
            updated_at_ms,
        }
    }

    fn last_write_path(&self, kb: &str) -> PathBuf {
        self.kb_dir(kb).join("last-write.json")
    }

    fn read_last_write(&self, kb: &str) -> Option<LastWrite> {
        serde_json::from_str(&fs::read_to_string(self.last_write_path(kb)).ok()?).ok()
    }

    /// Note which machine just wrote, for the binding picker to show.
    ///
    /// Failures are swallowed: this is a label on a list row, and refusing an
    /// upload that already landed because a decorative file could not be
    /// written would be the wrong trade every time.
    fn record_write(&self, kb: &str, device: Option<&str>) {
        let Some(device) = device else { return };
        let record = LastWrite {
            device: device.to_string(),
            at_ms: now_ms(),
        };
        if let Ok(json) = serde_json::to_vec(&record) {
            let _ = fs::write(self.last_write_path(kb), json);
        }
    }

    /// Create a knowledge base. `id` is derived from the display name when the
    /// caller does not supply one; a collision gets a `-2`, `-3`… suffix, the
    /// same shape the app's `uniqueEntityId` uses for entity folders.
    pub fn create_kb(&self, name: &str, requested_id: Option<&str>) -> Result<KbSummary> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("a name is required".into()));
        }
        if name.chars().count() > 80 {
            return Err(StoreError::Invalid("that name is too long".into()));
        }

        let id = match requested_id {
            Some(id) => {
                ids::validate_kb_id(id)?;
                if self.kb_dir(id).exists() {
                    return Err(StoreError::KbExists(id.to_string()));
                }
                id.to_string()
            }
            None => {
                let base = ids::slug_for_kb_name(name);
                let mut candidate = base.clone();
                let mut n = 2;
                while self.kb_dir(&candidate).exists() {
                    candidate = format!("{base}-{n}");
                    n += 1;
                    if n > 1000 {
                        return Err(StoreError::Invalid(
                            "could not find a free id for that name".into(),
                        ));
                    }
                }
                candidate
            }
        };

        let meta = KbMeta {
            id: id.clone(),
            name: name.to_string(),
            created_at_ms: now_ms(),
        };
        let dir = self.kb_dir(&id);
        fs::create_dir_all(dir.join("entries"))?;
        fs::create_dir_all(dir.join("tmp"))?;
        // meta.json last: a directory without it is skipped by `list_kbs`, so a
        // crash mid-create leaves an invisible stub rather than a listed base
        // that cannot be read.
        fs::write(
            dir.join("meta.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )?;
        Ok(self.summarise(meta))
    }

    // ── Entries ─────────────────────────────────────────────────────────────

    fn entry_dir(&self, kb: &str, category: &str) -> PathBuf {
        self.kb_dir(kb).join("entries").join(category)
    }

    /// Find the stored payload for one entry.
    ///
    /// Normally there is at most one file. Two can exist after a crash between
    /// the commit rename and the sweep that removes the previous version, so
    /// this resolves rather than assumes: newest mtime wins, ties broken by
    /// hash so the answer is the same on every call and on every replica.
    fn find_payload(
        &self,
        kb: &str,
        category: &str,
        id: &str,
    ) -> Option<(PathBuf, String, fs::Metadata)> {
        let dir = self.entry_dir(kb, category);
        let mut best: Option<(PathBuf, String, fs::Metadata)> = None;
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Some((found_id, hash)) = split_payload_name(&file_name) else {
                continue;
            };
            if found_id != id {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let better = match &best {
                None => true,
                Some((_, best_hash, best_meta)) => {
                    (mtime_ms(&meta), hash.as_str()) > (mtime_ms(best_meta), best_hash.as_str())
                }
            };
            if better {
                best = Some((entry.path(), hash, meta));
            }
        }
        best
    }

    /// Read one entry's payload. Held in memory rather than streamed: an entry
    /// is one lore entity — a few markdown files and its gallery images — and
    /// the request-size cap in `config` bounds it explicitly.
    pub fn read_entry(&self, kb: &str, category: &str, id: &str) -> Result<(Vec<u8>, String)> {
        self.require_kb(kb)?;
        ids::validate_category(category)?;
        ids::validate_entity_id(id)?;
        let (path, hash, _) = self
            .find_payload(kb, category, id)
            .ok_or_else(|| StoreError::NoSuchEntry(format!("{category}/{id}")))?;
        Ok((fs::read(path)?, hash))
    }

    pub fn put_entry(
        &self,
        kb: &str,
        category: &str,
        id: &str,
        write: EntryWrite<'_>,
    ) -> Result<PutOutcome> {
        let EntryWrite {
            hash,
            bytes,
            precondition,
            device,
        } = write;
        self.require_kb(kb)?;
        ids::validate_category(category)?;
        ids::validate_entity_id(id)?;
        ids::validate_hash(hash)?;

        let lock = self.lock_for(kb);
        let _guard = lock.lock().expect("kb lock poisoned");

        let existing = self.find_payload(kb, category, id);
        check_precondition(&precondition, existing.as_ref().map(|(_, h, _)| h.as_str()))?;

        let dir = self.entry_dir(kb, category);
        fs::create_dir_all(&dir)?;
        let tmp_dir = self.kb_dir(kb).join("tmp");
        fs::create_dir_all(&tmp_dir)?;

        // Staged inside the knowledge base so the commit below is a rename
        // within one filesystem — a cross-device rename fails, and falling back
        // to copy-then-delete would reintroduce the torn-write window the
        // filename-carries-the-hash design exists to remove.
        // Named from a counter as well as the clock: the per-kb lock already
        // serializes writes to one base, so a collision needs two writes in the
        // same millisecond from the same process — but relying on the lock for
        // *file naming* means any future narrowing of it corrupts uploads
        // instead of merely allowing them to race.
        let tmp_path = tmp_dir.join(format!(
            "put-{}-{}-{}.zip",
            now_ms(),
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&tmp_path, bytes)?;

        let final_path = dir.join(format!("{id}.{hash}.zip"));
        if let Err(e) = fs::rename(&tmp_path, &final_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(e.into());
        }

        // Sweep the previous version(s) *after* the commit. Best-effort on
        // purpose: a failure here leaves a stale sibling, which `find_payload`
        // already resolves, whereas failing the request would report a write
        // that did in fact land.
        let outcome = if existing.is_some() {
            PutOutcome::Replaced
        } else {
            PutOutcome::Created
        };
        if let Some((old_path, old_hash, _)) = existing {
            if old_hash != hash {
                let _ = fs::remove_file(old_path);
            }
        }
        self.record_write(kb, device);
        Ok(outcome)
    }

    pub fn delete_entry(
        &self,
        kb: &str,
        category: &str,
        id: &str,
        precondition: Precondition,
        device: Option<&str>,
    ) -> Result<()> {
        self.require_kb(kb)?;
        ids::validate_category(category)?;
        ids::validate_entity_id(id)?;

        let lock = self.lock_for(kb);
        let _guard = lock.lock().expect("kb lock poisoned");

        let existing = self.find_payload(kb, category, id);
        check_precondition(&precondition, existing.as_ref().map(|(_, h, _)| h.as_str()))?;

        let (path, _, _) =
            existing.ok_or_else(|| StoreError::NoSuchEntry(format!("{category}/{id}")))?;
        fs::remove_file(path)?;
        self.record_write(kb, device);
        Ok(())
    }

    // ── Manifest ────────────────────────────────────────────────────────────

    pub fn manifest(&self, kb: &str) -> Result<Manifest> {
        let meta = self.require_kb(kb)?;
        let mut entries = Vec::new();

        let entries_root = self.kb_dir(kb).join("entries");
        if let Ok(categories) = fs::read_dir(&entries_root) {
            for category in categories.flatten() {
                if !category.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let cat_name = category.file_name().to_string_lossy().to_string();
                // A directory the app could never have produced is skipped
                // rather than listed: it can only have been dropped in by hand,
                // and reporting it would send the client looking for an entry
                // it has no way to represent.
                if ids::validate_category(&cat_name).is_err() {
                    continue;
                }
                collect_category(&category.path(), &cat_name, &mut entries);
            }
        }

        entries.sort_by(|a, b| a.path.cmp(&b.path));
        entries.dedup_by(|a, b| a.path == b.path);

        let mut hasher = Sha256::new();
        for e in &entries {
            hasher.update(e.path.as_bytes());
            hasher.update(*b"\0");
            hasher.update(e.hash.as_bytes());
            hasher.update(*b"\n");
        }
        Ok(Manifest {
            kb: meta,
            digest: format!("{:x}", hasher.finalize()),
            entries,
        })
    }
}

/// Walk one category directory into manifest entries.
///
/// When a crash left two versions of the same entry behind, both are pushed and
/// the caller's `sort` + `dedup_by` keeps one — the same resolution
/// `find_payload` applies, so the manifest and a subsequent GET agree.
fn collect_category(dir: &Path, category: &str, out: &mut Vec<ManifestEntry>) {
    let Ok(files) = fs::read_dir(dir) else { return };
    let mut found: Vec<(String, String, u64, u64)> = Vec::new();
    for file in files.flatten() {
        let file_name = file.file_name().to_string_lossy().to_string();
        let Some((id, hash)) = split_payload_name(&file_name) else {
            continue;
        };
        if ids::validate_entity_id(&id).is_err() {
            continue;
        }
        let Ok(meta) = file.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        found.push((id, hash, meta.len(), mtime_ms(&meta)));
    }
    // Newest first, hash as the tiebreak — so the survivor of `dedup_by` below
    // is the same file `find_payload` would serve.
    found.sort_by(|a, b| (b.3, b.1.as_str()).cmp(&(a.3, a.1.as_str())));
    for (id, hash, size, updated) in found {
        out.push(ManifestEntry {
            path: format!("{category}/{id}"),
            hash,
            size,
            updated_at_ms: updated,
        });
    }
}

/// Split `<id>.<hash>.zip` back into its two halves.
///
/// Split from the right, because an entity id may legitimately contain a dot:
/// `slugifyEntityId` strips only what Windows refuses, and a name like
/// "St. Louis" slugs to `st._louis`. The hash never contains one (hex), so the
/// last dot before `.zip` is always the separator this module wrote.
fn split_payload_name(file_name: &str) -> Option<(String, String)> {
    let stem = file_name.strip_suffix(".zip")?;
    let (id, hash) = stem.rsplit_once('.')?;
    if id.is_empty() || ids::validate_hash(hash).is_err() {
        return None;
    }
    Some((id.to_string(), hash.to_string()))
}

fn check_precondition(precondition: &Precondition, current: Option<&str>) -> Result<()> {
    let ok = match precondition {
        Precondition::None => true,
        Precondition::Match(expected) => current == Some(expected.as_str()),
        Precondition::Absent => current.is_none(),
    };
    if ok {
        Ok(())
    } else {
        Err(StoreError::Precondition {
            current: current.map(str::to_string),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf()).unwrap();
        (dir, store)
    }

    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn create_list_and_roundtrip() {
        let (_d, s) = store();
        let kb = s.create_kb("My Wuxia World", None).unwrap().meta;
        assert_eq!(kb.id, "my-wuxia-world");
        assert_eq!(s.list_kbs().unwrap().len(), 1);

        s.put_entry(
            &kb.id,
            "characters",
            "爱丽丝",
            EntryWrite {
                hash: H1,
                bytes: b"zipbytes",
                precondition: Precondition::Absent,
                device: None,
            },
        )
        .unwrap();
        let (bytes, hash) = s.read_entry(&kb.id, "characters", "爱丽丝").unwrap();
        assert_eq!(bytes, b"zipbytes");
        assert_eq!(hash, H1);
    }

    #[test]
    fn a_summary_counts_entries_and_names_the_last_writer() {
        // What the binding picker shows for a knowledge base it might bind to.
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap();
        assert_eq!(kb.entry_count, 0);
        assert_eq!(kb.last_device, None, "a fresh base has no writer yet");

        s.put_entry(
            &kb.meta.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H1,
                bytes: b"a",
                precondition: Precondition::None,
                device: Some("MacBook-Pro"),
            },
        )
        .unwrap();

        let listed = &s.list_kbs().unwrap()[0];
        assert_eq!(listed.entry_count, 1);
        assert!(listed.updated_at_ms > 0);
        assert_eq!(listed.last_device.as_deref(), Some("MacBook-Pro"));

        // A delete is a write too — the label follows whoever touched it last.
        s.delete_entry(
            &kb.meta.id,
            "characters",
            "alice",
            Precondition::None,
            Some("DESKTOP-WIN"),
        )
        .unwrap();
        let listed = &s.list_kbs().unwrap()[0];
        assert_eq!(listed.entry_count, 0);
        assert_eq!(listed.last_device.as_deref(), Some("DESKTOP-WIN"));
    }

    #[test]
    fn a_write_without_a_device_leaves_the_previous_label_alone() {
        // A client that sends no header must not blank out what another one
        // recorded — "unknown" is not a claim about who wrote last.
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap();
        let put = |device| {
            s.put_entry(
                &kb.meta.id,
                "characters",
                "alice",
                EntryWrite {
                    hash: H1,
                    bytes: b"a",
                    precondition: Precondition::None,
                    device,
                },
            )
            .unwrap()
        };
        put(Some("MacBook-Pro"));
        put(None);
        assert_eq!(
            s.list_kbs().unwrap()[0].last_device.as_deref(),
            Some("MacBook-Pro")
        );
    }

    #[test]
    fn manifest_lists_entries_and_digest_tracks_content() {
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H1,
                bytes: b"a",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();
        s.put_entry(
            &kb.id,
            "world",
            "north",
            EntryWrite {
                hash: H2,
                bytes: b"b",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();

        let m = s.manifest(&kb.id).unwrap();
        let paths: Vec<_> = m.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["characters/alice", "world/north"]);

        // Pinned, not merely self-consistent: `digest` is a protocol value a
        // client compares across versions of this server, so the bytes fed to
        // the hasher (path, NUL, hash, LF — in sorted order) are a wire format.
        // Computed independently:
        //   for p, h in entries: sha256.update(p + b"\0" + h + b"\n")
        assert_eq!(
            m.digest,
            "781441779d45e95af072ad80b7b80c7169d166bbc2a3df5a69333b143e665bb4"
        );

        let before = m.digest.clone();

        // Same content re-uploaded: the digest must not move, or every client
        // would see a phantom change on each sync.
        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H1,
                bytes: b"a",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();
        assert_eq!(s.manifest(&kb.id).unwrap().digest, before);

        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H2,
                bytes: b"c",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();
        assert_ne!(s.manifest(&kb.id).unwrap().digest, before);
    }

    #[test]
    fn overwrite_replaces_the_previous_version() {
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H1,
                bytes: b"old",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();
        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H2,
                bytes: b"new",
                precondition: Precondition::Match(H1.into()),
                device: None,
            },
        )
        .unwrap();

        let (bytes, hash) = s.read_entry(&kb.id, "characters", "alice").unwrap();
        assert_eq!(bytes, b"new");
        assert_eq!(hash, H2);
        // Exactly one file survives — the sweep ran.
        assert_eq!(s.manifest(&kb.id).unwrap().entries.len(), 1);
        let files = fs::read_dir(s.entry_dir(&kb.id, "characters"))
            .unwrap()
            .count();
        assert_eq!(files, 1);
    }

    #[test]
    fn put_reports_whether_it_created_or_replaced() {
        // This is what the HTTP layer turns into 201 vs 204, and it has to come
        // back from inside the write lock — see `PutOutcome`.
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        assert_eq!(
            s.put_entry(
                &kb.id,
                "characters",
                "alice",
                EntryWrite {
                    hash: H1,
                    bytes: b"a",
                    precondition: Precondition::None,
                    device: None
                }
            )
            .unwrap(),
            PutOutcome::Created
        );
        assert_eq!(
            s.put_entry(
                &kb.id,
                "characters",
                "alice",
                EntryWrite {
                    hash: H2,
                    bytes: b"b",
                    precondition: Precondition::None,
                    device: None
                }
            )
            .unwrap(),
            PutOutcome::Replaced
        );
    }

    #[test]
    fn preconditions_reject_a_moved_remote() {
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H1,
                bytes: b"a",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();

        // Someone else already wrote: our If-Match names the version we planned
        // against, which is no longer there.
        let err = s
            .put_entry(
                &kb.id,
                "characters",
                "alice",
                EntryWrite {
                    hash: H2,
                    bytes: b"b",
                    precondition: Precondition::Match(H2.into()),
                    device: None,
                },
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::Precondition { current: Some(ref h) } if h == H1));

        // Create-only against something that exists.
        let err = s
            .put_entry(
                &kb.id,
                "characters",
                "alice",
                EntryWrite {
                    hash: H2,
                    bytes: b"b",
                    precondition: Precondition::Absent,
                    device: None,
                },
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::Precondition { .. }));

        // The payload is untouched by either refusal.
        assert_eq!(s.read_entry(&kb.id, "characters", "alice").unwrap().0, b"a");
    }

    #[test]
    fn delete_honours_preconditions() {
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H1,
                bytes: b"a",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();

        assert!(s
            .delete_entry(
                &kb.id,
                "characters",
                "alice",
                Precondition::Match(H2.into()),
                None,
            )
            .is_err());
        s.delete_entry(
            &kb.id,
            "characters",
            "alice",
            Precondition::Match(H1.into()),
            None,
        )
        .unwrap();
        assert!(s.read_entry(&kb.id, "characters", "alice").is_err());
        assert!(s.manifest(&kb.id).unwrap().entries.is_empty());
    }

    #[test]
    fn a_second_version_left_by_a_crash_resolves_to_one_entry() {
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        s.put_entry(
            &kb.id,
            "characters",
            "alice",
            EntryWrite {
                hash: H1,
                bytes: b"a",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();
        // Simulate the crash window: commit rename done, sweep never ran.
        let dir = s.entry_dir(&kb.id, "characters");
        fs::write(dir.join(format!("alice.{H2}.zip")), b"b").unwrap();

        let m = s.manifest(&kb.id).unwrap();
        assert_eq!(m.entries.len(), 1, "the duplicate must not be listed twice");
        // Manifest and GET must agree on which version survived.
        let (_, served) = s.read_entry(&kb.id, "characters", "alice").unwrap();
        assert_eq!(m.entries[0].hash, served);
    }

    #[test]
    fn ids_with_dots_round_trip() {
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        s.put_entry(
            &kb.id,
            "world",
            "st._louis",
            EntryWrite {
                hash: H1,
                bytes: b"x",
                precondition: Precondition::None,
                device: None,
            },
        )
        .unwrap();
        let m = s.manifest(&kb.id).unwrap();
        assert_eq!(m.entries[0].path, "world/st._louis");
        assert_eq!(s.read_entry(&kb.id, "world", "st._louis").unwrap().1, H1);
    }

    #[test]
    fn traversal_never_reaches_the_filesystem() {
        let (_d, s) = store();
        let kb = s.create_kb("k", None).unwrap().meta;
        assert!(s
            .put_entry(
                &kb.id,
                "characters",
                "../../escape",
                EntryWrite {
                    hash: H1,
                    bytes: b"x",
                    precondition: Precondition::None,
                    device: None
                }
            )
            .is_err());
        assert!(s
            .put_entry(
                &kb.id,
                "../..",
                "alice",
                EntryWrite {
                    hash: H1,
                    bytes: b"x",
                    precondition: Precondition::None,
                    device: None
                }
            )
            .is_err());
        assert!(s.read_entry("../..", "characters", "alice").is_err());
    }

    #[test]
    fn unknown_kb_is_reported_not_created() {
        let (_d, s) = store();
        assert!(matches!(s.manifest("nope"), Err(StoreError::NoSuchKb(_))));
        assert!(!s.kb_dir("nope").exists());
    }

    #[test]
    fn duplicate_names_get_distinct_ids() {
        let (_d, s) = store();
        assert_eq!(s.create_kb("Same Name", None).unwrap().meta.id, "same-name");
        assert_eq!(
            s.create_kb("Same Name", None).unwrap().meta.id,
            "same-name-2"
        );
        // A non-ASCII display name keeps its name but gets a generic id.
        let cjk = s.create_kb("我的武侠世界", None).unwrap().meta;
        assert_eq!(cjk.id, "kb");
        assert_eq!(cjk.name, "我的武侠世界");
    }
}
