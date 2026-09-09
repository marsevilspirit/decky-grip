use std::collections::HashMap;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(crate) enum StoreError {
    Validation(&'static str),
    Storage(&'static str),
    Durability(&'static str),
    Protocol(&'static str),
}

impl StoreError {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Validation(message)
            | Self::Storage(message)
            | Self::Durability(message)
            | Self::Protocol(message) => message,
        }
    }
}

pub(crate) enum ReadError {
    Missing,
    TooLarge,
    Changed,
    Unsafe,
}

pub(crate) enum AtomicReplaceError {
    Prepare,
    Replace,
    Durability,
}

#[derive(Default)]
pub(crate) struct KeyLockPool {
    entries: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl KeyLockPool {
    pub(crate) fn with<T>(&self, key: &str, operation: impl FnOnce() -> T) -> T {
        let entry = lock(&self.entries)
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let result = {
            let _guard = lock(&entry);
            operation()
        };
        // Release the per-key guard before pruning; waiting callers still own their Arc.
        let mut entries = lock(&self.entries);
        if Arc::strong_count(&entry) == 2
            && entries
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, &entry))
        {
            entries.remove(key);
        }
        result
    }
}

pub(crate) struct StoreLock(File);

impl Drop for StoreLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub(crate) fn acquire_store_lock(path: &Path) -> io::Result<StoreLock> {
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
pub(crate) struct FileSignature {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

pub(crate) fn signature(metadata: &Metadata) -> FileSignature {
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

pub(crate) fn read_bounded_regular_file(
    path: &Path,
    max_bytes: u64,
    known_signature: Option<FileSignature>,
) -> Result<(Option<Vec<u8>>, FileSignature), ReadError> {
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

    let payload = if known_signature == Some(initial_signature) {
        None
    } else {
        let mut payload = Vec::with_capacity(initial.len() as usize);
        (&mut file)
            .take(max_bytes + 1)
            .read_to_end(&mut payload)
            .map_err(|_| ReadError::Unsafe)?;
        if payload.len() as u64 > max_bytes {
            return Err(ReadError::TooLarge);
        }
        Some(payload)
    };

    let final_metadata = file.metadata().map_err(|_| ReadError::Unsafe)?;
    let final_signature = signature(&final_metadata);
    if !final_metadata.is_file()
        || final_signature != initial_signature
        || payload
            .as_ref()
            .is_some_and(|payload| payload.len() as u64 != final_metadata.len())
    {
        return Err(ReadError::Changed);
    }
    let path_metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ReadError::Changed
        } else {
            ReadError::Unsafe
        }
    })?;
    if !path_metadata.is_file() || signature(&path_metadata) != final_signature {
        return Err(ReadError::Changed);
    }
    Ok((payload, final_signature))
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

pub(crate) fn atomic_replace(
    path: &Path,
    temporary_prefix: &str,
    temporary_suffix: &str,
    payload: &[u8],
) -> Result<(), AtomicReplaceError> {
    let parent = path.parent().ok_or(AtomicReplaceError::Prepare)?;
    fs::create_dir_all(parent).map_err(|_| AtomicReplaceError::Prepare)?;
    let (mut temporary, temporary_path) = create_temp(parent, temporary_prefix, temporary_suffix)
        .map_err(|_| AtomicReplaceError::Prepare)?;
    let replace_result = (|| -> io::Result<()> {
        make_private(&temporary)?;
        temporary.write_all(payload)?;
        temporary.sync_all()?;
        drop(temporary);
        fs::rename(&temporary_path, path)
    })();
    if replace_result.is_err() {
        let _ = fs::remove_file(temporary_path);
        return Err(AtomicReplaceError::Replace);
    }
    sync_directory(parent).map_err(|_| AtomicReplaceError::Durability)
}

fn make_private(file: &File) -> io::Result<()> {
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)?
        .sync_all()
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn backup_corrupt_file(path: &Path) -> io::Result<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_lock_scope_returns_results_and_reclaims_keys_after_errors() {
        let pool = KeyLockPool::default();
        assert_eq!(pool.with("first", || 42), 42);
        assert!(lock(&pool.entries).is_empty());
        let result: Result<(), &str> = pool.with("first", || {
            pool.with("second", || {
                assert_eq!(lock(&pool.entries).len(), 2);
                Err("download failed")
            })
        });
        assert_eq!(result, Err("download failed"));
        assert!(lock(&pool.entries).is_empty());
    }
}
