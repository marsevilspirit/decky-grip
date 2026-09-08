//! Temporary import resources owned by one sidecar lifetime.
use crate::guides::GuideError;
use crate::heybox_renderer;
use crate::lock;
use crate::phone_import::PhoneImportSession;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

struct Capture {
    canceled: Arc<AtomicBool>,
    running: bool,
}

#[derive(Default)]
struct State {
    closed: bool,
    captures: HashMap<String, Capture>,
    phone: Option<PhoneImportSession>,
}

pub(crate) struct ImportSessions {
    state: Mutex<State>,
    stopped: Condvar,
    bundle: PathBuf,
}

impl Default for ImportSessions {
    fn default() -> Self {
        // Installed layout: <plugin>/bin/grip-sidecar and <plugin>/dist/heybox-render.js.
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.parent()?
                    .parent()
                    .map(|root| root.join("dist/heybox-render.js"))
            })
            .unwrap_or_default();
        Self {
            state: Mutex::default(),
            stopped: Condvar::new(),
            bundle,
        }
    }
}

impl ImportSessions {
    // Reserve at protocol intake, before queueing: an immediate cancel must also
    // cancel a capture that has not reached a worker yet.
    pub(crate) fn reserve_capture(
        self: &Arc<Self>,
        source_url: &str,
        marker: &str,
    ) -> Result<CaptureJob, GuideError> {
        heybox_renderer::validate_request(source_url, marker)?;
        let mut state = lock(&self.state);
        if state.closed {
            return Err(GuideError::download("插件正在卸载，无法开始导入"));
        }
        if state.captures.contains_key(marker) || state.captures.len() >= 64 {
            return Err(GuideError::download("导入页面标记正在使用或导入任务过多"));
        }
        let canceled = Arc::new(AtomicBool::new(false));
        state.captures.insert(
            marker.to_owned(),
            Capture {
                canceled: Arc::clone(&canceled),
                running: false,
            },
        );
        Ok(CaptureJob {
            sessions: Arc::clone(self),
            source_url: source_url.to_owned(),
            marker: marker.to_owned(),
            canceled,
        })
    }

    pub(crate) fn cancel_capture(&self, marker: &str) {
        let mut state = lock(&self.state);
        let Some(canceled) = state
            .captures
            .get(marker)
            .map(|capture| Arc::clone(&capture.canceled))
        else {
            return;
        };
        canceled.store(true, Ordering::Release);
        // Queued jobs own no socket. Wait only for an active transport to close.
        while state
            .captures
            .get(marker)
            .is_some_and(|capture| capture.running && Arc::ptr_eq(&capture.canceled, &canceled))
        {
            state = self
                .stopped
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    pub(crate) fn start_phone(&self) -> Result<Value, GuideError> {
        let mut state = lock(&self.state);
        if state.closed {
            return Err(GuideError::download("插件正在卸载，无法开启手机接收"));
        }
        state.phone.take();
        let phone = PhoneImportSession::start()
            .map_err(|error| GuideError::download(format!("手机接收启动失败：{error}")))?;
        let info = phone.info();
        state.phone = Some(phone);
        Ok(info)
    }

    pub(crate) fn get_phone(&self, id: &str) -> Value {
        lock(&self.state)
            .phone
            .as_ref()
            .filter(|phone| phone.id() == id)
            .map_or_else(|| json!({"state": "expired"}), PhoneImportSession::snapshot)
    }

    pub(crate) fn stop_phone(&self, id: &str) {
        let mut state = lock(&self.state);
        if state.phone.as_ref().is_some_and(|phone| phone.id() == id) {
            state.phone.take();
        }
    }

    pub(crate) fn shutdown(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        for capture in state.captures.values() {
            capture.canceled.store(true, Ordering::Release);
        }
        state.phone.take();
        while state.captures.values().any(|capture| capture.running) {
            state = self
                .stopped
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

pub(crate) struct CaptureJob {
    sessions: Arc<ImportSessions>,
    source_url: String,
    marker: String,
    canceled: Arc<AtomicBool>,
}

impl CaptureJob {
    pub(crate) fn run(self) -> Result<Value, GuideError> {
        {
            let mut state = lock(&self.sessions.state);
            if state.closed || self.canceled.load(Ordering::Acquire) {
                return Err(GuideError::download("导入已取消"));
            }
            state
                .captures
                .get_mut(&self.marker)
                .expect("reserved capture")
                .running = true;
        }
        heybox_renderer::capture(
            &self.source_url,
            &self.marker,
            &self.sessions.bundle,
            &self.canceled,
        )
    }
}

impl Drop for CaptureJob {
    fn drop(&mut self) {
        lock(&self.sessions.state).captures.remove(&self.marker);
        self.sessions.stopped.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    const SOURCE: &str = "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed";
    const MARKER: &str = "0123456789abcdef0123456789abcdef";

    fn sessions() -> Arc<ImportSessions> {
        Arc::new(ImportSessions {
            state: Mutex::default(),
            stopped: Condvar::new(),
            // Empty paths fail before renderer discovery: never contact the real port 8080.
            bundle: PathBuf::new(),
        })
    }

    fn wait_for_cancel(canceled: &AtomicBool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !canceled.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "cancellation flag was not set");
            thread::yield_now();
        }
    }

    #[test]
    fn reservations_validate_bound_duplicates_and_release_after_failure() {
        let sessions = sessions();
        assert!(
            sessions
                .reserve_capture("https://example.com", MARKER)
                .is_err()
        );
        assert!(sessions.reserve_capture(SOURCE, "bad-marker").is_err());
        assert!(lock(&sessions.state).captures.is_empty());

        let first = sessions.reserve_capture(SOURCE, MARKER).unwrap();
        assert!(sessions.reserve_capture(SOURCE, MARKER).is_err());
        drop(first);
        let error = sessions
            .reserve_capture(SOURCE, MARKER)
            .unwrap()
            .run()
            .unwrap_err();
        assert!(error.message().contains("渲染组件缺失"));
        assert!(lock(&sessions.state).captures.is_empty());

        let jobs: Vec<_> = (0..64)
            .map(|index| {
                sessions
                    .reserve_capture(SOURCE, &format!("{index:032x}"))
                    .unwrap()
            })
            .collect();
        assert!(sessions.reserve_capture(SOURCE, MARKER).is_err());
        drop(jobs);
        assert!(lock(&sessions.state).captures.is_empty());
        assert!(sessions.reserve_capture(SOURCE, MARKER).is_ok());
    }

    #[test]
    fn canceling_a_queued_reservation_prevents_it_from_starting() {
        let sessions = sessions();
        let job = sessions.reserve_capture(SOURCE, MARKER).unwrap();
        sessions.cancel_capture("unknown");
        sessions.cancel_capture(MARKER);
        sessions.cancel_capture(MARKER);
        assert!(job.canceled.load(Ordering::Acquire));
        assert!(!lock(&sessions.state).captures[MARKER].running);
        assert_eq!(job.run().unwrap_err().message(), "导入已取消");
        assert!(lock(&sessions.state).captures.is_empty());
        let replacement = sessions.reserve_capture(SOURCE, MARKER).unwrap();
        assert!(!replacement.canceled.load(Ordering::Acquire));
    }

    #[test]
    fn active_cancel_waits_until_the_transport_owner_drops() {
        let sessions = sessions();
        let job = sessions.reserve_capture(SOURCE, MARKER).unwrap();
        let canceled = Arc::clone(&job.canceled);
        lock(&sessions.state)
            .captures
            .get_mut(MARKER)
            .unwrap()
            .running = true;
        let canceler_sessions = Arc::clone(&sessions);
        let (done_sender, done_receiver) = mpsc::channel();
        let canceler = thread::spawn(move || {
            canceler_sessions.cancel_capture(MARKER);
            done_sender.send(()).unwrap();
        });
        wait_for_cancel(&canceled);
        assert!(
            done_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );
        drop(job);
        done_receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        canceler.join().unwrap();
        assert!(lock(&sessions.state).captures.is_empty());
    }

    #[test]
    fn active_cancel_does_not_wait_for_a_new_capture_reusing_the_marker() {
        let sessions = sessions();
        let old_canceled = Arc::new(AtomicBool::new(false));
        lock(&sessions.state).captures.insert(
            MARKER.into(),
            Capture {
                canceled: Arc::clone(&old_canceled),
                running: true,
            },
        );
        let canceler_sessions = Arc::clone(&sessions);
        let (done_sender, done_receiver) = mpsc::channel();
        let canceler = thread::spawn(move || {
            canceler_sessions.cancel_capture(MARKER);
            done_sender.send(()).unwrap();
        });
        wait_for_cancel(&old_canceled);
        let new_canceled = Arc::new(AtomicBool::new(false));
        // Model old Drop + same-marker run winning the lock before the canceler's wake.
        lock(&sessions.state).captures.insert(
            MARKER.into(),
            Capture {
                canceled: Arc::clone(&new_canceled),
                running: true,
            },
        );
        sessions.stopped.notify_all();
        let result = done_receiver.recv_timeout(Duration::from_secs(2));
        // Also release a regressed waiter before asserting, so failure cannot leak its thread.
        lock(&sessions.state).captures.remove(MARKER);
        sessions.stopped.notify_all();
        canceler.join().unwrap();
        assert!(
            result.is_ok(),
            "old cancel waited for the replacement capture"
        );
        assert!(!new_canceled.load(Ordering::Acquire));
    }

    #[test]
    fn shutdown_cancels_every_job_but_waits_only_for_running_owners() {
        let sessions = sessions();
        let active = sessions.reserve_capture(SOURCE, MARKER).unwrap();
        let queued = sessions.reserve_capture(SOURCE, &"f".repeat(32)).unwrap();
        lock(&sessions.state)
            .captures
            .get_mut(MARKER)
            .unwrap()
            .running = true;
        let shutdown_sessions = Arc::clone(&sessions);
        let (done_sender, done_receiver) = mpsc::channel();
        let shutdown = thread::spawn(move || {
            shutdown_sessions.shutdown();
            done_sender.send(()).unwrap();
        });
        wait_for_cancel(&active.canceled);
        wait_for_cancel(&queued.canceled);
        assert!(
            done_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );
        drop(active);
        // The queued owner remains alive and must not delay shutdown.
        done_receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        shutdown.join().unwrap();
        assert!(sessions.reserve_capture(SOURCE, MARKER).is_err());
        assert!(sessions.start_phone().is_err());
        assert_eq!(queued.run().unwrap_err().message(), "导入已取消");
        assert!(lock(&sessions.state).captures.is_empty());
        sessions.shutdown();
    }

    #[test]
    fn late_phone_stop_does_not_close_the_replacement_and_shutdown_expires_it() {
        let sessions = sessions();
        let old = PhoneImportSession::start_loopback(Duration::from_secs(60)).unwrap();
        let old_id = old.id().to_owned();
        lock(&sessions.state).phone = Some(old);
        assert_eq!(sessions.get_phone(&old_id)["state"], "waiting");
        let replacement = PhoneImportSession::start_loopback(Duration::from_secs(60)).unwrap();
        let new_id = replacement.id().to_owned();
        assert_ne!(new_id, old_id);
        lock(&sessions.state).phone = Some(replacement);
        sessions.stop_phone(&old_id);
        assert_eq!(sessions.get_phone(&old_id)["state"], "expired");
        assert_eq!(sessions.get_phone(&new_id)["state"], "waiting");
        sessions.shutdown();
        assert_eq!(sessions.get_phone(&new_id)["state"], "expired");
        sessions.stop_phone(&new_id);
    }
}
