use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use super::containers::Container;
use super::events::{HealthStatus, PodmanEvent, ServiceStatus};
use crate::term::{Loader, green, red, yellow};

const CHECKING_HEALTH: &str = "Checking health";
/// Fallback settle time for services whose healthcheck policy is unknown.
const HEALTH_SETTLE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Building,
    Starting,
    Stopping,
    Removing,
}

impl Operation {
    pub fn from_args(args: &[String]) -> Self {
        let has = |value: &str| args.iter().any(|arg| arg == value);
        if has("build") {
            Self::Building
        } else if args.first().is_some_and(|arg| arg == "down")
            && has("--remove-orphans")
            && !has("--volumes")
            && !has("--rmi")
        {
            Self::Stopping
        } else if has("down") {
            Self::Removing
        } else if has("stop") {
            Self::Stopping
        } else {
            Self::Starting
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Building => "Building",
            Self::Starting => "Starting",
            Self::Stopping => "Stopping",
            Self::Removing => "Removing",
        }
    }

    fn finished_label(self) -> &'static str {
        match self {
            Self::Building => "Building",
            Self::Starting => "Started",
            Self::Stopping => "Stopped",
            Self::Removing => "Removed",
        }
    }

    pub fn tracks_health(self) -> bool {
        self == Self::Starting
    }

    fn completes(self, event_status: &str) -> bool {
        match self {
            Self::Removing => event_status == "remove",
            Self::Stopping => matches!(event_status, "stop" | "died" | "remove"),
            Self::Starting | Self::Building => event_status == "start",
        }
    }

    /// Podman subcommands that podman-compose runs per service for this operation.
    fn podman_commands(self) -> &'static [&'static str] {
        match self {
            Self::Starting => &["start"],
            Self::Stopping => &["stop"],
            Self::Removing => &["stop", "rm"],
            Self::Building => &[],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HealthProgress {
    Starting,
    Healthy,
    Degraded,
    TimedOut,
}

impl HealthProgress {
    fn line(self) -> String {
        match self {
            Self::Starting => yellow(CHECKING_HEALTH),
            Self::Healthy => green("Healthy"),
            Self::Degraded => red("Unhealthy"),
            Self::TimedOut => yellow("Healthcheck timeout"),
        }
    }
}

impl From<HealthStatus> for HealthProgress {
    fn from(status: HealthStatus) -> Self {
        match status {
            HealthStatus::Starting => Self::Starting,
            HealthStatus::Healthy => Self::Healthy,
            HealthStatus::Degraded => Self::Degraded,
        }
    }
}

struct HealthEntry {
    service: String,
    status: HealthProgress,
    started_at: Option<Instant>,
}

/// What a podman event changed, so the caller can feed startup policy decisions.
pub struct EventEffect {
    pub service: String,
    pub service_status: Option<ServiceStatus>,
    pub health_change: Option<HealthStatus>,
}

/// Per-service progress of a compose operation, rendered through a [`Loader`].
pub struct Progress {
    project: String,
    operation: Operation,
    services: Vec<String>,
    /// Services ordered by descending name length, so `_web_api_` matches `web_api` before `web`.
    match_order: Vec<String>,
    started: HashSet<String>,
    /// Containers created or started by this operation.
    own_containers: HashSet<String>,
    finished: HashSet<String>,
    health: Vec<HealthEntry>,
    health_waits: HashMap<String, Duration>,
    unhealthy: Vec<String>,
    notices: usize,
    last_command_service: Option<String>,
}

impl Progress {
    pub fn new(
        project: &str,
        operation: Operation,
        services: Vec<String>,
        health_waits: HashMap<String, Duration>,
        loader: &Loader,
    ) -> Self {
        let mut match_order = services.clone();
        match_order.sort_by_key(|service| std::cmp::Reverse(service.len()));
        let mut progress = Self {
            project: project.to_owned(),
            operation,
            services,
            match_order,
            started: HashSet::new(),
            own_containers: HashSet::new(),
            finished: HashSet::new(),
            health: Vec::new(),
            health_waits,
            unhealthy: Vec::new(),
            notices: 0,
            last_command_service: None,
        };
        for service in progress.services.clone() {
            progress.start_service(&service, loader);
        }
        progress
    }

    pub fn unhealthy(&self) -> &[String] {
        &self.unhealthy
    }

    pub fn notices(&self) -> usize {
        self.notices
    }

    fn progress_id(&self, service: &str) -> String {
        format!("progress:{}/{service}", self.project)
    }

    fn health_id(&self, service: &str) -> String {
        format!("health:{}/{service}", self.project)
    }

    fn service_line(&self, label: &str, service: &str) -> String {
        format!("{label} {}/{service}", self.project)
    }

    fn start_service(&mut self, service: &str, loader: &Loader) {
        if self.started.insert(service.to_owned()) {
            loader.start_line(&self.progress_id(service), &self.service_line(self.operation.label(), service));
        }
    }

    fn finish_service(&mut self, service: &str, loader: &Loader) {
        if self.finished.contains(service) {
            return;
        }
        self.start_service(service, loader);
        self.finished.insert(service.to_owned());
        loader.finish_line(&self.progress_id(service), &self.service_line(self.operation.finished_label(), service));
    }

    fn health_entry(&mut self, service: &str) -> Option<&mut HealthEntry> {
        self.health.iter_mut().find(|entry| entry.service == service)
    }

    fn ensure_health(&mut self, service: &str, loader: &Loader) {
        if self.health_entry(service).is_some() {
            return;
        }
        self.health.push(HealthEntry {
            service: service.to_owned(),
            status: HealthProgress::Starting,
            started_at: Some(Instant::now()),
        });
        loader.start_line_after(&self.progress_id(service), &self.health_id(service), &HealthProgress::Starting.line());
    }

    fn finish_health(&mut self, service: &str, status: HealthProgress, loader: &Loader) {
        let health_id = self.health_id(service);
        if let Some(entry) = self.health_entry(service) {
            entry.status = status;
            entry.started_at = None;
        }
        loader.finish_line(&health_id, &status.line());
    }

    pub fn on_event(&mut self, event: &PodmanEvent, loader: &Loader) -> Option<EventEffect> {
        let service = event.service().filter(|service| self.services.iter().any(|known| known == service))?.to_owned();

        if self.operation.completes(&event.status) {
            self.finish_service(&service, loader);
            if self.operation.tracks_health() && self.health_waits.contains_key(&service) {
                self.ensure_health(&service, loader);
            }
        }

        let health = if self.operation.tracks_health() { event.health() } else { None };
        let health_change = health
            .filter(|_| self.finished.contains(&service))
            .filter(|health| self.update_health(&service, *health, loader));

        // `up --force-recreate` stops and removes the previous containers first; only containers of
        // this operation can make a service fail.
        let service_status = match event.service_status() {
            Some(status @ (ServiceStatus::Starting | ServiceStatus::Started)) => {
                self.own_containers.insert(event.id.clone());
                Some(status)
            }
            Some(ServiceStatus::Stopping) if !self.own_containers.contains(&event.id) => None,
            status => status,
        };

        Some(EventEffect { service_status, health_change, service })
    }

    /// Applies a health event; returns whether the tracked health changed.
    fn update_health(&mut self, service: &str, status: HealthStatus, loader: &Loader) -> bool {
        let next = HealthProgress::from(status);
        match self.health_entry(service).map(|entry| entry.status) {
            Some(previous) if previous != HealthProgress::Starting || previous == next => return false,
            Some(_) => {}
            None => {
                self.health.push(HealthEntry { service: service.to_owned(), status: next, started_at: None });
                loader.start_line_after(
                    &self.progress_id(service),
                    &self.health_id(service),
                    &HealthProgress::Starting.line(),
                );
            }
        }

        if next == HealthProgress::Starting {
            if let Some(entry) = self.health_entry(service) {
                entry.status = next;
                entry.started_at.get_or_insert_with(Instant::now);
            }
            return true;
        }

        self.finish_health(service, next, loader);
        if next == HealthProgress::Degraded {
            if !self.unhealthy.iter().any(|unhealthy| unhealthy == service) {
                self.unhealthy.push(service.to_owned());
            }
        } else {
            self.unhealthy.retain(|unhealthy| unhealthy != service);
        }
        true
    }

    /// Interprets one line of podman-compose output: detects which service is being processed
    /// and surfaces warnings/errors under that service.
    pub fn on_compose_line(&mut self, line: &str, loader: &Loader) {
        if let Some(service) = self.command_service(line) {
            self.start_service(&service, loader);
            self.last_command_service = Some(service);
        }

        if !is_notice_line(line) {
            return;
        }

        let notice = yellow(&notice_text(line));
        match self.service_in_line(line).or_else(|| self.last_command_service.clone()) {
            Some(service) => {
                self.start_service(&service, loader);
                let id = format!("notice:{}/{service}:{}", self.project, self.notices);
                loader.write_line_after(&self.progress_id(&service), &id, &notice);
            }
            None => loader.write_line(&format!("notice:{}", self.notices), &notice),
        }
        self.notices += 1;
    }

    fn command_service(&self, line: &str) -> Option<String> {
        let line = line.trim();
        let runs_command =
            self.operation.podman_commands().iter().any(|command| line.contains(&format!("podman {command} ")));
        if runs_command { self.service_in_line(line) } else { None }
    }

    fn service_in_line(&self, line: &str) -> Option<String> {
        self.match_order.iter().find(|service| line.contains(&format!("_{service}_"))).cloned()
    }

    /// Called once the compose command exited: finishes services that are already running
    /// without having emitted a start event, and opens health tracking where needed.
    pub fn seed(&mut self, containers: &[Container], loader: &Loader) {
        for service in self.services.clone() {
            if !self.finished.contains(&service)
                && containers.iter().any(|container| container.service == service && container.is_running())
            {
                self.finish_service(&service, loader);
            }
        }

        let current = current_health(containers);
        let mut waits: Vec<String> = self.health_waits.keys().cloned().collect();
        waits.sort_by_key(|service| self.services.iter().position(|known| known == service));
        for service in waits {
            match current.iter().find(|(name, _)| *name == service).map(|(_, status)| *status) {
                Some(status @ (HealthStatus::Healthy | HealthStatus::Degraded)) => {
                    if self.health_entry(&service).is_some_and(|entry| entry.status == HealthProgress::Starting) {
                        self.finish_health(&service, status.into(), loader);
                    }
                }
                _ => {
                    if self.finished.contains(&service) {
                        self.ensure_health(&service, loader);
                    }
                }
            }
        }
    }

    /// Settles pending health checks from a fresh container listing.
    pub fn reconcile(&mut self, containers: &[Container], loader: &Loader) {
        for (service, status) in current_health(containers) {
            let pending = self.health_entry(service).is_some_and(|entry| entry.status == HealthProgress::Starting);
            if pending && matches!(status, HealthStatus::Healthy | HealthStatus::Degraded) {
                self.finish_health(service, status.into(), loader);
            }
        }
    }

    fn deadline(&self, entry: &HealthEntry) -> Option<Instant> {
        let wait = self.health_waits.get(&entry.service).copied().unwrap_or(HEALTH_SETTLE_TIMEOUT);
        (entry.status == HealthProgress::Starting).then(|| entry.started_at.unwrap_or_else(Instant::now) + wait)
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.health.iter().filter_map(|entry| self.deadline(entry)).min()
    }

    pub fn has_pending_health(&self) -> bool {
        self.health.iter().any(|entry| entry.status == HealthProgress::Starting)
    }

    /// Marks health checks that outlived their policy as timed out.
    pub fn expire(&mut self, now: Instant, loader: &Loader) {
        let expired: Vec<String> = self
            .health
            .iter()
            .filter(|entry| entry.started_at.is_some() && self.deadline(entry).is_some_and(|deadline| deadline <= now))
            .map(|entry| entry.service.clone())
            .collect();
        for service in expired {
            self.finish_health(&service, HealthProgress::TimedOut, loader);
        }
    }

    pub fn expire_all(&mut self, loader: &Loader) {
        let pending: Vec<String> = self
            .health
            .iter()
            .filter(|entry| entry.status == HealthProgress::Starting)
            .map(|entry| entry.service.clone())
            .collect();
        for service in pending {
            self.finish_health(&service, HealthProgress::TimedOut, loader);
        }
    }
}

fn current_health(containers: &[Container]) -> Vec<(&str, HealthStatus)> {
    let mut health: Vec<(&str, HealthStatus)> = Vec::new();
    for container in containers {
        let Some(status) = container.health.filter(|_| !container.service.is_empty()) else { continue };
        match health.iter_mut().find(|(service, _)| *service == container.service) {
            Some(entry) => entry.1 = status,
            None => health.push((&container.service, status)),
        }
    }
    health
}

const NOTICE_LEVELS: [&str; 7] = ["err", "error", "warn", "warning", "critical", "fatal", "panic"];
const LOG_LEVELS: [&str; 10] =
    ["trace", "debug", "info", "warn", "warning", "err", "error", "critical", "fatal", "panic"];

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn words(line: &str) -> impl Iterator<Item = &str> {
    line.split(|char: char| !(char.is_ascii_alphanumeric() || char == '_')).filter(|word| !word.is_empty())
}

/// Whether a compose output line is a warning or error worth showing.
pub fn is_notice_line(line: &str) -> bool {
    match log_level(line) {
        Some(level) => NOTICE_LEVELS.contains(&level.as_str()),
        None => {
            words(line).any(|word| matches!(word.to_ascii_lowercase().as_str(), "err" | "error" | "warn" | "warning"))
        }
    }
}

pub fn has_warning_word(line: &str) -> bool {
    words(line).any(|word| matches!(word.to_ascii_lowercase().as_str(), "warn" | "warning"))
}

/// Level from a `LEVEL:logger:` prefix or a logfmt `level=` field.
fn log_level(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let prefix_length = trimmed.find(|char: char| !char.is_ascii_alphabetic()).unwrap_or(trimmed.len());
    if trimmed[prefix_length..].starts_with(':') {
        let prefix = trimmed[..prefix_length].to_ascii_lowercase();
        if LOG_LEVELS.contains(&prefix.as_str()) {
            return Some(prefix);
        }
    }

    logfmt_value(line, "level", |value| {
        let value = value.strip_prefix(['"', '\'']).unwrap_or(value);
        let length = value.find(|char: char| !char.is_ascii_alphabetic()).unwrap_or(value.len());
        let (level, rest) = value.split_at(length);
        let terminated = rest.is_empty() || rest.starts_with(['"', '\'']) || !is_word_byte(rest.as_bytes()[0]);
        (!level.is_empty() && terminated).then(|| level.to_ascii_lowercase())
    })
}

/// Finds `key=` at a word boundary (case-insensitive) and parses the raw value with `parse`.
fn logfmt_value<T>(line: &str, key: &str, parse: impl Fn(&str) -> Option<T>) -> Option<T> {
    let lower = line.to_ascii_lowercase();
    let pattern = format!("{key}=");
    lower.match_indices(&pattern).find_map(|(index, _)| {
        if index > 0 && is_word_byte(lower.as_bytes()[index - 1]) {
            return None;
        }
        parse(&line[index + pattern.len()..])
    })
}

fn notice_text(line: &str) -> String {
    podman_log_message(line).unwrap_or_else(|| line.trim().to_owned())
}

/// The `msg="..."` of a logfmt warning emitted by podman.
fn podman_log_message(line: &str) -> Option<String> {
    let is_warning = logfmt_value(line, "level", |value| {
        let word = &value[..value.bytes().position(|byte| !is_word_byte(byte)).unwrap_or(value.len())];
        matches!(word.to_ascii_lowercase().as_str(), "warn" | "warning").then_some(())
    });
    is_warning?;

    let lower = line.to_ascii_lowercase();
    lower.match_indices("msg=\"").find_map(|(index, _)| {
        if index > 0 && is_word_byte(lower.as_bytes()[index - 1]) {
            return None;
        }
        let mut message = String::new();
        let mut chars = line[index + 5..].chars();
        while let Some(char) = chars.next() {
            match char {
                '"' => return Some(message),
                '\\' => match chars.next()? {
                    'n' => message.push('\n'),
                    'r' => message.push('\r'),
                    't' => message.push('\t'),
                    escaped @ ('"' | '\\') => message.push(escaped),
                    other => {
                        message.push('\\');
                        message.push(other);
                    }
                },
                other => message.push(other),
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn derives_operations_from_compose_arguments() {
        assert_eq!(Operation::from_args(&args(&["build", "--no-cache"])), Operation::Building);
        assert_eq!(Operation::from_args(&args(&["up", "-d"])), Operation::Starting);
        assert_eq!(Operation::from_args(&args(&["down", "--remove-orphans", "--timeout", "30"])), Operation::Stopping);
        assert_eq!(
            Operation::from_args(&args(&["down", "--volumes", "--rmi", "all", "--remove-orphans"])),
            Operation::Removing
        );
        assert_eq!(Operation::from_args(&args(&["stop"])), Operation::Stopping);
    }

    #[test]
    fn notices_use_the_structured_log_level() {
        assert!(!is_notice_line("DEBUG:podman_compose:podman run --env DEBUG=app:*:warn,app:*:error"));
        assert!(!is_notice_line("INFO:podman_compose:podman run --env DEBUG=app:*:warn,app:*:error"));
        assert!(!is_notice_line(r#"time="now" level=info msg="ignored error""#));
        assert!(!is_notice_line(r#"time="now" level=information msg="ignored error""#));
        assert!(is_notice_line("WARNING:podman_compose:compose warning"));
        assert!(is_notice_line("ERROR:podman_compose:compose failed"));
        assert!(is_notice_line(r#"time="now" level=warning msg="compose warning""#));
    }

    #[test]
    fn notices_retain_unstructured_warnings_and_errors() {
        assert!(is_notice_line("Warning: service is missing"));
        assert!(is_notice_line("Error: service failed"));
        assert!(!is_notice_line("errors: none"));
        assert!(!is_notice_line("all good"));
    }

    #[test]
    fn extracts_podman_warning_messages() {
        assert_eq!(
            notice_text(r#"time="2026" level=warning msg="image \"x\" is\tstale\nretry""#),
            "image \"x\" is\tstale\nretry"
        );
        assert_eq!(notice_text("  WARNING:podman_compose:something  "), "WARNING:podman_compose:something");
        assert_eq!(notice_text(r#"level=error msg="boom""#), r#"level=error msg="boom""#);
    }

    #[test]
    fn counts_warning_words() {
        assert!(has_warning_word("WARN: x"));
        assert!(has_warning_word("a warning here"));
        assert!(!has_warning_word("warnings"));
    }

    #[test]
    fn tracks_service_and_health_progress() {
        let loader = Loader::silent();
        let waits = HashMap::from([("db".to_owned(), Duration::from_secs(5))]);
        let mut progress =
            Progress::new("app", Operation::Starting, vec!["web".to_owned(), "db".to_owned()], waits, &loader);

        let event = |status: &str, service: &str, health: Option<&str>| PodmanEvent {
            id: format!("{service}-new"),
            status: status.to_owned(),
            health_status: health.map(str::to_owned),
            attributes: HashMap::from([("io.podman.compose.service".to_owned(), service.to_owned())]),
        };

        let effect = progress.on_event(&event("remove", "db", None), &loader).unwrap();
        assert_eq!(effect.service_status, None, "previous containers are being replaced");

        let effect = progress.on_event(&event("start", "db", None), &loader).unwrap();
        assert_eq!(effect.service_status, Some(ServiceStatus::Started));
        assert!(progress.has_pending_health());

        let effect = progress.on_event(&event("health_status", "db", Some("unhealthy")), &loader).unwrap();
        assert_eq!(effect.health_change, Some(HealthStatus::Degraded));
        assert_eq!(progress.unhealthy(), ["db"]);
        assert!(!progress.has_pending_health());

        let effect = progress.on_event(&event("health_status", "db", Some("healthy")), &loader).unwrap();
        assert_eq!(effect.health_change, None);
        assert!(progress.on_event(&event("start", "unknown", None), &loader).is_none());
    }

    #[test]
    fn expires_health_checks_after_their_policy() {
        let loader = Loader::silent();
        let waits = HashMap::from([("db".to_owned(), Duration::from_millis(10))]);
        let mut progress = Progress::new("app", Operation::Starting, vec!["db".to_owned()], waits, &loader);
        progress.finish_service("db", &loader);
        progress.ensure_health("db", &loader);
        assert!(progress.next_deadline().is_some());
        progress.expire(Instant::now() + Duration::from_secs(1), &loader);
        assert!(!progress.has_pending_health());
        assert!(progress.next_deadline().is_none());
    }

    #[test]
    fn detects_services_from_compose_commands() {
        let loader = Loader::silent();
        let mut progress = Progress::new(
            "app",
            Operation::Starting,
            vec!["web".to_owned(), "web_api".to_owned()],
            HashMap::new(),
            &loader,
        );
        progress.on_compose_line("INFO:podman_compose:podman start app_web_api_1", &loader);
        assert_eq!(progress.last_command_service.as_deref(), Some("web_api"));
        progress.on_compose_line("WARNING: something odd", &loader);
        assert_eq!(progress.notices(), 1);
    }
}
