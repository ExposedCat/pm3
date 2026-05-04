# Examples

## Register and Run a Project

```sh
pm3 create ./apps/web --name website
pm3 start website
pm3 list --detailed
```

## Enable Boot-Time Autostart

```sh
pm3 enable website --now
systemctl --user enable --now pm3.service
```

## Rebuild Flows

Regular rebuild:

```sh
pm3 restart website --build
```

Clean rebuild:

```sh
pm3 start website --no-cache
```

## Detached Lifecycle

```sh
pm3 start website --detach
pm3 stop website --detach
pm3 restart website --detach
```

## Remove a Project

```sh
pm3 stop website
pm3 rm website
```

Force removal:

```sh
pm3 rm website --force
```

## Minimal Compose Project

```yaml
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
```

Register it:

```sh
pm3 create ./examples/web
pm3 start web
```

## Required Service Startup Policy

Stop startup when required services can never come up:

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
    required_services:
      - api
```

## Watcher Mode

Keep enforcing the dependency policy after initial startup:

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
```

In this mode, if the project later becomes permanently blocked, the daemon
stops the whole stack.

## Service Hooks

Run hooks for one service:

```yaml
x-pm3:
  hooks:
    api:
      started: ./scripts/on-api-started.sh
      degraded: ./scripts/on-api-degraded.sh
      healthy: ./scripts/on-api-healthy.sh
```

Run hooks for every service:

```yaml
x-pm3:
  hooks:
    all:
      started: ./scripts/on-started.sh
      stopped: ./scripts/on-stopped.sh
```

## Verbose Compose Output

```sh
pm3 --verbose start website --build
pm3 -v restart website
```
