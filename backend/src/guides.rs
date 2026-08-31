use crate::guide_html::{
    MAX_LABEL_CHARS, MAX_PAGE_NODES, MAX_PAGE_TEXT_CHARS, MAX_SANITIZED_HTML_BYTES, MAX_SECTIONS,
    localize_guide_images, parse_guide_html, sanitize_fragment_with_stats,
    source_url as guide_source_url, valid_guide_id,
};
use crate::{FileSignature, create_temp, make_private, signature, sync_directory};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub const MAX_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CACHE_BYTES: u64 = 20 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
pub const CACHE_MAX_AGE_MS: u64 = 6 * 60 * 60 * 1_000;

const CACHE_SCHEMA_VERSION: u64 = 1;
const MAX_FUTURE_TIMESTAMP_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_REDIRECTS: usize = 10;

type Fetcher = dyn Fn(&str, Duration, usize) -> Result<Vec<u8>, GuideError> + Send + Sync;
type Clock = dyn Fn() -> u64 + Send + Sync;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuideErrorKind {
    Validation,
    Download,
    Parse,
    Cache,
}

#[derive(Debug)]
pub struct GuideError {
    kind: GuideErrorKind,
    message: String,
}

impl GuideError {
    fn new(kind: GuideErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn download(message: impl Into<String>) -> Self {
        Self::new(GuideErrorKind::Download, message)
    }

    pub fn kind(&self) -> GuideErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::new(GuideErrorKind::Validation, message)
    }

    fn parse(source: impl Error) -> Self {
        Self::new(GuideErrorKind::Parse, source.to_string())
    }

    fn cache(message: impl Into<String>) -> Self {
        Self::new(GuideErrorKind::Cache, message)
    }
}

impl fmt::Display for GuideError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for GuideError {}

#[derive(Clone)]
struct MemoEntry {
    signature: FileSignature,
    document: Value,
}

#[derive(Debug)]
enum CacheReadError {
    Missing,
    TooLarge,
    Changed,
    Unsafe,
}

#[derive(Default)]
struct GuideLockPool {
    entries: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl GuideLockPool {
    fn retain(&self, guide_id: &str) -> Arc<Mutex<()>> {
        let mut entries = lock(&self.entries);
        entries
            .entry(guide_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn release(&self, guide_id: &str, entry: &Arc<Mutex<()>>) {
        let mut entries = lock(&self.entries);
        if Arc::strong_count(entry) == 2
            && entries
                .get(guide_id)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            entries.remove(guide_id);
        }
    }
}

pub struct GuideReader {
    cache_directory: PathBuf,
    fetcher: Arc<Fetcher>,
    now_ms: Arc<Clock>,
    guide_locks: GuideLockPool,
    memo: Mutex<HashMap<String, MemoEntry>>,
    disk_lock: Mutex<()>,
    generation: Mutex<u64>,
}

impl GuideReader {
    pub fn new(cache_directory: impl Into<PathBuf>) -> Self {
        Self::with_fetcher(cache_directory, download, system_now_ms)
    }

    pub fn with_fetcher<F, N>(cache_directory: impl Into<PathBuf>, fetcher: F, now_ms: N) -> Self
    where
        F: Fn(&str, Duration, usize) -> Result<Vec<u8>, GuideError> + Send + Sync + 'static,
        N: Fn() -> u64 + Send + Sync + 'static,
    {
        Self {
            cache_directory: cache_directory.into(),
            fetcher: Arc::new(fetcher),
            now_ms: Arc::new(now_ms),
            guide_locks: GuideLockPool::default(),
            memo: Mutex::new(HashMap::new()),
            disk_lock: Mutex::new(()),
            generation: Mutex::new(0),
        }
    }

    pub fn get(&self, guide_id: &str, force_refresh: bool) -> Result<Value, GuideError> {
        validate_guide_id(guide_id)?;
        let guide_lock = self.guide_locks.retain(guide_id);
        let result = {
            let _guard = lock(&guide_lock);
            self.get_locked(guide_id, force_refresh)
        };
        self.guide_locks.release(guide_id, &guide_lock);
        result
    }

    pub fn get_cached(&self, guide_id: &str) -> Result<Option<Value>, GuideError> {
        validate_guide_id(guide_id)?;
        let Some(document) = self.read_cache(guide_id)? else {
            return Ok(None);
        };
        let now = (self.now_ms)();
        Ok(Some(with_cache_status(
            &document,
            true,
            is_stale(now, fetched_at(&document)),
        )))
    }

    pub fn cached_summary(
        &self,
        guide_id: &str,
        section_id: Option<&str>,
    ) -> Result<Option<Value>, GuideError> {
        validate_guide_id(guide_id)?;
        let Some(document) = self.read_cache(guide_id)? else {
            return Ok(None);
        };
        let section_title = section_id.and_then(|section_id| {
            document["sections"].as_array()?.iter().find_map(|section| {
                (section["id"].as_str() == Some(section_id)).then(|| section["title"].clone())
            })
        });
        Ok(Some(json!({
            "author": document["author"],
            "fetchedAt": document["fetchedAt"],
            "sectionTitle": section_title,
            "stale": is_stale((self.now_ms)(), fetched_at(&document)),
            "title": document["title"],
        })))
    }

    pub fn clear_guide_cache(&self) -> Result<Value, GuideError> {
        {
            let mut generation = lock(&self.generation);
            *generation = generation.wrapping_add(1);
        }
        let _disk = lock(&self.disk_lock);
        let mut files_removed = 0_u64;
        let mut bytes_removed = 0_u64;
        if let Some(entries) = read_cache_directory(&self.cache_directory)? {
            for entry in entries {
                let entry =
                    entry.map_err(|_| GuideError::cache("guide cache could not be inspected"))?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                if !managed_cache_name(name) {
                    continue;
                }
                let metadata = match fs::symlink_metadata(entry.path()) {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                let result = if metadata.is_dir() {
                    fs::remove_dir(entry.path())
                } else {
                    fs::remove_file(entry.path())
                };
                result.map_err(|_| GuideError::cache("guide cache could not be cleared"))?;
                files_removed += 1;
                if metadata.is_file() {
                    bytes_removed = bytes_removed.saturating_add(metadata.len());
                }
            }
        }
        lock(&self.memo).clear();
        Ok(json!({
            "bytesRemoved": bytes_removed,
            "filesRemoved": files_removed,
        }))
    }

    pub fn remove_guide_cache(&self, guide_id: &str) -> Result<Value, GuideError> {
        validate_guide_id(guide_id)?;
        let guide_lock = self.guide_locks.retain(guide_id);
        let result = {
            let _guide = lock(&guide_lock);
            (|| {
                let _disk = lock(&self.disk_lock);
                let path = self.cache_path(guide_id);
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.is_file() => Some(metadata),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                    _ => {
                        return Err(GuideError::cache(
                            "cached guide could not be removed safely",
                        ));
                    }
                };
                let (files_removed, bytes_removed) = if let Some(metadata) = metadata {
                    fs::remove_file(path)
                        .map_err(|_| GuideError::cache("cached guide could not be removed"))?;
                    sync_directory(&self.cache_directory).map_err(|_| {
                        GuideError::cache(
                            "cached guide was removed but its directory could not be synced",
                        )
                    })?;
                    (1, metadata.len())
                } else {
                    (0, 0)
                };
                lock(&self.memo).remove(guide_id);
                Ok(json!({
                    "bytesRemoved": bytes_removed,
                    "filesRemoved": files_removed,
                }))
            })()
        };
        self.guide_locks.release(guide_id, &guide_lock);
        result
    }

    pub fn cache_stats(&self) -> Result<Value, GuideError> {
        let _disk = lock(&self.disk_lock);
        let mut files = 0_u64;
        let mut bytes = 0_u64;
        if let Some(entries) = read_cache_directory(&self.cache_directory)? {
            for entry in entries {
                let Ok(entry) = entry else {
                    continue;
                };
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                if !managed_cache_name(name) {
                    continue;
                }
                let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                if metadata.is_file() {
                    files += 1;
                    bytes = bytes.saturating_add(metadata.len());
                }
            }
        }
        Ok(json!({"bytes": bytes, "files": files}))
    }

    fn get_locked(&self, guide_id: &str, force_refresh: bool) -> Result<Value, GuideError> {
        let cache_generation = *lock(&self.generation);
        let cached = match self.read_cache(guide_id) {
            Ok(cached) => cached,
            Err(error) if force_refresh && error.kind() == GuideErrorKind::Cache => None,
            Err(error) => return Err(error),
        };
        let now = (self.now_ms)();
        if !force_refresh {
            if let Some(document) = &cached {
                return Ok(with_cache_status(
                    document,
                    true,
                    is_stale(now, fetched_at(document)),
                ));
            }
        }

        let refreshed = self.fetch_and_validate(guide_id, now);
        let validated = match refreshed {
            Ok(document) => document,
            Err(error)
                if matches!(
                    error.kind(),
                    GuideErrorKind::Download | GuideErrorKind::Parse
                ) && cached.is_some() =>
            {
                return Ok(with_cache_status(cached.as_ref().unwrap(), true, true));
            }
            Err(error) => return Err(error),
        };
        self.write_cache(&validated, cache_generation)?;
        Ok(with_cache_status(&validated, false, false))
    }

    fn fetch_and_validate(&self, guide_id: &str, fetched_at_ms: u64) -> Result<Value, GuideError> {
        let body = (self.fetcher)(
            &guide_source_url(guide_id),
            REQUEST_TIMEOUT,
            MAX_DOWNLOAD_BYTES,
        )?;
        if body.len() > MAX_DOWNLOAD_BYTES {
            return Err(GuideError::download(
                "Steam returned an invalid response body",
            ));
        }
        let source = std::str::from_utf8(&body)
            .map_err(|_| GuideError::download("Steam returned guide HTML that was not UTF-8"))?;
        let mut document = parse_guide_html(guide_id, source).map_err(GuideError::parse)?;
        let object = document
            .as_object_mut()
            .expect("parse_guide_html always returns an object");
        object.insert("fetchedAt".into(), json!(fetched_at_ms));
        object.insert("schemaVersion".into(), json!(CACHE_SCHEMA_VERSION));
        self.validate_cached_document(guide_id, &document)
    }

    fn read_cache(&self, guide_id: &str) -> Result<Option<Value>, GuideError> {
        let path = self.cache_path(guide_id);
        for attempt in 0..2 {
            let memoized = lock(&self.memo).get(guide_id).cloned();
            let known = memoized.as_ref().map(|entry| entry.signature);
            let (payload, signature) =
                match read_bounded_regular_file(&path, MAX_CACHE_BYTES, known) {
                    Ok(value) => value,
                    Err(CacheReadError::Missing) => {
                        lock(&self.memo).remove(guide_id);
                        return Ok(None);
                    }
                    Err(CacheReadError::TooLarge) => {
                        lock(&self.memo).remove(guide_id);
                        return Err(GuideError::cache("cached guide exceeds the size limit"));
                    }
                    Err(CacheReadError::Changed) => {
                        lock(&self.memo).remove(guide_id);
                        if attempt == 0 {
                            continue;
                        }
                        return Err(GuideError::cache("cached guide changed while being read"));
                    }
                    Err(CacheReadError::Unsafe) => {
                        lock(&self.memo).remove(guide_id);
                        return Err(GuideError::cache("cached guide could not be read safely"));
                    }
                };
            if payload.is_none() {
                return Ok(Some(
                    memoized
                        .expect("matching signature requires a memo entry")
                        .document,
                ));
            }
            let parsed: Value =
                serde_json::from_slice(payload.as_ref().unwrap()).map_err(|_| {
                    lock(&self.memo).remove(guide_id);
                    GuideError::cache("cached guide could not be read")
                })?;
            let document = match self.validate_cached_document(guide_id, &parsed) {
                Ok(document) => document,
                Err(error) => {
                    lock(&self.memo).remove(guide_id);
                    return Err(error);
                }
            };
            lock(&self.memo).insert(
                guide_id.to_owned(),
                MemoEntry {
                    signature,
                    document: document.clone(),
                },
            );
            return Ok(Some(document));
        }
        unreachable!("cache reads retry at most once")
    }

    fn validate_cached_document(&self, guide_id: &str, value: &Value) -> Result<Value, GuideError> {
        let object = exact_object(
            value,
            &[
                "schemaVersion",
                "guideId",
                "title",
                "author",
                "sourceUrl",
                "fetchedAt",
                "sections",
            ],
            "cached guide has unknown or missing fields",
        )?;
        if object.get("schemaVersion").and_then(Value::as_u64) != Some(CACHE_SCHEMA_VERSION) {
            return Err(GuideError::cache("cached guide uses an unsupported schema"));
        }
        if object.get("guideId").and_then(Value::as_str) != Some(guide_id) {
            return Err(GuideError::cache(
                "cached guide id does not match its file name",
            ));
        }
        if object.get("sourceUrl").and_then(Value::as_str)
            != Some(guide_source_url(guide_id).as_str())
        {
            return Err(GuideError::cache(
                "cached guide contains an invalid source URL",
            ));
        }
        for field in ["title", "author"] {
            let valid = object
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|value| {
                    !value.is_empty()
                        && value.chars().count() <= MAX_LABEL_CHARS
                        && !contains_control_character(value)
                });
            if !valid {
                return Err(GuideError::cache(format!(
                    "cached guide contains an invalid {field}"
                )));
            }
        }
        let now = (self.now_ms)();
        let fetched_at_ms = object
            .get("fetchedAt")
            .and_then(Value::as_u64)
            .filter(|value| *value <= now.saturating_add(MAX_FUTURE_TIMESTAMP_MS))
            .ok_or_else(|| GuideError::cache("cached guide contains an invalid timestamp"))?;
        let sections = object
            .get("sections")
            .and_then(Value::as_array)
            .filter(|sections| !sections.is_empty() && sections.len() <= MAX_SECTIONS)
            .ok_or_else(|| GuideError::cache("cached guide contains invalid sections"))?;
        let mut normalized_sections = Vec::with_capacity(sections.len());
        let mut identifiers = HashSet::with_capacity(sections.len());
        let mut total_nodes = 0_usize;
        let mut total_text_chars = 0_usize;
        let mut total_html_bytes = 0_usize;
        for section in sections {
            let section = exact_object(
                section,
                &["id", "title", "html"],
                "cached guide contains an invalid section",
            )?;
            let section_id = section
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| GuideError::cache("cached guide contains an invalid section id"))?;
            if !valid_guide_id(section_id) || !identifiers.insert(section_id.to_owned()) {
                return Err(GuideError::cache(
                    "cached guide contains an invalid section id",
                ));
            }
            let title = section
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.is_empty() && title.chars().count() <= MAX_LABEL_CHARS)
                .ok_or_else(|| {
                    GuideError::cache("cached guide contains an invalid section title")
                })?;
            let fragment = section
                .get("html")
                .and_then(Value::as_str)
                .filter(|fragment| fragment.len() <= MAX_DOWNLOAD_BYTES)
                .ok_or_else(|| GuideError::cache("cached guide contains invalid section HTML"))?;
            let (sanitized, stats) = sanitize_fragment_with_stats(fragment)
                .map_err(|_| GuideError::cache("cached guide exceeds the HTML parsing budget"))?;
            total_nodes = total_nodes.saturating_add(stats.nodes);
            total_text_chars = total_text_chars.saturating_add(stats.text_chars);
            total_html_bytes = total_html_bytes.saturating_add(stats.output_bytes);
            if total_nodes > MAX_PAGE_NODES
                || total_text_chars > MAX_PAGE_TEXT_CHARS
                || total_html_bytes > MAX_SANITIZED_HTML_BYTES
            {
                return Err(GuideError::cache(
                    "cached guide exceeds the HTML parsing budget",
                ));
            }
            if sanitized != fragment {
                return Err(GuideError::cache(
                    "cached guide contains unsafe section HTML",
                ));
            }
            normalized_sections.push(json!({
                "html": fragment,
                "id": section_id,
                "title": title,
            }));
        }
        Ok(json!({
            "author": object["author"],
            "fetchedAt": fetched_at_ms,
            "guideId": guide_id,
            "schemaVersion": CACHE_SCHEMA_VERSION,
            "sections": normalized_sections,
            "sourceUrl": guide_source_url(guide_id),
            "title": object["title"],
        }))
    }

    fn cache_path(&self, guide_id: &str) -> PathBuf {
        self.cache_directory.join(format!("{guide_id}.json"))
    }

    fn write_cache(&self, document: &Value, expected_generation: u64) -> Result<(), GuideError> {
        let _disk = lock(&self.disk_lock);
        if *lock(&self.generation) != expected_generation {
            return Ok(());
        }
        self.write_cache_unlocked(document)
    }

    fn write_cache_unlocked(&self, document: &Value) -> Result<(), GuideError> {
        let mut payload = serde_json::to_vec(document)
            .map_err(|_| GuideError::cache("cached guide could not be encoded"))?;
        payload.push(b'\n');
        if payload.len() as u64 > MAX_CACHE_BYTES {
            return Err(GuideError::cache(
                "cached guide would exceed the size limit",
            ));
        }
        fs::create_dir_all(&self.cache_directory)
            .map_err(|_| GuideError::cache("could not create a guide cache file"))?;
        let (mut temporary, temporary_path) = create_temp(&self.cache_directory, ".guide-", ".tmp")
            .map_err(|_| GuideError::cache("could not create a guide cache file"))?;
        let cache_path = self.cache_path(
            document["guideId"]
                .as_str()
                .expect("validated document has a guide id"),
        );
        let replace_result = (|| -> io::Result<()> {
            make_private(&temporary)?;
            temporary.write_all(&payload)?;
            temporary.sync_all()?;
            drop(temporary);
            fs::rename(&temporary_path, &cache_path)
        })();
        if replace_result.is_err() {
            let _ = fs::remove_file(&temporary_path);
            return Err(GuideError::cache(
                "could not atomically replace guide cache",
            ));
        }
        sync_directory(&self.cache_directory).map_err(|_| {
            GuideError::cache("guide cache was replaced but its directory could not be synced")
        })?;
        match fs::symlink_metadata(&cache_path) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_CACHE_BYTES => {
                lock(&self.memo).insert(
                    document["guideId"].as_str().unwrap().to_owned(),
                    MemoEntry {
                        signature: signature(&metadata),
                        document: document.clone(),
                    },
                );
            }
            _ => {
                lock(&self.memo).remove(document["guideId"].as_str().unwrap());
            }
        }
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn validate_guide_id(guide_id: &str) -> Result<(), GuideError> {
    if valid_guide_id(guide_id) {
        Ok(())
    } else {
        Err(GuideError::validation(
            "guide_id must be a positive decimal string",
        ))
    }
}

fn exact_object<'a>(
    value: &'a Value,
    fields: &[&str],
    message: &'static str,
) -> Result<&'a Map<String, Value>, GuideError> {
    value
        .as_object()
        .filter(|object| {
            object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
        })
        .ok_or_else(|| GuideError::cache(message))
}

fn contains_control_character(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(
            character as u32,
            0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f
        )
    })
}

fn fetched_at(document: &Value) -> u64 {
    document["fetchedAt"]
        .as_u64()
        .expect("cached documents have a valid timestamp")
}

fn is_stale(now: u64, fetched_at_ms: u64) -> bool {
    now.saturating_sub(fetched_at_ms) > CACHE_MAX_AGE_MS
}

fn with_cache_status(document: &Value, from_cache: bool, stale: bool) -> Value {
    let mut result = document
        .as_object()
        .expect("validated guide document is an object")
        .clone();
    result.remove("schemaVersion");
    let localized = document["sections"]
        .as_array()
        .expect("validated guide sections are an array")
        .iter()
        .map(|section| {
            json!({
                "html": localize_guide_images(section["html"].as_str().unwrap()),
                "id": section["id"],
                "title": section["title"],
            })
        })
        .collect();
    result.insert("sections".into(), Value::Array(localized));
    result.insert("fromCache".into(), json!(from_cache));
    result.insert("stale".into(), json!(stale));
    Value::Object(result)
}

fn managed_cache_name(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(valid_guide_id)
}

fn read_cache_directory(path: &Path) -> Result<Option<fs::ReadDir>, GuideError> {
    match fs::read_dir(path) {
        Ok(entries) => Ok(Some(entries)),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(_) => Err(GuideError::cache("guide cache could not be inspected")),
    }
}

fn read_bounded_regular_file(
    path: &Path,
    max_bytes: u64,
    known_signature: Option<FileSignature>,
) -> Result<(Option<Vec<u8>>, FileSignature), CacheReadError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(CacheReadError::Missing);
        }
        Err(_) => return Err(CacheReadError::Unsafe),
    };
    let initial = file.metadata().map_err(|_| CacheReadError::Unsafe)?;
    if !initial.is_file() {
        return Err(CacheReadError::Unsafe);
    }
    if initial.len() > max_bytes {
        return Err(CacheReadError::TooLarge);
    }
    let initial_signature = signature(&initial);
    let payload = if known_signature == Some(initial_signature) {
        None
    } else {
        let mut payload = Vec::with_capacity(initial.len() as usize);
        (&mut file)
            .take(max_bytes + 1)
            .read_to_end(&mut payload)
            .map_err(|_| CacheReadError::Unsafe)?;
        if payload.len() as u64 > max_bytes {
            return Err(CacheReadError::TooLarge);
        }
        Some(payload)
    };
    let final_metadata = file.metadata().map_err(|_| CacheReadError::Unsafe)?;
    let final_signature = signature(&final_metadata);
    if !final_metadata.is_file()
        || final_signature != initial_signature
        || payload
            .as_ref()
            .is_some_and(|payload| payload.len() as u64 != final_metadata.len())
    {
        return Err(CacheReadError::Changed);
    }
    let path_metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            CacheReadError::Changed
        } else {
            CacheReadError::Unsafe
        }
    })?;
    if !path_metadata.is_file() || signature(&path_metadata) != final_signature {
        return Err(CacheReadError::Changed);
    }
    Ok((payload, final_signature))
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn safe_steam_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    let password = url.password().unwrap_or_default();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || !password.is_empty()
        || !matches!(url.port(), None | Some(443))
        || !(host == "steamcommunity.com" || host.ends_with(".steamcommunity.com"))
    {
        return None;
    }
    Some(url)
}

fn redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn download(url: &str, timeout: Duration, max_bytes: usize) -> Result<Vec<u8>, GuideError> {
    let mut current = safe_steam_url(url)
        .ok_or_else(|| GuideError::download("Steam returned an unsafe final URL"))?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .https_only(true)
        .timeout_global(Some(timeout))
        .build()
        .into();
    for redirects in 0..=MAX_REDIRECTS {
        let mut response = agent
            .get(current.as_str())
            .header("Accept", "text/html,application/xhtml+xml")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.5")
            .header("User-Agent", "GRIP/1.0 Steam-Deck local guide reader")
            .call()
            .map_err(|_| GuideError::download("Could not download the Steam guide"))?;
        if redirect_status(response.status().as_u16()) {
            if redirects == MAX_REDIRECTS {
                return Err(GuideError::download("Could not download the Steam guide"));
            }
            let location = response
                .headers()
                .get("Location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| GuideError::download("Could not download the Steam guide"))?;
            let redirected = current
                .join(location)
                .ok()
                .and_then(|url| safe_steam_url(url.as_str()))
                .ok_or_else(|| {
                    GuideError::download("Steam redirected the guide to an unsafe URL")
                })?;
            current = redirected;
            continue;
        }
        if safe_steam_url(current.as_str()).is_none() {
            return Err(GuideError::download("Steam returned an unsafe final URL"));
        }
        let mime_type = response
            .body()
            .mime_type()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(mime_type.as_str(), "text/html" | "application/xhtml+xml") {
            return Err(GuideError::download("Steam returned a non-HTML response"));
        }
        if let Some(length) = response.headers().get("Content-Length") {
            let length = length
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| GuideError::download("Steam returned an invalid Content-Length"))?;
            if length > max_bytes as u64 {
                return Err(GuideError::download(
                    "Steam guide exceeds the download size limit",
                ));
            }
        }
        let body = response
            .body_mut()
            .with_config()
            .limit(max_bytes as u64 + 1)
            .read_to_vec()
            .map_err(|error| {
                let message = if matches!(error, ureq::Error::BodyExceedsLimit(_)) {
                    "Steam guide exceeds the download size limit"
                } else {
                    "Could not download the Steam guide"
                };
                GuideError::download(message)
            })?;
        if body.len() > max_bytes {
            return Err(GuideError::download(
                "Steam guide exceeds the download size limit",
            ));
        }
        return Ok(body);
    }
    unreachable!("redirect loop always returns or continues")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_url_policy_matches_the_python_redirect_handler() {
        for safe in [
            "https://steamcommunity.com/a",
            "https://store.steamcommunity.com./a",
            "https://steamcommunity.com:443/a",
        ] {
            assert!(safe_steam_url(safe).is_some(), "{safe}");
        }
        for unsafe_url in [
            "http://steamcommunity.com/a",
            "https://evil.example/a",
            "https://steamcommunity.com.evil.example/a",
            "https://user@steamcommunity.com/a",
            "https://steamcommunity.com:444/a",
        ] {
            assert!(safe_steam_url(unsafe_url).is_none(), "{unsafe_url}");
        }
    }

    #[test]
    fn stale_boundary_is_strict() {
        assert!(!is_stale(CACHE_MAX_AGE_MS, 0));
        assert!(is_stale(CACHE_MAX_AGE_MS + 1, 0));
        assert!(!is_stale(1, 2));
    }
}
