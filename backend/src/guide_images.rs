use crate::{
    FileSignature, KeyLockPool, atomic_replace, lock, read_bounded_regular_file, signature,
};
use base64::Engine as _;
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::fmt;
use std::fs::{self, File, FileTimes, OpenOptions};
use std::io::{self, Cursor, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use url::Url;

pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DISK_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_MEMORY_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_IMAGE_DIMENSION: u32 = 8_192;
pub const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_DECODE_BYTES: u64 = MAX_IMAGE_PIXELS * 8; // RGBA16, allocated only while validating.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

const MAX_URL_BYTES: usize = 4_096;
const MAX_REDIRECTS: usize = 10;
const IMAGE_TYPES: [(&str, &str); 4] = [
    ("image/gif", "gif"),
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/webp", "webp"),
];
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

type Fetcher = dyn Fn(&str, Duration, usize) -> Result<(String, Vec<u8>), ImageError> + Send + Sync;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageErrorKind {
    Validation,
    Download,
    Capacity,
}

#[derive(Debug)]
pub struct ImageError {
    kind: ImageErrorKind,
    message: String,
}

impl ImageError {
    fn new(kind: ImageErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::new(ImageErrorKind::Validation, message)
    }

    pub fn download(message: impl Into<String>) -> Self {
        Self::new(ImageErrorKind::Download, message)
    }

    pub fn kind(&self) -> ImageErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ImageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ImageError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageLimits {
    pub max_image_bytes: usize,
    pub max_disk_bytes: usize,
    pub max_memory_bytes: usize,
}

impl Default for ImageLimits {
    fn default() -> Self {
        Self {
            max_image_bytes: MAX_IMAGE_BYTES,
            max_disk_bytes: MAX_DISK_BYTES,
            max_memory_bytes: MAX_MEMORY_BYTES,
        }
    }
}

#[derive(Clone)]
struct ImageData {
    mime_type: String,
    body: Vec<u8>,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy)]
struct ValidatedImage {
    signature: FileSignature,
    width: u32,
    height: u32,
}

#[derive(Default)]
struct MemoryState {
    entries: HashMap<String, ImageData>,
    order: VecDeque<String>,
    bytes: usize,
    generation: u64,
    clearing: bool,
}

impl MemoryState {
    fn get(&mut self, url: &str) -> Option<ImageData> {
        let value = self.entries.get(url)?.clone();
        self.touch(url);
        Some(value)
    }

    fn touch(&mut self, url: &str) {
        if let Some(index) = self.order.iter().position(|candidate| candidate == url) {
            self.order.remove(index);
        }
        self.order.push_back(url.to_owned());
    }

    fn store(&mut self, url: &str, value: ImageData, limit: usize) {
        if let Some(old) = self.entries.remove(url) {
            self.bytes = self.bytes.saturating_sub(old.body.len());
            if let Some(index) = self.order.iter().position(|candidate| candidate == url) {
                self.order.remove(index);
            }
        }
        if limit == 0 || value.body.len() > limit {
            return;
        }
        self.bytes = self.bytes.saturating_add(value.body.len());
        self.entries.insert(url.to_owned(), value);
        self.order.push_back(url.to_owned());
        while self.bytes > limit {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.body.len());
            }
        }
    }

    fn clear_memory(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

pub struct GuideImageCache {
    cache_directory: PathBuf,
    fetcher: Arc<Fetcher>,
    limits: ImageLimits,
    key_locks: KeyLockPool,
    disk_lock: Mutex<()>,
    state: Mutex<MemoryState>,
    validated: Mutex<HashMap<PathBuf, ValidatedImage>>,
    disk_limit: AtomicU64,
    #[cfg(test)]
    validation_reads: AtomicU64,
    #[cfg(test)]
    validation_decodes: AtomicU64,
}

pub(crate) enum OrphanImages {
    RetryCache,
    OfflineOnly,
    All,
}

impl GuideImageCache {
    pub fn new(cache_directory: impl Into<PathBuf>) -> Self {
        Self::build(
            cache_directory.into(),
            Arc::new(download),
            ImageLimits::default(),
        )
    }

    pub fn with_fetcher<F>(
        cache_directory: impl Into<PathBuf>,
        fetcher: F,
        limits: ImageLimits,
    ) -> Result<Self, ImageError>
    where
        F: Fn(&str, Duration, usize) -> Result<(String, Vec<u8>), ImageError>
            + Send
            + Sync
            + 'static,
    {
        if limits.max_image_bytes == 0 {
            return Err(ImageError::validation("max_image_bytes must be positive"));
        }
        Ok(Self::build(
            cache_directory.into(),
            Arc::new(fetcher),
            limits,
        ))
    }

    fn build(cache_directory: PathBuf, fetcher: Arc<Fetcher>, limits: ImageLimits) -> Self {
        let disk_limit = read_bounded_regular_file(&cache_directory.join("quota.json"), 128, None)
            .ok()
            .and_then(|(body, _)| serde_json::from_slice::<u64>(&body?).ok())
            .filter(|bytes| valid_disk_limit(*bytes))
            .unwrap_or(limits.max_disk_bytes as u64);
        let cache = Self {
            cache_directory,
            fetcher,
            limits,
            key_locks: KeyLockPool::default(),
            disk_lock: Mutex::new(()),
            state: Mutex::new(MemoryState::default()),
            validated: Mutex::new(HashMap::new()),
            disk_limit: AtomicU64::new(disk_limit),
            #[cfg(test)]
            validation_reads: AtomicU64::new(0),
            #[cfg(test)]
            validation_decodes: AtomicU64::new(0),
        };
        {
            let _disk = lock(&cache.disk_lock);
            cache.prune_to_quota_locked();
        }
        cache
    }

    pub fn get(&self, url: &str, allow_download: bool) -> Result<Option<Value>, ImageError> {
        self.resolve(url, allow_download, false)
    }

    /// Explicit downloads must reach disk and must not be evicted by ordinary reading.
    pub fn download(&self, url: &str) -> Result<bool, ImageError> {
        Ok(self.resolve(url, true, true)?.is_some())
    }

    /// Only validated, pinned disk files count as complete offline downloads.
    pub fn is_downloaded(&self, url: &str) -> Result<bool, ImageError> {
        let url = canonical_image_url(url)?;
        let _disk = lock(&self.disk_lock);
        Ok(self.is_downloaded_locked(&url))
    }

    /// Keep checked images on disk until the caller publishes the corresponding body.
    pub(crate) fn downloaded_guard(
        &self,
        urls: &std::collections::HashSet<String>,
    ) -> Result<MutexGuard<'_, ()>, ImageError> {
        let guard = lock(&self.disk_lock);
        for url in urls {
            if !self.is_downloaded_locked(&canonical_image_url(url)?) {
                return Err(ImageError::download("图片尚未完整离线，未替换原指南"));
            }
        }
        Ok(guard)
    }

    fn is_downloaded_locked(&self, url: &str) -> bool {
        if !safe_directory(&self.cache_directory) {
            return false;
        }
        for (mime, path) in self.candidate_paths(url) {
            if !offline_path(&path) {
                continue;
            }
            let known = lock(&self.validated).get(&path).copied();
            if let Ok((body, signature)) = read_bounded_regular_file(
                &path,
                self.limits.max_image_bytes as u64,
                known.map(|value| value.signature),
            ) {
                #[cfg(test)]
                if body.is_some() {
                    self.validation_reads.fetch_add(1, Ordering::Relaxed);
                }
                if body.is_none() {
                    return true;
                }
                if let Ok(value) = self.validate(mime, body.unwrap()) {
                    self.remember_validation(path, signature, &value);
                    return true;
                }
            }
            lock(&self.validated).remove(&path);
        }
        false
    }

    fn remember_validation(&self, path: PathBuf, signature: FileSignature, value: &ImageData) {
        let mut validated = lock(&self.validated);
        // ponytail: bounded metadata memo; replace with LRU only if 4096 entries thrash.
        if validated.len() >= 4096 {
            validated.clear();
        }
        validated.insert(
            path,
            ValidatedImage {
                signature,
                width: value.width,
                height: value.height,
            },
        );
    }

    fn validate(&self, mime: &str, body: Vec<u8>) -> Result<ImageData, ImageError> {
        #[cfg(test)]
        self.validation_decodes.fetch_add(1, Ordering::Relaxed);
        validate_image(mime, body, self.limits.max_image_bytes)
    }

    pub fn set_disk_limit(&self, bytes: u64) -> Result<Value, ImageError> {
        if !valid_disk_limit(bytes) {
            return Err(ImageError::validation("图片额度需在 64 MiB 到 8 GiB 之间"));
        }
        {
            let _disk = lock(&self.disk_lock);
            let pinned = self
                .managed_entries_locked()
                .iter()
                .filter(|entry| offline_path(&entry.path))
                .map(|entry| entry.size)
                .sum::<u64>();
            if pinned > bytes {
                return Err(ImageError::download(
                    "新额度小于已下载图片用量，请先删除不需要的指南",
                ));
            }
            ensure_private_directory(&self.cache_directory)
                .map_err(|_| ImageError::download("无法保存图片额度：缓存目录不可写"))?;
            atomic_replace(
                &self.cache_directory.join("quota.json"),
                ".quota-",
                ".tmp",
                bytes.to_string().as_bytes(),
            )
            .map_err(|_| ImageError::download("图片额度保存失败，请重试"))?;
            self.disk_limit.store(bytes, Ordering::Relaxed);
            self.prune_to_quota_locked();
        }
        Ok(self.stats())
    }

    /// The caller holds the body/staging locks and includes every live and pending guide.
    pub(crate) fn reclaim_unreferenced(
        &self,
        retained: &HashSet<String>,
        policy: OrphanImages,
    ) -> Result<Value, ImageError> {
        let retained = retained
            .iter()
            .map(|url| canonical_image_url(url))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .flat_map(|url| self.candidate_paths(url))
            .map(|(_, path)| path)
            .collect::<HashSet<_>>();
        let _disk = lock(&self.disk_lock);
        let mut files = 0;
        let mut bytes = 0;
        if !safe_directory(&self.cache_directory) && self.cache_directory.exists() {
            return Err(ImageError::download("图片目录异常，未删除离线内容"));
        }
        if safe_directory(&self.cache_directory) {
            for entry in self.managed_entries_locked() {
                if retained.contains(&entry.path)
                    || (!offline_path(&entry.path) && !matches!(policy, OrphanImages::All))
                {
                    continue;
                }
                if matches!(policy, OrphanImages::RetryCache) {
                    // Keep canceled work reusable, but no longer permanently reserve offline quota.
                    let name = entry.path.file_name().unwrap().to_str().unwrap();
                    fs::rename(
                        &entry.path,
                        self.cache_directory.join(&name["offline-".len()..]),
                    )
                    .map_err(|_| ImageError::download("未能释放未完成下载的离线额度"))?;
                } else {
                    fs::remove_file(&entry.path)
                        .map_err(|_| ImageError::download("图片删除失败，请检查目录权限"))?;
                    files += 1;
                    bytes += entry.size;
                }
                lock(&self.validated).remove(&entry.path);
            }
            let mut state = lock(&self.state);
            let removed = state
                .entries
                .keys()
                .filter(|url| {
                    !self
                        .candidate_paths(url)
                        .iter()
                        .any(|(_, path)| retained.contains(path))
                })
                .cloned()
                .collect::<Vec<_>>();
            for url in removed {
                if let Some(value) = state.entries.remove(&url) {
                    state.bytes -= value.body.len();
                }
                state.order.retain(|entry| entry != &url);
            }
            drop(state);
            // Do not bump the global generation: unrelated pending downloads remain valid.
            self.prune_to_quota_locked();
            sync_directory(&self.cache_directory)
                .map_err(|_| ImageError::download("图片已删除，但目录同步失败"))?;
        }
        Ok(json!({"filesRemoved": files, "bytesRemoved": bytes}))
    }

    fn resolve(
        &self,
        url: &str,
        allow_download: bool,
        offline: bool,
    ) -> Result<Option<Value>, ImageError> {
        let normalized_url = canonical_image_url(url)?;
        let key_lock = self.key_locks.retain(&normalized_url);
        let result = {
            let _key = lock(&key_lock);
            self.get_locked(&normalized_url, allow_download, offline)
        };
        self.key_locks.release(&normalized_url, &key_lock);
        result
    }

    fn get_locked(
        &self,
        url: &str,
        allow_download: bool,
        offline: bool,
    ) -> Result<Option<Value>, ImageError> {
        let generation = lock(&self.state).generation;
        if offline && self.is_downloaded(url)? {
            return Ok(Some(json!(true)));
        }
        let cached = lock(&self.state).get(url);
        let cached = cached.or_else(|| self.read_disk(url, false));
        let from_cache = cached.is_some();
        let value = match cached {
            Some(value) => value,
            None if !allow_download => return Ok(None),
            None => match (self.fetcher)(url, REQUEST_TIMEOUT, self.limits.max_image_bytes)
                .and_then(|(mime, body)| self.validate(&mime, body))
            {
                Ok(value) => value,
                Err(error) if offline => return Err(error),
                Err(_) => return Ok(None),
            },
        };
        if offline || !from_cache {
            let saved = self.write_disk(url, &value, generation, offline);
            let saved = if offline {
                saved?
            } else {
                saved.unwrap_or(false)
            };
            if offline && !saved {
                return Err(ImageError::download(
                    "图片未能保存到本机：缓存正在清理，请稍后重试",
                ));
            }
        }
        self.store_memory_if_current(url, value.clone(), generation);
        Ok(Some(if offline {
            json!(true)
        } else {
            response(&value, from_cache)
        }))
    }

    pub fn clear(&self) -> Value {
        {
            let mut state = lock(&self.state);
            state.generation = state.generation.wrapping_add(1);
            state.clearing = true;
            state.clear_memory();
        }

        let mut files_removed = 0_u64;
        let mut bytes_removed = 0_u64;
        {
            let _disk = lock(&self.disk_lock);
            lock(&self.validated).clear();
            for entry in self.managed_entries_locked() {
                if fs::remove_file(&entry.path).is_ok() {
                    files_removed += 1;
                    bytes_removed = bytes_removed.saturating_add(entry.size);
                }
            }
        }

        {
            let mut state = lock(&self.state);
            state.clear_memory();
            state.clearing = false;
        }
        json!({
            "bytesRemoved": bytes_removed,
            "filesRemoved": files_removed,
        })
    }

    pub fn stats(&self) -> Value {
        let (memory_entries, memory_bytes) = {
            let state = lock(&self.state);
            (state.entries.len() as u64, state.bytes as u64)
        };
        let entries = {
            let _disk = lock(&self.disk_lock);
            self.managed_entries_locked()
        };
        json!({
            "diskBytes": entries.iter().map(|entry| entry.size).sum::<u64>(),
            "diskLimitBytes": self.disk_limit.load(Ordering::Relaxed),
            "offlineBytes": entries.iter().filter(|entry| offline_path(&entry.path)).map(|entry| entry.size).sum::<u64>(),
            "files": entries.len() as u64,
            "memoryBytes": memory_bytes,
            "memoryEntries": memory_entries,
            "memoryLimitBytes": self.limits.max_memory_bytes as u64,
        })
    }

    fn store_memory_if_current(&self, url: &str, value: ImageData, generation: u64) {
        let mut state = lock(&self.state);
        if state.generation == generation && !state.clearing {
            state.store(url, value, self.limits.max_memory_bytes);
        }
    }

    fn candidate_paths(&self, url: &str) -> Vec<(&'static str, PathBuf)> {
        let digest = cache_digest(url);
        IMAGE_TYPES
            .iter()
            .flat_map(|(mime_type, extension)| {
                ["offline-", ""].map(|prefix| {
                    (
                        *mime_type,
                        self.cache_directory
                            .join(format!("{prefix}{digest}.{extension}")),
                    )
                })
            })
            .collect()
    }

    fn read_disk(&self, url: &str, offline_only: bool) -> Option<ImageData> {
        let _disk = lock(&self.disk_lock);
        if !safe_directory(&self.cache_directory) {
            return None;
        }
        for (mime_type, path) in self.candidate_paths(url) {
            if offline_only && !offline_path(&path) {
                continue;
            }
            if let Some(value) = self.read_candidate_locked(&path, mime_type) {
                return Some(value);
            }
        }
        None
    }

    fn read_candidate_locked(&self, path: &Path, mime_type: &str) -> Option<ImageData> {
        let result = (|| -> io::Result<ImageData> {
            let (body, read_signature) =
                read_bounded_regular_file(path, self.limits.max_image_bytes as u64, None)
                    .map_err(|_| io::Error::other("invalid cached image file"))?;
            let body = body.expect("reading without a known signature returns bytes");
            let known = lock(&self.validated).get(path).copied();
            let value = if let Some(known) = known.filter(|value| value.signature == read_signature)
            {
                ImageData {
                    mime_type: mime_type.to_owned(),
                    body,
                    width: known.width,
                    height: known.height,
                }
            } else {
                self.validate(mime_type, body)
                    .map_err(|_| io::Error::other("invalid cached image content"))?
            };
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open(path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || signature(&metadata) != read_signature {
                return Err(io::Error::other("cached image changed while being read"));
            }
            let now = SystemTime::now();
            let _ = file.set_times(FileTimes::new().set_accessed(now).set_modified(now));
            self.remember_validation(path.to_owned(), signature(&file.metadata()?), &value);
            Ok(value)
        })();
        match result {
            Ok(value) => Some(value),
            Err(_) => {
                lock(&self.validated).remove(path);
                let _ = fs::remove_file(path);
                None
            }
        }
    }

    fn write_disk(
        &self,
        url: &str,
        value: &ImageData,
        generation: u64,
        offline: bool,
    ) -> Result<bool, ImageError> {
        let capacity_error = || {
            ImageError::new(
                ImageErrorKind::Capacity,
                "图片离线额度已满，请在 GRIP 高级选项中增加额度或删除不需要的指南",
            )
        };
        if value.body.len() as u64 > self.disk_limit.load(Ordering::Relaxed) {
            return Err(capacity_error());
        }
        let digest = cache_digest(url);
        let extension = extension_for_mime(&value.mime_type).unwrap();
        let prefix = if offline { "offline-" } else { "" };
        let target = self
            .cache_directory
            .join(format!("{prefix}{digest}.{extension}"));
        let replacing = self
            .candidate_paths(url)
            .into_iter()
            .filter_map(|(_, path)| path.file_name().map(|name| name.to_owned()))
            .collect::<Vec<_>>();
        let _disk = lock(&self.disk_lock);
        {
            let state = lock(&self.state);
            if state.generation != generation || state.clearing {
                return Ok(false);
            }
        }
        ensure_private_directory(&self.cache_directory).map_err(image_write_error)?;

        let mut entries = self.managed_entries_locked();
        entries.retain(|entry| {
            entry
                .path
                .file_name()
                .is_none_or(|name| !replacing.iter().any(|candidate| candidate == name))
        });
        entries.sort_by(|left, right| {
            (left.modified_seconds, left.modified_nanoseconds, &left.path).cmp(&(
                right.modified_seconds,
                right.modified_nanoseconds,
                &right.path,
            ))
        });
        let mut total = entries.iter().map(|entry| entry.size).sum::<u64>();
        let wanted = value.body.len() as u64;
        entries.retain(|entry| !offline_path(&entry.path));
        if total
            .saturating_sub(entries.iter().map(|entry| entry.size).sum::<u64>())
            .saturating_add(wanted)
            > self.disk_limit.load(Ordering::Relaxed)
        {
            return Err(capacity_error());
        }
        while total.saturating_add(wanted) > self.disk_limit.load(Ordering::Relaxed) {
            if entries.is_empty() {
                return Err(capacity_error());
            }
            let entry = entries.remove(0);
            if fs::remove_file(&entry.path).is_ok() {
                total = total.saturating_sub(entry.size);
            }
        }

        let (mut temporary, temporary_path) = match create_temporary(&self.cache_directory, &digest)
        {
            Ok(value) => value,
            Err(error) => return Err(image_write_error(error)),
        };
        let written = (|| -> io::Result<()> {
            temporary.write_all(&value.body)?;
            temporary.sync_all()?;
            {
                let state = lock(&self.state);
                if state.generation != generation || state.clearing {
                    return Err(io::Error::other("cache was cleared"));
                }
            }
            fs::rename(&temporary_path, &target)?;
            for (_, candidate) in self.candidate_paths(url) {
                if candidate != target {
                    let _ = fs::remove_file(candidate);
                }
            }
            sync_directory(&self.cache_directory)?;
            self.remember_validation(
                target.clone(),
                signature(&fs::symlink_metadata(&target)?),
                value,
            );
            Ok(())
        })();
        drop(temporary);
        if let Err(error) = written {
            let _ = fs::remove_file(temporary_path);
            return Err(image_write_error(error));
        }
        Ok(true)
    }

    fn managed_entries_locked(&self) -> Vec<DiskEntry> {
        if !safe_directory(&self.cache_directory) {
            return Vec::new();
        }
        let Ok(entries) = fs::read_dir(&self.cache_directory) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                if !managed_cache_name(name) {
                    return None;
                }
                let metadata = fs::symlink_metadata(entry.path()).ok()?;
                if !metadata.is_file() {
                    return None;
                }
                Some(DiskEntry {
                    path: entry.path(),
                    size: metadata.len(),
                    modified_seconds: metadata.mtime(),
                    modified_nanoseconds: metadata.mtime_nsec(),
                })
            })
            .collect()
    }

    fn prune_to_quota_locked(&self) {
        let mut entries = self.managed_entries_locked();
        entries.sort_by(|left, right| {
            (left.modified_seconds, left.modified_nanoseconds, &left.path).cmp(&(
                right.modified_seconds,
                right.modified_nanoseconds,
                &right.path,
            ))
        });
        let mut total = entries.iter().map(|entry| entry.size).sum::<u64>();
        let mut retained = Vec::with_capacity(entries.len());
        for entry in entries {
            if entry.size > self.limits.max_image_bytes as u64
                && fs::remove_file(&entry.path).is_ok()
            {
                total = total.saturating_sub(entry.size);
                continue;
            }
            if !offline_path(&entry.path) {
                retained.push(entry);
            }
        }
        while total > self.disk_limit.load(Ordering::Relaxed) && !retained.is_empty() {
            let entry = retained.remove(0);
            if fs::remove_file(&entry.path).is_ok() {
                total = total.saturating_sub(entry.size);
            }
        }
        self.remove_temporary_files_locked();
    }

    fn remove_temporary_files_locked(&self) {
        if !safe_directory(&self.cache_directory) {
            return;
        }
        let Ok(entries) = fs::read_dir(&self.cache_directory) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !managed_temporary_name(name) {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.is_file() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn valid_disk_limit(bytes: u64) -> bool {
    (64 * 1024 * 1024..=8 * 1024 * 1024 * 1024).contains(&bytes)
}

fn image_write_error(error: io::Error) -> ImageError {
    if matches!(error.raw_os_error(), Some(libc::ENOSPC | libc::EDQUOT)) {
        ImageError::new(
            ImageErrorKind::Capacity,
            "设备磁盘空间不足，请先释放存储空间",
        )
    } else {
        ImageError::download("图片保存失败：磁盘不可写或文件同步失败，请重试")
    }
}

#[derive(Debug)]
struct DiskEntry {
    path: PathBuf,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
}

pub fn canonical_image_url(value: &str) -> Result<String, ImageError> {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value.bytes().any(|byte| {
            !(0x21..=0x7e).contains(&byte)
                || matches!(
                    byte,
                    b'<' | b'>' | b'"' | b'{' | b'}' | b'|' | b'\\' | b'^' | b'`'
                )
        })
    {
        return Err(ImageError::validation("image URL is invalid"));
    }
    let value = match value.strip_suffix('#') {
        Some(without_fragment) if !without_fragment.contains('#') => without_fragment,
        _ if value.contains('#') => {
            return Err(ImageError::validation(
                "image URL is not an allowed Steam image URL",
            ));
        }
        _ => value,
    };
    let parsed = Url::parse(value).map_err(|_| ImageError::validation("image URL is invalid"))?;
    let scheme_end = value
        .find("://")
        .ok_or_else(|| ImageError::validation("image URL is invalid"))?;
    let authority_start = scheme_end + 3;
    let authority_end = value[authority_start..]
        .find(['/', '?', '#'])
        .map_or(value.len(), |offset| authority_start + offset);
    let authority = &value[authority_start..authority_end];
    let explicit_port = authority.rsplit_once(':').map(|(_, port)| port);
    let host = parsed
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .ok_or_else(|| ImageError::validation("image URL is not an allowed Steam image URL"))?;
    let allowed_host = ["steamstatic.com", "steamusercontent.com"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")));
    let port_valid = explicit_port.is_none_or(|port| {
        !port.is_empty()
            && port.bytes().all(|byte| byte.is_ascii_digit())
            && port.parse::<u16>() == Ok(443)
    });
    if !value[..scheme_end].eq_ignore_ascii_case("https")
        || parsed.scheme() != "https"
        || authority.contains('@')
        || !port_valid
        || !allowed_host
    {
        return Err(ImageError::validation(
            "image URL is not an allowed Steam image URL",
        ));
    }

    let suffix = &value[authority_end..];
    let (path, query) = match suffix.split_once('?') {
        Some((path, "")) => (path, None),
        Some((path, query)) => (path, Some(query)),
        None => (suffix, None),
    };
    let port = if explicit_port.is_some() { ":443" } else { "" };
    let path = if path.is_empty() { "/" } else { path };
    Ok(match query {
        Some(query) => format!("https://{host}{port}{path}?{query}"),
        None => format!("https://{host}{port}{path}"),
    })
}

fn validate_image(
    mime_type: &str,
    body: Vec<u8>,
    max_bytes: usize,
) -> Result<ImageData, ImageError> {
    let mut mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    // Steam's legacy CDN also serves valid raster images as generic binary data.
    if mime_type == "application/octet-stream" {
        mime_type = IMAGE_TYPES
            .iter()
            .find(|(candidate, _)| image_type_matches(candidate, &body))
            .map(|(candidate, _)| (*candidate).to_owned())
            .ok_or_else(|| ImageError::download("Steam returned an unsupported image type"))?;
    }
    if extension_for_mime(&mime_type).is_none() {
        return Err(ImageError::download(
            "Steam returned an unsupported image type",
        ));
    }
    if body.is_empty() || body.len() > max_bytes {
        return Err(ImageError::download(
            "Steam image exceeds the download size limit",
        ));
    }
    if !image_type_matches(&mime_type, &body) {
        return Err(ImageError::download(
            "Steam image content does not match its type",
        ));
    }
    reject_animated_image(&mime_type, &body)?;
    let format = ImageFormat::from_mime_type(&mime_type).expect("validated MIME type");
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(&body), format);
    reader.limits(limits.clone());
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| ImageError::download("Steam returned an invalid image"))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(ImageError::download(
            "Steam image exceeds the decoded pixel limit",
        ));
    }
    let bytes = usize::try_from(decoder.total_bytes())
        .ok()
        .filter(|bytes| *bytes as u64 <= MAX_DECODE_BYTES)
        .ok_or_else(|| ImageError::download("Steam image exceeds the decode memory limit"))?;
    // Account for our output buffer before allowing the decoder its remaining working budget.
    limits
        .reserve(bytes as u64)
        .and_then(|()| decoder.set_limits(limits))
        .map_err(|_| ImageError::download("Steam image exceeds the decode memory limit"))?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(bytes)
        .map_err(|_| ImageError::download("Not enough memory to validate the Steam image"))?;
    pixels.resize(bytes, 0);
    decoder
        .read_image(&mut pixels)
        .map_err(|_| ImageError::download("Steam returned an incomplete or corrupt image"))?;
    Ok(ImageData {
        mime_type,
        body,
        width,
        height,
    })
}

fn image_type_matches(mime_type: &str, body: &[u8]) -> bool {
    match mime_type {
        "image/png" => body.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => body.starts_with(b"\xff\xd8\xff"),
        "image/gif" => body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a"),
        "image/webp" => body.len() >= 12 && body.starts_with(b"RIFF") && &body[8..12] == b"WEBP",
        _ => false,
    }
}

fn reject_animated_image(mime_type: &str, body: &[u8]) -> Result<(), ImageError> {
    let invalid = || ImageError::download("Steam returned an incomplete image container");
    let animated = match mime_type {
        "image/gif" => gif_frame_count(body)? > 1,
        "image/png" | "image/webp" => {
            let png = mime_type == "image/png";
            let body = if png {
                body
            } else {
                let length =
                    u32::from_le_bytes(body.get(4..8).ok_or_else(invalid)?.try_into().unwrap())
                        as usize;
                body.get(..length.checked_add(8).ok_or_else(invalid)?)
                    .filter(|body| body.len() >= 12)
                    .ok_or_else(invalid)?
            };
            let mut cursor = if png { 8 } else { 12 };
            let mut animated = false;
            let mut ended = !png;
            while cursor < body.len() {
                let header = body.get(cursor..cursor + 8).ok_or_else(invalid)?;
                let (kind, length) = if png {
                    (
                        &header[4..8],
                        u32::from_be_bytes(header[..4].try_into().unwrap()) as usize,
                    )
                } else {
                    (
                        &header[..4],
                        u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize,
                    )
                };
                let size = length
                    .checked_add(if png { 12 } else { 8 + length % 2 })
                    .ok_or_else(invalid)?;
                let chunk = body
                    .get(cursor..cursor.checked_add(size).ok_or_else(invalid)?)
                    .ok_or_else(invalid)?;
                animated |= matches!(kind, b"acTL" | b"fcTL" | b"fdAT") && png
                    || !png
                        && (matches!(kind, b"ANIM" | b"ANMF")
                            || kind == b"VP8X" && length > 0 && chunk[8] & 0x02 != 0);
                cursor += size;
                if png && kind == b"IEND" {
                    ended = length == 0;
                    break;
                }
            }
            if !ended {
                return Err(invalid());
            }
            animated
        }
        "image/jpeg" if !jpeg_has_end(body) => return Err(invalid()),
        _ => false,
    };
    if animated {
        Err(ImageError::download(
            "animated Steam guide images are not supported",
        ))
    } else {
        Ok(())
    }
}

fn jpeg_has_end(body: &[u8]) -> bool {
    // image's JPEG decoder tolerates missing EOI. Require a real marker, not bytes inside EXIF,
    // while allowing trailing data after EOI just like browsers and the other supported formats.
    let mut cursor = 2;
    while cursor < body.len() {
        if body[cursor] != 0xff {
            cursor += 1; // Entropy-coded data following SOS.
            continue;
        }
        while body.get(cursor) == Some(&0xff) {
            cursor += 1;
        }
        let Some(&marker) = body.get(cursor) else {
            return false;
        };
        cursor += 1;
        match marker {
            0xd9 => return true,
            0x00 | 0x01 | 0xd0..=0xd7 => continue, // Stuffed bytes, TEM, restart markers.
            _ => {
                let Some(length) = body.get(cursor..cursor + 2) else {
                    return false;
                };
                let length = u16::from_be_bytes(length.try_into().unwrap()) as usize;
                if length < 2 || cursor + length > body.len() {
                    return false;
                }
                cursor += length;
            }
        }
    }
    false
}

fn gif_frame_count(body: &[u8]) -> Result<usize, ImageError> {
    if body.len() < 13 || !(body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a")) {
        return Err(ImageError::download(
            "Steam returned an invalid GIF structure",
        ));
    }
    let mut cursor = 13_usize;
    if body[10] & 0x80 != 0 {
        cursor = cursor.saturating_add(3 * (1 << ((body[10] & 0x07) + 1)));
    }
    if cursor > body.len() {
        return Err(ImageError::download(
            "Steam returned an invalid GIF structure",
        ));
    }
    let mut frames = 0;
    while cursor < body.len() {
        match body[cursor] {
            0x3b => {
                return if frames == 0 {
                    Err(ImageError::download(
                        "Steam returned a GIF without an image frame",
                    ))
                } else {
                    Ok(frames)
                };
            }
            0x21 => {
                if cursor + 2 > body.len() {
                    return Err(ImageError::download(
                        "Steam returned an invalid GIF structure",
                    ));
                }
                cursor = skip_gif_sub_blocks(body, cursor + 2)?;
            }
            0x2c if cursor + 10 <= body.len() => {
                let packed = body[cursor + 9];
                cursor += 10;
                if packed & 0x80 != 0 {
                    cursor = cursor.saturating_add(3 * (1 << ((packed & 0x07) + 1)));
                }
                if cursor >= body.len() {
                    return Err(ImageError::download(
                        "Steam returned an invalid GIF structure",
                    ));
                }
                cursor += 1;
                cursor = skip_gif_sub_blocks(body, cursor)?;
                frames += 1;
                if frames > 1 {
                    return Ok(frames);
                }
            }
            _ => {
                return Err(ImageError::download(
                    "Steam returned an invalid GIF structure",
                ));
            }
        }
    }
    Err(ImageError::download("Steam returned an unterminated GIF"))
}

fn skip_gif_sub_blocks(body: &[u8], mut offset: usize) -> Result<usize, ImageError> {
    loop {
        let Some(size) = body.get(offset).copied() else {
            return Err(ImageError::download(
                "Steam returned an invalid GIF structure",
            ));
        };
        offset += 1;
        if size == 0 {
            return Ok(offset);
        }
        offset = offset.saturating_add(size as usize);
        if offset > body.len() {
            return Err(ImageError::download(
                "Steam returned an invalid GIF structure",
            ));
        }
    }
}

fn download(
    url: &str,
    timeout: Duration,
    max_bytes: usize,
) -> Result<(String, Vec<u8>), ImageError> {
    let mut current = canonical_image_url(url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .https_only(true)
        .timeout_global(Some(timeout))
        .build()
        .into();
    for redirects in 0..=MAX_REDIRECTS {
        let mut response = agent
            .get(&current)
            .header("Accept", "image/webp,image/png,image/jpeg,image/gif;q=0.8")
            .header("Accept-Encoding", "identity")
            .header("User-Agent", "GRIP/1.0 Steam-Deck local guide reader")
            .call()
            .map_err(|_| ImageError::download("Could not download the Steam image"))?;
        if redirect_status(response.status().as_u16()) {
            if redirects == MAX_REDIRECTS {
                return Err(ImageError::download("Could not download the Steam image"));
            }
            let location = response
                .headers()
                .get("Location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| ImageError::download("Could not download the Steam image"))?;
            let joined = Url::parse(&current)
                .ok()
                .and_then(|base| base.join(location).ok())
                .ok_or_else(|| {
                    ImageError::download("Steam redirected the image to an unsafe URL")
                })?;
            current = canonical_image_url(joined.as_str())
                .map_err(|_| ImageError::download("Steam redirected the image to an unsafe URL"))?;
            continue;
        }
        canonical_image_url(&current)
            .map_err(|_| ImageError::download("Steam returned an unsafe final image URL"))?;
        if let Some(encoding) = response.headers().get("Content-Encoding") {
            let encoding = encoding.to_str().unwrap_or_default();
            if !encoding.eq_ignore_ascii_case("identity") {
                return Err(ImageError::download(
                    "Steam returned an encoded image response",
                ));
            }
        }
        let mime_type = response
            .headers()
            .get("Content-Type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let normalized_mime = mime_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if normalized_mime != "application/octet-stream"
            && extension_for_mime(&normalized_mime).is_none()
        {
            return Err(ImageError::download(
                "Steam returned an unsupported image type",
            ));
        }
        if let Some(length) = response.headers().get("Content-Length") {
            let length = length
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| {
                    ImageError::download("Steam returned an invalid image Content-Length")
                })?;
            if length > max_bytes as u64 {
                return Err(ImageError::download(
                    "Steam image exceeds the download size limit",
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
                    "Steam image exceeds the download size limit"
                } else {
                    "Could not download the Steam image"
                };
                ImageError::download(message)
            })?;
        // The common fetcher boundary validates once, including injected/offline test fetchers.
        return Ok((mime_type, body));
    }
    unreachable!("redirect loop always returns or continues")
}

fn response(value: &ImageData, from_cache: bool) -> Value {
    json!({
        "base64": base64::engine::general_purpose::STANDARD.encode(&value.body),
        "fromCache": from_cache,
        "height": value.height,
        "mimeType": value.mime_type,
        "width": value.width,
    })
}

fn redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn extension_for_mime(mime_type: &str) -> Option<&'static str> {
    IMAGE_TYPES
        .iter()
        .find_map(|(candidate, extension)| (*candidate == mime_type).then_some(*extension))
}

fn mime_for_extension(extension: &str) -> Option<&'static str> {
    IMAGE_TYPES
        .iter()
        .find_map(|(mime_type, candidate)| (*candidate == extension).then_some(*mime_type))
}

fn cache_digest(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    let mut output = String::with_capacity(64);
    for byte in digest {
        use fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn managed_cache_name(name: &str) -> bool {
    let name = name.strip_prefix("offline-").unwrap_or(name);
    let Some((digest, extension)) = name.split_once('.') else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && mime_for_extension(extension).is_some()
}

fn offline_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("offline-"))
}

fn managed_temporary_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix('.') else {
        return false;
    };
    let Some(name) = name.strip_suffix(".tmp") else {
        return false;
    };
    let mut parts = name.split('.');
    let (Some(digest), Some(token), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && (6..=16).contains(&token.len())
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn safe_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    if !directory.metadata()?.is_dir() {
        return Err(io::Error::other("image cache path is not a directory"));
    }
    if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn create_temporary(directory: &Path, digest: &str) -> io::Result<(File, PathBuf)> {
    let process = u64::from(std::process::id());
    for _ in 0..16 {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let token = format!("{:08x}{:08x}", process as u32, counter as u32);
        let path = directory.join(format!(".{digest}.{token}.tmp"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC)
            .open(&path)
        {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create image cache temporary file",
    ))
}

fn sync_directory(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?
        .sync_all()
}

#[cfg(test)]
mod offline_tests {
    use super::*;

    #[test]
    fn status_memo_skips_unchanged_bytes_and_revalidates_replaced_or_unsafe_files() {
        let directory = crate::test_support::TestDirectory::new("unused");
        let body = include!("../tests/fixtures/static_png.rs").to_vec();
        let cache = GuideImageCache::with_fetcher(
            directory.0.join("images"),
            {
                let body = body.clone();
                move |_, _, _| Ok(("image/png".into(), body.clone()))
            },
            ImageLimits {
                max_memory_bytes: 0,
                ..ImageLimits::default()
            },
        )
        .unwrap();
        let url = "https://images.steamusercontent.com/test.png";
        cache.download(url).unwrap();
        assert!(cache.is_downloaded(url).unwrap());
        let reads = cache.validation_reads.load(Ordering::Relaxed);
        assert_eq!(reads, 0); // The successful write already memoized a full decode.
        assert_eq!(cache.validation_decodes.load(Ordering::Relaxed), 1);
        for _ in 0..20 {
            assert!(cache.get(url, false).unwrap().is_some()); // Disk reads reuse the verified signature too.
            assert!(cache.is_downloaded(url).unwrap());
        }
        assert_eq!(cache.validation_reads.load(Ordering::Relaxed), reads);
        assert_eq!(cache.validation_decodes.load(Ordering::Relaxed), 1);
        let path = cache
            .cache_directory
            .join(format!("offline-{}.png", cache_digest(url)));
        let mut corrupt = body.clone();
        corrupt[0] = 0;
        fs::write(&path, &corrupt).unwrap(); // Same length, changed ctime/mtime.
        assert!(!cache.is_downloaded(url).unwrap());
        assert_eq!(cache.validation_reads.load(Ordering::Relaxed), reads + 1);
        fs::write(&path, &body).unwrap();
        assert!(cache.is_downloaded(url).unwrap());
        fs::remove_file(&path).unwrap();
        assert!(!cache.is_downloaded(url).unwrap());
        let outside = directory.0.join("unmanaged.png");
        fs::write(&outside, &body).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(!cache.is_downloaded(url).unwrap());
        assert_eq!(fs::read(outside).unwrap(), body);
        assert_eq!(
            image_write_error(io::Error::from_raw_os_error(libc::ENOSPC)).message(),
            "设备磁盘空间不足，请先释放存储空间"
        );
        for code in [libc::ENOSPC, libc::EDQUOT] {
            assert_eq!(
                image_write_error(io::Error::from_raw_os_error(code)).kind(),
                ImageErrorKind::Capacity
            );
        }
        assert_eq!(
            image_write_error(io::Error::from_raw_os_error(libc::EACCES)).kind(),
            ImageErrorKind::Download
        );
    }
}
