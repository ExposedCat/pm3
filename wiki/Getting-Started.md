# Getting Started

## Requirements

- `podman`
- `podman-compose`
- Linux user session with systemd if you want auto-start through
  `packaging/pm3.service`
- a compose file named one of:
  `podman-compose.yaml`, `podman-compose.yml`, `compose.yaml`, `compose.yml`,
  `docker-compose.yaml`, `docker-compose.yml`

## Install

Install `pm3`, then confirm the runtime tools are available:

```sh
pm3 help
podman --version
podman-compose --version
```

## Register a Project

Register a compose directory:

```sh
pm3 create ./apps/web --name website
```

Without `--name`, `pm3` uses the directory basename.

## Start a Project

```sh
pm3 start website
```

Build before start:

```sh
pm3 start website --build
```

Build without cache:

```sh
pm3 start website --no-cache
```

## Enable Autostart

Enable startup and start immediately:

```sh
pm3 enable website --now
```

This marks the project for autostart. The daemon is what makes boot-time
startup, health tracking, watcher policy, and hooks work across the user
session.

## Inspect State

```sh
pm3 list
pm3 list --detailed
pm3 view website
```

## Run the Daemon

Foreground:

```sh
pm3 daemon
```

User systemd service:

```sh
systemctl --user enable --now pm3.service
```

The packaged service runs:

```sh
pm3 daemon
```

## How It Works

- project metadata is stored in SQLite
- default database path is
  `${XDG_DATA_HOME:-$HOME/.local/share}/pm3/pm3.sqlite`
- `start`, `stop`, and `restart` call `podman-compose` in the registered
  working directory
- `enable` and `disable` only toggle autostart unless `--now` is used
- the daemon watches enabled projects and reacts to service state and health
  changes
- `x-pm3.startup` can abort or stop projects that are permanently blocked
- `x-pm3.hooks` can run commands on service transitions

## Next

- [Command Reference](Command-Reference)
- [Examples](Examples)
- [x-pm3 Spec](X-PM3-Spec)
