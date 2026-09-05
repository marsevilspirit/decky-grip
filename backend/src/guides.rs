use crate::guide_html::{
    MAX_LABEL_CHARS, MAX_PAGE_NODES, MAX_PAGE_TEXT_CHARS, MAX_SANITIZED_HTML_BYTES, MAX_SECTIONS,
    localize_guide_images, localized_image_urls, parse_guide_html, sanitize_fragment_with_stats,
    source_url as guide_source_url, valid_guide_id,
};
use crate::{
    AtomicReplaceError, FileSignature, KeyLockPool, ReadError, atomic_replace, lock,
    read_bounded_regular_file, signature, sync_directory,
};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::fmt;
use std::fs::{self, FileTimes, OpenOptions};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub const MAX_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CACHE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_DISK_CACHE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_MEMORY_CACHE_BYTES: usize = 32 * 1024 * 1024;
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

struct MemoEntry {
    signature: FileSignature,
    document: Value,
    bytes: usize,
}

#[derive(Default)]
struct MemoState {
    entries: HashMap<String, MemoEntry>,
    order: VecDeque<String>,
    bytes: usize,
}

impl MemoState {
    fn signature(&self, guide_id: &str) -> Option<FileSignature> {
        Some(self.entries.get(guide_id)?.signature)
    }

    fn clone_if_signature(
        &mut self,
        guide_id: &str,
        expected: FileSignature,
        updated: FileSignature,
        promote: bool,
    ) -> Option<Value> {
        let entry = self.entries.get_mut(guide_id)?;
        if entry.signature != expected {
            return None;
        }
        entry.signature = updated;
        let document = entry.document.clone();
        if promote {
            self.touch(guide_id);
        }
        Some(document)
    }

    fn store(&mut self, guide_id: &str, entry: MemoEntry, limit: usize) {
        self.remove(guide_id);
        if limit == 0 || entry.bytes > limit {
            return;
        }
        self.bytes = self.bytes.saturating_add(entry.bytes);
        self.entries.insert(guide_id.to_owned(), entry);
        self.order.push_back(guide_id.to_owned());
        while self.bytes > limit {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.bytes);
            }
        }
    }

    fn remove(&mut self, guide_id: &str) {
        if let Some(removed) = self.entries.remove(guide_id) {
            self.bytes = self.bytes.saturating_sub(removed.bytes);
        }
        if let Some(index) = self.order.iter().position(|entry| entry == guide_id) {
            self.order.remove(index);
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.bytes = 0;
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn touch(&mut self, guide_id: &str) {
        // ponytail: O(n) over a byte-bounded cache; use an intrusive list only if profiling says so.
        if let Some(index) = self.order.iter().position(|entry| entry == guide_id) {
            self.order.remove(index);
        }
        self.order.push_back(guide_id.to_owned());
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuideLimits {
    pub max_disk_bytes: usize,
    pub max_memory_bytes: usize,
}

impl Default for GuideLimits {
    fn default() -> Self {
        Self {
            max_disk_bytes: MAX_DISK_CACHE_BYTES,
            max_memory_bytes: MAX_MEMORY_CACHE_BYTES,
        }
    }
}

pub struct GuideReader {
    cache_directory: PathBuf,
    fetcher: Arc<Fetcher>,
    now_ms: Arc<Clock>,
    limits: GuideLimits,
    guide_locks: KeyLockPool,
    memo: Mutex<MemoState>,
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
        Self::with_fetcher_and_limits(cache_directory, fetcher, now_ms, GuideLimits::default())
    }

    pub fn with_fetcher_and_limits<F, N>(
        cache_directory: impl Into<PathBuf>,
        fetcher: F,
        now_ms: N,
        limits: GuideLimits,
    ) -> Self
    where
        F: Fn(&str, Duration, usize) -> Result<Vec<u8>, GuideError> + Send + Sync + 'static,
        N: Fn() -> u64 + Send + Sync + 'static,
    {
        let reader = Self {
            cache_directory: cache_directory.into(),
            fetcher: Arc::new(fetcher),
            now_ms: Arc::new(now_ms),
            limits,
            guide_locks: KeyLockPool::default(),
            memo: Mutex::new(MemoState::default()),
            disk_lock: Mutex::new(()),
            generation: Mutex::new(0),
        };
        {
            let _disk = lock(&reader.disk_lock);
            reader.prune_to_quota_locked(None);
        }
        reader
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
        let Some(document) = self.read_cache_without_memoizing(guide_id)? else {
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
        self.remove_cached_guide(guide_id, None)
    }

    pub fn remove_offline_guide(
        &self,
        guide_id: &str,
        images: &crate::guide_images::GuideImageCache,
    ) -> Result<Value, GuideError> {
        self.remove_cached_guide(guide_id, Some(images))
    }

    fn remove_cached_guide(
        &self,
        guide_id: &str,
        images: Option<&crate::guide_images::GuideImageCache>,
    ) -> Result<Value, GuideError> {
        validate_guide_id(guide_id)?;
        let guide_lock = self.guide_locks.retain(guide_id);
        let result = {
            let _guide = lock(&guide_lock);
            (|| {
                let _disk = lock(&self.disk_lock);
                let mut removed_images = json!({"filesRemoved": 0, "bytesRemoved": 0});
                if let Some(images) = images {
                    let mut urls = HashSet::new();
                    let mut shared = HashSet::new();
                    // Hold the body-cache lock until deletion finishes, so a refresh cannot
                    // add a new shared reference between inspection and image removal.
                    for entry in self.managed_entries_locked()? {
                        let document = self
                            .read_cache_without_memoizing(&entry.guide_id)?
                            .ok_or_else(|| GuideError::cache("指南缓存已变化，请重试删除"))?;
                        for section in document["sections"].as_array().expect("validated sections")
                        {
                            let localized = localize_guide_images(
                                section["html"].as_str().expect("validated HTML"),
                            );
                            let references = localized_image_urls(&localized).map_err(|_| {
                                GuideError::cache("无法确认共享图片，未删除离线内容")
                            })?;
                            if entry.guide_id == guide_id {
                                urls.extend(references);
                            } else {
                                shared.extend(references);
                            }
                        }
                    }
                    urls.retain(|url| !shared.contains(url));
                    removed_images = images
                        .remove_urls(&urls)
                        .map_err(|error| GuideError::cache(error.message()))?;
                }
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
                    "bytesRemoved": bytes_removed + removed_images["bytesRemoved"].as_u64().unwrap_or(0),
                    "filesRemoved": files_removed + removed_images["filesRemoved"].as_u64().unwrap_or(0),
                }))
            })()
        };
        self.guide_locks.release(guide_id, &guide_lock);
        result
    }

    pub fn cache_stats(&self) -> Result<Value, GuideError> {
        let entries = {
            let _disk = lock(&self.disk_lock);
            self.managed_entries_locked()?
        };
        let memo = lock(&self.memo);
        Ok(json!({
            "bytes": entries.iter().map(|entry| entry.size).sum::<u64>(),
            "diskLimitBytes": self.limits.max_disk_bytes as u64,
            "files": entries.len() as u64,
            "memoryBytes": memo.bytes as u64,
            "memoryEntries": memo.entries.len() as u64,
            "memoryLimitBytes": self.limits.max_memory_bytes as u64,
        }))
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
        self.read_cache_with_memo(guide_id, true)
    }

    fn read_cache_without_memoizing(&self, guide_id: &str) -> Result<Option<Value>, GuideError> {
        self.read_cache_with_memo(guide_id, false)
    }

    fn read_cache_with_memo(
        &self,
        guide_id: &str,
        memoize: bool,
    ) -> Result<Option<Value>, GuideError> {
        let path = self.cache_path(guide_id);
        for attempt in 0..2 {
            let known = lock(&self.memo).signature(guide_id);
            let (payload, signature) =
                match read_bounded_regular_file(&path, MAX_CACHE_BYTES, known) {
                    Ok(value) => value,
                    Err(ReadError::Missing) => {
                        lock(&self.memo).remove(guide_id);
                        return Ok(None);
                    }
                    Err(ReadError::TooLarge) => {
                        lock(&self.memo).remove(guide_id);
                        return Err(GuideError::cache("cached guide exceeds the size limit"));
                    }
                    Err(ReadError::Changed) => {
                        lock(&self.memo).remove(guide_id);
                        if attempt == 0 {
                            continue;
                        }
                        return Err(GuideError::cache("cached guide changed while being read"));
                    }
                    Err(ReadError::Unsafe) => {
                        lock(&self.memo).remove(guide_id);
                        return Err(GuideError::cache("cached guide could not be read safely"));
                    }
                };
            if payload.is_none() {
                let expected = known.expect("matching signature requires a memo entry");
                let touched = if memoize {
                    self.touch_cache_file(&path, signature).unwrap_or(signature)
                } else {
                    signature
                };
                if let Some(document) =
                    lock(&self.memo).clone_if_signature(guide_id, expected, touched, memoize)
                {
                    return Ok(Some(document));
                }
                if attempt == 0 {
                    continue;
                }
                return Err(GuideError::cache("cached guide changed while being read"));
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
            if memoize {
                let touched = self.touch_cache_file(&path, signature).unwrap_or(signature);
                lock(&self.memo).store(
                    guide_id,
                    MemoEntry {
                        signature: touched,
                        document: document.clone(),
                        bytes: payload.as_ref().unwrap().len(),
                    },
                    self.limits.max_memory_bytes,
                );
            }
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

    fn touch_cache_file(&self, path: &Path, expected: FileSignature) -> Option<FileSignature> {
        let _disk = lock(&self.disk_lock);
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
            .ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || signature(&metadata) != expected {
            return None;
        }
        let now = SystemTime::now();
        file.set_times(FileTimes::new().set_accessed(now).set_modified(now))
            .ok()?;
        let touched = file.metadata().ok()?;
        (touched.is_file() && touched.dev() == metadata.dev() && touched.ino() == metadata.ino())
            .then(|| signature(&touched))
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
        let cache_path = self.cache_path(
            document["guideId"]
                .as_str()
                .expect("validated document has a guide id"),
        );
        match atomic_replace(&cache_path, ".guide-", ".tmp", &payload) {
            Ok(()) => {}
            Err(AtomicReplaceError::Prepare) => {
                return Err(GuideError::cache("could not create a guide cache file"));
            }
            Err(AtomicReplaceError::Replace) => {
                return Err(GuideError::cache(
                    "could not atomically replace guide cache",
                ));
            }
            Err(AtomicReplaceError::Durability) => {
                return Err(GuideError::cache(
                    "guide cache was replaced but its directory could not be synced",
                ));
            }
        }
        match fs::symlink_metadata(&cache_path) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_CACHE_BYTES => {
                lock(&self.memo).store(
                    document["guideId"].as_str().unwrap(),
                    MemoEntry {
                        signature: signature(&metadata),
                        document: document.clone(),
                        bytes: payload.len(),
                    },
                    self.limits.max_memory_bytes,
                );
            }
            _ => {
                lock(&self.memo).remove(document["guideId"].as_str().unwrap());
            }
        }
        self.prune_to_quota_locked(document["guideId"].as_str());
        Ok(())
    }

    fn managed_entries_locked(&self) -> Result<Vec<GuideDiskEntry>, GuideError> {
        let mut managed = Vec::new();
        let Some(entries) = read_cache_directory(&self.cache_directory)? else {
            return Ok(managed);
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(guide_id) = name.strip_suffix(".json").filter(|id| valid_guide_id(id)) else {
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.is_file() {
                managed.push(GuideDiskEntry {
                    guide_id: guide_id.to_owned(),
                    path: entry.path(),
                    size: metadata.len(),
                    modified_seconds: metadata.mtime(),
                    modified_nanoseconds: metadata.mtime_nsec(),
                });
            }
        }
        Ok(managed)
    }

    fn prune_to_quota_locked(&self, protected: Option<&str>) {
        let Ok(mut entries) = self.managed_entries_locked() else {
            return;
        };
        entries.sort_by(|left, right| {
            (left.modified_seconds, left.modified_nanoseconds, &left.path).cmp(&(
                right.modified_seconds,
                right.modified_nanoseconds,
                &right.path,
            ))
        });
        let mut total = entries.iter().map(|entry| entry.size).sum::<u64>();
        while total > self.limits.max_disk_bytes as u64 && !entries.is_empty() {
            let index = entries
                .iter()
                .position(|entry| Some(entry.guide_id.as_str()) != protected)
                .unwrap_or(0);
            let entry = entries.remove(index);
            if fs::remove_file(&entry.path).is_ok() {
                total = total.saturating_sub(entry.size);
                lock(&self.memo).remove(&entry.guide_id);
            }
        }
        let _ = sync_directory(&self.cache_directory);
    }
}

#[derive(Debug)]
struct GuideDiskEntry {
    guide_id: String,
    path: PathBuf,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
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
    use crate::test_support::TestDirectory;

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

    #[test]
    fn memo_is_a_byte_bounded_lru_and_does_not_restore_cleared_entries() {
        let entry = |bytes| MemoEntry {
            signature: FileSignature {
                device: 0,
                inode: 0,
                size: bytes as u64,
                modified_seconds: 0,
                modified_nanoseconds: 0,
                changed_seconds: 0,
                changed_nanoseconds: 0,
            },
            document: json!({"bytes": bytes}),
            bytes,
        };
        let mut memo = MemoState::default();
        memo.store("1", entry(4), 8);
        memo.store("2", entry(4), 8);
        let first_signature = memo.signature("1").unwrap();
        assert!(
            memo.clone_if_signature("1", first_signature, first_signature, true)
                .is_some()
        );

        memo.store("3", entry(4), 8);

        assert!(memo.entries.contains_key("1"));
        assert!(!memo.entries.contains_key("2"));
        assert!(memo.entries.contains_key("3"));
        assert_eq!(memo.bytes, 8);

        memo.clear();
        assert!(
            memo.clone_if_signature("1", first_signature, first_signature, true)
                .is_none()
        );
        assert!(memo.is_empty());
    }

    #[test]
    fn cached_summary_validates_without_retaining_the_document() {
        let directory = TestDirectory::new("guides");
        let cache_directory = directory.path();
        fs::create_dir(&cache_directory).unwrap();
        let path = cache_directory.join("1.json");
        let mut document = json!({
            "author": "author",
            "fetchedAt": 1,
            "guideId": "1",
            "schemaVersion": 1,
            "sections": [{"html": "<p>body</p>", "id": "2", "title": "section"}],
            "sourceUrl": "https://steamcommunity.com/sharedfiles/filedetails/?id=1&l=schinese",
            "title": "title",
        });
        fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let reader = GuideReader::with_fetcher(cache_directory, |_, _, _| unreachable!(), || 1);

        assert!(reader.cached_summary("1", Some("2")).unwrap().is_some());
        assert!(lock(&reader.memo).is_empty());

        document["sections"][0]["html"] = json!("<script>unsafe</script>");
        fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(reader.cached_summary("1", None).is_err());
        assert!(lock(&reader.memo).is_empty());
    }
}
