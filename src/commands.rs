use std::io::{BufRead, Write};
use std::path::Path;

use futures_util::future::join_all;
use rusqlite::Connection;

use crate::Context;
use crate::cli::{Command, LifecycleCommand};
use crate::compose::containers::{Container, INVALID_STATE, StateSummary, compare_names, summarize};
use crate::compose::{self, StartOptions};
use crate::daemon::{self, ipc::Notifier};
use crate::db::{self, NewProject, Project};
use crate::error::{Error, Result};
use crate::lifecycle::{self, LifecycleOperation, LifecycleRequest};
use crate::term::{Loader, format_table, green, orange, print_line, red, split_padding, underline, yellow};
use crate::{git, logs, process};

pub async fn run(ctx: &Context, command: Command, yes: bool) -> Result<()> {
    if command == Command::Help {
        print_line(&crate::cli::help_text());
        return Ok(());
    }

    let database_path = db::resolve_path()?;
    let connection = db::open(&database_path)?;
    let targets = Targets { connection: &connection, yes };

    match command {
        Command::Help => Ok(()),
        Command::Create { workdir, name, git, compose_args } => {
            create(ctx, &connection, &workdir, name, git, &compose_args).await
        }
        Command::Enable { name, now } => toggle(ctx, &targets, "enable", name.as_deref(), true, now).await,
        Command::Disable { name, now } => toggle(ctx, &targets, "disable", name.as_deref(), false, now).await,
        Command::Git { enable, name } => set_git(ctx, &targets, enable, name.as_deref()).await,
        Command::Lifecycle(command) => run_lifecycle(ctx, &targets, command).await,
        Command::Logs { name, options } => {
            let Some(projects) = targets.resolve(ctx, "logs", name.as_deref(), not_found).await? else { return Ok(()) };
            logs::show(ctx, &projects, &options).await
        }
        Command::List { detailed } => list(&connection, detailed).await,
        Command::View { name } => view(ctx, &targets, name.as_deref()).await,
        Command::Remove { name, force } => remove(ctx, &targets, name.as_deref(), force).await,
        Command::Daemon => {
            drop(connection);
            daemon::run(ctx, database_path).await
        }
    }
}

fn not_found(name: &str) -> String {
    format!("Project not found: {name}")
}

/// Resolves the projects a command applies to: the named one, or all after confirmation.
struct Targets<'a> {
    connection: &'a Connection,
    yes: bool,
}

impl Targets<'_> {
    async fn resolve(
        &self,
        ctx: &Context,
        command: &str,
        name: Option<&str>,
        missing: fn(&str) -> String,
    ) -> Result<Option<Vec<Project>>> {
        if let Some(name) = name {
            return match db::project_by_name(self.connection, name)? {
                Some(project) => Ok(Some(vec![project])),
                None => Err(Error::input(missing(name))),
            };
        }

        let projects = db::list_projects(self.connection)?;
        if projects.is_empty() {
            return Err(Error::input("No projects registered."));
        }
        if !self.yes {
            let question = format!("Are you sure to execute '{command}' on {} projects? [Y/n]", projects.len());
            if !confirm(ctx, &question).await? {
                print_line("Aborted");
                return Ok(None);
            }
        }
        Ok(Some(projects))
    }
}

/// Asks a yes/no question on stdin; only `y`/`Y` confirms. Interrupts are honored while waiting.
async fn confirm(ctx: &Context, question: &str) -> Result<bool> {
    let mut stdout = std::io::stdout().lock();
    let _ = write!(stdout, "{question} ").and_then(|()| stdout.flush());
    drop(stdout);

    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut answer = String::new();
        let confirmed = match std::io::stdin().lock().read_line(&mut answer) {
            Ok(0) | Err(_) => false,
            Ok(_) => matches!(answer.trim_end_matches(['\n', '\r']), "y" | "Y"),
        };
        let _ = sender.send(confirmed);
    });

    tokio::select! {
        confirmed = receiver => Ok(confirmed.unwrap_or(false)),
        () = ctx.cancel.cancelled() => Err(Error::failure("Interrupted")),
    }
}

async fn create(
    ctx: &Context,
    connection: &Connection,
    workdir: &str,
    name: Option<String>,
    git: Option<bool>,
    compose_args: &[String],
) -> Result<()> {
    let working_dir = compose::absolute_path(workdir)?;
    let working_dir = working_dir.to_string_lossy().into_owned();
    let name = name.unwrap_or_else(|| {
        Path::new(&working_dir).file_name().map_or_else(String::new, |name| name.to_string_lossy().into_owned())
    });
    let project = NewProject { name: &name, working_dir: &working_dir, compose_args, git: git.unwrap_or(false) };

    if git == Some(true) {
        let candidate = Project {
            id: 0,
            name: name.clone(),
            working_dir: working_dir.clone(),
            enabled: false,
            git: true,
            compose_args: compose_args.to_vec(),
        };
        git::require_repository(ctx, &candidate).await?;
    }

    db::add_project(connection, &project)?;
    print_line(&format!("Created {name} with compose arguments `{}`", compose_args.join(" ")));
    print_line(&format!("Start with `pm3 start {name}`"));
    Ok(())
}

async fn toggle(
    ctx: &Context,
    targets: &Targets<'_>,
    command: &str,
    name: Option<&str>,
    enable: bool,
    now: bool,
) -> Result<()> {
    let Some(projects) = targets.resolve(ctx, command, name, not_found).await? else { return Ok(()) };
    let mut notifier = if now { Notifier::connect().await } else { Notifier::Disabled };

    for project in &projects {
        ctx.ensure_active()?;
        db::set_project_enabled(targets.connection, project.id, enable)?;
        print_line(&format!("{} {}", if enable { "Enabled" } else { "Disabled" }, project.name));

        if now {
            let operation = if enable { LifecycleOperation::Start } else { LifecycleOperation::Stop };
            let request = LifecycleRequest {
                operation,
                start: StartOptions { track_health: true, ..StartOptions::default() },
                down_args: Vec::new(),
            };
            lifecycle::run(ctx, project, &request, &mut notifier).await?;
        }
    }
    Ok(())
}

async fn set_git(ctx: &Context, targets: &Targets<'_>, enable: bool, name: Option<&str>) -> Result<()> {
    let Some(projects) = targets.resolve(ctx, "git", name, not_found).await? else { return Ok(()) };
    if enable {
        for project in &projects {
            git::require_repository(ctx, project).await?;
        }
    }
    for project in &projects {
        db::set_project_git(targets.connection, project.id, enable)?;
        print_line(&format!("Git pulling {} for {}", if enable { "enabled" } else { "disabled" }, project.name));
    }
    Ok(())
}

async fn run_lifecycle(ctx: &Context, targets: &Targets<'_>, command: LifecycleCommand) -> Result<()> {
    let Some(projects) = targets.resolve(ctx, command.operation.as_str(), command.name.as_deref(), not_found).await?
    else {
        return Ok(());
    };

    if command.detach {
        for project in &projects {
            launch_detached(ctx, &command, &project.name)?;
        }
        return Ok(());
    }

    // Pull every Git project first, so a failed pull aborts before anything restarts.
    let bulk_pull = command.name.is_none() && command.operation != LifecycleOperation::Stop && projects.len() > 1;
    let mut git = command.git;
    if bulk_pull {
        let git_projects: Vec<&Project> =
            projects.iter().filter(|project| command.git.unwrap_or(project.git)).collect();
        for project in &git_projects {
            ctx.ensure_active()?;
            git::pull(ctx, project).await?;
        }
        if !git_projects.is_empty() {
            git = Some(false);
        }
    }

    let is_start = command.operation == LifecycleOperation::Start;
    let request = LifecycleRequest {
        operation: command.operation,
        start: StartOptions {
            build: command.build,
            git,
            no_cache: command.no_cache,
            up_args: if is_start { command.operation_args.clone() } else { Vec::new() },
            detached: false,
            track_health: true,
        },
        down_args: if is_start { Vec::new() } else { command.operation_args.clone() },
    };
    let mut notifier = Notifier::connect().await;
    for project in &projects {
        ctx.ensure_active()?;
        lifecycle::run(ctx, project, &request, &mut notifier).await?;
    }
    Ok(())
}

/// Re-runs the lifecycle command for one project in a detached background process.
fn launch_detached(ctx: &Context, command: &LifecycleCommand, name: &str) -> Result<()> {
    let mut args: Vec<String> = Vec::new();
    if ctx.verbose {
        args.push("--verbose".to_owned());
    }
    args.push(command.operation.as_str().to_owned());
    match command.operation {
        LifecycleOperation::Start if command.build => args.push("--build".to_owned()),
        LifecycleOperation::Restart if !command.build => args.push("--no-build".to_owned()),
        _ => {}
    }
    match command.git {
        Some(true) => args.push("--git".to_owned()),
        Some(false) => args.push("--local".to_owned()),
        None => {}
    }
    if command.no_cache {
        args.push("--no-cache".to_owned());
    }
    args.push(name.to_owned());
    if !command.operation_args.is_empty() {
        args.push("--".to_owned());
        args.extend(command.operation_args.iter().cloned());
    }

    let executable = std::env::current_exe()?;
    process::spawn_detached(process::command(&executable.to_string_lossy(), args, None))
}

async fn list(connection: &Connection, detailed: bool) -> Result<()> {
    let projects = db::list_projects(connection)?;
    let summaries = compose::summarize_projects(&projects, detailed).await;

    let mut rows: Vec<Vec<String>> = Vec::with_capacity(projects.len() + 1);
    if detailed {
        rows.push(["NAME", "STATE", "STARTUP", "CREATED", "PORTS"].map(str::to_owned).to_vec());
    } else {
        rows.push(["NAME", "STATE"].map(str::to_owned).to_vec());
    }
    for (project, summary) in projects.iter().zip(summaries) {
        if detailed {
            rows.push(vec![
                project.name.clone(),
                summary.state,
                startup(project).to_owned(),
                summary.created,
                summary.ports,
            ]);
        } else {
            rows.push(vec![project.name.clone(), summary.state]);
        }
    }

    print_line(&format_table(&rows, format_list_cell));
    Ok(())
}

pub fn startup(project: &Project) -> &'static str {
    if project.enabled { "enabled" } else { "disabled" }
}

/// Leading state keyword of a state cell such as `up (5m)`.
fn state_keyword(value: &str) -> Option<&str> {
    let keyword = value.split_whitespace().next()?;
    ["degraded", "down", INVALID_STATE, "starting", "stopping", "up"].into_iter().find(|state| *state == keyword)
}

fn paint_state(state: &str, text: &str) -> Option<String> {
    Some(match state_keyword(state)? {
        "down" => orange(text),
        "degraded" | "invalid" => red(text),
        "starting" | "stopping" => yellow(text),
        _ => green(text),
    })
}

fn format_list_cell(header: &str, value: &str) -> String {
    let (content, padding) = split_padding(value);
    let painted = match header {
        "STATE" => paint_state(content, content),
        "STARTUP" => match content {
            "enabled" => Some(green(content)),
            "disabled" => Some(red(content)),
            _ => None,
        },
        _ => None,
    };
    painted.map_or_else(|| value.to_owned(), |painted| format!("{painted}{padding}"))
}

async fn view(ctx: &Context, targets: &Targets<'_>, name: Option<&str>) -> Result<()> {
    let label = name.map_or_else(|| "Loading project details".to_owned(), |name| format!("Loading {name}"));
    let loader = Loader::start(label, !ctx.verbose && (name.is_some() || targets.yes));
    let Some(projects) = targets.resolve(ctx, "view", name, not_found).await? else { return Ok(()) };

    let rendered = join_all(projects.iter().map(|project| async move {
        let containers = async {
            compose::locate(project)?;
            compose::project_containers(project).await
        };
        let (containers, services) = tokio::join!(containers, compose::list_services(project));
        render_project(project, containers, services)
    }))
    .await;
    loader.stop();
    print_line(&rendered.join("\n\n"));
    Ok(())
}

fn render_project(
    project: &Project,
    containers: Result<Vec<Container>, String>,
    services: Result<Option<Vec<String>>, String>,
) -> String {
    let mut errors = Vec::new();
    let state_known = containers.is_ok();
    let containers = containers.unwrap_or_else(|error| {
        errors.push(format!("Failed to inspect containers: {error}"));
        Vec::new()
    });
    let services = services.unwrap_or_else(|error| {
        errors.push(format!("Failed to list compose services: {error}"));
        None
    });

    let mut names: Vec<&str> = services.iter().flatten().map(String::as_str).collect();
    for container in &containers {
        if !container.service.is_empty() && !names.contains(&container.service.as_str()) {
            names.push(&container.service);
        }
    }
    names.sort_by(|left, right| compare_names(left, right));

    let all: Vec<&Container> = containers.iter().collect();
    let mut summary = summarize(&all, true);
    if !errors.is_empty() {
        INVALID_STATE.clone_into(&mut summary.state);
    }

    let created = if summary.created.is_empty() { String::new() } else { format!(" ({})", summary.created) };
    let mut lines = vec![
        format!("{} {} - {}{created}", state_dot(&summary.state), project.name, paint_state_value(&summary.state)),
        format!("    Startup: {}", format_list_cell("STARTUP", startup(project))),
        format!("    Workdir: {}", underline(&project.working_dir)),
        format!(
            "    Creation args: {}",
            if project.compose_args.is_empty() { "-".to_owned() } else { underline(&project.compose_args.join(" ")) }
        ),
    ];
    if !errors.is_empty() {
        lines.push("    Errors:".to_owned());
        for error in &errors {
            let mut error_lines = error.lines();
            lines.push(format!("        - {}", red(error_lines.next().unwrap_or(""))));
            lines.extend(error_lines.map(|line| format!("          {}", red(line))));
        }
    }

    let mut blocks = vec![lines.join("\n")];
    for service in names {
        let state = if state_known {
            let service_containers: Vec<&Container> =
                containers.iter().filter(|container| container.service == service).collect();
            summarize(&service_containers, true)
        } else {
            StateSummary { state: "unknown".to_owned(), created: String::new(), ports: String::new() }
        };
        let ports = if state.ports.is_empty() { "-" } else { &state.ports };
        blocks.push(format!(
            "    {} {service} - {}\n        Published ports: {ports}",
            state_dot(&state.state),
            paint_state_value(&state.state)
        ));
    }
    blocks.join("\n\n")
}

fn paint_state_value(state: &str) -> String {
    paint_state(state, state).unwrap_or_else(|| state.to_owned())
}

fn state_dot(state: &str) -> String {
    paint_state(state, "●").unwrap_or_else(|| "●".to_owned())
}

async fn remove(ctx: &Context, targets: &Targets<'_>, name: Option<&str>, force: bool) -> Result<()> {
    let Some(projects) =
        targets.resolve(ctx, "remove", name, |name| format!("Failed to remove project: \"{name}\" not found")).await?
    else {
        return Ok(());
    };

    if !force {
        for project in &projects {
            if !Path::new(&project.working_dir).is_dir() {
                return Err(Error::input(format!(
                    "Project {} has invalid cwd '{}'\nRetry with `--force` to remove as is",
                    project.name, project.working_dir
                )));
            }
            let containers = compose::project_containers(project).await.map_err(Error::failure)?;
            if containers.iter().any(Container::is_running) {
                return Err(Error::input(format!("Failed to remove project: \"{}\" is running", project.name)));
            }
        }
    }

    for project in &projects {
        ctx.ensure_active()?;
        let removed = compose::remove_artifacts(ctx, project).await;
        if !force {
            removed?;
        }
        db::delete_project(targets.connection, project.id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> Project {
        Project {
            id: 1,
            name: "api".to_owned(),
            working_dir: "/project".to_owned(),
            enabled: true,
            git: false,
            compose_args: ["-f", "compose.prod.yaml", "--profile", "production"].map(str::to_owned).to_vec(),
        }
    }

    fn container(service: &str, state: &str, ports: &str) -> Container {
        Container {
            id: format!("{service}-id"),
            name: format!("api_{service}_1"),
            service: service.to_owned(),
            project_label: "api".to_owned(),
            working_dir_label: "/project".to_owned(),
            state: state.to_owned(),
            status: "Up".to_owned(),
            health: None,
            created_at: 1,
            started_at: 1,
            exited_at: 0,
            exit_code: 0,
            ports: ports.to_owned(),
        }
    }

    #[test]
    fn view_renders_project_and_service_details() {
        let containers = vec![container("web", "running", "127.0.0.1:8080->80/tcp")];
        let output = crate::term::strip_ansi(&render_project(
            &project(),
            Ok(containers),
            Ok(Some(vec!["web".to_owned(), "worker".to_owned()])),
        ));

        assert!(output.starts_with("● api - up"), "{output}");
        assert!(output.contains("    Startup: enabled"));
        assert!(output.contains("    Workdir: /project"));
        assert!(output.contains("    Creation args: -f compose.prod.yaml --profile production"));
        assert!(output.contains("\n\n    ● web - up"));
        assert!(output.contains("        Published ports: 127.0.0.1:8080->80/tcp"));
        assert!(output.contains("\n\n    ● worker - down\n        Published ports: -"));
    }

    #[test]
    fn view_renders_known_details_and_errors_for_an_invalid_project() {
        let output = crate::term::strip_ansi(&render_project(
            &project(),
            Err("could not parse broken.yaml".to_owned()),
            Err("services.web.image must be a string\nsecond line".to_owned()),
        ));

        assert!(output.starts_with("● api - invalid"), "{output}");
        assert!(output.contains("    Errors:\n        - Failed to inspect containers: could not parse broken.yaml"));
        assert!(output.contains(
            "        - Failed to list compose services: services.web.image must be a string\n          second line"
        ));
    }

    #[test]
    fn list_cells_color_state_keywords() {
        assert_eq!(format_list_cell("STATE", "up (5m)  "), format!("{}  ", green("up (5m)")));
        assert_eq!(format_list_cell("STATE", "invalid"), red("invalid"));
        assert_eq!(format_list_cell("STATE", "down"), orange("down"));
        assert_eq!(format_list_cell("STATE", "STATE"), "STATE");
        assert_eq!(format_list_cell("STARTUP", "disabled "), format!("{} ", red("disabled")));
        assert_eq!(format_list_cell("NAME", "web "), "web ");
    }
}
