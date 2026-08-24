# GRIP

**Guide Resumes In Place** — resume Steam Community Guides exactly where you
left off on Steam Deck.

> Project status: foundation and on-device investigation. Automatic capture and
> restoration are not enabled yet.

## Why GRIP exists

Steam's in-game guide overlay can remember a position while its current history
entry survives, but reopening the overlay may rebuild that history and return
the guide to an earlier location. GRIP will persist the exact guide position and
restore it when the guide is opened again.

## Architecture

- **TypeScript/React** integrates with Decky and Steam's Gamepad UI.
- **Python** persists a small, versioned `positions.json` file using atomic
  replacement.
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

## Storage

Guide positions are stored under Decky's plugin settings directory as
`positions.json`. The initial schema stores:

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

`positions.json` is private to GRIP's single backend process. Backend RPC calls
are serialized before entering the file store, so their arrival order is not
reordered by the executor thread pool.

## Publishing

This repository is currently a local-development scaffold, not a store-ready
release. A public repository, stable public listing image, complete third-party
license review, working guide capture/restore flow, and device regression pass
are required before adding a `publish` block or submitting to the Decky store.

## Name

**GRIP** expands to **Guide Resumes In Place**. The repository name is
`decky-grip`.

## License

BSD-3-Clause. See [`LICENSE`](LICENSE).
