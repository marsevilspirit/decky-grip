# Real-browser interaction regression

Run `pnpm exec playwright install chromium` once, then `pnpm run test:browser`.
For an already installed local Chrome, use `PW_CHANNEL=chrome pnpm run test:browser`.
The server binds only `127.0.0.1:4173`, refuses an occupied port, and stops with the runner.
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

The adapter replaces only Decky primitives and the router/backend boundary.
F2 and F3 dispatch the existing Y/X callbacks; they do not validate Steam spatial
navigation, actual Decky styling, controller hardware, offline networking or device performance.
No Steam Deck connection is required or attempted.
