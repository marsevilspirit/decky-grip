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
  sanitization, body/image caches, and physical L4 input. The thin Python Decky
  bridge keeps only the RPC and lifecycle contract.
- **GRIP Reader** renders the validated Rust response in a dedicated Decky
  route.
- Guide images never load directly in the Steam browser. The backend validates,
  bounds, and caches trusted Steam-hosted raster images, then the reader exposes
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
- Guide and app ids stay decimal strings so large Steam ids never lose
  precision.
- The panel lists up to 20 recent GRIP Reader guides for the running game (or
  globally when no game is running), with cached title, chapter, and offline
  state. Reader history remains available when a guide body cache is removed.
- The plugin does not need root privileges.

The current Steam UI findings and implementation boundaries are recorded in
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

The frontend bundle is written to `dist/index.js`. Decky's custom-backend build
places `backend/out/grip-sidecar` in the packaged plugin's `bin/` directory.
Python tests use only the standard library.

## Using GRIP Reader

1. Open a Steam Community guide, scroll to the paragraph you want, then choose
   **下载到 GRIP**. The button reports image progress and only shows **已下载**
   after the body and every image are saved locally. Failed downloads can be
   retried without downloading already-saved images again.
2. Select **GRIP**, then choose **继续当前或最近指南**. The plugin panel does
   not list downloaded guides; switch guides inside the reader with **Y**.
   Open **高级选项** for local cache maintenance and diagnostics.
3. Scroll normally in the full-screen reader. Press **Y** to open the current
   game's guide list and **B** to close the list or leave the reader. Choose **搜索** to find local
   guide titles, chapters, or body text, preview matching context, and step
   through highlighted matches. GRIP saves each guide's visible text and exact
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
Background preloading never starts a network request. A cache older than six
hours still opens immediately; use **更新** when you want to fetch the newest
version. Large guides mount one bounded section first and append bounded batches
on later frames; each section has its own parser budget, and text anchors are
indexed incrementally rather than rescanning the whole article on every save or
restore.

The panel records only real, versioned physical-L4 opens. Under **高级选项**, it
reports the route, cache, first-content-frame, and position-restoration timings,
then evaluates a 20-attempt warm-cache gate: first-screen P95 must be at most
300 ms with no spinner, position failure, canceled open, or load timeout. Failed
physical opens remain in the same rolling 50-attempt window instead of
disappearing from the measurement.

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
limited to 20 MiB each, 256 MiB across the disk LRU, and 32 MiB in the Rust
memory LRU. Opening a body promotes it; listing guide summaries does not.

Images live under the guide cache's `images/` directory. Each image is limited
to 8 MiB and a validated 8192-pixel / 16-megapixel canvas, disk storage to
128 MiB, and the Rust memory LRU to 24 MiB. Explicit downloads use `offline-`
prefixed cache files that survive ordinary LRU eviction and process restarts;
if they fill the disk quota, further downloads report an error instead of
discarding offline images. Clearing the image cache also removes these files.
Downloads save up to three images concurrently in Rust without sending their
bytes through the frontend. The reader still loads only images near the viewport
and keeps at most 64 MiB / 64 entries of estimated decoded
frontend image residency. Animated image payloads are rejected, and the reader
observes at most 512 inert image nodes while staging no more than 48 distinct
image URLs at once. Under **高级选项**, the panel shows cache usage and provides
separate controls for clearing all guide bodies, one guide body, or images;
clearing images also invalidates in-flight frontend work, and none of these
controls deletes saved reading positions.

`positions.json` has exactly one owner: the Rust sidecar. Backend RPC calls are
serialized before entering the file store, so their arrival order is not
reordered by the executor thread pool. A running sidecar failure is surfaced;
the bridge never switches writers.

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
