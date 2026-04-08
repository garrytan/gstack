//! tray.rs — 시스템 트레이 관리
//!
//! TASK-007: 4가지 상태(Idle/Active/Error/Offline) 아이콘 동적 전환
//!           아이콘 클릭 시 팝오버 윈도우 토글

use std::sync::Mutex;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

/// Tray 아이콘 상태 — bams-server 연결 상태에 따라 변경
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TrayState {
    /// 서버 연결 없음, 대기 중
    Idle,
    /// 활성 파이프라인 존재
    Active,
    /// 에러 발생
    Error,
    /// 서버 오프라인
    Offline,
}

impl Default for TrayState {
    fn default() -> Self {
        TrayState::Idle
    }
}

/// AppState — Tauri manage()로 공유
pub struct TrayAppState {
    pub tray_state: Mutex<TrayState>,
}

impl TrayAppState {
    pub fn new() -> Self {
        Self {
            tray_state: Mutex::new(TrayState::default()),
        }
    }
}

/// 아이콘 바이트를 상태별로 반환
fn icon_bytes_for_state(state: &TrayState) -> &'static [u8] {
    match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle.png"),
        TrayState::Active => include_bytes!("../icons/tray-active.png"),
        TrayState::Error => include_bytes!("../icons/tray-error.png"),
        TrayState::Offline => include_bytes!("../icons/tray-offline.png"),
    }
}

/// Tray 아이콘 초기 설정 (App 초기화 시 1회 호출)
pub fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let icon = Image::from_bytes(icon_bytes_for_state(&TrayState::Idle))
        .expect("tray-idle.png not found");

    let _tray = TrayIconBuilder::with_id("bams-tray")
        .icon(icon)
        .icon_as_template(true) // macOS: 자동 다크/라이트 전환 (흑백 마스크로 처리)
        .title("BAMS")
        .tooltip("BAMS Widget")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_popover(app);
            }
        })
        .build(app)?;

    Ok(())
}

/// 팝오버 윈도우 토글 — 표시 중이면 숨김, 숨겨져 있으면 표시
pub fn toggle_popover(app: &AppHandle) {
    let Some(window) = app.get_webview_window("popover") else {
        eprintln!("[bams-widget] popover window not found");
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Tray 상태를 변경하고 아이콘을 즉시 업데이트
///
/// # 사용 예시 (Tauri IPC command에서 호출)
/// ```rust
/// update_tray_icon(&app_handle, TrayState::Active)?;
/// ```
pub fn update_tray_icon(
    app: &AppHandle,
    state: TrayState,
) -> Result<(), Box<dyn std::error::Error>> {
    // AppState의 tray_state 업데이트
    if let Some(app_state) = app.try_state::<TrayAppState>() {
        let mut current = app_state.tray_state.lock().unwrap();
        if *current == state {
            return Ok(()); // 동일 상태면 스킵
        }
        *current = state.clone();
    }

    // TrayIcon 핸들 획득 후 아이콘 변경
    if let Some(tray) = app.tray_by_id("bams-tray") {
        let icon = Image::from_bytes(icon_bytes_for_state(&state))
            .map_err(|e| format!("icon load error: {e}"))?;
        tray.set_icon(Some(icon))?;

        // tooltip도 상태에 맞게 업데이트
        let tooltip = match &state {
            TrayState::Idle => "BAMS — 대기 중",
            TrayState::Active => "BAMS — 파이프라인 실행 중",
            TrayState::Error => "BAMS — 에러 발생",
            TrayState::Offline => "BAMS — 오프라인",
        };
        tray.set_tooltip(Some(tooltip))?;
    }

    Ok(())
}
