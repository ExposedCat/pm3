mod api;
pub mod ipc;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::join_all;
use rusqlite::Connection;
use tokio::sync::mpsc;

use self::ipc::{DaemonMessage, IpcServer};
use crate::Context;
use crate::compose::containers::{Container, snapshot_services};
use crate::compose::events::{HealthStatus, PodmanEvent, ServiceStatus};
use crate::compose::startup::{ServiceState, StartupConfig};
use crate::compose::{self, PODMAN, StartOptions};
use crate::db::{self, Project, ServiceTable};
use crate::error::Result;
use crate::lifecycle::LifecycleOperation;
use crate::process::{self, LineStream};
use crate::term::{eprint_line, print_line};
use crate::time::now_iso;

const EVENTS_RESTART_DELAY: Duration = Duration::from_secs(1);

/// Runs the daemon: autostarts enabled projects, tracks service state and health from podman
/// events, runs hooks, enforces `x-pm3` policies and serves the local API.
pub async fn run(ctx: &Context, database_path: PathBuf) -> Result<()> {
    print_line("Starting PM3 Daemon...");
    // Claim the socket first, so a second instance exits before touching anything.
    let (messages, mut message_requests) = mpsc::unbounded_channel();
    let ipc = IpcServer::start(messages.clone()).await?;

    let connection = db::open(&database_path)?;
    let (hooks, hook_requests) = mpsc::unbounded_channel();
    let (controls, mut control_requests) = mpsc::unbounded_channel();
    let mut daemon = Daemon::load(ctx.clone(), connection, hooks, controls)?;
    let hook_runner = tokio::spawn(run_hooks(hook_requests));
    let api = api::ApiServer::start(ctx.clone(), database_path, messages).await?;
    // Follow events before taking the snapshot, so no transition in between is missed.
    let mut events = Some(spawn_events()?);

    let configs = join_all(daemon.projects.iter().map(load_watcher_config)).await;
    for (project, config) in daemon.projects.iter().zip(configs) {
        if let Some(config) = config {
            daemon.watchers.insert(project.name.clone(), config);
        }
    }

    let containers = daemon.snapshot().await;
    for project in daemon.projects.clone() {
        daemon.enforce_policy(&project);
    }

    // Without a container listing there's no telling which projects are down.
    let autostart: Vec<Project> = containers
        .map(|containers| {
            daemon
                .projects
                .iter()
                .filter(|project| {
                    project.enabled
                        && containers
                            .get(&project.name)
                            .is_some_and(|containers| containers.iter().all(Container::is_down))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    // Pending starts must not be judged by the stopped state left from the previous run.
    for project in &autostart {
        daemon.mark_all(project, ServiceStatus::Starting);
    }
    let autostart = tokio::spawn(start_projects(ctx.clone(), autostart, daemon.controls.clone()));

    loop {
        tokio::select! {
            message = message_requests.recv() => match message {
                Some(message) => daemon.handle_message(message),
                None => break,
            },
            line = next_event(&mut events) => match line {
                Some(line) => daemon.handle_event(&line),
                None => {
                    if let Some(stream) = events.take() {
                        stream.stop().await;
                        eprint_line("podman events stream ended; restarting");
                    }
                    tokio::time::sleep(EVENTS_RESTART_DELAY).await;
                    events = spawn_events().inspect_err(|error| eprint_line(&error.message)).ok();
                }
            },
            Some(control) = control_requests.recv() => daemon.handle_control(control),
            () = ctx.cancel.cancelled() => break,
        }
    }

    autostart.abort();
    if let Some(events) = events {
        events.stop().await;
    }
    api.stop().await;
    ipc.stop().await;
    hook_runner.abort();
    Ok(())
}

/// Next event line; `None` when the stream ended or isn't running.
async fn next_event(events: &mut Option<LineStream>) -> Option<String> {
    events.as_mut()?.next_line().await
}

fn spawn_events() -> Result<LineStream> {
    let args = ["events", "--format", "json", "--filter", "type=container", "--since", &now_iso()].map(str::to_owned);
    LineStream::spawn(process::command(PODMAN, args, None::<&Path>))
}

async fn load_watcher_config(project: &Project) -> Option<StartupConfig> {
    let config = match compose::read_config(project).await {
        Ok(Some(config)) => config,
        Ok(None) => return None,
        Err(message) => {
            eprint_line(&format!("Failed to read compose config for {}: {message}", project.name));
            return None;
        }
    };
    match config.startup(&project.name) {
        Ok(startup) => startup.filter(StartupConfig::watches_after_startup),
        Err(message) => {
            eprint_line(&format!("Failed to load x-pm3 policy for {}: {message}", project.name));
            None
        }
    }
}

async fn start_projects(ctx: Context, projects: Vec<Project>, controls: mpsc::UnboundedSender<Control>) {
    for project in projects {
        let options = StartOptions { detached: true, track_health: false, ..StartOptions::default() };
        if let Err(error) = compose::start(&ctx, &project, &options).await {
            eprint_line(&format!("Failed to start {}: {error}", project.name));
            let _ = controls.send(Control::StartFailed { project: project.name });
        }
    }
}

struct HookRequest {
    project: String,
    working_dir: String,
    service: String,
    event: &'static str,
}

/// Runs `PM3_<project>_<service>_<event>_EXEC` hooks as they arrive, each independently, so a
/// slow hook doesn't hold back others. Repeated failures of the same hook are reported once.
async fn run_hooks(mut requests: mpsc::UnboundedReceiver<HookRequest>) {
    let failing: Arc<Mutex<HashSet<String>>> = Arc::default();
    while let Some(hook) = requests.recv().await {
        let variable = format!("PM3_{}_{}_{}_EXEC", hook.project, hook.service, hook.event);
        let Some(command) = std::env::var(&variable)
            .ok()
            .map(|command| command.trim().to_owned())
            .filter(|command| !command.is_empty())
        else {
            continue;
        };
        tokio::spawn(run_hook(hook, command, Arc::clone(&failing)));
    }
}

async fn run_hook(hook: HookRequest, command: String, failing: Arc<Mutex<HashSet<String>>>) {
    let script =
        format!("{command} {} {} {}", shell_quote(&hook.project), shell_quote(&hook.service), shell_quote(hook.event));
    let output =
        process::capture(process::command("sh", ["-lc", &script], Some(Path::new(&hook.working_dir))), None).await;
    let key = format!("{}/{}/{}", hook.project, hook.service, hook.event);
    let message = match output {
        Ok(output) if output.code == 0 => None,
        Ok(output) => {
            Some(output.detail().map_or_else(|| format!("hook exited with code {}", output.code), str::to_owned))
        }
        Err(error) => Some(error.message),
    };

    let mut failing = failing.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    match message {
        None => {
            failing.remove(&key);
        }
        Some(message) => {
            if failing.insert(key) {
                eprint_line(&format!("Hook failed for {}/{} {}: {message}", hook.project, hook.service, hook.event));
            }
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

enum Control {
    Watcher { project: String, config: Option<StartupConfig> },
    StartFailed { project: String },
}

/// Daemon state. Owned by the main loop; background work reports back through channels.
struct Daemon {
    ctx: Context,
    connection: Connection,
    projects: Vec<Project>,
    /// Compose location (working directory and project label, `None` when unknown) to project name.
    locations: HashMap<(String, Option<String>), String>,
    health: HashMap<String, BTreeMap<String, HealthStatus>>,
    states: HashMap<String, BTreeMap<String, ServiceStatus>>,
    operations: HashMap<String, LifecycleOperation>,
    watchers: HashMap<String, StartupConfig>,
    hooks: mpsc::UnboundedSender<HookRequest>,
    controls: mpsc::UnboundedSender<Control>,
}

impl Daemon {
    fn load(
        ctx: Context,
        connection: Connection,
        hooks: mpsc::UnboundedSender<HookRequest>,
        controls: mpsc::UnboundedSender<Control>,
    ) -> Result<Self> {
        let mut daemon = Self {
            ctx,
            connection,
            projects: Vec::new(),
            locations: HashMap::new(),
            health: HashMap::new(),
            states: HashMap::new(),
            operations: HashMap::new(),
            watchers: HashMap::new(),
            hooks,
            controls,
        };
        daemon.refresh_projects()?;

        let names: HashMap<i64, String> =
            daemon.projects.iter().map(|project| (project.id, project.name.clone())).collect();
        for record in db::list_service_records(&daemon.connection, ServiceTable::Health)? {
            if let (Some(project), Some(status)) = (names.get(&record.project_id), HealthStatus::parse(&record.status))
            {
                daemon.health.entry(project.clone()).or_default().insert(record.service, status);
            }
        }
        for record in db::list_service_records(&daemon.connection, ServiceTable::State)? {
            if let (Some(project), Some(status)) = (names.get(&record.project_id), ServiceStatus::parse(&record.status))
            {
                daemon.states.entry(project.clone()).or_default().insert(record.service, status);
            }
        }
        Ok(daemon)
    }

    fn refresh_projects(&mut self) -> Result<()> {
        self.projects = db::list_projects(&self.connection)?;
        self.locations.clear();
        for project in &self.projects {
            let (dir, label) = compose::locate(project)
                .map_or_else(|_| (project.working_dir.clone(), None), |location| (location.dir, location.project_name));
            // The directory alone is a fallback for containers labelled under another name.
            self.locations.entry((dir.clone(), None)).or_insert_with(|| project.name.clone());
            if label.is_some() {
                self.locations.entry((dir, label)).or_insert_with(|| project.name.clone());
            }
        }
        let known: HashSet<&str> = self.projects.iter().map(|project| project.name.as_str()).collect();
        self.health.retain(|name, _| known.contains(name.as_str()));
        self.states.retain(|name, _| known.contains(name.as_str()));
        self.operations.retain(|name, _| known.contains(name.as_str()));
        self.watchers.retain(|name, _| known.contains(name.as_str()));
        Ok(())
    }

    fn project(&self, name: &str) -> Option<&Project> {
        self.projects.iter().find(|project| project.name == name)
    }

    /// Finds a project by name, reloading the registry once for projects created after startup.
    fn find_project(&mut self, name: &str) -> Option<Project> {
        if self.project(name).is_none() {
            if let Err(error) = self.refresh_projects() {
                eprint_line(&format!("Failed to reload projects: {error}"));
            }
        }
        self.project(name).cloned()
    }

    /// Records current container states at startup, without running hooks.
    async fn snapshot(&mut self) -> Option<HashMap<String, Vec<Container>>> {
        let listing = match compose::list_containers(None).await {
            Ok(listing) => listing,
            Err(error) => {
                eprint_line(&format!("Failed to list containers: {error}"));
                return None;
            }
        };

        let mut by_project = HashMap::new();
        for project in self.projects.clone() {
            let containers = match compose::project_containers_in(&project, &listing).await {
                Ok(containers) => containers,
                Err(message) => {
                    eprint_line(&format!("Failed to inspect {}: {message}", project.name));
                    continue;
                }
            };
            let snapshots = snapshot_services(&containers);
            for snapshot in &snapshots {
                self.track_state(&project, &snapshot.service, snapshot.status, false);
                if let Some(health) = snapshot.health {
                    self.track_health(&project, &snapshot.service, health, false);
                }
            }
            // Services whose containers are gone (e.g. removed by `down`) are stopped.
            let known: Vec<String> =
                self.states.get(&project.name).map(|states| states.keys().cloned().collect()).unwrap_or_default();
            for service in known {
                if !snapshots.iter().any(|snapshot| snapshot.service == service) {
                    self.track_state(&project, &service, ServiceStatus::Stopped, false);
                }
            }
            by_project.insert(project.name.clone(), containers);
        }
        Some(by_project)
    }

    fn handle_message(&mut self, message: DaemonMessage) {
        let Some(project) = self.find_project(message.project()) else { return };
        match message {
            DaemonMessage::Begin { operation, .. } => {
                self.operations.insert(project.name.clone(), operation);
                let status = if operation == LifecycleOperation::Start {
                    ServiceStatus::Starting
                } else {
                    ServiceStatus::Stopping
                };
                self.mark_all(&project, status);
            }
            DaemonMessage::Abort { .. } => {
                self.operations.remove(&project.name);
            }
            DaemonMessage::End { operation: LifecycleOperation::Stop, .. } => {
                self.mark_all(&project, ServiceStatus::Stopped);
                self.operations.insert(project.name.clone(), LifecycleOperation::Stop);
            }
            DaemonMessage::End { health, state, .. } => {
                self.operations.remove(&project.name);
                for entry in health {
                    self.track_health(&project, &entry.service, entry.status, true);
                }
                for entry in state {
                    self.track_state(&project, &entry.service, entry.status, true);
                }
                self.reload_watcher(project);
            }
        }
    }

    /// Re-reads the `x-pm3` policy after a (re)start, as the compose file may have changed.
    fn reload_watcher(&self, project: Project) {
        let controls = self.controls.clone();
        tokio::spawn(async move {
            let config = load_watcher_config(&project).await;
            let _ = controls.send(Control::Watcher { project: project.name, config });
        });
    }

    fn handle_control(&mut self, control: Control) {
        match control {
            Control::Watcher { project, config: Some(config) } => {
                self.watchers.insert(project, config);
            }
            Control::Watcher { project, config: None } => {
                self.watchers.remove(&project);
            }
            Control::StartFailed { project } => {
                if let Some(project) = self.project(&project).cloned() {
                    self.mark_all(&project, ServiceStatus::Stopped);
                }
            }
        }
    }

    fn handle_event(&mut self, line: &str) {
        let Some(event) = PodmanEvent::parse(line) else { return };
        let (health, status) = (event.health(), event.service_status());
        if health.is_none() && status.is_none() {
            return;
        }
        let (Some(dir), Some(service)) = (event.working_dir(), event.service()) else { return };
        let label = event.project().map(str::to_owned);
        let Some(project) = self
            .locations
            .get(&(dir.to_owned(), label))
            .or_else(|| self.locations.get(&(dir.to_owned(), None)))
            .and_then(|name| self.project(name))
            .cloned()
        else {
            return;
        };

        if let Some(operation) = self.operations.get(&project.name).copied() {
            if let Some(status) = status {
                let status = match (operation, status) {
                    (LifecycleOperation::Stop | LifecycleOperation::Restart, ServiceStatus::Stopping) => {
                        ServiceStatus::Stopped
                    }
                    (_, status) => status,
                };
                self.track_state(&project, service, status, true);
            }
            return;
        }

        if let Some(status) = status {
            self.track_state(&project, service, status, true);
        }
        if let Some(health) = health {
            self.track_health(&project, service, health, true);
        }
        self.enforce_policy(&project);
    }

    fn track_state(&mut self, project: &Project, service: &str, status: ServiceStatus, hooks: bool) {
        let previous = self.states.entry(project.name.clone()).or_default().insert(service.to_owned(), status);
        if previous == Some(status) {
            return;
        }
        self.record_change(project, ServiceTable::State, service, status.as_str(), hooks);

        // A (re)starting container gets a fresh healthcheck; the previous verdict no longer applies.
        let health = self.health.get_mut(&project.name).and_then(|health| health.get_mut(service));
        if let (ServiceStatus::Starting, Some(health)) = (status, health) {
            if *health != HealthStatus::Starting {
                *health = HealthStatus::Starting;
                let status = HealthStatus::Starting.as_str();
                if let Err(error) =
                    db::set_service_record(&self.connection, ServiceTable::Health, project.id, service, status)
                {
                    eprint_line(&format!("Failed to persist {}/{service} health: {error}", project.name));
                }
            }
        }
    }

    fn track_health(&mut self, project: &Project, service: &str, status: HealthStatus, hooks: bool) {
        let previous = self.health.entry(project.name.clone()).or_default().insert(service.to_owned(), status);
        if previous != Some(status) {
            self.record_change(project, ServiceTable::Health, service, status.as_str(), hooks);
        }
    }

    fn record_change(
        &mut self,
        project: &Project,
        table: ServiceTable,
        service: &str,
        status: &'static str,
        hooks: bool,
    ) {
        print_line(&format!("{}/{service} {status}", project.name));
        if db::set_service_record(&self.connection, table, project.id, service, status).is_err() {
            // The project may have been removed or re-created under a new id since it was loaded.
            let _ = self.refresh_projects();
            let retried = match self.project(&project.name) {
                Some(current) => db::set_service_record(&self.connection, table, current.id, service, status),
                None => Ok(()),
            };
            if let Err(error) = retried {
                eprint_line(&format!("Failed to persist {}/{service} {status}: {error}", project.name));
            }
        }
        if hooks {
            let _ = self.hooks.send(HookRequest {
                project: project.name.clone(),
                working_dir: project.working_dir.clone(),
                service: service.to_owned(),
                event: status,
            });
        }
    }

    /// Sets every known service of a project to `status`.
    fn mark_all(&mut self, project: &Project, status: ServiceStatus) {
        let services: Vec<String> =
            self.states.get(&project.name).map(|states| states.keys().cloned().collect()).unwrap_or_default();
        for service in services {
            self.track_state(project, &service, status, true);
        }
    }

    /// Stops a project whose required services can no longer start (`check_at: always`).
    fn enforce_policy(&mut self, project: &Project) {
        if self.operations.contains_key(&project.name) {
            return;
        }
        let Some(config) = self.watchers.get(&project.name) else { return };
        let states = self.states.get(&project.name);
        let active = states.is_some_and(|states| {
            states.values().any(|status| matches!(status, ServiceStatus::Starting | ServiceStatus::Started))
        });
        if !active {
            return;
        }

        let health = self.health.get(&project.name);
        let state: HashMap<String, ServiceState> = config
            .services()
            .iter()
            .map(|service| {
                let status = states.and_then(|states| states.get(service)).copied().unwrap_or(ServiceStatus::Starting);
                let state = ServiceState {
                    ever_started: matches!(status, ServiceStatus::Started | ServiceStatus::Stopped),
                    health: health.and_then(|health| health.get(service)).copied(),
                    status,
                };
                (service.clone(), state)
            })
            .collect();
        let Some(reason) = config.abort_reason(&state) else { return };

        print_line(&format!("Stopping {}: {reason}", project.name));
        self.operations.insert(project.name.clone(), LifecycleOperation::Stop);
        self.mark_all(project, ServiceStatus::Stopping);
        let ctx = self.ctx.clone();
        let project = project.clone();
        tokio::spawn(async move {
            if let Err(error) = compose::stop(&ctx, &project, &[], true).await {
                eprint_line(&format!("Failed to stop {} after watcher policy triggered: {error}", project.name));
            }
        });
    }
}
