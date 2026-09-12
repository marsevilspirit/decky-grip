#!/bin/sh
set -eu

cd /backend
export CARGO_TARGET_DIR=/tmp/grip-target
mkdir -p "$CARGO_TARGET_DIR"
# ponytail: one build per volume through copy-out; use separate volumes for parallel builds.
exec 9>"$CARGO_TARGET_DIR/.grip-package.lock"
flock 9
: "${GRIP_BUILD_KEY:?Missing validated backend/build environment fingerprint}"
binary="$CARGO_TARGET_DIR/release/grip-sidecar"
receipt="$CARGO_TARGET_DIR/.grip-package-receipt"
checksum=""
if [ -f "$binary" ] && [ -x "$binary" ]; then
    checksum=$(sha256sum "$binary")
fi
if [ -n "$checksum" ] && [ -f "$receipt" ] && [ "$(cat "$receipt")" = "$GRIP_BUILD_KEY $checksum" ]; then
    echo "GRIP Rust build: verified cache hit"
else
    # Invalidate before clean/build: a failed build must never certify its partial output.
    rm -f "$receipt"
    # Changed snapshots can have older mtimes. Rebuild GRIP, reuse only dependencies.
    cargo clean --locked --release -p grip-sidecar
    cargo build --locked --release
    test -f "$binary" && test -x "$binary"
    checksum=$(sha256sum "$binary")
    printf '%s %s\n' "$GRIP_BUILD_KEY" "$checksum" > "$receipt"
fi
mkdir -p out
cp "$binary" out/grip-sidecar
