# GRIP

**Guide Resumes In Place** — resume Steam Community Guides exactly where you
left off on Steam Deck.

> Project status: experimental plugin. GRIP Reader is the reliable path for
> exact resume; native Steam guide restoration remains best-effort because
> Steam's FocusNav can move the article back to a focused section title.

## Why GRIP exists

Steam's in-game guide overlay can remember a position while its current history
entry survives, but reopening the overlay may rebuild that history and return
the guide to an earlier location. GRIP persists the exact guide position and
restore it when the guide is opened again.

## Architecture

- **TypeScript/React** integrates with Decky and Steam's Gamepad UI.
- A resident **Rust sidecar** owns positions, public-guide download and
  sanitization, body/image caches, physical L4 input, temporary CEF article
  capture, and the opt-in LAN link inbox. Python only adapts Decky lifecycle,
  events and RPC transport to this sidecar.
- **GRIP Reader** renders the validated Rust response in a dedicated Decky
  route.
- In GRIP Reader, images never load directly from the web. The backend validates,
  bounds, and caches allowed Steam/Heybox raster images, then the reader exposes
  them through local Blob URLs for offline reuse.
- Reader positions include both a pixel fallback and the visible text anchor,
  section id, and viewport offset. The reader content itself has no focusable
  headings, so Steam's title-focused history cannot move the article.
- On the first handoff, GRIP resolves the saved native Steam pixel inside the
  still-mounted native DOM and transfers the matching text, not that pixel, to
  the independently laid-out reader.
- GRIP still observes Steam's selected guide and native guide scroll panel as a
  best-effort compatibility path.
- Restoration waits for lazy-loaded guide content to reach a stable, usable
  height before scrolling, preventing Steam's early clamped position from
  overwriting the saved value.
- Steam guide and app ids stay decimal strings so large Steam ids never lose
  precision. Imported articles use `heybox-<12 lowercase hex digits>` without
  migrating existing Steam cache files or bookmarks.
- The reader's **Y** switcher lists up to 20 recent guides for that game, with
  cached titles and last-read chapters. Reader history remains available when a
  guide body cache is removed; the plugin panel stays compact.
- The plugin does not need root privileges.

The code's module boundaries, ownership rules and earlier Steam UI findings are recorded in
[`docs/architecture.md`](docs/architecture.md).

## Development

Requirements follow the current official Decky template:

- Node.js 20.19+, 22.12+, or 24+
- pnpm 9
- Python 3.9 or newer
- Rust 1.85 or newer

```bash
pnpm install
pnpm run check
```

Individual checks are also available:

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

The frontend bundle is written to `dist/index.js`, with the fixed browser-only
extractor in `dist/heybox-render.js`. Both are packaged alongside a freshly built
Linux x86_64 `grip-sidecar` in the plugin's `bin/` directory.
Python tests use only the standard library.

Local browser regressions run separately from `check` (Node, Rust and a browser
are required; a Steam Deck is not):

```bash
pnpm exec playwright install chromium
pnpm run test:browser
```

Or use an already installed Chrome with `PW_CHANNEL=chrome pnpm run test:browser`.
The 1280×800 suite renders the real reader components, measures visible card and
table bounds, and checks search positioning after actual image decoding. It also
covers guide switching, close/reopen/reload, failed-load and save retries, and
DOM-work counts for a same-frame scroll burst over 600 images. Backend responses
and saved positions use local fixtures and a thin Decky adapter; layout,
observers, decoding and reader interactions remain real. The import journey
renders the real QR component, decodes its image pixels with the test-only `jsqr`,
and submits through the real Rust phone page on loopback. Download fixtures
exercise the production image-download/task pipeline, including cancellation,
failure and retry, without contacting third-party sites. This does not validate
Steam FocusNav, CEF compatibility, physical controller input, or device network/offline behavior.
CI installs Chromium and runs the same suite; failures retain screenshots and
traces in `test-results/browser/`. The browser dependency is development-only.

### Code boundaries

Plugin controls use Steam's `@decky/ui` dialog, panel, text, progress, and focus
components. Do not add a GRIP color palette, button skin, focus ring, or custom
animation. Reader CSS is only for document layout (including safe image/table
sizes and BBCode structure); the browser adapter does not reproduce Steam's
stylesheet, so local browser tests are not native-style visual acceptance.

Steam owns list/toolbar focus navigation and modal focus isolation/return through
`SimpleModal`, `ModalRoot` and `ConfirmModal`; do not add manual arrow-key or Tab
loops. Logical gamepad callbacks must return `false` for unhandled input (an
implicit return consumes it). Reader scrolling uses Steam's own step and boundary
logic in immediate mode: its smooth hook exposes no cancellation, so an old
animation could overwrite a chapter jump or restored position. If the hook is
unavailable, the reader explicitly reports compatibility scrolling.

Native component contracts can also be checked against an installed Steam
client: `node --test tests/scripts/steam-native-contract.test.mjs`. The test
locates the macOS installation by default; use `GRIP_STEAM_UI_DIR` for another
`steamui` directory. It executes the actual button/progress, scrolling and input functions,
does not vendor Valve code, and explicitly skips when Steam is not installed.
Steam progress takes a 0–100 percentage. A disabled DialogButton retains its
focusable DOM node; its native disabled styling and event blocking are not the
same contract as an HTML button's `disabled` attribute.

Image viewer hints use Steam's action-description map; unavailable actions are
`null` so ancestor hints cannot leak through. A guide row's right click shares
the X management action and restores focus to that row without adding a button.
Search yields X instead of treating it as a reader-navigation shortcut: Steam's
open keyboard uses X for backspace, not whole-field clearing. `TextField`'s clear
control is a separate pointer action. The installed-runtime contracts verify
A-to-edit, keyboard B-to-hide, X-to-backspace and pointer clearing separately;
browser input stand-ins do not certify the virtual keyboard or physical input.

The UI composition was cross-checked against public source on 2026-09-09:

- [SteamGridDB's focusable Field](https://github.com/SteamGridDB/decky-steamgriddb/blob/271c01d9ba5a775e573f5a15ad0786ff9beb00ae/src/components/qam-contents/QuickAccessSettings.tsx#L187-L203)
  and [native Marquee titles](https://github.com/SteamGridDB/decky-steamgriddb/blob/271c01d9ba5a775e573f5a15ad0786ff9beb00ae/src/modals/GameSelectionModal.tsx#L47-L59)
  inform the guide rows: native label/description, one activation target, and no
  GRIP card CSS. Field's disabled state is visual only, so the action guard is
  still required for both clicks and A. The list uses native `ScrollPanel`;
  its resize/focus scrolling is deliberately excluded from the article.
- [Decky's template](https://github.com/SteamDeckHomebrew/decky-plugin-template/blob/90d0780e882a17f5714fc6de044c645f22608290/src/index.tsx)
  places each `ButtonItem` in its own `PanelSectionRow`. GRIP puts the short
  action in the button and the explanation in `description`, not button text.
- [TabMaster's scrolling wrapper](https://github.com/Tormak9970/TabMaster/blob/cd01770a80a37e0692e76ad8083719c15205f5d9/src/components/generic/ScrollableWindow.tsx#L49-L74)
  explicitly disables group focus. GRIP does not adopt the extra group-enter
  step or its custom gradients/scrollbar. Its pinned `@decky/ui` 4.12.0 includes
  the upstream [Field locator compatibility fix](https://github.com/SteamDeckHomebrew/decky-frontend-lib/blob/247eb635ea7acdc3e7807d5f99722daf854aaa70/src/components/Field.ts#L27-L30).

These are API composition references, not a copied theme or implementation.
The browser adapters test behavior/layout, not Valve's visuals, marquee motion,
or physical controller timing; those still require Steam Deck acceptance.

`GuideReaderPage` owns the UI and saves checkpoints. `reader/viewport.ts` owns
document observers, image residency, retry hosts, and frame-coalesced measurement;
`reader/positioning.ts` shares one cancellable lifecycle for restoration and
search, while keeping their different timeout rules.

The Rust root only declares modules and exports the runtime. `positions` and
`reader_positions` keep their distinct schemas; `protocol` validates requests,
`storage` owns safe file operations and per-key locking, and `byte_lru` provides
the byte accounting shared by body, summary, and image caches.

### Deploying from a Mac or Linux workstation

```bash
just deploy          # defaults to ssh deck
just deploy my-deck  # another configured SSH alias
just package         # build a Deck ZIP locally, without SSH
```

Install `just`, Docker, `zip`/`unzip`, and the development requirements above;
deployment also needs Node.js 22+ for its native WebSocket client. Docker must be
running. Set up key-based `ssh deck`, keep the Deck awake in Gaming Mode, and
enable CEF debugging in Decky's developer settings. This redeploy command expects
the existing installation at `/home/deck/homebrew/plugins/decky-grip`.

`just deploy` checks connectivity and Decky first, runs `pnpm run check`, builds
the current working tree (including uncommitted changes) with the pinned Holo
Linux x86_64 toolchain, and validates the package. It never ships an old
`backend/out` binary. Docker layers and the Cargo registry are reused.
`just package`, deployment, and CI share `scripts/package.mjs`; it runs `check`
once, then verifies the ELF, ZIP file list, and hashes. CI also runs the browser
suite and uploads the ZIP with its source and package receipts.

The command backs up the existing plugin **and settings**, uploads and verifies
the ZIP, then opens **Decky's native reinstall confirmation**. Confirm once on
the Deck. It waits up to three minutes for new GRIP processes, all installed
file hashes, working RPC/L4 monitoring, preserved guide records, and two stable
checks. A successful installer response alone is not treated as success.

Packages and receipts are kept under `out/package-*/`. Device rollback archives
and uploaded ZIPs are kept under
`/home/deck/.local/share/grip-deployment-backups/deploy-*/`; the command prints
their exact paths. It does not clear guides or reading positions, restart the
global Loader, change permissions across `homebrew`, or automatically delete old
backups. A timeout/disconnect exits with an error and keeps recovery artifacts.
An installation already confirmed on the Deck may continue after a local
interruption; check its state before retrying. Physical controller/reading
acceptance remains separate. The orchestration uses Decky's
[native local-ZIP installer](https://github.com/SteamDeckHomebrew/decky-loader/blob/v3.2.8/backend/decky_loader/browser.py).

Deployment-script regressions run locally with `pnpm run test:deploy` as part of
`check`; they never connect to or modify a Steam Deck.

## Importing public Heybox articles (experimental)

Choose **导入攻略** in GRIP, paste a public Xiaoheihe share link/text, confirm
the game, and choose **保存完整图文**. The game choices include the running game,
the open library page, and games in GRIP history; open the target game's library
page first if it is missing. The existing **Y** switcher, image zoom and reading
positions work with imported articles.

**手机扫码发送链接** opens a one-link, ten-minute LAN inbox only on demand.
Keep the Deck awake and the phone on the same trusted Wi-Fi with `.local` name
resolution. This uses HTTP, not cloud storage; do not use an untrusted network.
The phone only fills the link field. Confirm the game and start the download on
the Deck; receiving a link is not download success.

Import uses a disposable page in Steam's existing CEF browser, not a second
installed browser. It waits for lazy image URLs, extracts public article DOM,
and passes it through Rust validation. Only complete body/image transactions
are published; failed updates keep the previous offline version. Login-only
pages, video, unsupported embedded graphics, and incomplete pages fail instead
of silently saving partial content. Imported guides never need a browser to read.

Local checks and a loopback browser submission have passed; **Steam Deck CEF
capture, real phone scanning, and offline device acceptance remain unverified**.
See [implementation and acceptance notes](docs/heybox-import.md).

## Using GRIP Reader

1. Open a Steam Community guide, scroll to the paragraph you want, then choose
   **下载到 GRIP**. The button checks local disk state on every visit: **补全下载**
   resumes an incomplete download, and **本地阅读** opens GRIP once the body and
   every image are saved for offline use. Download progress counts unique images;
   retrying preserves images already saved. Leaving and reopening the page
   reconnects to the same download progress. **取消下载** stops scheduling further
   images; up to three in-flight images finish saving before **继续下载** becomes
   available. Progress lasts until the plugin restarts; saved files survive
   restarts. The status check never goes online and reuses image validation
   while each file's identity, size, and timestamps remain unchanged.
2. Select **GRIP**, then choose **继续当前或最近指南**. The plugin panel does
   not list downloaded guides; switch guides inside the reader with **Y**.
   Open **高级选项** for local cache maintenance and diagnostics.
3. Scroll normally in the full-screen reader. Press **Y** to open the current
   game's guide list with focus directly on another guide. Cards keep their
   titles and focus while opening, show errors in place, and retry with **A**.
   Keyboard users can move between cards with **Up/Down**, jump to the first or
   last card with **Home/End**, or use **Tab**; focused cards stay visible.
   Press **X** or move right from the article to expand the full chapter directory;
   it overlays the article without changing its width or reading position.
   **B** backs out one layer at a time: search, directory, then the reader.
   **L1 / R1** page through the article. A failed image offers its own retry
   button; **A** in the article
   retries the first visible failed image without reloading the guide.
   Click a loaded image, or press **A** when a loaded image is visible and no
   failed image needs retrying, to view it full-screen. Use **L1 / R1** or the
   zoom buttons to change scale, **X** to fit the complete image, **L2 / R2**
   to switch between loaded images in the current viewport, and direction
   buttons or dragging to pan. Move down at the bottom of the image to reach
   the image controls.
   On a keyboard, use arrow keys to pan, **+ / -** to zoom, **0** to fit,
   and **PageUp / PageDown** to switch images. Zooming or fitting ends an active
   drag so the next pointer movement cannot jump back to the old coordinates.
   Tall images initially fit the reading width and scroll vertically; **适应屏幕**
   still shows the complete image. **B** returns to the unchanged reading position; the viewer reuses the local
   image without downloading it again.
   Choose **搜索** in the directory (or press **Ctrl/Cmd+F**) to find text in
   the current guide, preview matching context, and step
   through highlighted matches. **Enter / Shift+Enter** in the search field
   move to the next/previous match without stealing focus or interrupting Chinese
   input composition. GRIP saves each guide's visible text and exact
   viewport offset independently.
4. For instant in-game access after that first handoff, map the upper-left
   rear button **L4** to **Scroll Lock** in the game's Steam Input layout. Press
   L4 once to open GRIP and press it again to return to the game. GRIP reads the
   physical L4 button directly; the Scroll Lock mapping simply prevents the
   button from also performing a common game action.

GRIP leaves discovery to Steam's native guide list. The download action appears
only while a specific native guide is open.

The download action fetches the public guide; if you skip it, the first
foreground reader open does the same. After that, GRIP preloads the most recent
guide only when its validated local cache already exists, and keeps that document
and reader position in memory for the lifetime of the plugin.
Background preloading also prepares and decodes up to three local images near
the saved text in its section and adjacent sections, using the same bounded
image LRU. Foreground opens, game changes, cleanup and unload cancel stale
warming. Legacy pixel-only bookmarks without a known section skip image warming.
Background preloading never starts a network request. A cache older than six
hours still opens immediately; use **更新** when you want to fetch the newest
version. The old article remains scrollable, searchable, and navigable while
the update downloads; publication preserves the latest reading position.
While downloading, that same button becomes **取消更新**, including
after you close and reopen the reader. Cancellation stops new image requests,
waits for the in-flight saves, and keeps the old article and reading position.
The short final publication step shows **保存中** and cannot be canceled.
Large guides mount one bounded section first and append bounded batches
on later frames; each section has its own parser budget, and text anchors are
indexed incrementally rather than rescanning the whole article on every save or
restore. Scroll bursts share the existing animation-frame pass and reuse the
near-viewport image set for visibility, image actions and hydration priority.

The panel records only real, versioned physical-L4 opens. Under **高级选项**, it
reports the route, cache, first-content-frame, and position-restoration timings,
then evaluates a 20-attempt warm-cache gate: first-screen P95 must be at most
300 ms with no spinner, position failure, canceled open, or load timeout. Failed
physical opens remain in the same rolling 50-attempt window instead of
disappearing from the measurement.
These timings start when the backend reads the L4 report, not at the physical
button edge; they exclude device/report delivery latency. The HID listener waits
for descriptor readability rather than sleeping after an empty read, so incoming
reports wake it immediately. Actual button-to-screen acceptance remains a
separate device measurement.

## Storage

Native Steam guide positions are stored under Decky's plugin settings directory
as `positions.json`. The initial schema stores:

```json
{
  "schema_version": 1,
  "positions": {
    "1113000:3414883877": {
      "scroll_top": 5561.3335,
      "updated_at_ms": 1787551200123
    }
  }
}
```

The file is written with mode `0600`. Invalid or unsupported data is reported
without stopping guide observation or cached-body reading. The panel can retry
the read; an explicit repair first writes a same-directory `0600` backup and
only then atomically resets a store that still fails validation.

GRIP Reader uses separate `reader_positions.json` and `guides/<guide-id>.json`
files. Reader bookmarks include `section_id`, `anchor_text`, and
`anchor_offset`; downloaded HTML is revalidated on the first process read and
again whenever the cache file's identity or metadata changes. Guide bodies are
limited to 20 MiB each and 32 MiB in the Rust memory LRU. Ordinary body caches
are automatically pruned against a 256 MiB disk target; explicitly downloaded
bodies are pinned until manual deletion, even above that target. Schema-v1
bodies are conservatively protected on upgrade because they did not record
whether a user explicitly downloaded them. Opening a body promotes it;
listing guide summaries does not. Summaries have a separate 1 MiB serialized-payload
LRU budget, outside the 32 MiB body budget, and retain no HTML. Unchanged file
signatures reuse summaries; changed files undergo full validation again, while
staleness is always evaluated against the current time.

Downloads and reader updates first stage a candidate body (up to 32 MiB of
pending bodies in the backend), then save and verify all referenced images.
Only the final commit atomically replaces the live body and its offline flag.
A failed or canceled download leaves the previous version readable; saved
images remain available for retries as ordinary, evictable cache when no live
or pending guide references them. Abandoned staging is released on cancel,
failure, or backend restart. A short final publication step cannot be canceled.
Successful updates reclaim obsolete offline images; other guides and active
downloads protect their shared images. Before a new download, orphaned pins from
older versions or a stopped backend become ordinary retry cache as well. These
checks run on download lifecycle changes, not when opening the reader.

Images live under the guide cache's `images/` directory. Each image is limited
to 8 MiB and a validated 8192-pixel / 16-megapixel canvas, and the Rust memory
LRU to 24 MiB. The disk quota defaults to 128 MiB and can be set from 64 MiB to
8 GiB under **高级选项 → 本地缓存**. The quota is persisted in `images/quota.json`.
Rust memory-cache hits share the same immutable image payload through `Arc`;
they no longer copy its bytes on retrieval and reinsertion. RPC responses still
encode Base64, so this is not a zero-copy path across the Python/frontend bridge.
Lowering it below the space occupied by offline images is rejected without
deleting those images. Explicit downloads use `offline-`
prefixed cache files that survive ordinary LRU eviction and process restarts;
if they fill the disk quota, further downloads report a quota error instead of
discarding offline images. A full device disk is reported separately. Clearing
the image cache also removes these files, but keeps the configured quota.
Downloads save up to three images concurrently in Rust without sending their
bytes through the frontend. An image failure is shown immediately while other
images continue. Quota or device-space failures stop scheduling new images
immediately; already in-flight requests finish, and the old body is not replaced.
The reader still loads only images near the viewport
and keeps at most 64 MiB / 64 entries of estimated decoded
frontend image residency. The reader reuses this bounded image cache across
reader opens and guide switches. Closing
the reader releases its page nodes and cancels pending hydration; explicit image
cache cleanup and plugin unload also release the retained Blob URLs.
Animated image payloads are rejected. The browser observes all image nodes within
the validated guide's existing size/node limits; the reader chooses at most 512
active hydration candidates with visible images first, while staging no more than
48 distinct image URLs at once. This budget never permanently excludes images
later in a long guide. Under **高级选项**, the panel shows cache usage and provides
separate controls for clearing all guide bodies or images. To remove one guide,
open the reader's **Y** switcher, focus the guide's card and press **X**, then
choose **确认卸载**. **A** opens or resumes reading; each card has no separate
management button. The confirmation names the target guide; it does not need
to be the one currently being read.
This removes its body and all unreferenced images, including leftovers from
older updates, while preserving other cached guides and active downloads. If
the body is already gone after partial cleanup, **确认清理残留** retries image
cleanup, even after canceling or reopening the reader. The same shared-image
and active-download protections apply. If another guide cannot be inspected
safely, deletion stops. The current in-memory
article remains readable. Cache deletion is unavailable during an active
download. Clearing images also invalidates in-flight frontend work, and none
of these controls deletes saved reading positions.

Image completeness includes a bounded full pixel decode on download or the first
read of a changed disk file, not just a valid-looking header. Invalid cached images
do not count as downloaded and can be fetched again. Animation detection respects
format structure, so ordinary metadata containing animation keywords is accepted.
The decoder enables only the four supported raster formats. Warm reads reuse
validation by file signature and do not repeat the decode. Nearby preloads can be
evicted for actually visible images; if several visible images exceed the decoded
budget, **图片内存已满，优先显示此图** lets you choose one without raising that budget.

`positions.json` has exactly one owner: the Rust sidecar. Backend RPC calls are
serialized before entering the file store, so their arrival order is not
reordered by the executor thread pool. A running sidecar failure is surfaced;
the bridge never switches writers.
Its request deadline includes waiting for the write lock, pipe writes, and the
response. Pipe backpressure cannot block plugin shutdown; a partially written
timed-out JSON frame fails the transport instead of corrupting the next request.

## Publishing

This repository is currently an experimental local plugin, not a store-ready
release. A public repository, stable public listing image, complete third-party
license review, and a broader device regression matrix are required before
adding a `publish` block or submitting to the Decky store.

## Name

**GRIP** expands to **Guide Resumes In Place**. The repository name is
`decky-grip`.

## License

BSD-3-Clause. See [`LICENSE`](LICENSE).
