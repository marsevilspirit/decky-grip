import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
export const PACKAGE_FILES = [
  "LICENSE",
  "bin/grip-sidecar",
  "dist/heybox-render.js",
  "dist/index.js",
  "main.py",
  "package.json",
  "plugin.json",
  "py_modules/rust_sidecar.py",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd: options.cwd ?? repository,
      env: { ...process.env, ...options.env },
      signal: options.signal,
      timeout: options.timeout,
      stdio: ["inherit", options.capture ? "pipe" : "inherit", "inherit"],
    });
    const output = [];
    child.stdout?.on("data", (chunk) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} failed (${signal ?? code})`));
      } else {
        const bytes = Buffer.concat(output);
        resolve(
          options.capture
            ? options.encoding === null
              ? bytes
              : bytes.toString("utf8")
            : undefined,
        );
      }
    });
  });
}

export function snapshotBackend(source, destination) {
  // Copy the working tree, including uncommitted/new sources, but never reuse an old build.
  return cp(source, destination, {
    recursive: true,
    filter: (path) =>
      !["out", "target"].includes(relative(source, path).split(sep)[0]),
  });
}

export async function assemblePackage(directory, { signal } = {}) {
  signal?.throwIfAborted();
  directory = resolve(directory);
  const plugin = join(directory, "decky-grip");
  const manifest = JSON.parse(
    await readFile(join(plugin, "plugin.json"), "utf8"),
  );
  const metadata = JSON.parse(
    await readFile(join(plugin, "package.json"), "utf8"),
  );
  const { version } = metadata;
  if (
    manifest.name !== "GRIP" ||
    metadata.name !== "decky-grip" ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)
  ) {
    throw new Error(
      "Expected GRIP/decky-grip manifests with a valid package version",
    );
  }
  const sidecar = join(directory, "backend/out/grip-sidecar");
  const info = await lstat(sidecar);
  if (!info.isFile() || !(info.mode & 0o111)) {
    throw new Error(
      "Fresh backend output must be an executable Linux x86_64 ELF, not a host binary",
    );
  }
  const elf = await readFile(sidecar);
  if (
    elf.length < 64 ||
    !elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    elf[4] !== 2 ||
    elf[5] !== 1 ||
    elf[6] !== 1 ||
    ![2, 3].includes(elf.readUInt16LE(16)) ||
    elf.readUInt16LE(18) !== 62
  ) {
    throw new Error(
      "Fresh backend output must be an executable Linux x86_64 ELF, not a host binary",
    );
  }
  await mkdir(join(plugin, "bin"), { recursive: true });
  await copyFile(sidecar, join(plugin, "bin/grip-sidecar"));
  await chmod(join(plugin, "bin/grip-sidecar"), 0o755);
  const files = {};
  for (const name of PACKAGE_FILES) {
    const path = join(plugin, name);
    if (!(await lstat(path)).isFile())
      throw new Error(`Not a regular package file: ${name}`);
    files[name] = digest(await readFile(path));
  }
  const archive = join(directory, `decky-grip-${version}.zip`);
  if (
    await lstat(archive).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })
  )
    throw new Error("Refusing to append to an existing package archive");
  const members = PACKAGE_FILES.map((name) => `decky-grip/${name}`);
  await run("zip", ["-X", archive, ...members], { cwd: directory, signal });
  await run("unzip", ["-t", archive], { signal });
  const actual = (
    await run("unzip", ["-Z1", archive], { capture: true, signal })
  )
    .trim()
    .split("\n")
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...members].sort()))
    throw new Error("Unexpected ZIP contents");
  for (const [name, hash] of Object.entries(files)) {
    const bytes = await run("unzip", ["-p", archive, `decky-grip/${name}`], {
      capture: true,
      encoding: null,
      signal,
    });
    if (digest(bytes) !== hash) throw new Error(`ZIP hash mismatch: ${name}`);
  }
  const result = {
    directory,
    archive,
    sha256: digest(await readFile(archive)),
    version,
    files,
  };
  await writeFile(
    join(directory, "package-receipt.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

export async function buildPackage({ signal } = {}) {
  await run("pnpm", ["run", "check"], { signal });
  await mkdir(join(repository, "out"), { recursive: true });
  const directory = await mkdtemp(join(repository, "out/package-"));
  console.log(`GRIP package workspace: ${directory}`);
  const backend = join(directory, "backend");
  await snapshotBackend(join(repository, "backend"), backend);
  for (const name of PACKAGE_FILES.filter(
    (name) => name !== "bin/grip-sidecar",
  )) {
    const destination = join(directory, "decky-grip", name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repository, name), destination);
  }
  await writeFile(
    join(directory, "source-receipt.json"),
    JSON.stringify(
      {
        commit: (
          await run("git", ["rev-parse", "HEAD"], { capture: true, signal })
        ).trim(),
        worktree: await run("git", ["status", "--porcelain=v1"], {
          capture: true,
          signal,
        }),
        backendSnapshot: backend,
        dockerfileSha256: digest(await readFile(join(backend, "Dockerfile"))),
        cargoLockSha256: digest(await readFile(join(backend, "Cargo.lock"))),
        platform: "linux/amd64",
        validation: "pnpm run check",
      },
      null,
      2,
    ) + "\n",
  );
  // Docker's cached toolchain layer and registry cache are reusable; /tmp/grip-target is fresh per run.
  await run(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "-t",
      "decky-grip-package-builder",
      backend,
    ],
    { signal },
  );
  await run(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--mount",
      `type=bind,src=${backend},dst=/backend`,
      "--mount",
      "type=volume,src=decky-grip-cargo-registry,dst=/.cargo/registry",
      "decky-grip-package-builder",
    ],
    { signal },
  );
  return assemblePackage(directory, { signal });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  buildPackage()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
