# Steam update compatibility — 2026-09-12

## Confirmed failure

The Deck runs Steam client build `1789086785` and Decky Loader `v3.2.8`.
The QAM plugin panel renders, but opening the reader leaves a blank page.
Live CEF inspection found `DeckyPluginLoader.routerHook.Route` and
`DFL.useParams` both undefined. Decky's console reports that its Route
component and error-reporting initializer cannot be found. GRIP's backend,
Rust sidecar and L4 listener remain available; the library returns seven
cached guide identities.

These are two compatibility failures: Decky's route discovery must work before
plugin pages mount, and GRIP must no longer call the missing parameter hook.
Decky's route wrapper creates the plugin component without passing match props,
so replacing the hook with a match prop would not resolve the second failure.

## Minimal repairs

- GRIP subscribes to the existing Steam main-window History, whose `listen`
  function was verified on the device. It reuses the existing validated reader
  path parser and passes identity explicitly to the reader. Guide changes keep
  the existing keyed remount and bookmark cleanup. Invalid paths display an
  actionable message. No dependency or alternative UI was added.
- Decky's [upstream PR 962](https://github.com/SteamDeckHomebrew/decky-loader/pull/962)
  changes two discovery expressions to accept multi-character minified names.
  Commit `48a01f167eed30390ba91cefe1f4deb1e2d3977e` is one commit ahead of
  v3.2.8, changing one line in each of `router-hook.tsx` and
  `errorboundary-hook.tsx`. This is an unmerged testing build, not a release.

## Local verification and prepared artifacts

`pnpm run check` and `just package` passed, including 389 frontend tests,
the Python/Rust checks, 45 script checks, linting and build. The full Chrome
browser suite passed 16/16. Coverage includes actual registered-route rendering
without a mocked `useParams`, Steam/Heybox route changes, invalid paths,
subscription cleanup, reader reopening and left/right focus behavior.

GRIP package: `out/package-xR9kx8/decky-grip-0.3.10.zip`.
SHA-256: `2a733fe6a916ee418a1aa6460320736e3b72e169c320153d238aa84b86997fcc`.
Its `dist/index.js` SHA-256 is
`58b91d0720b1950d0dc3a1b17e70fd211f0da633d8df9e2ee35447459d587a47`.

The official Linux [Builder run](https://github.com/SteamDeckHomebrew/decky-loader/actions/runs/34438828405)
for the exact PR commit produced artifact `10137189140` (`PluginLoader`).
The downloaded archive hash matches GitHub's artifact digest:
`35d322df2093a1d6147481d412983c6c27051e73c86d562d3dea611ab5b66670`.
The archive contains only `PluginLoader`, verified as Linux x86_64 ELF;
its SHA-256 is
`5f1ce80b800b48ae15ab073461dff8be596b3ae6e31d12ac7ed139a182d1a4d3`.

The original installed loader was copied to the Mac only:
`out/steam-compat-z2AjSurG/PluginLoader.before`, SHA-256
`4b9a04a1ac4ed0c028dcbbc38cd03383eb438d69744d613775c93f81809afde2`.
No backup was created on the Deck, and no guide or setting was removed.

## Device acceptance status

The user approved Steam UI reload. The subsequent CEF connection timed out
while fetching its page list, before the updater RPC could be sent. Both
`steamdeck.local` resolution and SSH to the established tunnel's device address
then failed; an outside-sandbox SSH check also timed out. Application is pending
device reconnection at that point.

After the user confirmed reconnection, the original loader and GRIP hashes were
rechecked and still matched the pre-installation versions. Decky's native
`updater/download_testing_version` was then called for PR 962 and the exact
commit above. Its progress events showed the real download; the RPC timed out
during the subsequent service restart. Independent SSH verification confirmed
`.loader.version = PR-962` and the installed binary hash
`5f1ce80b800b48ae15ab073461dff8be596b3ae6e31d12ac7ed139a182d1a4d3`.

After restart, live CEF reported `routerHook.Route` as a function and both
error-boundary patches present. GRIP's RPC and L4 listener recovered with all
seven cached guide identities. `DFL.useParams` remained undefined, confirming
that GRIP's separate fix is still necessary.

The user confirmed GRIP's native reinstall dialog. `just deploy` completed all
installed-file, RPC, guide-inventory, settings-path and process-stability gates.
Its receipt is `out/package-qsrwhP/deployment.json`, state `verified`; the
deployed ZIP SHA-256 is
`715847d5e635d6ea93ac3ea855a5ae92a3cd4369ced2d40f376461000c6b7bf8`.
The frontend hash matches the prepared build above. The verified Python/Rust
process pair was `169582` / `169583`. No rollback backup was created on Deck,
and the verified temporary installation package was removed.

The normal panel `openReader()` action now mounts `.grip-reader` with the local
Heybox article, restored chapter, and native directory/switch/page-turn action
legends. Near the restored position, three inspected image nodes were decoded
with local Blob URLs. Offscreen placeholders were not counted as loaded images.
The five existing plugins remain listed after the loader restart.

In the actual Deck renderer, a software-triggered Heybox → Steam → Heybox
switch rendered each guide successfully and restored the Heybox scroll position
exactly (`4330` before and after). This confirms that the History subscription
updates the mounted route without the missing `useParams` hook.

Physical L4 reopening and directory left/right acceptance have been requested
from the user and are pending; software navigation is not physical-input proof.

## Subsequent recurrence

The user reported another failure after the successful renderer checks. Live
inspection at 21:13 found that GRIP still matched the repaired frontend hash,
but the installed loader had returned to `v3.2.8` and its original
`4b9a04a1ac4ed0c028dcbbc38cd03383eb438d69744d613775c93f81809afde2` hash.
`routerHook.Route` was undefined again. L4 hardware events still reached the
frontend; four opening attempts timed out waiting for first paint.

The journal records `updater/do_update` at 21:10:22, binary replacement at
21:10:32, and loader restart at 21:10:40. This is distinct from the earlier
`download_testing_version` call and GRIP reinstall. The current updater's
remote target is v3.2.8, so the regular Decky update path overwrote the PR fix.
The log establishes the update operation, not who initiated it.

The user subsequently requested restoring the compatibility build, explicitly
choosing to skip the old Decky update for now rather than changing update rules.
The exact PR build was restored through the native testing-download RPC at
21:28:24; GRIP's backend and Rust sidecar were ready at 21:28:34. Live
checks again confirmed `PR-962`, loader SHA-256
`5f1ce80b800b48ae15ab073461dff8be596b3ae6e31d12ac7ed139a182d1a4d3`,
a working Route function, and all seven cached guide identities. No update
branch, notification preference or version-comparison rule was changed by this
recovery. No cached guide was removed or plugin configuration changed, and GRIP
did not need to be reinstalled.

The normal reader action successfully displayed cached Steam guide
`1113000:3414883877` with 39,450 mounted text characters, scroll position
`31454.666015625`, and native directory/switch/page-turn action legends.
Physical L4 close/reopen confirmation was requested again and is pending.
