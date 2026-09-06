# Steam Deck acceptance — 2026-09-06

## Scope and build

The initial run covers orphan-image reclamation, canceling a reader update, and
reader latency/recovery. Its tested working tree started at `5841e64`; the
changes were uncommitted at that time. No new dependency was added. The later
warm-image follow-up is recorded separately below.

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

## Warm-image follow-up — 17:41 Asia/Shanghai

The follow-up starts at `e433da9` with an uncommitted frontend change. Closing
the reader previously revoked every image Blob URL, forcing another image RPC,
base64 conversion and new browser image resource on each reopen. The plugin now
reuses its existing 64 MiB / 64-entry image LRU across reader lifetimes. Closing
releases old DOM references and invalidates pending hydration; explicit image
cleanup and plugin unload still revoke the retained URLs. No dependency or
additional cache layer was added.

`pnpm run check` passed again, now with 200 frontend tests and the same 95 Rust
tests, Python/real-bridge checks, formatting, TypeScript, Clippy and build. New
regressions cover warm reuse over 20 page lifetimes, capacity eviction, explicit
cleanup, stale in-flight responses, and a real React reader unmount/remount.
The current sidecar was rebuilt through the Holo toolchain before packaging.

| Artifact                              | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `decky-grip-20260906-warm-images.zip` | `b455d2494c761cf73a66b5fd37561ffad178c14dd25f870a0da2421f53074b3b` |
| Installed `dist/index.js`             | `b02ac374b94b5448c09d4e78d0850493560981ce0280e13403246b465f34fec7` |
| Installed `bin/grip-sidecar`          | `bfff47b7a3f18069fa20d6329747d3662e36ca60e716056771f0ee449c0ebe01` |

Local/uploaded ZIP integrity and hashes matched. Decky's native installer
completed at 17:41. File watching caused an initial reload and a five-second
stop-timeout warning; the final Python/sidecar pair (`120982` / `120983`) was
healthy at both 17:41:17 and 17:42:05. No further errors appeared in the inspected
Loader interval. RPC reported a running L4 listener, five cached guide files and
105 image files. Both saved-position file hashes were unchanged across the
installation, before subsequent reading tests.

Rollback backup, containing plugin and settings:
`/home/deck/.local/share/grip-deployment-backups/before-warm-images-mXt1aA.tar.gz`.

### Controlled device comparison

The same guide (`1113000:2142283577`) and normal reader actions were exercised
before and after installation. The probe observed the existing
`markPositionSettled` callback without altering it. Both runs retained section
mounting, image completion and the original 100 ms stable-layout requirement.
These remain software-action measurements inside the actual Deck renderer,
not physical L4-to-screen samples.

| Measurement                       | Before, 6 warm opens | After, 20 warm opens |
| --------------------------------- | -------------------: | -------------------: |
| First content frame range         |        83.7–102.5 ms |        57.7–109.7 ms |
| Complete restoration range        |       456.2–648.3 ms |       191.9–282.3 ms |
| Complete restoration P95          |             648.3 ms |             249.4 ms |
| Distinct first-image Blob URLs    |                    6 |                    1 |
| Restored position in every sample |    29.33333396911621 |    29.33333396911621 |

Every sample reported `restored`; the first image was complete with natural
width 2741. The final screenshot visibly contained the expected guide image.
After 20 reopens the retained cache held three images, estimated at 52,946,556
decoded bytes, below the unchanged 64 MiB limit.

The 20 post-install restoration times were, in milliseconds:
`225.4, 246.9, 245.2, 236.2, 244.8, 249.4, 231.6, 232.4, 247.4, 209.7,
212.1, 217.4, 201.0, 212.9, 221.5, 216.4, 282.3, 202.9, 191.9, 194.2`.
Raw local probe results and screenshots are under
`/private/tmp/grip-warm-images.Y0qj79/` (`before.json`, `after.json`).

The software-action P95 is below 300 ms, but the physical-input gate is still
pending. Plugin reload naturally starts a new tracker window; the previous
eight physical attempts and their failures remain documented above. The probe
did not generate hardware events or change this new window: it showed zero
physical attempts both before and after the software series. New-version
in-game L4/Y acceptance has been requested from the user. This follow-up did
not repeat the disruptive Wi-Fi-off or suspend checks from the initial run.
