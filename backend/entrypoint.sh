#!/bin/sh
set -eu

cd /backend
CARGO_TARGET_DIR=/tmp/grip-target cargo build --locked --release
mkdir -p out
cp /tmp/grip-target/release/grip-sidecar out/grip-sidecar
