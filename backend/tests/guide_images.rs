mod common;

use base64::Engine as _;
use common::TestDirectory;
use grip_sidecar::guide_images::{
    GuideImageCache, ImageError, ImageErrorKind, ImageLimits, canonical_image_url,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::ffi::CString;
use std::fs::{self, File, FileTimes};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

const IMAGE_URL: &str = "https://images.steamusercontent.com/ugc/example/image.png";
const IMAGE_DIGEST: &str = "8440b380c871e5f183b586ca0a652b6d7b17e155fe2c05990b9b4aaa1829b874";
fn png(marker: u8, width: u32, height: u32) -> Vec<u8> {
    let mut body = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    body.extend_from_slice(&width.to_be_bytes());
    body.extend_from_slice(&height.to_be_bytes());
    body.extend_from_slice(b"\x08\x06\0\0\0");
    body.extend_from_slice(&[marker; 4]);
    body
}

fn gif(frames: usize) -> Vec<u8> {
    let mut body = b"GIF89a\x01\0\x01\0\0\0\0".to_vec();
    let frame = b",\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0";
    for _ in 0..frames {
        body.extend_from_slice(frame);
    }
    body.push(b';');
    body
}

fn webp(animated: bool) -> Vec<u8> {
    let mut payload = vec![if animated { 0x02 } else { 0x00 }];
    payload.extend_from_slice(&[0; 9]);
    let mut chunk = b"VP8X".to_vec();
    chunk.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    chunk.extend_from_slice(&payload);
    let mut riff_payload = b"WEBP".to_vec();
    riff_payload.extend_from_slice(&chunk);
    let mut body = b"RIFF".to_vec();
    body.extend_from_slice(&(riff_payload.len() as u32).to_le_bytes());
    body.extend_from_slice(&riff_payload);
    body
}

fn jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut body = b"\xff\xd8\xff\xc0\0\x07\x08".to_vec();
    body.extend_from_slice(&height.to_be_bytes());
    body.extend_from_slice(&width.to_be_bytes());
    body
}

fn limits(image: usize, disk: usize, memory: usize) -> ImageLimits {
    ImageLimits {
        max_image_bytes: image,
        max_disk_bytes: disk,
        max_memory_bytes: memory,
    }
}

fn make_fifo(path: &Path) {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
}

#[test]
fn canonicalizes_only_trusted_https_urls() {
    assert_eq!(
        canonical_image_url("HTTPS://IMAGES.STEAMUSERCONTENT.COM.:443/ugc/a.png?x=1&y=2").unwrap(),
        "https://images.steamusercontent.com:443/ugc/a.png?x=1&y=2"
    );
    assert_eq!(
        canonical_image_url("https://cdn.steamstatic.com").unwrap(),
        "https://cdn.steamstatic.com/"
    );
    assert_eq!(
        canonical_image_url("https://cdn.steamstatic.com?#").unwrap(),
        "https://cdn.steamstatic.com/"
    );

    for unsafe_url in [
        "data:image/png;base64,AAAA",
        "http://images.steamusercontent.com/a.png",
        "https://user@images.steamusercontent.com/a.png",
        "https://images.steamusercontent.com:444/a.png",
        "https://evilsteamusercontent.com/a.png",
        "https://steamusercontent.com.evil.example/a.png",
        "https://images.steamusercontent.com/a.png#fragment",
        "https://images.steamusercontent.com/a.png\r\nX-Test: bad",
    ] {
        let error = canonical_image_url(unsafe_url).unwrap_err();
        assert_eq!(error.kind(), ImageErrorKind::Validation, "{unsafe_url}");
    }
}

#[test]
fn download_result_requires_matching_static_bounded_raster() {
    let directory = TestDirectory::new();
    let bodies = [
        ("image/png", png(b'p', 1, 1), true),
        ("image/gif", gif(1), true),
        ("image/webp", webp(false), true),
        ("image/jpeg", jpeg(2, 3), true),
        ("image/gif", gif(2), false),
        ("image/webp", webp(true), false),
        ("image/png", png(b'p', 8_193, 1), false),
        ("image/png", b"not a png".to_vec(), false),
        ("image/svg+xml", b"<svg/>".to_vec(), false),
    ];
    for (index, (mime_type, body, accepted)) in bodies.into_iter().enumerate() {
        let mime_type = mime_type.to_owned();
        let body_len = body.len();
        let cache = GuideImageCache::with_fetcher(
            directory.0.join(index.to_string()),
            move |_, _, _| Ok((mime_type.clone(), body.clone())),
            limits(1024, 0, 0),
        )
        .unwrap();
        assert_eq!(
            cache.get(IMAGE_URL, true).unwrap().is_some(),
            accepted,
            "case {index}"
        );
        if accepted {
            assert!(body_len > 0);
        }
    }

    let apng = {
        let mut body = png(b'a', 1, 1);
        body.extend_from_slice(b"\0\0\0\x08acTL\0\0\0\x02\0\0\0\0crc!");
        body
    };
    let cache = GuideImageCache::with_fetcher(
        directory.0.join("apng"),
        move |_, _, _| Ok(("image/png".to_owned(), apng.clone())),
        limits(1024, 0, 0),
    )
    .unwrap();
    assert!(cache.get(IMAGE_URL, true).unwrap().is_none());
}

#[test]
fn network_failure_is_soft_and_cache_only_never_fetches() {
    let directory = TestDirectory::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let fetch_calls = Arc::clone(&calls);
    let cache = GuideImageCache::with_fetcher(
        directory.0.join("images"),
        move |_, _, _| {
            fetch_calls.fetch_add(1, Ordering::SeqCst);
            Err(ImageError::download("offline"))
        },
        limits(1024, 1024, 1024),
    )
    .unwrap();

    assert!(cache.get(IMAGE_URL, false).unwrap().is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(cache.get(IMAGE_URL, true).unwrap().is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn python_compatible_disk_cache_survives_an_offline_process() {
    let directory = TestDirectory::new();
    let cache_directory = directory.0.join("images");
    let body = png(b'a', 1, 1);
    let fetched = body.clone();
    let cache = GuideImageCache::with_fetcher(
        cache_directory.clone(),
        move |_, _, _| Ok(("image/png".to_owned(), fetched.clone())),
        limits(1024, 1024, 0),
    )
    .unwrap();
    let downloaded = cache.get(IMAGE_URL, true).unwrap().unwrap();

    assert_eq!(downloaded["fromCache"], false);
    assert_eq!(downloaded["mimeType"], "image/png");
    assert_eq!(downloaded["width"], 1);
    assert_eq!(downloaded["height"], 1);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(downloaded["base64"].as_str().unwrap())
            .unwrap(),
        body
    );
    let cache_path = cache_directory.join(format!("{IMAGE_DIGEST}.png"));
    assert_eq!(fs::read(&cache_path).unwrap(), body);
    assert_eq!(
        fs::metadata(&cache_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&cache_directory).unwrap().permissions().mode() & 0o777,
        0o700
    );

    let offline = GuideImageCache::with_fetcher(
        cache_directory,
        |_, _, _| panic!("network used"),
        limits(1024, 1024, 1024),
    )
    .unwrap();
    assert_eq!(
        offline.get(IMAGE_URL, false).unwrap().unwrap()["fromCache"],
        true
    );
    assert!(
        offline
            .get("https://images.steamusercontent.com/ugc/missing.png", false,)
            .unwrap()
            .is_none()
    );
}

#[test]
fn memory_and_disk_lrus_follow_recent_access() {
    let directory = TestDirectory::new();
    let body_len = png(b'a', 1, 1).len();
    let cache = GuideImageCache::with_fetcher(
        directory.0.join("memory"),
        |url, _, _| {
            let marker = url.as_bytes().last().copied().unwrap_or(b'a');
            Ok(("image/png".to_owned(), png(marker, 1, 1)))
        },
        limits(1024, 0, body_len * 2),
    )
    .unwrap();
    let urls = [
        format!("{IMAGE_URL}?a"),
        format!("{IMAGE_URL}?b"),
        format!("{IMAGE_URL}?c"),
    ];
    cache.get(&urls[0], true).unwrap();
    cache.get(&urls[1], true).unwrap();
    cache.get(&urls[0], false).unwrap();
    cache.get(&urls[2], true).unwrap();
    assert!(cache.get(&urls[1], false).unwrap().is_none());
    assert_eq!(
        cache.get(&urls[0], false).unwrap().unwrap()["fromCache"],
        true
    );
    assert_eq!(
        cache.get(&urls[2], false).unwrap().unwrap()["fromCache"],
        true
    );
    assert_eq!(cache.stats()["memoryEntries"], 2);

    let disk_directory = directory.0.join("disk");
    let disk = GuideImageCache::with_fetcher(
        disk_directory.clone(),
        |url, _, _| {
            let marker = url.as_bytes().last().copied().unwrap_or(b'a');
            Ok(("image/png".to_owned(), png(marker, 1, 1)))
        },
        limits(1024, body_len * 2, 0),
    )
    .unwrap();
    disk.get(&urls[0], true).unwrap();
    disk.get(&urls[1], true).unwrap();
    let mut entries = fs::read_dir(&disk_directory)
        .unwrap()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for (index, entry) in entries.into_iter().enumerate() {
        let file = File::open(entry.path()).unwrap();
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(index as u64 + 1);
        file.set_times(FileTimes::new().set_accessed(time).set_modified(time))
            .unwrap();
    }
    disk.get(&urls[2], true).unwrap();
    assert_eq!(disk.stats()["files"], 2);
    assert!(disk.stats()["diskBytes"].as_u64().unwrap() <= (body_len * 2) as u64);
}

#[test]
fn same_url_concurrent_requests_download_once() {
    let directory = TestDirectory::new();
    let started = Arc::new((Mutex::new(false), Condvar::new()));
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let fetch_started = Arc::clone(&started);
    let fetch_release = Arc::clone(&release);
    let fetch_calls = Arc::clone(&calls);
    let cache = Arc::new(
        GuideImageCache::with_fetcher(
            directory.0.join("images"),
            move |_, _, _| {
                fetch_calls.fetch_add(1, Ordering::SeqCst);
                let (started_lock, started_signal) = &*fetch_started;
                *started_lock.lock().unwrap() = true;
                started_signal.notify_all();
                let (release_lock, release_signal) = &*fetch_release;
                let mut released = release_lock.lock().unwrap();
                while !*released {
                    released = release_signal.wait(released).unwrap();
                }
                Ok(("image/png".to_owned(), png(b'a', 1, 1)))
            },
            limits(1024, 1024, 1024),
        )
        .unwrap(),
    );

    let first_cache = Arc::clone(&cache);
    let first = thread::spawn(move || first_cache.get(IMAGE_URL, true).unwrap().unwrap());
    {
        let (started_lock, started_signal) = &*started;
        let mut did_start = started_lock.lock().unwrap();
        while !*did_start {
            did_start = started_signal.wait(did_start).unwrap();
        }
    }
    let second_cache = Arc::clone(&cache);
    let second = thread::spawn(move || second_cache.get(IMAGE_URL, true).unwrap().unwrap());

    {
        let (release_lock, release_signal) = &*release;
        *release_lock.lock().unwrap() = true;
        release_signal.notify_all();
    }
    let first = first.join().unwrap();
    let second = second.join().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(first["fromCache"], false);
    assert_eq!(second["fromCache"], true);
}

#[test]
fn clear_during_download_blocks_late_refill() {
    let directory = TestDirectory::new();
    let started = Arc::new((Mutex::new(false), Condvar::new()));
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let fetch_started = Arc::clone(&started);
    let fetch_release = Arc::clone(&release);
    let cache = Arc::new(
        GuideImageCache::with_fetcher(
            directory.0.join("images"),
            move |_, _, _| {
                let (started_lock, started_signal) = &*fetch_started;
                *started_lock.lock().unwrap() = true;
                started_signal.notify_all();
                let (release_lock, release_signal) = &*fetch_release;
                let mut released = release_lock.lock().unwrap();
                while !*released {
                    released = release_signal.wait(released).unwrap();
                }
                Ok(("image/png".to_owned(), png(b'a', 1, 1)))
            },
            limits(1024, 1024, 1024),
        )
        .unwrap(),
    );
    let request_cache = Arc::clone(&cache);
    let request = thread::spawn(move || request_cache.get(IMAGE_URL, true).unwrap().unwrap());
    {
        let (started_lock, started_signal) = &*started;
        let mut did_start = started_lock.lock().unwrap();
        while !*did_start {
            did_start = started_signal.wait(did_start).unwrap();
        }
    }

    assert_eq!(cache.clear(), json!({"bytesRemoved": 0, "filesRemoved": 0}));
    {
        let (release_lock, release_signal) = &*release;
        *release_lock.lock().unwrap() = true;
        release_signal.notify_all();
    }
    assert_eq!(request.join().unwrap()["fromCache"], false);
    assert_eq!(cache.stats()["files"], 0);
    assert_eq!(cache.stats()["memoryEntries"], 0);
    assert!(cache.get(IMAGE_URL, false).unwrap().is_none());
}

#[test]
fn stats_clear_and_reads_only_touch_managed_regular_files() {
    let directory = TestDirectory::new();
    let cache_directory = directory.0.join("images");
    fs::create_dir(&cache_directory).unwrap();
    let unmanaged = cache_directory.join("metadata.json");
    fs::write(&unmanaged, b"keep").unwrap();
    let fifo = cache_directory.join(format!("{IMAGE_DIGEST}.gif"));
    make_fifo(&fifo);
    let outside = directory.0.join("outside.png");
    fs::write(&outside, png(b'o', 1, 1)).unwrap();
    std::os::unix::fs::symlink(
        &outside,
        cache_directory.join(format!("{IMAGE_DIGEST}.jpg")),
    )
    .unwrap();

    let body = png(b'a', 1, 1);
    let cache = GuideImageCache::with_fetcher(
        cache_directory.clone(),
        move |_, _, _| Ok(("image/png".to_owned(), body.clone())),
        limits(1024, 1024, 1024),
    )
    .unwrap();
    let downloaded = cache.get(IMAGE_URL, true).unwrap().unwrap();
    assert_eq!(downloaded["fromCache"], false);
    assert_eq!(cache.stats()["files"], 1);
    assert_eq!(
        cache
            .stats()
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "diskBytes",
            "diskLimitBytes",
            "files",
            "memoryBytes",
            "memoryEntries",
            "memoryLimitBytes",
        ])
    );

    assert_eq!(cache.clear()["filesRemoved"], 1);
    assert_eq!(fs::read(unmanaged).unwrap(), b"keep");
    assert_eq!(fs::read(outside).unwrap(), png(b'o', 1, 1));
    assert_eq!(cache.stats()["files"], 0);
}
