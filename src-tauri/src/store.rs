//! SQLite 持久层：一个文件就是全部数据。
//!
//! 表结构与 Python 版（`server/store.py`）逐字一致 —— 两边的数据库文件可以互换。
//! 这不是为了好看：桌面版（Rust）与浏览器版（Python 后端）读同一份数据，
//! 用户换个方式打开不会发现书架少了一本。
//!
//! 为什么每次操作都新开连接：SQLite 连接不能跨线程共享，而 Tauri 的命令跑在
//! 线程池里。本地文件 + WAL 下开连接很便宜，换来的是"不用操心并发"。
//!
//! `daily` 是 `sessions` 的物化视图，写入会话时在同一个事务里重算 ——
//! 统计口径只有一个来源。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

pub type Result<T> = std::result::Result<T, String>;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id         TEXT PRIMARY KEY,
  title      TEXT    NOT NULL DEFAULT '',
  author     TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chapters (
  book_id TEXT    NOT NULL,
  idx     INTEGER NOT NULL,
  title   TEXT    NOT NULL DEFAULT '',
  content TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE IF NOT EXISTS progress (
  id         TEXT PRIMARY KEY,
  book_id    TEXT    NOT NULL,
  idx        INTEGER NOT NULL,
  written    TEXT    NOT NULL DEFAULT '',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS progress_book ON progress(book_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  at            INTEGER NOT NULL DEFAULT 0,
  date          TEXT    NOT NULL DEFAULT '',
  book_id       TEXT    NOT NULL DEFAULT '',
  book_title    TEXT    NOT NULL DEFAULT '',
  chapter_index INTEGER NOT NULL DEFAULT 0,
  chapter_title TEXT    NOT NULL DEFAULT '',
  words         INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  correct       INTEGER NOT NULL DEFAULT 0,
  incorrect     INTEGER NOT NULL DEFAULT 0,
  final         INTEGER NOT NULL DEFAULT 0,
  legacy        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_date ON sessions(date);
CREATE INDEX IF NOT EXISTS sessions_at ON sessions(at);

CREATE TABLE IF NOT EXISTS daily (
  date        TEXT PRIMARY KEY,
  words       INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  count       INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  incorrect   INTEGER NOT NULL DEFAULT 0,
  chapters    TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/* ── 小工具：JSON ↔ SQLite 取值 ───────────────────────────────────────── */

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 取字符串：缺字段、类型不对都当空串（前端偶尔会传 null）。
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// 取整数：缺字段当 0，浮点截断，负数由调用方按业务决定怎么夹。
fn number(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

fn non_negative(value: Option<&Value>) -> i64 {
    number(value).max(0)
}

fn flag(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Bool(true)) => 1,
        Some(Value::Number(n)) => i64::from(n.as_i64().unwrap_or(0) != 0),
        Some(Value::String(s)) => i64::from(s == "true" || s == "1"),
        _ => 0,
    }
}

/* ── 数据目录 ─────────────────────────────────────────────────────────── */

/// 数据库默认位置。
///
/// 便携版优先：可执行文件旁边有 `data` 目录就把数据写进去 ——
/// 整个文件夹拷到 U 盘或另一台机器，抄写进度跟着走。
/// 否则用 `%LOCALAPPDATA%\MoJi\moji.sqlite3`（其它平台 ~/.local/share/moji），
/// 与 Python 版同一个位置 —— 两种启动方式共用一份数据。
pub fn default_db_path() -> PathBuf {
    if let Ok(dir) = std::env::var("MOJI_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("moji.sqlite3");
        }
    }
    if let Some(dir) = portable_dir() {
        return dir.join("moji.sqlite3");
    }
    if cfg!(windows) {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
        });
        PathBuf::from(base).join("MoJi").join("moji.sqlite3")
    } else {
        let base = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            format!("{home}/.local/share")
        });
        PathBuf::from(base).join("moji").join("moji.sqlite3")
    }
}

/// 便携模式的判定：可执行文件旁边有没有 `data` 目录。
///
/// 用"目录在不在"而不是"能不能写"来判断 —— 同一个 exe 的行为不该随
/// 它被放在哪个盘符、哪台机器上而变。目录由便携版压缩包自带。
fn portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("data");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/* ── Store ────────────────────────────────────────────────────────────── */

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("建数据目录失败：{e}"))?;
        }
        let store = Store { path };
        store.init()?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn conn(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path).map_err(|e| format!("打开数据库失败：{e}"))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("设置连接参数失败：{e}"))?;
        Ok(conn)
    }

    fn init(&self) -> Result<()> {
        let conn = self.conn()?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(|e| format!("开启 WAL 失败：{e}"))?;
        conn.execute_batch(SCHEMA).map_err(|e| format!("建表失败：{e}"))?;
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| format!("写版本号失败：{e}"))?;
        Ok(())
    }

    /* ── 读取 ─────────────────────────────────────────────────────────── */

    /// 库里一本书、一条练习记录都没有 —— 界面据此决定要不要做首次导入。
    pub fn is_empty(&self) -> Result<bool> {
        let conn = self.conn()?;
        let books: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(books == 0 && sessions == 0)
    }

    /// 一次性取全量。形状与前端一开始就习惯的那份一致（books / progress /
    /// sessions / daily / settings），前端不必为换后端改数据结构。
    pub fn bootstrap(&self) -> Result<Value> {
        let conn = self.conn()?;

        let mut chapters_by_book: Map<String, Value> = Map::new();
        {
            let mut stmt = conn
                .prepare("SELECT book_id, idx, title, content FROM chapters ORDER BY book_id, idx")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        json!({
                            "title": row.get::<_, String>(2)?,
                            "content": row.get::<_, String>(3)?,
                        }),
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (book_id, chapter) = row.map_err(|e| e.to_string())?;
                let entry = chapters_by_book
                    .entry(book_id)
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Value::Array(list) = entry {
                    list.push(chapter);
                }
            }
        }

        let books = {
            let mut stmt = conn
                .prepare("SELECT id, title, author, updated_at FROM books ORDER BY updated_at DESC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows.into_iter()
                .map(|(id, title, author, updated_at)| {
                    json!({
                        "id": id,
                        "book": {
                            "title": title,
                            "author": author,
                            "chapters": chapters_by_book.get(&id).cloned().unwrap_or_else(|| json!([])),
                        },
                        "updatedAt": updated_at,
                    })
                })
                .collect::<Vec<_>>()
        };

        let progress = {
            let mut stmt = conn
                .prepare("SELECT id, book_id, idx, written, elapsed_ms, updated_at FROM progress")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "bookId": row.get::<_, String>(1)?,
                        "index": row.get::<_, i64>(2)?,
                        "written": row.get::<_, String>(3)?,
                        "elapsedMs": row.get::<_, i64>(4)?,
                        "updatedAt": row.get::<_, i64>(5)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let sessions = {
            let mut stmt = conn
                .prepare("SELECT * FROM sessions ORDER BY at DESC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], session_from_row)
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let daily = {
            let mut stmt = conn
                .prepare("SELECT * FROM daily")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], daily_from_row)
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let settings = {
            let mut stmt = conn
                .prepare("SELECT key, value FROM settings")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    let raw: String = row.get(1)?;
                    Ok(json!({
                        "key": row.get::<_, String>(0)?,
                        "value": serde_json::from_str::<Value>(&raw).unwrap_or(Value::String(raw)),
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        Ok(json!({
            "books": books,
            "progress": progress,
            "sessions": sessions,
            "daily": daily,
            "settings": settings,
        }))
    }

    /* ── 书籍 ─────────────────────────────────────────────────────────── */

    /// 整本写入：元信息 + 章节正文 + 每章进度。
    ///
    /// 章节增删会让后续章节的序号整体前移，而进度是按 `bookId-idx` 存的 ——
    /// 所以这里"先清空该书再按新序号重写"。前端只提交，不用管重排。
    pub fn put_book(&self, payload: &Value) -> Result<()> {
        let book_id = text(payload.get("id"));
        if book_id.is_empty() {
            return Err("book.id 不能为空".into());
        }
        let book = payload.get("book").cloned().unwrap_or_else(|| json!({}));
        let chapters = book
            .get("chapters")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let updated_at = {
            let given = number(payload.get("updatedAt"));
            if given > 0 { given } else { now_ms() }
        };

        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO books(id, title, author, updated_at) VALUES(?1, ?2, ?3, ?4) \
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, \
             updated_at = excluded.updated_at",
            params![
                book_id,
                fallback(&text(book.get("title")), "未命名书籍"),
                fallback(&text(book.get("author")), "本地文本"),
                updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chapters WHERE book_id = ?1", params![book_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM progress WHERE book_id = ?1", params![book_id])
            .map_err(|e| e.to_string())?;

        for (index, chapter) in chapters.iter().enumerate() {
            if !chapter.is_object() {
                continue;
            }
            let title = fallback(&text(chapter.get("title")), &format!("第 {} 章", index + 1));
            tx.execute(
                "INSERT INTO chapters(book_id, idx, title, content) VALUES(?1, ?2, ?3, ?4)",
                params![book_id, index as i64, title, text(chapter.get("content"))],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO progress(id, book_id, idx, written, elapsed_ms, updated_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    format!("{book_id}-{index}"),
                    book_id,
                    index as i64,
                    text(chapter.get("written")),
                    number(chapter.get("timeSpentMs")),
                    updated_at
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_book(&self, book_id: &str) -> Result<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chapters WHERE book_id = ?1", params![book_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM progress WHERE book_id = ?1", params![book_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM books WHERE id = ?1", params![book_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 单章进度：打字时高频调用，只碰一行。
    pub fn put_progress(&self, book_id: &str, index: i64, written: &str, elapsed_ms: i64) -> Result<Value> {
        let record_id = format!("{book_id}-{index}");
        let updated_at = now_ms();
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO progress(id, book_id, idx, written, elapsed_ms, updated_at) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(id) DO UPDATE SET written = excluded.written, \
             elapsed_ms = excluded.elapsed_ms, updated_at = excluded.updated_at",
            params![record_id, book_id, index, written, elapsed_ms, updated_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(json!({
            "id": record_id,
            "bookId": book_id,
            "index": index,
            "written": written,
            "elapsedMs": elapsed_ms,
            "updatedAt": updated_at,
        }))
    }

    /* ── 会话与每日汇总 ───────────────────────────────────────────────── */

    /// 写入（或覆盖）一次会话，并重算它所属那一天的汇总。
    ///
    /// 覆盖写是设计的一部分：练习中每 5 秒落一次库，同一条 recordId
    /// 反复提交的是"这段会话的最新快照"，不是累加。
    pub fn put_session(&self, record: &Value) -> Result<Value> {
        let session_id = text(record.get("id"));
        if session_id.is_empty() {
            return Err("session.id 不能为空".into());
        }
        let day = text(record.get("date"));
        if day.is_empty() {
            return Err("session.date 不能为空".into());
        }

        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO sessions(id, at, date, book_id, book_title, chapter_index, chapter_title, \
             words, duration_ms, correct, incorrect, final, legacy) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
             ON CONFLICT(id) DO UPDATE SET at = excluded.at, date = excluded.date, \
             book_id = excluded.book_id, book_title = excluded.book_title, \
             chapter_index = excluded.chapter_index, chapter_title = excluded.chapter_title, \
             words = excluded.words, duration_ms = excluded.duration_ms, \
             correct = excluded.correct, incorrect = excluded.incorrect, final = excluded.final",
            params![
                session_id,
                number(record.get("at")),
                day,
                text(record.get("bookId")),
                text(record.get("bookTitle")),
                number(record.get("chapterIndex")),
                text(record.get("chapterTitle")),
                non_negative(record.get("words")),
                non_negative(record.get("durationMs")),
                non_negative(record.get("correct")),
                non_negative(record.get("incorrect")),
                flag(record.get("final")),
                flag(record.get("legacy")),
            ],
        )
        .map_err(|e| e.to_string())?;
        let daily = Self::refresh_daily(&tx, &day)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(daily)
    }

    /// 把某一天从 sessions 重新聚合（前端 rollupDaily 的 SQL 版本）。
    fn refresh_daily(tx: &rusqlite::Transaction<'_>, day: &str) -> Result<Value> {
        let rows = {
            let mut stmt = tx
                .prepare(
                    "SELECT book_id, chapter_index, words, duration_ms, correct, incorrect \
                     FROM sessions WHERE date = ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![day], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        if rows.is_empty() {
            tx.execute("DELETE FROM daily WHERE date = ?1", params![day])
                .map_err(|e| e.to_string())?;
            return Ok(json!({
                "date": day, "words": 0, "durationMs": 0, "count": 0,
                "correct": 0, "incorrect": 0, "chapters": {},
            }));
        }

        let mut words = 0;
        let mut duration = 0;
        let mut correct = 0;
        let mut incorrect = 0;
        let mut chapters: Map<String, Value> = Map::new();
        for (book_id, chapter_index, w, d, c, i) in &rows {
            words += w;
            duration += d;
            correct += c;
            incorrect += i;
            let key = format!("{book_id}#{chapter_index}");
            let bucket = chapters.entry(key).or_insert_with(|| json!({
                "words": 0, "durationMs": 0, "count": 0
            }));
            if let Value::Object(map) = bucket {
                bump(map, "words", *w);
                bump(map, "durationMs", *d);
                bump(map, "count", 1);
            }
        }

        let record = json!({
            "date": day,
            "words": words,
            "durationMs": duration,
            "count": rows.len() as i64,
            "correct": correct,
            "incorrect": incorrect,
            "chapters": Value::Object(chapters),
        });
        tx.execute(
            "INSERT INTO daily(date, words, duration_ms, count, correct, incorrect, chapters) \
             VALUES(:date, :words, :durationMs, :count, :correct, :incorrect, :chapters) \
             ON CONFLICT(date) DO UPDATE SET words = excluded.words, \
             duration_ms = excluded.duration_ms, count = excluded.count, \
             correct = excluded.correct, incorrect = excluded.incorrect, chapters = excluded.chapters",
            rusqlite::named_params! {
                ":date": day,
                ":words": words,
                ":durationMs": duration,
                ":count": rows.len() as i64,
                ":correct": correct,
                ":incorrect": incorrect,
                ":chapters": record["chapters"].to_string(),
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(record)
    }

    pub fn delete_session(&self, session_id: &str) -> Result<Value> {
        let mut conn = self.conn()?;
        let day: Option<String> = conn
            .query_row("SELECT date FROM sessions WHERE id = ?1", params![session_id], |row| row.get(0))
            .ok();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|e| e.to_string())?;
        let daily = match day {
            Some(day) => Self::refresh_daily(&tx, &day)?,
            None => Value::Null,
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(daily)
    }

    pub fn clear_sessions(&self) -> Result<()> {
        let conn = self.conn()?;
        conn.execute_batch("DELETE FROM sessions; DELETE FROM daily;")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /* ── 设置 ─────────────────────────────────────────────────────────── */

    pub fn put_setting(&self, key: &str, value: &Value) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /* ── 备份 ─────────────────────────────────────────────────────────── */

    pub fn export_payload(&self) -> Result<Value> {
        let data = self.bootstrap()?;
        Ok(json!({
            "app": "MoJi",
            "format": 1,
            "books": data["books"],
            "progress": data["progress"],
            "sessions": data["sessions"],
            "daily": data["daily"],
            "settings": data["settings"],
        }))
    }

    /// 导入备份：overwrite 先清空，merge 按 id 覆盖同名记录。
    /// `daily` 一律从 sessions 重算 —— 备份里的旧汇总可能已经对不上。
    pub fn import_payload(&self, payload: &Value, mode: &str) -> Result<Value> {
        if mode != "merge" && mode != "overwrite" {
            return Err("mode 只能是 merge 或 overwrite".into());
        }
        let empty = Vec::new();
        let books = payload.get("books").and_then(Value::as_array).unwrap_or(&empty);
        let progress = payload.get("progress").and_then(Value::as_array).unwrap_or(&empty);
        let sessions = payload.get("sessions").and_then(Value::as_array).unwrap_or(&empty);
        let settings = payload.get("settings").and_then(Value::as_array).unwrap_or(&empty);

        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if mode == "overwrite" {
            tx.execute_batch(
                "DELETE FROM books; DELETE FROM chapters; DELETE FROM progress; \
                 DELETE FROM sessions; DELETE FROM daily; DELETE FROM settings;",
            )
            .map_err(|e| e.to_string())?;
        }

        let mut imported_books = 0;
        for record in books {
            let book_id = text(record.get("id"));
            if book_id.is_empty() {
                continue;
            }
            let book = record.get("book").cloned().unwrap_or_else(|| json!({}));
            let updated_at = {
                let given = number(record.get("updatedAt"));
                if given > 0 { given } else { now_ms() }
            };
            tx.execute(
                "INSERT INTO books(id, title, author, updated_at) VALUES(?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, \
                 updated_at = excluded.updated_at",
                params![
                    book_id,
                    fallback(&text(book.get("title")), "未命名书籍"),
                    fallback(&text(book.get("author")), "本地文本"),
                    updated_at
                ],
            )
            .map_err(|e| e.to_string())?;
            imported_books += 1;

            let chapters = book.get("chapters").and_then(Value::as_array).cloned().unwrap_or_default();
            if chapters.is_empty() {
                continue;
            }
            tx.execute("DELETE FROM chapters WHERE book_id = ?1", params![book_id])
                .map_err(|e| e.to_string())?;
            for (index, chapter) in chapters.iter().enumerate() {
                if !chapter.is_object() {
                    continue;
                }
                tx.execute(
                    "INSERT INTO chapters(book_id, idx, title, content) VALUES(?1, ?2, ?3, ?4)",
                    params![
                        book_id,
                        index as i64,
                        fallback(&text(chapter.get("title")), &format!("第 {} 章", index + 1)),
                        text(chapter.get("content"))
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        for record in progress {
            let record_id = text(record.get("id"));
            let book_id = text(record.get("bookId"));
            if record_id.is_empty() || book_id.is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO progress(id, book_id, idx, written, elapsed_ms, updated_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(id) DO UPDATE SET written = excluded.written, \
                 elapsed_ms = excluded.elapsed_ms, updated_at = excluded.updated_at",
                params![
                    record_id,
                    book_id,
                    number(record.get("index")),
                    text(record.get("written")),
                    number(record.get("elapsedMs")),
                    {
                        let given = number(record.get("updatedAt"));
                        if given > 0 { given } else { now_ms() }
                    }
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        let mut imported_sessions = 0;
        for record in sessions {
            if text(record.get("id")).is_empty() || text(record.get("date")).is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO sessions(id, at, date, book_id, book_title, chapter_index, chapter_title, \
                 words, duration_ms, correct, incorrect, final, legacy) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
                 ON CONFLICT(id) DO UPDATE SET at = excluded.at, date = excluded.date, \
                 book_id = excluded.book_id, book_title = excluded.book_title, \
                 chapter_index = excluded.chapter_index, chapter_title = excluded.chapter_title, \
                 words = excluded.words, duration_ms = excluded.duration_ms, \
                 correct = excluded.correct, incorrect = excluded.incorrect, final = excluded.final",
                params![
                    text(record.get("id")),
                    number(record.get("at")),
                    text(record.get("date")),
                    text(record.get("bookId")),
                    text(record.get("bookTitle")),
                    number(record.get("chapterIndex")),
                    text(record.get("chapterTitle")),
                    non_negative(record.get("words")),
                    non_negative(record.get("durationMs")),
                    non_negative(record.get("correct")),
                    non_negative(record.get("incorrect")),
                    flag(record.get("final")),
                    flag(record.get("legacy")),
                ],
            )
            .map_err(|e| e.to_string())?;
            imported_sessions += 1;
        }

        for record in settings {
            let key = text(record.get("key"));
            if key.is_empty() {
                continue;
            }
            let value = record.get("value").cloned().unwrap_or(Value::Null);
            tx.execute(
                "INSERT INTO settings(key, value) VALUES(?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.execute("DELETE FROM daily", []).map_err(|e| e.to_string())?;
        let days = {
            let mut stmt = tx
                .prepare("SELECT DISTINCT date FROM sessions WHERE date <> '' ORDER BY date")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for day in &days {
            Self::refresh_daily(&tx, day)?;
        }
        tx.commit().map_err(|e| e.to_string())?;

        Ok(json!({
            "books": imported_books,
            "sessions": imported_sessions,
            "days": days.len(),
            "mode": mode,
        }))
    }
}

/* ── 行 → JSON ────────────────────────────────────────────────────────── */

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "at": row.get::<_, i64>("at")?,
        "date": row.get::<_, String>("date")?,
        "bookId": row.get::<_, String>("book_id")?,
        "bookTitle": row.get::<_, String>("book_title")?,
        "chapterIndex": row.get::<_, i64>("chapter_index")?,
        "chapterTitle": row.get::<_, String>("chapter_title")?,
        "words": row.get::<_, i64>("words")?,
        "durationMs": row.get::<_, i64>("duration_ms")?,
        "correct": row.get::<_, i64>("correct")?,
        "incorrect": row.get::<_, i64>("incorrect")?,
        "final": row.get::<_, i64>("final")? != 0,
        "legacy": row.get::<_, i64>("legacy")? != 0,
    }))
}

fn daily_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let raw: String = row.get("chapters")?;
    Ok(json!({
        "date": row.get::<_, String>("date")?,
        "words": row.get::<_, i64>("words")?,
        "durationMs": row.get::<_, i64>("duration_ms")?,
        "count": row.get::<_, i64>("count")?,
        "correct": row.get::<_, i64>("correct")?,
        "incorrect": row.get::<_, i64>("incorrect")?,
        "chapters": serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({})),
    }))
}

fn fallback(value: &str, default: &str) -> String {
    if value.trim().is_empty() { default.to_string() } else { value.to_string() }
}

fn bump(map: &mut Map<String, Value>, key: &str, delta: i64) {
    let current = map.get(key).and_then(Value::as_i64).unwrap_or(0);
    map.insert(key.to_string(), json!(current + delta));
}

/* ── 测试 ─────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> Store {
        let path = std::env::temp_dir().join(format!("moji-test-{tag}-{}.sqlite3", now_ms()));
        Store::open(path).unwrap()
    }

    fn session(id: &str, day: &str, words: i64, duration: i64) -> Value {
        json!({
            "id": id, "at": 1, "date": day, "bookId": "b", "chapterIndex": 0,
            "words": words, "durationMs": duration,
        })
    }

    #[test]
    fn book_roundtrip_keeps_chapters_and_progress() {
        let store = temp_store("book");
        store
            .put_book(&json!({
                "id": "b1",
                "book": {
                    "title": "测试书", "author": "作者",
                    "chapters": [
                        { "title": "第一章", "content": "正文一", "written": "正文", "timeSpentMs": 60000 },
                        { "title": "第二章", "content": "正文二" },
                    ],
                },
            }))
            .unwrap();

        let data = store.bootstrap().unwrap();
        assert_eq!(data["books"].as_array().unwrap().len(), 1);
        assert_eq!(data["books"][0]["book"]["title"], "测试书");
        assert_eq!(data["books"][0]["book"]["chapters"].as_array().unwrap().len(), 2);
        // 正文与进度分表：chapters 只有 title/content，written 走 progress
        assert!(data["books"][0]["book"]["chapters"][0].get("written").is_none());
        let progress = data["progress"].as_array().unwrap();
        assert_eq!(progress[0]["written"], "正文");
        assert_eq!(progress[0]["elapsedMs"], 60000);
    }

    #[test]
    fn put_book_rewrites_progress_indices() {
        let store = temp_store("reindex");
        store
            .put_book(&json!({ "id": "b", "book": { "title": "t", "chapters": [
                { "title": "a", "content": "x", "written": "写成这样" },
                { "title": "b", "content": "y", "written": "写成那样" },
                { "title": "c", "content": "z", "written": "写成哪样" },
            ]}}))
            .unwrap();
        // 删掉第二章：原来的第三章节变成 index 1
        store
            .put_book(&json!({ "id": "b", "book": { "title": "t", "chapters": [
                { "title": "a", "content": "x", "written": "写成这样" },
                { "title": "c", "content": "z", "written": "写成哪样" },
            ]}}))
            .unwrap();

        let data = store.bootstrap().unwrap();
        let progress = data["progress"].as_array().unwrap();
        assert_eq!(progress.len(), 2);
        let mut by_index: Vec<(i64, String)> = progress
            .iter()
            .map(|item| (item["index"].as_i64().unwrap(), item["written"].as_str().unwrap().to_string()))
            .collect();
        by_index.sort();
        assert_eq!(by_index[0].1, "写成这样");
        assert_eq!(by_index[1].1, "写成哪样");
    }

    #[test]
    fn session_is_upserted_not_accumulated() {
        let store = temp_store("session");
        store.put_session(&session("s1", "2026-09-18", 100, 60000)).unwrap();
        let daily = store.put_session(&session("s1", "2026-09-18", 180, 120000)).unwrap();
        // 覆盖写：同一条会话反复提交的是"最新快照"，不是累加
        assert_eq!(daily["words"], 180);
        assert_eq!(daily["durationMs"], 120000);
        assert_eq!(daily["count"], 1);
    }

    #[test]
    fn daily_is_rollup_of_sessions() {
        let store = temp_store("daily");
        store.put_session(&session("s1", "2026-09-18", 100, 60000)).unwrap();
        store.put_session(&session("s2", "2026-09-18", 200, 60000)).unwrap();
        store.put_session(&session("s3", "2026-09-17", 50, 30000)).unwrap();

        let data = store.bootstrap().unwrap();
        let daily = data["daily"].as_array().unwrap();
        let day = daily.iter().find(|item| item["date"] == "2026-09-18").unwrap();
        assert_eq!(day["words"], 300);
        assert_eq!(day["count"], 2);
        // 章节维度：bookId#index
        assert_eq!(day["chapters"]["b#0"]["words"], 300);
    }

    #[test]
    fn deleting_last_session_drops_daily_row() {
        let store = temp_store("delete");
        store.put_session(&session("s1", "2026-09-18", 100, 60000)).unwrap();
        store.delete_session("s1").unwrap();
        let data = store.bootstrap().unwrap();
        assert!(data["daily"].as_array().unwrap().is_empty());
    }

    #[test]
    fn import_merge_keeps_others_and_overwrites_same_id() {
        let store = temp_store("import");
        store.put_book(&json!({ "id": "keep", "book": { "title": "保留", "chapters": [] } })).unwrap();
        store.put_session(&session("old", "2026-09-01", 5, 500)).unwrap();

        store
            .import_payload(
                &json!({
                    "books": [{ "id": "new", "book": { "title": "新增", "chapters": [] } }],
                    "sessions": [session("old", "2026-09-01", 99, 9000)],
                }),
                "merge",
            )
            .unwrap();

        let data = store.bootstrap().unwrap();
        assert_eq!(data["books"].as_array().unwrap().len(), 2);
        let sessions = data["sessions"].as_array().unwrap();
        let old = sessions.iter().find(|item| item["id"] == "old").unwrap();
        assert_eq!(old["words"], 99);
        // daily 按 sessions 重算，不会和导入的旧值叠加
        assert_eq!(data["daily"][0]["words"], 99);
    }

    #[test]
    fn persisted_across_reopen() {
        let store = temp_store("reopen");
        store.put_session(&session("s1", "2026-09-18", 42, 4200)).unwrap();
        let path = store.path().to_path_buf();
        drop(store);

        let reopened = Store::open(path).unwrap();
        assert_eq!(reopened.bootstrap().unwrap()["daily"][0]["words"], 42);
    }
}
