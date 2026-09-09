use crate::storage::{
    AtomicReplaceError, ReadError, StoreError, acquire_store_lock, atomic_replace,
    backup_corrupt_file, read_bounded_regular_file,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const SCHEMA_VERSION: u64 = 1;
pub(crate) const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MAX_POSITIONS: usize = 10_000;
pub(crate) const MAX_SCROLL_TOP: f64 = 1_000_000_000.0;
pub(crate) const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Position {
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

pub(crate) struct PositionStore {
    path: PathBuf,
}

impl PositionStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read_document(&self) -> Result<Document, StoreError> {
        match read_bounded_regular_file(&self.path, MAX_FILE_BYTES, None) {
            Ok((Some(payload), _)) => Document::from_bytes(&payload),
            Ok((None, _)) => unreachable!("a read without a known signature returns bytes"),
            Err(ReadError::Missing) => Ok(Document::default()),
            Err(ReadError::TooLarge) => Err(StoreError::Storage(
                "positions.json is larger than the safety limit",
            )),
            Err(ReadError::Changed | ReadError::Unsafe) => Err(StoreError::Storage(
                "positions.json could not be read safely",
            )),
        }
    }

    pub(crate) fn snapshot(&self) -> Result<Value, StoreError> {
        Ok(Value::Object(self.read_document()?.positions_value()))
    }

    pub(crate) fn save(&self, guide_key: &str, scroll_top: &Value) -> Result<Position, StoreError> {
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

    pub(crate) fn repair(&self) -> Result<Value, StoreError> {
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

        match atomic_replace(&self.path, ".positions-", ".tmp", &payload) {
            Ok(()) => Ok(()),
            Err(AtomicReplaceError::Prepare) => Err(StoreError::Storage(
                "could not create a temporary positions file",
            )),
            Err(AtomicReplaceError::Replace) => Err(StoreError::Storage(
                "could not atomically replace positions.json",
            )),
            Err(AtomicReplaceError::Durability) => Err(StoreError::Durability(
                "positions.json was replaced, but its directory could not be synced",
            )),
        }
    }
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

pub(crate) fn valid_id(value: &str) -> bool {
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

pub(crate) fn position_value(position: &Position) -> Value {
    json!({
        "scroll_top": position.scroll_top,
        "updated_at_ms": position.updated_at_ms,
    })
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
