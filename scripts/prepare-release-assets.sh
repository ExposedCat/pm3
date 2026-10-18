#!/usr/bin/env bash

set -euo pipefail

version="${VERSION:?VERSION is required.}"
release_dir="dist/release"
checksums="$release_dir/pm3-$version-SHA256SUMS.txt"

mkdir -p "$release_dir"
install -m0755 dist/pm3 "$release_dir/pm3-linux-x86_64"
install -m0644 packaging/pm3.service "$release_dir/pm3.service"

sums="$(find "$release_dir" -maxdepth 1 -type f ! -path "$checksums" -print0 | xargs -0 sha256sum | sort)"
printf '%s\n' "$sums" > "$checksums"
