use super::{
    MAX_REQUEST_BYTES, PositionStore, ReaderPositionStore, StoreError, dispatch, empty_params,
    params_with_fields, protocol_info, request_fields, valid_id,
};
use crate::guide_html::localized_image_urls;
use crate::guide_images::{GuideImageCache, ImageError, ImageErrorKind};
use crate::guides::{GuideError, GuideErrorKind, GuideReader};
use crate::hotkey::{HotkeyEvent, L4HotkeyMonitor};
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

const QUEUE_CAPACITY: usize = 64;
// The reader can issue three image RPCs at once; keep one slot for foreground work.
const GENERAL_WORKERS: usize = 4;
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const GUIDE_LIBRARY_LIMIT: usize = 20;

enum Work {
    Request(Value),
    Ready(Value),
}

#[derive(Default)]
struct GeneralState {
    requests: VecDeque<Work>,
    active_guides: HashSet<String>,
    active_images: usize,
    closed: bool,
}

#[derive(Default)]
struct GeneralQueue {
    state: Mutex<GeneralState>,
    ready: Condvar,
    space: Condvar,
}

impl GeneralQueue {
    fn send(&self, work: Work) -> Result<(), ()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while state.requests.len() >= QUEUE_CAPACITY && !state.closed {
            state = self
                .space
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        if state.closed {
            return Err(());
        }
        state.requests.push_back(work);
        self.ready.notify_one();
        Ok(())
    }

    fn recv(&self) -> Option<(Work, Option<String>, bool)> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            // ponytail: scan at most 64 jobs; index queues only if this fixed bound grows.
            let runnable = state.requests.iter().position(|work| {
                (!is_image_request(work) || state.active_images < GENERAL_WORKERS - 1)
                    && guide_request_id(work)
                        .is_none_or(|guide_id| !state.active_guides.contains(guide_id))
            });
            if let Some(index) = runnable {
                let work = state.requests.remove(index).expect("request index exists");
                let guide_id = guide_request_id(&work).map(str::to_owned);
                let image_request = is_image_request(&work);
                state.active_images += usize::from(image_request);
                if let Some(guide_id) = &guide_id {
                    state.active_guides.insert(guide_id.clone());
                }
                self.space.notify_one();
                return Some((work, guide_id, image_request));
            }
            if state.closed && state.requests.is_empty() {
                return None;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn complete(&self, guide_id: Option<&str>, image_request: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(guide_id) = guide_id {
            state.active_guides.remove(guide_id);
        }
        state.active_images -= usize::from(image_request);
        self.ready.notify_all();
    }

    fn close(&self) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .closed = true;
        self.ready.notify_all();
        self.space.notify_all();
    }
}

struct GeneralLease<'a> {
    queue: &'a GeneralQueue,
    guide_id: Option<String>,
    image_request: bool,
}

struct GeneralServices {
    monitor: Arc<Mutex<L4HotkeyMonitor>>,
    guides: Arc<GuideReader>,
    images: Arc<GuideImageCache>,
    reader_store: ReaderPositionStore,
}

impl Drop for GeneralLease<'_> {
    fn drop(&mut self) {
        self.queue
            .complete(self.guide_id.as_deref(), self.image_request);
    }
}

fn is_image_request(work: &Work) -> bool {
    matches!(work, Work::Request(request) if request_fields(request)
        .is_ok_and(|(method, _)| matches!(method, "images.get" | "images.download" | "guides.download_status")))
}

fn guide_request_id(work: &Work) -> Option<&str> {
    let Work::Request(request) = work else {
        return None;
    };
    let (method, params) = request_fields(request).ok()?;
    if !matches!(
        method,
        "guides.get" | "guides.get_cached" | "guides.remove" | "guides.remove_offline"
    ) {
        return None;
    }
    params?.as_object()?.get("guide_id")?.as_str()
}

enum RequestError {
    Store(StoreError),
    Guide(GuideError),
    Image(ImageError),
}

impl From<StoreError> for RequestError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

fn response_for_request(
    request: &Value,
    dispatcher: impl FnOnce(&str, Option<&Value>) -> Result<Value, RequestError>,
) -> Value {
    let id = request
        .as_object()
        .and_then(|object| object.get("id"))
        .cloned()
        .unwrap_or(Value::Null);
    match request_fields(request)
        .map_err(RequestError::Store)
        .and_then(|(method, params)| dispatcher(method, params))
    {
        Ok(result) => json!({"id": id, "ok": true, "result": result}),
        Err(error) => error_response(id, error),
    }
}

fn error_response(id: Value, error: RequestError) -> Value {
    let (kind, message) = match &error {
        RequestError::Store(StoreError::Validation(message)) => ("validation", *message),
        RequestError::Store(StoreError::Storage(message)) => ("storage", *message),
        RequestError::Store(StoreError::Durability(message)) => ("durability", *message),
        RequestError::Store(StoreError::Protocol(message)) => ("protocol", *message),
        RequestError::Guide(error) => (guide_error_kind(error.kind()), error.message()),
        RequestError::Image(error) => (image_error_kind(error.kind()), error.message()),
    };
    json!({"error": {"kind": kind, "message": message}, "id": id, "ok": false})
}

fn image_error_kind(kind: ImageErrorKind) -> &'static str {
    match kind {
        ImageErrorKind::Validation => "validation",
        ImageErrorKind::Download => "download",
    }
}

fn guide_error_kind(kind: GuideErrorKind) -> &'static str {
    match kind {
        GuideErrorKind::Validation => "validation",
        GuideErrorKind::Download => "download",
        GuideErrorKind::Parse => "parse",
        GuideErrorKind::Cache => "cache",
    }
}

fn invalid_json_response() -> Value {
    json!({
        "error": {"kind": "protocol", "message": "request is not valid JSON"},
        "id": null,
        "ok": false,
    })
}

fn is_store_request(request: &Value) -> bool {
    request_fields(request).is_ok_and(|(method, _)| {
        method.starts_with("positions.") || method.starts_with("reader_positions.")
    })
}

fn dispatch_general(
    monitor: &Arc<Mutex<L4HotkeyMonitor>>,
    guides: &Arc<GuideReader>,
    images: &Arc<GuideImageCache>,
    reader_store: &ReaderPositionStore,
    method: &str,
    params: Option<&Value>,
) -> Result<Value, RequestError> {
    match method {
        "ping" => {
            empty_params(params)?;
            Ok(protocol_info())
        }
        "hotkey.status" => {
            empty_params(params)?;
            let status = monitor
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .status();
            Ok(json!({
                "available": status.available,
                "button": status.button,
                "device": status.device,
                "running": status.running,
            }))
        }
        "guides.get" => {
            let object = params_with_fields(params, &["guide_id", "force_refresh"])?;
            let guide_id =
                object
                    .get("guide_id")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_id must be a positive decimal string",
                    ))?;
            let force_refresh = object
                .get("force_refresh")
                .and_then(Value::as_bool)
                .ok_or(StoreError::Validation("force_refresh must be a boolean"))?;
            guides
                .get(guide_id, force_refresh)
                .map_err(RequestError::Guide)
        }
        "guides.get_cached" | "guides.download_status" => {
            let object = params_with_fields(params, &["guide_id"])?;
            let guide_id =
                object
                    .get("guide_id")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_id must be a positive decimal string",
                    ))?;
            let guide = guides.get_cached(guide_id).map_err(RequestError::Guide)?;
            if method == "guides.get_cached" {
                return Ok(guide.unwrap_or(Value::Null));
            }
            let Some(guide) = guide else {
                return Ok(json!({"state": "missing", "completed": 0, "total": 0}));
            };
            let mut urls = HashSet::new();
            for section in guide["sections"]
                .as_array()
                .expect("validated guide sections")
            {
                urls.extend(
                    localized_image_urls(section["html"].as_str().expect("validated HTML"))
                        .map_err(|_| {
                            StoreError::Storage("cached guide images could not be inspected")
                        })?,
                );
            }
            let mut completed = 0;
            for url in &urls {
                completed += usize::from(images.is_downloaded(url).map_err(RequestError::Image)?);
            }
            Ok(json!({
                "state": if completed == urls.len() { "complete" } else { "partial" },
                "completed": completed,
                "total": urls.len(),
            }))
        }
        "guides.list" => {
            let object = params_with_fields(params, &["app_id"])?;
            let app_id = match object.get("app_id").expect("app_id was checked") {
                Value::Null => None,
                Value::String(app_id) if valid_id(app_id) => Some(app_id.as_str()),
                _ => {
                    return Err(StoreError::Validation(
                        "app_id must be null or a positive decimal string",
                    )
                    .into());
                }
            };
            let mut entries = Vec::new();
            for entry in reader_store.recent(app_id, GUIDE_LIBRARY_LIMIT)? {
                let cache = guides
                    .cached_summary(&entry.guide_id, entry.section_id.as_deref())
                    .map_err(RequestError::Guide)?;
                entries.push(json!({
                    "appId": entry.app_id,
                    "cache": cache,
                    "guideId": entry.guide_id,
                    "updatedAt": entry.updated_at_ms,
                }));
            }
            Ok(Value::Array(entries))
        }
        "guides.clear" => {
            empty_params(params)?;
            guides.clear_guide_cache().map_err(RequestError::Guide)
        }
        "guides.remove" | "guides.remove_offline" => {
            let object = params_with_fields(params, &["guide_id"])?;
            let guide_id =
                object
                    .get("guide_id")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_id must be a positive decimal string",
                    ))?;
            if method == "guides.remove_offline" {
                guides
                    .remove_offline_guide(guide_id, images)
                    .map_err(RequestError::Guide)
            } else {
                guides
                    .remove_guide_cache(guide_id)
                    .map_err(RequestError::Guide)
            }
        }
        "guides.stats" => {
            empty_params(params)?;
            guides.cache_stats().map_err(RequestError::Guide)
        }
        "images.get" => {
            let object = params_with_fields(params, &["url", "allow_download"])?;
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .ok_or(StoreError::Validation("image URL is invalid"))?;
            let allow_download = object
                .get("allow_download")
                .and_then(Value::as_bool)
                .ok_or(StoreError::Validation("allow_download must be a boolean"))?;
            Ok(images
                .get(url, allow_download)
                .map_err(RequestError::Image)?
                .unwrap_or(Value::Null))
        }
        "images.download" => {
            let object = params_with_fields(params, &["url"])?;
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .ok_or(StoreError::Validation("image URL is invalid"))?;
            Ok(json!(images.download(url).map_err(RequestError::Image)?))
        }
        "images.clear" => {
            empty_params(params)?;
            Ok(images.clear())
        }
        "images.set_limit" => {
            let object = params_with_fields(params, &["bytes"])?;
            let bytes = object
                .get("bytes")
                .and_then(Value::as_u64)
                .ok_or(StoreError::Validation("图片额度必须是正整数"))?;
            images.set_disk_limit(bytes).map_err(RequestError::Image)
        }
        "reader_cache.stats" => {
            empty_params(params)?;
            Ok(json!({
                "guides": guides.cache_stats().map_err(RequestError::Guide)?,
                "images": images.stats(),
            }))
        }
        _ => Err(StoreError::Protocol("unknown method").into()),
    }
}

fn write_message<W: Write>(writer: &Arc<Mutex<&mut W>>, message: &Value) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    serde_json::to_writer(&mut **writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn record_writer_failure(errors: &SyncSender<io::Error>, failed: &AtomicBool, error: io::Error) {
    if !failed.swap(true, Ordering::AcqRel) {
        let _ = errors.try_send(error);
    }
}

fn write_or_stop<W: Write>(
    writer: &Arc<Mutex<&mut W>>,
    message: &Value,
    errors: &SyncSender<io::Error>,
    failed: &AtomicBool,
) -> bool {
    match write_message(writer, message) {
        Ok(()) => true,
        Err(error) => {
            record_writer_failure(errors, failed, error);
            false
        }
    }
}

fn store_worker<W: Write>(
    requests: Receiver<Work>,
    store: PositionStore,
    reader_store: ReaderPositionStore,
    writer: Arc<Mutex<&mut W>>,
    errors: SyncSender<io::Error>,
    failed: Arc<AtomicBool>,
) {
    while let Ok(work) = requests.recv() {
        if failed.load(Ordering::Acquire) {
            break;
        }
        let response = match work {
            Work::Request(request) => response_for_request(&request, |method, params| {
                dispatch(&store, &reader_store, method, params).map_err(RequestError::Store)
            }),
            Work::Ready(response) => response,
        };
        if !write_or_stop(&writer, &response, &errors, &failed) {
            break;
        }
    }
}

fn general_worker<W: Write>(
    requests: Arc<GeneralQueue>,
    services: Arc<GeneralServices>,
    writer: Arc<Mutex<&mut W>>,
    errors: SyncSender<io::Error>,
    failed: Arc<AtomicBool>,
) {
    loop {
        if failed.load(Ordering::Acquire) {
            break;
        }
        let Some((work, guide_id, image_request)) = requests.recv() else {
            break;
        };
        let lease = GeneralLease {
            queue: &requests,
            guide_id,
            image_request,
        };
        if failed.load(Ordering::Acquire) {
            break;
        }
        let response = match work {
            Work::Request(request) => response_for_request(&request, |method, params| {
                dispatch_general(
                    &services.monitor,
                    &services.guides,
                    &services.images,
                    &services.reader_store,
                    method,
                    params,
                )
            }),
            Work::Ready(response) => response,
        };
        let written = write_or_stop(&writer, &response, &errors, &failed);
        drop(lease);
        if !written {
            break;
        }
    }
}

fn event_message(event: HotkeyEvent, sequence: u64) -> Value {
    json!({
        "event": "grip_hotkey",
        "payload": {
            "version": 1,
            "button": "L4",
            "sequence": sequence,
            "detectedAtUnixMs": event.detected_at_unix_ms,
        },
    })
}

fn forward_events<W: Write>(
    events: Receiver<HotkeyEvent>,
    writer: Arc<Mutex<&mut W>>,
    stop: Arc<AtomicBool>,
    errors: SyncSender<io::Error>,
    failed: Arc<AtomicBool>,
) {
    let mut sequence = 0_u64;
    loop {
        let event = if stop.load(Ordering::Acquire) {
            match events.try_recv() {
                Ok(event) => event,
                Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
            }
        } else {
            match events.recv_timeout(EVENT_POLL_INTERVAL) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        };
        sequence += 1;
        if !write_or_stop(&writer, &event_message(event, sequence), &errors, &failed) {
            break;
        }
    }
}

fn queue_request(line: &[u8], stores: &SyncSender<Work>, general: &GeneralQueue) -> io::Result<()> {
    let request = match serde_json::from_slice::<Value>(line) {
        Ok(request) => request,
        Err(_) => {
            return general
                .send(Work::Ready(invalid_json_response()))
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "general worker stopped"));
        }
    };
    if is_store_request(&request) {
        stores
            .send(Work::Request(request))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "storage worker stopped"))
    } else {
        general
            .send(Work::Request(request))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "general worker stopped"))
    }
}

pub fn serve(path: PathBuf, input: impl BufRead, output: impl Write + Send) -> io::Result<()> {
    serve_with_hotkey_roots(
        path,
        input,
        output,
        PathBuf::from("/dev"),
        PathBuf::from("/sys/class/hidraw"),
        PathBuf::from("/proc"),
    )
}

pub fn serve_with_hotkey_roots(
    path: PathBuf,
    mut input: impl BufRead,
    mut output: impl Write + Send,
    device_root: PathBuf,
    sysfs_root: PathBuf,
    proc_root: PathBuf,
) -> io::Result<()> {
    let (hotkey_events, hotkey_event_receiver) = mpsc::channel();
    let monitor = Arc::new(Mutex::new(L4HotkeyMonitor::new(
        hotkey_events,
        device_root,
        sysfs_root,
        proc_root,
    )));
    let guides = Arc::new(GuideReader::new(path.with_file_name("guides")));
    let images = Arc::new(GuideImageCache::new(path.with_file_name("images")));
    monitor
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .start()?;

    thread::scope(|scope| {
        let writer = Arc::new(Mutex::new(&mut output));
        let failed = Arc::new(AtomicBool::new(false));
        let event_stop = Arc::new(AtomicBool::new(false));
        let (writer_errors, writer_error_receiver) = mpsc::sync_channel(1);
        let (store_requests, store_receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let general_requests = Arc::new(GeneralQueue::default());
        let general_services = Arc::new(GeneralServices {
            monitor: Arc::clone(&monitor),
            guides: Arc::clone(&guides),
            images: Arc::clone(&images),
            reader_store: ReaderPositionStore::new(path.with_file_name("reader_positions.json")),
        });

        let store_writer = Arc::clone(&writer);
        let store_errors = writer_errors.clone();
        let store_failed = Arc::clone(&failed);
        let store = PositionStore::new(path.clone());
        let reader_store = ReaderPositionStore::new(path.with_file_name("reader_positions.json"));
        let store_thread = scope.spawn(move || {
            store_worker(
                store_receiver,
                store,
                reader_store,
                store_writer,
                store_errors,
                store_failed,
            )
        });

        let mut general_threads = Vec::with_capacity(GENERAL_WORKERS);
        for _ in 0..GENERAL_WORKERS {
            let requests = Arc::clone(&general_requests);
            let services = Arc::clone(&general_services);
            let worker_writer = Arc::clone(&writer);
            let worker_errors = writer_errors.clone();
            let worker_failed = Arc::clone(&failed);
            general_threads.push(scope.spawn(move || {
                general_worker(
                    requests,
                    services,
                    worker_writer,
                    worker_errors,
                    worker_failed,
                )
            }));
        }

        let event_writer = Arc::clone(&writer);
        let event_errors = writer_errors.clone();
        let event_failed = Arc::clone(&failed);
        let event_stop_worker = Arc::clone(&event_stop);
        let event_thread = scope.spawn(move || {
            forward_events(
                hotkey_event_receiver,
                event_writer,
                event_stop_worker,
                event_errors,
                event_failed,
            )
        });

        let mut result = Ok(());
        let mut line = Vec::with_capacity(MAX_REQUEST_BYTES + 1);
        loop {
            line.clear();
            let read = match input
                .by_ref()
                .take((MAX_REQUEST_BYTES + 1) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(read) => read,
                Err(error) => {
                    result = Err(error);
                    break;
                }
            };
            if read == 0 {
                break;
            }
            if line.len() > MAX_REQUEST_BYTES {
                result = Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "JSON-lines request exceeds 64 KiB",
                ));
                break;
            }
            if failed.load(Ordering::Acquire) {
                result = Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "sidecar output stopped",
                ));
                break;
            }
            if let Err(error) = queue_request(&line, &store_requests, &general_requests) {
                result = Err(error);
                break;
            }
        }

        drop(store_requests);
        general_requests.close();
        let mut worker_panicked = store_thread.join().is_err();
        for worker in general_threads {
            worker_panicked |= worker.join().is_err();
        }

        monitor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .stop();
        event_stop.store(true, Ordering::Release);
        worker_panicked |= event_thread.join().is_err();

        if result.is_ok() && worker_panicked {
            result = Err(io::Error::other("sidecar worker panicked"));
        }
        if result.is_ok() {
            if let Ok(error) = writer_error_receiver.try_recv() {
                result = Err(error);
            }
        }
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Cursor;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    #[derive(Clone, Default)]
    struct SharedOutput(Arc<Mutex<Vec<u8>>>);

    impl SharedOutput {
        fn messages(&self) -> Vec<Value> {
            let bytes = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            String::from_utf8(bytes)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
    }

    impl Write for SharedOutput {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn missing_roots() -> (PathBuf, PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("grip-runtime-missing-{}", std::process::id()));
        (
            root.join("dev"),
            root.join("sys/class/hidraw"),
            root.join("proc"),
        )
    }

    fn empty_images() -> Arc<GuideImageCache> {
        Arc::new(GuideImageCache::new(std::env::temp_dir().join(format!(
            "grip-runtime-images-{}-{}",
            std::process::id(),
            crate::TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))))
    }

    fn test_services(
        root: &std::path::Path,
        monitor: Arc<Mutex<L4HotkeyMonitor>>,
        guides: Arc<GuideReader>,
        images: Arc<GuideImageCache>,
    ) -> Arc<GeneralServices> {
        Arc::new(GeneralServices {
            monitor,
            guides,
            images,
            reader_store: ReaderPositionStore::new(root.join("reader_positions.json")),
        })
    }

    #[test]
    fn download_status_checks_pinned_disk_images_without_fetching_or_trusting_memory() {
        let directory = crate::test_support::TestDirectory::new("reader_positions.json");
        let guide_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&guide_calls);
        let guides = Arc::new(GuideReader::with_fetcher(
            directory.0.join("guides"),
            move |url, _, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                let body = if url.contains("?id=2&") {
                    "<p>Text only</p>"
                } else {
                    r#"<img src="https://images.steamusercontent.com/a.png?x=1&amp;y=2"><img src="https://images.steamusercontent.com/a.png?x=1&amp;y=2"><img src="https://images.steamusercontent.com/b.png">"#
                };
                Ok(format!(r#"<div class="workshopItemTitle">Guide</div><div class="guideAuthors">Author</div><div class="subSection" id="1"><div class="subSectionTitle">Chapter</div><div class="subSectionDesc">{body}</div></div>"#).into_bytes())
            },
            || 1,
        ));
        let image_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&image_calls);
        let images = Arc::new(
            GuideImageCache::with_fetcher(
                directory.0.join("images"),
                move |_, _, _| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok((
                        "image/png".to_owned(),
                        b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0test"
                            .to_vec(),
                    ))
                },
                crate::guide_images::ImageLimits::default(),
            )
            .unwrap(),
        );
        let (events, _receiver) = mpsc::channel();
        let (device, sysfs, proc_root) = missing_roots();
        let monitor = Arc::new(Mutex::new(L4HotkeyMonitor::new(
            events, device, sysfs, proc_root,
        )));
        let reader_store = ReaderPositionStore::new(directory.path());
        let query = |guide_id: &str| {
            let response = response_for_request(
                &json!({"id": 1, "method": "guides.download_status", "params": {"guide_id": guide_id}}),
                |method, params| {
                    dispatch_general(&monitor, &guides, &images, &reader_store, method, params)
                },
            );
            assert_eq!(response["ok"], true, "{response}");
            response["result"].clone()
        };
        assert_eq!(
            query("1"),
            json!({"state": "missing", "completed": 0, "total": 0})
        );
        assert_eq!(guide_calls.load(Ordering::SeqCst), 0);
        guides.get("1", false).unwrap();
        assert_eq!(
            query("1"),
            json!({"state": "partial", "completed": 0, "total": 2})
        );
        assert_eq!(image_calls.load(Ordering::SeqCst), 0);
        let first = "https://images.steamusercontent.com/a.png?x=1&y=2";
        images.get(first, true).unwrap();
        assert_eq!(query("1")["completed"], 0);
        assert!(images.download(first).unwrap());
        assert_eq!(query("1")["completed"], 1);
        assert!(
            images
                .download("https://images.steamusercontent.com/b.png")
                .unwrap()
        );
        assert_eq!(
            query("1"),
            json!({"state": "complete", "completed": 2, "total": 2})
        );
        let pinned = std::fs::read_dir(directory.0.join("images"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::write(pinned, b"corrupt").unwrap();
        assert_eq!(
            query("1"),
            json!({"state": "partial", "completed": 1, "total": 2})
        );
        images.clear();
        assert_eq!(query("1")["completed"], 0);
        assert_eq!(guide_calls.load(Ordering::SeqCst), 1);
        assert_eq!(image_calls.load(Ordering::SeqCst), 2);
        guides.get("2", false).unwrap();
        assert_eq!(
            query("2"),
            json!({"state": "complete", "completed": 0, "total": 0})
        );
        guides.clear_guide_cache().unwrap();
        assert_eq!(query("1")["state"], "missing");
    }

    #[test]
    fn ping_status_and_monitor_lifecycle_use_protocol_v2() {
        let output = SharedOutput::default();
        let output_copy = output.clone();
        let (device_root, sysfs_root, proc_root) = missing_roots();
        let input = Cursor::new(
            b"{\"id\":1,\"method\":\"ping\"}\n{\"id\":2,\"method\":\"hotkey.status\"}\n",
        );

        serve_with_hotkey_roots(
            std::env::temp_dir().join("grip-runtime-positions.json"),
            input,
            output,
            device_root,
            sysfs_root,
            proc_root,
        )
        .unwrap();

        let responses: BTreeMap<_, _> = output_copy
            .messages()
            .into_iter()
            .map(|response| (response["id"].as_u64().unwrap(), response))
            .collect();
        assert_eq!(
            responses[&1]["result"],
            json!({
                "version": 2,
                "capabilities": ["positions", "reader_positions", "guides", "images", "hotkey", "multiplex"],
            })
        );
        assert_eq!(
            responses[&2]["result"],
            json!({"available": false, "button": "L4", "device": null, "running": true})
        );
    }

    #[test]
    fn events_have_the_exact_envelope_and_monotonic_sequence() {
        let output = SharedOutput::default();
        let output_copy = output.clone();
        let (sender, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let (errors, _error_receiver) = mpsc::sync_channel(1);
        let mut output = output;
        thread::scope(|scope| {
            let writer = Arc::new(Mutex::new(&mut output));
            let worker =
                scope.spawn(|| forward_events(receiver, writer, stop, errors, Arc::clone(&failed)));
            sender
                .send(HotkeyEvent {
                    detected_at_unix_ms: 123,
                })
                .unwrap();
            sender
                .send(HotkeyEvent {
                    detected_at_unix_ms: 456,
                })
                .unwrap();
            drop(sender);
            worker.join().unwrap();
        });

        assert!(!failed.load(Ordering::Acquire));
        assert_eq!(
            output_copy.messages(),
            vec![
                json!({"event": "grip_hotkey", "payload": {
                    "version": 1, "button": "L4", "sequence": 1, "detectedAtUnixMs": 123,
                }}),
                json!({"event": "grip_hotkey", "payload": {
                    "version": 1, "button": "L4", "sequence": 2, "detectedAtUnixMs": 456,
                }}),
            ]
        );
    }

    #[test]
    fn guide_error_kinds_keep_the_python_contract() {
        assert_eq!(guide_error_kind(GuideErrorKind::Validation), "validation");
        assert_eq!(guide_error_kind(GuideErrorKind::Download), "download");
        assert_eq!(guide_error_kind(GuideErrorKind::Parse), "parse");
        assert_eq!(guide_error_kind(GuideErrorKind::Cache), "cache");
    }

    #[test]
    fn image_error_kinds_keep_the_python_contract() {
        assert_eq!(image_error_kind(ImageErrorKind::Validation), "validation");
        assert_eq!(image_error_kind(ImageErrorKind::Download), "download");
    }

    #[test]
    fn slow_guide_request_does_not_block_positions_worker() {
        let output = SharedOutput::default();
        let output_copy = output.clone();
        let test_root = std::env::temp_dir().join(format!(
            "grip-runtime-concurrency-{}-{}",
            std::process::id(),
            crate::TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let (started, started_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        let release_receiver = Mutex::new(release_receiver);
        let guides = Arc::new(GuideReader::with_fetcher(
            test_root.join("guides"),
            move |_, _, _| {
                started.send(()).unwrap();
                release_receiver.lock().unwrap().recv().unwrap();
                Err(GuideError::download("download failed"))
            },
            || 0,
        ));
        let (events, _event_receiver) = mpsc::channel();
        let (device_root, sysfs_root, proc_root) = missing_roots();
        let monitor = Arc::new(Mutex::new(L4HotkeyMonitor::new(
            events,
            device_root,
            sysfs_root,
            proc_root,
        )));
        let images = empty_images();
        let services = test_services(
            &test_root,
            Arc::clone(&monitor),
            Arc::clone(&guides),
            Arc::clone(&images),
        );
        let (store_requests, store_receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let general_requests = Arc::new(GeneralQueue::default());
        let failed = Arc::new(AtomicBool::new(false));
        let (errors, _error_receiver) = mpsc::sync_channel(1);
        let mut output = output;

        thread::scope(|scope| {
            let writer = Arc::new(Mutex::new(&mut output));
            let store = PositionStore::new(test_root.join("positions.json"));
            let reader_store = ReaderPositionStore::new(test_root.join("reader_positions.json"));
            let store_worker = scope.spawn({
                let writer = Arc::clone(&writer);
                let errors = errors.clone();
                let failed = Arc::clone(&failed);
                move || store_worker(store_receiver, store, reader_store, writer, errors, failed)
            });
            let guide_worker = scope.spawn({
                let writer = Arc::clone(&writer);
                let errors = errors.clone();
                let failed = Arc::clone(&failed);
                let requests = Arc::clone(&general_requests);
                let services = Arc::clone(&services);
                move || general_worker(requests, services, writer, errors, failed)
            });

            general_requests
                .send(Work::Request(json!({
                    "id": 1,
                    "method": "guides.get",
                    "params": {"guide_id": "3414883877", "force_refresh": false},
                })))
                .unwrap();
            started_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
            store_requests
                .send(Work::Request(
                    json!({"id": 2, "method": "positions.snapshot"}),
                ))
                .unwrap();

            let deadline = Instant::now() + Duration::from_secs(1);
            while output_copy.messages().is_empty() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(output_copy.messages()[0]["id"], 2);
            assert_eq!(output_copy.messages()[0]["result"], json!({}));

            release.send(()).unwrap();
            drop(store_requests);
            general_requests.close();
            store_worker.join().unwrap();
            guide_worker.join().unwrap();
        });

        let responses = output_copy.messages();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[1]["id"], 1);
        assert_eq!(responses[1]["error"]["kind"], "download");
        assert!(!failed.load(Ordering::Acquire));
    }

    #[test]
    fn same_guide_operations_wait_in_fifo_without_starving_other_work() {
        const GUIDE_ID: &str = "3414883877";
        const OTHER_GUIDE_ID: &str = "3414883878";

        let output = SharedOutput::default();
        let output_copy = output.clone();
        let test_root = std::env::temp_dir().join(format!(
            "grip-runtime-guide-scheduling-{}-{}",
            std::process::id(),
            crate::TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let (started, started_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        let release_receiver = Mutex::new(release_receiver);
        let guide_calls = Arc::new(AtomicUsize::new(0));
        let fetch_calls = Arc::clone(&guide_calls);
        let guides = Arc::new(GuideReader::with_fetcher(
            test_root.join("guides"),
            move |url, _, _| {
                if url.contains(&format!("id={GUIDE_ID}"))
                    && fetch_calls.fetch_add(1, Ordering::SeqCst) == 0
                {
                    started.send(()).unwrap();
                    release_receiver.lock().unwrap().recv().unwrap();
                }
                Err(GuideError::download("download failed"))
            },
            || 0,
        ));
        let images = empty_images();
        let (events, _event_receiver) = mpsc::channel();
        let (device_root, sysfs_root, proc_root) = missing_roots();
        let monitor = Arc::new(Mutex::new(L4HotkeyMonitor::new(
            events,
            device_root,
            sysfs_root,
            proc_root,
        )));
        let services = test_services(
            &test_root,
            Arc::clone(&monitor),
            Arc::clone(&guides),
            Arc::clone(&images),
        );
        let requests = Arc::new(GeneralQueue::default());
        let failed = Arc::new(AtomicBool::new(false));
        let (errors, _error_receiver) = mpsc::sync_channel(1);
        let mut output = output;
        let mut before_release = Vec::new();

        thread::scope(|scope| {
            let writer = Arc::new(Mutex::new(&mut output));
            let mut workers = Vec::new();
            for _ in 0..GENERAL_WORKERS {
                let requests = Arc::clone(&requests);
                let services = Arc::clone(&services);
                let writer = Arc::clone(&writer);
                let errors = errors.clone();
                let failed = Arc::clone(&failed);
                workers.push(
                    scope.spawn(move || general_worker(requests, services, writer, errors, failed)),
                );
            }

            requests
                .send(Work::Request(json!({
                    "id": 1,
                    "method": "guides.get",
                    "params": {"guide_id": GUIDE_ID, "force_refresh": false},
                })))
                .unwrap();
            started_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
            for request in [
                json!({"id": 2, "method": "guides.get", "params": {
                    "guide_id": GUIDE_ID, "force_refresh": false,
                }}),
                json!({"id": 3, "method": "guides.get_cached", "params": {
                    "guide_id": GUIDE_ID,
                }}),
                json!({"id": 4, "method": "guides.remove", "params": {
                    "guide_id": GUIDE_ID,
                }}),
                json!({"id": 5, "method": "ping"}),
                json!({"id": 6, "method": "guides.get", "params": {
                    "guide_id": OTHER_GUIDE_ID, "force_refresh": false,
                }}),
            ] {
                requests.send(Work::Request(request)).unwrap();
            }

            let deadline = Instant::now() + Duration::from_secs(1);
            while output_copy.messages().len() < 2 && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            before_release = output_copy.messages();
            release.send(()).unwrap();
            requests.close();
            for worker in workers {
                worker.join().unwrap();
            }
        });

        let before_release: BTreeMap<_, _> = before_release
            .into_iter()
            .map(|response| (response["id"].as_u64().unwrap(), response))
            .collect();
        assert_eq!(before_release.len(), 2);
        assert!(before_release.contains_key(&5));
        assert!(before_release.contains_key(&6));
        let messages = output_copy.messages();
        let same_guide_order: Vec<_> = messages
            .iter()
            .filter_map(|response| response["id"].as_u64().filter(|id| *id <= 4))
            .collect();
        assert_eq!(same_guide_order, vec![1, 2, 3, 4]);
        let responses: BTreeMap<_, _> = messages
            .into_iter()
            .map(|response| (response["id"].as_u64().unwrap(), response))
            .collect();
        assert_eq!(responses.len(), 6);
        assert_eq!(responses[&1]["error"]["kind"], "download");
        assert_eq!(responses[&2]["error"]["kind"], "download");
        assert_eq!(responses[&3]["result"], Value::Null);
        assert_eq!(responses[&4]["result"]["filesRemoved"], 0);
        assert_eq!(responses[&5]["result"], protocol_info());
        assert_eq!(responses[&6]["error"]["kind"], "download");
        assert_eq!(guide_calls.load(Ordering::SeqCst), 2);
        assert!(!failed.load(Ordering::Acquire));
    }

    #[test]
    fn image_downloads_leave_a_worker_for_foreground_requests() {
        let output = SharedOutput::default();
        let output_copy = output.clone();
        let test_root = std::env::temp_dir().join(format!(
            "grip-runtime-image-scheduling-{}-{}",
            std::process::id(),
            crate::TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let (started, started_receiver) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        let release_receiver = Mutex::new(release_receiver);
        let images = Arc::new(
            GuideImageCache::with_fetcher(
                test_root.join("images"),
                move |_, _, _| {
                    started.send(()).unwrap();
                    release_receiver.lock().unwrap().recv().unwrap();
                    Err(ImageError::download("download failed"))
                },
                crate::guide_images::ImageLimits::default(),
            )
            .unwrap(),
        );
        let guides = Arc::new(GuideReader::new(test_root.join("guides")));
        let (events, _event_receiver) = mpsc::channel();
        let (device_root, sysfs_root, proc_root) = missing_roots();
        let monitor = Arc::new(Mutex::new(L4HotkeyMonitor::new(
            events,
            device_root,
            sysfs_root,
            proc_root,
        )));
        let services = test_services(
            &test_root,
            Arc::clone(&monitor),
            Arc::clone(&guides),
            Arc::clone(&images),
        );
        let requests = Arc::new(GeneralQueue::default());
        let failed = Arc::new(AtomicBool::new(false));
        let (errors, _error_receiver) = mpsc::sync_channel(1);
        let mut output = output;
        let mut all_images_started = true;
        let mut before_release = Vec::new();

        thread::scope(|scope| {
            let writer = Arc::new(Mutex::new(&mut output));
            let mut workers = Vec::new();
            for _ in 0..GENERAL_WORKERS {
                let requests = Arc::clone(&requests);
                let services = Arc::clone(&services);
                let writer = Arc::clone(&writer);
                let errors = errors.clone();
                let failed = Arc::clone(&failed);
                workers.push(
                    scope.spawn(move || general_worker(requests, services, writer, errors, failed)),
                );
            }

            for id in 1..=3 {
                requests
                    .send(Work::Request(json!({
                        "id": id,
                        "method": "images.get",
                        "params": {
                            "url": format!("https://images.steamusercontent.com/ugc/{id}/image.png"),
                            "allow_download": true,
                        },
                    })))
                    .unwrap();
            }
            for _ in 0..3 {
                all_images_started &= started_receiver
                    .recv_timeout(Duration::from_secs(5))
                    .is_ok();
            }
            for id in 5..=7 {
                requests.send(Work::Request(json!({
                    "id": id,
                    "method": "images.download",
                    "params": {
                        "url": format!("https://images.steamusercontent.com/ugc/{id}/image.png"),
                    },
                }))).unwrap();
            }
            requests
                .send(Work::Request(json!({"id": 4, "method": "ping"})))
                .unwrap();

            let deadline = Instant::now() + Duration::from_secs(5);
            while output_copy.messages().is_empty() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            before_release = output_copy.messages();
            for _ in 0..6 {
                let _ = release.send(());
            }
            requests.close();
            for worker in workers {
                worker.join().unwrap();
            }
        });

        assert!(all_images_started);
        assert_eq!(before_release.len(), 1);
        assert_eq!(before_release[0]["id"], 4);
        assert_eq!(before_release[0]["result"], protocol_info());
        assert_eq!(output_copy.messages().len(), 7);
        assert!(!failed.load(Ordering::Acquire));
    }

    #[test]
    fn general_workers_can_respond_out_of_order() {
        let output = SharedOutput::default();
        let output_copy = output.clone();
        let test_root = std::env::temp_dir().join(format!(
            "grip-runtime-out-of-order-{}-{}",
            std::process::id(),
            crate::TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let (events, _event_receiver) = mpsc::channel();
        let (device_root, sysfs_root, proc_root) = missing_roots();
        let monitor = Arc::new(Mutex::new(L4HotkeyMonitor::new(
            events,
            device_root,
            sysfs_root,
            proc_root,
        )));
        let guides = Arc::new(GuideReader::new(test_root.join("guides")));
        let images = empty_images();
        let services = test_services(
            &test_root,
            Arc::clone(&monitor),
            Arc::clone(&guides),
            Arc::clone(&images),
        );
        let requests = Arc::new(GeneralQueue::default());
        requests
            .send(Work::Request(json!({"id": 1, "method": "hotkey.status"})))
            .unwrap();
        requests
            .send(Work::Request(json!({"id": 2, "method": "ping"})))
            .unwrap();
        let failed = Arc::new(AtomicBool::new(false));
        let (errors, _error_receiver) = mpsc::sync_channel(1);
        let monitor_guard = monitor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut output = output;

        thread::scope(|scope| {
            let writer = Arc::new(Mutex::new(&mut output));
            let mut workers = Vec::new();
            for _ in 0..GENERAL_WORKERS {
                let requests = Arc::clone(&requests);
                let services = Arc::clone(&services);
                let writer = Arc::clone(&writer);
                let errors = errors.clone();
                let failed = Arc::clone(&failed);
                workers.push(
                    scope.spawn(move || general_worker(requests, services, writer, errors, failed)),
                );
            }

            let deadline = Instant::now() + Duration::from_secs(5);
            while output_copy.messages().is_empty() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            let ping_responded_first = output_copy
                .messages()
                .first()
                .is_some_and(|response| response["id"] == 2);

            drop(monitor_guard);
            requests.close();
            for worker in workers {
                worker.join().unwrap();
            }
            assert!(ping_responded_first);
        });

        let responses = output_copy.messages();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], 2);
        assert_eq!(responses[1]["id"], 1);
        assert!(!failed.load(Ordering::Acquire));
    }
}
