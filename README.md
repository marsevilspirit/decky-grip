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
- **Python** persists a small, versioned `positions.json` file using atomic
  replacement.
- **GRIP Reader** downloads a public Community guide through the Python
  backend, sanitizes it with a strict HTML allowlist, caches it locally, and
  renders it in a dedicated Decky route.
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
- The plugin does not need root privileges.

The current Steam UI findings and implementation boundaries are recorded in
[`docs/architecture.md`](docs/architecture.md).

## Development

Requirements follow the current official Decky template:

- Node.js 20.19+, 22.12+, or 24+
- pnpm 9
- Python 3.9 or newer

```bash
just install
just check
```

Individual checks are also available:

```bash
just typecheck
just test
just build
```

The frontend bundle is written to `dist/index.js`. Python tests use only the
standard library.

## Using GRIP Reader

1. Open a Steam Community guide and leave it on the paragraph you want. For the
   first handoff, keep the guide visible and open Decky with the Quick Access
   button.
2. Select **GRIP**, then choose **在 GRIP 阅读器中继续**.
3. Scroll normally in the full-screen reader. GRIP saves the first visible text
   and its exact viewport offset automatically.
4. For instant in-game access after that first handoff, map the upper-left
   rear button **L4** to **Scroll Lock** in the game's Steam Input layout. Press
   L4 once to open GRIP and press it again to return to the game. GRIP reads the
   physical L4 button directly; the Scroll Lock mapping simply prevents the
   button from also performing a common game action.

The first open downloads the public guide. After that, GRIP preloads the most
recent guide and keeps its validated document and reader position in memory for
the lifetime of the plugin. A cache older than six hours still opens immediately;
use **更新** when you want to fetch the newest version.

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
instead of being silently replaced.

GRIP Reader uses separate `reader_positions.json` and `guides/<guide-id>.json`
files. Reader bookmarks include `section_id`, `anchor_text`, and
`anchor_offset`; downloaded HTML is revalidated on the first process read and
again whenever the cache file's identity or metadata changes.

`positions.json` is private to GRIP's single backend process. Backend RPC calls
are serialized before entering the file store, so their arrival order is not
reordered by the executor thread pool.

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
