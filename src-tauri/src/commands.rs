//! Tauri IPC 命令：与 HTTP 版（`server/api.py`）一一对应。
//!
//! 前端的数据层（`src/api/`）在桌面里走 `invoke`，在浏览器里走 `fetch`，
//! 两边的方法名与参数形状保持一致 —— 同一份前端因此能在两个宿主里跑，
//! 加功能时只要两边各加一个同名端点即可。
//!
//! 为什么每个命令都把活儿丢进 spawn_blocking：rusqlite 是同步的，
//! 直接在 async 命令里跑会占住 Tauri 的运行时线程，界面会卡。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::store::Store;

pub struct AppState {
    pub store: Arc<Store>,
}

/// 把一次数据库操作挪到阻塞线程池执行。
async fn db<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

#[tauri::command]
pub async fn health(state: State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        Ok(json!({
            "ok": true,
            "app": "MoJi",
            "version": env!("CARGO_PKG_VERSION"),
            "storage": "sqlite",
            "dbPath": store.path().to_string_lossy(),
            "empty": store.is_empty()?,
        }))
    })
    .await
}

#[tauri::command]
pub async fn bootstrap(state: State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || store.bootstrap()).await
}

#[tauri::command]
pub async fn put_book(state: State<'_, AppState>, record: Value) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        store.put_book(&record)?;
        Ok(json!({ "ok": true, "id": record.get("id").cloned().unwrap_or(Value::Null) }))
    })
    .await
}

#[tauri::command]
pub async fn delete_book(state: State<'_, AppState>, book_id: String) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        store.delete_book(&book_id)?;
        Ok(json!({ "ok": true, "id": book_id }))
    })
    .await
}

#[tauri::command]
pub async fn put_progress(
    state: State<'_, AppState>,
    book_id: String,
    index: i64,
    written: String,
    elapsed_ms: i64,
) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        let progress = store.put_progress(&book_id, index, &written, elapsed_ms)?;
        Ok(json!({ "ok": true, "progress": progress }))
    })
    .await
}

/// 写入（或覆盖）一次练习会话，返回重算后的当日汇总。
#[tauri::command]
pub async fn put_session(state: State<'_, AppState>, record: Value) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        let daily = store.put_session(&record)?;
        Ok(json!({ "ok": true, "daily": daily }))
    })
    .await
}

#[tauri::command]
pub async fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        let daily = store.delete_session(&session_id)?;
        Ok(json!({ "ok": true, "daily": daily }))
    })
    .await
}

#[tauri::command]
pub async fn clear_sessions(state: State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        store.clear_sessions()?;
        Ok(json!({ "ok": true }))
    })
    .await
}

#[tauri::command]
pub async fn put_setting(state: State<'_, AppState>, key: String, value: Value) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || {
        store.put_setting(&key, &value)?;
        Ok(json!({ "ok": true, "key": key }))
    })
    .await
}

#[tauri::command]
pub async fn export_payload(state: State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || store.export_payload()).await
}

#[tauri::command]
pub async fn import_payload(
    state: State<'_, AppState>,
    payload: Value,
    mode: String,
) -> Result<Value, String> {
    let store = state.store.clone();
    db(move || store.import_payload(&payload, &mode)).await
}
