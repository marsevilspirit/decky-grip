use super::{
    AtomicReplaceError, JAVASCRIPT_MAX_SAFE_INTEGER, ReadError, SCHEMA_VERSION, StoreError,
    acquire_store_lock, atomic_replace, backup_corrupt_file, now_ms, read_bounded_regular_file,
    validate_guide_key,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;

const MAX_FILE_BYTES: u64 = 64 * 1024;
const MAX_FAVORITES: usize = 20;

#[derive(Debug, Default)]
struct FavoriteDocument {
    favorites: BTreeMap<String, u64>,
}

impl FavoriteDocument {
    fn from_bytes(payload: &[u8]) -> Result<Self, StoreError> {
        let value: Value = serde_json::from_slice(payload)
            .map_err(|_| StoreError::Storage("favorites.json could not be read"))?;
        let object = value.as_object().ok_or(StoreError::Storage(
            "favorites.json has unknown or missing fields",
        ))?;
        if object.len() != 2
            || !object.contains_key("schema_version")
            || !object.contains_key("favorites")
        {
            return Err(StoreError::Storage(
                "favorites.json has unknown or missing fields",
            ));
        }
        if object.get("schema_version").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            return Err(StoreError::Storage(
                "favorites.json uses an unsupported schema",
            ));
        }
        let raw_favorites = object
            .get("favorites")
            .and_then(Value::as_object)
            .filter(|favorites| favorites.len() <= MAX_FAVORITES)
            .ok_or(StoreError::Storage("favorites.json has invalid favorites"))?;

        let mut favorites = BTreeMap::new();
        for (guide_key, raw_favorite) in raw_favorites {
            validate_guide_key(guide_key)
                .map_err(|_| StoreError::Storage("favorites.json has an invalid guide key"))?;
            let favorite = raw_favorite
                .as_object()
                .filter(|favorite| favorite.len() == 1 && favorite.contains_key("favorited_at_ms"));
            let favorited_at_ms = favorite
                .and_then(|favorite| favorite.get("favorited_at_ms"))
                .and_then(Value::as_u64)
                .filter(|value| *value <= JAVASCRIPT_MAX_SAFE_INTEGER)
                .ok_or(StoreError::Storage(
                    "favorites.json has an invalid favorite",
                ))?;
            favorites.insert(guide_key.clone(), favorited_at_ms);
        }
        Ok(Self { favorites })
    }

    fn to_value(&self) -> Value {
        json!({
            "favorites": self.favorites.iter().map(|(guide_key, favorited_at_ms)| {
                (guide_key.clone(), json!({"favorited_at_ms": favorited_at_ms}))
            }).collect::<serde_json::Map<_, _>>(),
            "schema_version": SCHEMA_VERSION,
        })
    }
}

pub(super) struct FavoriteStore {
    path: PathBuf,
}

impl FavoriteStore {
    pub(super) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read_document(&self) -> Result<FavoriteDocument, StoreError> {
        match read_bounded_regular_file(&self.path, MAX_FILE_BYTES, None) {
            Ok((Some(payload), _)) => FavoriteDocument::from_bytes(&payload),
            Ok((None, _)) => unreachable!("a read without a known signature returns bytes"),
            Err(ReadError::Missing) => Ok(FavoriteDocument::default()),
            Err(ReadError::TooLarge) => {
                Err(StoreError::Storage("favorites.json exceeds the size limit"))
            }
            Err(ReadError::Changed | ReadError::Unsafe) => Err(StoreError::Storage(
                "favorites.json could not be read safely",
            )),
        }
    }

    pub(super) fn entries(&self) -> Result<BTreeMap<String, u64>, StoreError> {
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock favorites.json"))?;
        Ok(self.read_document()?.favorites)
    }

    pub(super) fn set(&self, guide_key: &str, favorite: &Value) -> Result<Value, StoreError> {
        validate_guide_key(guide_key)?;
        let favorite = favorite
            .as_bool()
            .ok_or(StoreError::Validation("favorite must be a boolean"))?;
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock favorites.json"))?;
        let mut document = self.read_document()?;

        let changed = if favorite {
            if document.favorites.contains_key(guide_key) {
                false
            } else {
                if document.favorites.len() >= MAX_FAVORITES {
                    return Err(StoreError::Storage("favorite limit reached"));
                }
                document.favorites.insert(guide_key.to_owned(), now_ms()?);
                true
            }
        } else {
            document.favorites.remove(guide_key).is_some()
        };
        if changed {
            self.write_atomic(&document)?;
        }
        Ok(json!({"favorite": favorite, "guide_key": guide_key}))
    }

    pub(super) fn repair(&self) -> Result<Value, StoreError> {
        if matches!(
            fs::symlink_metadata(&self.path),
            Err(error) if error.kind() == io::ErrorKind::NotFound
        ) {
            return Ok(json!({"backup": null, "repaired": false}));
        }
        let _lock = acquire_store_lock(&self.path)
            .map_err(|_| StoreError::Storage("could not lock favorites.json"))?;
        if self.read_document().is_ok() {
            return Ok(json!({"backup": null, "repaired": false}));
        }
        let backup = backup_corrupt_file(&self.path)
            .map_err(|_| StoreError::Storage("could not back up corrupt favorites.json"))?;
        self.write_atomic(&FavoriteDocument::default())?;
        Ok(json!({"backup": backup.to_string_lossy(), "repaired": true}))
    }

    fn write_atomic(&self, document: &FavoriteDocument) -> Result<(), StoreError> {
        let mut payload = serde_json::to_vec(&document.to_value())
            .expect("validated favorite document must serialize");
        payload.push(b'\n');
        if payload.len() as u64 > MAX_FILE_BYTES {
            return Err(StoreError::Storage(
                "favorites.json would exceed the size limit",
            ));
        }

        match atomic_replace(&self.path, ".favorites-", ".tmp", &payload) {
            Ok(()) => Ok(()),
            Err(AtomicReplaceError::Prepare) => {
                Err(StoreError::Storage("could not create a favorites file"))
            }
            Err(AtomicReplaceError::Replace) => Err(StoreError::Storage(
                "could not atomically replace favorites.json",
            )),
            Err(AtomicReplaceError::Durability) => Err(StoreError::Durability(
                "favorites.json was replaced but its directory could not be synced",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn set_is_private_bounded_and_idempotent() {
        let directory = TestDirectory::new("favorites.json");
        let path = directory.path();
        let store = FavoriteStore::new(path.clone());

        assert_eq!(
            store.set("1:1", &json!(true)).unwrap(),
            json!({"favorite": true, "guide_key": "1:1"})
        );
        let original = fs::read(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(store.set("1:1", &json!(true)).unwrap()["favorite"], true);
        assert_eq!(fs::read(&path).unwrap(), original);

        for guide_id in 2..=MAX_FAVORITES {
            store.set(&format!("1:{guide_id}"), &json!(true)).unwrap();
        }
        assert!(matches!(
            store.set("2:1", &json!(true)),
            Err(StoreError::Storage("favorite limit reached"))
        ));
        assert_eq!(store.entries().unwrap().len(), MAX_FAVORITES);

        store.set("1:1", &json!(false)).unwrap();
        let removed = fs::read(&path).unwrap();
        store.set("1:1", &json!(false)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), removed);
    }

    #[test]
    fn corruption_is_preserved_until_repair_backs_it_up() {
        let directory = TestDirectory::new("favorites.json");
        let path = directory.path();
        let original = b"{ definitely not json";
        fs::write(&path, original).unwrap();
        let store = FavoriteStore::new(path.clone());

        assert!(store.set("1:2", &json!(true)).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let repaired = store.repair().unwrap();
        let backup = PathBuf::from(repaired["backup"].as_str().unwrap());
        assert_eq!(fs::read(backup).unwrap(), original);
        assert!(store.entries().unwrap().is_empty());
    }

    #[test]
    fn reads_wait_for_the_sibling_store_lock() {
        let directory = TestDirectory::new("favorites.json");
        let path = directory.path();
        let writer_lock = acquire_store_lock(&path).unwrap();
        let (started_sender, started_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            started_sender.send(()).unwrap();
            result_sender
                .send(FavoriteStore::new(path).entries())
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
        drop(writer_lock);
        assert!(
            result_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap()
                .is_empty()
        );
        reader.join().unwrap();
    }
}
