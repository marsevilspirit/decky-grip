# Architecture and device findings

## Module boundaries

The frontend entry point wires features to Decky. Source selection, offline
transactions, document rendering, and temporary import resources have separate
owners; there is no provider registry or dependency-injection framework.

| Responsibility                              | Owner                                                | Boundary                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decky registration and feature coordination | `src/index.tsx`                                      | Connects routes, status, caches and game lifecycle; shows user-facing notifications.                                                                             |
| Download source selection                   | `src/guide-download.ts`                              | Chooses Steam preparation or public Heybox capture; knows which commit persists game association. No UI state.                                                   |
| Offline transaction and download jobs       | `src/reader/download.ts`                             | Prepare → save every image → commit/discard; owns cancellation, progress and shared job lifetime. No Steam or Decky API imports.                                 |
| Platform/browser access                     | `src/steam/`                                         | `import-browser.ts` owns one temporary Steam browser page; `src/import/heybox.ts` reads and sanitizes public article DOM without Steam APIs.                     |
| Reader interaction / document presentation  | `GuideReaderPage.tsx` / `GuideDocument.tsx`          | Page owns focus, restoration, search and hydration scheduling. Document receives the validated guide, visible section count and content ref; it performs no I/O. |
| Decky RPC and backend lifetime              | `main.py` / `py_modules/rust_sidecar.py`             | Adapts public RPC names, events, cancellation and process lifetime. Import business logic stays in Rust.                                                         |
| Temporary import sessions                   | `backend/src/import_sessions.rs`                     | Owns reserved/running captures and the opt-in phone inbox; cancels queued work and closes active transports before shutdown.                                     |
| CEF capture / phone inbox                   | `backend/src/heybox_renderer.rs` / `phone_import.rs` | Fixed marked-page CDP capture and bounded opt-in HTTP inbox. No provider framework; uses existing cache transactions after capture.                              |
| Validation and durable storage              | `backend/src/`                                       | Rust revalidates untrusted input, enforces cache budgets and atomically replaces files.                                                                          |

The download call path is `index.tsx → guide-download.ts → reader/download.ts
→ backend.ts → main.py → Rust`. Heybox preparation also uses the isolated
Steam browser and bundled DOM extractor; downloaded articles never need that
browser to be read.

The Rust runtime reserves captures when their RPC arrives, before worker dispatch,
so cancellation also covers queued captures. Images and captures share at most
three of four general workers, leaving a slot for foreground and cancellation
requests. Storage keeps its separate worker. The phone inbox starts only on an
explicit RPC and owns all its accepted sockets. Graceful shutdown cancels captures
and closes the listener/clients before draining the remaining queue.

`guides.commit_import` validates the game key and position store before publishing
the complete offline guide. It then updates recent-access time under the existing
position-file lock, retaining the latest scroll and anchor even if another save
arrived during publication. An association failure after publication is an error
with an explicit partial-success message, not a cross-file atomic transaction.

Keep these invariants when moving code:

- Body/image cache identity is the guide id; reading position and association
  identity is `appId:guideId`. Do not merge the two storage scopes.
- A download succeeds only after complete image validation and publication;
  imported game association finishes before graceful sidecar shutdown.
- `GuideDocument` keeps stable `dangerouslySetInnerHTML` objects for unchanged
  section HTML. Parent rerenders and appended chapters must not replace hydrated
  image nodes. Its style node stays outside the indexed content container.
- Restoration, incremental section mounting and focus still share the Page's
  lifecycle. Do not split them into hooks that merely exchange mutable refs.
- Reader navigation has one state: `collapsed`, `toc`, or `search`. Focus can
  expand a collapsed directory but must not replace an active search. The
  article is inert only for the modal directory or a covering viewer/switcher.
- Public RPC signatures, cache schemas and hardware hotkeys are unchanged by
  this refactor. Validation is local; no device deployment is implied.

## Confirmed on-device behavior

Read-only CEF inspection on 2026-08-24 used Decky Loader `v3.2.8-pre1`.

The Decky plugin executes in `SharedJSContext`, while the native Steam guide DOM
belongs to `GamepadUIMainWindowInstance.BrowserWindow.document`. The observed
overlay route was:

```text
/app/1113000/overlay/guides
```

Steam instantiated scroll restoration state named for the application and
guide, including:

```text
OverlayGuides_1113000
OverlayGuide_3414883877
OverlayGuide_3414883877ScrollTop_HistoryValue
```

At inspection time, the real scroll container and the corresponding history
value both reported `5561.3335`. This shows that Steam already measures the
correct location. The likely failure is loss of the relevant React Router
history entry when the overlay is closed or reconstructed.

## Native implementation boundary

The original GRIP path preserves Steam's existing state. It is now explicitly a
best-effort compatibility path: physical overlay reactivation also restores
Steam FocusNav history, whose focused section title may scroll after a pixel
restore has already been confirmed.

```text
Steam overlay location.state
          │
          ▼
TypeScript capture / restore adapter
          │ debounced RPC
          ▼
Python Decky RPC shim
          │ JSON lines
          ▼
Rust sidecar
          │ atomic replace
          ▼
positions.json
```

The frontend identifies the active guide through the named
`MainMenuStore.GetSelectedGuide(appId)` API. Opening and closing a detail view
uses `SetSelectedGuide(appId, guideId | null)` while the route remains unchanged.
GRIP patches that named setter only to start or stop a guarded restore epoch; it
does not replace Steam's React tree or navigation methods.

The guide detail ScrollPanel is identified by stable class tokens (`Panel` and
`Focusable`) plus its `20px / 20px` inline scroll padding. The guide list uses a
different top padding, so it is excluded. A match is accepted only while a
valid guide route and selected guide are active, and ambiguous matches fail
closed.

Steam normally restores in a layout effect before lazy-loaded images have
necessarily expanded the article. The browser can clamp that early request,
after which Steam writes the smaller value back to history. GRIP suppresses
capture during a restore epoch, waits for sufficient and stable content height,
applies the saved DOM position, verifies it, and only then merges the value into
Steam's existing location state.

Steam can also reset a guide panel to zero while tearing it down. GRIP treats a
zero that would replace a nonzero bookmark as provisional: it must originate
from the real scroll panel after user scroll intent, and the same connected
panel must remain at the top for 400 ms. History, blur, and teardown snapshots
cannot authorize that destructive update on their own.
If restoration times out, its target still protects the bookmark from passive
polling, blur, and close snapshots. A layout change or focus return retries the
same target; deliberate scrolling releases the protection.

All Steam-specific assumptions must stay under `src/steam/`. Persistence and
the Decky panel must not depend on React Fiber shapes or minified module names.

## Position identity

The storage key is `<appId>:<guideId>`. Steam ids remain positive decimal
strings; the independent reader also accepts `heybox-<12 lowercase hex digits>`
as the guide id. The first, native schema stores Steam's exact `scrollTop` value.

The native compatibility store remains pixel-only. Text anchors live in the
independent reader store because only that renderer can guarantee stable,
non-focusable content nodes.

## Independent reader

The physical Steam-button failure proved that pixels alone are insufficient:
Steam restores a focusable section title after route and layout restoration.
GRIP Reader therefore owns a separate, non-focusable article scroller.

```text
Steam Community public guide
          │ HTTPS, bounded response
          ▼
Rust allowlist parser ──► validated 0600 cache
          │ structured sections + inert image keys
          ├──► bounded image disk/memory LRU ──► local Blob URLs
          ▼
Decky full-screen reader route
          │ scrollTop + section/text/viewport offset
          ▼
reader_positions.json
```

Steam preparation accepts decimal guide ids, Steam HTTPS hosts, bounded UTF-8
HTML, and known guide page structure. Imported Heybox content takes a separate
validated path with namespaced ids and its own image-host allowlist, then joins
the same offline transaction. Scriptable elements, event handlers, inline
styles and unsafe URLs are removed or rejected. Cached content is
validated on first use and whenever its on-disk signature changes. Validated
documents and reader positions stay in a plugin-lifetime memory snapshot, so a
warm L4 open renders immediately; expired content remains visible until the user
requests an update. Background preloading is cache-only and reads an atomically
stable file snapshot without taking the foreground lock; network and write I/O
is serialized per guide id, so one slow Steam request cannot block another guide.
Remote image URLs are removed from returned HTML. Only allowed Steam/Heybox HTTPS
static PNG/JPEG/GIF/WebP content with bounded encoded bytes and decoded
dimensions can enter the bounded Rust cache. The image decoder validates actual
pixels before a download or changed disk file counts as complete; unchanged
validated signatures reuse the result. Animation checks inspect format structure,
not arbitrary bytes inside metadata or compressed content. Rust memory-cache
access shares an immutable `Arc<ImageData>` payload; Base64 encoding for RPC
responses remains. The frontend observes
all images within the bounded guide, selects at most 512 active hydration
candidates, deduplicates URLs, stages at most 48 distinct requests, and pins
actually visible blobs. Scroll bursts reuse one animation-frame pass and the
near-viewport image set for geometry, pinning and visible-image actions, rather
than rescanning all image nodes. Nearby preloads remain evictable under the existing
decoded-residency LRU. If visible images themselves exceed that budget, a capacity
control lets the user prioritize one without growing the budget. Clearing the
image cache synchronously acquires a
token that pauses and invalidates active reader work before the backend deletes
memory and disk entries. The reader mounts one
budgeted section first, incrementally indexes new text nodes, first applies the
pixel fallback, and then aligns the saved text anchor after relevant layout or
image-size changes.
An arriving background update may capture a new DOM bookmark only after the
reader checkpoint is safe; otherwise it retains the existing restoration target.

The physical L4 event carries the userspace HID-read Unix timestamp and sequence
number. A readable-descriptor wait wakes on incoming data; its bounded timeout
only checks for shutdown and is not an intentional input delay. The timestamp
does not measure the preceding physical-button/device/report-delivery latency.
The frontend records route request/mount, cache readiness, first content frame,
spinner visibility, and a stable position outcome. Physical opens that fail,
time out, are superseded, or are canceled terminate as failures in the same
rolling attempt window. Once 20 warm attempts are retained, successful
memory/disk samples contribute latency values to the P95 ≤ 300 ms calculation,
while any retained warm failure fails that gate.
Visible queued or deferred images cannot complete the gate. Failed or
capacity-limited visible images allow the article to remain usable but report an
unavailable position outcome, not a passing complete-screen sample.

Guide and position reads fail independently: an unavailable or corrupt reader
position does not block cached body rendering, and a failed refresh keeps the
old body visible with an explicit warning. Store repair is user-triggered and
backs up the invalid bytes before atomically writing an empty validated store.
The reader's Y switcher is a cache-only Rust query over the 20 newest
`reader_positions.json` entries. It joins only validated title, author, section,
and staleness metadata from the existing guide cache; it never downloads in the
background, and removing one cached body leaves its reader position intact.
Its summary LRU has a separate 1 MiB serialized-payload budget outside the 32 MiB
body LRU and retains no HTML. Safe file-signature checks reuse unchanged summaries;
changed files are fully revalidated, and staleness is computed at query time.
Publication, removal and clearing invalidate summaries; an in-flight pre-clear
validation cannot repopulate them afterward.

For a first-time handoff, the controller uses its native pixel bookmark only to
probe the still-mounted native Steam DOM and capture the corresponding visible
text. The independent reader then resolves that text in its own layout and
saves its own pixel fallback. Native pixels are never applied directly across
the two renderers.

## Safety constraints

- No root flag.
- Never write inside the installed plugin directory.
- Debounce scroll persistence; do not write on every scroll event.
- Flush once on navigation/unmount after the normal debounce.
- Verify the active guide id again before applying an asynchronous restore.
- Remove every route patch, observer, and timer from `onDismount()`.
- Preserve corrupt or unknown storage files and surface an error.
- Keep `positions.json` private to the Rust sidecar. RPC operations are
  serialized before entering its storage worker.

## Runtime lifecycle

1. Preload all validated positions through the Decky backend bridge.
2. Attach to the main Steam window's history, selected-guide store, and real DOM.
3. Debounce ordinary scroll captures and flush on guide close, blur, or unload.
4. Start a protected restore when a saved guide appears or its DOM is rebuilt.
5. Wait for a reachable, stable layout; restore and verify within one pixel.
6. Remove every patch, listener, observer, interval, and timer on dismount.
