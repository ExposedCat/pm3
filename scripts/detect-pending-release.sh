#!/usr/bin/env bash

set -euo pipefail

base_ref="${1:-}"
head_ref="${2:-HEAD}"
package_file=".tito/packages/pm3"
force_release="${FORCE_RELEASE:-false}"

if [[ "$force_release" == "true" ]]; then
  changed=true
elif [[ -z "$base_ref" || "$base_ref" == "0000000000000000000000000000000000000000" ]]; then
  base_ref="$(git rev-list --max-parents=0 HEAD)"
fi

if [[ "${changed:-}" != "true" ]]; then
  if git diff --quiet "$base_ref" "$head_ref" -- "$package_file"; then
    changed=false
  else
    changed=true
  fi
fi

version=""
if [[ "$changed" == "true" ]]; then
  version="$(awk '{print $1}' "$package_file" | sed 's/-[^-]*$//')"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'changed=%s\n' "$changed"
    if [[ -n "$version" ]]; then
      printf 'version=%s\n' "$version"
    fi
  } >> "$GITHUB_OUTPUT"
else
  printf 'changed=%s\n' "$changed"
  if [[ -n "$version" ]]; then
    printf 'version=%s\n' "$version"
  fi
fi
