import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Use the real Rust HTTP inbox on loopback, with no production test flags or LAN
// listener. Only the Decky RPC transport is replaced for this local browser run.
export async function createPhoneBackend() {
  const { stdout } = await promisify(execFile)(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "backend/Cargo.toml",
      "--lib",
      "--no-run",
      "--message-format=json",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const artifact = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((entry) => entry.executable && entry.target?.name === "grip_sidecar");
  if (!artifact) throw new Error("Rust browser bridge executable not found");
  const child = spawn(artifact.executable, [
    "--exact",
    "phone_import::tests::browser_bridge",
    "--ignored",
    "--nocapture",
    "--quiet",
  ]);
  child.stderr.pipe(process.stderr);
  const pending = new Map();
  let sequence = 0;
  let failure;
  const fail = (error) => {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(new Error(`Rust phone bridge exited: ${code ?? signal}`));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.startsWith("{")) return; // Ignore Rust's test-runner status lines.
    const { id, result } = JSON.parse(line);
    pending.get(id)?.resolve(result);
    pending.delete(id);
  });
  return {
    async call(method, args = []) {
      if (failure) throw failure;
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end(); // EOF drops the session and joins its HTTP workers.
      const timeout = setTimeout(() => child.kill("SIGKILL"), 1_500);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
        lines.close();
      }
    },
  };
}
