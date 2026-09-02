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
- The panel lists up to 20 local favorites before 20 recent GRIP Reader
  guides for the running game (or globally when no game is running), with
  cached title, chapter, and offline state. Reader history and favorites remain
  available when a guide body cache is removed.
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

1. Open a Steam Community guide and leave it on the paragraph you want. For the
   first handoff, keep the guide visible and open Decky with the Quick Access
   button.
2. Select **GRIP**, then choose **继续当前或最近指南**, or open a specific
   entry from **指南库**. Important guides can be kept at the top with the
   local **收藏** switch. Open **高级选项** to download or update missing or
   stale guide bodies without opening the reader, and to manage local caches;
   filtering never contacts Steam. Choose **查找更多 Steam 指南** to open the
   running game's native guide list.
3. Scroll normally in the full-screen reader. Use **切换指南** to move between
   guides for the same game, or choose **查找更多 Steam 指南** there to return
   to the native guide list. GRIP saves each guide's visible text and exact
   viewport offset independently.
4. For instant in-game access after that first handoff, map the upper-left
   rear button **L4** to **Scroll Lock** in the game's Steam Input layout. Press
   L4 once to open GRIP and press it again to return to the game. GRIP reads the
   physical L4 button directly; the Scroll Lock mapping simply prevents the
   button from also performing a common game action.

The first foreground open downloads the public guide. After that, GRIP preloads
the most recent guide only when its validated local cache already exists, and
keeps that document and reader position in memory for the lifetime of the plugin.
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

Local favorites are stored separately in `favorites.json`, capped at 20, and
never synchronized to the Steam account. The Rust sidecar validates and writes
the file with the same private, locked, atomic replacement used by the position
stores, so an older plugin can still read existing position schemas after a
rollback. Repair preserves invalid bytes in a same-directory backup before
resetting only the damaged store.

Images live under the guide cache's `images/` directory. Each image is limited
to 8 MiB and a validated 8192-pixel / 16-megapixel canvas, the disk LRU to
128 MiB, and the Rust memory LRU to 24 MiB. The reader downloads only images
near the viewport and keeps at most 32 MiB / 64 entries of estimated decoded
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
