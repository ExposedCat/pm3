# pm3

Container spinning made simple

## Requirements

`pm3` operates on top of `podman-compose`. Make sure to install it whichever
way.

## Commands

```sh
pm3 create WORKDIR [--name NAME]        # teach pm3 about a compose project
pm3 start NAME [-b|--build]             # podman-compose up -d
pm3 start NAME [-c|--no-cache]          # rebuild from scratch, then start
pm3 stop NAME                           # stop the project
pm3 restart NAME [-b|--build]           # restart, optionally rebuilding first
pm3 list [-d|--detailed]                # show the fleet
pm3 view NAME                           # inspect the project
pm3 rm NAME [-f|--force]                # remove it and its Podman artifacts
```

## Examples

Create a project from a compose directory:

```sh
pm3 create ./apps/web --name website
```

Start it, then admire the table:

```sh
pm3 start website
pm3 list --detailed
```

Rebuild after you changed something suspicious:

```sh
pm3 restart website --build
```

Go full scorched-earth rebuild:

```sh
pm3 start website --no-cache
```

Clean up when the experiment has learned its lesson:

```sh
pm3 stop website
pm3 rm website
```

## Compose Notes

`pm3` does not invent a new orchestration religion. Keep using normal Compose
features like `depends_on`, `service_healthy`, and healthchecks.
Project-specific extras are planned under `x-pm3` for hooks, timeouts, failure
limits, and reporting.
