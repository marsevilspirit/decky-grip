//! Read-only Steam Deck L4 hotkey monitoring.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REPORT_SIZE: usize = 64;
const REPORT_HEADER: [u8; 4] = [0x01, 0x00, 0x09, 0x40];
const L4_MASK: u32 = 0x0000_0200;
const DEBOUNCE: Duration = Duration::from_millis(350);
const PEER_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const READ_POLL_INTERVAL: Duration = Duration::from_millis(100);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const STEAM_DECK_HID_ID: &str = "0003:000028DE:00001205";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HotkeyEvent {
    pub detected_at_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HotkeyStatus {
    pub available: bool,
    pub button: &'static str,
    pub device: Option<String>,
    pub running: bool,
}

#[derive(Clone)]
struct DevicePaths {
    device_root: PathBuf,
    sysfs_root: PathBuf,
    proc_root: PathBuf,
}

impl DevicePaths {
    fn candidate_devices(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&self.device_root) else {
            return Vec::new();
        };
        let mut candidates: Vec<_> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                if !name.to_string_lossy().starts_with("hidraw") {
                    return None;
                }
                let identity =
                    fs::read_to_string(self.sysfs_root.join(&name).join("device").join("uevent"))
                        .ok()?
                        .to_ascii_uppercase();
                let hid_id = identity
                    .lines()
                    .find_map(|line| line.strip_prefix("HID_ID="))
                    .unwrap_or_default();
                if hid_id != STEAM_DECK_HID_ID {
                    return None;
                }
                let resolved = fs::canonicalize(self.sysfs_root.join(&name)).ok()?;
                if !resolved
                    .components()
                    .any(|component| component.as_os_str().to_string_lossy().ends_with(":1.2"))
                {
                    return None;
                }
                Some(entry.path())
            })
            .collect();
        candidates.sort();
        candidates
    }

    fn other_process_has_device_open(&self, path: &Path) -> bool {
        let Ok(device) = fs::metadata(path) else {
            return false;
        };
        if !device.file_type().is_char_device() {
            return false;
        }
        let Ok(processes) = fs::read_dir(&self.proc_root) else {
            return false;
        };
        let own_pid = std::process::id().to_string();
        let own_executable = fs::metadata(self.proc_root.join(&own_pid).join("exe"))
            .ok()
            .map(|metadata| (metadata.dev(), metadata.ino()));
        for process in processes.filter_map(Result::ok) {
            let name = process.file_name();
            let name = name.to_string_lossy();
            if name == own_pid || name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit())
            {
                continue;
            }
            if own_executable.is_some_and(|own| {
                fs::metadata(process.path().join("exe"))
                    .ok()
                    .is_some_and(|metadata| (metadata.dev(), metadata.ino()) == own)
            }) {
                continue;
            }
            let Ok(descriptors) = fs::read_dir(process.path().join("fd")) else {
                continue;
            };
            for descriptor in descriptors.filter_map(Result::ok) {
                let Ok(opened) = fs::metadata(descriptor.path()) else {
                    continue;
                };
                if opened.file_type().is_char_device() && opened.rdev() == device.rdev() {
                    return true;
                }
            }
        }
        false
    }

    fn connect(&self) -> Option<Connection> {
        for path in self.candidate_devices() {
            if !self.other_process_has_device_open(&path) {
                continue;
            }
            let Ok(file) = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(&path)
            else {
                continue;
            };
            // Do not keep hidraw layered open by ourselves if Steam vanished
            // between the peer scan and open().
            if !self.other_process_has_device_open(&path) {
                drop(file);
                continue;
            }
            return Some(Connection { file, path });
        }
        None
    }
}

struct Connection {
    file: File,
    path: PathBuf,
}

#[derive(Default)]
struct ReportState {
    seeded: bool,
    pressed: bool,
    last_emit_at: Option<Instant>,
}

impl ReportState {
    fn reset_connection(&mut self) {
        self.seeded = false;
        self.pressed = false;
    }

    fn process(&mut self, report: &[u8], now: Instant) -> bool {
        if report.len() != REPORT_SIZE || !report.starts_with(&REPORT_HEADER) {
            return false;
        }
        let buttons = u32::from_le_bytes(report[12..16].try_into().expect("four report bytes"));
        let pressed = buttons & L4_MASK != 0;
        if !self.seeded {
            self.seeded = true;
            self.pressed = pressed;
            return false;
        }
        let rising_edge = pressed && !self.pressed;
        self.pressed = pressed;
        if !rising_edge
            || self
                .last_emit_at
                .is_some_and(|last| now.saturating_duration_since(last) < DEBOUNCE)
        {
            return false;
        }
        self.last_emit_at = Some(now);
        true
    }
}

#[derive(Default)]
struct SharedState {
    device: Option<PathBuf>,
}

pub struct L4HotkeyMonitor {
    events: Sender<HotkeyEvent>,
    paths: DevicePaths,
    shared: Arc<Mutex<SharedState>>,
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl L4HotkeyMonitor {
    pub fn new(
        events: Sender<HotkeyEvent>,
        device_root: PathBuf,
        sysfs_root: PathBuf,
        proc_root: PathBuf,
    ) -> Self {
        Self {
            events,
            paths: DevicePaths {
                device_root,
                sysfs_root,
                proc_root,
            },
            shared: Arc::new(Mutex::new(SharedState::default())),
            stop: None,
            thread: None,
        }
    }

    pub fn start(&mut self) -> io::Result<()> {
        if self
            .thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
        {
            return Ok(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.stop = None;

        let initial_connection = self.paths.connect();
        let paths = self.paths.clone();
        let events = self.events.clone();
        let shared = Arc::clone(&self.shared);
        let (stop, stop_receiver) = mpsc::channel();
        set_device(
            &self.shared,
            initial_connection
                .as_ref()
                .map(|connection| connection.path.clone()),
        );
        let thread = match thread::Builder::new()
            .name("grip-l4-hotkey".to_owned())
            .spawn(move || run_monitor(paths, events, shared, stop_receiver, initial_connection))
        {
            Ok(thread) => thread,
            Err(error) => {
                set_device(&self.shared, None);
                return Err(error);
            }
        };
        self.stop = Some(stop);
        self.thread = Some(thread);
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        set_device(&self.shared, None);
    }

    pub fn status(&self) -> HotkeyStatus {
        let device = self
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .device
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        HotkeyStatus {
            available: device.is_some(),
            button: "L4",
            device,
            running: self
                .thread
                .as_ref()
                .is_some_and(|thread| !thread.is_finished()),
        }
    }
}

impl Drop for L4HotkeyMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_monitor(
    paths: DevicePaths,
    events: Sender<HotkeyEvent>,
    shared: Arc<Mutex<SharedState>>,
    stop: Receiver<()>,
    mut connection: Option<Connection>,
) {
    let mut reports = ReportState::default();
    let mut next_peer_check = Instant::now();
    if let Some(connection) = &connection {
        set_device(&shared, Some(connection.path.clone()));
    }

    loop {
        match stop.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        if connection.is_none() {
            connection = paths.connect();
            let Some(connected) = &connection else {
                if wait_for_stop(&stop, RECONNECT_DELAY) {
                    break;
                }
                continue;
            };
            reports.reset_connection();
            set_device(&shared, Some(connected.path.clone()));
            next_peer_check = Instant::now();
        }

        let now = Instant::now();
        if now >= next_peer_check {
            next_peer_check = now + PEER_CHECK_INTERVAL;
            let peer_gone = connection
                .as_ref()
                .is_none_or(|connected| !paths.other_process_has_device_open(&connected.path));
            if peer_gone {
                disconnect(&mut connection, &shared, &mut reports);
                continue;
            }
        }

        let mut report = [0_u8; REPORT_SIZE];
        let read_result = connection
            .as_mut()
            .expect("connection was checked")
            .file
            .read(&mut report);
        match read_result {
            Ok(0) => {
                disconnect(&mut connection, &shared, &mut reports);
                if wait_for_stop(&stop, RECONNECT_DELAY) {
                    break;
                }
            }
            Ok(size) => {
                queue_report(&mut reports, &report[..size], Instant::now(), &events);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if wait_for_stop(&stop, READ_POLL_INTERVAL) {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => {
                disconnect(&mut connection, &shared, &mut reports);
                if wait_for_stop(&stop, RECONNECT_DELAY) {
                    break;
                }
            }
        }
    }
    disconnect(&mut connection, &shared, &mut reports);
}

fn queue_report(
    reports: &mut ReportState,
    report: &[u8],
    now: Instant,
    events: &Sender<HotkeyEvent>,
) -> bool {
    if !reports.process(report, now) {
        return false;
    }
    let _ = events.send(HotkeyEvent {
        detected_at_unix_ms: unix_time_ms(),
    });
    true
}

fn disconnect(
    connection: &mut Option<Connection>,
    shared: &Arc<Mutex<SharedState>>,
    reports: &mut ReportState,
) {
    *connection = None;
    reports.reset_connection();
    set_device(shared, None);
}

fn set_device(shared: &Arc<Mutex<SharedState>>, device: Option<PathBuf>) {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .device = device;
}

fn wait_for_stop(stop: &Receiver<()>, timeout: Duration) -> bool {
    matches!(
        stop.recv_timeout(timeout),
        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected)
    )
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestTree {
        root: PathBuf,
        device_root: PathBuf,
        sysfs_root: PathBuf,
        proc_root: PathBuf,
    }

    impl TestTree {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "grip-hotkey-test-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let device_root = root.join("dev");
            let sysfs_root = root.join("sys/class/hidraw");
            let proc_root = root.join("proc");
            fs::create_dir_all(&device_root).unwrap();
            fs::create_dir_all(&sysfs_root).unwrap();
            fs::create_dir_all(&proc_root).unwrap();
            Self {
                root,
                device_root,
                sysfs_root,
                proc_root,
            }
        }

        fn add_candidate(&self, name: &str, hid_id: &str, interface: &str) -> PathBuf {
            let device = self.device_root.join(name);
            symlink("/dev/null", &device).unwrap();
            let target = self
                .root
                .join("sys/devices")
                .join(interface)
                .join("hidraw")
                .join(name);
            fs::create_dir_all(target.join("device")).unwrap();
            fs::write(target.join("device/uevent"), format!("HID_ID={hid_id}\n")).unwrap();
            symlink(target, self.sysfs_root.join(name)).unwrap();
            device
        }

        fn add_peer(&self, pid: u32, descriptor: &str) -> PathBuf {
            let path = self.proc_root.join(pid.to_string()).join("fd");
            fs::create_dir_all(&path).unwrap();
            let descriptor = path.join(descriptor);
            symlink("/dev/null", &descriptor).unwrap();
            descriptor
        }

        fn set_executable(&self, pid: u32, executable: &Path) {
            let process = self.proc_root.join(pid.to_string());
            fs::create_dir_all(&process).unwrap();
            symlink(executable, process.join("exe")).unwrap();
        }

        fn monitor(&self, events: Sender<HotkeyEvent>) -> L4HotkeyMonitor {
            L4HotkeyMonitor::new(
                events,
                self.device_root.clone(),
                self.sysfs_root.clone(),
                self.proc_root.clone(),
            )
        }
    }

    impl Drop for TestTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn report(l4: bool) -> [u8; REPORT_SIZE] {
        let mut report = [0_u8; REPORT_SIZE];
        report[..REPORT_HEADER.len()].copy_from_slice(&REPORT_HEADER);
        if l4 {
            report[13] = 2;
        }
        report
    }

    #[test]
    fn emits_once_for_each_press_edge() {
        let start = Instant::now();
        let mut state = ReportState::default();
        assert!(!state.process(&report(false), start));
        assert!(state.process(&report(true), start));
        assert!(!state.process(&report(true), start));
        assert!(!state.process(&report(false), start));
        assert!(state.process(&report(true), start + Duration::from_secs(1)));
    }

    #[test]
    fn rising_edges_are_queued_for_the_future_protocol_layer() {
        let start = Instant::now();
        let mut state = ReportState::default();
        let (events, receiver) = mpsc::channel();
        assert!(!queue_report(&mut state, &report(false), start, &events));
        assert!(queue_report(&mut state, &report(true), start, &events));
        assert!(receiver.recv().unwrap().detected_at_unix_ms > 0);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn initial_hold_is_seeded_and_debounce_survives_reconnect() {
        let start = Instant::now();
        let mut state = ReportState::default();
        assert!(!state.process(&report(true), start));
        assert!(!state.process(&report(false), start));
        assert!(state.process(&report(true), start));

        state.reset_connection();
        assert!(!state.process(&report(true), start + Duration::from_millis(100)));
        assert!(!state.process(&report(false), start + Duration::from_millis(100)));
        assert!(!state.process(&report(true), start + Duration::from_millis(100)));
        assert!(!state.process(&report(false), start + Duration::from_millis(400)));
        assert!(state.process(&report(true), start + Duration::from_millis(400)));
    }

    #[test]
    fn rejects_wrong_reports_and_neighboring_grip_buttons() {
        let start = Instant::now();
        let mut state = ReportState::default();
        assert!(!state.process(b"short", start));

        let mut wrong_type = report(true);
        wrong_type[2] = 8;
        assert!(!state.process(&wrong_type, start));

        let idle = report(false);
        let mut r5 = idle;
        r5[10] = 1;
        let mut r4 = idle;
        r4[13] = 4;
        assert!(!state.process(&idle, start));
        assert!(!state.process(&r5, start));
        assert!(!state.process(&r4, start));
        assert!(state.process(&report(true), start));
    }

    #[test]
    fn finds_only_the_steam_deck_gamepad_data_interface() {
        let tree = TestTree::new();
        tree.add_candidate("hidraw0", "0003:000028DE:00001204", "3-3:1.2");
        tree.add_candidate("hidraw1", STEAM_DECK_HID_ID, "3-3:1.1");
        let expected = tree.add_candidate("hidraw2", STEAM_DECK_HID_ID, "3-3:1.2");
        let (events, _receiver) = mpsc::channel();
        let monitor = tree.monitor(events);

        assert_eq!(monitor.paths.candidate_devices(), vec![expected]);
    }

    #[test]
    fn peer_scan_excludes_self_and_fails_closed() {
        let tree = TestTree::new();
        let device = tree.add_candidate("hidraw2", STEAM_DECK_HID_ID, "3-3:1.2");
        tree.add_peer(std::process::id(), "5");
        let other = tree.add_peer(123, "4");
        let (events, _receiver) = mpsc::channel();
        let monitor = tree.monitor(events);

        assert!(monitor.paths.other_process_has_device_open(&device));
        fs::remove_file(other).unwrap();
        assert!(!monitor.paths.other_process_has_device_open(&device));
        fs::remove_file(&device).unwrap();
        fs::write(&device, b"not a character device").unwrap();
        assert!(!monitor.paths.other_process_has_device_open(&device));

        let unavailable = DevicePaths {
            proc_root: tree.root.join("missing-proc"),
            ..monitor.paths.clone()
        };
        assert!(!unavailable.other_process_has_device_open(Path::new("/dev/null")));
    }

    #[test]
    fn peer_scan_ignores_the_same_executable_but_keeps_real_peers() {
        let tree = TestTree::new();
        let device = tree.add_candidate("hidraw2", STEAM_DECK_HID_ID, "3-3:1.2");
        let sidecar = tree.root.join("grip-sidecar");
        let steam = tree.root.join("steam");
        fs::write(&sidecar, b"sidecar").unwrap();
        fs::write(&steam, b"steam").unwrap();

        let own_pid = std::process::id();
        let sidecar_pid = own_pid.checked_add(1).unwrap();
        let steam_pid = own_pid.checked_add(2).unwrap();
        tree.set_executable(own_pid, &sidecar);
        tree.set_executable(sidecar_pid, &sidecar);
        tree.add_peer(sidecar_pid, "4");
        let (events, _receiver) = mpsc::channel();
        let monitor = tree.monitor(events);

        assert!(!monitor.paths.other_process_has_device_open(&device));
        tree.set_executable(steam_pid, &steam);
        tree.add_peer(steam_pid, "5");
        assert!(monitor.paths.other_process_has_device_open(&device));
    }

    #[test]
    fn connect_opens_read_only_nonblocking_and_close_on_exec() {
        let tree = TestTree::new();
        let device = tree.add_candidate("hidraw2", STEAM_DECK_HID_ID, "3-3:1.2");
        let peer = tree.add_peer(123, "4");
        let (events, _receiver) = mpsc::channel();
        let monitor = tree.monitor(events);

        let connection = monitor.paths.connect().unwrap();
        assert_eq!(connection.path, device);
        let descriptor = connection.file.as_raw_fd();
        let status_flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
        let descriptor_flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        assert_ne!(status_flags, -1);
        assert_ne!(descriptor_flags, -1);
        assert_eq!(status_flags & libc::O_ACCMODE, libc::O_RDONLY);
        assert_ne!(status_flags & libc::O_NONBLOCK, 0);
        assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);

        fs::remove_file(peer).unwrap();
        assert!(monitor.paths.connect().is_none());
    }

    #[test]
    fn lifecycle_is_idempotent_and_status_tracks_the_worker() {
        let tree = TestTree::new();
        let (events, _receiver) = mpsc::channel();
        let mut monitor = tree.monitor(events);
        assert_eq!(
            monitor.status(),
            HotkeyStatus {
                available: false,
                button: "L4",
                device: None,
                running: false,
            }
        );

        monitor.start().unwrap();
        let thread_id = monitor.thread.as_ref().unwrap().thread().id();
        monitor.start().unwrap();
        assert_eq!(monitor.thread.as_ref().unwrap().thread().id(), thread_id);
        assert!(monitor.status().running);
        monitor.stop();
        assert_eq!(
            monitor.status(),
            HotkeyStatus {
                available: false,
                button: "L4",
                device: None,
                running: false,
            }
        );
    }
}
