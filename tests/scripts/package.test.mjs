import assert from "node:assert/strict";
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
