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

## Implementation boundary

GRIP should preserve Steam's existing state rather than replace the guide
reader or scrape the Steam Community website.

```text
Steam overlay location.state
          │
          ▼
TypeScript capture / restore adapter
          │ debounced RPC
          ▼
Python PositionStore
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

If image loading or future layout changes prove that pixels alone are
insufficient, a later schema can add a visible-text anchor and relative offset.
That complexity should be driven by real device failures rather than added in
advance.

## Safety constraints

- No root flag.
- Never write inside the installed plugin directory.
- Debounce scroll persistence; do not write on every scroll event.
- Flush once on navigation/unmount after the normal debounce.
- Verify the active guide id again before applying an asynchronous restore.
- Remove every route patch, observer, and timer from `onDismount()`.
- Preserve corrupt or unknown storage files and surface an error.
- Keep `positions.json` private to the one GRIP backend process; RPC operations
  are serialized before entering the worker executor.

## Runtime lifecycle

1. Preload all validated positions from the Python backend.
2. Attach to the main Steam window's history, selected-guide store, and real DOM.
3. Debounce ordinary scroll captures and flush on guide close, blur, or unload.
4. Start a protected restore when a saved guide appears or its DOM is rebuilt.
5. Wait for a reachable, stable layout; restore and verify within one pixel.
6. Remove every patch, listener, observer, interval, and timer on dismount.
