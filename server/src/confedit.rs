//! Writing the config file back, without destroying it.
//!
//! The admin console edits the same file an operator edits by hand, which makes
//! exactly one thing non-negotiable: **their comments and ordering survive.** A
//! config file's comments are where the reasoning lives — why this bind address,
//! why this limit was raised — and a console that serialized its own struct over
//! the top would delete all of it on the first save. Nobody edits a file by hand
//! twice after that happens.
//!
//! So edits go through `toml_edit`'s document model, which keeps every byte it
//! was not asked to change. Keys the console does not know about are left
//! untouched for the same reason: an operator may be running a newer file than
//! this binary understands, and silently dropping the parts it cannot parse is
//! the worst way to find that out.

use std::path::Path;

use toml_edit::{DocumentMut, Item, Table, Value};

use crate::config::{harden_permissions, TokenEntry};

pub type Result<T> = std::result::Result<T, String>;

/// One setting the console may change, as `("server.bind", value)`.
pub enum Setting {
    Str(&'static str, String),
    Int(&'static str, i64),
    Bool(&'static str, bool),
}

impl Setting {
    fn key(&self) -> &'static str {
        match self {
            Setting::Str(k, _) | Setting::Int(k, _) | Setting::Bool(k, _) => k,
        }
    }

    fn value(&self) -> Value {
        match self {
            Setting::Str(_, v) => Value::from(v.clone()),
            Setting::Int(_, v) => Value::from(*v),
            Setting::Bool(_, v) => Value::from(*v),
        }
    }
}

fn read(path: &Path) -> Result<DocumentMut> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读不到配置文件 {}：{e}", path.display()))?;
    text.parse::<DocumentMut>()
        .map_err(|e| format!("配置文件不是合法的 TOML：{e}"))
}

/// Write the document out via a temporary file in the same directory.
///
/// A truncate-then-write would leave the file empty if the process died between
/// the two — and the file it would empty is the one holding every credential the
/// server needs to start. The rename is atomic, so a reader sees the old file or
/// the new one.
fn commit(path: &Path, doc: &DocumentMut) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config")
    ));
    std::fs::write(&tmp, doc.to_string()).map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    harden_permissions(&tmp);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存不了 {}：{e}", path.display())
    })?;
    harden_permissions(path);
    Ok(())
}

/// Ensure `[section]` exists and hand back a mutable reference to it.
fn section<'a>(doc: &'a mut DocumentMut, name: &str) -> &'a mut Table {
    if !doc.contains_key(name) {
        let mut table = Table::new();
        // Not implicit: an operator opening the file should see `[admin]`
        // written out, not a dotted key they then have to reason about.
        table.set_implicit(false);
        doc.insert(name, Item::Table(table));
    }
    doc[name]
        .as_table_mut()
        .expect("the section was just created as a table")
}

/// Replace one key's value, keeping everything written around it.
///
/// `Table::insert` on an existing key replaces the whole key-value *including
/// its decor* — and in a TOML file "decor" is where the comments live. The
/// comment explaining why `max_entry_mb` was raised sits in the decor attached
/// to that key, so inserting over it silently deletes the operator's note about
/// the very line they are changing. Editing the value in place leaves the key
/// (and the comment above it) untouched, and carrying the old value's own decor
/// across keeps a trailing `# …` on the same line.
fn set_value(table: &mut Table, key: &str, value: Value) {
    if let Some(item) = table.get_mut(key) {
        if let Some(existing) = item.as_value() {
            let decor = existing.decor().clone();
            let mut fresh = value;
            *fresh.decor_mut() = decor;
            *item = Item::Value(fresh);
            return;
        }
    }
    table.insert(key, Item::Value(value));
}

/// Apply a batch of settings in one save.
///
/// Batched because a save from the console is one user action: applying half of
/// it and failing on the rest would leave the file in a state the operator never
/// asked for and cannot see.
pub fn apply(path: &Path, settings: &[Setting]) -> Result<()> {
    let mut doc = read(path)?;
    for setting in settings {
        let (table_name, key) = setting
            .key()
            .split_once('.')
            .ok_or_else(|| format!("不认识的配置项 {:?}", setting.key()))?;
        let table = section(&mut doc, table_name);
        set_value(table, key, setting.value());
    }
    commit(path, &doc)
}

/// Append a `[[tokens]]` entry.
pub fn add_token(path: &Path, name: &str, value: &str, created_at_ms: u64) -> Result<()> {
    let mut doc = read(path)?;
    let array = doc
        .entry("tokens")
        .or_insert_with(|| Item::ArrayOfTables(Default::default()))
        .as_array_of_tables_mut()
        .ok_or_else(|| "配置文件里的 tokens 不是 [[tokens]] 数组".to_string())?;
    let mut table = Table::new();
    table.insert("name", Item::Value(Value::from(name)));
    table.insert("value", Item::Value(Value::from(value)));
    table.insert(
        "created_at_ms",
        Item::Value(Value::from(created_at_ms as i64)),
    );
    array.push(table);
    commit(path, &doc)
}

/// Remove the `[[tokens]]` entry whose value hashes to `id`.
///
/// Matched by the derived id rather than by index: the console's list and the
/// file can be out of step by any hand edit in between, and deleting "the third
/// one" would then delete the wrong credential.
pub fn remove_token(path: &Path, id: &str) -> Result<bool> {
    let mut doc = read(path)?;
    let Some(array) = doc
        .get_mut("tokens")
        .and_then(|i| i.as_array_of_tables_mut())
    else {
        return Ok(false);
    };
    let before = array.len();
    array.retain(|table| {
        table
            .get("value")
            .and_then(|v| v.as_str())
            .map(|value| TokenEntry::derive_id(value) != id)
            .unwrap_or(true)
    });
    if array.len() == before {
        return Ok(false);
    }
    commit(path, &doc)?;
    Ok(true)
}

/// Rename a `[[tokens]]` entry.
pub fn rename_token(path: &Path, id: &str, name: &str) -> Result<bool> {
    let mut doc = read(path)?;
    let Some(array) = doc
        .get_mut("tokens")
        .and_then(|i| i.as_array_of_tables_mut())
    else {
        return Ok(false);
    };
    let mut hit = false;
    for table in array.iter_mut() {
        let matches = table
            .get("value")
            .and_then(|v| v.as_str())
            .map(|value| TokenEntry::derive_id(value) == id)
            .unwrap_or(false);
        if matches {
            table.insert("name", Item::Value(Value::from(name)));
            hit = true;
        }
    }
    if !hit {
        return Ok(false);
    }
    commit(path, &doc)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# 这行注释必须活下来
[server]
# 为什么是 0.0.0.0：家里的另外两台机器要连
bind = "0.0.0.0:8787"

# 调大过一次：白鹿书院那个条目带了 40 张图
max_entry_mb = 64            # 反代那边也改了
allow_anonymous = false

[[tokens]]
name = "书房 iMac"
value = "aiw_abcdefghijklmnop"
"#;

    fn sample_file() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aiw-kb.toml");
        std::fs::write(&path, SAMPLE).unwrap();
        (dir, path)
    }

    #[test]
    fn keeps_comments_and_untouched_keys() {
        let (_dir, path) = sample_file();
        apply(&path, &[Setting::Int("server.max_entry_mb", 128)]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# 这行注释必须活下来"));
        assert!(text.contains("# 为什么是 0.0.0.0：家里的另外两台机器要连"));
        assert!(text.contains("bind = \"0.0.0.0:8787\""));
        assert!(text.contains("max_entry_mb = 128"));
        // The two that a plain `insert` silently eats: the comment above the key
        // being changed, and the one trailing it on the same line. Both explain
        // *this* setting, so losing them on the one save that touches it is the
        // worst possible time to lose them.
        assert!(
            text.contains("# 调大过一次：白鹿书院那个条目带了 40 张图"),
            "the comment above the edited key was deleted:\n{text}"
        );
        assert!(
            text.contains("# 反代那边也改了"),
            "the trailing comment on the edited line was deleted:\n{text}"
        );
    }

    #[test]
    fn a_bool_keeps_its_comment_too() {
        let (_dir, path) = sample_file();
        apply(&path, &[Setting::Bool("server.allow_anonymous", true)]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("allow_anonymous = true"));
        assert!(text.contains("# 调大过一次"), "{text}");
    }

    #[test]
    fn creates_a_missing_section() {
        let (_dir, path) = sample_file();
        apply(
            &path,
            &[
                Setting::Str("admin.username", "admin".into()),
                Setting::Str("admin.password", "hunter2".into()),
            ],
        )
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[admin]"));
        assert!(text.contains("password = \"hunter2\""));
    }

    #[test]
    fn adds_and_removes_tokens_by_derived_id() {
        let (_dir, path) = sample_file();
        add_token(&path, "阳台的 iPad", "aiw_zzzzzzzzzzzzzzzz", 1000).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("阳台的 iPad"));

        let id = TokenEntry::derive_id("aiw_abcdefghijklmnop");
        assert!(remove_token(&path, &id).unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("书房 iMac"));
        assert!(text.contains("阳台的 iPad"), "the other one survives");

        assert!(
            !remove_token(&path, "0123456789ab").unwrap(),
            "an unknown id is a no-op, not an error"
        );
    }

    #[test]
    fn renames_a_token_without_touching_its_value() {
        let (_dir, path) = sample_file();
        let id = TokenEntry::derive_id("aiw_abcdefghijklmnop");
        assert!(rename_token(&path, &id, "客厅 iMac").unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("客厅 iMac"));
        assert!(text.contains("value = \"aiw_abcdefghijklmnop\""));
    }

    #[test]
    fn refuses_a_file_that_is_not_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.toml");
        std::fs::write(&path, "[server\nbind =").unwrap();
        let err = apply(&path, &[Setting::Int("server.max_entry_mb", 1)]).unwrap_err();
        assert!(err.contains("合法的 TOML"), "{err}");
    }
}
