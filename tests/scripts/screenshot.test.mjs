import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { quote, SSH_OPTIONS } from "../../scripts/deploy.mjs";
import {
  CAPTURE_SCRIPT,
  COPY_IMAGE_SCRIPT,
  screenshot,
  validatePng,
} from "../../scripts/screenshot.mjs";

// A complete, CRC-valid 1×1 grayscale/alpha PNG, including compressed image data.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("accepts a complete PNG and rejects nonbinary, truncated, or invalid image headers", () => {
  assert.deepEqual(validatePng(png), { width: 1, height: 1 });
  const zeroWidth = Buffer.from(png);
  zeroWidth.writeUInt32BE(0, 16);
  const wrongHeader = Buffer.from(png);
  wrongHeader.write("IDAT", 12, "ascii");
  for (const bytes of [
    null,
    png.toString("base64"),
    new Uint8Array(png),
    Buffer.alloc(45),
    png.subarray(0, 20),
    png.subarray(0, -1),
    Buffer.concat([png, Buffer.from("trailing output")]),
    zeroWidth,
    wrongHeader,
  ]) {
    assert.throws(() => validatePng(bytes), /未收到完整 PNG 截图/);
  }
});

test("passes the host as an SSH argument, copies the binary PNG, and removes its private temporary file", async () => {
  const calls = [];
  let imagePath;
  const size = await screenshot("deck@steamdeck.local", {
    platform: "darwin",
    runCommand: async (command, args, options) => {
      calls.push(command);
      if (command === "ssh") {
        assert.deepEqual(args, [
          ...SSH_OPTIONS,
          "deck@steamdeck.local",
          `bash -euo pipefail -c ${quote(CAPTURE_SCRIPT)}`,
        ]);
        assert.deepEqual(options, {
          capture: true,
          encoding: null,
          timeout: 30_000,
        });
        return png;
      }
      assert.equal(command, "/usr/bin/osascript");
      assert.deepEqual(args.slice(0, -1), [
        "-l",
        "JavaScript",
        "-e",
        COPY_IMAGE_SCRIPT,
      ]);
      assert.deepEqual(options, { timeout: 15_000 });
      imagePath = args.at(-1);
      assert.deepEqual(await readFile(imagePath), png);
      assert.equal((await stat(imagePath)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(imagePath))).mode & 0o777, 0o700);
    },
  });
  assert.deepEqual(calls, ["ssh", "/usr/bin/osascript"]);
  assert.deepEqual(size, { width: 1, height: 1 });
  await assert.rejects(stat(dirname(imagePath)), { code: "ENOENT" });
});

test("rejects unsafe SSH hosts before running any command", async () => {
  for (const host of ["-oProxyCommand=evil", "deck; echo injected", "$(id)"]) {
    await assert.rejects(
      screenshot(host, {
        platform: "darwin",
        runCommand: () => assert.fail("An unsafe host must not reach SSH"),
      }),
      /目标必须是 SSH 别名/,
    );
  }
});

test("rejects a non-Mac platform without contacting the Deck", async () => {
  await assert.rejects(
    screenshot("deck", {
      platform: "linux",
      runCommand: () => assert.fail("Non-Mac platforms must not run SSH"),
    }),
    /此命令需要在 Mac 上运行/,
  );
});

test("SSH failure or invalid screenshot data never reaches the clipboard", async () => {
  const disconnected = new Error("SSH disconnected");
  for (const result of [disconnected, png.subarray(0, -12)]) {
    const calls = [];
    await assert.rejects(
      screenshot(undefined, {
        platform: "darwin",
        runCommand: async (command, args) => {
          calls.push(command);
          assert.equal(command, "ssh");
          assert.equal(args.at(-2), "deck");
          if (result instanceof Error) throw result;
          return result;
        },
      }),
      result instanceof Error ? result : /未收到完整 PNG 截图/,
    );
    assert.deepEqual(calls, ["ssh"]);
  }
});

test("clipboard failure propagates while still removing the temporary PNG and directory", async () => {
  const unavailable = new Error("clipboard unavailable");
  let imagePath;
  await assert.rejects(
    screenshot("deck", {
      platform: "darwin",
      runCommand: async (command, args) => {
        if (command === "ssh") return png;
        assert.equal(command, "/usr/bin/osascript");
        imagePath = args.at(-1);
        assert.deepEqual(await readFile(imagePath), png);
        throw unavailable;
      },
    }),
    unavailable,
  );
  await assert.rejects(stat(dirname(imagePath)), { code: "ENOENT" });
});

test("capture script parses as Bash and gates full-composition output on a new completed PNG", () => {
  execFileSync("bash", ["-n"], { input: CAPTURE_SCRIPT, timeout: 5_000 });
  assert.match(
    CAPTURE_SCRIPT,
    /GAMESCOPECTRL_REQUEST_SCREENSHOT GAMESCOPECTRL_DEBUG_REQUEST_SCREENSHOT/,
  );
  assert.match(CAPTURE_SCRIPT, /32c -set GAMESCOPECTRL_REQUEST_SCREENSHOT 3/);
  assert.ok(CAPTURE_SCRIPT.includes("before=$(stat -c '%y:%s' \"$shot\")"));
  assert.ok(CAPTURE_SCRIPT.includes("\"$pending\" != *' = '* &&"));
  assert.ok(CAPTURE_SCRIPT.includes('!= "$before" &&'));
  assert.match(CAPTURE_SCRIPT, /tail -c 12/);
  assert.match(CAPTURE_SCRIPT, /0000000049454e44ae426082/);
  assert.match(CAPTURE_SCRIPT, /flock -n 9/);
  assert.match(COPY_IMAGE_SCRIPT, /image\.isValid/);
  assert.match(
    COPY_IMAGE_SCRIPT,
    /setDataForType\(data, \$\.NSPasteboardTypePNG\)/,
  );
  assert.match(COPY_IMAGE_SCRIPT, /copied\.isEqualToData\(data\)/);
});
