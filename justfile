default:
    @just --list

# Build, back up and reinstall GRIP; confirm once in Decky's native dialog.
[positional-arguments]
deploy host="deck":
    node scripts/deploy.mjs "$1"

# Copy the Deck's complete Gaming Mode screen to the Mac image clipboard.
[positional-arguments]
screenshot host="deck":
    node scripts/screenshot.mjs "$1"

# Build and verify a Steam Deck ZIP without connecting to a device.
package:
    node scripts/package.mjs

check:
    pnpm run check
