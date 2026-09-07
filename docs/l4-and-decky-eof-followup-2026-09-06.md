# Physical L4 acceptance and Decky EOF patch — 2026-09-06

## Outcome

- Physical L4 acceptance remains **pending**: no actual button samples arrived
  during the bounded collection window. Zero attempts is not a pass.
- An independently branched Decky EOF patch and regression tests are prepared
  and verified locally. It has **not** been installed on the Deck or submitted
  upstream. GRIP runtime code and global Loader state were not modified.

## Physical acceptance preparation

At 18:36 Asia/Shanghai, `ssh deck` connected successfully. Decky 3.2.8 was active
and the previously installed GRIP Python/sidecar pair (`121600` / `121602`) had
been running for about 16 minutes. Installed hashes matched the preloading
build recorded in `device-acceptance-2026-09-06-preload.md`:

```text
dist/index.js     469e769de0f6e974d0f35cb86f743e6cc1d84c97fd660086ef86b07e233c61fd
bin/grip-sidecar  bfff47b7a3f18069fa20d6329747d3662e36ca60e716056771f0ee449c0ebe01
```

The L4 monitor reported available/running on `/dev/hidraw2`. The existing
performance tracker had zero attempts; it was not reset or replaced.

A read-only probe sampled the existing tracker every two seconds from
18:39:26 to 18:49:27. There were no new samples. A separate read at 18:50:59
still showed zero attempts and gate `collecting`. The runtime did not report a
current game (`guideLibraryAppId = null`); the previous reader remained visible
at `scrollTop = 29.33333396911621` with three decoded images. No synthetic
button event, programmatic open, input remapping, or counter change was used.

Evidence: `/private/tmp/grip-l4-acceptance.7pZuCG/physical-l4.json`.
Collector: `/private/tmp/grip-l4-acceptance.7pZuCG/collect.mjs`.
The collector stopped after ten minutes; it is not a background monitor.

To complete acceptance, the user must enter a game and perform at least 20
physical L4 open/close cycles on the same downloaded guide, allowing content,
images, and the saved position to settle before closing (about two seconds).
Read and preserve all results, including early closes/failures. The existing
gate requires at least 20 attempts, P95 full restoration at or below 300 ms,
and no spinners, position failures, or open failures. User-observed flicker and
position behavior must be recorded separately from timings.

## Upstream preparation

Repository: `SteamDeckHomebrew/decky-loader`, GPL-2.0.
Current upstream baseline fetched on this turn:
`1ea69d315a49376e32f1fba46ffa7d028eed8046`.
Dedicated local branch: `codex/fix-socket-eof`.
Independent checkout: `/private/tmp/decky-unload.El3F6V/repo`.

The README contribution instructions, PR template, backend project/lock
configuration, typecheck/lint workflows, current code, and callers were read.
No repository-level AGENTS, CONTRIBUTING, or AI policy file was present in the
fetched tree; the organization's CONTRIBUTING lookup returned 404. The README
asks contributors to start from current main, which this branch does.

Duplicate checks found related work, not an exact existing EOF patch:

- [Issue #648](https://github.com/SteamDeckHomebrew/decky-loader/issues/648):
  open, assigned to AAGaming00, created 2024-07-04, last updated 2024-07-08.
  Its AutoFlatpaks stuck-uninstall reproduction is related, not proven identical.
- [PR #955](https://github.com/SteamDeckHomebrew/decky-loader/pull/955): open,
  created 2026-08-24, last updated 2026-09-01. Its changes are systemd unit
  lifetime/process-cleanup settings, not socket EOF handling.
- [PR #695](https://github.com/SteamDeckHomebrew/decky-loader/pull/695): merged
  2024-09-01; introduced shutdown deadlines/active-loop checks but no EOF break.
- [PR #884](https://github.com/SteamDeckHomebrew/decky-loader/pull/884): closed
  without merge; replaces bare exception handlers, not EOF handling.

GitHub searches for `EOF`, `localsocket`, and shutdown/unload terms and the
socket file's commit history did not reveal an exact duplicate at lookup time.
This is a bounded search, not a guarantee that no related work exists elsewhere.

## Patch and validation

The patch changes two production files and adds one stdlib test file:

1. `localplatform/localsocket.py`: stop dispatching messages at EOF.
2. `plugin/plugin.py`: stop the response receive loop at EOF; run its existing
   close/cancel cleanup for EOF as well as task cancellation.
3. `tests/test_localsocket.py`: bounded regressions for both handlers, final
   buffered messages, long-line handling, normal replies, and canceled requests.

It deliberately leaves global process deadlines, signal handling, transport
framing, and Loader installation unchanged. No project dependency was added.

On macOS ARM64 / Python 3.12.14:

- Original upstream source: seven EOF subcases fail via a bounded 20-read
  guard; the cancellation control passes. No unbounded busy loop was run.
- Patched source: two tests/all eight subcases pass.
- Targeted Pyright 1.1.369 with Python 3.10 configuration: zero errors/warnings.
- Real local Unix/TCP sockets: round-trip reply, EOF, and executor completion
  succeed in 24.9/24.0 ms, including an intentional 20 ms worker sleep. This
  is not a measurement of a patched Steam Deck installation.
- `git diff --check` passes; the exported patch applies cleanly to a separate
  clean checkout of the stated upstream baseline (`git apply --check`).

The source checkout emits the same missing version-metadata warning before and
after patching. Full Loader packaging, frontend checks, hosted CI, and actual
patched-device unload acceptance were not run and are not claimed complete.

Artifacts:

- Patch: `/private/tmp/decky-unload.El3F6V/socket-eof.patch`
- Patch SHA-256: `31a43033ca7eb2d4d3a77f868af22df66d93b79d12bc01cbe2fe4c7afeaed610`
- English PR draft: `/private/tmp/decky-unload.El3F6V/PR.md`
- Native socket smoke check: `/private/tmp/decky-unload.El3F6V/smoke_socket_eof.py`

Per the contributor workflow, fork/push/PR publication still require explicit
confirmation of the destination, account, branch, full diff, and PR text.
Updating the live global Loader is a separate approval boundary. No GitHub
write, commit, or device deployment was performed in this follow-up.
