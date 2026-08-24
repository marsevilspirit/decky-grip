set shell := ["bash", "-euo", "pipefail", "-c"]

pnpm := "pnpm"

default: check

install:
    {{pnpm}} install

typecheck:
    {{pnpm}} run typecheck

test:
    {{pnpm}} run test

build:
    {{pnpm}} run build

check:
    {{pnpm}} run check

format:
    {{pnpm}} run format

format-check:
    {{pnpm}} run format:check
