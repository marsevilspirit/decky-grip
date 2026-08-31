use super::{
    JAVASCRIPT_MAX_SAFE_INTEGER, MAX_POSITIONS, MAX_SCROLL_TOP, ReadError, SCHEMA_VERSION,
    StoreError, acquire_store_lock, backup_corrupt_file, create_temp, make_private,
    read_bounded_regular_file, sync_directory, valid_guide_key, validate_guide_key,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ANCHOR_OFFSET: f64 = 1_000_000_000.0;
const MAX_ANCHOR_TEXT: usize = 512;

#[derive(Clone, Debug, PartialEq)]
struct ReaderPosition {
    scroll_top: f64,
    section_id: Option<String>,
    anchor_text: Option<String>,
    anchor_offset: f64,
    updated_at_ms: u64,
}

#[derive(Debug, Default)]
struct ReaderDocument {
    positions: BTreeMap<String, ReaderPosition>,
}

pub(super) struct ReaderHistoryEntry {
    pub(super) app_id: String,
    pub(super) guide_id: String,
    pub(super) section_id: Option<String>,
    pub(super) updated_at_ms: u64,
}

impl ReaderDocument {
    fn from_bytes(payload: &[u8]) -> Result<Self, StoreError> {
        let value: Value = serde_json::from_slice(payload)
            .map_err(|_| StoreError::Storage("reader_positions.json could not be read"))?;
        let object = value.as_object().ok_or(StoreError::Storage(
            "reader_positions.json has unknown or missing fields",
        ))?;
        if object.len() != 2
            || !object.contains_key("schema_version")
            || !object.contains_key("positions")
        {
            return Err(StoreError::Storage(
                "reader_positions.json has unknown or missing fields",
            ));
        }
        if object.get("schema_version").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            return Err(StoreError::Storage(
                "reader_positions.json uses an unsupported schema",
            ));
        }
        let raw_positions = object
            .get("positions")
            .and_then(Value::as_object)
            .filter(|positions| positions.len() <= MAX_POSITIONS)
            .ok_or(StoreError::Storage(
                "reader_positions.json has invalid positions",
            ))?;

        let mut positions = BTreeMap::new();
        for (guide_key, raw_position) in raw_positions {
            if !valid_guide_key(guide_key) {
                return Err(StoreError::Storage(
                    "reader_positions.json has an invalid key",
                ));
            }
            let position = raw_position.as_object().ok_or(StoreError::Storage(
                "reader position contains unknown or missing fields",
            ))?;
            if position.len() != 5
                || ![
                    "scroll_top",
                    "section_id",
                    "anchor_text",
                    "anchor_offset",
                    "updated_at_ms",
                ]
                .iter()
                .all(|field| position.contains_key(*field))
            {
                return Err(StoreError::Storage(
                    "reader position contains unknown or missing fields",
                ));
            }

            let scroll_top = number_in_range(
                position.get("scroll_top").expect("scroll_top was checked"),
                0.0,
                MAX_SCROLL_TOP,
            )
            .ok_or(StoreError::Storage("stored reader position is invalid"))?;
            let section_id =
                optional_section_id(position.get("section_id").expect("section_id was checked"))
                    .ok_or(StoreError::Storage("stored reader position is invalid"))?
                    .map(str::to_owned);
            let anchor_text = optional_anchor_text(
                position
                    .get("anchor_text")
                    .expect("anchor_text was checked"),
            )
            .ok_or(StoreError::Storage("stored reader position is invalid"))?
            .map(str::to_owned);
            let anchor_offset = number_in_range(
                position
                    .get("anchor_offset")
                    .expect("anchor_offset was checked"),
                -MAX_ANCHOR_OFFSET,
                MAX_ANCHOR_OFFSET,
            )
            .ok_or(StoreError::Storage("stored reader position is invalid"))?;
            let updated_at_ms = position
                .get("updated_at_ms")
                .and_then(Value::as_u64)
                .filter(|value| *value <= JAVASCRIPT_MAX_SAFE_INTEGER)
                .ok_or(StoreError::Storage("stored reader timestamp is invalid"))?;

            positions.insert(
                guide_key.clone(),
                ReaderPosition {
                    scroll_top,
                    section_id,
                    anchor_text,
                    anchor_offset,
                    updated_at_ms,
                },
            );
        }
        Ok(Self { positions })
    }

    fn to_value(&self) -> Value {
        json!({
            "positions": self.positions.iter().map(|(key, position)| {
                (key.clone(), reader_position_value(position))
            }).collect::<serde_json::Map<_, _>>(),
            "schema_version": SCHEMA_VERSION,
        })
    }
}

pub(super) struct ReaderPositionStore {
    path: PathBuf,
}

impl ReaderPositionStore {
    pub(super) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read_document(&self) -> Result<ReaderDocument, StoreError> {
        match read_bounded_regular_file(&self.path, MAX_FILE_BYTES) {
            Ok(payload) => ReaderDocument::from_bytes(&payload),
            Err(ReadError::Missing) => Ok(ReaderDocument::default()),
            Err(ReadError::TooLarge) => Err(StoreError::Storage(
                "reader_positions.json exceeds the size limit",
            )),
            Err(ReadError::Unsafe) => Err(StoreError::Storage(
                "reader_positions.json could not be read safely",
            )),
        }
    }

    pub(super) fn get(&self, guide_key: &str) -> Result<Value, StoreError> {
        validate_guide_key(guide_key)?;
        Ok(self
            .read_document()?
            .positions
            .get(guide_key)
            .map(reader_position_value)
            .unwrap_or(Value::Null))
    }

    pub(super) fn recent(
        &self,
        app_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ReaderHistoryEntry>, StoreError> {
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock reader_positions.json"))?;
        let mut entries: Vec<_> = self
            .read_document()?
            .positions
            .into_iter()
            .filter_map(|(guide_key, position)| {
                let (entry_app_id, guide_id) = guide_key
                    .split_once(':')
                    .expect("stored reader position keys are validated");
                if app_id.is_some_and(|app_id| app_id != entry_app_id) {
                    return None;
                }
                Some(ReaderHistoryEntry {
                    app_id: entry_app_id.to_owned(),
                    guide_id: guide_id.to_owned(),
                    section_id: position.section_id,
                    updated_at_ms: position.updated_at_ms,
                })
            })
            .collect();
        entries.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then_with(|| left.app_id.cmp(&right.app_id))
                .then_with(|| left.guide_id.cmp(&right.guide_id))
        });
        entries.truncate(limit);
        Ok(entries)
    }

    pub(super) fn save(
        &self,
        guide_key: &str,
        scroll_top: &Value,
        section_id: &Value,
        anchor_text: &Value,
        anchor_offset: &Value,
    ) -> Result<Value, StoreError> {
        validate_guide_key(guide_key)?;
        let scroll_top = validate_number(
            scroll_top,
            0.0,
            MAX_SCROLL_TOP,
            "scroll_top must be a finite number",
            "scroll_top must be a finite number in range",
        )?;
        let section_id = optional_section_id(section_id)
            .ok_or(StoreError::Validation("section_id is invalid"))?
            .map(str::to_owned);
        let anchor_text = optional_anchor_text(anchor_text)
            .ok_or(StoreError::Validation("anchor_text is invalid"))?
            .map(str::to_owned);
        let anchor_offset = validate_number(
            anchor_offset,
            -MAX_ANCHOR_OFFSET,
            MAX_ANCHOR_OFFSET,
            "anchor_offset must be a finite number",
            "anchor_offset must be a finite number in range",
        )?;
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock reader_positions.json"))?;
        let position = ReaderPosition {
            scroll_top,
            section_id,
            anchor_text,
            anchor_offset,
            updated_at_ms: reader_now_ms()?,
        };

        let mut document = self.read_document()?;
        document
            .positions
            .insert(guide_key.to_owned(), position.clone());
        if document.positions.len() > MAX_POSITIONS {
            return Err(StoreError::Storage("reader position limit reached"));
        }
        self.write_atomic(&document)?;
        Ok(reader_position_value(&position))
    }

    pub(super) fn repair(&self) -> Result<Value, StoreError> {
        if matches!(
            fs::symlink_metadata(&self.path),
            Err(error) if error.kind() == io::ErrorKind::NotFound
        ) {
            return Ok(json!({"backup": null, "repaired": false}));
        }
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock reader_positions.json"))?;
        if self.read_document().is_ok() {
            return Ok(json!({"backup": null, "repaired": false}));
        }
        let backup = backup_corrupt_file(&self.path)
            .map_err(|_| StoreError::Storage("could not back up corrupt reader_positions.json"))?;
        self.write_atomic(&ReaderDocument::default())?;
        Ok(json!({"backup": backup.to_string_lossy(), "repaired": true}))
    }

    fn write_atomic(&self, document: &ReaderDocument) -> Result<(), StoreError> {
        let mut payload = serde_json::to_vec(&document.to_value())
            .expect("validated reader position document must serialize");
        payload.push(b'\n');
        if payload.len() as u64 > MAX_FILE_BYTES {
            return Err(StoreError::Storage(
                "reader_positions.json would exceed the size limit",
            ));
        }

        let parent = self.path.parent().ok_or(StoreError::Storage(
            "could not create a reader position file",
        ))?;
        fs::create_dir_all(parent)
            .map_err(|_| StoreError::Storage("could not create a reader position file"))?;
        let (mut temporary, temporary_path) = create_temp(parent, ".reader-positions-", ".tmp")
            .map_err(|_| StoreError::Storage("could not create a reader position file"))?;

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
                "could not atomically replace reader_positions.json",
            ));
        }

        sync_directory(parent).map_err(|_| {
            StoreError::Durability(
                "reader_positions.json was replaced but its directory could not be synced",
            )
        })
    }
}

fn number_in_range(value: &Value, minimum: f64, maximum: f64) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && minimum <= *value && *value <= maximum)
}

fn validate_number(
    value: &Value,
    minimum: f64,
    maximum: f64,
    type_message: &'static str,
    range_message: &'static str,
) -> Result<f64, StoreError> {
    if !value.is_number() {
        return Err(StoreError::Validation(type_message));
    }
    number_in_range(value, minimum, maximum).ok_or(StoreError::Validation(range_message))
}

fn optional_section_id(value: &Value) -> Option<Option<&str>> {
    match value {
        Value::Null => Some(None),
        Value::String(value) if valid_section_id(value) => Some(Some(value)),
        _ => None,
    }
}

fn valid_section_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 128
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn optional_anchor_text(value: &Value) -> Option<Option<&str>> {
    match value {
        Value::Null => Some(None),
        Value::String(value) if valid_anchor_text(value) => Some(Some(value)),
        _ => None,
    }
}

fn valid_anchor_text(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ANCHOR_TEXT
        && !value.chars().any(|character| {
            matches!(
                character as u32,
                0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f
            )
        })
}

fn reader_now_ms() -> Result<u64, StoreError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::Validation("updated_at_ms is invalid"))?
        .as_millis();
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= JAVASCRIPT_MAX_SAFE_INTEGER)
        .ok_or(StoreError::Validation("updated_at_ms is invalid"))
}

fn reader_position_value(position: &ReaderPosition) -> Value {
    json!({
        "anchor_offset": position.anchor_offset,
        "anchor_text": position.anchor_text.as_deref(),
        "scroll_top": position.scroll_top,
        "section_id": position.section_id.as_deref(),
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
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let store = ReaderPositionStore::new(path.clone());

        assert_eq!(store.get("1113000:3414883877").unwrap(), Value::Null);
        assert!(!path.exists());
        let saved = store
            .save(
                "1113000:90071992547409931234",
                &json!(4040.25),
                &json!("7667220"),
                &json!("去河堤下方与老人对话"),
                &json!(-17.5),
            )
            .unwrap();
        assert_eq!(saved["scroll_top"], 4040.25);
        assert_eq!(saved["section_id"], "7667220");
        assert_eq!(saved["anchor_text"], "去河堤下方与老人对话");
        assert_eq!(saved["anchor_offset"], -17.5);
        assert!(saved["updated_at_ms"].as_u64().unwrap() <= JAVASCRIPT_MAX_SAFE_INTEGER);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(store.get("1113000:90071992547409931234").unwrap(), saved);

        let replacement = store
            .save(
                "1113000:90071992547409931234",
                &json!(1),
                &Value::Null,
                &Value::Null,
                &json!(0),
            )
            .unwrap();
        assert_eq!(replacement["scroll_top"], 1.0);
        assert_eq!(replacement["section_id"], Value::Null);
        assert_eq!(replacement["anchor_text"], Value::Null);
        let document: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(document["schema_version"], 1);
    }

    #[test]
    fn recent_history_filters_sorts_and_limits_without_rewriting() {
        let directory = TestDirectory::new("reader_positions.json");
        let store = ReaderPositionStore::new(directory.path());
        let mut document = ReaderDocument::default();
        for (guide_key, updated_at_ms, section_id) in [
            ("2:9", 300, None),
            ("1:3", 200, Some("third")),
            ("1:2", 200, Some("second")),
            ("1:1", 100, Some("first")),
        ] {
            document.positions.insert(
                guide_key.to_owned(),
                ReaderPosition {
                    scroll_top: 1.0,
                    section_id: section_id.map(str::to_owned),
                    anchor_text: None,
                    anchor_offset: 0.0,
                    updated_at_ms,
                },
            );
        }
        store.write_atomic(&document).unwrap();

        let recent = store.recent(Some("1"), 2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].guide_id, "2");
        assert_eq!(recent[0].section_id.as_deref(), Some("second"));
        assert_eq!(recent[1].guide_id, "3");
        assert_eq!(recent[1].updated_at_ms, 200);

        let all = store.recent(None, 5).unwrap();
        assert_eq!(all[0].app_id, "2");
        assert_eq!(all[0].guide_id, "9");
        assert!(
            ReaderPositionStore::new(directory.0.join("missing.json"))
                .recent(None, 5)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn recent_waits_for_an_active_store_write() {
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let store = ReaderPositionStore::new(path.clone());
        let writer_lock = acquire_store_lock(&path).unwrap();
        let (started_sender, started_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            started_sender.send(()).unwrap();
            result_sender
                .send(ReaderPositionStore::new(path).recent(None, 1))
                .unwrap();
        });

        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(
            result_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );

        let mut document = ReaderDocument::default();
        document.positions.insert(
            "1:2".to_owned(),
            ReaderPosition {
                scroll_top: 1.0,
                section_id: None,
                anchor_text: None,
                anchor_offset: 0.0,
                updated_at_ms: 1,
            },
        );
        store.write_atomic(&document).unwrap();
        drop(writer_lock);

        let recent = result_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("recent did not resume after the writer unlocked")
            .unwrap();
        reader.join().unwrap();
        assert_eq!(recent[0].guide_id, "2");
    }

    #[test]
    fn invalid_inputs_are_rejected_without_a_write() {
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let store = ReaderPositionStore::new(path.clone());
        let cases = [
            ("bad", json!(1), Value::Null, Value::Null, json!(0)),
            ("1:2", json!(-1), Value::Null, Value::Null, json!(0)),
            ("1:2", Value::Bool(true), Value::Null, Value::Null, json!(0)),
            ("1:2", json!(1), json!("../section"), Value::Null, json!(0)),
            ("1:2", json!(1), Value::Null, json!(""), json!(0)),
            (
                "1:2",
                json!(1),
                Value::Null,
                json!("x".repeat(MAX_ANCHOR_TEXT + 1)),
                json!(0),
            ),
            ("1:2", json!(1), Value::Null, json!("bad\u{1}"), json!(0)),
            (
                "1:2",
                json!(1),
                Value::Null,
                Value::Null,
                json!(MAX_ANCHOR_OFFSET + 1.0),
            ),
        ];

        for (guide_key, scroll_top, section_id, anchor_text, anchor_offset) in cases {
            assert!(matches!(
                store.save(
                    guide_key,
                    &scroll_top,
                    &section_id,
                    &anchor_text,
                    &anchor_offset,
                ),
                Err(StoreError::Validation(_))
            ));
        }
        assert!(!path.exists());
    }

    #[test]
    fn anchor_text_uses_python_unicode_and_control_character_rules() {
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let store = ReaderPositionStore::new(path.clone());
        let allowed_controls = "tab\tline\nreturn\rnext\u{85}";
        assert_eq!(
            store
                .save(
                    "1:2",
                    &json!(MAX_SCROLL_TOP),
                    &Value::Null,
                    &json!(allowed_controls),
                    &json!(-MAX_ANCHOR_OFFSET),
                )
                .unwrap()["anchor_text"],
            allowed_controls
        );
        let unicode_boundary = "🦀".repeat(MAX_ANCHOR_TEXT);
        assert_eq!(
            store
                .save(
                    "1:2",
                    &json!(-0.0),
                    &Value::Null,
                    &json!(unicode_boundary),
                    &json!(MAX_ANCHOR_OFFSET),
                )
                .unwrap()["anchor_text"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_ANCHOR_TEXT
        );
        let original = fs::read(&path).unwrap();

        for invalid in [
            "🦀".repeat(MAX_ANCHOR_TEXT + 1),
            "nul\0".to_owned(),
            "vertical\u{b}tab".to_owned(),
            "delete\u{7f}".to_owned(),
        ] {
            assert!(matches!(
                store.save("1:2", &json!(1), &Value::Null, &json!(invalid), &json!(0),),
                Err(StoreError::Validation("anchor_text is invalid"))
            ));
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn corruption_is_preserved_until_repair_backs_it_up() {
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let original = b"{ definitely not json";
        fs::write(&path, original).unwrap();
        let store = ReaderPositionStore::new(path.clone());

        assert!(matches!(
            store.save("1:2", &json!(-1), &Value::Null, &Value::Null, &json!(0)),
            Err(StoreError::Validation(
                "scroll_top must be a finite number in range"
            ))
        ));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(
            store
                .save("1:2", &json!(3), &Value::Null, &Value::Null, &json!(0))
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        let repaired = store.repair().unwrap();
        let backup = PathBuf::from(repaired["backup"].as_str().unwrap());
        assert_eq!(repaired["repaired"], true);
        assert_eq!(fs::read(&backup).unwrap(), original);
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(store.get("1:2").unwrap(), Value::Null);
        assert_eq!(
            store.repair().unwrap(),
            json!({"backup": null, "repaired": false})
        );
    }

    #[test]
    fn repair_leaves_missing_and_valid_stores_untouched() {
        let directory = TestDirectory::new("reader_positions.json");
        let missing_path = directory.0.join("missing/reader_positions.json");
        let missing_store = ReaderPositionStore::new(missing_path.clone());
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
            ReaderPositionStore::new(path.clone()).repair().unwrap(),
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
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let store = ReaderPositionStore::new(path.clone());
        let mut document = ReaderDocument::default();
        for guide_id in 1..=MAX_POSITIONS {
            document.positions.insert(
                format!("1:{guide_id}"),
                ReaderPosition {
                    scroll_top: guide_id as f64,
                    section_id: None,
                    anchor_text: None,
                    anchor_offset: 0.0,
                    updated_at_ms: guide_id as u64,
                },
            );
        }
        store.write_atomic(&document).unwrap();
        let original = fs::read(&path).unwrap();

        let error = store
            .save("2:1", &json!(1), &Value::Null, &Value::Null, &json!(0))
            .unwrap_err();
        assert!(matches!(
            error,
            StoreError::Storage("reader position limit reached")
        ));
        assert_eq!(fs::read(&path).unwrap(), original);

        assert_eq!(
            store
                .save("1:1", &json!(999), &Value::Null, &Value::Null, &json!(0))
                .unwrap()["scroll_top"],
            999.0
        );
        assert_eq!(
            store.read_document().unwrap().positions.len(),
            MAX_POSITIONS
        );
    }

    #[test]
    fn unsafe_and_fifo_stores_are_rejected_without_blocking() {
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let outside = directory.0.join("outside.json");
        fs::write(&outside, b"{\"positions\":{},\"schema_version\":1}").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(matches!(
            ReaderPositionStore::new(path.clone()).get("1:2"),
            Err(StoreError::Storage(message)) if message.contains("safely")
        ));
        assert!(matches!(
            ReaderPositionStore::new(path.clone()).repair(),
            Err(StoreError::Storage(message)) if message.contains("back up")
        ));
        assert_eq!(
            fs::read(&outside).unwrap(),
            b"{\"positions\":{},\"schema_version\":1}"
        );
        fs::remove_file(&path).unwrap();

        let path_bytes = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path_bytes.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            sender
                .send(ReaderPositionStore::new(path).repair())
                .unwrap()
        });
        let error = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("FIFO read blocked")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(
            error,
            StoreError::Storage(message) if message.contains("back up")
        ));
    }

    #[test]
    fn stored_schema_validation_matches_the_python_store() {
        let invalid_documents: &[(&[u8], &str)] = &[
            (b"[]", "unknown or missing fields"),
            (
                b"{\"positions\":{},\"schema_version\":1.0}",
                "unsupported schema",
            ),
            (
                b"{\"positions\":{},\"schema_version\":1,\"future\":true}",
                "unknown or missing fields",
            ),
            (
                b"{\"positions\":[],\"schema_version\":1}",
                "invalid positions",
            ),
            (
                b"{\"positions\":{\"0:2\":{}},\"schema_version\":1}",
                "invalid key",
            ),
            (
                b"{\"positions\":{\"1:2\":{\"anchor_offset\":0,\"anchor_text\":null,\"scroll_top\":1,\"section_id\":null}},\"schema_version\":1}",
                "unknown or missing fields",
            ),
            (
                b"{\"positions\":{\"1:2\":{\"anchor_offset\":0,\"anchor_text\":null,\"scroll_top\":true,\"section_id\":null,\"updated_at_ms\":1}},\"schema_version\":1}",
                "stored reader position is invalid",
            ),
            (
                b"{\"positions\":{\"1:2\":{\"anchor_offset\":0,\"anchor_text\":null,\"scroll_top\":1,\"section_id\":null,\"updated_at_ms\":9007199254740992}},\"schema_version\":1}",
                "stored reader timestamp is invalid",
            ),
        ];

        for (payload, expected) in invalid_documents {
            let error = ReaderDocument::from_bytes(payload).unwrap_err();
            assert!(matches!(
                error,
                StoreError::Storage(message) if message.contains(expected)
            ));
        }
    }

    #[test]
    fn reader_store_accepts_a_valid_file_larger_than_the_primary_budget() {
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        let mut document = ReaderDocument::default();
        let anchor_text = "x".repeat(150);
        for guide_id in 1..=MAX_POSITIONS {
            document.positions.insert(
                format!("1:{guide_id}"),
                ReaderPosition {
                    scroll_top: guide_id as f64,
                    section_id: None,
                    anchor_text: Some(anchor_text.clone()),
                    anchor_offset: 0.0,
                    updated_at_ms: guide_id as u64,
                },
            );
        }
        let payload = serde_json::to_vec(&document.to_value()).unwrap();
        assert!(payload.len() as u64 > crate::MAX_FILE_BYTES);
        assert!(payload.len() as u64 <= MAX_FILE_BYTES);
        fs::write(&path, payload).unwrap();

        assert_eq!(
            ReaderPositionStore::new(path).get("1:10000").unwrap()["anchor_text"],
            anchor_text
        );
    }

    #[test]
    fn oversized_store_is_rejected_before_parsing() {
        let directory = TestDirectory::new("reader_positions.json");
        let path = directory.path();
        fs::write(&path, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();

        let error = ReaderPositionStore::new(path).get("1:2").unwrap_err();
        assert!(matches!(
            error,
            StoreError::Storage("reader_positions.json exceeds the size limit")
        ));
    }
}
