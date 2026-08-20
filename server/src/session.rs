//! Admin-console sessions and the lock-out that protects them.
//!
//! Two things separate this from the bearer tokens in `config`:
//!
//! **It is a different credential for a different surface.** The sync API is
//! reached by the app with a 32-byte random token; the admin console is reached
//! by a person with a username and a password they chose. Neither opens the
//! other — a sync token cannot log in here, and a session cookie is not accepted
//! by `/v1`. Collapsing them would mean every machine running the app holds a
//! credential that can also delete every knowledge base.
//!
//! **A password can be guessed.** A 32-byte token cannot be brute-forced over
//! HTTP in any useful time, so the sync API needs no rate limit. A password a
//! human picked can be, which is why failed attempts are counted and the
//! account locks for a while — the one piece of machinery this file exists for.
//!
//! Sessions live in memory only. Restarting the server logs everyone out, which
//! is the correct behavior for a process whose restart usually means its
//! configuration (possibly the password) just changed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::config::random_hex;

/// How many failures before the console stops answering, and for how long.
const MAX_FAILURES: u32 = 5;
const LOCKOUT_MS: u64 = 5 * 60 * 1000;

pub const COOKIE_NAME: &str = "aiw_kb_admin";

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub username: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: u64,
    #[serde(rename = "lastSeenMs")]
    pub last_seen_ms: u64,
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: u64,
    /// What the browser said it is, and where from. Kept for the activity log's
    /// login entries; never trusted for anything.
    pub agent: String,
    pub ip: String,
}

/// One login attempt. Named rather than positional: four adjacent `&str`
/// arguments where two are what the browser sent and two are what the config
/// holds is a call site that compiles perfectly when they are swapped — and a
/// swapped pair means every password is compared against itself.
pub struct LoginAttempt<'a> {
    pub presented_user: &'a str,
    pub presented_password: &'a str,
    pub expected_user: &'a str,
    pub expected_password: &'a str,
    pub session_hours: u64,
    pub agent: &'a str,
    pub ip: &'a str,
}

/// What a login attempt produced.
pub enum LoginOutcome {
    Ok(String),
    Wrong,
    /// Locked out; carries the milliseconds still to wait.
    Locked(u64),
}

#[derive(Default)]
struct Failures {
    count: u32,
    locked_until_ms: u64,
}

#[derive(Default)]
pub struct SessionStore {
    sessions: Mutex<HashMap<String, Session>>,
    failures: Mutex<Failures>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Compare in constant time — same reasoning as the sync API's token check, and
/// more so here, because the compared secret is short enough that a byte-at-a-
/// time oracle is a realistic way to recover it.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

impl SessionStore {
    /// Milliseconds remaining on a lock-out, or 0.
    pub fn locked_for(&self) -> u64 {
        let failures = self.failures.lock().expect("failure map poisoned");
        failures.locked_until_ms.saturating_sub(now_ms())
    }

    pub fn login(&self, attempt: LoginAttempt<'_>) -> LoginOutcome {
        let LoginAttempt {
            presented_user,
            presented_password,
            expected_user,
            expected_password,
            session_hours,
            agent,
            ip,
        } = attempt;
        let remaining = self.locked_for();
        if remaining > 0 {
            return LoginOutcome::Locked(remaining);
        }

        // Both halves are always compared, even when the username is already
        // wrong: returning early on the username would say which of the two was
        // the mistake, and "that user exists" is exactly the half an attacker
        // does not have.
        let user_ok = constant_time_eq(presented_user.as_bytes(), expected_user.as_bytes());
        let pass_ok = constant_time_eq(presented_password.as_bytes(), expected_password.as_bytes());
        if !(user_ok && pass_ok) {
            let mut failures = self.failures.lock().expect("failure map poisoned");
            failures.count += 1;
            if failures.count >= MAX_FAILURES {
                failures.locked_until_ms = now_ms() + LOCKOUT_MS;
                failures.count = 0;
                return LoginOutcome::Locked(LOCKOUT_MS);
            }
            return LoginOutcome::Wrong;
        }

        {
            let mut failures = self.failures.lock().expect("failure map poisoned");
            failures.count = 0;
            failures.locked_until_ms = 0;
        }

        let now = now_ms();
        let id = random_hex(32);
        let session = Session {
            username: expected_user.to_string(),
            created_at_ms: now,
            last_seen_ms: now,
            expires_at_ms: now + session_hours * 3_600_000,
            agent: summarise_agent(agent),
            ip: ip.to_string(),
        };
        self.sessions
            .lock()
            .expect("session map poisoned")
            .insert(id.clone(), session);
        LoginOutcome::Ok(id)
    }

    /// Look up a session and refresh its last-seen stamp. Expired sessions are
    /// dropped here rather than by a sweeper: the only thing that can observe a
    /// stale one is this call.
    pub fn touch(&self, id: &str) -> Option<Session> {
        let mut sessions = self.sessions.lock().expect("session map poisoned");
        let now = now_ms();
        sessions.retain(|_, s| s.expires_at_ms > now);
        let session = sessions.get_mut(id)?;
        session.last_seen_ms = now;
        Some(session.clone())
    }

    pub fn revoke(&self, id: &str) {
        self.sessions
            .lock()
            .expect("session map poisoned")
            .remove(id);
    }

    /// Drop every session except one. Used after a password change — a password
    /// that changed because it may have leaked has to take the sessions with it.
    pub fn revoke_others(&self, keep: &str) -> usize {
        let mut sessions = self.sessions.lock().expect("session map poisoned");
        let before = sessions.len();
        sessions.retain(|id, _| id == keep);
        before - sessions.len()
    }
}

/// Squeeze a User-Agent into something a person recognizes as their own browser.
///
/// Deliberately crude: this is a label that helps someone spot the session that
/// is not theirs, not a device-fingerprinting exercise.
fn summarise_agent(raw: &str) -> String {
    let browser = if raw.contains("Edg/") {
        "Edge"
    } else if raw.contains("Chrome/") && !raw.contains("Chromium") {
        "Chrome"
    } else if raw.contains("Firefox/") {
        "Firefox"
    } else if raw.contains("Safari/") {
        "Safari"
    } else {
        "浏览器"
    };
    let os = if raw.contains("Windows") {
        "Windows"
    } else if raw.contains("Mac OS X") || raw.contains("Macintosh") {
        "macOS"
    } else if raw.contains("iPhone") || raw.contains("iPad") {
        "iOS"
    } else if raw.contains("Android") {
        "Android"
    } else if raw.contains("Linux") {
        "Linux"
    } else {
        "未知系统"
    };
    format!("{browser} · {os}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SessionStore {
        SessionStore::default()
    }

    #[test]
    fn accepts_the_right_credentials_and_rejects_the_rest() {
        let s = store();
        assert!(matches!(
            s.login(LoginAttempt {
                presented_user: "admin",
                presented_password: "hunter2",
                expected_user: "admin",
                expected_password: "hunter2",
                session_hours: 1,
                agent: "curl",
                ip: "::1"
            }),
            LoginOutcome::Ok(_)
        ));
        assert!(matches!(
            s.login(LoginAttempt {
                presented_user: "admin",
                presented_password: "wrong",
                expected_user: "admin",
                expected_password: "hunter2",
                session_hours: 1,
                agent: "curl",
                ip: "::1"
            }),
            LoginOutcome::Wrong
        ));
        assert!(matches!(
            s.login(LoginAttempt {
                presented_user: "root",
                presented_password: "hunter2",
                expected_user: "admin",
                expected_password: "hunter2",
                session_hours: 1,
                agent: "curl",
                ip: "::1"
            }),
            LoginOutcome::Wrong
        ));
    }

    #[test]
    fn locks_out_after_five_failures() {
        let s = store();
        for _ in 0..4 {
            assert!(matches!(
                s.login(LoginAttempt {
                    presented_user: "admin",
                    presented_password: "no",
                    expected_user: "admin",
                    expected_password: "yes",
                    session_hours: 1,
                    agent: "",
                    ip: ""
                }),
                LoginOutcome::Wrong
            ));
        }
        assert!(matches!(
            s.login(LoginAttempt {
                presented_user: "admin",
                presented_password: "no",
                expected_user: "admin",
                expected_password: "yes",
                session_hours: 1,
                agent: "",
                ip: ""
            }),
            LoginOutcome::Locked(_)
        ));
        // Even the correct password is refused while locked: otherwise the lock
        // is only a lock against people who keep guessing wrong.
        assert!(matches!(
            s.login(LoginAttempt {
                presented_user: "admin",
                presented_password: "yes",
                expected_user: "admin",
                expected_password: "yes",
                session_hours: 1,
                agent: "",
                ip: ""
            }),
            LoginOutcome::Locked(_)
        ));
    }

    #[test]
    fn a_success_clears_the_failure_count() {
        let s = store();
        for _ in 0..4 {
            let _ = s.login(LoginAttempt {
                presented_user: "admin",
                presented_password: "no",
                expected_user: "admin",
                expected_password: "yes",
                session_hours: 1,
                agent: "",
                ip: "",
            });
        }
        assert!(matches!(
            s.login(LoginAttempt {
                presented_user: "admin",
                presented_password: "yes",
                expected_user: "admin",
                expected_password: "yes",
                session_hours: 1,
                agent: "",
                ip: ""
            }),
            LoginOutcome::Ok(_)
        ));
        assert!(matches!(
            s.login(LoginAttempt {
                presented_user: "admin",
                presented_password: "no",
                expected_user: "admin",
                expected_password: "yes",
                session_hours: 1,
                agent: "",
                ip: ""
            }),
            LoginOutcome::Wrong
        ));
    }

    #[test]
    fn sessions_can_be_looked_up_and_revoked() {
        let s = store();
        let LoginOutcome::Ok(id) = s.login(LoginAttempt {
            presented_user: "admin",
            presented_password: "yes",
            expected_user: "admin",
            expected_password: "yes",
            session_hours: 1,
            agent: "",
            ip: "",
        }) else {
            panic!("expected a session");
        };
        assert!(s.touch(&id).is_some());
        s.revoke(&id);
        assert!(s.touch(&id).is_none());
    }

    #[test]
    fn an_expired_session_is_not_returned() {
        let s = store();
        let LoginOutcome::Ok(id) = s.login(LoginAttempt {
            presented_user: "admin",
            presented_password: "yes",
            expected_user: "admin",
            expected_password: "yes",
            session_hours: 1,
            agent: "",
            ip: "",
        }) else {
            panic!("expected a session");
        };
        {
            let mut sessions = s.sessions.lock().unwrap();
            sessions.get_mut(&id).unwrap().expires_at_ms = 1;
        }
        assert!(s.touch(&id).is_none());
    }
}
