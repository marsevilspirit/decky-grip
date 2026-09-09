mod common;

use common::TestDirectory;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Barrier, mpsc};
use std::thread;
use std::time::{Duration, Instant};

fn responses_by_id(messages: Vec<Value>) -> BTreeMap<u64, Value> {
    messages
        .into_iter()
        .filter_map(|message| message.get("id")?.as_u64().map(|id| (id, message)))
        .collect()
}

#[test]
fn browser_import_and_reader_history_round_trip_without_relaxing_native_positions() {
    let directory = TestDirectory::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(directory.0.join("positions.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut call = |method: &str, params: Value| {
        send_and_read_response(
            &mut input,
            &mut output,
            &json!({"id": 1, "method": method, "params": params}),
        )
    };
    let id = "heybox-8a79701fa858";
    let key = format!("1113000:{id}");
    let mut guide = json!({"guideId": id, "title": "Article", "author": "Author", "sourceUrl": "https://www.xiaoheihe.cn/app/bbs/link/8a79701fa858",
        "sections": (1..=4).map(|id| json!({"id": id.to_string(), "title": "正文", "html": "a".repeat(1024 * 1024 - 1024)})).collect::<Vec<_>>(), "imageUrls": []});
    let remaining = 4 * 1024 * 1024 - serde_json::to_vec(&guide).unwrap().len();
    // Fill labels rather than one fragment, keeping every fragment below its independent budget.
    guide["sections"][3]["title"] = json!(format!("正文{}", "a".repeat(remaining)));
    assert_eq!(serde_json::to_vec(&guide).unwrap().len(), 4 * 1024 * 1024);
    let prepared = call("guides.prepare_import", json!({"guide": guide}));
    assert_eq!(prepared["ok"], true, "{prepared}");
    assert_eq!(
        call("guides.get_cached", json!({"guide_id": id}))["result"],
        Value::Null
    );
    for app_id in [json!(null), json!(1113000), json!("0"), json!("../1")] {
        let rejected = call(
            "guides.commit_import",
            json!({"guide_id": id, "token": prepared["result"]["token"], "app_id": app_id}),
        );
        assert_eq!(rejected["error"]["kind"], "validation", "{rejected}");
        assert_eq!(
            call("guides.get_cached", json!({"guide_id": id}))["result"],
            Value::Null
        );
    }
    assert_eq!(
        call(
            "guides.commit_import",
            json!({"guide_id": id, "token": prepared["result"]["token"], "app_id": "1113000"})
        )["ok"],
        true
    );
    assert_eq!(
        call("guides.list", json!({"app_id": "1113000"}))["result"][0]["guideId"],
        id
    );
    assert_eq!(
        call("reader_positions.get", json!({"guide_key": key}))["result"]["scroll_top"],
        0.0
    );
    assert_eq!(
        call("guides.download_status", json!({"guide_id": id}))["result"]["state"],
        "complete"
    );
    assert_eq!(
        call(
            "positions.save",
            json!({"guide_key": key, "scroll_top": 50})
        )["ok"],
        false
    );
    assert_eq!(
        call(
            "positions.save",
            json!({"guide_key": "1113000:123", "scroll_top": 99})
        )["ok"],
        true
    );
    assert_eq!(
        call(
            "reader_positions.save",
            json!({"guide_key": key, "scroll_top": 50, "section_id": "1", "anchor_text": null, "anchor_offset": 0})
        )["ok"],
        true
    );
    assert_eq!(
        call("reader_positions.get", json!({"guide_key": key}))["result"]["scroll_top"],
        50.0
    );
    let library = call("guides.list", json!({"app_id": "1113000"}));
    assert_eq!(library["result"][0]["guideId"], id);
    assert_eq!(library["result"][0]["cache"]["title"], "Article");
    let bookmark = call("reader_positions.get", json!({"guide_key": key}))["result"].clone();
    let replacement = json!({"guideId": id, "title": "Updated", "author": "Author", "sourceUrl": "https://www.xiaoheihe.cn/app/bbs/link/8a79701fa858",
        "sections": [{"id": "1", "title": "正文", "html": "<p>Updated content</p>"}], "imageUrls": []});
    let prepared = call("guides.prepare_import", json!({"guide": replacement}));
    assert_eq!(
        call(
            "guides.commit_import",
            json!({"guide_id": id, "token": prepared["result"]["token"], "app_id": "1113000"})
        )["ok"],
        true
    );
    let updated = call("reader_positions.get", json!({"guide_key": key}))["result"].clone();
    for field in ["scroll_top", "section_id", "anchor_text", "anchor_offset"] {
        assert_eq!(updated[field], bookmark[field]);
    }
    assert!(
        updated["updated_at_ms"].as_u64().unwrap() > bookmark["updated_at_ms"].as_u64().unwrap()
    );
    assert_eq!(
        call("positions.snapshot", json!({}))["result"]["1113000:123"]["scroll_top"],
        99.0
    );
    assert_eq!(
        call("guides.remove_offline", json!({"guide_id": id}))["ok"],
        true
    );
    assert_eq!(
        call("reader_positions.get", json!({"guide_key": key}))["result"]["scroll_top"],
        50.0
    );
    assert_eq!(
        call("guides.list", json!({"app_id": "1113000"}))["result"],
        json!([])
    );
    assert_eq!(
        call("imports.phone_get", json!({"session_id": "missing"}))["result"],
        json!({"state": "expired"})
    );
    assert_eq!(
        call("imports.phone_stop", json!({"session_id": 1}))["error"]["kind"],
        "validation"
    );
    assert_eq!(
        call("imports.shutdown", json!({"unexpected": true}))["error"]["kind"],
        "protocol"
    );
    assert_eq!(
        call(
            "imports.capture",
            json!({"source_url": "http://example.invalid", "marker": "a".repeat(32)})
        )["ok"],
        false
    );
    assert_eq!(call("imports.shutdown", json!({}))["ok"], true);
    // Closed resources cannot start listeners or attach to the local CEF endpoint.
    assert!(
        call("imports.phone_start", json!({}))["error"]["message"]
            .as_str()
            .unwrap()
            .contains("卸载")
    );
    assert!(call("imports.capture", json!({"source_url": "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed", "marker": "a".repeat(32)}))["error"]["message"].as_str().unwrap().contains("卸载"));
    assert_eq!(
        call("imports.cancel_capture", json!({"marker": "a".repeat(32)}))["ok"],
        true
    );
    assert_eq!(call("imports.shutdown", json!({}))["ok"], true);
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[test]
fn offline_transactions_round_trip_through_the_real_process() {
    let directory = TestDirectory::new();
    let guides = directory.0.join("guides");
    fs::create_dir(&guides).unwrap();
    let body = json!({"schemaVersion": 1, "guideId": "1", "title": "Old", "author": "A", "fetchedAt": 1,
        "sourceUrl": "https://steamcommunity.com/sharedfiles/filedetails/?id=1&l=schinese",
        "sections": [{"id": "1", "title": "Chapter", "html": "<p>Offline body</p>"}]});
    let path = guides.join("1.json");
    fs::write(&path, serde_json::to_vec(&body).unwrap()).unwrap();
    let original = fs::read(&path).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(directory.0.join("positions.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut call = |method: &str, params: Value| {
        send_and_read_response(
            &mut input,
            &mut output,
            &json!({"id": 1, "method": method, "params": params}),
        )
    };
    assert_eq!(
        call(
            "guides.prepare",
            json!({"guide_id": "1", "force_refresh": "yes"})
        )["error"]["kind"],
        "validation"
    );
    let prepared = call(
        "guides.prepare",
        json!({"guide_id": "1", "force_refresh": false}),
    );
    assert_eq!(prepared["ok"], true);
    let token = &prepared["result"]["token"];
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(
        call("guides.commit", json!({"guide_id": "1", "token": "wrong"}))["ok"],
        false
    );
    assert_eq!(
        call("guides.discard", json!({"guide_id": "1", "token": "wrong"}))["result"],
        false
    );
    let committed = call("guides.commit", json!({"guide_id": "1", "token": token}));
    assert_eq!(committed["ok"], true, "{committed}");
    assert_eq!(committed["result"]["offline"], true);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap()["schemaVersion"],
        2
    );
    assert_eq!(
        call("guides.download_status", json!({"guide_id": "1"}))["result"]["state"],
        "complete"
    );
    let prepared = call(
        "guides.prepare",
        json!({"guide_id": "1", "force_refresh": false}),
    );
    assert_eq!(
        call(
            "guides.discard",
            json!({"guide_id": "1", "token": prepared["result"]["token"]})
        )["result"],
        true
    );
    assert_eq!(
        call(
            "guides.commit",
            json!({"guide_id": "1", "token": prepared["result"]["token"]})
        )["ok"],
        false
    );
    drop(input);
    assert!(child.wait().unwrap().success());
}

fn send_and_expect_ok(input: &mut impl Write, output: &mut impl BufRead, request: &Value) {
    let response = send_and_read_response(input, output, request);
    assert_eq!(response["ok"], true, "{response}");
}

fn send_and_read_response(
    input: &mut impl Write,
    output: &mut impl BufRead,
    request: &Value,
) -> Value {
    serde_json::to_writer(&mut *input, request).unwrap();
    input.write_all(b"\n").unwrap();
    input.flush().unwrap();

    loop {
        let mut line = String::new();
        assert_ne!(output.read_line(&mut line).unwrap(), 0);
        let response: Value = serde_json::from_str(&line).unwrap();
        if response.get("id") == request.get("id") {
            return response;
        }
    }
}

fn run_concurrent_store_writer(positions_path: PathBuf, app_id: u64, barrier: Arc<Barrier>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(&positions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());

    barrier.wait();
    for index in 1..=32_u64 {
        let guide_key = format!("{app_id}:{index}");
        send_and_expect_ok(
            &mut input,
            &mut output,
            &json!({
                "id": index * 2 - 1,
                "method": "positions.save",
                "params": {"guide_key": guide_key, "scroll_top": index},
            }),
        );
        send_and_expect_ok(
            &mut input,
            &mut output,
            &json!({
                "id": index * 2,
                "method": "reader_positions.save",
                "params": {
                    "guide_key": guide_key,
                    "scroll_top": index,
                    "section_id": null,
                    "anchor_text": null,
                    "anchor_offset": 0,
                },
            }),
        );
    }
    drop(input);
    output.read_to_end(&mut Vec::new()).unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "sidecar exited with {status}");
}

#[test]
fn json_lines_process_handles_ping_repair_and_position_lifecycle() {
    let directory = TestDirectory::new();
    let positions_path = directory.0.join("positions.json");
    let corrupt = b"{ broken";
    fs::write(&positions_path, corrupt).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(&positions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"id": 1, "method": "ping"}),
        json!({"id": 2, "method": "positions.snapshot"}),
        json!({"id": 3, "method": "positions.repair"}),
        json!({"id": 4, "method": "positions.save", "params": {"guide_key": "1:90071992547409931234", "scroll_top": 12.5}}),
        json!({"id": 5, "method": "positions.snapshot"}),
        json!({"id": 6, "method": "positions.save", "params": {"guide_key": "0:2", "scroll_top": 3}}),
        json!({"id": 7, "method": "hotkey.status"}),
        json!({"id": 8, "method": "guides.get", "params": {"guide_id": "0", "force_refresh": false}}),
        json!({"id": 9, "method": "guides.get_cached", "params": {"guide_id": "3414883877"}}),
        json!({"id": 10, "method": "guides.clear"}),
        json!({"id": 11, "method": "guides.stats"}),
        json!({"id": 12, "method": "images.get", "params": {"url": "http://evil.example/image.png", "allow_download": false}}),
        json!({"id": 13, "method": "images.get", "params": {"url": "https://images.steamusercontent.com/ugc/example/image.png", "allow_download": false}}),
        json!({"id": 14, "method": "images.clear"}),
        json!({"id": 15, "method": "reader_cache.stats"}),
        json!({"id": 16, "method": "images.download", "params": {"url": "http://evil.example/image.png"}}),
        json!({"id": 17, "method": "guides.download_status", "params": {"guide_id": "3414883877"}}),
        json!({"id": 18, "method": "guides.download_status", "params": {"guide_id": "0"}}),
    ];
    {
        let input = child.stdin.as_mut().unwrap();
        for request in requests {
            serde_json::to_writer(&mut *input, &request).unwrap();
            input.write_all(b"\n").unwrap();
        }
    }
    drop(child.stdin.take());

    let responses = responses_by_id(
        BufReader::new(child.stdout.take().unwrap())
            .lines()
            .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
            .collect(),
    );
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(responses.len(), 18);
    assert_eq!(
        responses[&17]["result"],
        json!({"state": "missing", "completed": 0, "total": 0})
    );
    assert_eq!(responses[&18]["error"]["kind"], "validation");
    assert_eq!(responses[&16]["error"]["kind"], "validation");
    assert_eq!(
        responses[&1]["result"],
        json!({
            "version": 2,
            "capabilities": ["positions", "reader_positions", "guides", "images", "hotkey", "multiplex"],
        })
    );
    assert_eq!(responses[&2]["error"]["kind"], "storage");
    assert_eq!(responses[&3]["result"]["repaired"], true);
    let backup = PathBuf::from(responses[&3]["result"]["backup"].as_str().unwrap());
    assert_eq!(fs::read(backup).unwrap(), corrupt);
    assert_eq!(
        responses[&5]["result"]["1:90071992547409931234"]["scroll_top"],
        12.5
    );
    assert_eq!(responses[&6]["error"]["kind"], "validation");
    assert_eq!(responses[&7]["result"]["button"], "L4");
    assert_eq!(responses[&7]["result"]["running"], true);
    assert_eq!(responses[&8]["error"]["kind"], "validation");
    assert_eq!(responses[&9]["result"], Value::Null);
    assert_eq!(
        responses[&10]["result"],
        json!({"bytesRemoved": 0, "filesRemoved": 0})
    );
    assert_eq!(
        responses[&11]["result"],
        json!({
            "bytes": 0,
            "diskLimitBytes": 256 * 1024 * 1024,
            "files": 0,
            "memoryBytes": 0,
            "memoryEntries": 0,
            "memoryLimitBytes": 32 * 1024 * 1024,
        })
    );
    assert_eq!(responses[&12]["error"]["kind"], "validation");
    assert_eq!(responses[&13]["result"], Value::Null);
    assert_eq!(
        responses[&14]["result"],
        json!({"bytesRemoved": 0, "filesRemoved": 0})
    );
    assert_eq!(
        responses[&15]["result"],
        json!({
            "guides": {
                "bytes": 0,
                "diskLimitBytes": 256 * 1024 * 1024,
                "files": 0,
                "memoryBytes": 0,
                "memoryEntries": 0,
                "memoryLimitBytes": 32 * 1024 * 1024,
            },
            "images": {
                "diskBytes": 0,
                "offlineBytes": 0,
                "diskLimitBytes": 128 * 1024 * 1024,
                "files": 0,
                "memoryBytes": 0,
                "memoryEntries": 0,
                "memoryLimitBytes": 24 * 1024 * 1024,
            },
        })
    );
    assert_eq!(
        fs::metadata(positions_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn offline_admin_protocol_validates_inputs_and_restores_quota_after_restart() {
    let directory = TestDirectory::new();
    for run in 0..2 {
        let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
            .arg(directory.0.join("positions.json"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        if run == 0 {
            let response = send_and_read_response(
                &mut input,
                &mut output,
                &json!({"id":1,"method":"images.set_limit","params":{"bytes":268435456}}),
            );
            assert_eq!(response["ok"], true, "{response}");
            assert_eq!(response["result"]["diskLimitBytes"], 268435456);
            for (method, params) in [
                ("images.set_limit", json!({"bytes":1})),
                ("images.set_limit", json!({"bytes":true})),
                ("guides.remove_offline", json!({"guide_id":"../1"})),
            ] {
                let response = send_and_read_response(
                    &mut input,
                    &mut output,
                    &json!({"id":2,"method":method,"params":params}),
                );
                assert_eq!(response["error"]["kind"], "validation", "{response}");
            }
        }
        let stats = send_and_read_response(
            &mut input,
            &mut output,
            &json!({"id":3,"method":"reader_cache.stats"}),
        );
        assert_eq!(stats["result"]["images"]["diskLimitBytes"], 268435456);
        let removed = send_and_read_response(
            &mut input,
            &mut output,
            &json!({"id":4,"method":"guides.remove_offline","params":{"guide_id":"1"}}),
        );
        assert_eq!(
            removed["result"],
            json!({"filesRemoved":0,"bytesRemoved":0})
        );
        drop(input);
        output.read_to_end(&mut Vec::new()).unwrap();
        assert!(child.wait().unwrap().success());
    }
}

#[test]
fn json_lines_process_uses_the_sibling_reader_position_store() {
    let directory = TestDirectory::new();
    let positions_path = directory.0.join("positions.json");
    let reader_positions_path = directory.0.join("reader_positions.json");
    let corrupt = b"{ broken reader positions";
    fs::write(&reader_positions_path, corrupt).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(&positions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"id": 1, "method": "ping"}),
        json!({"id": 2, "method": "reader_positions.get", "params": {"guide_key": "1113000:3414883877"}}),
        json!({"id": 3, "method": "reader_positions.repair"}),
        json!({"id": 4, "method": "reader_positions.save", "params": {
            "guide_key": "1113000:3414883877",
            "scroll_top": 4040.25,
            "section_id": "7667220",
            "anchor_text": "去河堤下方与老人对话",
            "anchor_offset": -17.5
        }}),
        json!({"id": 5, "method": "reader_positions.get", "params": {"guide_key": "1113000:3414883877"}}),
        json!({"id": 6, "method": "reader_positions.save", "params": {
            "guide_key": "1:2",
            "scroll_top": 3,
            "section_id": null,
            "anchor_text": null
        }}),
    ];
    {
        let input = child.stdin.as_mut().unwrap();
        for request in requests {
            serde_json::to_writer(&mut *input, &request).unwrap();
            input.write_all(b"\n").unwrap();
        }
    }
    drop(child.stdin.take());

    let responses = responses_by_id(
        BufReader::new(child.stdout.take().unwrap())
            .lines()
            .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
            .collect(),
    );
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(responses.len(), 6);
    assert_eq!(
        responses[&1]["result"],
        json!({
            "version": 2,
            "capabilities": ["positions", "reader_positions", "guides", "images", "hotkey", "multiplex"],
        })
    );
    assert_eq!(responses[&2]["error"]["kind"], "storage");
    assert_eq!(responses[&3]["result"]["repaired"], true);
    let backup = PathBuf::from(responses[&3]["result"]["backup"].as_str().unwrap());
    assert_eq!(fs::read(backup).unwrap(), corrupt);
    assert_eq!(responses[&4]["result"]["scroll_top"], 4040.25);
    assert_eq!(responses[&4]["result"]["section_id"], "7667220");
    assert_eq!(
        responses[&4]["result"]["anchor_text"],
        "去河堤下方与老人对话"
    );
    assert_eq!(responses[&4]["result"]["anchor_offset"], -17.5);
    assert_eq!(responses[&5]["result"], responses[&4]["result"]);
    assert_eq!(responses[&6]["error"]["kind"], "protocol");
    assert_eq!(
        fs::metadata(reader_positions_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(!positions_path.exists());
}

#[test]
fn guide_library_joins_recent_reader_positions_with_cached_metadata() {
    let directory = TestDirectory::new();
    let positions_path = directory.0.join("positions.json");
    let reader_positions_path = directory.0.join("reader_positions.json");
    let guides_path = directory.0.join("guides");
    fs::create_dir(&guides_path).unwrap();
    fs::write(
        &reader_positions_path,
        serde_json::to_vec(&json!({
            "positions": {
                "1113000:3414883877": {
                    "anchor_offset": 0,
                    "anchor_text": "正文",
                    "scroll_top": 100,
                    "section_id": "7667220",
                    "updated_at_ms": 300,
                },
                "1113000:3414883878": {
                    "anchor_offset": 0,
                    "anchor_text": null,
                    "scroll_top": 0,
                    "section_id": null,
                    "updated_at_ms": 200,
                },
                "222:3414883879": {
                    "anchor_offset": 0,
                    "anchor_text": null,
                    "scroll_top": 0,
                    "section_id": null,
                    "updated_at_ms": 400,
                },
            },
            "schema_version": 1,
        }))
        .unwrap(),
    )
    .unwrap();
    for guide_id in ["3414883877", "3414883879"] {
        fs::write(
            guides_path.join(format!("{guide_id}.json")),
            serde_json::to_vec(&json!({
                "author": "测试作者",
                "fetchedAt": 1,
                "guideId": guide_id,
                "schemaVersion": 1,
                "sections": [{"html": "<p>正文</p>", "id": "7667220", "title": "四月"}],
                "sourceUrl": format!("https://steamcommunity.com/sharedfiles/filedetails/?id={guide_id}&l=schinese"),
                "title": "完整攻略",
            }))
            .unwrap(),
        )
        .unwrap();
    }
    let reader_history = fs::read(&reader_positions_path).unwrap();
    let other_body = fs::read(guides_path.join("3414883879.json")).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(&positions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());

    let current_app = send_and_read_response(
        &mut input,
        &mut output,
        &json!({"id": 1, "method": "guides.list", "params": {"app_id": "1113000"}}),
    );
    assert_eq!(current_app["ok"], true);
    assert_eq!(current_app["result"].as_array().unwrap().len(), 1);
    assert_eq!(current_app["result"][0]["guideId"], "3414883877");
    assert_eq!(current_app["result"][0]["cache"]["title"], "完整攻略");
    assert_eq!(current_app["result"][0]["cache"]["sectionTitle"], "四月");

    let all = send_and_read_response(
        &mut input,
        &mut output,
        &json!({"id": 2, "method": "guides.list", "params": {"app_id": null}}),
    );
    assert_eq!(all["result"].as_array().unwrap().len(), 2);
    assert_eq!(all["result"][0]["appId"], "222");
    assert_eq!(all["result"][1]["appId"], "1113000");

    let invalid = send_and_read_response(
        &mut input,
        &mut output,
        &json!({"id": 3, "method": "guides.list", "params": {"app_id": "0"}}),
    );
    assert_eq!(invalid["error"]["kind"], "validation");

    let removed = send_and_read_response(
        &mut input,
        &mut output,
        &json!({"id": 4, "method": "guides.remove_offline", "params": {"guide_id": "3414883877"}}),
    );
    assert_eq!(removed["result"]["filesRemoved"], 1);
    let after_remove = send_and_read_response(
        &mut input,
        &mut output,
        &json!({"id": 5, "method": "guides.list", "params": {"app_id": "1113000"}}),
    );
    assert_eq!(after_remove["result"], json!([]));
    let remaining = send_and_read_response(
        &mut input,
        &mut output,
        &json!({"id": 6, "method": "guides.list", "params": {"app_id": null}}),
    );
    assert_eq!(remaining["result"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["result"][0]["guideId"], "3414883879");
    assert!(!guides_path.join("3414883877.json").exists());
    assert_eq!(fs::read(&reader_positions_path).unwrap(), reader_history);
    assert_eq!(
        fs::read(guides_path.join("3414883879.json")).unwrap(),
        other_body
    );

    drop(input);
    output.read_to_end(&mut Vec::new()).unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn guide_library_returns_twenty_cached_entries_after_newer_missing_bodies() {
    let directory = TestDirectory::new();
    let positions_path = directory.0.join("positions.json");
    let reader_positions_path = directory.0.join("reader_positions.json");
    let reader_positions = (1_u64..=52)
        .map(|guide_id| {
            (
                format!("1:{guide_id}"),
                json!({
                    "anchor_offset": 0,
                    "anchor_text": null,
                    "scroll_top": 0,
                    "section_id": null,
                    "updated_at_ms": 10_000 - guide_id * 100,
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    fs::write(
        &reader_positions_path,
        serde_json::to_vec(&json!({
            "positions": reader_positions,
            "schema_version": 1,
        }))
        .unwrap(),
    )
    .unwrap();
    let guides_path = directory.0.join("guides");
    fs::create_dir(&guides_path).unwrap();
    for guide_id in 26_u64..=52 {
        fs::write(
            guides_path.join(format!("{guide_id}.json")),
            serde_json::to_vec(&json!({
                "author": "Author",
                "fetchedAt": 1,
                "guideId": guide_id.to_string(),
                "schemaVersion": 1,
                "sections": [{"html": "<p>Body</p>", "id": "1", "title": "Chapter"}],
                "sourceUrl": format!("https://steamcommunity.com/sharedfiles/filedetails/?id={guide_id}&l=schinese"),
                "title": "Guide",
            }))
            .unwrap(),
        )
        .unwrap();
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(&positions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let response = send_and_read_response(
        &mut input,
        &mut output,
        &json!({"id": 1, "method": "guides.list", "params": {"app_id": "1"}}),
    );
    assert_eq!(response["ok"], true);
    let entries = response["result"].as_array().unwrap();
    assert_eq!(entries.len(), 20);
    for (entry, guide_id) in entries.iter().zip(26_u64..=45) {
        assert_eq!(entry["guideId"], guide_id.to_string());
        assert_eq!(entry["cache"]["title"], "Guide");
        assert!(entry.get("favorite").is_none());
    }

    drop(input);
    output.read_to_end(&mut Vec::new()).unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn concurrent_sidecars_preserve_disjoint_store_writes() {
    let directory = TestDirectory::new();
    let positions_path = directory.0.join("positions.json");
    let reader_positions_path = directory.0.join("reader_positions.json");
    let barrier = Arc::new(Barrier::new(2));
    let writers: Vec<_> = [1_u64, 2]
        .into_iter()
        .map(|app_id| {
            let positions_path = positions_path.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || run_concurrent_store_writer(positions_path, app_id, barrier))
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }

    for path in [&positions_path, &reader_positions_path] {
        let document: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let positions = document["positions"].as_object().unwrap();
        assert_eq!(positions.len(), 64);
        for app_id in [1_u64, 2] {
            for index in 1..=32_u64 {
                assert!(positions.contains_key(&format!("{app_id}:{index}")));
            }
        }
        let mut lock_name = path.file_name().unwrap().to_os_string();
        lock_name.push(".lock");
        let lock = fs::metadata(path.with_file_name(lock_name)).unwrap();
        assert!(lock.is_file());
        assert_eq!(lock.permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn oversized_json_line_terminates_the_process() {
    let directory = TestDirectory::new();
    let positions_path = directory.0.join("positions.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(&positions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child
        .stdin
        .take()
        .unwrap()
        .write_all(&vec![b' '; 64 * 1024 + 1]);

    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("request exceeds 64 KiB"));
    assert!(!positions_path.exists());
}

#[test]
fn broken_stdout_terminates_even_while_stdin_stays_open() {
    let directory = TestDirectory::new();
    let positions_path = directory.0.join("positions.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_grip-sidecar"))
        .arg(&positions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    // Bound startup separately so the shutdown deadline measures a running sidecar.
    let (ready, started) = mpsc::sync_channel(1);
    let startup = thread::spawn(move || {
        send_and_expect_ok(&mut input, &mut output, &json!({"id": 1, "method": "ping"}));
        let _ = ready.send((input, output));
    });
    let (mut input, output) = match started.recv_timeout(Duration::from_secs(5)) {
        Ok(streams) => streams,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = startup.join();
            panic!("sidecar startup ping failed: {error}");
        }
    };
    startup.join().unwrap();
    drop(output);
    input
        .write_all(b"{\"id\":2,\"method\":\"ping\"}\n")
        .unwrap();
    input.flush().unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("sidecar stayed alive after stdout disconnected");
        }
        thread::sleep(Duration::from_millis(10));
    };
    drop(input);

    assert!(!status.success());
    assert!(!positions_path.exists());
}
