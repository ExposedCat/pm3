# Pain Points

- pm3 provides an easy supervision and control over projects which compose does
  not. compose only starts containers, pm3 supervises and manages them.
- pm3 fixes healthcheck issues, see [healthcheck](#healthcheck)

# Supervision

- pm3 maintains own database list of projects and their services. this allows
  pm3 not to just rely on running containers, but spot when, for whatever
  reason, some services or entire compose projects were not started. compose
  just won't list unstarted containers, pm3 will use database and compare it
  against podman state resulting in visible project failure
- pm3 trims huge podman outputs, it shows concise outputs with spinners of
  current actions and only shows warnings and errors, per-service, unless a raw
  log param not specified
- pm3 provides a simple to use CLI tool, always with 3 options: default concise
  output, raw command execution log, and detach mode which runs same command as
  a detached process
- pm3 has a daemon for background startup and monitoring, see [daemon](#daemon)

# Daemon

- pm3 has an optional daemon that tracks which projects are enabled to be
  started up in a database, and on startup it ensure enabled projects are
  started
- pm3 tracks events and state for "degraded later" or "recovered later",
  "started" or "stopped" etc. so that it can report it

# Healthcheck

- pm3 unlike compose tracks list of required services to be started via x-pm3
  compose section. it also tracks dependency tree. unlike compose which just
  hangs, when pm3 notices that any required service is blocked by unhealthy
  dependency, which means required service could never start, it will
  compose-down entire project.
- pm3 unlike compose properly handles healthcheck setup. unlike compose, pm3
  doesn't treat service unhealthy until all the healthcheck retries finish,
  which means that for infinite retires service never treated unhealthy, for 3
  failed retries, first 2 are treated as basically starting, and only 3rd, final
  failure is treated as unhealthy service, which triggers reporting or
  compose-down (see above). this solves noisy reports while restarting and stuck
  services
