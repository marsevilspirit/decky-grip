import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildPackage, run } from "./package.mjs";

const HOMEBREW = "/home/deck/homebrew";
const PLUGIN = `${HOMEBREW}/plugins/decky-grip`;
export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
];

export function validateHost(host) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(host))
    throw new Error(
      "目标必须是 SSH 别名或 user@hostname；端口等配置请放在 ~/.ssh/config。",
    );
  return host;
}

export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function installExpression(remoteZip, { version, sha256 }) {
  return `DeckyBackend.call(...${JSON.stringify([
    "utilities/install_plugin",
    `file://${remoteZip}`,
    "GRIP",
    version,
    sha256,
    1,
  ])})`;
}

// Steam CEF exposes page sockets, not necessarily a browser-level CDP endpoint.
export async function evaluate(port, expression, timeout = 15_000) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Steam CEF 返回 HTTP ${response.status}`);
  const page = (await response.json()).find(
    (item) => item.title === "SharedJSContext",
  );
  if (!page)
    throw new Error("未找到 Steam 大屏幕模式；请开启游戏模式和 CEF 调试。");
  const endpoint = new URL(page.webSocketDebuggerUrl);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname)
  )
    throw new Error("拒绝非本机 Steam CEF WebSocket 地址。");
  endpoint.hostname = "127.0.0.1";
  endpoint.port = String(port);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(
      () => finish(new Error("Steam CEF 调用超时")),
      timeout,
    );
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      ),
    );
    socket.addEventListener("message", ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.id !== 1) return;
        const failure = message.error || message.result?.exceptionDetails;
        finish(
          failure ? new Error(JSON.stringify(failure)) : null,
          message.result?.result?.value,
        );
      } catch (error) {
        finish(error);
      }
    });
    socket.addEventListener("error", () =>
      finish(new Error("Steam CEF 连接失败")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Steam CEF 连接已断开")),
    );
  });
}

export async function waitFor(check, timeout, interval, signal) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    signal?.throwIfAborted();
    try {
      return await check();
    } catch (error) {
      lastError = error;
    }
    await delay(interval, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error(`等待超时：${lastError?.message ?? "未完成"}`);
}

export function verifyInstalled(output, files, previousPids) {
  const pids = output
    .match(/^PIDS\s+(\d+)\s+(\d+)$/m)
    ?.slice(1)
    .join(" ");
  if (
    !pids ||
    pids.split(" ").some((pid, index) => pid === previousPids.split(" ")[index])
  )
    throw new Error("等待 GRIP 完成重载");
  for (const [file, hash] of Object.entries(files)) {
    if (!`${output}\n`.includes(`${hash}  ${PLUGIN}/${file}\n`))
      throw new Error(`已安装文件尚未匹配：${file}`);
  }
  return pids;
}

export function verifySettings(before, after) {
  const paths = new Set(after.split("\0"));
  for (const path of before.split("\0").filter(Boolean)) {
    if (!paths.has(path)) throw new Error(`设置文件丢失：${path}`);
  }
}

const RPC_CHECK = `Promise.all([
  DeckyBackend.call("loader/call_plugin_method", "GRIP", "get_hotkey_status"),
  DeckyBackend.call("loader/call_plugin_method", "GRIP", "get_guide_library", null)
]).then(([hotkey, entries]) => ({
  hotkey, guides: entries.map(e => e.appId + ":" + e.guideId),
  loaded: DeckyPluginLoader.plugins.some(p => p.name === "GRIP")
}))`;

export async function deploy(host = "deck") {
  validateHost(host);
  if (typeof WebSocket === "undefined")
    throw new Error("部署脚本需要 Node.js 22 或更新版本。");
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(
      new Error(
        "部署已中断；已开始的 Decky 安装可能仍会继续，请在 Deck 上检查。",
      ),
    );
  const { signal } = controller;
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const ssh = (command, timeout = 30_000) =>
    run(
      "ssh",
      [...SSH_OPTIONS, host, `bash -euo pipefail -c ${quote(command)}`],
      { capture: true, signal, timeout },
    );
  let tunnel;
  let receipt;
  let receiptPath;
  try {
    console.log(`检查 ${host}…`);
    await ssh(`set -eu
test "$(uname -m)" = x86_64
systemctl is-active --quiet plugin_loader
test -d ${quote(PLUGIN)} && test ! -L ${quote(PLUGIN)}
test -d ${quote(`${HOMEBREW}/settings/decky-grip`)}
command -v find >/dev/null; command -v unzip >/dev/null; command -v sha256sum >/dev/null`);
    // Reserve an ephemeral loopback port. SSH fails closed if it is taken in between.
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    tunnel = spawn(
      "ssh",
      [
        ...SSH_OPTIONS,
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        `127.0.0.1:${port}:127.0.0.1:8080`,
        host,
      ],
      { stdio: ["ignore", "ignore", "inherit"], signal },
    );
    let tunnelError;
    tunnel.on("error", (error) => {
      tunnelError = error;
    });
    tunnel.on("exit", (code) => {
      tunnelError ??= new Error(`SSH 隧道已退出 (${code})`);
    });
    const cdp = (expression) => {
      signal.throwIfAborted();
      if (tunnelError) throw tunnelError;
      return evaluate(port, expression);
    };
    const baseline = await waitFor(() => cdp(RPC_CHECK), 20_000, 1000, signal);
    if (!baseline?.loaded || !Array.isArray(baseline.guides))
      throw new Error("GRIP 尚未正常加载，停止重新部署。");

    const pkg = await buildPackage({ signal });
    signal.throwIfAborted();
    const remoteDir = (
      await ssh("umask 077; mktemp -d /tmp/grip-deploy-XXXXXXXX")
    ).trim();
    if (!/^\/tmp\/grip-deploy-[a-zA-Z0-9]{8}$/.test(remoteDir))
      throw new Error("设备返回了意外的部署目录，停止安装。");
    const remoteZip = `${remoteDir}/grip.zip`;
    receipt = {
      host,
      archive: pkg.archive,
      sha256: pkg.sha256,
      files: pkg.files,
      remoteZip,
      state: "preparing",
    };
    receiptPath = join(pkg.directory, "deployment.json");
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    console.log("不创建回滚备份；保留并校验现有指南和设置。");
    const snapshotSettings = () =>
      ssh(`find ${quote(`${HOMEBREW}/settings/decky-grip`)} -print0`);
    const settingsBefore = await snapshotSettings();
    await run("scp", [...SSH_OPTIONS, pkg.archive, `${host}:${remoteZip}`], {
      signal,
      timeout: 60_000,
    });
    await ssh(`set -eu
printf '%s  %s\n' ${quote(pkg.sha256)} ${quote(remoteZip)} | sha256sum --check -
unzip -tq ${quote(remoteZip)}`);

    const snapshot = () =>
      ssh(`set -eu
systemctl is-active --quiet plugin_loader
sidecar=$(pgrep -f '^${PLUGIN}/bin/grip-sidecar ')
test "$(printf '%s' "$sidecar" | wc -w)" -eq 1
printf 'PIDS %s %s\n' "$(ps -o ppid= -p "$sidecar" | tr -d ' ')" "$sidecar"
sha256sum ${Object.keys(pkg.files)
        .map((file) => quote(`${PLUGIN}/${file}`))
        .join(" ")} 2>/dev/null`);
    const before = await snapshot();
    const previousPids = before
      .match(/^PIDS\s+(\d+)\s+(\d+)$/m)
      ?.slice(1)
      .join(" ");
    if (!previousPids) throw new Error("无法确认当前 GRIP 进程，停止安装。");
    receipt.startedAt = (await ssh("date +%s")).trim();
    receipt.state = "awaiting-confirmation";
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    // Keep Decky's own confirmation/loading/close lifecycle; do not patch its UI.
    await cdp(installExpression(remoteZip, pkg));
    console.log(
      "请在 Steam Deck 的 Decky 弹窗中确认重新安装（等待最多 3 分钟）…",
    );
    let candidate;
    let stableSince = 0;
    const verified = await waitFor(
      async () => {
        const pids = verifyInstalled(await snapshot(), pkg.files, previousPids);
        const rpc = await cdp(RPC_CHECK);
        if (!rpc?.loaded || !rpc.hotkey?.running || !rpc.hotkey?.available)
          throw new Error("等待 GRIP 接口和 L4 监听就绪");
        if (!baseline.guides.every((key) => rpc.guides.includes(key)))
          throw new Error("指南记录未完整恢复");
        if (candidate !== pids) {
          candidate = pids;
          stableSince = Date.now();
        }
        if (Date.now() - stableSince < 15_000)
          throw new Error("正在确认进程稳定性");
        return { pids, rpc };
      },
      180_000,
      3000,
      signal,
    );
    // Forked plugins inherit Loader's journal stream; _PID need not be the child PID.
    receipt.startup = await ssh(
      `journalctl -u plugin_loader -b --since ${quote(`@${receipt.startedAt}`)} --no-pager -o cat | grep -E '^GRIP (Rust sidecar|backend) ready$'`,
    );
    if (
      !receipt.startup.includes("GRIP Rust sidecar ready") ||
      !receipt.startup.includes("GRIP backend ready")
    )
      throw new Error("未找到新后端的两条 ready 日志，请检查 Decky 日志。");
    // Bookmarks can advance while reading; compare path inventories, not contents.
    verifySettings(settingsBefore, await snapshotSettings());
    receipt.state = "verified";
    receipt.verified = verified;
    // Do not clean in finally: Decky may still be reading the ZIP after a timeout.
    try {
      await ssh(`rm -- ${quote(remoteZip)} && rmdir -- ${quote(remoteDir)}`);
      receipt.remoteZipRemoved = true;
    } catch (error) {
      receipt.cleanupError = error.message;
      console.warn(
        `部署验收通过，但临时包清理失败：${remoteZip}（${error.message}）`,
      );
    }
    console.log(
      `部署完成：GRIP ${pkg.version}，文件、接口及两次稳定进程检查通过。\n未创建回滚备份${receipt.remoteZipRemoved ? "，临时安装包已清理" : "，临时目录尚未清理完成"}。\n部署记录：${receiptPath}\n实体按键和阅读体验仍需在 Deck 上确认。`,
    );
  } catch (error) {
    if (receipt) {
      receipt.state = "failed";
      receipt.error = error.message;
    }
    if (receipt?.remoteZip && !receipt.remoteZipRemoved)
      console.error(
        `部署未完成；本次没有回滚备份。请先检查 Decky 安装状态，再清理临时包：${receipt.remoteZip}`,
      );
    throw error;
  } finally {
    tunnel?.kill("SIGTERM");
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (receiptPath)
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) {
    console.error("用法：just deploy [SSH别名]");
    process.exitCode = 1;
  } else
    deploy(process.argv[2]).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
