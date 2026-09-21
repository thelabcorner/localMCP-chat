#!/usr/bin/env bash
set -euo pipefail

# Prove the final Linux x64 release artifacts on the oldest Linux userspace we
# currently promise: Ubuntu 20.04 (glibc 2.31). Running the packaged Electron
# runtime and every bundled native executable catches a newer-GLIBC dependency
# that metadata inspection alone can miss.

deb_path="${1:-release/localMCP-chat-Linux-x64.deb}"
appimage_path="${2:-release/localMCP-chat-Linux-x64.AppImage}"

for artifact in "$deb_path" "$appimage_path"; do
  if [[ ! -f "$artifact" ]]; then
    echo "Missing Linux compatibility artifact: $artifact" >&2
    exit 1
  fi
done

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for the Ubuntu 20.04 compatibility smoke test." >&2
  exit 1
}

release_dir="$(cd "$(dirname "$deb_path")" && pwd)"
deb_name="$(basename "$deb_path")"
appimage_name="$(basename "$appimage_path")"

if [[ "$(cd "$(dirname "$appimage_path")" && pwd)" != "$release_dir" ]]; then
  echo "DEB and AppImage must be in the same release directory." >&2
  exit 1
fi

docker run --rm --platform linux/amd64 \
  -e DEBIAN_FRONTEND=noninteractive \
  -v "$release_dir:/release:ro" \
  ubuntu:20.04 bash -s -- "$deb_name" "$appimage_name" <<'CONTAINER'
set -euo pipefail

deb="/release/$1"
appimage="/release/$2"

glibc_line="$(ldd --version 2>&1 | head -n 1)"
case "$glibc_line" in
  *" 2.31"*) ;;
  *) echo "Expected Ubuntu 20.04 / glibc 2.31, got: $glibc_line" >&2; exit 1 ;;
esac

arch="$(dpkg-deb -f "$deb" Architecture)"
[[ "$arch" == "amd64" ]] || { echo "Expected amd64 DEB, got $arch" >&2; exit 1; }

apt-get update
apt-get install -y --no-install-recommends ca-certificates "$deb"

package_name="$(dpkg-deb -f "$deb" Package)"
app="$(dpkg -L "$package_name" | awk '/\/localMCP-chat$/ { print; exit }')"
[[ -n "$app" && -x "$app" ]] || { echo "Could not locate installed localMCP-chat executable." >&2; exit 1; }

resources="$(dirname "$app")/resources"
[[ -d "$resources" ]] || { echo "Missing installed resources directory: $resources" >&2; exit 1; }

"$resources/rg/rg" --version
"$resources/tunnel/tunnel-client" --version
"$resources/tunnel/cloudflared" --version

probe="$(cat <<'NODE'
(async () => {
  const base = process.env.LOCALMCP_RESOURCES_DIR;
  const pty = require(base + '/app.asar/node_modules/node-pty');
  const terminal = pty.spawn('/bin/sh', ['-lc', 'printf focal-packaged-pty'], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node-pty focal probe timed out')), 10000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      exitCode === 0 ? resolve() : reject(new Error('node-pty focal child exited ' + exitCode));
    });
  });
  if (!output.includes('focal-packaged-pty')) throw new Error('node-pty focal output mismatch');
  process.stdout.write(JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    pty: true
  }) + '\n');
})().catch((error) => {
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exit(1);
});
NODE
)"

ELECTRON_RUN_AS_NODE=1 \
  LOCALMCP_RESOURCES_DIR="$resources" \
  "$app" -e "$probe"

# Exercise the AppImage runtime itself as well as the DEB payload. Extract-and-run
# avoids requiring FUSE inside the CI container while still executing the exact
# final AppImage runtime and embedded Electron binary on glibc 2.31.
APPIMAGE_EXTRACT_AND_RUN=1 \
  ELECTRON_RUN_AS_NODE=1 \
  "$appimage" -e "process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node})+'\\n')"

echo "Ubuntu 20.04 / glibc 2.31 Linux x64 compatibility smoke passed."
CONTAINER
