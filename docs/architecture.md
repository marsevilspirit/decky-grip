# Architecture and device findings

## Confirmed on-device behavior

Read-only CEF inspection on 2026-08-24 used Decky Loader `v3.2.8-pre1`.

The native Steam guide was rendered inside the `SharedJSContext` React tree,
not in a separate community web-page BrowserView. The observed overlay route
was:

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

The first frontend milestone is a read-only probe that can identify the active
`appId`, `guideId`, and verified history key without relying on minified React
member names. Only after that probe is repeatable should the route/history
adapter write restored state.

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

## Planned milestones

1. Build and deploy the inert scaffold.
2. Add a read-only overlay history probe and log its structured result.
3. Prove capture across close/reopen without modifying Steam state.
4. Add guarded restoration for the same `appId` and `guideId`.
5. Add the QAM controls, recovery fallback, and device regression matrix.
