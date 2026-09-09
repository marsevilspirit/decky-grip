import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quote, SSH_OPTIONS, validateHost } from "./deploy.mjs";
import { run } from "./package.mjs";

// Gamescope's X11 API accepts type 3 (full composition); its CLI drops the type argument.
// https://github.com/ValveSoftware/gamescope/blob/1290cbc1a7ca625688bde8728d8e3b1e703d6a40/src/steamcompmgr.cpp#L5821-L5845
// ponytail: this lock serializes our requests, not simultaneous Steam screenshot requests.
export const CAPTURE_SCRIPT = `
export LC_ALL=C
export DISPLAY="\${DISPLAY:-:0}"
umask 077
runtime="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
test -d "$runtime" && test -O "$runtime" || { echo '找不到当前用户的图形会话。' >&2; exit 1; }
exec 9>"$runtime/grip-screenshot.lock"
flock -n 9 || { echo '已有截图任务，请稍后重试。' >&2; exit 1; }
xprop -root GAMESCOPE_FOCUSED_APP | grep -q ' = ' || { echo '请保持 Steam Deck 唤醒并处于游戏模式。' >&2; exit 1; }
pending=$(xprop -root GAMESCOPECTRL_REQUEST_SCREENSHOT GAMESCOPECTRL_DEBUG_REQUEST_SCREENSHOT)
if [[ "$pending" == *' = '* ]]; then
  echo 'Steam 正在截图，请稍后重试。' >&2
  exit 1
fi
shot=/tmp/gamescope.png
if [[ -L "$shot" || ( -e "$shot" && ( ! -f "$shot" || ! -O "$shot" ) ) ]]; then
  echo '拒绝使用不安全的 Gamescope 临时图片路径。' >&2
  exit 1
fi
if [[ ! -e "$shot" ]]; then (set -o noclobber; : > "$shot"); fi
before=$(stat -c '%y:%s' "$shot")
xprop -root -f GAMESCOPECTRL_REQUEST_SCREENSHOT 32c -set GAMESCOPECTRL_REQUEST_SCREENSHOT 3 >&2
deadline=$((SECONDS + 15))
while (( SECONDS < deadline )); do
  pending=$(xprop -root GAMESCOPECTRL_REQUEST_SCREENSHOT)
  if [[ "$pending" != *' = '* && "$(stat -c '%y:%s' "$shot")" != "$before" && "$(tail -c 12 "$shot" | od -An -tx1 | tr -d ' \\n')" == '0000000049454e44ae426082' ]]; then
    cat -- "$shot"
    exit 0
  fi
  sleep 0.1
done
echo '等待完整截图超时，请确认 Deck 已唤醒并重试。' >&2
exit 1
`;

export const COPY_IMAGE_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var data = $.NSData.dataWithContentsOfFile($(argv[0]));
  var image = $.NSImage.alloc.initWithData(data);
  if (!data || !image || !image.isValid) throw new Error('截图无法解码，未修改粘贴板');
  var board = $.NSPasteboard.generalPasteboard;
  if (!board || typeof board.setDataForType !== 'function') throw new Error('无法访问 Mac 系统粘贴板，请在普通终端中运行');
  board.clearContents;
  if (!board.setDataForType(data, $.NSPasteboardTypePNG)) throw new Error('写入图片粘贴板失败');
  var copied = board.dataForType($.NSPasteboardTypePNG);
  if (!copied || !copied.isEqualToData(data)) throw new Error('图片粘贴板校验失败');
}
`;

export function validatePng(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    !bytes
      .subarray(-12)
      .equals(Buffer.from("0000000049454e44ae426082", "hex")) ||
    !bytes.readUInt32BE(16) ||
    !bytes.readUInt32BE(20)
  ) {
    throw new Error("未收到完整 PNG 截图，未修改 Mac 粘贴板。");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export async function screenshot(
  host = "deck",
  { runCommand = run, platform = process.platform } = {},
) {
  validateHost(host);
  if (platform !== "darwin") throw new Error("此命令需要在 Mac 上运行。");
  const bytes = await runCommand(
    "ssh",
    [...SSH_OPTIONS, host, `bash -euo pipefail -c ${quote(CAPTURE_SCRIPT)}`],
    { capture: true, encoding: null, timeout: 30_000 },
  );
  const size = validatePng(bytes);
  const directory = await mkdtemp(join(tmpdir(), "grip-screenshot-"));
  try {
    const path = join(directory, "screen.png");
    await writeFile(path, bytes, { mode: 0o600 });
    await runCommand(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", COPY_IMAGE_SCRIPT, path],
      { timeout: 15_000 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return size;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length > 3) {
    console.error("用法：just screenshot [SSH别名]");
    process.exitCode = 1;
  } else {
    screenshot(process.argv[2])
      .then(({ width, height }) => {
        console.log(
          `已复制 Deck 当前屏幕（${width}×${height}）到 Mac 粘贴板，可直接 ⌘V 粘贴。`,
        );
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
