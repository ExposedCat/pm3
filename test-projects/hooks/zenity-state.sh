#!/usr/bin/env bash
set -eu

project=${1:?missing project}
service=${2:?missing service}
state=${3:?missing state}

title="pm3: ${project}/${service}"
text=$(printf 'project: %s\nservice: %s\nstate: %s' "$project" "$service" "$state")

nohup zenity \
  --info \
  --title="$title" \
  --width=320 \
  --text="$text" \
  >/dev/null 2>&1 &
