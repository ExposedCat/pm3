use std::collections::{HashMap, HashSet};

use super::events::{HealthStatus, ServiceStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Condition {
    Started,
    Healthy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub service: String,
    pub condition: Condition,
}

/// How long `x-pm3` keeps enforcing that a service stays startable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckAt {
    Startup,
    Always,
}

/// Required services, dependency graph and health enforcement from `x-pm3.<project>`.
#[derive(Debug, Clone)]
pub struct StartupConfig {
    services: Vec<String>,
    dependencies: HashMap<String, Vec<Dependency>>,
    check_at: HashMap<String, CheckAt>,
    required: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceState {
    pub ever_started: bool,
    pub health: Option<HealthStatus>,
    pub status: ServiceStatus,
}

impl Default for ServiceState {
    fn default() -> Self {
        Self { ever_started: false, health: None, status: ServiceStatus::Starting }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Classification {
    Waiting,
    Started,
    Failed,
    BlockedTerminal,
}

impl Classification {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Failed | Self::BlockedTerminal)
    }
}

impl StartupConfig {
    pub fn new(services: Vec<(String, Vec<Dependency>, CheckAt)>, required: Vec<String>) -> Self {
        let mut config = Self {
            services: Vec::with_capacity(services.len()),
            dependencies: HashMap::new(),
            check_at: HashMap::new(),
            required,
        };
        for (service, dependencies, check_at) in services {
            config.dependencies.insert(service.clone(), dependencies);
            config.check_at.insert(service.clone(), check_at);
            config.services.push(service);
        }
        config
    }

    pub fn services(&self) -> &[String] {
        &self.services
    }

    #[cfg(test)]
    pub fn required(&self) -> &[String] {
        &self.required
    }

    pub fn check_at(&self, service: &str) -> CheckAt {
        self.check_at.get(service).copied().unwrap_or(CheckAt::Startup)
    }

    /// Whether the daemon has to keep enforcing the policy after startup.
    pub fn watches_after_startup(&self) -> bool {
        self.required.iter().any(|service| self.check_at(service) == CheckAt::Always)
    }

    /// Reason why required services can never start, if any.
    pub fn abort_reason(&self, state: &HashMap<String, ServiceState>) -> Option<String> {
        let mut classifications = HashMap::new();
        for service in &self.services {
            self.classify(state, &mut classifications, service, &mut HashSet::new());
        }

        let blocked: Vec<&str> = self
            .required
            .iter()
            .filter(|service| {
                classifications.get(service.as_str()).is_some_and(|classification| classification.is_terminal())
            })
            .map(String::as_str)
            .collect();
        (!blocked.is_empty()).then(|| format!("Required services permanently unstartable: {}", blocked.join(", ")))
    }

    fn classify<'a>(
        &'a self,
        state: &HashMap<String, ServiceState>,
        classifications: &mut HashMap<&'a str, Classification>,
        service: &'a str,
        chain: &mut HashSet<&'a str>,
    ) -> Classification {
        if let Some(classification) = classifications.get(service) {
            return *classification;
        }

        let service_state = state.get(service);
        let ever_started = service_state.is_some_and(|state| state.ever_started);
        let classification = if self.check_at(service) == CheckAt::Startup && ever_started {
            Classification::Started
        } else if service_state.is_some_and(|state| is_stopped(state.status)) {
            Classification::Failed
        } else if chain.contains(service) {
            Classification::Waiting
        } else {
            chain.insert(service);
            let dependencies = self.dependencies.get(service).map_or(&[][..], Vec::as_slice);
            let blocked = dependencies
                .iter()
                .any(|dependency| self.dependency_is_terminal(state, classifications, service, dependency, chain));
            chain.remove(service);

            if blocked {
                Classification::BlockedTerminal
            } else if ever_started {
                Classification::Started
            } else {
                Classification::Waiting
            }
        };

        classifications.insert(service, classification);
        classification
    }

    fn dependency_is_terminal<'a>(
        &'a self,
        state: &HashMap<String, ServiceState>,
        classifications: &mut HashMap<&'a str, Classification>,
        consumer: &str,
        dependency: &'a Dependency,
        chain: &mut HashSet<&'a str>,
    ) -> bool {
        if self.classify(state, classifications, &dependency.service, chain).is_terminal() {
            return true;
        }

        let dependency_state = state.get(&dependency.service);
        let dependency_stopped = dependency_state.is_some_and(|state| is_stopped(state.status));
        match dependency.condition {
            Condition::Started => dependency_stopped && !state.get(consumer).is_some_and(|state| state.ever_started),
            Condition::Healthy => {
                dependency_stopped || dependency_state.is_some_and(|state| state.health == Some(HealthStatus::Degraded))
            }
        }
    }
}

fn is_stopped(status: ServiceStatus) -> bool {
    matches!(status, ServiceStatus::Stopping | ServiceStatus::Stopped)
}

/// Follows service events during `up` to detect required services that can never start.
pub struct StartupTracker {
    config: StartupConfig,
    state: HashMap<String, ServiceState>,
}

impl StartupTracker {
    pub fn new(config: StartupConfig) -> Self {
        let state = config.services.iter().map(|service| (service.clone(), ServiceState::default())).collect();
        Self { config, state }
    }

    pub fn record_health(&mut self, service: &str, health: HealthStatus) {
        if let Some(state) = self.state.get_mut(service) {
            state.health = Some(health);
        }
    }

    pub fn record_service(&mut self, service: &str, status: ServiceStatus) {
        if let Some(state) = self.state.get_mut(service) {
            state.ever_started |= status == ServiceStatus::Started;
            state.status = status;
        }
    }

    pub fn abort_reason(&self) -> Option<String> {
        self.config.abort_reason(&self.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(check_at: CheckAt) -> StartupConfig {
        StartupConfig::new(
            vec![
                (
                    "main".to_owned(),
                    vec![Dependency { service: "db".to_owned(), condition: Condition::Healthy }],
                    check_at,
                ),
                ("db".to_owned(), Vec::new(), CheckAt::Startup),
            ],
            vec!["main".to_owned()],
        )
    }

    #[test]
    fn waits_while_dependencies_start() {
        let tracker = StartupTracker::new(config(CheckAt::Startup));
        assert_eq!(tracker.abort_reason(), None);
    }

    #[test]
    fn aborts_when_a_healthy_dependency_degrades() {
        let mut tracker = StartupTracker::new(config(CheckAt::Startup));
        tracker.record_service("db", ServiceStatus::Started);
        tracker.record_health("db", HealthStatus::Degraded);
        assert_eq!(tracker.abort_reason().as_deref(), Some("Required services permanently unstartable: main"));
    }

    #[test]
    fn started_services_are_safe_unless_checked_always() {
        let mut tracker = StartupTracker::new(config(CheckAt::Startup));
        tracker.record_service("main", ServiceStatus::Started);
        tracker.record_service("db", ServiceStatus::Started);
        tracker.record_health("db", HealthStatus::Degraded);
        assert_eq!(tracker.abort_reason(), None);

        let mut tracker = StartupTracker::new(config(CheckAt::Always));
        tracker.record_service("main", ServiceStatus::Started);
        tracker.record_service("db", ServiceStatus::Started);
        tracker.record_health("db", HealthStatus::Degraded);
        assert!(tracker.abort_reason().is_some());
    }

    #[test]
    fn stopped_required_services_fail() {
        let mut tracker = StartupTracker::new(config(CheckAt::Always));
        tracker.record_service("main", ServiceStatus::Stopping);
        assert!(tracker.abort_reason().is_some());
    }

    #[test]
    fn started_condition_only_blocks_consumers_that_never_started() {
        let config = StartupConfig::new(
            vec![
                (
                    "api".to_owned(),
                    vec![Dependency { service: "cache".to_owned(), condition: Condition::Started }],
                    CheckAt::Always,
                ),
                ("cache".to_owned(), Vec::new(), CheckAt::Always),
            ],
            vec!["api".to_owned()],
        );
        let mut state = HashMap::new();
        state.insert(
            "api".to_owned(),
            ServiceState { ever_started: true, health: None, status: ServiceStatus::Started },
        );
        state.insert(
            "cache".to_owned(),
            ServiceState { ever_started: true, health: None, status: ServiceStatus::Stopped },
        );
        // The stopped dependency itself fails, which propagates to its consumers.
        assert!(config.abort_reason(&state).is_some());
    }

    #[test]
    fn tolerates_dependency_cycles() {
        let config = StartupConfig::new(
            vec![
                (
                    "a".to_owned(),
                    vec![Dependency { service: "b".to_owned(), condition: Condition::Started }],
                    CheckAt::Startup,
                ),
                (
                    "b".to_owned(),
                    vec![Dependency { service: "a".to_owned(), condition: Condition::Started }],
                    CheckAt::Startup,
                ),
            ],
            vec!["a".to_owned()],
        );
        assert_eq!(StartupTracker::new(config).abort_reason(), None);
    }
}
