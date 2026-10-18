use std::collections::HashMap;

use serde::{Deserialize, Deserializer};

use super::events::{HealthStatus, PROJECT_LABEL, SERVICE_LABELS, ServiceStatus, WORKING_DIR_LABEL};
use crate::time::{format_duration, format_elapsed_since};

/// A compose-managed container as reported by `podman ps -a --format json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub service: String,
    pub project_label: String,
    pub working_dir_label: String,
    /// Lowercase podman state (`running`, `exited`, ...).
    pub state: String,
    pub status: String,
    pub health: Option<HealthStatus>,
    pub created_at: i64,
    pub started_at: i64,
    pub exited_at: i64,
    pub exit_code: i64,
    pub ports: String,
}

impl Container {
    pub fn service_status(&self) -> ServiceStatus {
        match self.state.as_str() {
            "running" => ServiceStatus::Started,
            "created" | "exited" | "stopped" => ServiceStatus::Stopped,
            _ => ServiceStatus::Starting,
        }
    }

    pub fn is_running(&self) -> bool {
        self.state == "running"
    }

    pub fn is_down(&self) -> bool {
        matches!(self.state.as_str(), "created" | "exited" | "stopped")
    }
}

#[derive(Deserialize)]
struct PodmanContainer {
    #[serde(rename = "Id", alias = "ID", default)]
    id: String,
    #[serde(rename = "Names", default, deserialize_with = "names")]
    names: Vec<String>,
    #[serde(rename = "Labels", default, deserialize_with = "nullable")]
    labels: HashMap<String, String>,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Created", default, deserialize_with = "integer")]
    created: i64,
    #[serde(rename = "StartedAt", default, deserialize_with = "integer")]
    started_at: i64,
    #[serde(rename = "ExitedAt", default, deserialize_with = "integer")]
    exited_at: i64,
    #[serde(rename = "ExitCode", default, deserialize_with = "integer")]
    exit_code: i64,
    #[serde(rename = "Ports", default)]
    ports: serde_json::Value,
}

fn nullable<'de, D: Deserializer<'de>, T: Default + Deserialize<'de>>(deserializer: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn names<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::String(name) => vec![name],
        serde_json::Value::Array(names) => {
            names.into_iter().filter_map(|name| name.as_str().map(str::to_owned)).collect()
        }
        _ => Vec::new(),
    })
}

fn integer<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Number(number) => {
            number.as_i64().or_else(|| number.as_f64().map(|value| value as i64)).unwrap_or(0)
        }
        _ => 0,
    })
}

#[derive(Deserialize)]
struct PodmanPort {
    #[serde(default)]
    host_ip: Option<String>,
    #[serde(default)]
    container_port: Option<u32>,
    #[serde(default)]
    host_port: Option<u32>,
    #[serde(default)]
    range: Option<u32>,
    #[serde(default)]
    protocol: Option<String>,
}

pub fn parse_containers(output: &str) -> Result<Vec<Container>, String> {
    let output = output.trim();
    if output.is_empty() || output == "null" {
        return Ok(Vec::new());
    }

    let containers: Vec<PodmanContainer> =
        serde_json::from_str(output).map_err(|error| format!("Failed to parse podman container list: {error}"))?;
    Ok(containers.into_iter().map(Container::from).collect())
}

impl From<PodmanContainer> for Container {
    fn from(container: PodmanContainer) -> Self {
        let label = |name: &str| container.labels.get(name).cloned().unwrap_or_default();
        let service = SERVICE_LABELS.iter().find_map(|name| container.labels.get(*name)).cloned().unwrap_or_default();

        Self {
            id: container.id.clone(),
            name: container.names.first().cloned().unwrap_or_default(),
            service,
            project_label: label(PROJECT_LABEL),
            working_dir_label: label(WORKING_DIR_LABEL),
            state: container.state.to_ascii_lowercase(),
            health: parse_status_health(&container.status),
            status: container.status,
            created_at: container.created,
            started_at: container.started_at,
            exited_at: container.exited_at,
            exit_code: container.exit_code,
            ports: format_ports(&container.ports),
        }
    }
}

fn format_ports(ports: &serde_json::Value) -> String {
    match ports {
        serde_json::Value::String(ports) => ports.clone(),
        serde_json::Value::Array(ports) => ports
            .iter()
            .filter_map(|port| PodmanPort::deserialize(port).ok())
            .map(|port| format_port(&port))
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

fn format_port(port: &PodmanPort) -> String {
    let protocol = port.protocol.as_deref().unwrap_or("tcp");
    let container_port = format_port_range(port.container_port, port.range);
    match port.host_port.filter(|port| *port != 0) {
        None => format!("{container_port}/{protocol}"),
        Some(host_port) => {
            let host_ip = port.host_ip.as_deref().filter(|ip| !ip.is_empty()).unwrap_or("0.0.0.0");
            format!("{host_ip}:{}->{container_port}/{protocol}", format_port_range(Some(host_port), port.range))
        }
    }
}

fn format_port_range(start: Option<u32>, range: Option<u32>) -> String {
    match (start.filter(|start| *start != 0), range) {
        (None, _) => String::new(),
        (Some(start), None | Some(0 | 1)) => start.to_string(),
        (Some(start), Some(range)) => format!("{start}-{}", start + range - 1),
    }
}

/// Extracts `(healthy)` / `(health: starting)` / `(unhealthy)` from a podman status text.
fn parse_status_health(status: &str) -> Option<HealthStatus> {
    let lower = status.to_ascii_lowercase();
    lower.match_indices('(').find_map(|(index, _)| {
        let inner = &lower[index + 1..];
        let inner = inner.strip_prefix("health:").map_or(inner, str::trim_start);
        ["starting", "healthy", "unhealthy"].into_iter().find_map(|word| {
            inner.strip_prefix(word).filter(|rest| rest.starts_with(')')).and_then(|_| HealthStatus::from_podman(word))
        })
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectState {
    Up,
    Down,
    Starting,
    Stopping,
    Degraded,
}

impl ProjectState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Starting => "starting",
            Self::Stopping => "stopping",
            Self::Degraded => "degraded",
        }
    }
}

/// Containers that exited with code 0 alongside running ones are completed one-shot jobs
/// (migrations, init scripts) and don't affect the project state.
pub fn project_state(containers: &[&Container]) -> ProjectState {
    if containers.is_empty() || containers.iter().all(|container| container.is_down()) {
        return ProjectState::Down;
    }
    if containers.iter().all(|container| container.is_running()) {
        return ProjectState::Up;
    }
    if containers.iter().any(|container| container.state == "created") {
        return ProjectState::Starting;
    }
    if containers.iter().all(|container| container.is_running() || container.state == "exited") {
        return if containers.iter().all(|container| container.is_running() || container.exit_code == 0) {
            ProjectState::Up
        } else {
            ProjectState::Degraded
        };
    }
    ProjectState::Stopping
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateSummary {
    /// State with an optional duration, e.g. `up (2h 5m)`.
    pub state: String,
    pub created: String,
    pub ports: String,
}

pub const INVALID_STATE: &str = "invalid";

impl StateSummary {
    pub fn invalid() -> Self {
        Self { state: INVALID_STATE.to_owned(), created: String::new(), ports: String::new() }
    }
}

pub fn summarize(containers: &[&Container], detailed: bool) -> StateSummary {
    let state = project_state(containers);
    let duration = if detailed { state_duration(containers, state) } else { String::new() };
    let mut ports: Vec<&str> = Vec::new();
    for container in containers {
        if !container.ports.is_empty() && !ports.contains(&container.ports.as_str()) {
            ports.push(&container.ports);
        }
    }

    StateSummary {
        state: if duration.is_empty() { state.as_str().to_owned() } else { format!("{} ({duration})", state.as_str()) },
        created: created_time(containers),
        ports: ports.join("; "),
    }
}

fn state_duration(containers: &[&Container], state: ProjectState) -> String {
    let timestamp = match state {
        ProjectState::Up => containers
            .iter()
            .filter(|container| container.is_running())
            .map(|container| container.started_at)
            .filter(|timestamp| *timestamp > 0)
            .min(),
        ProjectState::Down => {
            containers.iter().map(|container| container.exited_at).filter(|timestamp| *timestamp > 0).min()
        }
        _ => return String::new(),
    };

    if let Some(timestamp) = timestamp {
        format_elapsed_since(timestamp)
    } else {
        let status = containers.first().map_or("", |container| container.status.as_str());
        compact_duration(&status_duration(status, state).unwrap_or_default())
    }
}

fn created_time(containers: &[&Container]) -> String {
    if let Some(timestamp) =
        containers.iter().map(|container| container.created_at).filter(|timestamp| *timestamp > 0).min()
    {
        format_elapsed_since(timestamp)
    } else {
        let status = containers.first().map_or("", |container| container.status.as_str());
        compact_duration(&created_duration(status).unwrap_or_default())
    }
}

/// `Up 5 minutes (healthy)` -> `5 minutes`; `Exited (0) 2 hours ago` -> `2 hours ago`.
fn status_duration(status: &str, state: ProjectState) -> Option<String> {
    let rest = match state {
        ProjectState::Up => status.strip_prefix("Up")?,
        ProjectState::Down => {
            let rest = status.strip_prefix("Exited")?;
            let rest = rest.trim_start_matches(char::is_whitespace);
            if rest.len() == status.len() - "Exited".len() {
                return None;
            }
            let close = rest.strip_prefix('(')?.find(')')?;
            if close == 0 {
                return None;
            }
            &rest[close + 2..]
        }
        _ => return None,
    };

    let trimmed = rest.trim_start_matches(char::is_whitespace);
    if trimmed.len() == rest.len() || trimmed.is_empty() {
        return None;
    }
    let end = (1..trimmed.len())
        .filter(|index| trimmed.is_char_boundary(*index))
        .find(|index| {
            let tail = &trimmed[*index..];
            let after_space = tail.trim_start_matches(char::is_whitespace);
            after_space.len() < tail.len() && after_space.starts_with('(')
        })
        .unwrap_or(trimmed.len());
    Some(trimmed[..end].to_owned())
}

/// Finds `<digits> <word> ago` in a status text.
fn created_duration(status: &str) -> Option<String> {
    let bytes = status.as_bytes();
    let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';

    (0..bytes.len()).find_map(|start| {
        if !bytes[start].is_ascii_digit() || (start > 0 && is_word(bytes[start - 1])) {
            return None;
        }
        let mut index = start;
        let mut advance = |predicate: &dyn Fn(u8) -> bool| {
            let begin = index;
            while index < bytes.len() && predicate(bytes[index]) {
                index += 1;
            }
            index > begin
        };
        let matched = advance(&|byte| byte.is_ascii_digit())
            && advance(&|byte| byte.is_ascii_whitespace())
            && advance(&is_word)
            && advance(&|byte| byte.is_ascii_whitespace());
        let ago_end = index + 3;
        (matched && status.get(index..ago_end) == Some("ago") && bytes.get(ago_end).is_none_or(|byte| !is_word(*byte)))
            .then(|| status[start..ago_end].to_owned())
    })
}

/// `2 days 3 hours` -> `2d 3h`; text without day/hour/minute amounts is returned unchanged.
fn compact_duration(duration: &str) -> String {
    let mut rest = duration;
    let mut total = 0;
    for (index, (unit, seconds)) in [("day", 86_400), ("hour", 3600), ("minute", 60)].into_iter().enumerate() {
        if index > 0 {
            rest = rest.trim_start_matches(char::is_whitespace);
        }
        if let Some((amount, remaining)) = parse_amount(rest, unit) {
            total += amount * seconds;
            rest = remaining;
        }
    }

    if total > 0 { format_duration(total) } else { duration.to_owned() }
}

fn parse_amount<'a>(text: &'a str, unit: &str) -> Option<(i64, &'a str)> {
    let digits = text.len() - text.trim_start_matches(|char: char| char.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let after_digits = &text[digits..];
    let after_space = after_digits.trim_start_matches(char::is_whitespace);
    if after_space.len() == after_digits.len() {
        return None;
    }
    let after_unit = after_space.strip_prefix(unit)?;
    let after_unit = after_unit.strip_prefix('s').unwrap_or(after_unit);
    Some((text[..digits].parse().ok()?, after_unit))
}

/// Human-friendly name order: case-insensitive first, then exact.
pub fn compare_names(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase().cmp(&right.to_lowercase()).then_with(|| left.cmp(right))
}

/// Combined status of one service across its containers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSnapshot {
    pub service: String,
    pub status: ServiceStatus,
    pub health: Option<HealthStatus>,
}

pub fn snapshot_services(containers: &[Container]) -> Vec<ServiceSnapshot> {
    let mut snapshots: Vec<ServiceSnapshot> = Vec::new();
    for container in containers.iter().filter(|container| !container.service.is_empty()) {
        let status = container.service_status();
        match snapshots.iter_mut().find(|snapshot| snapshot.service == container.service) {
            Some(snapshot) => {
                if status.rank() > snapshot.status.rank() {
                    snapshot.status = status;
                }
                if container.health.map(HealthStatus::rank) > snapshot.health.map(HealthStatus::rank) {
                    snapshot.health = container.health;
                }
            }
            None => {
                snapshots.push(ServiceSnapshot {
                    service: container.service.clone(),
                    status,
                    health: container.health,
                });
            }
        }
    }
    snapshots
}

/// Selects a project's containers from a listing by compose project label and directory.
pub fn select_project_containers(containers: &[Container], working_dir: &str, project_name: &str) -> Vec<Container> {
    containers
        .iter()
        .filter(|container| container.working_dir_label == working_dir && container.project_label == project_name)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(state: &str, exit_code: i64) -> Container {
        Container {
            id: String::new(),
            name: String::new(),
            service: state.to_owned(),
            project_label: "p".to_owned(),
            working_dir_label: "/p".to_owned(),
            state: state.to_owned(),
            status: String::new(),
            health: None,
            created_at: 0,
            started_at: 0,
            exited_at: 0,
            exit_code,
            ports: String::new(),
        }
    }

    fn state_of(containers: &[Container]) -> String {
        summarize(&containers.iter().collect::<Vec<_>>(), false).state
    }

    #[test]
    fn ignores_completed_one_shot_containers() {
        assert_eq!(state_of(&[container("running", 0), container("exited", 0)]), "up");
        assert_eq!(state_of(&[container("running", 0), container("exited", 1)]), "degraded");
        assert_eq!(state_of(&[container("exited", 0), container("exited", 0)]), "down");
        assert_eq!(state_of(&[container("running", 0), container("stopping", 0)]), "stopping");
        assert_eq!(state_of(&[container("running", 0), container("created", 0)]), "starting");
        assert_eq!(state_of(&[]), "down");
    }

    #[test]
    fn parses_podman_ps_output() {
        let containers = parse_containers(
            r#"[{"Id":"abc","Names":["p_web_1"],"Labels":{"io.podman.compose.service":"web","io.podman.compose.project":"p","com.docker.compose.project.working_dir":"/p"},
                "State":"running","Status":"Up 9 seconds (healthy)","Created":10,"StartedAt":11,"ExitedAt":-62135596800,"ExitCode":0,
                "Ports":[{"host_ip":"127.0.0.1","container_port":80,"host_port":8080,"range":1,"protocol":"tcp"},{"container_port":53,"range":2,"protocol":"udp"}]},
               {"ID":"def","Names":null,"Labels":null,"State":"Exited","Status":"Exited (0) 2 hours ago","Ports":null}]"#,
        )
        .unwrap();

        assert_eq!(containers[0].id, "abc");
        assert_eq!(containers[0].name, "p_web_1");
        assert_eq!(containers[0].service, "web");
        assert_eq!(containers[0].health, Some(HealthStatus::Healthy));
        assert_eq!(containers[0].ports, "127.0.0.1:8080->80/tcp, 53-54/udp");
        assert_eq!(containers[0].exited_at, -62_135_596_800);
        assert_eq!(containers[1].state, "exited");
        assert_eq!(containers[1].service, "");
        assert_eq!(containers[1].ports, "");
        assert!(parse_containers("").unwrap().is_empty());
        assert!(parse_containers("[]").unwrap().is_empty());
    }

    #[test]
    fn parses_health_from_status() {
        assert_eq!(parse_status_health("Up 5 minutes (healthy)"), Some(HealthStatus::Healthy));
        assert_eq!(parse_status_health("Up 5 minutes (health: starting)"), Some(HealthStatus::Starting));
        assert_eq!(parse_status_health("Up 5 minutes (unhealthy)"), Some(HealthStatus::Degraded));
        assert_eq!(parse_status_health("Up 5 minutes (Paused)"), None);
        assert_eq!(parse_status_health("Exited (0) 1 second ago"), None);
    }

    #[test]
    fn parses_status_durations() {
        assert_eq!(status_duration("Up 5 minutes (healthy)", ProjectState::Up).as_deref(), Some("5 minutes"));
        assert_eq!(status_duration("Up About an hour", ProjectState::Up).as_deref(), Some("About an hour"));
        assert_eq!(status_duration("Exited (0) 2 hours ago", ProjectState::Down).as_deref(), Some("2 hours ago"));
        assert_eq!(status_duration("Created", ProjectState::Down), None);
        assert_eq!(created_duration("Exited (0) 3 days ago").as_deref(), Some("3 days ago"));
        assert_eq!(created_duration("Up 5 seconds"), None);
    }

    #[test]
    fn compacts_textual_durations() {
        assert_eq!(compact_duration("5 minutes ago"), "5m");
        assert_eq!(compact_duration("1 day 2 hours"), "1d 2h");
        assert_eq!(compact_duration("2 hours ago"), "2h");
        assert_eq!(compact_duration("About an hour"), "About an hour");
        assert_eq!(compact_duration("3 seconds ago"), "3 seconds ago");
    }

    #[test]
    fn summarizes_durations_from_timestamps() {
        let now = crate::time::unix_now_millis() / 1000;
        let mut running = container("running", 0);
        running.started_at = now - 3700;
        running.created_at = now - 7300;
        running.ports = "0.0.0.0:80->80/tcp".to_owned();
        let summary = summarize(&[&running, &running.clone()], true);
        assert_eq!(summary.state, "up (1h 1m)");
        assert_eq!(summary.created, "2h 1m");
        assert_eq!(summary.ports, "0.0.0.0:80->80/tcp");
    }

    #[test]
    fn selects_containers_by_project_and_directory() {
        let mine = container("running", 0);
        let mut other_dir = container("running", 0);
        other_dir.working_dir_label = "/other".to_owned();
        let mut sibling = container("running", 0);
        sibling.project_label = "q".to_owned();
        let containers = vec![mine.clone(), other_dir, sibling];
        assert_eq!(select_project_containers(&containers, "/p", "p"), vec![mine]);
        assert!(select_project_containers(&containers, "/p", "x").is_empty());
    }
}
