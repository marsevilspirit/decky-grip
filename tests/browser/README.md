# Real-browser interaction regression

Run `pnpm exec playwright install chromium` once, then `pnpm run test:browser`.
For an already installed local Chrome, use `PW_CHANNEL=chrome pnpm run test:browser`.
The fixture server binds only `127.0.0.1:4173`, refuses an occupied port, and stops with the runner.
Failures retain screenshots and traces in `test-results/browser/`.

These tests render the real `GuideReaderPage`, `GuideDocument` and `GuideSwitcher`
at 1280×800, measuring DOM geometry rather than replacing layout methods.
ResizeObserver, IntersectionObserver, Range, focus, scroll and PNG Blob decoding
all run in Chromium. The delayed-image test holds only the backend response and
verifies that the production hydrator and search alignment recover from the resulting layout shift.

The `journey` fixture uses distinct local guides and a small stateful route boundary.
Guide switching changes the real reader's route, closing unmounts it, and reopening
uses the same production `ReaderSessionCache`. Successful position writes go to
localStorage and are read back after a page reload with a fresh cache. The journey
tests check A → B → A, close/reopen/reload, a failed guide switch, and a failed
position write followed by retry. HTTP response gates under `/fixture/` allow
deterministic local fault injection without sleeping or replacing reader behavior.

The `scroll` fixture contains 20 chapters with 30 copies of one cached image per
chapter for dense-image viewport work checks. The default fixture remains the
18-chapter table/image layout case. No fixture replaces DOM geometry or decoding.

The `import` fixture renders the real `PhoneImport` and `ImportGuideModal`.
The runner builds the existing Rust test target and opens its real phone HTTP
inbox on an ephemeral loopback port, closing it with the server. jsQR (test-only)
decodes the QR image at its displayed size; a second browser page opens that URL
and submits through the real phone page and token validation. The production
`GuideDownloadTasks` and `downloadOfflineGuide` then handle game confirmation,
image deduplication, progress, failure, cancellation, retry and publication.
Only article extraction and image/disk transports are controlled fixtures.
Tests check that partial/canceled versions never publish, retries reuse saved
images, and a completed version opens the real reader with decoded PNGs. This
does not validate live Xiaoheihe capture, real phone cameras or Deck networking.

The adapter replaces only Decky primitives and the router/backend boundary.
Dialog components remain structural stand-ins: a system-color surface provides
occlusion for layout tests, not a copy of Steam's styles. Do not treat fixture
screenshots as native Steam visual acceptance.
F2 and F3 dispatch the existing Y/X callbacks; they do not validate Steam spatial
navigation, actual Decky styling, controller hardware, offline networking or device performance.
No Steam Deck connection is required or attempted.
