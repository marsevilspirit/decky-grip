use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
