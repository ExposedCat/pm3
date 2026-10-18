#!/usr/bin/env bash

set -euo pipefail

version="${VERSION:?VERSION is required.}"
mapfile -t assets < <(find dist/release -maxdepth 1 -type f | sort)

gh release create "v$version" "${assets[@]}" \
  --title "pm3 v$version" \
  --notes "Release generated from tito version $version."
