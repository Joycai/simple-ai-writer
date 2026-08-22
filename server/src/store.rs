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

// ─── Application-config backups ──────────────────────────────────────────────
//
// A second, much smaller resource living beside the knowledge bases:
//
// ```text
// configs/tmp/                                   staging for atomic renames
// configs/<slot>/meta.json                       { id, name, createdAtMs }
// configs/<slot>/versions/<atMs>.<hash>.bin      the envelope the app uploaded
// configs/<slot>/versions/<atMs>.<hash>.meta     that version's display metadata
// ```
//
// It repeats the knowledge-base design where the reasoning still holds and
// departs from it in exactly two places, both deliberate:
//
// **The hash is computed here, not supplied.** An entry's hash cannot be
// recomputed from its zip (compression choices, entry order, timestamps), which
// is the whole reason `EntryWrite` carries one. A config version is the byte
// string the client itself composed — hashing it here is deterministic, agrees
// with what the client computed, and removes one client-supplied value that a
// precondition depends on.
//
// **There is a sidecar file, which `entries/` forbids.** The rule there is that
// a sidecar holding the *hash* can disagree with the payload, and the client's
// three-way rail cannot see that it has. This sidecar holds `device`,
// `appVersion` and the like — a label on a list row. Losing it costs one line of
// decoration, which is the same trade `last-write.json` already makes. It is
// written *before* the payload's commit rename, so the payload's arrival is
// still the single commit point and a crash leaves an ignored orphan.

/// `configs/<slot>/meta.json` — the two facts fixed at creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: u64,
}

/// One stored config version.
#[derive(Debug, Clone, Serialize)]
pub struct SlotVersion {
    /// When it was stored, epoch millis — and its identity within the slot.
    ///
    /// Unlike an entry's mtime this **is** load-bearing: it orders the versions
    /// and addresses one of them in a URL. It is therefore taken from the clock
    /// at write time and forced strictly upward (see `put_config`), never read
    /// back off the filesystem, so copying the data directory cannot reorder a
    /// slot's history.
    #[serde(rename = "atMs")]
    pub at_ms: u64,
    pub hash: String,
    pub size: u64,
    /// The client's own display metadata, verbatim. `None` when the sidecar is
    /// missing or unreadable, which reads as "unknown" everywhere it is shown.
    pub meta: Option<String>,
}

/// What a client is shown for a config backup slot it might restore from.
#[derive(Debug, Clone, Serialize)]
pub struct SlotSummary {
    #[serde(flatten)]
    pub meta: SlotMeta,
    #[serde(rename = "versionCount")]
    pub version_count: usize,
    /// The version a bare `GET /v1/configs/{slot}` returns; `None` for a slot
    /// created but never written to.
    pub current: Option<SlotVersion>,
}

/// Everything one config upload carries besides *which slot* it goes to.
#[derive(Debug, Clone)]
pub struct ConfigWrite<'a> {
    /// The envelope bytes, exactly as the client composed them.
    pub bytes: &'a [u8],
    /// Opaque display metadata; stored verbatim, never parsed.
    pub meta: Option<&'a str>,
    pub precondition: Precondition,
    /// How many versions to keep after this one lands.
    pub keep: usize,
}

/// One stored payload file, as the maintenance scans see it.
#[derive(Debug, Clone, Serialize)]
pub struct PayloadFile {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(skip)]
    pub path: PathBuf,
    pub hash: String,
    pub size: u64,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: u64,
}

/// An entry with more than one payload file — the residue of a crash between
/// the commit rename and the sweep that removes the previous version.
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateEntry {
    pub kb: String,
    pub path: String,
    /// The one a download would return.
    pub keeper: PayloadFile,
    /// The superseded ones, newest first.
    pub losers: Vec<PayloadFile>,
}

/// A file left in a `tmp/` directory by an interrupted upload.
#[derive(Debug, Clone, Serialize)]
pub struct StrayFile {
    /// The knowledge base it belongs to; empty for the shared `configs/tmp/`,
    /// which is not owned by any one slot.
    pub kb: String,
    /// Relative to the data directory, for display.
    pub rel: String,
    /// The write lock to hold while removing it, if any. `None` for
    /// `configs/tmp/`: it is shared by every slot, so there is no single lock
    /// that covers it — and none is needed, for the reason `clear_staging`
    /// gives.
    #[serde(skip)]
    pub lock_key: Option<String>,
    #[serde(skip)]
    pub path: PathBuf,
    pub size: u64,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: u64,
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
    NoSuchSlot(String),
    NoSuchVersion(String),
    SlotExists(String),
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
            StoreError::NoSuchSlot(id) => write!(f, "no config backup named {id:?}"),
            StoreError::NoSuchVersion(at) => {
                write!(f, "this config backup has no version stored at {at}")
            }
            StoreError::SlotExists(id) => write!(f, "a config backup {id:?} already exists"),
            // Worded for both resources that carry preconditions. Naming the
            // entry here would put "the entry has changed" in front of an author
            // whose *configuration* another machine just pushed — a sentence
            // that sends them looking at the wrong thing entirely.
            StoreError::Precondition { current: Some(h) } => {
                write!(f, "it has changed on the server (its hash is now {h})")
            }
            StoreError::Precondition { current: None } => {
                write!(f, "it no longer exists on the server")
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
        fs::create_dir_all(root.join("configs"))?;
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

    // ── Application-config backups ──────────────────────────────────────────

    fn configs_dir(&self) -> PathBuf {
        self.root.join("configs")
    }

    fn slot_dir(&self, slot: &str) -> PathBuf {
        self.configs_dir().join(slot)
    }

    fn versions_dir(&self, slot: &str) -> PathBuf {
        self.slot_dir(slot).join("versions")
    }

    /// The slot's write lock. Namespaced away from the knowledge-base keys so a
    /// slot and a base that happen to share an id do not serialize against each
    /// other — they are unrelated resources and one waiting on the other would
    /// be a stall nobody could explain from the outside.
    fn slot_lock(&self, slot: &str) -> Arc<Mutex<()>> {
        self.lock_for(&format!("config:{slot}"))
    }

    fn read_slot_meta(&self, slot: &str) -> Option<SlotMeta> {
        let raw = fs::read_to_string(self.slot_dir(slot).join("meta.json")).ok()?;
        serde_json::from_str::<SlotMeta>(&raw).ok()
    }

    /// Every stored version of one slot, newest first.
    ///
    /// Derived by walking `versions/` — no index, same rule as the manifest. A
    /// file whose name this module could not have written is skipped rather
    /// than reported: it can only have been dropped in by hand, and an orphaned
    /// `.meta` from a crashed upload is exactly that shape.
    fn slot_versions(&self, slot: &str) -> Vec<SlotVersion> {
        let dir = self.versions_dir(slot);
        let mut out = Vec::new();
        let Ok(files) = fs::read_dir(&dir) else {
            return out;
        };
        for file in files.flatten() {
            let file_name = file.file_name().to_string_lossy().to_string();
            let Some((at_ms, hash)) = split_version_name(&file_name) else {
                continue;
            };
            let Ok(meta) = file.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            out.push(SlotVersion {
                at_ms,
                hash: hash.clone(),
                size: meta.len(),
                meta: fs::read_to_string(dir.join(format!("{at_ms}.{hash}.meta")))
                    .ok()
                    .filter(|m| ids::validate_slot_meta(m).is_ok()),
            });
        }
        // Hash breaks a same-millisecond tie so the answer is stable across
        // calls and machines. `put_config` makes that tie impossible for writes
        // it performed, but a restored backup can carry one.
        out.sort_by(|a, b| (b.at_ms, b.hash.as_str()).cmp(&(a.at_ms, a.hash.as_str())));
        out
    }

    fn summarise_slot(&self, meta: SlotMeta) -> SlotSummary {
        let versions = self.slot_versions(&meta.id);
        SlotSummary {
            meta,
            version_count: versions.len(),
            current: versions.into_iter().next(),
        }
    }

    pub fn list_slots(&self) -> Result<Vec<SlotSummary>> {
        let mut out = Vec::new();
        let dir = match fs::read_dir(self.configs_dir()) {
            Ok(d) => d,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e.into()),
        };
        for entry in dir.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // `tmp` is staging, not a slot; and a directory without a readable
            // meta.json is a half-finished create, skipped for the same reason
            // `list_kbs` skips one.
            if name == "tmp" {
                continue;
            }
            if let Some(meta) = self.read_slot_meta(&name) {
                out.push(self.summarise_slot(meta));
            }
        }
        out.sort_by(|a, b| a.meta.id.cmp(&b.meta.id));
        Ok(out)
    }

    pub fn require_slot(&self, slot: &str) -> Result<SlotSummary> {
        ids::validate_slot_id(slot)?;
        let meta = self
            .read_slot_meta(slot)
            .ok_or_else(|| StoreError::NoSuchSlot(slot.to_string()))?;
        Ok(self.summarise_slot(meta))
    }

    pub fn create_slot(&self, name: &str, requested_id: Option<&str>) -> Result<SlotSummary> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("a name is required".into()));
        }
        if name.chars().count() > 80 {
            return Err(StoreError::Invalid("that name is too long".into()));
        }

        let id = match requested_id {
            Some(id) => {
                ids::validate_slot_id(id)?;
                if self.slot_dir(id).exists() {
                    return Err(StoreError::SlotExists(id.to_string()));
                }
                id.to_string()
            }
            None => {
                let base = ids::slug_for_kb_name(name);
                let mut candidate = base.clone();
                let mut n = 2;
                while self.slot_dir(&candidate).exists() {
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

        let meta = SlotMeta {
            id: id.clone(),
            name: name.to_string(),
            created_at_ms: now_ms(),
        };
        let dir = self.slot_dir(&id);
        fs::create_dir_all(dir.join("versions"))?;
        fs::create_dir_all(self.configs_dir().join("tmp"))?;
        // meta.json last, for the same reason `create_kb` writes it last.
        fs::write(
            dir.join("meta.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )?;
        Ok(self.summarise_slot(meta))
    }

    pub fn rename_slot(&self, slot: &str, name: &str) -> Result<SlotSummary> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("a name is required".into()));
        }
        if name.chars().count() > 80 {
            return Err(StoreError::Invalid("that name is too long".into()));
        }
        let lock = self.slot_lock(slot);
        let _guard = lock.lock().expect("slot lock poisoned");

        let mut meta = self
            .read_slot_meta(slot)
            .ok_or_else(|| StoreError::NoSuchSlot(slot.to_string()))?;
        meta.name = name.to_string();
        fs::write(
            self.slot_dir(slot).join("meta.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )?;
        Ok(self.summarise_slot(meta))
    }

    /// Store a new version and prune the slot's history to `keep`.
    ///
    /// The hash is `sha256` of the uploaded bytes, computed here — see the
    /// section comment for why this resource may do what `put_entry` may not.
    pub fn put_config(&self, slot: &str, write: ConfigWrite<'_>) -> Result<(PutOutcome, String)> {
        let ConfigWrite {
            bytes,
            meta,
            precondition,
            keep,
        } = write;
        self.require_slot(slot)?;
        if bytes.is_empty() {
            return Err(StoreError::Invalid("the config payload is empty".into()));
        }
        if let Some(meta) = meta {
            ids::validate_slot_meta(meta)?;
        }

        let lock = self.slot_lock(slot);
        let _guard = lock.lock().expect("slot lock poisoned");

        let existing = self.slot_versions(slot);
        check_precondition(&precondition, existing.first().map(|v| v.hash.as_str()))?;

        let hash = format!("{:x}", Sha256::digest(bytes));
        // Forced strictly upward past the newest stored version. Two uploads in
        // the same millisecond would otherwise produce two versions sharing an
        // `atMs`, and `atMs` is this resource's *address* — the URL that fetches
        // one of them would be ambiguous, and "newest" would be decided by a
        // hash tiebreak rather than by which upload actually came second.
        let at_ms = match existing.first() {
            Some(newest) if newest.at_ms >= now_ms() => newest.at_ms + 1,
            _ => now_ms(),
        };

        let versions = self.versions_dir(slot);
        fs::create_dir_all(&versions)?;
        let tmp_dir = self.configs_dir().join("tmp");
        fs::create_dir_all(&tmp_dir)?;

        // The sidecar goes down first and is not part of the commit: the
        // payload's rename is still the single point at which this version
        // exists. A crash between the two leaves a `.meta` that `slot_versions`
        // never looks at, because it only reads sidecars for payloads it found.
        if let Some(meta) = meta {
            let _ = fs::write(versions.join(format!("{at_ms}.{hash}.meta")), meta);
        }

        let tmp_path = tmp_dir.join(format!(
            "put-{}-{}-{}.bin",
            at_ms,
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&tmp_path, bytes)?;
        let final_path = versions.join(format!("{at_ms}.{hash}.bin"));
        if let Err(e) = fs::rename(&tmp_path, &final_path) {
            let _ = fs::remove_file(&tmp_path);
            let _ = fs::remove_file(versions.join(format!("{at_ms}.{hash}.meta")));
            return Err(e.into());
        }

        // Pruning is best-effort and happens after the commit, like the
        // knowledge-base sweep: a failure leaves one extra old version, whereas
        // failing the request would report a write that did in fact land.
        self.prune_versions(slot, keep);

        Ok((
            if existing.is_empty() {
                PutOutcome::Created
            } else {
                PutOutcome::Replaced
            },
            hash,
        ))
    }

    /// Keep the newest `keep` versions of a slot, delete the rest.
    fn prune_versions(&self, slot: &str, keep: usize) {
        let keep = keep.max(1);
        let versions = self.slot_versions(slot);
        if versions.len() <= keep {
            return;
        }
        let dir = self.versions_dir(slot);
        for old in &versions[keep..] {
            let _ = fs::remove_file(dir.join(format!("{}.{}.bin", old.at_ms, old.hash)));
            let _ = fs::remove_file(dir.join(format!("{}.{}.meta", old.at_ms, old.hash)));
        }
    }

    /// Read one config version — the newest when `at_ms` is `None`.
    pub fn read_config(&self, slot: &str, at_ms: Option<u64>) -> Result<(Vec<u8>, SlotVersion)> {
        self.require_slot(slot)?;
        let versions = self.slot_versions(slot);
        let version = match at_ms {
            None => versions
                .into_iter()
                .next()
                .ok_or_else(|| StoreError::NoSuchVersion("(latest)".into()))?,
            Some(at) => versions
                .into_iter()
                .find(|v| v.at_ms == at)
                .ok_or_else(|| StoreError::NoSuchVersion(at.to_string()))?,
        };
        let path = self
            .versions_dir(slot)
            .join(format!("{}.{}.bin", version.at_ms, version.hash));
        Ok((fs::read(path)?, version))
    }

    pub fn list_config_versions(&self, slot: &str) -> Result<Vec<SlotVersion>> {
        self.require_slot(slot)?;
        Ok(self.slot_versions(slot))
    }

    /// Delete one version. Refuses to empty a slot that way — a slot with no
    /// versions is a slot the author has to notice they emptied, so removing the
    /// last one is `delete_slot`'s job and says so.
    pub fn delete_config_version(&self, slot: &str, at_ms: u64) -> Result<()> {
        self.require_slot(slot)?;
        let lock = self.slot_lock(slot);
        let _guard = lock.lock().expect("slot lock poisoned");

        let versions = self.slot_versions(slot);
        if versions.len() <= 1 {
            return Err(StoreError::Invalid(
                "this is the only version left — delete the whole backup instead".into(),
            ));
        }
        let version = versions
            .into_iter()
            .find(|v| v.at_ms == at_ms)
            .ok_or_else(|| StoreError::NoSuchVersion(at_ms.to_string()))?;
        let dir = self.versions_dir(slot);
        fs::remove_file(dir.join(format!("{}.{}.bin", version.at_ms, version.hash)))?;
        let _ = fs::remove_file(dir.join(format!("{}.{}.meta", version.at_ms, version.hash)));
        Ok(())
    }

    pub fn delete_slot(&self, slot: &str) -> Result<()> {
        self.require_slot(slot)?;
        let lock = self.slot_lock(slot);
        let _guard = lock.lock().expect("slot lock poisoned");

        let dir = self.slot_dir(slot);
        let _ = fs::remove_file(dir.join("meta.json"));
        fs::remove_dir_all(&dir)?;
        self.locks
            .lock()
            .expect("lock map poisoned")
            .remove(&format!("config:{slot}"));
        Ok(())
    }

    /// Total bytes every stored config version occupies.
    pub fn config_bytes(&self) -> u64 {
        self.list_slots()
            .unwrap_or_default()
            .iter()
            .map(|slot| {
                self.slot_versions(&slot.meta.id)
                    .iter()
                    .map(|v| v.size)
                    .sum::<u64>()
            })
            .sum()
    }

    // ── Administration ──────────────────────────────────────────────────────
    //
    // Everything below exists for the admin console and has no client on the
    // sync API. It is kept in this module rather than beside the console's
    // handlers because it touches the same layout the rest of the file owns —
    // a second place that knows `<id>.<hash>.zip` is a second place to get it
    // wrong.

    /// The data directory, for the maintenance scans that walk it directly.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// One knowledge base's directory.
    pub fn kb_path(&self, kb: &str) -> PathBuf {
        self.kb_dir(kb)
    }

    /// Change a knowledge base's display name.
    ///
    /// The **id** is deliberately not changeable: it is the entry's address in
    /// every client's binding and in every URL, and renaming it would silently
    /// unbind every machine. The display name is the part that was always free
    /// to change — `meta.json` is the only place it appears.
    pub fn rename_kb(&self, kb: &str, name: &str) -> Result<KbSummary> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("a name is required".into()));
        }
        if name.chars().count() > 80 {
            return Err(StoreError::Invalid("that name is too long".into()));
        }
        let lock = self.lock_for(kb);
        let _guard = lock.lock().expect("kb lock poisoned");

        let mut meta = self
            .read_kb_meta(kb)
            .ok_or_else(|| StoreError::NoSuchKb(kb.to_string()))?;
        meta.name = name.to_string();
        fs::write(
            self.kb_dir(kb).join("meta.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )?;
        Ok(self.summarise(meta))
    }

    /// Delete a knowledge base and everything in it.
    ///
    /// `meta.json` goes first, so a failure part-way through leaves a directory
    /// that `list_kbs` already skips rather than a listed base whose entries are
    /// half gone — the same ordering `create_kb` uses in reverse, and for the
    /// same reason.
    pub fn delete_kb(&self, kb: &str) -> Result<()> {
        self.require_kb(kb)?;
        let lock = self.lock_for(kb);
        let _guard = lock.lock().expect("kb lock poisoned");

        let dir = self.kb_dir(kb);
        let _ = fs::remove_file(dir.join("meta.json"));
        fs::remove_dir_all(&dir)?;
        self.locks.lock().expect("lock map poisoned").remove(kb);
        Ok(())
    }

    /// Total bytes of one knowledge base's stored payloads.
    ///
    /// Sums the payload files rather than the directory, so it answers "how much
    /// of this is the author's work" and not "how many blocks did the filesystem
    /// spend" — the number the console puts next to an entry count.
    pub fn kb_bytes(&self, kb: &str) -> u64 {
        let mut total = 0u64;
        let entries_root = self.kb_dir(kb).join("entries");
        let Ok(categories) = fs::read_dir(&entries_root) else {
            return 0;
        };
        for category in categories.flatten() {
            let Ok(files) = fs::read_dir(category.path()) else {
                continue;
            };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().to_string();
                if split_payload_name(&name).is_none() {
                    continue;
                }
                if let Ok(meta) = file.metadata() {
                    total += meta.len();
                }
            }
        }
        total
    }

    /// Every payload file that is *not* the one `find_payload` would serve.
    ///
    /// These are the leftovers of a crash between the commit rename and the
    /// sweep that removes the previous version. Returned as
    /// `(kb, path, keeper, losers)` so the console can show which file wins
    /// before offering to delete the rest — deleting the wrong one of two files
    /// that differ only in a hash is not a mistake anyone can see afterwards.
    pub fn duplicate_payloads(&self) -> Vec<DuplicateEntry> {
        let mut out = Vec::new();
        let Ok(kbs) = fs::read_dir(self.kbs_dir()) else {
            return out;
        };
        for kb_dir in kbs.flatten() {
            let kb = kb_dir.file_name().to_string_lossy().to_string();
            let Ok(categories) = fs::read_dir(kb_dir.path().join("entries")) else {
                continue;
            };
            for category in categories.flatten() {
                let cat_name = category.file_name().to_string_lossy().to_string();
                let Ok(files) = fs::read_dir(category.path()) else {
                    continue;
                };
                let mut by_id: HashMap<String, Vec<PayloadFile>> = HashMap::new();
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().to_string();
                    let Some((id, hash)) = split_payload_name(&name) else {
                        continue;
                    };
                    let Ok(meta) = file.metadata() else { continue };
                    by_id.entry(id).or_default().push(PayloadFile {
                        file_name: name,
                        path: file.path(),
                        hash,
                        size: meta.len(),
                        updated_at_ms: mtime_ms(&meta),
                    });
                }
                for (id, mut files) in by_id {
                    if files.len() < 2 {
                        continue;
                    }
                    // Same ordering as `find_payload`: newest mtime wins, hash
                    // breaks the tie, so the file this reports as the keeper is
                    // the file a download would actually return.
                    files.sort_by(|a, b| {
                        (b.updated_at_ms, b.hash.as_str()).cmp(&(a.updated_at_ms, a.hash.as_str()))
                    });
                    let keeper = files.remove(0);
                    out.push(DuplicateEntry {
                        kb: kb.clone(),
                        path: format!("{cat_name}/{id}"),
                        keeper,
                        losers: files,
                    });
                }
            }
        }
        out.sort_by(|a, b| (a.kb.as_str(), a.path.as_str()).cmp(&(b.kb.as_str(), b.path.as_str())));
        out
    }

    /// Delete every superseded payload. Returns (files removed, bytes freed).
    pub fn remove_duplicate_payloads(&self) -> (usize, u64) {
        let mut files = 0usize;
        let mut bytes = 0u64;
        for duplicate in self.duplicate_payloads() {
            // Under the base's own write lock: a concurrent upload to this entry
            // is creating exactly the kind of second file this sweep deletes.
            let lock = self.lock_for(&duplicate.kb);
            let _guard = lock.lock().expect("kb lock poisoned");
            for loser in &duplicate.losers {
                if fs::remove_file(&loser.path).is_ok() {
                    files += 1;
                    bytes += loser.size;
                }
            }
        }
        (files, bytes)
    }

    /// Staged uploads left behind by a killed process.
    pub fn stray_staging(&self) -> Vec<StrayFile> {
        let mut out = Vec::new();
        let Ok(kbs) = fs::read_dir(self.kbs_dir()) else {
            return out;
        };
        for kb_dir in kbs.flatten() {
            let kb = kb_dir.file_name().to_string_lossy().to_string();
            let tmp = kb_dir.path().join("tmp");
            let Ok(files) = fs::read_dir(&tmp) else {
                continue;
            };
            for file in files.flatten() {
                let Ok(meta) = file.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                out.push(StrayFile {
                    kb: kb.clone(),
                    rel: format!("kbs/{kb}/tmp/{}", file.file_name().to_string_lossy()),
                    lock_key: Some(kb.clone()),
                    path: file.path(),
                    size: meta.len(),
                    updated_at_ms: mtime_ms(&meta),
                });
            }
        }
        if let Ok(files) = fs::read_dir(self.configs_dir().join("tmp")) {
            for file in files.flatten() {
                let Ok(meta) = file.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                out.push(StrayFile {
                    kb: String::new(),
                    rel: format!("configs/tmp/{}", file.file_name().to_string_lossy()),
                    lock_key: None,
                    path: file.path(),
                    size: meta.len(),
                    updated_at_ms: mtime_ms(&meta),
                });
            }
        }
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        out
    }

    /// Remove every staged file. Returns (files removed, bytes freed).
    ///
    /// Safe at any time and in any state: a staged file is only ever read by the
    /// `rename` that commits it, and that rename happens microseconds after the
    /// write inside one locked call. Anything still sitting there belongs to a
    /// process that is gone.
    pub fn clear_staging(&self) -> (usize, u64) {
        let mut files = 0usize;
        let mut bytes = 0u64;
        for stray in self.stray_staging() {
            let lock = stray.lock_key.as_deref().map(|key| self.lock_for(key));
            let _guard = lock.as_ref().map(|l| l.lock().expect("kb lock poisoned"));
            if fs::remove_file(&stray.path).is_ok() {
                files += 1;
                bytes += stray.size;
            }
        }
        (files, bytes)
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

/// Split `<atMs>.<hash>.bin` back into its two halves.
///
/// Split from the *left*, unlike an entry's name: both halves here are produced
/// by this module (decimal digits and a hex digest), neither can contain a dot,
/// and the first dot is therefore always the separator. Anything else — an
/// orphaned `.meta`, a file an operator dropped in — returns `None` and is
/// skipped by every caller.
fn split_version_name(file_name: &str) -> Option<(u64, String)> {
    let stem = file_name.strip_suffix(".bin")?;
    let (at_ms, hash) = stem.split_once('.')?;
    if ids::validate_hash(hash).is_err() {
        return None;
    }
    Some((at_ms.parse::<u64>().ok()?, hash.to_string()))
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
        // A non-ASCII display name keeps its name and gets a digest-derived id,
        // so two of them are told apart by the id rather than by which was made
        // first (see `ids::slug_for_kb_name`).
        let cjk = s.create_kb("我的武侠世界", None).unwrap().meta;
        assert!(cjk.id.starts_with("kb-"), "{}", cjk.id);
        assert_eq!(cjk.name, "我的武侠世界");
        let other = s.create_kb("东海奇谭", None).unwrap().meta;
        assert_ne!(other.id, cjk.id);
    }

    // ── Application-config backups ──────────────────────────────────────────

    fn write(s: &Store, slot: &str, body: &[u8], keep: usize) -> (PutOutcome, String) {
        s.put_config(
            slot,
            ConfigWrite {
                bytes: body,
                meta: None,
                precondition: Precondition::None,
                keep,
            },
        )
        .unwrap()
    }

    #[test]
    fn a_config_slot_round_trips_and_hashes_its_own_bytes() {
        let (_d, s) = store();
        let slot = s.create_slot("书房台式机", None).unwrap();
        assert!(slot.meta.id.starts_with("kb-"), "{}", slot.meta.id);
        assert_eq!(slot.version_count, 0);
        assert!(
            slot.current.is_none(),
            "a fresh slot has nothing to restore"
        );

        let payload = br#"{"kind":"envelope"}"#;
        let (outcome, hash) = write(&s, &slot.meta.id, payload, 10);
        assert_eq!(outcome, PutOutcome::Created);
        // Computed here, not supplied — the one place this resource departs
        // from `put_entry`, so the value has to be checkable from the outside.
        assert_eq!(hash, format!("{:x}", Sha256::digest(payload)));

        let (bytes, version) = s.read_config(&slot.meta.id, None).unwrap();
        assert_eq!(bytes, payload);
        assert_eq!(version.hash, hash);
        assert_eq!(s.list_slots().unwrap()[0].version_count, 1);
    }

    #[test]
    fn the_current_version_is_the_newest_one() {
        let (_d, s) = store();
        let slot = s.create_slot("laptop", Some("laptop")).unwrap().meta.id;
        write(&s, &slot, b"first", 10);
        let (_, second) = write(&s, &slot, b"second", 10);

        let summary = s.require_slot(&slot).unwrap();
        assert_eq!(summary.version_count, 2);
        assert_eq!(summary.current.as_ref().unwrap().hash, second);
        assert_eq!(s.read_config(&slot, None).unwrap().0, b"second");

        // Every version stays addressable by its own timestamp — that is what
        // makes "restore the one from before I broke it" possible at all.
        let versions = s.list_config_versions(&slot).unwrap();
        let oldest = versions.last().unwrap().at_ms;
        assert_eq!(s.read_config(&slot, Some(oldest)).unwrap().0, b"first");
    }

    #[test]
    fn versions_in_the_same_millisecond_stay_distinguishable() {
        // Two pushes can land inside one millisecond, and `atMs` is this
        // resource's *address*: a shared one would make the URL that fetches a
        // version ambiguous and decide "newest" by a hash tiebreak instead of by
        // which upload actually came second.
        let (_d, s) = store();
        let slot = s.create_slot("box", Some("box")).unwrap().meta.id;
        for i in 0..5u8 {
            write(&s, &slot, &[i], 10);
        }
        let versions = s.list_config_versions(&slot).unwrap();
        assert_eq!(versions.len(), 5);
        let mut stamps: Vec<u64> = versions.iter().map(|v| v.at_ms).collect();
        let before = stamps.len();
        stamps.dedup();
        assert_eq!(stamps.len(), before, "two versions share an atMs");
        assert_eq!(s.read_config(&slot, None).unwrap().0, vec![4u8]);
    }

    #[test]
    fn history_is_pruned_to_the_keep_count() {
        let (_d, s) = store();
        let slot = s.create_slot("box", Some("box")).unwrap().meta.id;
        for i in 0..6u8 {
            write(&s, &slot, &[i], 3);
        }
        let versions = s.list_config_versions(&slot).unwrap();
        assert_eq!(versions.len(), 3, "only the newest three survive");
        assert_eq!(s.read_config(&slot, None).unwrap().0, vec![5u8]);
        // The pruned ones are gone from disk, not merely hidden from the list.
        let files = fs::read_dir(s.versions_dir(&slot)).unwrap().count();
        assert_eq!(files, 3);
    }

    #[test]
    fn a_precondition_stops_the_second_machine() {
        let (_d, s) = store();
        let slot = s.create_slot("box", Some("box")).unwrap().meta.id;

        // First push: nothing must be stored yet.
        s.put_config(
            &slot,
            ConfigWrite {
                bytes: b"a",
                meta: None,
                precondition: Precondition::Absent,
                keep: 10,
            },
        )
        .unwrap();
        // The same expectation a second time is the "another device got here
        // first" case, reported with what is actually stored.
        let err = s
            .put_config(
                &slot,
                ConfigWrite {
                    bytes: b"b",
                    meta: None,
                    precondition: Precondition::Absent,
                    keep: 10,
                },
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::Precondition { current: Some(_) }));

        let current = s.require_slot(&slot).unwrap().current.unwrap().hash;
        s.put_config(
            &slot,
            ConfigWrite {
                bytes: b"b",
                meta: None,
                precondition: Precondition::Match(current),
                keep: 10,
            },
        )
        .unwrap();
        assert_eq!(s.read_config(&slot, None).unwrap().0, b"b");
    }

    #[test]
    fn display_metadata_is_stored_verbatim_and_never_parsed() {
        let (_d, s) = store();
        let slot = s.create_slot("box", Some("box")).unwrap().meta.id;
        s.put_config(
            &slot,
            ConfigWrite {
                bytes: b"payload",
                meta: Some("eyJkZXZpY2UiOiJSRUlORSJ9"),
                precondition: Precondition::None,
                keep: 10,
            },
        )
        .unwrap();
        let version = s.require_slot(&slot).unwrap().current.unwrap();
        assert_eq!(version.meta.as_deref(), Some("eyJkZXZpY2UiOiJSRUlORSJ9"));

        // Anything outside base64url is refused rather than stored: it ends up
        // in a response header, and a header cannot carry arbitrary bytes.
        assert!(s
            .put_config(
                &slot,
                ConfigWrite {
                    bytes: b"payload",
                    meta: Some("not base64!"),
                    precondition: Precondition::None,
                    keep: 10,
                },
            )
            .is_err());
    }

    #[test]
    fn an_orphan_sidecar_is_ignored_not_listed() {
        // What a crash between the sidecar write and the payload's commit
        // rename leaves behind. It must read as "that version never happened".
        let (_d, s) = store();
        let slot = s.create_slot("box", Some("box")).unwrap().meta.id;
        write(&s, &slot, b"real", 10);
        fs::write(
            s.versions_dir(&slot)
                .join(format!("999999999999.{H1}.meta")),
            "abc",
        )
        .unwrap();

        assert_eq!(s.list_config_versions(&slot).unwrap().len(), 1);
        assert_eq!(s.read_config(&slot, None).unwrap().0, b"real");
        assert!(matches!(
            s.read_config(&slot, Some(999_999_999_999)),
            Err(StoreError::NoSuchVersion(_))
        ));
    }

    #[test]
    fn deleting_the_last_version_is_refused_but_the_slot_can_go() {
        let (_d, s) = store();
        let slot = s.create_slot("box", Some("box")).unwrap().meta.id;
        write(&s, &slot, b"one", 10);
        let only = s.list_config_versions(&slot).unwrap()[0].at_ms;
        assert!(matches!(
            s.delete_config_version(&slot, only),
            Err(StoreError::Invalid(_))
        ));

        write(&s, &slot, b"two", 10);
        s.delete_config_version(&slot, only).unwrap();
        assert_eq!(s.list_config_versions(&slot).unwrap().len(), 1);

        s.delete_slot(&slot).unwrap();
        assert!(matches!(
            s.require_slot(&slot),
            Err(StoreError::NoSuchSlot(_))
        ));
        assert!(s.list_slots().unwrap().is_empty());
    }

    #[test]
    fn slots_and_knowledge_bases_do_not_see_each_other() {
        // Unrelated resources that happen to share a data directory and an id
        // shape. A slot must not be reachable as a base, or the other way.
        let (_d, s) = store();
        s.create_kb("shared", Some("shared")).unwrap();
        s.create_slot("shared", Some("shared")).unwrap();

        assert_eq!(s.list_kbs().unwrap().len(), 1);
        assert_eq!(s.list_slots().unwrap().len(), 1);
        assert!(matches!(
            s.require_slot("nope"),
            Err(StoreError::NoSuchSlot(_))
        ));
        assert!(matches!(s.manifest("nope"), Err(StoreError::NoSuchKb(_))));

        // Deleting one leaves the other standing.
        s.delete_slot("shared").unwrap();
        assert_eq!(s.list_kbs().unwrap().len(), 1);
    }

    #[test]
    fn config_staging_is_swept_without_a_slot_lock() {
        // `configs/tmp/` is shared by every slot, so there is no single lock
        // that covers it — the sweep has to work anyway.
        let (_d, s) = store();
        s.create_slot("box", Some("box")).unwrap();
        let tmp = s.configs_dir().join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("put-1-2-3.bin"), b"stranded").unwrap();

        let strays = s.stray_staging();
        assert_eq!(strays.len(), 1);
        assert_eq!(strays[0].rel, "configs/tmp/put-1-2-3.bin");
        assert!(strays[0].lock_key.is_none());

        let (files, bytes) = s.clear_staging();
        assert_eq!(files, 1);
        assert_eq!(bytes, 8);
        assert!(s.stray_staging().is_empty());
    }
}
