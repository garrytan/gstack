//! bams-widget Tauri v2 라이브러리 루트
//!
//! 모듈 구성:
//! - tray: 시스템 트레이 관리 (TASK-007)
//! - sidecar: bams-server 사이드카 관리 (TASK-010)
//! - commands: Tauri IPC 커맨드

use std::sync::Arc;
use tauri::{App, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod tray;
mod sidecar;

pub use tray::{TrayAppState, TrayState};
pub use sidecar::SidecarManager;

/// Tauri 앱 초기화 및 실행 (main.rs에서 호출)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // Cmd+Shift+B → 팝오버 토글
                    if event.state() == ShortcutState::Pressed
                        && shortcut.mods.contains(Modifiers::META)
                        && shortcut.mods.contains(Modifiers::SHIFT)
                        && shortcut.key == Code::KeyB
                    {
                        toggle_popover(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(TrayAppState::new())
        .manage(Arc::new(SidecarManager::new()))
        .invoke_handler(tauri::generate_handler![
            cmd_update_tray_state,
            cmd_get_tray_state,
            cmd_toggle_popover,
        ])
        .setup(|app| {
            setup_app(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "popover" {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 앱 종료 이벤트 — 사이드카 정리
            if let tauri::RunEvent::Exit = event {
                if let Some(mgr) = app_handle.try_state::<Arc<SidecarManager>>() {
                    mgr.stop();
                }
            }
        });
}

fn setup_app(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // 트레이 아이콘 설정 (TASK-007)
    tray::setup_tray(app)?;

    // 사이드카 시작 (TASK-010)
    if let Some(mgr) = app.try_state::<Arc<SidecarManager>>() {
        if let Err(e) = mgr.start(app.handle()) {
            eprintln!("[lib] sidecar start error: {}", e);
            // 사이드카 실패 시에도 앱은 계속 실행 (오프라인 모드)
        } else {
            eprintln!("[lib] sidecar status: {}", mgr.status_summary());
        }
    }

    // 글로벌 단축키 Cmd+Shift+B 등록 (TASK-014)
    let shortcut = Shortcut::new(Some(Modifiers::META | Modifiers::SHIFT), Code::KeyB);
    app.global_shortcut().register(shortcut)?;
    eprintln!("[lib] global shortcut registered: Cmd+Shift+B");

    // 기본 창 숨김 (트레이 클릭 시에만 표시)
    if let Some(window) = app.get_webview_window("popover") {
        let _ = window.hide();
    }

    Ok(())
}

/// 팝오버 창 표시/숨김 토글
fn toggle_popover(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("popover") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            // 화면 중앙 상단에 위치 (macOS 메뉴바 아래)
            if let Ok(monitor) = window.primary_monitor() {
                if let Some(monitor) = monitor {
                    let screen_size = monitor.size();
                    let window_size = tauri::PhysicalSize::new(320u32, 400u32);
                    let x = (screen_size.width / 2).saturating_sub(window_size.width / 2) as i32;
                    let y = 40_i32; // 메뉴바 높이
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// IPC Command: 프론트엔드에서 tray 상태 변경 요청
///
/// # 프론트엔드 호출 예시
/// ```typescript
/// import { invoke } from '@tauri-apps/api/core'
/// await invoke('cmd_update_tray_state', { state: 'active' })
/// ```
#[tauri::command]
fn cmd_update_tray_state(
    app: tauri::AppHandle,
    state: TrayState,
) -> Result<(), String> {
    tray::update_tray_icon(&app, state)
        .map_err(|e| e.to_string())
}

/// IPC Command: 현재 tray 상태 조회
#[tauri::command]
fn cmd_get_tray_state(
    app_state: tauri::State<TrayAppState>,
) -> TrayState {
    app_state.tray_state.lock().unwrap().clone()
}

/// IPC Command: 프론트엔드에서 팝오버 토글 요청
#[tauri::command]
fn cmd_toggle_popover(app: tauri::AppHandle) {
    toggle_popover(&app)
}
