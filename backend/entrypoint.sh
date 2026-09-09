#!/bin/sh
set -eu

cd /backend
export CARGO_TARGET_DIR=/tmp/grip-target
mkdir -p "$CARGO_TARGET_DIR"
# ponytail: one build per volume through copy-out; use separate volumes for parallel builds.
exec 9>"$CARGO_TARGET_DIR/.grip-package.lock"
flock 9
# Snapshots can have older mtimes than another build. Always rebuild GRIP, reuse dependencies.
cargo clean --locked --release -p grip-sidecar
cargo build --locked --release
mkdir -p out
cp "$CARGO_TARGET_DIR/release/grip-sidecar" out/grip-sidecar
