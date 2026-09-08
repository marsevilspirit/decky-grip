# Heybox import: implementation and acceptance

Status: local implementation and validation. Steam Deck testing is explicitly
deferred by the user for this iteration; no deployment or device acceptance is
claimed.

## Flow

1. Paste share text, or explicitly enable the phone inbox and scan its QR.
2. Confirm the Steam game on the Deck. Phone receipt only fills the input.
3. Create one temporary Steam BrowserView with a unique fragment marker.
   The Rust sidecar attaches only to that exact page on local CEF port 8080.
   It never enables remote debugging or navigates an existing user tab.
4. The bundled DOM extractor waits for the article and every body image URL,
   removes game/product cards and non-article content, and preserves chapters.
   Unsupported media or missing content aborts the import.
5. Rust revalidates the source, resource id, HTML budgets and complete image
   manifest. Existing prepare/download/commit/discard transactions publish only
   after every image is validated and durable. One backend operation performs
   publication and game association before graceful unload can close the sidecar,
   preserving the existing reading position. Association failure is reported as
   an error, never import success; this is not a cross-file power-loss transaction.
6. Read through the existing reader, width-fit images and image viewer. Updates
   rerun capture; failed updates leave the prior complete guide available.

Only `imgheybox.max-c.com` images are accepted for Heybox. Source/redirect,
byte, pixel, HTML and disk-budget checks remain in force. Steam numeric ids,
native positions and old files are unchanged; section ids remain numeric.

The LAN inbox binds an ephemeral port only while enabled, expires after ten
minutes and closes on receipt, manual close, modal unmount or plugin unload.
It has one-use submission, a fragment token, exact Host/Origin checks, bounded
requests/concurrency, no CORS, no external page resources and no request logs.
It uses HTTP on a trusted LAN and requires working `.local` resolution.

## Evidence (2026-09-08)

- Live public DOM was inspected for `8a79701fa858`, `4aec6fe8edfc`, and
  `249c72219fed`: 16/7/15 body images, 12/6/0 chapter headings, 0/4/15 image
  captions, and the expected title/author selectors. The first article contains
  a game card to remove.
  This was normal browser inspection, not execution through Steam CEF.
- The samples' `h4.img-desc` elements are image captions, not chapter headings.
  The extractor now keeps them with the preceding image; a regression
  test failed before the fix and passes afterward. Captured article DOM snapshots
  were replayed through the shipped extraction bundle: 13/7/1 output sections,
  all 38 body images and all 19 captions retained, game card removed. Snapshots
  omit comments; the first two also mechanically remove Vue attributes, inline
  styles and empty comments before replay. No site text was added to repository
  fixtures. This exercises extraction, not the Steam browser capture transport.
- The real Rust sidecar prepared, downloaded and committed all three extracted
  guides: 16/16, 7/7 and 15/15 images. Early attempts had image request failures;
  those attempts aborted before publishing the incomplete guide. Explicit retries
  reused downloaded images and completed the missing ones. This is not evidence
  of automatic retry or first-attempt network reliability.
- After closing the original sidecar, a fresh macOS process ran under
  `sandbox-exec` with `(deny network*)`. All three cached bodies matched the
  committed bodies, all 38 images returned `fromCache: true` with positive
  dimensions and valid nonempty base64, and all three download states remained
  `complete`. Image bytes were 1,134,414 / 481,400 / 803,692. This did not disable
  the Mac's network or connect to a Steam Deck; on-device rendering is still open.
- Shared image errors now use source-neutral wording instead of identifying
  a failed Heybox image request as a Steam failure; download behavior is unchanged.
- Frontend tests cover source validation, extraction, missing/unsupported media,
  lazy DOM stability, navigation, cancellation, game identity and import feedback.
- Only images without source URLs are scrolled to wake lazy loading. Already
  resolved URLs no longer incur repeated 200 ms waits per image; the same two
  stable-content intervals and complete offline image validation remain. A fake-
  timer regression accepts 61 ready image URLs after 400 ms and another verifies
  that newly appended lazy images restart the stability check. These are local
  scheduling checks, not real network/rendering latency measurements.
- Editing the link (including phone receipt) or game clears the previous import's
  completion/error feedback, without starting a download. Late phone receipt
  cannot change the form while an import is in progress.
- Navigation away from the temporary article immediately fails capture and
  cancels the backend request. Failure to remove its navigation listener does
  not prevent the temporary page from closing or replace the original error.
- A retained reader integration test takes a synthetic Heybox article through
  extraction, the session cache, image hydrator and the existing reader/viewer.
  It checks captions, width-fit CSS, Blob-only image nodes, zoom, gallery switching,
  return to the same scroll position, and no guide fetch/download.
  The same test also passed once with temporary inputs from the third real DOM
  snapshot and the actual local-only Rust RPC results (one section, 15 WebP images
  at 1280 x 582). The real input override was then removed and the retained test
  rerun. Viewport geometry, Blob URLs and gamepad events use the existing test
  adapters: this is component integration evidence, not CEF painting or physical
  button acceptance. Neither the article nor its image bytes enter the repository.
- Rust tests exercise the actual import RPC, exact 4 MiB body boundary, image
  completeness, retained old content, source restrictions and independent history.
- Rust tests cover marked-page isolation, local CDP/response limits and cleanup;
  loopback HTTP tests cover inbox auth/origin, expiry, concurrency and port release.
- Bridge regressions cover imported publication followed by association under
  the existing I/O lock, validation/publication/association errors, cancellation,
  and queued commits rejected during unload. A local real-sidecar check paused
  immediately after commit and triggered unload (also cancellation during a
  reimport): cold restart retained the library entry and complete guide, with
  existing scroll position, section and anchor unchanged.
- A real browser opened a loopback inbox, submitted the third sample link, showed
  “待确认并下载，不代表导入成功”, and the server returned that exact share text.
  No Steam Deck or phone was involved in this loopback check.
- `pnpm run check` passed after the local import optimizations: 305 frontend tests, 57 Python
  tests (one conditional skip, separately covered by the real sidecar process
  integration test), 104 Rust tests, formatting, type checks, Clippy and build.

## Rust migration (local, 2026-09-08)

CEF capture, the LAN inbox, import-session lifetime, publication/game association,
and combined store repair now run in Rust. The three old Python import modules
were removed. Production Python is 747 lines instead of 1,212 (counting comments
and blank lines); it retains Decky callbacks, public RPC adaptation and process
transport. The DOM extractor stays TypeScript because it executes inside CEF.

The existing cache transaction is reused. Capture cancellation is ordered after
the request write, including executor-queue cancellation and submission failure.
Phone-start cancellation finishes exact-session cleanup before a retry. Rust
tests use random loopback ports for HTTP/WebSocket transport checks, and the real
sidecar protocol test covers publication, preserved bookmarks and closed imports.

`pnpm run check` passed: 314 frontend tests, 42 Python tests (one conditional skip,
then its real-sidecar integration passed separately), 136 Rust tests, formatting,
type checking, Clippy and build. No Steam Deck connection or deployment was made;
this migration is not a device-speed benchmark.

## Deferred device checks (outside this iteration)

These checks are retained for a future device session, not as blockers for the
current code-only work. Local checks do not establish platform compatibility.

- Import all three real samples through the shipped Steam BrowserView/CDP path;
  verify hidden-page lazy loading and preservation of the unique target marker.
- Confirm all 38 images are downloaded and all three guides can be read offline,
  including screenshot zoom, Y switching and restored positions after reopening.
- Scan from a real phone on the same LAN; verify `.local` resolution and the
  receive -> Deck confirmation -> full download flow, including error feedback.
- Cancel during discovery/images, unload during publication, and retry after a
  network failure; verify old content and game association after plugin restart.
- Compare physical L4 restore behavior/performance with the existing acceptance
  baseline. No new device performance claim has been made.
