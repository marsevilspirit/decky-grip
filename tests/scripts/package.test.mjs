import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  assemblePackage,
  buildPackage,
  hashBackendSnapshot,
  PACKAGE_FILES,
  run,
  snapshotBackend,
} from "../../scripts/package.mjs";

test("CI and just package share one checked package entry point and retain validation evidence", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const recipes = await readFile(
    new URL("../../justfile", import.meta.url),
    "utf8",
  );
  assert.equal(workflow.match(/run: node scripts\/package\.mjs/g)?.length, 1);
  assert.match(recipes, /\npackage:\n\s+node scripts\/package\.mjs\n/);
  assert.doesNotMatch(
    workflow,
    /pnpm run check|Decky CLI|plugin build|\bsudo\b/,
  );
  for (const path of [
    "out/package-*/*.zip",
    "out/package-*/package-receipt.json",
    "out/package-*/source-receipt.json",
    "test-results/browser/",
  ])
    assert.ok(workflow.includes(path), `Missing artifact path: ${path}`);
  assert.match(workflow, /run: pnpm run test:browser/);
  assert.match(workflow, /if: failure\(\)/);
});

test("persistent target reuse still checks sources and runs the exact validated builder image", async () => {
  const validId = `sha256:${"a".repeat(64)}`;
  const configId = `sha256:${"b".repeat(64)}`;
  for (const [imageId, failure] of [
    [validId, null],
    [undefined, null],
    ["moving-tag", null],
    ["sha256:bad", null],
    [validId, "invalid-json"],
    [validId, "check-fails"],
    [validId, "classic"],
    [validId, "bad-config"],
    [validId, "run-fails"],
  ]) {
    const calls = [];
    const operation = vm.runInNewContext(`(${buildPackage.toString()})()`, {
      repository: "/repo",
      join,
      dirname,
      PACKAGE_FILES,
      console: { log() {} },
      mkdir: async () => {},
      copyFile: async () => {},
      writeFile: async () => {},
      snapshotBackend: async () => {},
      hashBackendSnapshot: async () => "backend-content-hash",
      mkdtemp: async () => "/repo/out/package-test",
      readFile: async (path) =>
        path.endsWith("builder-metadata.json")
          ? failure === "invalid-json"
            ? "not JSON"
            : JSON.stringify({
                "containerimage.digest": imageId,
                "containerimage.config.digest":
                  failure === "bad-config" ? "not-a-digest" : configId,
              })
          : "source",
      digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (command === "pnpm" && failure === "check-fails")
          throw Error("check failed");
        if (
          command === "docker" &&
          args[0] === "image" &&
          args[2] === validId &&
          ["classic", "bad-config"].includes(failure)
        )
          throw Error("No such image");
        if (
          command === "docker" &&
          args[0] === "run" &&
          failure === "run-fails"
        )
          throw Error("build failed");
        return "source-commit\n";
      },
      assemblePackage: async () => {
        calls.push(["assemble"]);
        return "package";
      },
    });
    if (imageId !== validId || (failure !== null && failure !== "classic")) {
      await assert.rejects(
        operation,
        failure === "check-fails"
          ? /check failed/
          : failure === "run-fails"
            ? /build failed/
            : failure === "invalid-json"
              ? /JSON/
              : /invalid builder image ID/,
      );
      assert.equal(
        calls.filter(
          ([command, action]) => `${command} ${action}` === "docker run",
        ).length,
        failure === "run-fails" ? 1 : 0,
      );
      assert.ok(!calls.some(([command]) => command === "assemble"));
      if (["bad-config", "run-fails"].includes(failure))
        assert.deepEqual(
          calls.filter((call) => call[1] === "image"),
          [["docker", "image", "inspect", validId]],
        );
      if (failure === "check-fails")
        assert.deepEqual(calls, [["pnpm", "run", "check"]]);
      continue;
    }
    assert.equal(await operation, "package");
    assert.deepEqual(
      calls.map((call) => call.slice(0, 2).join(" ")),
      [
        "pnpm run",
        "git rev-parse",
        "git status",
        "docker build",
        "docker image",
        ...(failure === "classic" ? ["docker image"] : []),
        "docker run",
        "assemble",
      ],
    );
    assert.deepEqual(calls[0], ["pnpm", "run", "check"]);
    const build = calls[3];
    assert.ok(build.includes("--provenance=false"));
    assert.equal(
      build[build.indexOf("--metadata-file") + 1],
      "/repo/out/package-test/builder-metadata.json",
    );
    assert.equal(build[build.indexOf("--platform") + 1], "linux/amd64");
    const expectedId = failure === "classic" ? configId : validId;
    assert.deepEqual(
      calls.filter((call) => call[1] === "image").map((call) => call[3]),
      failure === "classic" ? [validId, configId] : [validId],
    );
    const container = calls.find(
      (call) => call[0] === "docker" && call[1] === "run",
    );
    assert.equal(container.at(-1), expectedId);
    assert.equal(container[container.indexOf("--platform") + 1], "linux/amd64");
    assert.equal(
      container[container.indexOf("--env") + 1],
      `GRIP_BUILD_KEY=${createHash("sha256")
        .update(`backend-content-hash\n${expectedId}\nlinux/amd64`)
        .digest("hex")}`,
    );
    assert.ok(
      container.includes(
        `type=volume,src=decky-grip-cargo-target-${expectedId.slice(7)},dst=/tmp/grip-target`,
      ),
    );
  }
});

test("backend fingerprints use complete snapshot contents, names and modes, never mtimes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "grip-snapshot-hash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "src/new-untracked.rs");
  await write(file, "original", { mode: 0o644 });
  const original = await hashBackendSnapshot(directory);
  await utimes(file, 1, 1);
  assert.equal(await hashBackendSnapshot(directory), original);
  await writeFile(file, "modified");
  await utimes(file, 1, 1);
  assert.notEqual(await hashBackendSnapshot(directory), original);
  await writeFile(file, "original");
  assert.equal(await hashBackendSnapshot(directory), original);
  await chmod(file, 0o755);
  assert.notEqual(await hashBackendSnapshot(directory), original);
  await chmod(file, 0o644);
  await rename(file, join(directory, "src/renamed.rs"));
  assert.notEqual(await hashBackendSnapshot(directory), original);
  await rename(join(directory, "src/renamed.rs"), file);
  await mkdir(join(directory, "empty"));
  assert.notEqual(await hashBackendSnapshot(directory), original);
  await symlink(file, join(directory, "linked.rs"));
  await assert.rejects(hashBackendSnapshot(directory), /only regular files/);
});

test("the real entrypoint reuses only verified artifacts and locks through copy-out", async (t) => {
  const script = await readFile(
    new URL("../../backend/entrypoint.sh", import.meta.url),
    "utf8",
  );
  execFileSync("sh", ["-n"], { input: script });
  const directory = await mkdtemp(join(tmpdir(), "grip-artifact-reuse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target");
  const binary = join(target, "release/grip-sidecar");
  const receipt = join(target, ".grip-package-receipt");
  const bin = join(directory, "bin");
  // macOS has no flock command; Python invokes the same kernel lock on inherited fd 9.
  await write(
    join(bin, "flock"),
    `#!/bin/sh
exec python3 -c 'import fcntl, sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX)' "$@"
`,
    { mode: 0o755 },
  );
  await write(
    join(bin, "cargo"),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$CARGO_TARGET_DIR/cargo-calls"
case "$*" in
  'clean --locked --release -p grip-sidecar')
    rm -f "$CARGO_TARGET_DIR/release/grip-sidecar" ;;
  'build --locked --release')
    mkdir "$CARGO_TARGET_DIR/building"
    trap 'rmdir "$CARGO_TARGET_DIR/building"' EXIT
    sleep 0.05
    mkdir -p "$CARGO_TARGET_DIR/release"
    cp src/main.rs "$CARGO_TARGET_DIR/release/grip-sidecar"
    chmod +x "$CARGO_TARGET_DIR/release/grip-sidecar"
    test "$(cat src/main.rs)" != FAIL ;;
  *) exit 42 ;;
esac
`,
    { mode: 0o755 },
  );
  // Relocate only the two container paths; execute the real locking/cache/build/copy logic.
  const relocated = script
    .replace("cd /backend", 'cd "$GRIP_TEST_BACKEND"')
    .replace(
      "export CARGO_TARGET_DIR=/tmp/grip-target",
      'export CARGO_TARGET_DIR="$GRIP_TEST_TARGET"',
    );
  async function build(content, imageId = "builder-a") {
    const backend = await mkdtemp(join(directory, "snapshot-"));
    await write(join(backend, "src/main.rs"), content);
    // Even modified source gets an old mtime, as happens when copying another snapshot.
    await utimes(join(backend, "src/main.rs"), 1, 1);
    const buildKey = createHash("sha256")
      .update(`${await hashBackendSnapshot(backend)}\n${imageId}\nlinux/amd64`)
      .digest("hex");
    const output = await run("sh", ["-c", relocated], {
      capture: true,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GRIP_TEST_BACKEND: backend,
        GRIP_TEST_TARGET: target,
        GRIP_BUILD_KEY: buildKey,
      },
    });
    assert.equal(
      await readFile(join(backend, "out/grip-sidecar"), "utf8"),
      content,
    );
    return output;
  }
  const calls = () => readFile(join(target, "cargo-calls"), "utf8");
  await build("A");
  const firstCalls = await calls();
  assert.equal(
    firstCalls,
    "clean --locked --release -p grip-sidecar\nbuild --locked --release\n",
  );
  assert.match(await build("A"), /verified cache hit/);
  assert.equal(await calls(), firstCalls);
  assert.doesNotMatch(await build("B"), /cache hit/);
  await writeFile(binary, "corrupt");
  assert.doesNotMatch(await build("B"), /cache hit/);
  await writeFile(receipt, "corrupt receipt");
  assert.doesNotMatch(await build("B"), /cache hit/);
  await rm(receipt);
  assert.doesNotMatch(await build("B"), /cache hit/);
  await rm(binary);
  assert.doesNotMatch(await build("B"), /cache hit/);
  await assert.rejects(build("FAIL"), /sh failed/);
  await assert.rejects(readFile(receipt), { code: "ENOENT" });
  assert.doesNotMatch(await build("B"), /cache hit/);
  assert.doesNotMatch(await build("B", "builder-b"), /cache hit/);
  // Different concurrent sources must each copy their own output while holding the lock.
  await Promise.all([build("C"), build("D")]);
  assert.equal((await calls()).split("\n").filter(Boolean).length, 22);
  const concurrent = await Promise.all([build("E"), build("E")]);
  assert.equal(
    concurrent.filter((output) => output.includes("cache hit")).length,
    1,
  );
  assert.equal((await calls()).split("\n").filter(Boolean).length, 24);
});

const elf = () => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  return bytes;
};
const write = async (path, content, options) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, options);
};
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "grip-package-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of PACKAGE_FILES.filter(
    (name) => name !== "bin/grip-sidecar",
  )) {
    await write(
      join(directory, "decky-grip", name),
      `current working tree: ${name}`,
    );
  }
  await write(
    join(directory, "decky-grip/plugin.json"),
    JSON.stringify({ name: "GRIP" }),
  );
  await write(
    join(directory, "decky-grip/package.json"),
    JSON.stringify({ name: "decky-grip", version: "0.3.10" }),
  );
  return directory;
}

test("packages current sources only after a fresh backend output exists, with the exact install layout", async (t) => {
  const directory = await workspace(t);
  const source = join(directory, "checkout/backend");
  await write(
    join(source, "src/uncommitted.rs"),
    "new source not present in HEAD",
  );
  await write(join(source, "out/grip-sidecar"), "stale output");
  await write(join(source, "target/release/grip-sidecar"), "stale host build");
  await snapshotBackend(source, join(directory, "backend"));
  assert.equal(
    await readFile(join(directory, "backend/src/uncommitted.rs"), "utf8"),
    "new source not present in HEAD",
  );
  await assert.rejects(
    readFile(join(directory, "backend/target/release/grip-sidecar")),
    { code: "ENOENT" },
  );
  await assert.rejects(assemblePackage(directory), { code: "ENOENT" });
  await write(join(directory, "backend/out/grip-sidecar"), elf(), {
    mode: 0o755,
  });
  await write(join(directory, "decky-grip/not-for-install.txt"), "not shipped");
  const result = await assemblePackage(directory);
  assert.equal(result.directory, directory);
  assert.equal(result.version, "0.3.10");
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result.files), PACKAGE_FILES);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "package-receipt.json"), "utf8")),
    result,
  );
  assert.equal(
    await run("unzip", ["-p", result.archive, "decky-grip/dist/index.js"], {
      capture: true,
    }),
    "current working tree: dist/index.js",
  );
  await assert.rejects(assemblePackage(directory), /existing package archive/);
});

test("rejects missing executability, non-ELF and wrong-architecture outputs before packaging", async (t) => {
  const directory = await workspace(t);
  const binary = join(directory, "backend/out/grip-sidecar");
  await write(binary, elf(), { mode: 0o644 });
  await assert.rejects(
    assemblePackage(directory),
    /executable Linux x86_64 ELF/,
  );
  await chmod(binary, 0o755);
  await write(binary, "a macOS binary is not a Deck binary");
  await assert.rejects(
    assemblePackage(directory),
    /executable Linux x86_64 ELF/,
  );
  const arm = elf();
  arm.writeUInt16LE(183, 18);
  await write(binary, arm);
  await assert.rejects(
    assemblePackage(directory),
    /executable Linux x86_64 ELF/,
  );
});

test("run captures output without a shell and rejects failed commands", async () => {
  assert.equal(
    await run(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", "space;$(not-a-command)"],
      { capture: true },
    ),
    "space;$(not-a-command)",
  );
  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(7)"]),
    /failed \(7\)/,
  );
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeout: 50,
    }),
    /failed \(SIGTERM\)/,
  );
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
  await assert.rejects(buildPackage({ signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
});
