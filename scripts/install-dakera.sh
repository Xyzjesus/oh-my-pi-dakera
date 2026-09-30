#!/bin/sh
set -e

# OMP Dakera Fork Installer (binary-only)
# Usage: curl -fsSL https://cdn.jsdelivr.net/gh/Xyzjesus/oh-my-pi-dakera@build/dakera/scripts/install-dakera.sh | sh
#        (raw works too: https://raw.githubusercontent.com/Xyzjesus/oh-my-pi-dakera/build/dakera/scripts/install-dakera.sh)
#
# Fork of can1357/oh-my-pi's scripts/install.sh, trimmed to the binary path:
#  - REPO points at Xyzjesus/oh-my-pi-dakera
#  - latest release resolved via /releases?per_page=1 because the fork's
#    releases are published as prereleases and /releases/latest ignores those
#  - --source / bun / npm package modes dropped: the fork is not published to
#    npm, and source installs from a branch would need a local natives build
#
# Options:
#   --ref <ref>    Install specific release tag
#   -r <ref>       Shorthand for --ref
#   --binary       Accepted for compatibility with the upstream script (no-op)

REPO="Xyzjesus/oh-my-pi-dakera"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"

# Parse arguments
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --binary)
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

ARCH="$(host_arch)"
case "$(uname -s)" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="darwin" ;;
    *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac
if [ "$PLATFORM" = "linux" ]; then
    if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
        PLATFORM="linux-musl"
    fi
fi

BINARY="omp-${PLATFORM}-${ARCH}"

# Get release tag
if [ -n "$REF" ]; then
    echo "Fetching release $REF..."
    if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    else
        echo "Release tag not found: $REF"
        exit 1
    fi
else
    echo "Fetching latest release..."
    # The fork publishes prereleases; /releases/latest would 404 on those.
    RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases?per_page=1")
    LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | head -1)
fi
if [ -z "$LATEST" ]; then
    echo "Failed to fetch release tag"
    exit 1
fi
echo "Using version: $LATEST"

mkdir -p "$INSTALL_DIR"

# Download binary
BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
echo "Downloading ${BINARY}..."
curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "${INSTALL_DIR}/omp-dakera"
chmod +x "${INSTALL_DIR}/omp-dakera"

# macOS: taskgated SIGKILLs downloaded ad-hoc-signed binaries (provenance
# xattr), so a bun-compiled release that runs fine on the build machine is
# killed on the user's arm64 Mac with "zsh: killed". The durable fix is
# scripts/ci-macos-sign.sh (Developer ID + notarization) in the release
# pipeline; until its Apple secrets are wired, re-sign locally — guarded on
# Signature=adhoc so Developer-ID builds are untouched.
if [ "$(uname)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
    if codesign -dv "${INSTALL_DIR}/omp-dakera" 2>&1 | grep -q "Signature=adhoc"; then
        codesign --force --sign - "${INSTALL_DIR}/omp-dakera" >/dev/null 2>&1 || true
    fi
fi

# Verify the freshly installed binary can actually start before reporting
# success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
# which stock Alpine/musl systems do not ship, so the download succeeds while
# the binary exits 127 with relocation errors. Never claim success for a
# binary that cannot run.
if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/omp-dakera" --version 2>&1)"; then
    echo ""
    echo "✗ omp-dakera was downloaded to ${INSTALL_DIR}/omp-dakera but cannot start:"
    echo "$SMOKE_OUTPUT" | sed 's/^/    /'
    if [ "$PLATFORM" = "linux-musl" ]; then
        echo ""
        echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'omp-dakera':"
        if command -v apk >/dev/null 2>&1; then
            echo "    apk add libstdc++ libgcc"
        else
            echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
        fi
    fi
    exit 1
fi
echo ""
echo "✓ Installed omp-dakera to ${INSTALL_DIR}/omp-dakera"
# Check if in PATH
case ":$PATH:" in
    *":$INSTALL_DIR:"*) echo "Run 'omp-dakera' to get started!" ;;
    *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp-dakera'" ;;
esac
