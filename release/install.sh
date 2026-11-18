#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Install the anycloud CLI.

Usage:
  curl -fsSL https://get.anycloud.sh | sh
  sh install.sh [--version <version>] [--install-dir <dir>] [--no-modify-path]

Options:
  --version <version>    Install a specific release, for example 0.1.30 or v0.1.30
  --install-dir <dir>    Install directory; defaults to ANYCLOUD_INSTALL_DIR,
                         then ~/.local/bin (/usr/local/bin when run as root)
  --no-modify-path       Do not add ~/.local/bin to PATH in your shell startup file;
                         also set by ANYCLOUD_NO_MODIFY_PATH=1
  -h, --help             Show this help
EOF
}

INSTALL_DIR="${ANYCLOUD_INSTALL_DIR:-}"
MODIFY_PATH=1
[ -n "${ANYCLOUD_NO_MODIFY_PATH:-}" ] && MODIFY_PATH=0
VERSION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "Error: --version requires a value." >&2
        exit 1
      fi
      VERSION="${2#v}"
      shift 2
      ;;
    --install-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "Error: --install-dir requires a value." >&2
        exit 1
      fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    --no-modify-path)
      MODIFY_PATH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Print the physical path of $1, following symlinks to it and its directory.
resolve_path() {
  p="$1"
  n=0
  while [ -L "$p" ] && [ "$n" -lt 40 ]; do
    target=$(readlink "$p")
    case "$target" in
      /*) p="$target" ;;
      *) p="$(dirname "$p")/$target" ;;
    esac
    n=$((n + 1))
  done
  dir=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || dir=$(dirname "$p")
  printf '%s/%s\n' "$dir" "$(basename "$p")"
}

# Previous installers defaulted to /usr/local/bin. Keep updating a binary they
# left there instead of installing a second copy.
LEGACY_DIR=/usr/local/bin
DEFAULT_USER_DIR=0
if [ -z "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    INSTALL_DIR="$LEGACY_DIR"
  elif [ -f "$LEGACY_DIR/anycloud" ] && [ ! -L "$LEGACY_DIR/anycloud" ]; then
    INSTALL_DIR="$LEGACY_DIR"
  else
    INSTALL_DIR="$HOME/.local/bin"
    DEFAULT_USER_DIR=1
  fi
fi
TARGET="$INSTALL_DIR/anycloud"

case "$(resolve_path "$TARGET")" in
  */Cellar/anycloud/*)
    echo "Error: $TARGET is managed by Homebrew. Update it with: brew upgrade anycloud-sh/tap/anycloud" >&2
    exit 1
    ;;
esac

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case $ARCH in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

PLATFORM="${OS}-${ARCH}"
ASSET_NAME="anycloud-${PLATFORM}.tar.gz"
RELEASES_BASE="https://github.com/anycloud-sh/releases/releases"

if [ -n "$VERSION" ]; then
  RELEASE_URL="${RELEASES_BASE}/download/v${VERSION}"
  VERSION_LABEL="v${VERSION}"
else
  RELEASE_URL="${RELEASES_BASE}/latest/download"
  VERSION_LABEL="latest"
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/anycloud-install.XXXXXX")
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

verify_checksum() {
  if ! line=$(awk -v asset="$ASSET_NAME" '$2 == asset { print; found = 1 } END { exit found ? 0 : 1 }' "$TMP_DIR/checksums.txt"); then
    echo "Error: checksum for ${ASSET_NAME} not found in checksums.txt" >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "$line" | (cd "$TMP_DIR" && sha256sum -c -)
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s\n' "$line" | (cd "$TMP_DIR" && shasum -a 256 -c -)
  else
    echo "Error: sha256sum or shasum is required to verify the download." >&2
    exit 1
  fi
}

echo "Downloading anycloud ${VERSION_LABEL} for ${PLATFORM}..."

if ! curl -fsSLo "$TMP_DIR/$ASSET_NAME" "$RELEASE_URL/$ASSET_NAME"; then
  echo "Error: Failed to download ${ASSET_NAME} from ${RELEASE_URL}" >&2
  exit 1
fi
if ! curl -fsSLo "$TMP_DIR/checksums.txt" "$RELEASE_URL/checksums.txt"; then
  echo "Error: Failed to download checksums.txt from ${RELEASE_URL}" >&2
  exit 1
fi

verify_checksum

# --no-same-owner: as root, tar would otherwise keep the archive's owner, and
# that account could later replace the installed binary. The sudo update below
# uses install for the same reason: mv kept the invoking user as the owner.
if ! tar --no-same-owner -xzf "$TMP_DIR/$ASSET_NAME" -C "$TMP_DIR" anycloud; then
  echo "Error: Failed to extract anycloud from ${ASSET_NAME}" >&2
  exit 1
fi
chmod +x "$TMP_DIR/anycloud"

mkdir -p "$INSTALL_DIR" 2>/dev/null || true
if [ -d "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ]; then
  mv "$TMP_DIR/anycloud" "$TARGET"
elif [ -f "$TARGET" ]; then
  # Only an existing installation is updated with sudo; new installs never are.
  echo "anycloud is installed in $INSTALL_DIR, which only an administrator can change, so updating it needs sudo."
  echo "To use a personal install instead, remove $TARGET and run: curl -fsSL https://get.anycloud.sh | sh"
  sudo install -m 755 "$TMP_DIR/anycloud" "$TARGET"
else
  echo "Error: cannot write to $INSTALL_DIR. Choose a directory you own with --install-dir." >&2
  exit 1
fi

echo ""
echo "anycloud installed successfully to $TARGET"
echo ""
"$TARGET" --version

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

FOUND=$(command -v anycloud 2>/dev/null) || FOUND=""
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
# A symlink elsewhere on PATH may already reach the installed binary.
if [ -n "$FOUND" ] && [ "$(resolve_path "$FOUND")" = "$(resolve_path "$TARGET")" ]; then
  ON_PATH=1
fi

if [ "$ON_PATH" -eq 1 ]; then
  :
elif [ "$DEFAULT_USER_DIR" -eq 1 ] && [ "$MODIFY_PATH" -eq 1 ]; then
  # Write $HOME rather than its value, so the line never re-expands the path.
  line='export PATH="$HOME/.local/bin:$PATH"'
  load='.'
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      rc="$HOME/.bashrc"
      if [ "$OS" = "darwin" ]; then
        # Login shells read only the first of these, so never create an earlier one.
        rc="$HOME/.profile"
        for f in "$HOME/.bash_login" "$HOME/.bash_profile"; do
          if [ -f "$f" ]; then rc="$f"; fi
        done
      fi
      ;;
    fish)
      rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/anycloud.fish"
      line='fish_add_path "$HOME/.local/bin"'
      load='source'
      ;;
    *) rc="$HOME/.profile" ;;
  esac
  if grep -qxF "$line" "$rc" 2>/dev/null; then
    echo "$INSTALL_DIR is added to PATH by $rc. To use anycloud in this terminal, run: $load $(quote "$rc")"
  elif mkdir -p "$(dirname "$rc")" 2>/dev/null && printf '\n# Added by the anycloud installer\n%s\n' "$line" >> "$rc" 2>/dev/null; then
    echo "Added $INSTALL_DIR to PATH in $rc. To use anycloud in this terminal, run: $load $(quote "$rc")"
  else
    echo "Could not update $rc. Add anycloud to PATH with: export PATH=$(quote "$INSTALL_DIR"):\"\$PATH\""
  fi
else
  echo "$INSTALL_DIR is not on PATH. Add it with: export PATH=$(quote "$INSTALL_DIR"):\"\$PATH\""
fi

if [ -n "$FOUND" ] && [ "$(resolve_path "$FOUND")" != "$(resolve_path "$TARGET")" ]; then
  echo "Warning: $FOUND comes first on PATH and was left unchanged. Remove it or put $INSTALL_DIR first." >&2
fi
