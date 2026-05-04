# x-pm3 Spec

`pm3` reads an optional top-level `x-pm3` section from the resolved compose
config.

## Schema

```yaml
x-pm3:
  startup:
    mode: startup | watcher
    required_services:
      - service-name
    stop_when_unstartable: all
  hooks:
    all:
      starting: <command>
      started: <command>
      healthy: <command>
      degraded: <command>
      stopping: <command>
      stopped: <command>
    service-name:
      starting: <command>
      started: <command>
      healthy: <command>
      degraded: <command>
      stopping: <command>
      stopped: <command>
```

All fields are optional.

## startup

### `startup.mode`

- `startup`: enforce startup blocking only until a service has started once
- `watcher`: keep enforcing blocking after startup while the daemon is watching
  the project

Default:

```yaml
mode: startup
```

### `startup.required_services`

List of service names that must become startable.

Rules:

- every name must exist in `services`
- if any required service becomes permanently blocked, `pm3` treats startup as
  failed
- when the list is empty and `stop_when_unstartable` is unset, no startup
  policy is enabled

Example:

```yaml
x-pm3:
  startup:
    required_services:
      - api
      - worker
```

### `startup.stop_when_unstartable`

Supported value:

- `all`: if every remaining not-yet-started service is terminally blocked,
  treat the project as unstartable

In `watcher` mode, the daemon reacts by stopping the whole project.

Example:

```yaml
x-pm3:
  startup:
    mode: watcher
    stop_when_unstartable: all
```

## Dependency Semantics

`pm3` derives dependency edges from normal Compose `depends_on`.

Supported conditions:

- `service_started`
- `service_healthy`

List-form `depends_on` is treated as `service_started`.

Example:

```yaml
services:
  api:
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
```

Terminal blocking rules:

- a dependency in `stopping` or `stopped` state blocks consumers that never
  started
- a `service_healthy` dependency also blocks consumers when the dependency is
  `degraded`
- blocked dependencies propagate through the dependency graph

## hooks

`x-pm3.hooks` maps services to event commands.

Supported events:

- `starting`
- `started`
- `healthy`
- `degraded`
- `stopping`
- `stopped`

Resolution order:

1. service-specific hook
2. `all` hook
3. no hook

Hook values:

- must be non-empty strings
- run from the project working directory
- are ignored when missing or blank

Example:

```yaml
x-pm3:
  hooks:
    all:
      degraded: ./scripts/report-degraded.sh
    api:
      healthy: ./scripts/api-healthy.sh
      stopped: ./scripts/api-stopped.sh
```

## Full Example

```yaml
services:
  db:
    image: postgres:17
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    image: ghcr.io/example/api:latest
    depends_on:
      db:
        condition: service_healthy

x-pm3:
  startup:
    mode: watcher
    required_services:
      - api
    stop_when_unstartable: all
  hooks:
    all:
      degraded: ./scripts/report-degraded.sh
    api:
      started: ./scripts/api-started.sh
      healthy: ./scripts/api-healthy.sh
```
