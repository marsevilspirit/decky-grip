mod common;

use common::TestDirectory;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn responses_by_id(messages: Vec<Value>) -> BTreeMap<u64, Value> {
    messages
        .into_iter()
        .filter_map(|message| message.get("id")?.as_u64().map(|id| (id, message)))
        .collect()
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
    assert_eq!(responses.len(), 15);
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
    assert_eq!(responses[&11]["result"], json!({"bytes": 0, "files": 0}));
    assert_eq!(responses[&12]["error"]["kind"], "validation");
    assert_eq!(responses[&13]["result"], Value::Null);
    assert_eq!(
        responses[&14]["result"],
        json!({"bytesRemoved": 0, "filesRemoved": 0})
    );
    assert_eq!(
        responses[&15]["result"],
        json!({
            "guides": {"bytes": 0, "files": 0},
            "images": {
                "diskBytes": 0,
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
    drop(child.stdout.take());
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(b"{\"id\":1,\"method\":\"ping\"}\n")
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
