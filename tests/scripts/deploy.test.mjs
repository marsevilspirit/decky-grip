import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import {
  evaluate,
  installExpression,
  quote,
  validateHost,
  verifyInstalled,
  waitFor,
} from "../../scripts/deploy.mjs";

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
  const path =
    "/home/deck/.local/share/grip-deployment-backups/deploy-123/grip.zip";
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
