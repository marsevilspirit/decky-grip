# Steam Deck acceptance — 2026-09-06

## Scope and build

This run covers orphan-image reclamation, canceling a reader update, and
reader latency/recovery. The tested working tree starts at `5841e64`; the
changes are not committed. No new dependency was added.

`pnpm run check` passed: formatting, TypeScript, 197 frontend tests, the Python
suite (one skipped test), the real Rust bridge integration check, 95 Rust tests,
Clippy, and the frontend build. The added regression coverage checks shared and
pending image references, canceled-download reuse, unsafe sibling cache files,
cancel/update publication boundaries, and fractional-scale anchor restoration.

The Rust sidecar was rebuilt with the official x86_64 Holo toolchain. The final
package was installed through Decky's native installer on `ssh deck`.

| Artifact                     | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `decky-grip-20260906-r2.zip` | `f7a26dd59c71fd482326b35f69f8948ca933f109c1d819ee19f56662b5f7c109` |
| Installed `bin/grip-sidecar` | `bfff47b7a3f18069fa20d6329747d3662e36ca60e716056771f0ee449c0ebe01` |
| Installed `dist/index.js`    | `2478c0ad70b940c3f7d521f9d4c844065091db7aec2830b44568846ca4997265` |

Both local and uploaded ZIPs passed integrity checks. Installed file hashes
matched, and two spaced checks found the same healthy GRIP Python/sidecar
processes; the later check was 469 seconds after startup. Decky remained active.
Existing guide bodies and images were preserved. Saved-position file hashes
were unchanged immediately after the initial installation; subsequent reading
tests legitimately updated reading history.

Rollback backup (plugin and settings, on the Deck):
`/home/deck/.local/share/grip-deployment-backups/before-20260906-orphan-cancel.tar.gz`.

## Observed device results

Times below were measured inside the actual Deck CEF renderer. Programmatic
reader actions exercised the installed plugin's existing handlers; they are
**not physical controller-to-screen latency samples**.

| Check                                        | Result                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancel update                                | Button feedback in 106.6 ms; cancellation settled in 1345.9 ms while waiting for in-flight work. The original article DOM node and scroll position `32880` stayed unchanged. The reader displayed the cancellation message, not an update-failure warning. |
| Reopen, final build, 6 runs                  | First content frame: 131.4, 81.5, 74.9, 83.7, 86.3, 66.7 ms. All six restored `scrollTop = 29.33333396911621`, with no warning.                                                                                                                            |
| Existing Y-handler path, 4 switches          | Switcher visible in 12.8–28.6 ms; destination content frame in 62.6–202.7 ms. Both guides retained their independent positions (`32880` and `29.33333396911621`).                                                                                          |
| Actual Wi-Fi-off reopen, final build, 3 runs | Content frame: 123.8, 84.7, 103.4 ms. First image decoded/display-ready: 339.0, 350.7, 287.0 ms. All three used local Blob URLs, reported natural image width 2741, and kept the same reading position.                                                    |
| Actual Wi-Fi-off full image-cache read       | All 61 unique images in guide `2142283577` returned local bytes with downloads disabled, in 5904 ms total (three concurrent RPC readers). This is a full-cache verification, not the reader's startup delay.                                               |

The cancel-update check was performed on the first deployment. The final `r2`
deployment changes only fractional anchor restoration relative to that build;
the cancellation implementation is unchanged and its full regression suite was
rerun.

### Offline evidence

The transient user service `grip-offline-observe-20260906c` sampled
`nmcli -t radio wifi` once a second. Its journal records Wi-Fi disabled from
02:24:46 through 02:25:13 Asia/Shanghai and enabled again at 02:25:14.

The UI checks ran from 02:24:49.322 through 02:24:52.574, and the 61-image cache
read from 02:24:49.403 through 02:24:55.307: both entirely inside the disabled
interval. Wi-Fi restoration was armed before disabling it and was verified
afterward. Chromium's `navigator.onLine` stayed true because another virtual
interface existed, so it was not used as proof of network availability.

Image display timing requires both `complete` and positive `naturalWidth`;
assigning an image URL alone is not counted as successful rendering. This run
validates the fully downloaded 61-image guide, not every legacy body-only cache.

### Bug found and fixed during acceptance

At Steam's fractional UI scale, assigning a microscopic anchor correction on
every reopen rounded the scroll position down by roughly two-thirds of a CSS
pixel each time. The shared anchor-restoration function now skips corrections
within its existing one-pixel tolerance. A 40-reopen fractional-scale unit check
and the six final-build device opens both preserve the position.

## Suspend and controller acceptance

### Suspend/resume verified

The system journal records actual suspend at 02:30:15 and return from suspend at
02:33:20 Asia/Shanghai. After reconnection, Decky was active, Wi-Fi was enabled,
and the same GRIP Python/sidecar processes were still running. No plugin reload
or backend restart was needed.

The reader was not visible when the post-wake inspection attached; by then the
game was running. This observation does not establish whether the page closed
because of suspend or subsequent user navigation. Reopening the same guide
through its normal reader action produced content in 137.4 ms and the decoded
local image in 345.2 ms. The scroller and persisted backend position both remained
`29.33333396911621`, matching the pre-suspend value; no reader warning appeared.
The physical L4 monitor still reported available/running on `/dev/hidraw2`.
Actual button handling was checked separately below.

### Physical input and user confirmation

After being asked to exercise in-game physical L4 open/close and Y guide
switching, the user reported no problems. Physical input produced versioned
backend events in the existing tracker; no synthetic L4 event was sent by the
test scripts. This verifies the installed **L4 rear-button** path, not keyboard
F4 support. Y functionality is user-confirmed; its numerical timings above are
still software-handler measurements, not controller-to-screen timings.

The read at 02:48:59.308 Asia/Shanghai contained eight actual warm-cache attempts:

| Outcome                  | Content frame (ms) | Position settled (ms) |
| ------------------------ | -----------------: | --------------------: |
| Restored                 |                116 |                   591 |
| Restored                 |                117 |                   670 |
| Closed before settlement |                  — |                     — |
| Restored                 |                 90 |                   535 |
| Restored                 |                 91 |                   546 |
| Closed before settlement |                  — |                     — |
| Restored                 |                 96 |                   521 |
| Restored                 |                106 |                   381 |

All six completed opens used the memory cache, showed no spinner, and restored
their positions. The two early closes were recorded at 653 and 706 ms and remain
failures in the measurement window; they were not erased or relabeled as
successful opens.

Functional acceptance is user-confirmed, but the stricter warm performance gate
is **not certified**: eight attempts are below its minimum of 20, and the observed
completed-sample P95 is 670 ms versus the 300 ms target. The tracker correctly
remains `collecting`. The reader's complete-restoration timer includes mounting
the sections, decoding near-viewport images, and a 100 ms stable-layout check,
not just the first text frame. Those safety checks were not weakened to make
this measurement pass. Further work on the 300 ms full-restoration target remains
a performance follow-up, not a claimed result of this acceptance run.
