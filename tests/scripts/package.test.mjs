import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  assemblePackage,
  buildPackage,
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
      digest: () => "source-hash",
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
    assert.ok(
      container.includes(
        `type=volume,src=decky-grip-cargo-target-${expectedId.slice(7)},dst=/tmp/grip-target`,
      ),
    );
  }
});

test("the container holds one lock through package-only clean, locked build and copy-out", async () => {
  const script = await readFile(
    new URL("../../backend/entrypoint.sh", import.meta.url),
    "utf8",
  );
  execFileSync("sh", ["-n"], { input: script });
  const commands = script
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(commands, [
    "set -eu",
    "cd /backend",
    "export CARGO_TARGET_DIR=/tmp/grip-target",
    'mkdir -p "$CARGO_TARGET_DIR"',
    'exec 9>"$CARGO_TARGET_DIR/.grip-package.lock"',
    "flock 9",
    "cargo clean --locked --release -p grip-sidecar",
    "cargo build --locked --release",
    "mkdir -p out",
    'cp "$CARGO_TARGET_DIR/release/grip-sidecar" out/grip-sidecar',
  ]);
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
