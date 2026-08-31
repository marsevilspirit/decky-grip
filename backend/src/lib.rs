use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

mod favorites;
pub mod guide_html;
pub mod guide_images;
pub mod guides;
pub mod hotkey;
mod reader_positions;
mod runtime;

pub use runtime::{serve, serve_with_hotkey_roots};

use favorites::FavoriteStore;
use reader_positions::ReaderPositionStore;

const SCHEMA_VERSION: u64 = 1;
const PROTOCOL_VERSION: u64 = 2;
const PROTOCOL_CAPABILITIES: [&str; 7] = [
    "positions",
    "reader_positions",
    "favorites",
    "guides",
    "images",
    "hotkey",
    "multiplex",
];
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_POSITIONS: usize = 10_000;
const MAX_SCROLL_TOP: f64 = 1_000_000_000.0;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq)]
struct Position {
    scroll_top: f64,
    updated_at_ms: u64,
}

#[derive(Debug, Default)]
struct Document {
    positions: BTreeMap<String, Position>,
}

impl Document {
    fn from_bytes(payload: &[u8]) -> Result<Self, StoreError> {
        let value: Value = serde_json::from_slice(payload)
            .map_err(|_| StoreError::Storage("positions.json could not be read"))?;
        let object = value.as_object().ok_or(StoreError::Storage(
            "positions.json must contain a JSON object",
        ))?;
        require_fields(
            object,
            &["schema_version", "positions"],
            "positions.json contains unknown or missing fields",
        )?;
        if object.get("schema_version").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            return Err(StoreError::Storage(
                "positions.json uses an unsupported schema version",
            ));
        }

        let raw_positions =
            object
                .get("positions")
                .and_then(Value::as_object)
                .ok_or(StoreError::Storage(
                    "positions.json contains an invalid positions map",
                ))?;
        if raw_positions.len() > MAX_POSITIONS {
            return Err(StoreError::Storage(
                "positions.json contains too many positions",
            ));
        }

        let mut positions = BTreeMap::new();
        for (guide_key, raw_position) in raw_positions {
            if !valid_guide_key(guide_key) {
                return Err(StoreError::Storage(
                    "positions.json contains an invalid guide key",
                ));
            }
            let position = raw_position.as_object().ok_or(StoreError::Storage(
                "positions.json contains an invalid position",
            ))?;
            require_fields(
                position,
                &["scroll_top", "updated_at_ms"],
                "positions.json contains unknown or missing position fields",
            )?;
            let scroll_top = position
                .get("scroll_top")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value >= 0.0 && *value <= MAX_SCROLL_TOP)
                .ok_or(StoreError::Storage(
                    "positions.json contains an invalid scroll position",
                ))?;
            let updated_at_ms = position
                .get("updated_at_ms")
                .and_then(Value::as_u64)
                .filter(|value| *value <= JAVASCRIPT_MAX_SAFE_INTEGER)
                .ok_or(StoreError::Storage(
                    "positions.json contains an invalid timestamp",
                ))?;
            positions.insert(
                guide_key.clone(),
                Position {
                    scroll_top,
                    updated_at_ms,
                },
            );
        }
        Ok(Self { positions })
    }

    fn positions_value(&self) -> Map<String, Value> {
        self.positions
            .iter()
            .map(|(key, position)| (key.clone(), position_value(position)))
            .collect()
    }

    fn to_value(&self) -> Value {
        json!({
            "positions": Value::Object(self.positions_value()),
            "schema_version": SCHEMA_VERSION,
        })
    }
}

#[derive(Debug)]
enum StoreError {
    Validation(&'static str),
    Storage(&'static str),
    Durability(&'static str),
    Protocol(&'static str),
}

struct PositionStore {
    path: PathBuf,
}

impl PositionStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read_document(&self) -> Result<Document, StoreError> {
        match read_bounded_regular_file(&self.path, MAX_FILE_BYTES) {
            Ok(payload) => Document::from_bytes(&payload),
            Err(ReadError::Missing) => Ok(Document::default()),
            Err(ReadError::TooLarge) => Err(StoreError::Storage(
                "positions.json is larger than the safety limit",
            )),
            Err(ReadError::Unsafe) => Err(StoreError::Storage(
                "positions.json could not be read safely",
            )),
        }
    }

    fn snapshot(&self) -> Result<Value, StoreError> {
        Ok(Value::Object(self.read_document()?.positions_value()))
    }

    fn save(&self, guide_key: &str, scroll_top: &Value) -> Result<Position, StoreError> {
        validate_guide_key(guide_key)?;
        let scroll_top = scroll_top.as_f64().ok_or(StoreError::Validation(
            "scroll_top must be a finite non-negative number",
        ))?;
        let scroll_top = validate_scroll_top(scroll_top)?;
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock positions.json"))?;
        let mut document = self.read_document()?;
        let updated_at_ms = now_ms()?;
        let position = Position {
            scroll_top,
            updated_at_ms,
        };
        document
            .positions
            .insert(guide_key.to_owned(), position.clone());
        if document.positions.len() > MAX_POSITIONS {
            return Err(StoreError::Storage("position limit reached"));
        }
        self.write_atomic(&document)?;
        Ok(position)
    }

    fn repair(&self) -> Result<Value, StoreError> {
        if matches!(
            fs::symlink_metadata(&self.path),
            Err(error) if error.kind() == io::ErrorKind::NotFound
        ) {
            return Ok(json!({"backup": null, "repaired": false}));
        }
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock positions.json"))?;
        if self.read_document().is_ok() {
            return Ok(json!({"backup": null, "repaired": false}));
        }
        let backup = backup_corrupt_file(&self.path)
            .map_err(|_| StoreError::Storage("could not back up corrupt positions.json"))?;
        self.write_atomic(&Document::default())?;
        Ok(json!({"backup": backup.to_string_lossy(), "repaired": true}))
    }

    fn write_atomic(&self, document: &Document) -> Result<(), StoreError> {
        let mut payload = serde_json::to_vec(&document.to_value())
            .map_err(|_| StoreError::Storage("positions.json could not be encoded"))?;
        payload.push(b'\n');
        if payload.len() as u64 > MAX_FILE_BYTES {
            return Err(StoreError::Storage(
                "positions.json would exceed the safety limit",
            ));
        }

        let parent = self.path.parent().ok_or(StoreError::Storage(
            "could not create a temporary positions file",
        ))?;
        fs::create_dir_all(parent)
            .map_err(|_| StoreError::Storage("could not create a temporary positions file"))?;
        let (mut temporary, temporary_path) = create_temp(parent, ".positions-", ".tmp")
            .map_err(|_| StoreError::Storage("could not create a temporary positions file"))?;

        let replace_result = (|| -> io::Result<()> {
            make_private(&temporary)?;
            temporary.write_all(&payload)?;
            temporary.sync_all()?;
            drop(temporary);
            fs::rename(&temporary_path, &self.path)
        })();
        if replace_result.is_err() {
            let _ = fs::remove_file(&temporary_path);
            return Err(StoreError::Storage(
                "could not atomically replace positions.json",
            ));
        }

        sync_directory(parent).map_err(|_| {
            StoreError::Durability(
                "positions.json was replaced, but its directory could not be synced",
            )
        })
    }
}

enum ReadError {
    Missing,
    TooLarge,
    Unsafe,
}

struct StoreLock(File);

impl Drop for StoreLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn acquire_store_lock(path: &Path) -> io::Result<StoreLock> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("position store has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut lock_name = path
        .file_name()
        .ok_or_else(|| io::Error::other("position store has no filename"))?
        .to_os_string();
    lock_name.push(".lock");
    let lock_path = parent.join(lock_name);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(lock_path)?;
    if !lock.metadata()?.is_file() {
        return Err(io::Error::other(
            "position store lock is not a regular file",
        ));
    }
    make_private(&lock)?;
    loop {
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(StoreLock(lock));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileSignature {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

fn signature(metadata: &Metadata) -> FileSignature {
    FileSignature {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    }
}

fn read_bounded_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ReadError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(ReadError::Missing),
        Err(_) => return Err(ReadError::Unsafe),
    };
    let initial = file.metadata().map_err(|_| ReadError::Unsafe)?;
    if !initial.is_file() {
        return Err(ReadError::Unsafe);
    }
    if initial.len() > max_bytes {
        return Err(ReadError::TooLarge);
    }
    let initial_signature = signature(&initial);

    let mut payload = Vec::with_capacity(initial.len() as usize);
    (&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut payload)
        .map_err(|_| ReadError::Unsafe)?;
    if payload.len() as u64 > max_bytes {
        return Err(ReadError::TooLarge);
    }

    let final_metadata = file.metadata().map_err(|_| ReadError::Unsafe)?;
    if !final_metadata.is_file()
        || signature(&final_metadata) != initial_signature
        || payload.len() as u64 != final_metadata.len()
    {
        return Err(ReadError::Unsafe);
    }
    let path_metadata = fs::symlink_metadata(path).map_err(|_| ReadError::Unsafe)?;
    if !path_metadata.is_file() || signature(&path_metadata) != signature(&final_metadata) {
        return Err(ReadError::Unsafe);
    }
    Ok(payload)
}

fn create_temp(parent: &Path, prefix: &str, suffix: &str) -> io::Result<(File, PathBuf)> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut last_error = None;
    for _ in 0..128 {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            "{prefix}{}-{nonce:x}-{counter:x}{suffix}",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("could not create temporary file")))
}

fn make_private(file: &File) -> io::Result<()> {
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)?
        .sync_all()
}

fn backup_corrupt_file(path: &Path) -> io::Result<PathBuf> {
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    if !source.metadata()?.is_file() {
        return Err(io::Error::other("position store is not a regular file"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("position store has no parent"))?;
    let filename = path
        .file_name()
        .ok_or_else(|| io::Error::other("position store has no filename"))?
        .to_string_lossy();
    let (mut backup, backup_path) = create_temp(parent, &format!("{filename}.corrupt-"), ".bak")?;

    let copy_result = (|| -> io::Result<()> {
        make_private(&backup)?;
        io::copy(&mut source, &mut backup)?;
        backup.sync_all()
    })();
    drop(source);
    drop(backup);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&backup_path);
        return Err(error);
    }
    if let Err(error) = sync_directory(parent) {
        let _ = fs::remove_file(&backup_path);
        return Err(error);
    }
    Ok(backup_path)
}

fn now_ms() -> Result<u64, StoreError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::Storage("system time is before the Unix epoch"))?
        .as_millis();
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= JAVASCRIPT_MAX_SAFE_INTEGER)
        .ok_or(StoreError::Storage(
            "system time exceeds the supported range",
        ))
}

fn valid_guide_key(value: &str) -> bool {
    let Some((app_id, guide_id)) = value.split_once(':') else {
        return false;
    };
    !guide_id.contains(':') && valid_id(app_id) && valid_id(guide_id)
}

fn valid_id(value: &str) -> bool {
    (1..=20).contains(&value.len())
        && value.as_bytes()[0] != b'0'
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn validate_guide_key(value: &str) -> Result<&str, StoreError> {
    if valid_guide_key(value) {
        Ok(value)
    } else {
        Err(StoreError::Validation(
            "guide_key must have the form <app_id>:<guide_id>",
        ))
    }
}

fn validate_scroll_top(value: f64) -> Result<f64, StoreError> {
    if value.is_finite() && (0.0..=MAX_SCROLL_TOP).contains(&value) {
        Ok(value)
    } else {
        Err(StoreError::Validation(
            "scroll_top must be a finite non-negative number",
        ))
    }
}

fn require_fields(
    object: &Map<String, Value>,
    fields: &[&str],
    message: &'static str,
) -> Result<(), StoreError> {
    if object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)) {
        Ok(())
    } else {
        Err(StoreError::Storage(message))
    }
}

fn position_value(position: &Position) -> Value {
    json!({
        "scroll_top": position.scroll_top,
        "updated_at_ms": position.updated_at_ms,
    })
}

fn request_fields(value: &Value) -> Result<(&str, Option<&Value>), StoreError> {
    let object = value
        .as_object()
        .ok_or(StoreError::Protocol("request must be a JSON object"))?;
    if object.len() < 2
        || object.len() > 3
        || !object.contains_key("id")
        || !object.contains_key("method")
        || object
            .keys()
            .any(|key| !matches!(key.as_str(), "id" | "method" | "params"))
    {
        return Err(StoreError::Protocol(
            "request contains unknown or missing fields",
        ));
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or(StoreError::Protocol("method must be a string"))?;
    Ok((method, object.get("params")))
}

fn empty_params(params: Option<&Value>) -> Result<(), StoreError> {
    match params {
        None => Ok(()),
        Some(Value::Object(object)) if object.is_empty() => Ok(()),
        _ => Err(StoreError::Protocol("method takes no parameters")),
    }
}

fn params_with_fields<'a>(
    params: Option<&'a Value>,
    fields: &[&str],
) -> Result<&'a Map<String, Value>, StoreError> {
    let object = params
        .and_then(Value::as_object)
        .ok_or(StoreError::Protocol("params must be a JSON object"))?;
    if object.len() != fields.len() || !fields.iter().all(|field| object.contains_key(*field)) {
        return Err(StoreError::Protocol(
            "params contain unknown or missing fields",
        ));
    }
    Ok(object)
}

fn guide_key_param(params: Option<&Value>) -> Result<&str, StoreError> {
    let object = params_with_fields(params, &["guide_key"])?;
    let guide_key =
        object
            .get("guide_key")
            .and_then(Value::as_str)
            .ok_or(StoreError::Validation(
                "guide_key must have the form <app_id>:<guide_id>",
            ))?;
    Ok(guide_key)
}

fn protocol_info() -> Value {
    json!({
        "capabilities": PROTOCOL_CAPABILITIES,
        "version": PROTOCOL_VERSION,
    })
}

fn dispatch(
    store: &PositionStore,
    reader_store: &ReaderPositionStore,
    favorite_store: &FavoriteStore,
    method: &str,
    params: Option<&Value>,
) -> Result<Value, StoreError> {
    match method {
        "positions.snapshot" => {
            empty_params(params)?;
            store.snapshot()
        }
        "positions.save" => {
            let object = params_with_fields(params, &["guide_key", "scroll_top"])?;
            let guide_key =
                object
                    .get("guide_key")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_key must have the form <app_id>:<guide_id>",
                    ))?;
            let scroll_top = object.get("scroll_top").expect("scroll_top was checked");
            Ok(position_value(&store.save(guide_key, scroll_top)?))
        }
        "positions.repair" => {
            empty_params(params)?;
            store.repair()
        }
        "reader_positions.get" => reader_store.get(guide_key_param(params)?),
        "reader_positions.save" => {
            let object = params_with_fields(
                params,
                &[
                    "guide_key",
                    "scroll_top",
                    "section_id",
                    "anchor_text",
                    "anchor_offset",
                ],
            )?;
            let guide_key =
                object
                    .get("guide_key")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_key must have the form <app_id>:<guide_id>",
                    ))?;
            reader_store.save(
                guide_key,
                object.get("scroll_top").expect("scroll_top was checked"),
                object.get("section_id").expect("section_id was checked"),
                object.get("anchor_text").expect("anchor_text was checked"),
                object
                    .get("anchor_offset")
                    .expect("anchor_offset was checked"),
            )
        }
        "reader_positions.repair" => {
            empty_params(params)?;
            reader_store.repair()
        }
        "favorites.set" => {
            let object = params_with_fields(params, &["guide_key", "favorite"])?;
            let guide_key =
                object
                    .get("guide_key")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_key must have the form <app_id>:<guide_id>",
                    ))?;
            favorite_store.set(
                guide_key,
                object.get("favorite").expect("favorite was checked"),
            )
        }
        "favorites.repair" => {
            empty_params(params)?;
            favorite_store.repair()
        }
        _ => Err(StoreError::Protocol("unknown method")),
    }
}

#[cfg(test)]
mod test_support {
    use super::{Ordering, PathBuf, TEMP_COUNTER, fs};

    pub(crate) struct TestDirectory(pub(crate) PathBuf, &'static str);

    impl TestDirectory {
        pub(crate) fn new(filename: &'static str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "grip-sidecar-test-{}-{}",
                std::process::id(),
                TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path, filename)
        }

        pub(crate) fn path(&self) -> PathBuf {
            self.0.join(self.1)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn round_trip_matches_python_schema_and_permissions() {
        let directory = TestDirectory::new("positions.json");
        let path = directory.path();
        let store = PositionStore::new(path.clone());

        assert_eq!(store.snapshot().unwrap(), json!({}));
        let saved = store
            .save("1113000:90071992547409931234", &json!(42.0))
            .unwrap();
        assert_eq!(saved.scroll_top, 42.0);
        assert!(saved.updated_at_ms <= JAVASCRIPT_MAX_SAFE_INTEGER);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["schema_version"], 1);
        assert_eq!(
            document["positions"]["1113000:90071992547409931234"]["scroll_top"],
            42.0
        );
        assert_eq!(store.snapshot().unwrap(), document["positions"]);
    }

    #[test]
    fn corruption_is_preserved_until_repair_backs_it_up() {
        let directory = TestDirectory::new("positions.json");
        let path = directory.path();
        let original = b"{ definitely not json";
        fs::write(&path, original).unwrap();
        let store = PositionStore::new(path.clone());

        assert!(store.save("1:2", &json!(3.0)).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let repaired = store.repair().unwrap();
        let backup = PathBuf::from(repaired["backup"].as_str().unwrap());
        assert_eq!(repaired["repaired"], true);
        assert_eq!(fs::read(&backup).unwrap(), original);
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(store.snapshot().unwrap(), json!({}));
    }

    #[test]
    fn repair_leaves_missing_and_valid_stores_untouched() {
        let directory = TestDirectory::new("positions.json");
        let missing_path = directory.0.join("missing/positions.json");
        let missing_store = PositionStore::new(missing_path.clone());
        assert_eq!(
            missing_store.repair().unwrap(),
            json!({"backup": null, "repaired": false})
        );
        assert!(!missing_path.parent().unwrap().exists());

        let path = directory.path();
        let original = b"{ \"schema_version\": 1, \"positions\": {} }\n";
        fs::write(&path, original).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            PositionStore::new(path.clone()).repair().unwrap(),
            json!({"backup": null, "repaired": false})
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[test]
    fn full_store_rejects_new_keys_without_blocking_overwrites() {
        let directory = TestDirectory::new("positions.json");
        let path = directory.path();
        let store = PositionStore::new(path.clone());
        let mut document = Document::default();
        for guide_id in 1..=MAX_POSITIONS {
            document.positions.insert(
                format!("1:{guide_id}"),
                Position {
                    scroll_top: guide_id as f64,
                    updated_at_ms: guide_id as u64,
                },
            );
        }
        store.write_atomic(&document).unwrap();
        let original = fs::read(&path).unwrap();

        let error = store.save("2:1", &json!(1.0)).unwrap_err();
        assert!(matches!(
            error,
            StoreError::Storage("position limit reached")
        ));
        assert_eq!(fs::read(&path).unwrap(), original);

        assert_eq!(store.save("1:1", &json!(999.0)).unwrap().scroll_top, 999.0);
        assert_eq!(
            store.read_document().unwrap().positions.len(),
            MAX_POSITIONS
        );
        assert_eq!(store.snapshot().unwrap()["1:1"]["scroll_top"], 999.0);
    }

    #[test]
    fn unsafe_and_invalid_stores_are_rejected() {
        let directory = TestDirectory::new("positions.json");
        let path = directory.path();
        let outside = directory.0.join("outside.json");
        fs::write(&outside, b"{\"positions\":{},\"schema_version\":1}").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(PositionStore::new(path.clone()).snapshot().is_err());
        fs::remove_file(&path).unwrap();

        fs::write(&path, b"{\"positions\":{},\"schema_version\":1.0}").unwrap();
        assert!(PositionStore::new(path).snapshot().is_err());
    }

    #[test]
    fn fifo_store_is_rejected_without_blocking() {
        let directory = TestDirectory::new("positions.json");
        let path = directory.path();
        let path_bytes = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path_bytes.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = mpsc::channel();
        let handle =
            thread::spawn(move || sender.send(PositionStore::new(path).snapshot()).unwrap());

        let error = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("FIFO read blocked")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(
            error,
            StoreError::Storage(message) if message.contains("safely")
        ));
    }

    #[test]
    fn stored_schema_validation_matches_the_python_store() {
        let invalid_documents: &[(&[u8], &str)] = &[
            (b"[]", "must contain a JSON object"),
            (
                b"{\"positions\":{},\"schema_version\":1,\"future\":true}",
                "unknown or missing fields",
            ),
            (
                b"{\"positions\":[],\"schema_version\":1}",
                "invalid positions map",
            ),
            (
                b"{\"positions\":{\"0:2\":{\"scroll_top\":3,\"updated_at_ms\":4}},\"schema_version\":1}",
                "invalid guide key",
            ),
            (
                b"{\"positions\":{\"1:2\":{\"scroll_top\":true,\"updated_at_ms\":4}},\"schema_version\":1}",
                "invalid scroll position",
            ),
            (
                b"{\"positions\":{\"1:2\":{\"scroll_top\":3,\"updated_at_ms\":9007199254740992}},\"schema_version\":1}",
                "invalid timestamp",
            ),
        ];

        for (payload, message) in invalid_documents {
            let error = Document::from_bytes(payload).unwrap_err();
            assert!(matches!(
                error,
                StoreError::Storage(actual) if actual.contains(message)
            ));
        }
        assert!(!valid_guide_key("1:2\u{662}2"));
        assert!(valid_guide_key("1:90071992547409931234"));
    }

    #[test]
    fn oversized_store_is_rejected_before_parsing() {
        let directory = TestDirectory::new("positions.json");
        let path = directory.path();
        fs::write(&path, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();

        let error = PositionStore::new(path).snapshot().unwrap_err();
        assert!(matches!(
            error,
            StoreError::Storage(message) if message.contains("larger than")
        ));
    }
}
