#!/usr/bin/env bash
# Real managed-slot lifecycle gate.
#
# Builds the updater with an ephemeral trusted Ed25519 key, creates signed
# file:// release bundles containing the real native launcher, then exercises
# install -> apply -> rollback -> tamper rejection through the CLI verbs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCHER_DIR="$REPO_ROOT/apps/hermes-launcher"
if [ -n "${UV:-}" ]; then
    UV="$UV"
elif command -v uv >/dev/null 2>&1; then
    UV="$(command -v uv)"
else
    UV="$HOME/.hermes/bin/uv"
fi

WORK=$(mktemp -d)
export HERMES_HOME="$WORK/home"
RELEASES="$WORK/releases"
mkdir -p "$HERMES_HOME" "$RELEASES"
trap 'rm -rf "$WORK"' EXIT

readarray -t KEYS < <("$UV" run --with pynacl python - <<'PY'
import base64
from nacl.signing import SigningKey
key = SigningKey.generate()
print(base64.b64encode(bytes(key)).decode())
print(base64.b64encode(bytes(key.verify_key)).decode())
PY
)
SIGNING_KEY="${KEYS[0]}"
PUBLIC_KEY="${KEYS[1]}"

printf '==> building hermes-updater with ephemeral E2E trust key\n'
(
    cd "$LAUNCHER_DIR"
    if grep -qi '^ID=nixos' /etc/os-release 2>/dev/null; then
        HERMES_RELEASE_PUBLIC_KEY="$PUBLIC_KEY" \
            nix shell nixpkgs#gcc nixpkgs#openssl -c cargo build --quiet
    else
        HERMES_RELEASE_PUBLIC_KEY="$PUBLIC_KEY" cargo build --quiet
    fi
)
LAUNCHER="$LAUNCHER_DIR/target/debug/hermes"
PLATFORM=$(
    case "$(uname -s)-$(uname -m)" in
        Linux-x86_64) echo linux-x64 ;;
        Linux-aarch64|Linux-arm64) echo linux-arm64 ;;
        Darwin-arm64) echo darwin-arm64 ;;
        *) echo "unsupported E2E platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
    esac
)

make_bundle() {
    local version="$1"
    local tamper="${2:-false}"
    local tree="$WORK/bundle-$version"
    local version_dir="$RELEASES/$version"
    rm -rf "$tree"
    mkdir -p \
        "$tree/bin" \
        "$tree/runtime/venv/bin" \
        "$tree/runtime/tools" \
        "$tree/runtime/node/bin" \
        "$tree/runtime/python/bin" \
        "$tree/app/skills/demo" \
        "$tree/ui/tui/dist" \
        "$tree/ui/web/dist" \
        "$version_dir"

    cp "$LAUNCHER" "$tree/bin/hermes"
    chmod +x "$tree/bin/hermes"
    printf 'demo\n' > "$tree/app/skills/demo/SKILL.md"
    printf 'tui\n' > "$tree/ui/tui/dist/entry.js"
    printf 'web\n' > "$tree/ui/web/dist/index.html"
    printf '%s\n' "$version" > "$tree/VERSION"

    cat > "$tree/runtime/venv/bin/python" <<'PY'
#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
if [ "${1:-}" = "-c" ]; then
    exit 0
fi
if [ "${1:-}" = "-m" ] && [ "${2:-}" = "hermes_cli.main" ]; then
    shift 2
fi
if [ "${1:-}" = "doctor" ] && [ "${2:-}" = "--preflight" ]; then
    exit 0
fi
if [ "${1:-}" = "version-probe" ]; then
    cat "$ROOT/VERSION"
    exit 0
fi
exit 0
PY
    chmod +x "$tree/runtime/venv/bin/python"

    "$UV" run --with pynacl python "$REPO_ROOT/scripts/release/write-manifest.py" \
        --bundle-dir "$tree" \
        --version "$version" \
        --channel stable \
        --git-sha "$(printf 'a%.0s' {1..40})" \
        --platform "$PLATFORM" \
        --signing-key "$SIGNING_KEY" >/dev/null

    if [ "$tamper" = true ]; then
        printf 'tampered after signing\n' > "$tree/VERSION"
    fi

    tar --zstd -cf "$version_dir/hermes-$version-$PLATFORM.tar.zst" \
        -C "$WORK" "bundle-$version"
    # The updater accepts the canonical archive root name `bundle/`.
    local normalized="$WORK/normalize-$version"
    rm -rf "$normalized"
    mkdir -p "$normalized/bundle"
    cp -a "$tree/." "$normalized/bundle/"
    tar --zstd -cf "$version_dir/hermes-$version-$PLATFORM.tar.zst" \
        -C "$normalized" bundle
}

make_bundle 1.0.0
printf '1.0.0\n' > "$RELEASES/latest-stable.txt"

printf '==> real install\n'
"$LAUNCHER" install --source "file://$RELEASES" --channel stable
[ "$(cat "$HERMES_HOME/current.txt")" = "1.0.0" ]
[ -x "$HERMES_HOME/bin/hermes" ]
[ -x "$HERMES_HOME/bin/hermes-updater" ]
[ "$("$HERMES_HOME/bin/hermes" launch version-probe)" = "1.0.0" ]

make_bundle 2.0.0
printf '2.0.0\n' > "$RELEASES/latest-stable.txt"

printf '==> running v1 process remains on its concrete slot across flip\n'
OLD_PROCESS_OUTPUT="$WORK/old-process-version"
(
    sleep 1
    cat "$HERMES_HOME/versions/1.0.0/VERSION" > "$OLD_PROCESS_OUTPUT"
) &
OLD_PROCESS_PID=$!

printf '==> stale interrupted staging is cleaned before real apply\n'
mkdir -p "$HERMES_HOME/versions/interrupted.staging"
printf 'partial\n' > "$HERMES_HOME/versions/interrupted.staging/partial"

printf '==> real apply\n'
"$HERMES_HOME/bin/hermes-updater" apply --source "file://$RELEASES"
wait "$OLD_PROCESS_PID"
[ "$(cat "$OLD_PROCESS_OUTPUT")" = "1.0.0" ]
[ ! -e "$HERMES_HOME/versions/interrupted.staging" ]
[ "$(cat "$HERMES_HOME/current.txt")" = "2.0.0" ]
[ "$(cat "$HERMES_HOME/previous.txt")" = "1.0.0" ]
[ "$("$HERMES_HOME/bin/hermes" launch version-probe)" = "2.0.0" ]

printf '==> real rollback\n'
"$HERMES_HOME/bin/hermes-updater" rollback
[ "$(cat "$HERMES_HOME/current.txt")" = "1.0.0" ]
[ "$(cat "$HERMES_HOME/previous.txt")" = "2.0.0" ]
[ "$("$HERMES_HOME/bin/hermes" launch version-probe)" = "1.0.0" ]

printf '==> tampered bundle fails before flip\n'
make_bundle 3.0.0 true
printf '3.0.0\n' > "$RELEASES/latest-stable.txt"
if "$HERMES_HOME/bin/hermes-updater" apply --source "file://$RELEASES"; then
    echo 'ERROR: tampered bundle was accepted' >&2
    exit 1
fi
[ "$(cat "$HERMES_HOME/current.txt")" = "1.0.0" ]
[ ! -e "$HERMES_HOME/versions/3.0.0.staging" ]

printf 'E2E_PASS: real slot install/apply/rollback/tamper lifecycle\n'
