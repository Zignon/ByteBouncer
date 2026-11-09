#!/usr/bin/env bash
# Builds ByteBouncer-Setup-<version>-x64.exe from Linux without Wine.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
export CSC_IDENTITY_AUTO_DISCOVERY=false
rm -rf dist
# 1) package the app (electron-builder stops at the Wine-only signing step; win-unpacked is complete by then)
npx electron-builder --win --x64 --dir >/dev/null 2>&1 || true
test -f dist/win-unpacked/ByteBouncer.exe || { echo "packaging failed"; exit 1; }
rm -f dist/win-unpacked/resources/app-update.yml dist/win-unpacked/resources/elevate.exe
# 2) stamp icon + version info with a pure-JS PE editor
node build/brand-exe.js dist/win-unpacked/ByteBouncer.exe
# 3) compile the installer with the NSIS build electron-builder caches
NSIS=$(ls -d ~/.cache/electron-builder/nsis/nsis-3.*/ | head -1)
"$NSIS/linux/makensis" -V2 -NOCD "-DSRC_DIR=$PWD" "-DAPP_DIR=$PWD/dist/win-unpacked" "-DAPP_VERSION=$VER" "-DOUT_FILE=$PWD/dist/ByteBouncer-Setup-$VER-x64.exe" build/installer.nsi
ls -la dist/*.exe
