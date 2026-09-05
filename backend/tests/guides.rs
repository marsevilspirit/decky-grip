mod common;

use common::TestDirectory;
use grip_sidecar::guides::{GuideError, GuideLimits, GuideReader};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::Duration;

const GUIDE_ID: &str = "3414883877";
const OTHER_GUIDE_ID: &str = "3414883878";
const THIRD_GUIDE_ID: &str = "3414883879";
const NOW_MS: u64 = 1_800_000_000_000;
const CACHE_MAX_AGE_MS: u64 = 6 * 60 * 60 * 1_000;
const MAX_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;

#[test]
fn deleting_one_offline_guide_preserves_shared_images_and_positions() {
    use grip_sidecar::guide_images::{GuideImageCache, ImageLimits};
    let directory = TestDirectory::new();
    let guides = GuideReader::with_fetcher(
        directory.0.join("guides"),
        |url, _, _| {
            let own = if url.contains("?id=1&") {
                "first"
            } else {
                "second"
            };
            Ok(format!(r#"<div class="workshopItemTitle">Guide</div><div class="guideAuthors">Author</div><div class="subSection" id="1"><div class="subSectionTitle">Chapter</div><div class="subSectionDesc"><img src="https://images.steamusercontent.com/shared.png"><img src="https://images.steamusercontent.com/{own}.png"></div></div>"#).into_bytes())
        },
        || NOW_MS,
    );
    let images = GuideImageCache::with_fetcher(
        directory.0.join("images"),
        |_, _, _| {
            Ok((
                "image/png".into(),
                b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0test".to_vec(),
            ))
        },
        ImageLimits::default(),
    )
    .unwrap();
    for id in ["1", "2"] {
        guides.get(id, false).unwrap();
    }
    let urls = ["shared", "first", "second"]
        .map(|name| format!("https://images.steamusercontent.com/{name}.png"));
    for url in &urls {
        images.download(url).unwrap();
    }
    let positions = directory.0.join("reader_positions.json");
    fs::write(&positions, b"keep this exact history").unwrap();
    // Corrupt sibling cache: fail before deleting any possibly shared data.
    let sibling = directory.0.join("guides/2.json");
    let body = fs::read(&sibling).unwrap();
    fs::write(&sibling, b"corrupt").unwrap();
    assert!(guides.remove_offline_guide("1", &images).is_err());
    assert!(images.is_downloaded(&urls[1]).unwrap());
    fs::write(sibling, body).unwrap();
    assert_eq!(
        guides.remove_offline_guide("1", &images).unwrap()["filesRemoved"],
        2
    );
    assert!(guides.get_cached("1").unwrap().is_none());
    assert!(guides.get_cached("2").unwrap().is_some());
    assert!(images.is_downloaded(&urls[0]).unwrap());
    assert!(!images.is_downloaded(&urls[1]).unwrap());
    assert!(images.get(&urls[1], false).unwrap().is_none());
    assert!(images.is_downloaded(&urls[2]).unwrap());
    assert_eq!(fs::read(positions).unwrap(), b"keep this exact history");
    assert_eq!(
        guides.remove_offline_guide("2", &images).unwrap()["filesRemoved"],
        3
    );
}

enum FetchPlan {
    Body(Vec<u8>),
    Error(String),
}

struct Harness {
    _directory: TestDirectory,
    cache_directory: PathBuf,
    now_ms: Arc<AtomicU64>,
    plan: Arc<Mutex<FetchPlan>>,
    calls: Arc<Mutex<Vec<(String, Duration, usize)>>>,
    reader: GuideReader,
}

impl Harness {
    fn new() -> Self {
        Self::with_limits(GuideLimits::default())
    }

    fn with_limits(limits: GuideLimits) -> Self {
        let directory = TestDirectory::new();
        let cache_directory = directory.0.join("guides");
        let now_ms = Arc::new(AtomicU64::new(NOW_MS));
        let plan = Arc::new(Mutex::new(FetchPlan::Body(guide_fixture("初始指南"))));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fetch_plan = Arc::clone(&plan);
        let fetch_calls = Arc::clone(&calls);
        let clock = Arc::clone(&now_ms);
        let reader = GuideReader::with_fetcher_and_limits(
            cache_directory.clone(),
            move |url, timeout, max_bytes| {
                fetch_calls
                    .lock()
                    .unwrap()
                    .push((url.to_owned(), timeout, max_bytes));
                match &*fetch_plan.lock().unwrap() {
                    FetchPlan::Body(body) => Ok(body.clone()),
                    FetchPlan::Error(message) => Err(GuideError::download(message.clone())),
                }
            },
            move || clock.load(Ordering::SeqCst),
            limits,
        );
        Self {
            _directory: directory,
            cache_directory,
            now_ms,
            plan,
            calls,
            reader,
        }
    }

    fn cache_path(&self, guide_id: &str) -> PathBuf {
        self.cache_directory.join(format!("{guide_id}.json"))
    }

    fn set_body(&self, title: &str) {
        *self.plan.lock().unwrap() = FetchPlan::Body(guide_fixture(title));
    }

    fn set_large_body(&self, title: &str) {
        *self.plan.lock().unwrap() =
            FetchPlan::Body(guide_fixture_with_text(title, &"x".repeat(2_000)));
    }

    fn set_error(&self, message: &str) {
        *self.plan.lock().unwrap() = FetchPlan::Error(message.to_owned());
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

fn guide_fixture(title: &str) -> Vec<u8> {
    guide_fixture_with_text(title, "正文")
}

#[test]
fn offline_updates_publish_only_after_all_images_and_preserve_the_old_version_on_failure() {
    use grip_sidecar::guide_images::{GuideImageCache, ImageErrorKind, ImageLimits};
    let harness = Harness::new();
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0test";
    let images = GuideImageCache::with_fetcher(
        harness._directory.0.join("images"),
        move |_, _, _| Ok(("image/png".into(), png.to_vec())),
        ImageLimits {
            max_disk_bytes: png.len(),
            ..ImageLimits::default()
        },
    )
    .unwrap();
    let old_url = "https://images.steamusercontent.com/ugc/example/image.png";
    let new_url = "https://images.steamusercontent.com/ugc/example/new.png";
    let candidate = harness.reader.prepare(GUIDE_ID, false).unwrap();
    let token = candidate["token"].as_str().unwrap();
    assert!(harness.reader.get_cached(GUIDE_ID).unwrap().is_none());
    assert!(harness.reader.commit(GUIDE_ID, token, &images).is_err());
    images.download(old_url).unwrap();
    harness.reader.commit(GUIDE_ID, token, &images).unwrap();
    let path = harness.cache_path(GUIDE_ID);
    let original = fs::read(&path).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&original).unwrap()["offline"],
        true
    );
    assert!(harness.reader.get(GUIDE_ID, true).is_err()); // No bypass that drops the offline pin.

    harness.set_error("network unavailable");
    assert!(harness.reader.prepare(GUIDE_ID, true).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    *harness.plan.lock().unwrap() = FetchPlan::Body(
        String::from_utf8(guide_fixture("新版指南"))
            .unwrap()
            .replace(old_url, new_url)
            .into_bytes(),
    );
    let candidate = harness.reader.prepare(GUIDE_ID, true).unwrap();
    let token = candidate["token"].as_str().unwrap();
    assert_eq!(
        harness.reader.get_cached(GUIDE_ID).unwrap().unwrap()["title"],
        "初始指南"
    );
    assert!(!harness.reader.discard(GUIDE_ID, "stale-token").unwrap());
    assert!(
        harness
            .reader
            .commit(GUIDE_ID, "stale-token", &images)
            .is_err()
    );
    assert!(harness.reader.commit(GUIDE_ID, token, &images).is_err());
    assert_eq!(
        images.download(new_url).unwrap_err().kind(),
        ImageErrorKind::Capacity
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(images.is_downloaded(old_url).unwrap());

    images.set_disk_limit(64 * 1024 * 1024).unwrap();
    images.download(new_url).unwrap();
    if unsafe { libc::geteuid() } != 0 {
        fs::set_permissions(&harness.cache_directory, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(harness.reader.commit(GUIDE_ID, token, &images).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::set_permissions(&harness.cache_directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let committed = harness.reader.commit(GUIDE_ID, token, &images).unwrap();
    assert_eq!(committed["title"], "新版指南");
    assert_eq!(committed["offline"], true);
    assert!(!harness.reader.discard(GUIDE_ID, token).unwrap());
    assert_eq!(fs::read_dir(&harness.cache_directory).unwrap().count(), 1); // No routine backup litter.
    let offline = GuideReader::with_fetcher(
        &harness.cache_directory,
        |_, _, _| panic!("offline read fetched"),
        || NOW_MS,
    );
    assert_eq!(offline.get(GUIDE_ID, false).unwrap()["title"], "新版指南");

    let pending = harness.reader.prepare(GUIDE_ID, true).unwrap();
    let committed_bytes = fs::read(&path).unwrap();
    images.clear();
    assert!(
        harness
            .reader
            .commit(GUIDE_ID, pending["token"].as_str().unwrap(), &images)
            .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), committed_bytes);
    harness.reader.remove_guide_cache(GUIDE_ID).unwrap();
    images.download(new_url).unwrap();
    assert!(
        harness
            .reader
            .commit(GUIDE_ID, pending["token"].as_str().unwrap(), &images)
            .is_err()
    );
    assert!(!path.exists());
    let pending = harness.reader.prepare(GUIDE_ID, true).unwrap();
    harness.reader.clear_guide_cache().unwrap();
    assert!(
        harness
            .reader
            .commit(GUIDE_ID, pending["token"].as_str().unwrap(), &images)
            .is_err()
    );
    assert!(!path.exists());
}

#[test]
fn downloaded_and_legacy_bodies_survive_lru_and_restart_until_manual_deletion() {
    use grip_sidecar::guide_images::{GuideImageCache, ImageLimits};
    let harness = Harness::with_limits(GuideLimits {
        max_disk_bytes: 1,
        max_memory_bytes: 0,
    });
    let images = GuideImageCache::with_fetcher(
        harness._directory.0.join("images"),
        |_, _, _| {
            Ok((
                "image/png".into(),
                b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0test".to_vec(),
            ))
        },
        ImageLimits::default(),
    )
    .unwrap();
    images
        .download("https://images.steamusercontent.com/ugc/example/image.png")
        .unwrap();
    let candidate = harness.reader.prepare(GUIDE_ID, false).unwrap();
    harness
        .reader
        .commit(GUIDE_ID, candidate["token"].as_str().unwrap(), &images)
        .unwrap();
    let path = harness.cache_path(GUIDE_ID);
    let original = fs::read(&path).unwrap();
    let mut legacy: Value = serde_json::from_slice(&original).unwrap();
    legacy["guideId"] = json!(THIRD_GUIDE_ID);
    legacy["sourceUrl"] = json!(format!(
        "https://steamcommunity.com/sharedfiles/filedetails/?id={THIRD_GUIDE_ID}&l=schinese"
    ));
    legacy["schemaVersion"] = json!(1);
    legacy.as_object_mut().unwrap().remove("offline");
    fs::write(
        harness.cache_path(THIRD_GUIDE_ID),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    harness.reader.get(OTHER_GUIDE_ID, false).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!harness.cache_path(OTHER_GUIDE_ID).exists());
    let restarted = GuideReader::with_fetcher_and_limits(
        &harness.cache_directory,
        |_, _, _| panic!("pinned body must be offline"),
        || NOW_MS,
        GuideLimits {
            max_disk_bytes: 1,
            max_memory_bytes: 0,
        },
    );
    assert!(restarted.get_cached(GUIDE_ID).unwrap().is_some());
    assert!(restarted.get_cached(THIRD_GUIDE_ID).unwrap().is_some());
    restarted.remove_offline_guide(GUIDE_ID, &images).unwrap();
    assert!(!path.exists());
    assert!(
        images
            .is_downloaded("https://images.steamusercontent.com/ugc/example/image.png")
            .unwrap()
    );
    restarted
        .remove_offline_guide(THIRD_GUIDE_ID, &images)
        .unwrap();
    assert_eq!(images.stats()["files"], 0);
}

fn guide_fixture_with_text(title: &str, text: &str) -> Vec<u8> {
    format!(
        "<div class=\"workshopItemTitle\">{title}</div>\
         <div class=\"guideAuthors\">By 测试作者</div>\
         <div class=\"subSection\" id=\"7667220\">\
         <div class=\"subSectionTitle\">四月</div>\
         <div class=\"subSectionDesc\"><p>{text}</p>\
         <img class=\"bb_img\" src=\"https://images.steamusercontent.com/ugc/example/image.png\"></div></div>"
    )
    .into_bytes()
}

fn make_fifo(path: &Path) {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
}

#[test]
fn downloads_then_serves_the_validated_network_inert_cache() {
    let harness = Harness::new();
    let downloaded = harness.reader.get(GUIDE_ID, false).unwrap();
    let cached = harness.reader.get(GUIDE_ID, false).unwrap();

    assert_eq!(harness.call_count(), 1);
    assert_eq!(
        harness.calls.lock().unwrap()[0],
        (
            "https://steamcommunity.com/sharedfiles/filedetails/?id=3414883877&l=schinese"
                .to_owned(),
            Duration::from_secs(12),
            MAX_DOWNLOAD_BYTES,
        )
    );
    assert_eq!(
        downloaded
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "author",
            "fetchedAt",
            "fromCache",
            "guideId",
            "offline",
            "sections",
            "sourceUrl",
            "stale",
            "title",
        ])
    );
    assert_eq!(downloaded["fromCache"], false);
    assert_eq!(downloaded["stale"], false);
    assert_eq!(cached["fromCache"], true);
    assert_eq!(cached["stale"], false);
    assert_eq!(cached["sections"], downloaded["sections"]);
    assert!(
        downloaded["sections"][0]["html"]
            .as_str()
            .unwrap()
            .contains("data-grip-image-url=")
    );
    assert!(
        !downloaded["sections"][0]["html"]
            .as_str()
            .unwrap()
            .contains(" src=")
    );

    let cache_path = harness.cache_path(GUIDE_ID);
    let stored: Value = serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
    assert!(
        stored["sections"][0]["html"]
            .as_str()
            .unwrap()
            .contains(" src=")
    );
    assert!(
        !stored["sections"][0]["html"]
            .as_str()
            .unwrap()
            .contains("data-grip-image-url=")
    );
    assert_eq!(
        fs::metadata(cache_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn cache_only_miss_and_special_files_never_download_or_follow_links() {
    let harness = Harness::new();
    assert!(harness.reader.get_cached(GUIDE_ID).unwrap().is_none());
    assert_eq!(harness.call_count(), 0);

    fs::create_dir_all(&harness.cache_directory).unwrap();
    let cache_path = harness.cache_path(GUIDE_ID);
    let outside = harness._directory.0.join("outside.json");
    fs::write(&outside, b"keep").unwrap();
    symlink(&outside, &cache_path).unwrap();
    assert!(harness.reader.get_cached(GUIDE_ID).is_err());
    assert!(harness.reader.remove_guide_cache(GUIDE_ID).is_err());

    let fifo_path = harness.cache_path(OTHER_GUIDE_ID);
    make_fifo(&fifo_path);
    assert!(harness.reader.get_cached(OTHER_GUIDE_ID).is_err());
    assert!(harness.reader.remove_guide_cache(OTHER_GUIDE_ID).is_err());
    assert_eq!(harness.call_count(), 0);

    let cleared = harness.reader.clear_guide_cache().unwrap();
    assert_eq!(cleared, json!({"bytesRemoved": 0, "filesRemoved": 2}));
    assert!(fs::symlink_metadata(&cache_path).is_err());
    assert!(fs::symlink_metadata(&fifo_path).is_err());
    assert_eq!(fs::read(outside).unwrap(), b"keep");
}

#[test]
fn reads_a_python_v1_cache_without_downloading() {
    let harness = Harness::new();
    fs::create_dir_all(&harness.cache_directory).unwrap();
    let python_cache = format!(
        "{{\"author\":\"测试作者\",\"fetchedAt\":{NOW_MS},\"guideId\":\"{GUIDE_ID}\",\"schemaVersion\":1,\"sections\":[{{\"html\":\"<p>Python 缓存</p>\",\"id\":\"7667220\",\"title\":\"四月\"}}],\"sourceUrl\":\"https://steamcommunity.com/sharedfiles/filedetails/?id={GUIDE_ID}&l=schinese\",\"title\":\"Python v1 指南\"}}\n"
    );
    fs::write(harness.cache_path(GUIDE_ID), python_cache).unwrap();
    harness.set_error("cache-only lookup attempted network");

    let cached = harness.reader.get_cached(GUIDE_ID).unwrap().unwrap();

    assert_eq!(cached["title"], "Python v1 指南");
    assert_eq!(cached["sections"][0]["html"], "<p>Python 缓存</p>");
    assert_eq!(cached["fromCache"], true);
    assert_eq!(cached["stale"], false);
    assert_eq!(harness.call_count(), 0);
}

#[test]
fn cached_summary_and_single_remove_reuse_the_validated_cache() {
    let harness = Harness::new();
    harness.reader.get(GUIDE_ID, false).unwrap();
    harness.set_body("另一篇指南");
    harness.reader.get(OTHER_GUIDE_ID, false).unwrap();

    let summary = harness
        .reader
        .cached_summary(GUIDE_ID, Some("7667220"))
        .unwrap()
        .unwrap();
    assert_eq!(
        summary,
        json!({
            "author": "测试作者",
            "fetchedAt": NOW_MS,
            "sectionTitle": "四月",
            "stale": false,
            "title": "初始指南",
        })
    );
    assert_eq!(harness.call_count(), 2);

    let removed = harness.reader.remove_guide_cache(GUIDE_ID).unwrap();
    assert_eq!(removed["filesRemoved"], 1);
    assert!(removed["bytesRemoved"].as_u64().unwrap() > 0);
    assert!(harness.reader.get_cached(GUIDE_ID).unwrap().is_none());
    assert_eq!(
        harness.reader.get_cached(OTHER_GUIDE_ID).unwrap().unwrap()["title"],
        "另一篇指南"
    );
    assert_eq!(
        harness.reader.remove_guide_cache(GUIDE_ID).unwrap(),
        json!({"bytesRemoved": 0, "filesRemoved": 0})
    );
}

#[test]
fn invalid_utf8_oversized_and_non_guide_responses_are_never_cached() {
    for body in [
        b"not utf-8: \xff".to_vec(),
        vec![b'x'; MAX_DOWNLOAD_BYTES + 1],
        b"<html>login required</html>".to_vec(),
    ] {
        let harness = Harness::new();
        *harness.plan.lock().unwrap() = FetchPlan::Body(body);

        assert!(harness.reader.get(GUIDE_ID, true).is_err());
        assert!(!harness.cache_path(GUIDE_ID).exists());
    }
}

#[test]
fn stale_and_force_refresh_follow_the_explicit_network_policy() {
    let harness = Harness::new();
    let original = harness.reader.get(GUIDE_ID, false).unwrap();

    harness.now_ms.store(NOW_MS + 1, Ordering::SeqCst);
    harness.set_error("offline");
    let fallback = harness.reader.get(GUIDE_ID, true).unwrap();
    assert_eq!(fallback["fromCache"], true);
    assert_eq!(fallback["stale"], true);
    assert_eq!(fallback["fetchedAt"], original["fetchedAt"]);

    harness
        .now_ms
        .store(NOW_MS + CACHE_MAX_AGE_MS + 10, Ordering::SeqCst);
    harness.set_body("更新后的指南");
    let refreshed = harness.reader.get(GUIDE_ID, true).unwrap();
    assert_eq!(refreshed["title"], "更新后的指南");
    assert_eq!(refreshed["fromCache"], false);
    assert_eq!(refreshed["stale"], false);
    let refreshed_at = refreshed["fetchedAt"].as_u64().unwrap();

    harness
        .now_ms
        .store(refreshed_at + CACHE_MAX_AGE_MS, Ordering::SeqCst);
    assert_eq!(
        harness.reader.get_cached(GUIDE_ID).unwrap().unwrap()["stale"],
        false
    );
    harness
        .now_ms
        .store(refreshed_at + CACHE_MAX_AGE_MS + 1, Ordering::SeqCst);
    let calls_before_stale_get = harness.call_count();
    let stale = harness.reader.get(GUIDE_ID, false).unwrap();
    assert_eq!(stale["fromCache"], true);
    assert_eq!(stale["stale"], true);
    assert_eq!(harness.call_count(), calls_before_stale_get);
}

#[test]
fn corrupt_cache_is_preserved_until_a_successful_force_refresh() {
    let harness = Harness::new();
    fs::create_dir_all(&harness.cache_directory).unwrap();
    let path = harness.cache_path(GUIDE_ID);
    let corrupt = b"{ definitely not json";
    fs::write(&path, corrupt).unwrap();

    assert!(harness.reader.get_cached(GUIDE_ID).is_err());
    assert!(harness.reader.get(GUIDE_ID, false).is_err());
    assert_eq!(harness.call_count(), 0);
    assert_eq!(fs::read(&path).unwrap(), corrupt);

    harness.set_error("offline");
    assert!(harness.reader.get(GUIDE_ID, true).is_err());
    assert_eq!(harness.call_count(), 1);
    assert_eq!(fs::read(&path).unwrap(), corrupt);

    harness.set_body("修复后的指南");
    let refreshed = harness.reader.get(GUIDE_ID, true).unwrap();
    assert_eq!(refreshed["fromCache"], false);
    assert_eq!(refreshed["title"], "修复后的指南");
    let stored: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(stored["schemaVersion"], 2);
    assert_eq!(stored["offline"], false);
    assert_eq!(stored["guideId"], GUIDE_ID);
}

#[test]
fn strict_v1_cache_validation_rejects_unknown_fields_and_unsafe_html() {
    let harness = Harness::new();
    harness.reader.get(GUIDE_ID, false).unwrap();
    let path = harness.cache_path(GUIDE_ID);
    let original = fs::read(&path).unwrap();
    let mut document: Value = serde_json::from_slice(&original).unwrap();

    document["unexpected"] = json!(true);
    fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    assert!(harness.reader.get_cached(GUIDE_ID).is_err());

    let mut document: Value = serde_json::from_slice(&original).unwrap();
    let html = document["sections"][0]["html"].as_str().unwrap();
    document["sections"][0]["html"] = json!(format!("{html}<script>alert(1)</script>"));
    fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    let error = harness.reader.get_cached(GUIDE_ID).unwrap_err();
    assert!(error.to_string().contains("unsafe"), "{error}");
}

#[test]
fn changing_the_cache_file_invalidates_the_validation_memo() {
    let harness = Harness::new();
    harness.reader.get(GUIDE_ID, false).unwrap();
    let path = harness.cache_path(GUIDE_ID);
    let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    document["title"] = json!("磁盘上更新后的标题");
    fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();

    let changed = harness.reader.get(GUIDE_ID, false).unwrap();
    assert_eq!(changed["title"], "磁盘上更新后的标题");
    assert_eq!(harness.call_count(), 1);
}

struct Gate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

impl Gate {
    fn new() -> Self {
        Self {
            state: Mutex::new((false, false)),
            changed: Condvar::new(),
        }
    }

    fn block_fetch(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        let _ = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(3), |state| !state.1)
            .unwrap();
    }

    fn wait_until_started(&self) {
        let state = self.state.lock().unwrap();
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(1), |state| !state.0)
            .unwrap();
        assert!(state.0 && !timeout.timed_out(), "fetch did not start");
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.1 = true;
        self.changed.notify_all();
    }
}

#[test]
fn different_guides_do_not_share_a_network_lock() {
    let directory = TestDirectory::new();
    let gate = Arc::new(Gate::new());
    let fetch_gate = Arc::clone(&gate);
    let reader = Arc::new(GuideReader::with_fetcher(
        directory.0.join("guides"),
        move |url, _timeout, _max_bytes| {
            if url.contains(&format!("id={GUIDE_ID}")) {
                fetch_gate.block_fetch();
            }
            Ok(guide_fixture("并发指南"))
        },
        || NOW_MS,
    ));

    let first_reader = Arc::clone(&reader);
    let first = thread::spawn(move || first_reader.get(GUIDE_ID, false));
    gate.wait_until_started();

    let second_reader = Arc::clone(&reader);
    let (finished_tx, finished_rx) = mpsc::channel();
    let second = thread::spawn(move || {
        let result = second_reader.get(OTHER_GUIDE_ID, false);
        finished_tx.send(result.is_ok()).unwrap();
        result
    });
    let second_finished = finished_rx.recv_timeout(Duration::from_secs(1));
    gate.release();

    assert!(second_finished.unwrap());
    assert_eq!(second.join().unwrap().unwrap()["guideId"], OTHER_GUIDE_ID);
    assert_eq!(first.join().unwrap().unwrap()["guideId"], GUIDE_ID);
}

#[test]
fn cache_only_reads_while_the_same_guide_force_refresh_is_blocked() {
    let directory = TestDirectory::new();
    let gate = Arc::new(Gate::new());
    let should_block = Arc::new(AtomicBool::new(false));
    let fetch_gate = Arc::clone(&gate);
    let block = Arc::clone(&should_block);
    let reader = Arc::new(GuideReader::with_fetcher(
        directory.0.join("guides"),
        move |_url, _timeout, _max_bytes| {
            if block.load(Ordering::SeqCst) {
                fetch_gate.block_fetch();
            }
            Ok(guide_fixture("同一指南"))
        },
        || NOW_MS,
    ));
    let original = reader.get(GUIDE_ID, false).unwrap();
    should_block.store(true, Ordering::SeqCst);

    let foreground_reader = Arc::clone(&reader);
    let foreground = thread::spawn(move || foreground_reader.get(GUIDE_ID, true));
    gate.wait_until_started();

    let cache_reader = Arc::clone(&reader);
    let (cached_tx, cached_rx) = mpsc::channel();
    let cached = thread::spawn(move || {
        let result = cache_reader.get_cached(GUIDE_ID);
        cached_tx.send(result.is_ok()).unwrap();
        result
    });
    let cache_finished = cached_rx.recv_timeout(Duration::from_secs(1));
    gate.release();

    assert!(cache_finished.unwrap());
    let cached = cached.join().unwrap().unwrap().unwrap();
    assert_eq!(cached["fromCache"], true);
    assert_eq!(cached["fetchedAt"], original["fetchedAt"]);
    foreground.join().unwrap().unwrap();
}

#[test]
fn clear_during_an_inflight_download_prevents_cache_resurrection() {
    let directory = TestDirectory::new();
    let cache_directory = directory.0.join("guides");
    let gate = Arc::new(Gate::new());
    let fetch_gate = Arc::clone(&gate);
    let reader = Arc::new(GuideReader::with_fetcher(
        cache_directory.clone(),
        move |_url, _timeout, _max_bytes| {
            fetch_gate.block_fetch();
            Ok(guide_fixture("在途指南"))
        },
        || NOW_MS,
    ));

    let download_reader = Arc::clone(&reader);
    let download = thread::spawn(move || download_reader.get(GUIDE_ID, false));
    gate.wait_until_started();

    let clear_reader = Arc::clone(&reader);
    let (cleared_tx, cleared_rx) = mpsc::channel();
    let clear = thread::spawn(move || {
        let result = clear_reader.clear_guide_cache();
        cleared_tx.send(result.is_ok()).unwrap();
        result
    });
    let clear_finished = cleared_rx.recv_timeout(Duration::from_secs(1));
    gate.release();

    assert!(clear_finished.unwrap());
    clear.join().unwrap().unwrap();
    assert_eq!(download.join().unwrap().unwrap()["fromCache"], false);
    assert!(!cache_directory.join(format!("{GUIDE_ID}.json")).exists());
    assert!(reader.get_cached(GUIDE_ID).unwrap().is_none());
}

#[test]
fn stats_and_clear_ignore_unmanaged_names() {
    let harness = Harness::new();
    harness.reader.get(GUIDE_ID, false).unwrap();
    let unmanaged = harness.cache_directory.join("metadata.json");
    fs::write(&unmanaged, b"keep").unwrap();

    let stats = harness.reader.cache_stats().unwrap();
    assert_eq!(stats["files"], 1);
    assert!(stats["bytes"].as_u64().unwrap() > 0);
    let cleared = harness.reader.clear_guide_cache().unwrap();
    assert_eq!(cleared["filesRemoved"], 1);
    assert!(unmanaged.exists());
    assert!(harness.reader.get_cached(GUIDE_ID).unwrap().is_none());
}

#[test]
fn body_reads_promote_the_disk_lru_and_keep_both_tiers_bounded() {
    const LIMIT: usize = 6 * 1024;
    let harness = Harness::with_limits(GuideLimits {
        max_disk_bytes: LIMIT,
        max_memory_bytes: LIMIT,
    });

    harness.set_large_body("A");
    harness.reader.get(GUIDE_ID, false).unwrap();
    thread::sleep(Duration::from_millis(10));
    harness.set_large_body("B");
    harness.reader.get(OTHER_GUIDE_ID, false).unwrap();
    thread::sleep(Duration::from_millis(10));
    harness.reader.get_cached(GUIDE_ID).unwrap().unwrap();
    thread::sleep(Duration::from_millis(10));
    harness.set_large_body("C");
    harness.reader.get(THIRD_GUIDE_ID, false).unwrap();

    assert!(harness.cache_path(GUIDE_ID).exists());
    assert!(!harness.cache_path(OTHER_GUIDE_ID).exists());
    assert!(harness.cache_path(THIRD_GUIDE_ID).exists());
    let stats = harness.reader.cache_stats().unwrap();
    assert!(stats["bytes"].as_u64().unwrap() <= LIMIT as u64);
    assert!(stats["memoryBytes"].as_u64().unwrap() <= LIMIT as u64);
    assert_eq!(stats["diskLimitBytes"], LIMIT);
    assert_eq!(stats["memoryLimitBytes"], LIMIT);
}

#[test]
fn cached_summaries_do_not_promote_the_body_lru() {
    const LIMIT: usize = 6 * 1024;
    let harness = Harness::with_limits(GuideLimits {
        max_disk_bytes: LIMIT,
        max_memory_bytes: LIMIT,
    });

    harness.set_large_body("A");
    harness.reader.get(GUIDE_ID, false).unwrap();
    thread::sleep(Duration::from_millis(10));
    harness.set_large_body("B");
    harness.reader.get(OTHER_GUIDE_ID, false).unwrap();
    thread::sleep(Duration::from_millis(10));
    harness.reader.cached_summary(GUIDE_ID, None).unwrap();
    thread::sleep(Duration::from_millis(10));
    harness.set_large_body("C");
    harness.reader.get(THIRD_GUIDE_ID, false).unwrap();

    assert!(!harness.cache_path(GUIDE_ID).exists());
    assert!(harness.cache_path(OTHER_GUIDE_ID).exists());
    assert!(harness.cache_path(THIRD_GUIDE_ID).exists());
}
