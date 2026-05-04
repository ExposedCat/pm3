# pm3

`pm3` is a Podman Compose project manager.

It does not replace Compose files. You keep standard Compose configuration and
run stacks through `podman-compose`. `pm3` adds a small registry, lifecycle
commands, boot-time autostart, startup failure detection, health-aware
stopping, and service hooks.

## What It Does

- registers compose projects by name
- starts, stops, and restarts projects with `podman-compose`
- stores project state in SQLite
- runs an autostart daemon
- watches service state and health transitions
- enforces `x-pm3.startup` policy
- runs `x-pm3.hooks` commands on service events

## Docs

- [Getting Started](Getting-Started)
- [Command Reference](Command-Reference)
- [Examples](Examples)
- [x-pm3 Spec](X-PM3-Spec)

## Fast Path

```sh
pm3 create ./apps/api --name api
pm3 enable api --now
pm3 list --detailed
```

## Mental Model

1. `create` registers a compose working directory in the local database.
2. `start`, `stop`, and `restart` run `podman-compose` in that directory.
3. `enable` marks a project for autostart.
4. The daemon starts enabled projects after boot and keeps watching service
   status and health.
5. `x-pm3` extends the compose file with startup policy and hooks.
