use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const SERVICE_LABELS: [&str; 2] = ["io.podman.compose.service", "com.docker.compose.service"];
pub const WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
pub const PROJECT_LABEL: &str = "io.podman.compose.project";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Starting,
    Healthy,
    Degraded,
}

impl HealthStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Healthy => "healthy",
            Self::Degraded => "degraded",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "starting" => Some(Self::Starting),
            "healthy" => Some(Self::Healthy),
            "degraded" => Some(Self::Degraded),
            _ => None,
        }
    }

    /// Precedence when several containers back one service: the worst health wins.
    pub fn rank(self) -> u8 {
        match self {
            Self::Degraded => 3,
            Self::Starting => 2,
            Self::Healthy => 1,
        }
    }

    /// Maps podman's health vocabulary (`unhealthy`) to pm3's (`degraded`).
    pub fn from_podman(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "starting" => Some(Self::Starting),
            "healthy" => Some(Self::Healthy),
            "unhealthy" => Some(Self::Degraded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    Starting,
    Started,
    Stopping,
    Stopped,
}

impl ServiceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Started => "started",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "starting" => Some(Self::Starting),
            "started" => Some(Self::Started),
            "stopping" => Some(Self::Stopping),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }

    /// Precedence when several containers back one service: transitions win over steady states.
    pub fn rank(self) -> u8 {
        match self {
            Self::Starting => 4,
            Self::Stopping => 3,
            Self::Started => 2,
            Self::Stopped => 1,
        }
    }
}

/// A `podman events --format json` record.
#[derive(Debug, Default, Deserialize)]
pub struct PodmanEvent {
    #[serde(rename = "ID", default)]
    pub id: String,
    #[serde(rename = "Status", default)]
    pub status: String,
    #[serde(rename = "health_status", alias = "HealthStatus", default)]
    pub health_status: Option<String>,
    #[serde(rename = "Attributes", default)]
    pub attributes: HashMap<String, String>,
}

impl PodmanEvent {
    pub fn parse(line: &str) -> Option<Self> {
        serde_json::from_str(line).ok()
    }

    pub fn service(&self) -> Option<&str> {
        SERVICE_LABELS.iter().find_map(|label| self.attributes.get(*label)).map(String::as_str)
    }

    pub fn project(&self) -> Option<&str> {
        self.attributes.get(PROJECT_LABEL).map(String::as_str)
    }

    pub fn working_dir(&self) -> Option<&str> {
        self.attributes.get(WORKING_DIR_LABEL).map(String::as_str)
    }

    pub fn health(&self) -> Option<HealthStatus> {
        match &self.health_status {
            Some(status) => HealthStatus::from_podman(status),
            None => self
                .status
                .strip_prefix("health_status")
                .map(|rest| rest.strip_prefix(':').unwrap_or(rest))
                .filter(|rest| rest.starts_with(char::is_whitespace))
                .and_then(|rest| HealthStatus::from_podman(rest.trim())),
        }
    }

    pub fn service_status(&self) -> Option<ServiceStatus> {
        match self.status.to_ascii_lowercase().as_str() {
            "start" => Some(ServiceStatus::Started),
            "create" | "init" | "restart" => Some(ServiceStatus::Starting),
            "stop" | "died" | "remove" => Some(ServiceStatus::Stopping),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_podman_events() {
        let event = PodmanEvent::parse(
            r#"{"ID":"abc","Status":"health_status","health_status":"unhealthy","Attributes":{"com.docker.compose.service":"web","com.docker.compose.project.working_dir":"/app"}}"#,
        )
        .unwrap();
        assert_eq!(event.id, "abc");
        assert_eq!(event.service(), Some("web"));
        assert_eq!(event.working_dir(), Some("/app"));
        assert_eq!(event.health(), Some(HealthStatus::Degraded));
        assert_eq!(event.service_status(), None);

        let start =
            PodmanEvent::parse(r#"{"Status":"start","Attributes":{"io.podman.compose.service":"db"}}"#).unwrap();
        assert_eq!(start.service(), Some("db"));
        assert_eq!(start.service_status(), Some(ServiceStatus::Started));
        assert_eq!(start.health(), None);
    }

    #[test]
    fn parses_legacy_health_status_text() {
        let event = PodmanEvent { status: "health_status: healthy".to_owned(), ..PodmanEvent::default() };
        assert_eq!(event.health(), Some(HealthStatus::Healthy));
        let event = PodmanEvent { status: "health_status starting".to_owned(), ..PodmanEvent::default() };
        assert_eq!(event.health(), Some(HealthStatus::Starting));
    }

    #[test]
    fn maps_lifecycle_statuses() {
        let status =
            |status: &str| PodmanEvent { status: status.to_owned(), ..PodmanEvent::default() }.service_status();
        assert_eq!(status("create"), Some(ServiceStatus::Starting));
        assert_eq!(status("died"), Some(ServiceStatus::Stopping));
        assert_eq!(status("remove"), Some(ServiceStatus::Stopping));
        assert_eq!(status("cleanup"), None);
    }
}
