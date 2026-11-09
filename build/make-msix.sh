#!/usr/bin/env bash
# Builds an unsigned MSIX for Microsoft Store submission (Partner Center signs it).
# Identity comes from build/store-identity.json - fill it from Partner Center first.
#   ./build/make-msix.sh            -> dist/ByteBouncer-<ver>-x64.msix
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
PKGVER="$VER.0"                      # Store requires a 4-part version ending in .0
read -r IDNAME PUBLISHER PUBDISP < <(node -p "const j=require('./build/store-identity.json'); [j.identityName,j.publisher.replace(/ /g,' '),j.publisherDisplayName.replace(/ /g,' ')].join(' ')")
PUBLISHER=${PUBLISHER//$' '/ }; PUBDISP=${PUBDISP//$' '/ }

if [[ ! -f dist/win-unpacked/ByteBouncer.exe ]]; then
  echo "dist/win-unpacked missing - run ./build/make-installer.sh first"; exit 1
fi

STAGE=dist/msix-stage
rm -rf "$STAGE"; mkdir -p "$STAGE/app" "$STAGE/assets"
cp -r dist/win-unpacked/. "$STAGE/app/"
rm -f "$STAGE/app/resources/app-update.yml" "$STAGE/app/resources/elevate.exe"
cp build/appx/*.png "$STAGE/assets/"

python3 - "$STAGE/AppxManifest.xml" "$IDNAME" "$PUBLISHER" "$PUBDISP" "$PKGVER" <<'EOF'
import sys, html
out, idname, publisher, pubdisp, ver = sys.argv[1:]
t = open('build/AppxManifest.template.xml', encoding='utf-8').read()
for k, v in {'identityName': idname, 'publisher': publisher, 'publisherDisplayName': pubdisp, 'version': ver}.items():
    t = t.replace('{{%s}}' % k, html.escape(v, quote=True))
open(out, 'w', encoding='utf-8').write(t)
EOF

OUT="dist/ByteBouncer-$VER-x64.msix"
rm -f "$OUT"
export LD_LIBRARY_PATH="$PWD/build/tools${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
./build/tools/makemsix-linux pack -d "$STAGE" -p "$OUT"
echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "  Identity: $IDNAME  Publisher: $PUBLISHER  Version: $PKGVER"
if [[ "$PUBLISHER" == *00000000-0000* ]]; then
  echo "  WARNING: placeholder publisher - edit build/store-identity.json with your Partner Center values and rebuild before uploading."
fi
