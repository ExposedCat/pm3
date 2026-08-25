#!/usr/bin/env bash

set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
generated_dir="$fixture_dir/generated"
origin_dir="$generated_dir/origin.git"
seed_dir="$generated_dir/seed"

rm -rf "$generated_dir"
mkdir -p "$generated_dir"

git init --bare "$origin_dir"
git init --initial-branch=main "$seed_dir"
git -C "$seed_dir" config user.name "PM3 test"
git -C "$seed_dir" config user.email "pm3-test@example.invalid"
cp "$fixture_dir/compose.yaml" "$seed_dir/compose.yaml"
printf 'initial\n' > "$seed_dir/state.txt"
git -C "$seed_dir" add compose.yaml state.txt
git -C "$seed_dir" commit -m "Initial state"
git -C "$seed_dir" remote add origin "$origin_dir"
git -C "$seed_dir" push --set-upstream origin main
git --git-dir="$origin_dir" symbolic-ref HEAD refs/heads/main

git clone "$origin_dir" "$generated_dir/pulled-commits"
git clone "$origin_dir" "$generated_dir/failed-pull"
git -C "$generated_dir/failed-pull" config user.name "PM3 test"
git -C "$generated_dir/failed-pull" config user.email "pm3-test@example.invalid"
printf 'local change\n' > "$generated_dir/failed-pull/state.txt"
git -C "$generated_dir/failed-pull" add state.txt
git -C "$generated_dir/failed-pull" commit -m "Local divergent change"

printf 'remote change 1\n' > "$seed_dir/state.txt"
git -C "$seed_dir" add state.txt
git -C "$seed_dir" commit -m "Remote change 1"
printf 'remote change 2\n' > "$seed_dir/state.txt"
git -C "$seed_dir" add state.txt
git -C "$seed_dir" commit -m "Remote change 2"
git -C "$seed_dir" push

git -C "$generated_dir/failed-pull" fetch origin
git -C "$generated_dir/failed-pull" config advice.diverging false
git clone "$origin_dir" "$generated_dir/no-changes"

printf 'Created Git pull fixtures in %s\n' "$generated_dir"
