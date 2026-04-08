//! sidecar.rs — bams-server 사이드카 관리
//!
//! TASK-010: Tauri sidecar로 bams-server 자동 시작/관리
//!
//! 흐름:
//! 1. 앱 시작 시 포트 3099 점유 확인
//! 2. 이미 점유 중이면 기존 서버 재사용 (외부 bams-server 가정)
//! 3. 미점유 시 사이드카 바이너리 시작
//! 4. 앱 종료 시 SIGTERM으로 정리
//! 5. 비정상 종료 시 최대 3회 재시작

use std::{
    net::TcpStream,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

const BAMS_PORT: u16 = 3099;
const MAX_RESTART: u8 = 3;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 200;
const STARTUP_WAIT_MS: u64 = 500;

// ─────────────────────────────────────────────────────────────
// 사이드카 상태
// ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum SidecarState {
    /// 아직 시작 전
    NotStarted,
    /// 외부 서버 재사용 중 (포트 이미 점유)
    ExternalServer,
    /// 사이드카 프로세스 실행 중
    Running(CommandChild),
    /// 종료됨
    Stopped,
}

pub struct SidecarManager {
    state: Mutex<SidecarState>,
    restart_count: Mutex<u8>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SidecarState::NotStarted),
            restart_count: Mutex::new(0),
        }
    }

    /// 포트 3099 점유 여부 확인
    fn is_port_occupied() -> bool {
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", BAMS_PORT).parse().unwrap(),
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        )
        .is_ok()
    }

    /// 사이드카 시작 (앱 초기화 시 호출)
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();

        // 포트 이미 점유 중 → 기존 서버 재사용
        if Self::is_port_occupied() {
            eprintln!("[sidecar] port {} already in use — reusing existing server", BAMS_PORT);
            *state = SidecarState::ExternalServer;
            return Ok(());
        }

        // 사이드카 바이너리 시작
        self.spawn_sidecar(app, &mut state)
    }

    /// 사이드카 프로세스 생성
    fn spawn_sidecar(
        &self,
        app: &AppHandle,
        state: &mut SidecarState,
    ) -> Result<(), String> {
        let shell = app.shell();

        // tauri.conf.json externalBin에 등록된 바이너리 이름과 일치해야 함
        let (mut rx, child) = shell
            .sidecar("bams-server")
            .map_err(|e| format!("sidecar spawn error: {e}"))?
            .spawn()
            .map_err(|e| format!("sidecar spawn failed: {e}"))?;

        eprintln!("[sidecar] bams-server started on port {}", BAMS_PORT);
        *state = SidecarState::Running(child);

        // 비동기 종료 감지 스레드
        let app_handle = app.clone();
        thread::spawn(move || {
            while let Some(event) = rx.blocking_recv() {
                use tauri_plugin_shell::process::CommandEvent;
                match event {
                    CommandEvent::Terminated(payload) => {
                        let code = payload.code.unwrap_or(-1);
                        eprintln!("[sidecar] bams-server terminated (exit_code={})", code);

                        if let Some(mgr) = app_handle.try_state::<Arc<SidecarManager>>() {
                            mgr.on_terminated(&app_handle);
                        }
                        break;
                    }
                    CommandEvent::Error(msg) => {
                        eprintln!("[sidecar] error: {}", msg);
                    }
                    CommandEvent::Stdout(line) => {
                        let text = String::from_utf8_lossy(&line);
                        eprintln!("[sidecar:stdout] {}", text);
                    }
                    CommandEvent::Stderr(line) => {
                        let text = String::from_utf8_lossy(&line);
                        eprintln!("[sidecar:stderr] {}", text);
                    }
                    _ => {}
                }
            }
        });

        // 서버가 준비될 때까지 잠시 대기
        thread::sleep(Duration::from_millis(STARTUP_WAIT_MS));

        Ok(())
    }

    /// 비정상 종료 시 재시작 처리
    fn on_terminated(&self, app: &AppHandle) {
        let mut count = self.restart_count.lock().unwrap();

        if *count >= MAX_RESTART {
            eprintln!(
                "[sidecar] max restart limit ({}) reached — giving up",
                MAX_RESTART
            );
            *self.state.lock().unwrap() = SidecarState::Stopped;
            return;
        }

        *count += 1;
        let attempt = *count;
        drop(count); // lock 해제

        eprintln!("[sidecar] restarting ({}/{})", attempt, MAX_RESTART);

        // 재시작 전 포트 재확인 (외부 서버가 이미 기동된 경우)
        if Self::is_port_occupied() {
            eprintln!("[sidecar] port {} occupied after restart — using external server", BAMS_PORT);
            *self.state.lock().unwrap() = SidecarState::ExternalServer;
            return;
        }

        let mut state = self.state.lock().unwrap();
        if let Err(e) = self.spawn_sidecar(app, &mut state) {
            eprintln!("[sidecar] restart failed: {}", e);
            *state = SidecarState::Stopped;
        }
    }

    /// 앱 종료 시 사이드카 정리 (SIGTERM)
    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        // take ownership by swapping with Stopped
        let prev = std::mem::replace(&mut *state, SidecarState::Stopped);
        match prev {
            SidecarState::Running(child) => {
                eprintln!("[sidecar] stopping bams-server (kill)");
                if let Err(e) = child.kill() {
                    eprintln!("[sidecar] kill error: {}", e);
                }
            }
            SidecarState::ExternalServer => {
                eprintln!("[sidecar] external server — not stopping");
                // restore state since we took it
                *state = SidecarState::ExternalServer;
            }
            other => {
                *state = other;
            }
        }
    }

    /// 현재 상태 요약 반환 (로그/디버깅용)
    pub fn status_summary(&self) -> &'static str {
        match &*self.state.lock().unwrap() {
            SidecarState::NotStarted => "not_started",
            SidecarState::ExternalServer => "external",
            SidecarState::Running(_) => "running",
            SidecarState::Stopped => "stopped",
        }
    }
}
