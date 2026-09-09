import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  deploy,
  evaluate,
  installExpression,
  quote,
  RPC_CHECK,
  SSH_OPTIONS,
  validateHost,
  verifyInstalled,
  verifySettings,
  waitFor,
} from "../../scripts/deploy.mjs";

test("deployment preserves downloaded guides without requiring old uninstalled placeholders", async () => {
  const cached = { appId: "1113000", guideId: "2130870345", cache: {} };
  const removed = { appId: "1113000", guideId: "2977774727", cache: null };
  for (const entries of [[cached, removed], [cached]]) {
    const result = await vm.runInNewContext(RPC_CHECK, {
      DeckyBackend: {
        call: async (_method, _plugin, method) =>
          method === "get_guide_library"
            ? entries
            : { running: true, available: true },
      },
      DeckyPluginLoader: { plugins: [{ name: "GRIP" }] },
    });
    assert.deepEqual(Array.from(result.guides), ["1113000:2130870345"]);
    assert.equal(result.loaded, true);
    assert.equal(result.hotkey.running, true);
  }
});

test("SSH inputs cannot become command options or shell expansions", () => {
  for (const host of ["deck", "deck@steamdeck.local", "deck@172.20.10.2"])
    assert.equal(validateHost(host), host);
  for (const host of [
    "-oProxyCommand=bad",
    "deck; touch bad",
    "$(bad)",
    "",
    "deck\nother",
  ])
    assert.throws(() => validateHost(host), /SSH/);
  const value = "path with space/'quote'; $(no-command)";
  assert.equal(
    execFileSync("sh", ["-c", `printf '%s' ${quote(value)}`], {
      encoding: "utf8",
    }),
    value,
  );
});

test("requests only the named native reinstall, without auto-confirming or touching other plugins", async () => {
  const calls = [];
  const pkg = { version: "0.3.10", sha256: "a".repeat(64) };
  const path = "/tmp/grip-deploy-12345678/grip.zip";
  await vm.runInNewContext(installExpression(path, pkg), {
    DeckyBackend: {
      call: (...args) => {
        calls.push(args);
        return Promise.resolve(null);
      },
    },
  });
  assert.deepEqual(calls, [
    [
      "utilities/install_plugin",
      `file://${path}`,
      "GRIP",
      pkg.version,
      pkg.sha256,
      1,
    ],
  ]);
});

test("settings inventories preserve complete NUL-delimited paths while allowing new files", () => {
  const paths = [
    "/settings/decky-grip",
    "/settings/decky-grip/with space",
    "/settings/decky-grip/with'quote",
    "/settings/decky-grip/with\nnewline",
  ];
  const inventory = (entries) => entries.join("\0") + "\0";
  assert.doesNotThrow(() =>
    verifySettings(
      inventory(paths),
      inventory([...paths].reverse().concat("/settings/new")),
    ),
  );
  assert.doesNotThrow(() => verifySettings("", inventory(paths)));
  for (const missing of paths) {
    assert.throws(
      () =>
        verifySettings(
          inventory(paths),
          inventory(paths.filter((path) => path !== missing)),
        ),
      (error) => error.message === `设置文件丢失：${missing}`,
    );
  }
  assert.throws(
    () =>
      verifySettings(
        "/settings/a\n/settings/b\0",
        "/settings/a\0/settings/b\0",
      ),
    /设置文件丢失/,
  );
});

test("deployment keeps unverified packages and cleans only the exact verified staging directory", async (t) => {
  const remoteDir = "/tmp/grip-deploy-12345678";
  const remoteZip = `${remoteDir}/grip.zip`;
  const pkg = {
    directory: "/local/package",
    archive: "/local/package/grip.zip",
    version: "0.3.10",
    sha256: "a".repeat(64),
    files: {
      "dist/index.js": "b".repeat(64),
      "bin/grip-sidecar": "c".repeat(64),
    },
  };
  const shell = (command) => `bash -euo pipefail -c ${quote(command)}`;
  const cleanup = shell(
    `rm -- ${quote(remoteZip)} && rmdir -- ${quote(remoteDir)}`,
  );

  async function execute(failure, directory = remoteDir) {
    const events = [];
    const receipts = [];
    const commands = [];
    const warnings = [];
    const process = new EventEmitter();
    const tunnel = new EventEmitter();
    tunnel.kill = (signal) => events.push(`kill:${signal}`);
    let installed = false;
    let settingsRead = false;
    let now = 0;
    let error;
    try {
      await vm.runInNewContext(`(${deploy.toString()})("deck")`, {
        validateHost,
        quote,
        SSH_OPTIONS,
        installExpression,
        verifyInstalled,
        HOMEBREW: "/home/deck/homebrew",
        PLUGIN: "/home/deck/homebrew/plugins/decky-grip",
        RPC_CHECK: "rpc-check",
        WebSocket: class {},
        AbortController,
        process,
        join,
        Date: { now: () => now },
        console: {
          log() {},
          error() {},
          warn: (message) => warnings.push(message),
        },
        createServer: () => ({
          once() {},
          listen(_port, _host, done) {
            done();
          },
          address: () => ({ port: 12345 }),
          close(done) {
            done();
          },
        }),
        spawn: (command) => {
          assert.equal(command, "ssh");
          return tunnel;
        },
        buildPackage: async () => {
          events.push("build");
          return pkg;
        },
        writeFile: async (path, data) => {
          assert.equal(path, "/local/package/deployment.json");
          receipts.push(JSON.parse(data));
        },
        // Execute the real acceptance callbacks; only advance their clock instead of sleeping.
        waitFor: async (check, _timeout, _interval, signal) => {
          let lastError;
          for (let attempt = 0; attempt < 2; attempt++) {
            signal.throwIfAborted();
            try {
              return await check();
            } catch (error) {
              lastError = error;
            }
            now += 16000;
          }
          throw lastError;
        },
        evaluate: async (_port, expression) => {
          if (expression !== "rpc-check") {
            assert.equal(expression, installExpression(remoteZip, pkg));
            events.push("install");
            installed = true;
            if (failure === "interrupt") process.emit("SIGINT");
            return null;
          }
          events.push(installed ? "rpc" : "baseline");
          return {
            loaded: true,
            hotkey: { running: true, available: true },
            guides: ["1:a"],
          };
        },
        verifySettings: (before, after) => {
          events.push("settings-check");
          verifySettings(before, after);
        },
        run: async (command, args, { signal }) => {
          signal.throwIfAborted();
          commands.push([command, ...args]);
          if (command === "scp") {
            assert.deepEqual(Array.from(args), [
              ...SSH_OPTIONS,
              pkg.archive,
              `deck:${remoteZip}`,
            ]);
            events.push("upload");
            return "";
          }
          assert.equal(command, "ssh");
          assert.equal(args.at(-2), "deck");
          const script = args.at(-1);
          if (script.includes("uname -m")) {
            events.push("preflight");
            return "";
          }
          if (script.includes("mktemp -d")) {
            events.push("mktemp");
            return directory;
          }
          if (script.includes("find ")) {
            const after = settingsRead;
            settingsRead = true;
            events.push(after ? "settings-after" : "settings-before");
            return after && failure === "settings"
              ? ""
              : "/settings/bookmark\0";
          }
          if (script.includes("unzip -tq")) {
            events.push("zip-check");
            return "";
          }
          if (script.includes("pgrep -f")) {
            events.push(installed ? "snapshot-after" : "snapshot-before");
            const pids =
              installed && failure !== "not-confirmed" ? "20 21" : "10 11";
            return (
              `PIDS ${pids}\n` +
              Object.entries(pkg.files)
                .map(
                  ([file, hash]) =>
                    `${hash}  /home/deck/homebrew/plugins/decky-grip/${file}`,
                )
                .join("\n")
            );
          }
          if (script === shell("date +%s")) {
            events.push("date");
            return "1234567890";
          }
          if (script.includes("journalctl")) {
            events.push("ready");
            return failure === "ready"
              ? "GRIP backend ready"
              : "GRIP Rust sidecar ready\nGRIP backend ready";
          }
          assert.equal(
            script,
            cleanup,
            "no unexpected remote mutation or backup command",
          );
          events.push("cleanup");
          if (failure === "cleanup") throw Error("cleanup denied");
          return "";
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal(process.listenerCount("SIGINT"), 0);
    assert.equal(process.listenerCount("SIGTERM"), 0);
    assert.equal(events.at(-1), "kill:SIGTERM");
    assert.equal(
      commands.some((args) =>
        /\btar\b|deployment-backups/.test(args.join(" ")),
      ),
      false,
    );
    assert.equal(
      receipts.some((receipt) => "backup" in receipt),
      false,
    );
    return { events, receipt: receipts.at(-1), error, warnings };
  }

  await t.test(
    "verified package is removed only after all acceptance gates",
    async () => {
      const result = await execute();
      assert.equal(result.error, undefined);
      assert.deepEqual(result.events, [
        "preflight",
        "baseline",
        "build",
        "mktemp",
        "settings-before",
        "upload",
        "zip-check",
        "snapshot-before",
        "date",
        "install",
        "snapshot-after",
        "rpc",
        "snapshot-after",
        "rpc",
        "ready",
        "settings-after",
        "settings-check",
        "cleanup",
        "kill:SIGTERM",
      ]);
      assert.equal(result.receipt.state, "verified");
      assert.equal(result.receipt.remoteZipRemoved, true);
      assert.equal(result.receipt.remoteZip, remoteZip);
      assert.equal(result.receipt.verified.pids, "20 21");
    },
  );
  for (const [failure, message] of [
    ["interrupt", /已中断/],
    ["not-confirmed", /重载/],
    ["ready", /ready 日志/],
    ["settings", /设置文件丢失/],
  ]) {
    await t.test(
      `${failure} leaves the installer package untouched`,
      async () => {
        const result = await execute(failure);
        assert.match(result.error?.message ?? "", message);
        assert.equal(result.events.includes("cleanup"), false);
        assert.equal(result.receipt.state, "failed");
        assert.equal(result.receipt.remoteZip, remoteZip);
        assert.equal(result.receipt.remoteZipRemoved, undefined);
      },
    );
  }
  await t.test(
    "cleanup failure does not turn a verified deployment into failure",
    async () => {
      const result = await execute("cleanup");
      assert.equal(result.error, undefined);
      assert.equal(result.receipt.state, "verified");
      assert.equal(result.receipt.cleanupError, "cleanup denied");
      assert.equal(result.receipt.remoteZipRemoved, undefined);
      assert.equal(result.receipt.error, undefined);
      assert.match(result.warnings[0], /临时包清理失败/);
    },
  );
  await t.test(
    "unexpected staging paths are rejected before upload or install",
    async () => {
      for (const directory of [
        "/tmp",
        "/tmp/grip-deploy-12345678/../other",
        "/tmp/grip-deploy-12345678; touch bad",
        "/home/deck/grip-deploy-12345678",
      ]) {
        const result = await execute(undefined, directory);
        assert.match(result.error?.message ?? "", /意外的部署目录/);
        assert.equal(result.events.includes("upload"), false);
        assert.equal(result.events.includes("install"), false);
        assert.equal(result.events.includes("cleanup"), false);
        assert.equal(result.receipt, undefined);
      }
    },
  );
});

test("installer completion is insufficient: require every deployed hash and a new process pair", () => {
  const files = {
    "dist/index.js": "a".repeat(64),
    "bin/grip-sidecar": "b".repeat(64),
  };
  const output =
    "PIDS 10 11\n" +
    Object.entries(files)
      .map(
        ([file, hash]) =>
          `${hash}  /home/deck/homebrew/plugins/decky-grip/${file}`,
      )
      .join("\n");
  assert.equal(verifyInstalled(output, files, "8 9"), "10 11");
  assert.throws(() => verifyInstalled(output, files, "10 11"), /重载/);
  assert.throws(() => verifyInstalled(output, files, "10 9"), /重载/);
  assert.throws(() => verifyInstalled(output, files, "8 11"), /重载/);
  assert.throws(
    () =>
      verifyInstalled(
        output.replace(files["dist/index.js"], "c".repeat(64)),
        files,
        "8 9",
      ),
    /index.js/,
  );
  assert.throws(
    () =>
      verifyInstalled(output.split("\n").slice(0, 2).join("\n"), files, "8 9"),
    /sidecar/,
  );
  assert.throws(
    () => verifyInstalled("plugin_download_finish", files, "8 9"),
    /重载/,
  );
});

test("polling retries transient failures but remains bounded and interruptible", async () => {
  let attempts = 0;
  assert.equal(
    await waitFor(
      async () => {
        if (++attempts < 2) throw Error("warming");
        return 7;
      },
      100,
      1,
    ),
    7,
  );
  await assert.rejects(
    waitFor(
      async () => {
        throw Error("still offline");
      },
      2,
      1,
    ),
    /超时.*offline/,
  );
  await assert.rejects(
    waitFor(
      async () => assert.fail("should not run"),
      100,
      1,
      AbortSignal.abort(),
    ),
    { name: "AbortError" },
  );
});

test("CEF calls clean up sockets on success, exception, disconnect and timeout without a Deck", async (t) => {
  let response = { id: 1, result: { result: { value: { ready: true } } } };
  let socket;
  class FakeSocket extends EventTarget {
    closed = false;
    constructor(url) {
      super();
      socket = this;
      assert.equal(url.port, "12345");
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      assert.equal(JSON.parse(text).params.awaitPromise, true);
      if (response === "disconnect") this.dispatchEvent(new Event("close"));
      else if (response)
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(response) }),
          ),
        );
    }
    close() {
      this.closed = true;
    }
  }
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => [
      {
        title: "SharedJSContext",
        webSocketDebuggerUrl: "ws://127.0.0.1:8080/devtools/page/test",
      },
    ],
  }));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  assert.deepEqual(await evaluate(12345, "probe"), { ready: true });
  assert.equal(socket.closed, true);
  response = {
    id: 1,
    result: { exceptionDetails: { text: "backend unavailable" } },
  };
  await assert.rejects(evaluate(12345, "probe"), /backend unavailable/);
  assert.equal(socket.closed, true);
  response = "disconnect";
  await assert.rejects(evaluate(12345, "probe"), /断开/);
  assert.equal(socket.closed, true);
  response = null;
  await assert.rejects(evaluate(12345, "probe", 5), /超时/);
  assert.equal(socket.closed, true);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => [
      {
        title: "SharedJSContext",
        webSocketDebuggerUrl: "ws://outside.example/secret",
      },
    ],
  }));
  await assert.rejects(evaluate(12345, "probe"), /拒绝/);
});
