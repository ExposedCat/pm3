pub mod config;
pub mod containers;
pub mod events;
mod progress;
pub mod startup;

use std::collections::HashMap;

use futures_util::future::join_all;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio::process::Command;

use self::config::ComposeConfig;
use self::containers::{Container, StateSummary, parse_containers, select_project_containers, summarize};
use self::events::{HealthStatus, PROJECT_LABEL, PodmanEvent, WORKING_DIR_LABEL};
pub use self::progress::Operation;
use self::progress::{Progress, has_warning_word};
use self::startup::StartupTracker;
use crate::Context;
use crate::db::Project;
use crate::error::{Error, Result};
use crate::process::{self, LineReader, LineStream, Output, OutputTail};
use crate::term::{Loader, all_streams_are_terminals, eprint_line, print_line};
use crate::{git, time};

pub const PODMAN: &str = "podman";
pub const PODMAN_COMPOSE: &str = "podman-compose";

/// Files podman-compose looks for when no `-f` is given, in its lookup order.
const DEFAULT_COMPOSE_FILES: [&str; 14] = [
    "compose.yaml",
    "compose.yml",
    "compose.override.yaml",
    "compose.override.yml",
    "podman-compose.yaml",
    "podman-compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.override.yml",
    "docker-compose.override.yaml",
    "container-compose.yml",
    "container-compose.yaml",
    "container-compose.override.yml",
    "container-compose.override.yaml",
];
/// podman-compose global options that take no value.
const GLOBAL_COMPOSE_FLAGS: [&str; 7] = ["-v", "--version", "-h", "--help", "--no-ansi", "--no-cleanup", "--dry-run"];
const VERBOSE_FLAG: &str = "--verbose";
const STOP_ARGS: [&str; 2] = ["down", "--remove-orphans"];
const EVENT_GRACE: Duration = Duration::from_millis(150);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(1);

pub fn compose_args(project: &Project, args: &[String]) -> Vec<String> {
    project.compose_args.iter().chain(args).cloned().collect()
}

fn compose_command(project: &Project, args: &[String]) -> Command {
    process::command(PODMAN_COMPOSE, compose_args(project, args), Some(Path::new(&project.working_dir)))
}

pub fn has_compose_file(project: &Project) -> bool {
    !project.compose_args.is_empty() || default_compose_files(Path::new(&project.working_dir)).next().is_some()
}

fn default_compose_files(dir: &Path) -> impl Iterator<Item = &'static str> {
    DEFAULT_COMPOSE_FILES.into_iter().filter(move |file| dir.join(file).is_file())
}

/// Where podman-compose labels a project's containers: the canonical directory of its first
/// compose file and the compose project name (`None` when it can't be derived statically).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub dir: String,
    pub project_name: Option<String>,
}

pub fn locate(project: &Project) -> Result<Location, String> {
    let working_dir = Path::new(&project.working_dir);
    if !working_dir.is_dir() {
        return Err(format!("Working directory not found: {}", project.working_dir));
    }

    let mut args = parse_global_compose_args(&project.compose_args);
    if args.files.is_empty() {
        if let Some(compose_file) = non_empty_env("COMPOSE_FILE") {
            let separator = std::env::var("COMPOSE_PATH_SEPARATOR").unwrap_or_else(|_| ":".to_owned());
            args.files = compose_file
                .split(separator.as_str())
                .filter(|file| working_dir.join(file).exists())
                .map(str::to_owned)
                .collect();
        } else {
            args.files = default_compose_files(working_dir).map(str::to_owned).collect();
        }
    }

    let first = args.files.first().ok_or_else(|| format!("No compose file found in {}", project.working_dir))?;
    let missing: Vec<&str> =
        args.files.iter().filter(|file| *file != "-" && !working_dir.join(file).exists()).map(String::as_str).collect();
    if !missing.is_empty() {
        return Err(format!("Missing compose files: {}", missing.join(", ")));
    }

    let first_path = working_dir.join(first);
    let parent = first_path.parent().unwrap_or(working_dir);
    let dir = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let project_name = match args.project_name {
        Some(name) => Some(name),
        None if first == "-" => None,
        None => resolve_project_name(working_dir, &dir, &first_path, args.env_file.as_deref()),
    };
    Ok(Location { dir: dir.to_string_lossy().into_owned(), project_name })
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct GlobalComposeArgs {
    files: Vec<String>,
    project_name: Option<String>,
    env_file: Option<String>,
}

/// Extracts `-f/--file`, `-p/--project-name` and `--env-file` from podman-compose global arguments.
fn parse_global_compose_args(args: &[String]) -> GlobalComposeArgs {
    let mut parsed = GlobalComposeArgs::default();
    let mut args = args.iter();

    while let Some(arg) = args.next() {
        // argparse treats tokens with spaces as values, never as options.
        if !arg.starts_with('-')
            || arg.contains(' ')
            || GLOBAL_COMPOSE_FLAGS.contains(&arg.as_str())
            || arg == VERBOSE_FLAG
        {
            continue;
        }

        let (option, value) = match arg.split_once('=').filter(|_| arg.starts_with("--")) {
            Some((option, value)) => (option.to_owned(), Some(value.to_owned())),
            None => match ["-f", "-p"].into_iter().find(|short| arg.len() > 2 && arg.starts_with(short)) {
                Some(short) => (short.to_owned(), Some(arg[2..].to_owned())),
                None => (arg.clone(), None),
            },
        };
        let Some(value) = value.or_else(|| args.next().cloned()) else { break };
        match option.as_str() {
            "-f" | "--file" => parsed.files.push(value),
            "-p" | "--project-name" => parsed.project_name = Some(value),
            "--env-file" => parsed.env_file = Some(value),
            _ => {}
        }
    }

    parsed
}

/// The project name podman-compose derives without `-p`: `COMPOSE_PROJECT_NAME` from the
/// environment or env file, the first compose file's `name`, or the directory name.
fn resolve_project_name(
    working_dir: &Path,
    compose_dir: &Path,
    first_file: &Path,
    env_file: Option<&str>,
) -> Option<String> {
    let name = match non_empty_env("COMPOSE_PROJECT_NAME")
        .or_else(|| env_file_project_name(working_dir, compose_dir, env_file))
    {
        Some(name) => name,
        None => match compose_file_name(first_file)? {
            Some(name) => name,
            None => compose_dir.file_name()?.to_string_lossy().to_lowercase(),
        },
    };
    if name.contains('$') {
        return None;
    }
    let name: String = name.chars().filter(|char| matches!(char, '-' | '_' | 'a'..='z' | '0'..='9')).collect();
    (!name.is_empty()).then_some(name)
}

fn env_file_project_name(working_dir: &Path, compose_dir: &Path, env_file: Option<&str>) -> Option<String> {
    let env_file = env_file.unwrap_or(".env");
    let mut candidates = vec![working_dir.join(env_file)];
    if env_file == ".env" {
        candidates.push(compose_dir.join(".env"));
    }
    candidates
        .iter()
        .find_map(|path| {
            let content = std::fs::read_to_string(path).ok()?;
            content.lines().rev().find_map(|line| {
                let line = line.trim();
                let line = line.strip_prefix("export ").unwrap_or(line);
                let (key, value) = line.split_once('=')?;
                (key.trim() == "COMPOSE_PROJECT_NAME").then(|| dotenv_value(value.trim()))
            })
        })
        .filter(|name| !name.is_empty())
}

fn dotenv_value(value: &str) -> String {
    for quote in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(quote) {
            return inner.split(quote).next().unwrap_or("").to_owned();
        }
    }
    value.split(" #").next().unwrap_or("").trim().to_owned()
}

/// Top-level `name` of a compose file. `None` when the file can't be read or parsed.
fn compose_file_name(path: &Path) -> Option<Option<String>> {
    let content = std::fs::read_to_string(path).ok()?;
    let document: serde_norway::Value = serde_norway::from_str(&content).ok()?;
    match document.get("name") {
        None | Some(serde_norway::Value::Null) => Some(None),
        Some(serde_norway::Value::String(name)) => Some(Some(name.clone())),
        Some(_) => None,
    }
}

async fn compose_output(project: &Project, args: &[&str]) -> Result<Output> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    process::capture(compose_command(project, &args), None).await
}

fn command_failure(output: &Output, description: &str) -> String {
    output.detail().map_or_else(|| format!("{description} exited with code {}", output.code), str::to_owned)
}

/// Resolved compose configuration; `Ok(None)` when the project has no compose file.
pub async fn read_config(project: &Project) -> Result<Option<ComposeConfig>, String> {
    if !has_compose_file(project) {
        return Ok(None);
    }
    let output = compose_output(project, &["config"]).await.map_err(|error| error.message)?;
    if output.code != 0 {
        return Err(command_failure(&output, &format!("{PODMAN_COMPOSE} config")));
    }
    ComposeConfig::parse(&output.stdout).map(Some)
}

/// Service names from `podman-compose config --services`; `Ok(None)` without a compose file.
pub async fn list_services(project: &Project) -> Result<Option<Vec<String>>, String> {
    if !has_compose_file(project) {
        return Ok(None);
    }
    let output = compose_output(project, &["config", "--services"]).await.map_err(|error| error.message)?;
    if output.code != 0 {
        return Err(command_failure(&output, &format!("{PODMAN_COMPOSE} config --services")));
    }
    Ok(Some(output.stdout.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect()))
}

/// All compose-managed containers, optionally limited to one compose working directory.
pub async fn list_containers(working_dir: Option<&str>) -> Result<Vec<Container>> {
    let mut args = vec!["ps".to_owned(), "-a".to_owned(), "--format".to_owned(), "json".to_owned()];
    args.extend(["--filter".to_owned(), format!("label={PROJECT_LABEL}")]);
    if let Some(dir) = working_dir {
        args.extend(["--filter".to_owned(), format!("label={WORKING_DIR_LABEL}={dir}")]);
    }

    let output = process::capture(process::command(PODMAN, args, None), None).await?;
    if output.code != 0 {
        return Err(Error::failure(command_failure(&output, &format!("{PODMAN} ps"))));
    }
    parse_containers(&output.stdout).map_err(Error::failure)
}

/// A project's containers taken from a shared listing. Falls back to `podman-compose ps` when
/// the compose project name can't be derived statically.
pub async fn project_containers_in(project: &Project, listing: &[Container]) -> Result<Vec<Container>, String> {
    if !has_compose_file(project) {
        return Ok(Vec::new());
    }
    let location = locate(project)?;
    let Some(name) = &location.project_name else { return compose_ps(project).await };
    let containers = select_project_containers(listing, &location.dir, name);
    // Containers in the directory under another name: let podman-compose decide what's ours.
    let foreign = containers.is_empty()
        && listing
            .iter()
            .any(|container| container.working_dir_label == location.dir && container.project_label != *name);
    if foreign { compose_ps(project).await } else { Ok(containers) }
}

/// Containers of a single project.
pub async fn project_containers(project: &Project) -> Result<Vec<Container>, String> {
    if !has_compose_file(project) {
        return Ok(Vec::new());
    }
    let location = locate(project)?;
    if location.project_name.is_none() {
        return compose_ps(project).await;
    }
    let listing = list_containers(Some(&location.dir)).await.map_err(|error| error.message)?;
    project_containers_in(project, &listing).await
}

async fn compose_ps(project: &Project) -> Result<Vec<Container>, String> {
    let output = compose_output(project, &["ps", "--format", "json"]).await.map_err(|error| error.message)?;
    if output.code != 0 {
        return Err(command_failure(&output, &format!("{PODMAN_COMPOSE} ps")));
    }
    parse_containers(&output.stdout)
}

/// Summaries for all projects from a single `podman ps` call.
pub async fn summarize_projects(projects: &[Project], detailed: bool) -> Vec<StateSummary> {
    let listing = list_containers(None).await;
    join_all(projects.iter().map(|project| async {
        let Ok(listing) = &listing else { return StateSummary::invalid() };
        if locate(project).is_err() {
            return StateSummary::invalid();
        }
        match project_containers_in(project, listing).await {
            Ok(containers) => summarize(&containers.iter().collect::<Vec<_>>(), detailed),
            Err(_) => StateSummary::invalid(),
        }
    }))
    .await
}

#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub build: bool,
    /// Overrides the project's Git pull setting.
    pub git: Option<bool>,
    pub no_cache: bool,
    pub up_args: Vec<String>,
    pub detached: bool,
    pub track_health: bool,
}

pub async fn start(ctx: &Context, project: &Project, options: &StartOptions) -> Result<()> {
    if options.git.unwrap_or(project.git) {
        git::pull(ctx, project).await?;
    }

    let run_options = RunOptions { detached: options.detached, track_health: options.track_health };
    let mut up_args = vec!["up".to_owned(), "-d".to_owned()];
    if options.build {
        let mut build_args = vec!["build".to_owned()];
        if options.no_cache {
            build_args.push("--no-cache".to_owned());
        }
        run(ctx, project, build_args, run_options).await?;
        up_args.push("--force-recreate".to_owned());
    }
    up_args.extend(options.up_args.iter().cloned());
    run(ctx, project, up_args, run_options).await
}

pub async fn stop(ctx: &Context, project: &Project, down_args: &[String], detached: bool) -> Result<()> {
    let args = STOP_ARGS.iter().map(|arg| (*arg).to_owned()).chain(down_args.iter().cloned()).collect();
    run(ctx, project, args, RunOptions { detached, track_health: true }).await
}

pub async fn restart(ctx: &Context, project: &Project, options: &StartOptions) -> Result<()> {
    if options.git.unwrap_or(project.git) {
        git::pull(ctx, project).await?;
    }
    stop(ctx, project, &[], options.detached).await?;
    start(ctx, project, &StartOptions { git: Some(false), ..options.clone() }).await
}

pub async fn remove_artifacts(ctx: &Context, project: &Project) -> Result<()> {
    if !has_compose_file(project) {
        return Ok(());
    }
    let args = ["down", "--volumes", "--rmi", "all", "--remove-orphans"].map(str::to_owned).to_vec();
    run(ctx, project, args, RunOptions { detached: false, track_health: true }).await
}

#[derive(Debug, Clone, Copy)]
struct RunOptions {
    detached: bool,
    track_health: bool,
}

/// Runs a compose operation with progress output, health tracking and the `x-pm3` startup
/// policy. Startups that can never succeed are rolled back with `down`.
async fn run(ctx: &Context, project: &Project, args: Vec<String>, options: RunOptions) -> Result<()> {
    let operation = Operation::from_args(&args);
    let starting = operation == Operation::Starting;
    let with_progress = options.track_health && !options.detached && operation != Operation::Building;
    let config = if has_compose_file(project) && (starting || with_progress) {
        match read_config(project).await {
            Ok(config) => config,
            Err(message) if starting => {
                return Err(Error::input(format!("Failed to inspect compose images for {}: {message}", project.name)));
            }
            Err(_) => None,
        }
    } else {
        None
    };

    if let (true, Some(config)) = (starting, &config) {
        pull_missing_images(ctx, project, config).await?;
    }

    let abort_on_unhealthy = options.track_health && starting;
    let mut tracker = match (&config, abort_on_unhealthy) {
        (Some(config), true) => config.startup(&project.name).map_err(Error::input)?.map(StartupTracker::new),
        _ => None,
    };
    let fail_on_unhealthy = abort_on_unhealthy && tracker.is_none();
    let progress =
        config.as_ref().filter(|config| with_progress && !config.services.is_empty()).map(|config| ProgressSetup {
            services: config.service_names(),
            health_waits: if starting {
                config
                    .services
                    .iter()
                    .filter_map(|service| Some((service.name.clone(), service.health_wait?)))
                    .collect()
            } else {
                HashMap::new()
            },
        });

    let execution = execute(
        ctx,
        project,
        operation,
        &args,
        ExecuteOptions {
            detached: options.detached,
            progress,
            tracker: tracker.as_mut(),
            abort_on_unhealthy,
            cancellable: true,
        },
    )
    .await?;
    if execution.detached {
        return Ok(());
    }

    let stop_services = config.as_ref().map(ComposeConfig::service_names);
    if let Some(reason) = tracker.as_ref().and_then(StartupTracker::abort_reason) {
        stop_started(ctx, project, stop_services, options.detached).await?;
        return Err(Error::failure(reason));
    }
    if fail_on_unhealthy && !execution.unhealthy.is_empty() {
        stop_started(ctx, project, stop_services, options.detached).await?;
        let services: Vec<String> =
            execution.unhealthy.iter().map(|service| format!("{}/{service}", project.name)).collect();
        return Err(Error::failure(format!("Unhealthy services: {}", services.join(", "))));
    }
    if ctx.cancel.is_cancelled() {
        if starting && execution.code != 0 {
            stop_started(ctx, project, stop_services, options.detached).await?;
        }
        return Err(Error::failure("Interrupted"));
    }
    if execution.code != 0 {
        if !execution.unhealthy.is_empty() {
            return Ok(());
        }
        return Err(Error::failure(execution.failure_message()));
    }

    let warnings = execution.warnings();
    if warnings > execution.notices {
        print_line(&format!("Finished with {warnings} warnings"));
    }
    Ok(())
}

async fn stop_started(ctx: &Context, project: &Project, services: Option<Vec<String>>, detached: bool) -> Result<()> {
    let args: Vec<String> = STOP_ARGS.iter().map(|arg| (*arg).to_owned()).collect();
    let progress = services
        .filter(|services| !services.is_empty())
        .map(|services| ProgressSetup { services, health_waits: HashMap::new() });
    let options = ExecuteOptions { detached, progress, tracker: None, abort_on_unhealthy: false, cancellable: false };
    let execution = execute(ctx, project, Operation::Stopping, &args, options).await?;
    if !execution.detached && execution.code != 0 {
        return Err(Error::failure(execution.failure_message()));
    }
    Ok(())
}

async fn pull_missing_images(ctx: &Context, project: &Project, config: &ComposeConfig) -> Result<()> {
    let cwd = Some(Path::new(&project.working_dir));
    for image in config.pullable_short_images() {
        let exists = process::capture(process::command(PODMAN, ["image", "exists", image], cwd), None).await?;
        if exists.code == 0 {
            continue;
        }

        let pull = process::command(PODMAN, ["pull", image], cwd);
        let output = if all_streams_are_terminals() {
            process::run_interactive(pull, Some(&ctx.cancel)).await?
        } else {
            process::run_echoed(pull, Some(&ctx.cancel)).await?
        };
        ctx.ensure_active()?;
        if output.code != 0 {
            return Err(Error::failure(match output.detail() {
                Some(detail) => format!("Failed to pull compose image {image}: {detail}"),
                None => format!("Failed to pull compose image {image} ({PODMAN} exited with code {})", output.code),
            }));
        }
    }
    Ok(())
}

struct ProgressSetup {
    services: Vec<String>,
    health_waits: HashMap<String, Duration>,
}

struct ExecuteOptions<'a> {
    detached: bool,
    progress: Option<ProgressSetup>,
    tracker: Option<&'a mut StartupTracker>,
    abort_on_unhealthy: bool,
    cancellable: bool,
}

struct Execution {
    code: i32,
    detached: bool,
    stdout: OutputTail,
    stderr: OutputTail,
    /// podman-compose debug logging was enabled by pm3 to follow per-service progress.
    debug_logging: bool,
    unhealthy: Vec<String>,
    notices: usize,
}

impl Execution {
    fn relevant_lines<'a>(&'a self, tail: &'a OutputTail) -> impl Iterator<Item = &'a str> {
        tail.lines().filter(move |line| !(self.debug_logging && is_debug_log_line(line)))
    }

    fn failure_message(&self) -> String {
        let text = |tail| self.relevant_lines(tail).collect::<Vec<_>>().join("\n").trim().to_owned();
        [text(&self.stderr), text(&self.stdout)]
            .into_iter()
            .find(|text| !text.is_empty())
            .unwrap_or_else(|| format!("{PODMAN_COMPOSE} failed"))
    }

    fn warnings(&self) -> usize {
        self.relevant_lines(&self.stdout)
            .chain(self.relevant_lines(&self.stderr))
            .filter(|line| has_warning_word(line))
            .count()
    }
}

fn is_debug_log_line(line: &str) -> bool {
    line.starts_with("DEBUG:podman_compose:") || line.starts_with("INFO:podman_compose:")
}

fn events_command(working_dir: &str) -> Command {
    let args = [
        "events".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
        "--filter".to_owned(),
        "type=container".to_owned(),
        "--filter".to_owned(),
        format!("label={WORKING_DIR_LABEL}={working_dir}"),
        "--since".to_owned(),
        time::now_iso(),
    ];
    process::command(PODMAN, args, None)
}

/// Feeds a podman event into progress and the startup policy. Returns whether the running
/// compose command should be aborted.
fn apply_event(
    progress: &mut Progress,
    tracker: Option<&mut StartupTracker>,
    line: &str,
    loader: &Loader,
    abort_on_unhealthy: bool,
) -> bool {
    let Some(effect) = PodmanEvent::parse(line).and_then(|event| progress.on_event(&event, loader)) else {
        return false;
    };
    let mut abort = abort_on_unhealthy && effect.health_change == Some(HealthStatus::Degraded);
    if let Some(tracker) = tracker {
        if let Some(status) = effect.service_status {
            tracker.record_service(&effect.service, status);
        }
        if let Some(health) = effect.health_change {
            tracker.record_health(&effect.service, health);
        }
        abort |= tracker.abort_reason().is_some();
    }
    abort
}

async fn next_event(events: &mut Option<LineStream>) -> Option<String> {
    match events {
        Some(events) => events.next_line().await,
        None => std::future::pending().await,
    }
}

/// Runs one podman-compose command while following container events for progress output.
async fn execute(
    ctx: &Context,
    project: &Project,
    operation: Operation,
    args: &[String],
    mut options: ExecuteOptions<'_>,
) -> Result<Execution> {
    if options.detached {
        process::spawn_detached(compose_command(project, args))?;
        return Ok(Execution {
            code: 0,
            detached: true,
            stdout: OutputTail::default(),
            stderr: OutputTail::default(),
            debug_logging: false,
            unhealthy: Vec::new(),
            notices: 0,
        });
    }

    let loader = Loader::start(format!("{} {}", operation.label(), project.name), !ctx.verbose);
    let location = options.progress.as_ref().and_then(|_| locate(project).ok());
    let mut events = match &location {
        Some(location) => Some(LineStream::spawn(events_command(&location.dir))?),
        None => None,
    };
    let mut progress = match (options.progress.take(), &events) {
        (Some(setup), Some(_)) => {
            Some(Progress::new(&project.name, operation, setup.services, setup.health_waits, &loader))
        }
        _ => None,
    };
    let debug_logging = progress.is_some() && !ctx.verbose;

    let mut compose_args = Vec::with_capacity(args.len() + 1);
    if debug_logging {
        compose_args.push(VERBOSE_FLAG.to_owned());
    }
    compose_args.extend(args.iter().cloned());
    let mut command = compose_command(project, &compose_args);
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = process::spawn(&mut command)?;
    let mut stdout_lines = child.stdout.take().map(LineReader::new);
    let mut stderr_lines = child.stderr.take().map(LineReader::new);

    let mut stdout = OutputTail::default();
    let mut stderr = OutputTail::default();
    let mut status = None;
    let mut terminated = false;
    let abort_on_unhealthy = options.abort_on_unhealthy;
    let drain_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(drain_deadline);

    while status.is_none() || stdout_lines.is_some() || stderr_lines.is_some() {
        tokio::select! {
            line = async { stdout_lines.as_mut()?.next_line().await }, if stdout_lines.is_some() => match line {
                Some(line) => {
                    if ctx.verbose {
                        print_line(&line);
                    } else if let Some(progress) = progress.as_mut() {
                        progress.on_compose_line(&line, &loader);
                    }
                    stdout.push_line(&line);
                }
                None => stdout_lines = None,
            },
            line = async { stderr_lines.as_mut()?.next_line().await }, if stderr_lines.is_some() => match line {
                Some(line) => {
                    if ctx.verbose {
                        eprint_line(&line);
                    } else if let Some(progress) = progress.as_mut() {
                        progress.on_compose_line(&line, &loader);
                    }
                    stderr.push_line(&line);
                }
                None => stderr_lines = None,
            },
            exit = child.wait(), if status.is_none() => {
                status = Some(process::exit_code(exit?));
                drain_deadline.as_mut().reset((Instant::now() + process::DRAIN_GRACE).into());
            }
            () = &mut drain_deadline, if status.is_some() => break,
            line = next_event(&mut events), if events.is_some() => match (line, progress.as_mut()) {
                (Some(line), Some(progress)) => {
                    let abort = apply_event(progress, options.tracker.as_deref_mut(), &line, &loader, abort_on_unhealthy);
                    if abort && !terminated {
                        terminated = true;
                        process::terminate(&child);
                    }
                }
                (Some(_), None) => {}
                (None, _) => events = None,
            },
            () = ctx.cancel.cancelled(), if options.cancellable && !terminated => {
                terminated = true;
                process::terminate(&child);
            },
        }
    }

    let interrupted = options.cancellable && ctx.cancel.is_cancelled();
    if let (Some(progress), false, Some(0)) = (progress.as_mut(), operation.tracks_health(), status) {
        let containers = project_containers(project).await.unwrap_or_default();
        progress.complete(&containers, &loader);
    }
    if let (Some(progress), true, false) = (progress.as_mut(), operation.tracks_health(), interrupted) {
        let containers = project_containers(project).await.unwrap_or_default();
        progress.seed(&containers, &loader);
        'settle: loop {
            progress.expire(Instant::now(), &loader);
            let Some(deadline) = progress.next_deadline() else { break };
            let wake = deadline.min(Instant::now() + HEALTH_POLL_INTERVAL);
            loop {
                tokio::select! {
                    () = tokio::time::sleep_until(wake.into()) => break,
                    line = next_event(&mut events), if events.is_some() => match line {
                        Some(line) => {
                            apply_event(progress, options.tracker.as_deref_mut(), &line, &loader, abort_on_unhealthy);
                            if !progress.has_pending_health() {
                                break 'settle;
                            }
                        }
                        None => events = None,
                    },
                    () = ctx.cancel.cancelled(), if options.cancellable => break 'settle,
                }
            }
            let containers = project_containers(project).await.unwrap_or_default();
            progress.reconcile(&containers, &loader);
        }
        progress.expire_all(&loader);
    }

    if let Some(mut stream) = events.take() {
        let grace = tokio::time::sleep(EVENT_GRACE);
        tokio::pin!(grace);
        loop {
            tokio::select! {
                () = &mut grace => break,
                line = stream.next_line() => match (line, progress.as_mut()) {
                    (Some(line), Some(progress)) => {
                        apply_event(progress, options.tracker.as_deref_mut(), &line, &loader, abort_on_unhealthy);
                    }
                    (Some(_), None) => {}
                    (None, _) => break,
                },
            }
        }
        stream.stop().await;
    }
    loader.stop();

    let unhealthy = progress.as_ref().map(|progress| progress.unhealthy().to_vec()).unwrap_or_default();
    let notices = progress.as_ref().map_or(0, Progress::notices);
    Ok(Execution { code: status.unwrap_or(1), detached: false, stdout, stderr, debug_logging, unhealthy, notices })
}

/// Resolves a user-supplied path to an absolute, lexically normalized path.
pub fn absolute_path(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    let base = if path.is_absolute() { PathBuf::new() } else { std::env::current_dir()? };
    let mut resolved = PathBuf::from("/");
    for component in base.join(path).components() {
        match component {
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::Normal(part) => resolved.push(part),
            std::path::Component::RootDir | std::path::Component::CurDir | std::path::Component::Prefix(_) => {}
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn applies_compose_arguments_before_the_subcommand() {
        let project = Project {
            id: 1,
            name: "api".to_owned(),
            working_dir: "/project".to_owned(),
            enabled: false,
            git: false,
            compose_args: strings(&["-f", "compose.prod.yaml", "--profile", "production"]),
        };
        assert_eq!(
            compose_args(&project, &strings(&["up", "-d"])),
            ["-f", "compose.prod.yaml", "--profile", "production", "up", "-d"]
        );
    }

    #[test]
    fn parses_global_compose_arguments() {
        let parsed = parse_global_compose_args(&strings(&[
            "-f",
            "a.yaml",
            "--file=b.yaml",
            "-fc.yaml",
            "--profile",
            "x",
            "-p",
            "web",
            "--env-file",
            "prod.env",
        ]));
        assert_eq!(parsed.files, ["a.yaml", "b.yaml", "c.yaml"]);
        assert_eq!(parsed.project_name.as_deref(), Some("web"));
        assert_eq!(parsed.env_file.as_deref(), Some("prod.env"));
        assert_eq!(parse_global_compose_args(&strings(&["--project-name=api"])).project_name.as_deref(), Some("api"));
        let parsed = parse_global_compose_args(&strings(&[
            "--podman-run-args",
            "-p 8080:80",
            "--verbose",
            "-pweb",
            "--in-pod=false",
        ]));
        assert_eq!(parsed.project_name.as_deref(), Some("web"));
        assert!(parsed.files.is_empty());
    }

    #[test]
    fn parses_dotenv_values() {
        assert_eq!(dotenv_value("plain # comment"), "plain");
        assert_eq!(dotenv_value("\"quoted # kept\" # comment"), "quoted # kept");
        assert_eq!(dotenv_value("'single'"), "single");
    }

    #[test]
    fn resolves_project_names_like_podman_compose() {
        let root = std::env::temp_dir().join(format!("pm3-locate-{}", std::process::id()));
        let dir = root.join("My App");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("compose.yaml"), "services: {}\n").unwrap();
        std::fs::write(dir.join("sub/named.yaml"), "name: Named-Stack_1\nservices: {}\n").unwrap();
        let project = |args: &[&str]| Project {
            id: 1,
            name: "p".to_owned(),
            working_dir: dir.to_string_lossy().into_owned(),
            enabled: false,
            git: false,
            compose_args: strings(args),
        };
        let canonical = std::fs::canonicalize(&dir).unwrap().to_string_lossy().into_owned();

        let location = locate(&project(&[])).unwrap();
        assert_eq!(location, Location { dir: canonical.clone(), project_name: Some("myapp".to_owned()) });

        let location = locate(&project(&["-f", "sub/named.yaml"])).unwrap();
        assert_eq!(location.dir, format!("{canonical}/sub"));
        assert_eq!(location.project_name.as_deref(), Some("amed-tack_1"));

        assert_eq!(locate(&project(&["-p", "Explicit"])).unwrap().project_name.as_deref(), Some("Explicit"));

        std::fs::write(dir.join(".env"), "export COMPOSE_PROJECT_NAME=from-env # comment\n").unwrap();
        assert_eq!(locate(&project(&[])).unwrap().project_name.as_deref(), Some("from-env"));
        std::fs::write(dir.join(".env"), "COMPOSE_PROJECT_NAME=${OTHER}\n").unwrap();
        assert_eq!(locate(&project(&[])).unwrap().project_name, None);

        assert_eq!(locate(&project(&["-f", "missing.yaml"])).unwrap_err(), "Missing compose files: missing.yaml");
        std::fs::remove_dir_all(&root).unwrap();
        assert!(locate(&project(&[])).unwrap_err().starts_with("Working directory not found"));
    }
}
