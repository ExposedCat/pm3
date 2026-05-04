# Command Reference

Global option:

- `-v`, `--verbose`: include verbose compose output

## Summary

| Command | Description |
| --- | --- |
| `pm3 create WORKDIR [--name NAME]` | Register project |
| `pm3 enable NAME [--now]` | Enable project startup |
| `pm3 disable NAME [--now]` | Disable project startup |
| `pm3 start NAME [--detach] [--build] [--no-cache]` | Start the project |
| `pm3 stop NAME [--detach]` | Stop the project |
| `pm3 restart NAME [--detach] [--build] [--no-cache]` | Restart the project |
| `pm3 list [--detailed]` | List projects |
| `pm3 view NAME` | Show registered project metadata |
| `pm3 rm NAME [--force]` | Remove project and Podman artifacts |
| `pm3 remove NAME [--force]` | Alias for `rm` |
| `pm3 daemon` | Run autostart daemon |
| `pm3 help` | Show help |

## create

Syntax:

```sh
pm3 create WORKDIR [--name NAME]
```

Behavior:

- resolves `WORKDIR` to an absolute path
- stores the project in the SQLite registry
- uses the directory basename when `--name` is omitted

Examples:

```sh
pm3 create ./apps/api
pm3 create ./apps/web --name website
```

## enable

Syntax:

```sh
pm3 enable NAME [-n|--now]
```

Behavior:

- marks the project for autostart
- `--now` also starts the project immediately

Examples:

```sh
pm3 enable website
pm3 enable website --now
```

## disable

Syntax:

```sh
pm3 disable NAME [-n|--now]
```

Behavior:

- disables autostart for the project
- `--now` also stops the project immediately

Examples:

```sh
pm3 disable website
pm3 disable website --now
```

## start

Syntax:

```sh
pm3 start NAME [-d|--detach] [-b|--build] [-c|--no-cache]
```

Behavior:

- runs project startup through `podman-compose`
- `--build` builds images before start
- `--no-cache` implies `--build` and disables build cache
- `--detach` launches the lifecycle in a detached child process

Examples:

```sh
pm3 start website
pm3 start website --build
pm3 start website --no-cache
pm3 start website --detach
```

## stop

Syntax:

```sh
pm3 stop NAME [-d|--detach]
```

Behavior:

- stops the project with compose down semantics
- current stop path removes orphans
- `--detach` launches the lifecycle in a detached child process

Examples:

```sh
pm3 stop website
pm3 stop website --detach
```

## restart

Syntax:

```sh
pm3 restart NAME [-d|--detach] [-b|--build] [-c|--no-cache]
```

Behavior:

- restarts the project
- `--build` builds images before restart
- `--no-cache` implies `--build`
- `--detach` launches the lifecycle in a detached child process

Examples:

```sh
pm3 restart website
pm3 restart website --build
pm3 restart website --no-cache
pm3 restart website --detach
```

## list

Syntax:

```sh
pm3 list [-d|--detailed]
```

Behavior:

- prints all registered projects
- shows startup state, current project state, created time, and published ports
- `--detailed` adds state duration detail

Examples:

```sh
pm3 list
pm3 list --detailed
```

## view

Syntax:

```sh
pm3 view NAME
```

Behavior:

- prints stored registry metadata for one project
- current output fields are `name`, `id`, and `workdir`

Example:

```sh
pm3 view website
```

## rm / remove

Syntax:

```sh
pm3 rm NAME [-f|--force]
pm3 remove NAME [-f|--force]
```

Behavior:

- removes compose artifacts and deletes the project from the registry
- fails if the project is still running unless `--force` is used

Examples:

```sh
pm3 rm website
pm3 rm website --force
```

## daemon

Syntax:

```sh
pm3 daemon
```

Behavior:

- loads enabled projects from the registry
- restores state watchers for them
- watches service state and health changes
- runs `x-pm3.hooks`
- enforces `x-pm3.startup` watcher policy

Example:

```sh
pm3 daemon
```

## help

Syntax:

```sh
pm3 help
pm3 --help
pm3 -h
```

Example:

```sh
pm3 help
```
