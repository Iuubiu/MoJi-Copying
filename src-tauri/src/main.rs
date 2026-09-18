// 桌面壳：一个窗口 + 一份 SQLite 文件。
//
// 数据层在 Rust 这边（src/store.rs + src/commands.rs），前端通过 IPC 调用，
// 不再需要本地 HTTP 服务与端口；也因此在 Windows 上不会触发防火墙询问。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod store;

use std::sync::Arc;

use commands::AppState;
use store::{default_db_path, Store};

fn main() {
    let db_path = default_db_path();
    let store = match Store::open(&db_path) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            // 数据库打不开必须让人看见：静默退出等于用户以为"数据没了"，
            // 而实际上多半只是路径权限或磁盘满了。
            show_fatal(&format!(
                "打开数据库失败：\n\n{error}\n\n位置：{}",
                db_path.display()
            ));
            return;
        }
    };

    if let Err(error) = run(store) {
        show_fatal(&format!("启动失败：\n\n{error}"));
    }
}

fn run(store: Arc<Store>) -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        .manage(AppState { store })
        .invoke_handler(tauri::generate_handler![
            commands::health,
            commands::bootstrap,
            commands::put_book,
            commands::delete_book,
            commands::put_progress,
            commands::put_session,
            commands::delete_session,
            commands::clear_sessions,
            commands::put_setting,
            commands::export_payload,
            commands::import_payload,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}

/// 没有窗口可用的阶段（启动早期）用系统弹窗把话说清楚。
#[cfg(windows)]
fn show_fatal(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }

    let text: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    let caption: Vec<u16> = "墨迹 · 启动失败".encode_utf16().chain(std::iter::once(0)).collect();
    // 0x10 = MB_ICONERROR
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10) };
}

#[cfg(not(windows))]
fn show_fatal(message: &str) {
    eprintln!("{message}");
}
