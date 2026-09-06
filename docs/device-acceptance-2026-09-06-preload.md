# Steam Deck follow-up — local image preload and tall images

## Delivered scope

This follow-up starts at `a0675c0`; its changes are uncommitted. Background
preloading now prepares and decodes at most three local images near the saved
text anchor. It reuses the existing image LRU and request slots: 64 MiB of
estimated decoded residency, 64 entries, three concurrent foreground requests,
and 48 pending URLs remain the limits. Preload requests disable downloads and
run sequentially. Opening the reader, changing the relevant game/guide,
cleanup, and unload invalidate stale warming. Legacy pixel-only bookmarks with
no known section skip it.

Resident image dimensions are assigned before observing newly mounted image
placeholders, so collapsed placeholders do not spuriously request images below
the viewport. Tall images initially fit the available width without upscaling;
vertical scrolling and existing zoom controls remain available. The explicit
fit-screen action still displays the whole image.

The third requested item, investigating the installation stop timeout, is
diagnosed below. **Decky's global shutdown implementation was not changed, and
the five-second warning still occurs during installation.** No dependency was
added and the existing layout-stability/restoration checks were not weakened.

## Validation and installation

`pnpm run check` passed after the final code change: formatting, TypeScript,
204 frontend tests in 22 files, 27 Python tests with one skipped, 95 Rust tests,
the real Python/Rust bridge integration, Rust formatting, Clippy, and build.
New regression checks cover nearby-image selection/deduplication, local-only
requests, existing capacity limits, cancellation/late responses, resident-only
mounting, and tall versus landscape image viewing with position preservation.

The unchanged Rust source was rebuilt during this follow-up with the official
x86_64 Holo toolchain. The final ZIP was integrity-checked locally and after
upload, then installed using Decky's native confirmation flow on `ssh deck`.

| Final artifact                    | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `decky-grip-preload-final-v2.zip` | `d18911886d3923600299e504bcf4ef044459ea8024e6c638c678a3ec639a41f3` |
| Installed `dist/index.js`         | `469e769de0f6e974d0f35cb86f743e6cc1d84c97fd660086ef86b07e233c61fd` |
| Installed `main.py`               | `fa031afa956f710f0bb934a7916a57d4aa52e0bc6ac2aa8c9d7f96b47701f728` |
| Installed `bin/grip-sidecar`      | `bfff47b7a3f18069fa20d6329747d3662e36ca60e716056771f0ee449c0ebe01` |

The final load completed at 18:20:09 Asia/Shanghai. Checks at 18:20:20 and
18:21:26 found the same Python/sidecar pair (`121600` / `121602`) alive, with
Decky active. No further warning/error appeared in the inspected interval after
18:20:15. RPC reported the L4 listener available/running on `/dev/hidraw2`, five
guide files, and 105 image files. Reading position remained
`29.33333396911621`, section `4293563`, anchor `更正说明`.

Both saved-position file hashes matched before and after installation, checked
before the first reader probe. Subsequent reading legitimately updated recency.
The final installed `main.py` matches the original uninstrumented file.

Rollback backup (plugin and settings):
`/home/deck/.local/share/grip-deployment-backups/before-preload-C1EruN.tar.gz`.
The final ZIP is in that same directory. Existing downloaded content was not
deleted. This run did not turn Wi-Fi off, suspend, or restart Steam.

After these completed checks, the debug tunnel disconnected and a fresh SSH
attempt could no longer resolve `steamdeck.local`. The final attempt to close
the test reader therefore could not run. The last verified process state is
the 18:21:26 check above; this later connectivity loss is not evidence of a
plugin crash or a successful reader close.

## Actual renderer measurements

On the final plugin lifetime, the observer recorded exactly three background
`get_guide_image` calls, all with `allow_download = false`, before any reader
open. Decky's file watcher also caused an intermediate plugin lifetime during
installation, which made its own three local-only calls; those are retained in
the raw record rather than counted as six images in one preload.

The first normal software-triggered open after the final restart and background
preload showed article content in **114 ms** and reported complete restoration
in **327 ms**. It made **zero image RPCs during opening**. The first image was
decoded and complete at restoration, with natural width 2741 and a local Blob
URL. The first-content measurement alone does not establish image readiness.
The frontend cache held three entries and 52,946,556 estimated decoded bytes,
below the unchanged 64 MiB limit. The saved position was preserved.

An earlier candidate measured 123 ms for content and 305 ms for restoration,
but made three unnecessary foreground image requests. That observation led to
the resident-dimensions-before-observation fix. The final single sample is not
claimed to improve restoration time over that candidate; it verifies removal
of those requests and correct preloaded-image reuse.

These are software actions in the actual Deck renderer, **not physical
L4-to-screen measurements**. The physical tracker remained at zero attempts
before and after the probe; the 20-sample / 300 ms physical-input gate is not
certified. No physical events were synthesized or relabeled.

### Tall-image viewer

On the final installed build, an actual loaded 1401 × 3697 image opened at
822 × 2169.12 CSS pixels in an 854 × 392 viewport. The previous whole-image
fit is 136.424 × 360, so the initial text is now directly readable. A native
wheel event scrolled vertically by 400 pixels; zoom enlarged the image to
1233 pixels wide. Fit-screen returned to the whole-image view, and returning
to the article preserved `scrollTop = 29.33333396911621` exactly. Screenshots
of the first open and width-fitted viewer were visually inspected.

Raw local evidence and probe scripts are under
`/private/tmp/grip-preload-verify.eoh9Fp/`: `preload-rpcs-final-v2.json`,
`first-open-v2.json`, `first-open-v2.png`, `tall-image-v2.json`, and
`tall-image-v2.png`. The earlier candidate records remain there separately.

## Installation unload timeout diagnosis

The device runs Decky Loader **3.2.8**. Temporary phase logging and a two-second
thread dump were installed only for diagnosis, then removed before both final
packages. On the diagnostic unload at 18:05:25, GRIP reached its sidecar-stop
phase. The 18:05:27 dump showed the executor workers idle in
`concurrent/futures/thread.py:81`, no Rust stdout-reader thread remaining, and
the main event-loop thread in this Loader stack:

```text
asyncio/streams.py:650                         readuntil
decky_loader/localplatform/localsocket.py:90    _read_single_line
decky_loader/localplatform/localsocket.py:125   _listen_for_method_call
```

At 18:05:30 the Loader sent SIGKILL after its five-second deadline. This is
consistent with the sidecar-close worker having finished while the event loop
could not resume GRIP's awaiting unload coroutine.

The matching official v3.2.8 source explains the cause:

- [LocalSocket](https://github.com/SteamDeckHomebrew/decky-loader/blob/v3.2.8/backend/decky_loader/localplatform/localsocket.py)
  returns an empty string on socket EOF; its active receive loop keeps creating
  message tasks without breaking on that empty read. EOF reads finish
  immediately, so this loop starves the event loop.
- [Plugin.stop](https://github.com/SteamDeckHomebrew/decky-loader/blob/v3.2.8/backend/decky_loader/plugin/plugin.py)
  sends the stop signal and closes/cancels its response listener before waiting
  for the child to finish, exposing that EOF path.
- [SandboxedPlugin](https://github.com/SteamDeckHomebrew/decky-loader/blob/v3.2.8/backend/decky_loader/plugin/sandboxed_plugin.py)
  awaits the plugin's unload coroutine before completing shutdown.

A bounded stdlib reproduction in `eof-repro.py` fed EOF to an
`asyncio.StreamReader`, mirrored 1,000 read/create-task iterations, and verified
that none of the queued tasks ran until the loop explicitly yielded. It
completed successfully without an unbounded busy loop.

This locates the timeout in Loader's socket-EOF shutdown path, not slow image
downloads or a Rust computation. A Loader-side fix/upgrade is outside this
diagnostic item; no global patch, upgrade, or upstream submission was made.
The final installation still logged the known five-second stop warning before
the new plugin loaded normally. This report does not claim that warning fixed.
