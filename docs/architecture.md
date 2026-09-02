# Architecture and device findings

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

All Steam-specific assumptions must stay under `src/steam/`. Persistence and
the Decky panel must not depend on React Fiber shapes or minified module names.

## Position identity

The storage key is `<appId>:<guideId>`, with both ids represented as positive
decimal strings. The first schema stores Steam's exact `scrollTop` value.

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

The backend accepts only decimal guide ids, Steam HTTPS hosts, bounded UTF-8
HTML, and known guide page structure. Scriptable elements, event handlers,
inline styles, unsafe URLs, and non-Steam images are removed. Cached content is
validated on first use and whenever its on-disk signature changes. Validated
documents and reader positions stay in a plugin-lifetime memory snapshot, so a
warm L4 open renders immediately; expired content remains visible until the user
requests an update. Background preloading is cache-only and reads an atomically
stable file snapshot without taking the foreground lock; network and write I/O
is serialized per guide id, so one slow Steam request cannot block another guide.
Remote image URLs are removed from returned HTML. Only trusted Steam HTTPS
static PNG/JPEG/GIF/WebP content with bounded encoded bytes and decoded
dimensions can enter the bounded Rust cache. The frontend assigns only local
Blob URLs to a capped IntersectionObserver working set, deduplicates URLs,
stages at most 48 distinct requests, pins near-viewport blobs, and applies its
own decoded-residency LRU. Clearing the image cache synchronously acquires a
token that pauses and invalidates active reader work before the backend deletes
memory and disk entries. The reader mounts one
budgeted section first, incrementally indexes new text nodes, first applies the
pixel fallback, and then aligns the saved text anchor after relevant layout or
image-size changes.

The physical L4 event carries the HID-edge Unix timestamp and sequence number.
The frontend records route request/mount, cache readiness, first content frame,
spinner visibility, and a stable position outcome. Physical opens that fail,
time out, are superseded, or are canceled terminate as failures in the same
rolling attempt window. Once 20 warm attempts are retained, successful
memory/disk samples contribute latency values to the P95 ≤ 300 ms calculation,
while any retained warm failure fails that gate.

Guide and position reads fail independently: an unavailable or corrupt reader
position does not block cached body rendering, and a failed refresh keeps the
old body visible with an explicit warning. Store repair is user-triggered and
backs up the invalid bytes before atomically writing an empty validated store.
The panel's guide library is a cache-only Rust query over the 20 newest
`reader_positions.json` entries. It joins only validated title, author, section,
and staleness metadata from the existing guide cache; it never downloads in the
background, and removing one cached body leaves its reader position intact.
Frontend filtering runs only over this bounded response.

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
