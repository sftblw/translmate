#!/bin/bash

set -euo pipefail

pnpm wxt build -b firefox
OUT_PATH=".output/firefox-mv2"

# zip OUT_PATH to _local_install/translmate-firefox
pushd "$OUT_PATH" >/dev/null

mkdir -p "../../_local_install"
zip -rFS "../../_local_install/translmate-firefox.zip" .

popd >/dev/null
