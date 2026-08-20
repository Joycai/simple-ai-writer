//! The activity log — who wrote what, from which machine, and what came back.
//!
//! This is the one place where the server keeps a record it does not have to.
//! Everything else about a knowledge base is derived by walking the filesystem
//! (see `store`'s note on why there is no index), and the same argument would
//! reject a log: it is a second copy of the truth that can disagree with the
//! blobs.
//!
//! It is kept anyway, for one reason: **nothing else can answer "why".** The
//! filesystem knows an entry's current hash; only a log knows that the reason it
//! is not what you expected is that a second machine pushed at 11:52 and yours
//! got a 412. That is the question an operator actually has, and before this the
//! only answer was `journalctl`.
//!
//! It is kept **outside** the truth path so the disagreement cannot matter:
//! nothing reads the log to answer a sync question, `manifest` never consults
//! it, and deleting `audit.log` costs history and nothing else. It lives beside
//! `kbs/`, not inside one, so no knowledge base's directory contains a file the
//! sync protocol does not know about.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How many events stay queryable in memory. The console shows at most a few
/// hundred at a time; this is generous enough that "最近 30 天" is usually
/// answered without touching the disk, and small enough to be free.
const RECENT_CAP: usize = 5_000;

/// Rotate at this size. One event is ~200 bytes, so this is roughly a quarter
/// of a million of them — years, for a server two people write to.
const ROTATE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    #[serde(rename = "atMs")]
    pub at_ms: u64,
    /// `create` · `replace` · `delete` · `download` · `create-kb` · `delete-kb`
    /// · `rename-kb` — the vocabulary the console renders as 创建/替换/….
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// As the client named itself (`X-Source-Device`). Untrusted text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// The presenting token's first characters — never the whole value, because
    /// this file is the one an operator is most likely to paste somewhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub status: u16,
    /// Why it failed, when the status alone does not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AuditEvent {
    pub fn is_write(&self) -> bool {
        matches!(
            self.action.as_str(),
            "create" | "replace" | "delete" | "create-kb" | "delete-kb" | "rename-kb"
        )
    }

    pub fn failed(&self) -> bool {
        self.status >= 400
    }
}

/// One entry-level event, named rather than positional.
///
/// Seven arguments in a row, four of them `Option<&str>`, is a call site where
/// swapping `device` and `token` compiles and silently mislabels every row in
/// the activity page. The same reason `store::EntryWrite` exists.
pub struct EntryLog<'a> {
    pub action: &'a str,
    pub kb: &'a str,
    pub path: &'a str,
    pub device: Option<&'a str>,
    pub token: Option<&'a str>,
    pub status: u16,
    pub detail: Option<String>,
}

pub struct AuditLog {
    path: PathBuf,
    recent: Mutex<VecDeque<AuditEvent>>,
    file: Mutex<Option<File>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl AuditLog {
    /// Open (or create) the log and pull its tail into memory.
    ///
    /// A log that cannot be opened is not an error: the server's job is to store
    /// knowledge bases, and losing the ability to explain a 412 is not a reason
    /// to refuse uploads. Every write below is best-effort for the same reason.
    pub fn open(data_dir: &Path) -> AuditLog {
        let path = data_dir.join("audit.log");
        let recent = read_tail(&path, RECENT_CAP);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| tracing::warn!("could not open the activity log: {e}"))
            .ok();
        AuditLog {
            path,
            recent: Mutex::new(recent),
            file: Mutex::new(file),
        }
    }

    pub fn record(&self, event: AuditEvent) {
        {
            let mut recent = self.recent.lock().expect("audit buffer poisoned");
            recent.push_back(event.clone());
            while recent.len() > RECENT_CAP {
                recent.pop_front();
            }
        }
        let Ok(mut line) = serde_json::to_string(&event) else {
            return;
        };
        line.push('\n');

        let mut slot = self.file.lock().expect("audit file poisoned");
        let Some(file) = slot.as_mut() else { return };
        if file.write_all(line.as_bytes()).is_err() {
            return;
        }
        // Rotation is checked after the write rather than before: the check is a
        // `metadata` call, and doing it on every request to save an occasional
        // 8 MB rename is the wrong way round.
        if file
            .metadata()
            .map(|m| m.len() > ROTATE_BYTES)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
            *slot = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .ok();
        }
    }

    /// Convenience for the common shape: one entry write.
    pub fn entry(&self, entry: EntryLog<'_>) {
        self.record(AuditEvent {
            at_ms: now_ms(),
            action: entry.action.to_string(),
            kb: Some(entry.kb.to_string()),
            path: Some(entry.path.to_string()),
            device: entry.device.map(str::to_string),
            token: entry.token.map(str::to_string),
            status: entry.status,
            detail: entry.detail,
        });
    }

    pub fn snapshot(&self) -> Vec<AuditEvent> {
        self.recent
            .lock()
            .expect("audit buffer poisoned")
            .iter()
            .cloned()
            .collect()
    }

    /// Newest first, filtered.
    pub fn query(&self, filter: &AuditFilter) -> Vec<AuditEvent> {
        let recent = self.recent.lock().expect("audit buffer poisoned");
        let mut out: Vec<AuditEvent> = recent
            .iter()
            .rev()
            .filter(|e| filter.matches(e))
            .take(filter.limit)
            .cloned()
            .collect();
        out.shrink_to_fit();
        out
    }

    /// How many writes landed since `since_ms`.
    pub fn write_count_since(&self, since_ms: u64) -> usize {
        self.recent
            .lock()
            .expect("audit buffer poisoned")
            .iter()
            .filter(|e| e.at_ms >= since_ms && e.is_write() && !e.failed())
            .count()
    }

    /// Writes per bucket over `buckets` buckets of `bucket_ms`, oldest first —
    /// the console's activity bars.
    pub fn histogram(&self, start_ms: u64, bucket_ms: u64, buckets: usize) -> Vec<usize> {
        let mut out = vec![0usize; buckets];
        if bucket_ms == 0 {
            return out;
        }
        for event in self.recent.lock().expect("audit buffer poisoned").iter() {
            if event.at_ms < start_ms || !event.is_write() {
                continue;
            }
            let index = ((event.at_ms - start_ms) / bucket_ms) as usize;
            if index < buckets {
                out[index] += 1;
            }
        }
        out
    }

    /// Every distinct device name seen, for the filter dropdown.
    pub fn devices(&self) -> Vec<String> {
        let mut seen: Vec<String> = self
            .recent
            .lock()
            .expect("audit buffer poisoned")
            .iter()
            .filter_map(|e| e.device.clone())
            .collect();
        seen.sort();
        seen.dedup();
        seen
    }
}

#[derive(Debug, Clone)]
pub struct AuditFilter {
    pub kb: Option<String>,
    pub device: Option<String>,
    pub action: Option<String>,
    pub since_ms: u64,
    pub only_failures: bool,
    pub limit: usize,
}

impl Default for AuditFilter {
    fn default() -> Self {
        AuditFilter {
            kb: None,
            device: None,
            action: None,
            since_ms: 0,
            only_failures: false,
            limit: 200,
        }
    }
}

impl AuditFilter {
    fn matches(&self, event: &AuditEvent) -> bool {
        if event.at_ms < self.since_ms {
            return false;
        }
        if self.only_failures && !event.failed() {
            return false;
        }
        if let Some(kb) = &self.kb {
            if event.kb.as_deref() != Some(kb.as_str()) {
                return false;
            }
        }
        if let Some(device) = &self.device {
            if event.device.as_deref() != Some(device.as_str()) {
                return false;
            }
        }
        if let Some(action) = &self.action {
            if &event.action != action {
                return false;
            }
        }
        true
    }
}

/// Read the last `cap` parseable lines of the log.
///
/// Unparseable lines are skipped rather than fatal: this file is append-only
/// text that a crash can truncate mid-line, and one torn record is not a reason
/// to start with no history.
fn read_tail(path: &Path, cap: usize) -> VecDeque<AuditEvent> {
    let mut out = VecDeque::new();
    let Ok(file) = File::open(path) else {
        return out;
    };
    for line in BufReader::new(file)
        .lines()
        .map_while(std::result::Result::ok)
    {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<AuditEvent>(&line) {
            out.push_back(event);
            if out.len() > cap {
                out.pop_front();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(at_ms: u64, action: &str, kb: &str, status: u16) -> AuditEvent {
        AuditEvent {
            at_ms,
            action: action.to_string(),
            kb: Some(kb.to_string()),
            path: Some("characters/爱丽丝".into()),
            device: Some("MacBook-Pro".into()),
            token: Some("aiw_m3".into()),
            status,
            detail: None,
        }
    }

    #[test]
    fn survives_a_round_trip_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::open(dir.path());
        log.record(event(1000, "replace", "kb", 204));
        log.record(event(2000, "delete", "kb", 204));
        drop(log);

        let reopened = AuditLog::open(dir.path());
        let events = reopened.snapshot();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].action, "delete");
    }

    #[test]
    fn a_torn_last_line_does_not_lose_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::open(dir.path());
        log.record(event(1000, "replace", "kb", 204));
        drop(log);
        let path = dir.path().join("audit.log");
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"atMs\":2000,\"acti");
        std::fs::write(&path, text).unwrap();

        assert_eq!(AuditLog::open(dir.path()).snapshot().len(), 1);
    }

    #[test]
    fn filters_compose() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::open(dir.path());
        log.record(event(1000, "replace", "alpha", 204));
        log.record(event(2000, "replace", "beta", 412));
        log.record(event(3000, "download", "alpha", 200));

        let all = log.query(&AuditFilter::default());
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].at_ms, 3000, "newest first");

        let failures = log.query(&AuditFilter {
            only_failures: true,
            ..Default::default()
        });
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].status, 412);

        let alpha_writes = log.query(&AuditFilter {
            kb: Some("alpha".into()),
            action: Some("replace".into()),
            ..Default::default()
        });
        assert_eq!(alpha_writes.len(), 1);
    }

    #[test]
    fn counts_and_buckets_only_successful_writes() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::open(dir.path());
        log.record(event(1_000, "replace", "kb", 204));
        log.record(event(1_500, "download", "kb", 200));
        log.record(event(2_500, "replace", "kb", 412));
        log.record(event(2_600, "create", "kb", 201));

        assert_eq!(log.write_count_since(0), 2, "download and 412 excluded");
        // A 412 *is* activity, so the histogram counts attempts; the tile counts
        // landings. Two different questions, deliberately two different numbers.
        assert_eq!(log.histogram(1_000, 1_000, 2), vec![1, 2]);
    }
}
