#!/bin/bash
set -euo pipefail

echo "========================================="
echo "Install Script Test"
echo "========================================="
echo ""

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anycloud-install-test.XXXXXX")"
cleanup() {
  chmod -R u+w "$TMP_DIR" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case $ARCH in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture for test: $ARCH"
    exit 1
    ;;
esac

PLATFORM="${OS}-${ARCH}"
ASSET_NAME="anycloud-${PLATFORM}.tar.gz"
ASSET_TARBALL="${TMP_DIR}/${ASSET_NAME}"
CHECKSUMS="${TMP_DIR}/checksums.txt"
CURL_LOG="${TMP_DIR}/curl.log"
INSTALL_DIR="${TMP_DIR}/bin"
FAKE_BIN="${TMP_DIR}/fake-bin"
PKG_DIR="${TMP_DIR}/asset"

mkdir -p "$PKG_DIR" "$FAKE_BIN" "$INSTALL_DIR"
cat > "${PKG_DIR}/anycloud" <<'BIN'
#!/bin/bash
echo "anycloud 9.9.9"
BIN
chmod +x "${PKG_DIR}/anycloud"
tar -czf "$ASSET_TARBALL" -C "$PKG_DIR" anycloud

checksum_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

printf '%s  %s\n' "$(checksum_file "$ASSET_TARBALL")" "$ASSET_NAME" > "$CHECKSUMS"

cat > "${FAKE_BIN}/curl" <<'CURL'
#!/bin/bash
set -euo pipefail
echo "$*" >> "$CURL_LOG"
url="${@: -1}"
out=""
expect_out=0
for arg in "$@"; do
  if [ "$expect_out" -eq 1 ]; then
    out="$arg"
    expect_out=0
    continue
  fi
  case "$arg" in
    -o|--output|-*o)
      expect_out=1
      ;;
  esac
done
emit() {
  if [ -n "$out" ]; then
    cat > "$out"
  else
    cat
  fi
}
case "$url" in
  "https://github.com/anycloud-sh/releases/releases/latest/download/$ASSET_NAME")
    emit < "$ASSET_TARBALL"
    ;;
  "https://github.com/anycloud-sh/releases/releases/latest/download/checksums.txt")
    emit < "$CHECKSUMS"
    ;;
  "https://github.com/anycloud-sh/releases/releases/download/v9.9.9/$ASSET_NAME")
    emit < "$ASSET_TARBALL"
    ;;
  "https://github.com/anycloud-sh/releases/releases/download/v9.9.9/checksums.txt")
    emit < "$CHECKSUMS"
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 1
    ;;
esac
CURL
chmod +x "${FAKE_BIN}/curl"

echo "1. Rejecting unknown installer arguments before network access..."
for selector in latest stable 0.3.17 --channel; do
  set +e
  PATH="${FAKE_BIN}:$PATH" \
    CURL_LOG="$CURL_LOG" \
    ASSET_NAME="$ASSET_NAME" \
    ASSET_TARBALL="$ASSET_TARBALL" \
    CHECKSUMS="$CHECKSUMS" \
    ANYCLOUD_INSTALL_DIR="$INSTALL_DIR" \
    sh release/install.sh "$selector" > "${TMP_DIR}/install-${selector}.log" 2>&1
  EXIT_CODE=$?
  set -e

  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "   ✗ ERROR: installer accepted argument '$selector'"
    cat "${TMP_DIR}/install-${selector}.log"
    exit 1
  fi

  if ! grep -q "unknown argument" "${TMP_DIR}/install-${selector}.log"; then
    echo "   ✗ ERROR: installer did not explain rejected argument '$selector'"
    cat "${TMP_DIR}/install-${selector}.log"
    exit 1
  fi
done

if [ -s "$CURL_LOG" ]; then
  echo "   ✗ ERROR: installer contacted network before rejecting an argument"
  cat "$CURL_LOG"
  exit 1
fi
echo "   ✓ Installer rejects unknown arguments before network access"

echo "2. Installing latest public release asset with checksum verification..."
PATH="${FAKE_BIN}:$PATH" \
  CURL_LOG="$CURL_LOG" \
  ASSET_NAME="$ASSET_NAME" \
  ASSET_TARBALL="$ASSET_TARBALL" \
  CHECKSUMS="$CHECKSUMS" \
  ANYCLOUD_INSTALL_DIR="$INSTALL_DIR" \
  sh release/install.sh > "${TMP_DIR}/install-latest.log" 2>&1

if [ ! -x "${INSTALL_DIR}/anycloud" ]; then
  echo "   ✗ ERROR: anycloud was not installed to the test install dir"
  cat "${TMP_DIR}/install-latest.log"
  exit 1
fi

if ! grep -q "releases/latest/download/${ASSET_NAME}" "$CURL_LOG"; then
  echo "   ✗ ERROR: installer did not request the latest release asset"
  cat "$CURL_LOG"
  exit 1
fi

if ! grep -q "releases/latest/download/checksums.txt" "$CURL_LOG"; then
  echo "   ✗ ERROR: installer did not request release checksums"
  cat "$CURL_LOG"
  exit 1
fi

if ! grep -q "${ASSET_NAME}: OK" "${TMP_DIR}/install-latest.log"; then
  echo "   ✗ ERROR: installer did not verify checksum"
  cat "${TMP_DIR}/install-latest.log"
  exit 1
fi

if ! grep -q "anycloud 9.9.9" "${TMP_DIR}/install-latest.log"; then
  echo "   ✗ ERROR: installed binary was not executed from the test install dir"
  cat "${TMP_DIR}/install-latest.log"
  exit 1
fi

echo "   ✓ Installer downloads, verifies, and installs the latest release asset"

echo "3. Installing a pinned release with --version and --install-dir..."
PINNED_INSTALL_DIR="${TMP_DIR}/pinned-bin"
mkdir -p "$PINNED_INSTALL_DIR"
PATH="${FAKE_BIN}:$PATH" \
  CURL_LOG="$CURL_LOG" \
  ASSET_NAME="$ASSET_NAME" \
  ASSET_TARBALL="$ASSET_TARBALL" \
  CHECKSUMS="$CHECKSUMS" \
  sh release/install.sh --version 9.9.9 --install-dir "$PINNED_INSTALL_DIR" \
    > "${TMP_DIR}/install-pinned.log" 2>&1

if [ ! -x "${PINNED_INSTALL_DIR}/anycloud" ]; then
  echo "   ✗ ERROR: pinned install did not write to --install-dir"
  cat "${TMP_DIR}/install-pinned.log"
  exit 1
fi

if ! grep -q "releases/download/v9.9.9/${ASSET_NAME}" "$CURL_LOG"; then
  echo "   ✗ ERROR: installer did not request the pinned release asset"
  cat "$CURL_LOG"
  exit 1
fi

echo "   ✓ Installer supports pinned versions and explicit install dirs"

# The remaining cases control the user ID, sudo, HOME, PATH and the previous
# installer's /usr/local/bin default, which is redirected into the temp dir.
SUDO_LOG="${TMP_DIR}/sudo.log"
LEGACY_DIR="${TMP_DIR}/legacy-bin"
INSTALLER="${TMP_DIR}/install.sh"
BASE_PATH="/usr/bin:/bin"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
mkdir -p "$LEGACY_DIR"
: > "$SUDO_LOG"
sed "s|^LEGACY_DIR=/usr/local/bin\$|LEGACY_DIR='${LEGACY_DIR}'|" release/install.sh > "$INSTALLER"
grep -q "^LEGACY_DIR='${LEGACY_DIR}'\$" "$INSTALLER"

cat > "${FAKE_BIN}/id" <<'ID'
#!/bin/bash
if [ "${1:-}" = "-u" ]; then echo "${FAKE_UID:-1000}"; else exec /usr/bin/id "$@"; fi
ID
# Records the elevated command; the test cannot actually elevate.
cat > "${FAKE_BIN}/sudo" <<'SUDO'
#!/bin/bash
echo "$*" >> "$SUDO_LOG"
SUDO
chmod +x "${FAKE_BIN}/id" "${FAKE_BIN}/sudo"

fail() {
  echo "   ✗ ERROR: $1"
  [ -f "${2:-}" ] && cat "$2"
  exit 1
}

# run_install [VAR=value ...] -- [installer args...]; output goes to $LOG.
run_install() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    envs+=("$1")
    shift
  done
  [ "$#" -gt 0 ] && shift
  env -u ZDOTDIR -u XDG_CONFIG_HOME -u ANYCLOUD_INSTALL_DIR -u ANYCLOUD_NO_MODIFY_PATH \
    HOME="$TEST_HOME" SHELL=/bin/bash PATH="${FAKE_BIN}:${BASE_PATH}" \
    CURL_LOG="$CURL_LOG" ASSET_NAME="$ASSET_NAME" ASSET_TARBALL="$ASSET_TARBALL" \
    CHECKSUMS="$CHECKSUMS" SUDO_LOG="$SUDO_LOG" \
    ${envs[@]+"${envs[@]}"} sh "$INSTALLER" "$@" > "$LOG" 2>&1
}

new_home() {
  TEST_HOME="${TMP_DIR}/$1"
  LOG="${TMP_DIR}/$(basename "$1").log"
  mkdir -p "$TEST_HOME"
}

echo "4. Installing into ~/.local/bin without sudo and adding it to PATH once..."
new_home 'home with space/we$ird'
run_install || fail "default install failed" "$LOG"
[ -x "${TEST_HOME}/.local/bin/anycloud" ] || fail "anycloud was not installed to ~/.local/bin" "$LOG"
[ ! -s "$SUDO_LOG" ] || fail "fresh install invoked sudo" "$SUDO_LOG"
run_install || fail "repeat install failed" "$LOG"
[ "$(grep -cxF "$PATH_LINE" "${TEST_HOME}/.bashrc")" -eq 1 ] || fail "PATH line missing or duplicated" "${TEST_HOME}/.bashrc"
FOUND=$(HOME="$TEST_HOME" PATH="$BASE_PATH" bash -c '. "$HOME/.bashrc"; command -v anycloud')
[ "$FOUND" = "${TEST_HOME}/.local/bin/anycloud" ] || fail "sourced PATH resolved anycloud to '$FOUND'"
echo "   ✓ Fresh installs use ~/.local/bin, never sudo, and keep unusual HOME paths literal"

echo "5. Respecting ZDOTDIR and fish configuration locations..."
new_home zsh-home
run_install SHELL=/bin/zsh ZDOTDIR="${TMP_DIR}/zdot" || fail "zsh install failed" "$LOG"
grep -qxF "$PATH_LINE" "${TMP_DIR}/zdot/.zshrc" || fail "PATH was not added to \$ZDOTDIR/.zshrc" "$LOG"
[ ! -e "${TEST_HOME}/.zshrc" ] || fail "installer wrote ~/.zshrc despite ZDOTDIR"
new_home fish-home
run_install SHELL=/usr/bin/fish XDG_CONFIG_HOME="${TMP_DIR}/xdg" || fail "fish install failed" "$LOG"
grep -qxF 'fish_add_path "$HOME/.local/bin"' "${TMP_DIR}/xdg/fish/conf.d/anycloud.fish" || fail "fish PATH config missing" "$LOG"
echo "   ✓ Shell setup honors ZDOTDIR and XDG_CONFIG_HOME"

echo "6. Leaving shell files untouched on opt-out, explicit directories, or an existing PATH entry..."
new_home opt-out-flag
run_install -- --no-modify-path || fail "--no-modify-path install failed" "$LOG"
[ ! -e "${TEST_HOME}/.bashrc" ] || fail "--no-modify-path wrote .bashrc"
grep -q 'is not on PATH' "$LOG" || fail "--no-modify-path did not print manual PATH instructions" "$LOG"
new_home opt-out-env
run_install ANYCLOUD_NO_MODIFY_PATH=1 || fail "ANYCLOUD_NO_MODIFY_PATH install failed" "$LOG"
[ ! -e "${TEST_HOME}/.bashrc" ] || fail "ANYCLOUD_NO_MODIFY_PATH wrote .bashrc"
new_home explicit-dir
run_install -- --install-dir "${TEST_HOME}/.local/bin" || fail "explicit-dir install failed" "$LOG"
[ ! -e "${TEST_HOME}/.bashrc" ] || fail "explicit --install-dir wrote .bashrc"
new_home on-path
run_install PATH="${FAKE_BIN}:${TMP_DIR}/on-path/.local/bin:${BASE_PATH}" || fail "on-PATH install failed" "$LOG"
[ ! -e "${TEST_HOME}/.bashrc" ] || fail "installer wrote .bashrc although the directory was on PATH"
echo "   ✓ Shell files change only for default installs that need it"

echo "7. Refusing Homebrew-managed targets before network access..."
new_home brew
BREW="${TMP_DIR}/brew"
mkdir -p "${BREW}/Cellar/anycloud/1.0/bin" "${BREW}/bin" "${BREW}/opt/anycloud"
printf '#!/bin/sh\necho brew-anycloud\n' > "${BREW}/Cellar/anycloud/1.0/bin/anycloud"
chmod +x "${BREW}/Cellar/anycloud/1.0/bin/anycloud"
ln -s ../Cellar/anycloud/1.0/bin/anycloud "${BREW}/bin/anycloud"
ln -s ../../Cellar/anycloud/1.0/bin "${BREW}/opt/anycloud/bin"
[ "$("${BREW}/bin/anycloud")" = brew-anycloud ] || fail "Homebrew symlink fixture is not executable"
CURL_CALLS=$(wc -l < "$CURL_LOG")
for dir in "${BREW}/bin" "${BREW}/opt/anycloud/bin"; do
  if run_install -- --install-dir "$dir"; then fail "installer replaced Homebrew file via $dir" "$LOG"; fi
  grep -q 'managed by Homebrew' "$LOG" || fail "Homebrew refusal was not explained" "$LOG"
done
[ -L "${BREW}/bin/anycloud" ] || fail "Homebrew symlink was replaced"
[ "$("${BREW}/Cellar/anycloud/1.0/bin/anycloud")" = brew-anycloud ] || fail "Homebrew binary was modified"
[ "$(wc -l < "$CURL_LOG")" -eq "$CURL_CALLS" ] || fail "installer downloaded before refusing Homebrew" "$CURL_LOG"
echo "   ✓ Homebrew files stay untouched, including through symlinked directories"

echo "8. Updating the previous installer's system location and selecting /usr/local/bin for root..."
new_home legacy
printf '#!/bin/sh\necho anycloud 0.0.1\n' > "${LEGACY_DIR}/anycloud"
chmod +x "${LEGACY_DIR}/anycloud"
run_install || fail "legacy update failed" "$LOG"
[ "$("${LEGACY_DIR}/anycloud")" = "anycloud 9.9.9" ] || fail "legacy install was not updated" "$LOG"
[ ! -e "${TEST_HOME}/.local/bin/anycloud" ] || fail "legacy update installed a second copy"
[ ! -e "${TEST_HOME}/.bashrc" ] || fail "legacy update wrote .bashrc"
rm "${LEGACY_DIR}/anycloud"
ln -s "${BREW}/Cellar/anycloud/1.0/bin/anycloud" "${LEGACY_DIR}/anycloud"
new_home legacy-symlink
run_install || fail "install beside a symlinked system binary failed" "$LOG"
[ -x "${TEST_HOME}/.local/bin/anycloud" ] || fail "a symlink in the system dir was treated as a legacy install" "$LOG"
rm "${LEGACY_DIR}/anycloud"
new_home root
run_install FAKE_UID=0 || fail "root install failed" "$LOG"
[ -x "${LEGACY_DIR}/anycloud" ] || fail "root install did not use /usr/local/bin" "$LOG"
rm "${LEGACY_DIR}/anycloud"
echo "   ✓ Existing system installs update in place; root keeps /usr/local/bin"

if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  echo "9. Using sudo only to update an existing install in a read-only directory..."
  new_home read-only
  RO_NEW="${TMP_DIR}/ro-new"
  RO_EXISTING="${TMP_DIR}/ro-existing"
  mkdir -p "$RO_NEW" "$RO_EXISTING"
  printf '#!/bin/sh\necho anycloud 0.0.1\n' > "${RO_EXISTING}/anycloud"
  chmod +x "${RO_EXISTING}/anycloud"
  chmod 555 "$RO_NEW" "$RO_EXISTING"
  if run_install -- --install-dir "$RO_NEW"; then fail "installer wrote to a read-only directory" "$LOG"; fi
  grep -q 'cannot write to' "$LOG" || fail "read-only failure was not explained" "$LOG"
  [ ! -s "$SUDO_LOG" ] || fail "fresh read-only install invoked sudo" "$SUDO_LOG"
  run_install -- --install-dir "$RO_EXISTING" || fail "elevated update failed" "$LOG"
  grep -q 'needs sudo' "$LOG" || fail "elevation was not explained" "$LOG"
  grep -q "^install -m 755 .*${RO_EXISTING}/anycloud\$" "$SUDO_LOG" || fail "existing install was not updated with sudo" "$SUDO_LOG"
  chmod 755 "$RO_NEW" "$RO_EXISTING"
  echo "   ✓ sudo is limited to updating an existing install, with an explanation"
fi

echo "10. Reporting another anycloud earlier on PATH without changing it..."
new_home shadowed
OTHER="${TMP_DIR}/other-bin"
mkdir -p "$OTHER"
printf '#!/bin/sh\necho anycloud 0.0.1\n' > "${OTHER}/anycloud"
chmod +x "${OTHER}/anycloud"
run_install PATH="${FAKE_BIN}:${OTHER}:${TMP_DIR}/shadowed/.local/bin:${BASE_PATH}" || fail "shadowed install failed" "$LOG"
grep -q "${OTHER}/anycloud comes first on PATH" "$LOG" || fail "PATH conflict was not reported" "$LOG"
[ "$("${OTHER}/anycloud")" = "anycloud 0.0.1" ] || fail "the other anycloud was modified"
echo "   ✓ PATH conflicts are reported and the other binary is left alone"

echo "11. Treating a symlink on PATH to the installed binary as on PATH..."
new_home symlinked
REAL_DIR="${TMP_DIR}/real-bin"
LINK_DIR="${TMP_DIR}/link-bin"
mkdir -p "$REAL_DIR" "$LINK_DIR"
ln -s "${REAL_DIR}/anycloud" "${LINK_DIR}/anycloud"
run_install PATH="${FAKE_BIN}:${LINK_DIR}:${BASE_PATH}" -- --install-dir "$REAL_DIR" || fail "symlinked install failed" "$LOG"
if grep -qE 'not on PATH|comes first on PATH' "$LOG"; then fail "symlinked binary was reported as off PATH" "$LOG"; fi
echo "   ✓ A symlink on PATH to the installed binary needs no PATH advice"

echo "12. Using the startup file macOS bash login shells already read..."
DARWIN_ASSET="anycloud-darwin-${ARCH}.tar.gz"
mkdir -p "${TMP_DIR}/darwin"
cp "$ASSET_TARBALL" "${TMP_DIR}/darwin/${DARWIN_ASSET}"
printf '%s  %s\n' "$(checksum_file "${TMP_DIR}/darwin/${DARWIN_ASSET}")" "$DARWIN_ASSET" > "${TMP_DIR}/darwin/checksums.txt"
cat > "${FAKE_BIN}/uname" <<'UNAME'
#!/bin/bash
if [ "${1:-}" = "-s" ]; then echo Darwin; else exec /usr/bin/uname "$@"; fi
UNAME
chmod +x "${FAKE_BIN}/uname"
DARWIN_ENV=(ASSET_NAME="$DARWIN_ASSET" ASSET_TARBALL="${TMP_DIR}/darwin/${DARWIN_ASSET}" CHECKSUMS="${TMP_DIR}/darwin/checksums.txt")
new_home mac-profile
run_install "${DARWIN_ENV[@]}" || fail "macOS install failed" "$LOG"
grep -qxF "$PATH_LINE" "${TEST_HOME}/.profile" || fail "macOS bash did not fall back to ~/.profile" "$LOG"
[ ! -e "${TEST_HOME}/.bash_profile" ] || fail "installer created ~/.bash_profile, hiding ~/.profile"
new_home mac-bash-profile
: > "${TEST_HOME}/.bash_profile"
: > "${TEST_HOME}/.bash_login"
run_install "${DARWIN_ENV[@]}" || fail "macOS install with .bash_profile failed" "$LOG"
grep -qxF "$PATH_LINE" "${TEST_HOME}/.bash_profile" || fail "existing ~/.bash_profile was not used" "$LOG"
[ ! -s "${TEST_HOME}/.bash_login" ] || fail "~/.bash_login was used ahead of ~/.bash_profile"
new_home mac-bash-login
: > "${TEST_HOME}/.bash_login"
run_install "${DARWIN_ENV[@]}" || fail "macOS install with .bash_login failed" "$LOG"
grep -qxF "$PATH_LINE" "${TEST_HOME}/.bash_login" || fail "existing ~/.bash_login was not used" "$LOG"
rm "${FAKE_BIN}/uname"
echo "   ✓ macOS bash uses the first startup file bash reads, never creating one ahead of ~/.profile"

echo ""
echo "========================================="
echo "All install script tests PASSED!"
echo "========================================="
