use std::time::Duration;

use serde_norway::{Mapping, Value};

use super::startup::{CheckAt, Condition, Dependency, StartupConfig};

const DEFAULT_HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_HEALTH_START_PERIOD: Duration = Duration::ZERO;
const DEFAULT_HEALTH_RETRIES: u32 = 3;
const INFINITE_RETRY_ATTEMPTS: u32 = 3;

/// The resolved configuration printed by `podman-compose config`.
#[derive(Debug, Default)]
pub struct ComposeConfig {
    pub services: Vec<ServiceConfig>,
    extension: Option<Mapping>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceConfig {
    pub name: String,
    pub image: Option<String>,
    pub has_build: bool,
    pub pull_policy: Option<String>,
    /// How long a health check may take to settle; `None` without a healthcheck.
    pub health_wait: Option<Duration>,
    pub depends_on: Vec<Dependency>,
}

impl ComposeConfig {
    pub fn parse(text: &str) -> Result<Self, String> {
        let document: Value =
            serde_norway::from_str(text).map_err(|error| format!("Invalid compose config: {error}"))?;
        let Value::Mapping(document) = document else {
            return Err("Invalid compose config: expected a mapping".to_owned());
        };

        let services = mapping(document.get("services"))
            .map(|services| {
                services
                    .iter()
                    .filter_map(|(name, definition)| Some(parse_service(key_name(name)?, definition)))
                    .collect()
            })
            .unwrap_or_default();

        Ok(Self { services, extension: mapping(document.get("x-pm3")).cloned() })
    }

    pub fn service_names(&self) -> Vec<String> {
        self.services.iter().map(|service| service.name.clone()).collect()
    }

    /// Unqualified image names that podman would have to resolve through a registry prompt.
    pub fn pullable_short_images(&self) -> Vec<&str> {
        let mut images: Vec<&str> = Vec::new();
        for service in &self.services {
            let Some(image) = service.image.as_deref() else { continue };
            let skip = service.has_build
                || matches!(service.pull_policy.as_deref(), Some("never" | "build"))
                || is_qualified_image(image)
                || images.contains(&image);
            if !skip {
                images.push(image);
            }
        }
        images
    }

    /// Startup policy from `x-pm3.<project>`; `None` when no services are required.
    pub fn startup(&self, project_name: &str) -> Result<Option<StartupConfig>, String> {
        let services = self.service_names();
        let empty = Mapping::new();
        let project =
            self.extension.as_ref().and_then(|extension| mapping(named(extension, project_name))).unwrap_or(&empty);

        let required: Vec<String> = match project.get("required_services") {
            Some(Value::String(value)) if value == "all" => services.clone(),
            Some(Value::Sequence(entries)) => {
                entries.iter().filter_map(Value::as_str).filter(|entry| !entry.is_empty()).map(str::to_owned).collect()
            }
            _ => Vec::new(),
        };

        let unknown: Vec<&str> =
            required.iter().filter(|service| !services.contains(service)).map(String::as_str).collect();
        if !unknown.is_empty() {
            return Err(format!("Unknown x-pm3.{project_name}.required_services entries: {}", unknown.join(", ")));
        }
        if required.is_empty() {
            return Ok(None);
        }

        let fallback = check_at(mapping(project.get("all"))).unwrap_or(CheckAt::Startup);
        let services = self
            .services
            .iter()
            .map(|service| {
                let check_at = check_at(mapping(named(project, &service.name))).unwrap_or(fallback);
                (service.name.clone(), service.depends_on.clone(), check_at)
            })
            .collect();
        Ok(Some(StartupConfig::new(services, required)))
    }
}

fn check_at(config: Option<&Mapping>) -> Option<CheckAt> {
    match mapping(config?.get("health"))?.get("check_at")?.as_str()? {
        "always" => Some(CheckAt::Always),
        "startup" => Some(CheckAt::Startup),
        _ => None,
    }
}

/// Looks up a mapping entry by name, also matching numeric or boolean YAML keys.
fn named<'a>(mapping: &'a Mapping, name: &str) -> Option<&'a Value> {
    mapping.iter().find(|(key, _)| key_name(key).as_deref() == Some(name)).map(|(_, value)| value)
}

fn mapping(value: Option<&Value>) -> Option<&Mapping> {
    match value? {
        Value::Mapping(mapping) => Some(mapping),
        Value::Tagged(tagged) => mapping(Some(&tagged.value)),
        _ => None,
    }
}

fn key_name(key: &Value) -> Option<String> {
    match key {
        Value::String(key) => Some(key.clone()),
        Value::Number(key) => Some(key.to_string()),
        Value::Bool(key) => Some(key.to_string()),
        _ => None,
    }
}

fn parse_service(name: String, definition: &Value) -> ServiceConfig {
    let empty = Mapping::new();
    let definition = mapping(Some(definition)).unwrap_or(&empty);
    let healthcheck = mapping(definition.get("healthcheck")).filter(|healthcheck| !healthcheck.is_empty());

    ServiceConfig {
        name,
        image: definition.get("image").and_then(Value::as_str).filter(|image| !image.is_empty()).map(str::to_owned),
        has_build: definition.get("build").is_some_and(|build| !build.is_null()),
        pull_policy: definition.get("pull_policy").and_then(Value::as_str).map(str::to_owned),
        health_wait: healthcheck.map(health_wait),
        depends_on: parse_dependencies(definition.get("depends_on")),
    }
}

/// Upper bound for a healthcheck to reach a final verdict: the start period plus every retry.
fn health_wait(healthcheck: &Mapping) -> Duration {
    let attempts = match healthcheck.get("retries") {
        Some(Value::Number(number)) => match number.as_f64() {
            Some(retries) if retries.is_finite() => {
                if retries <= 0.0 {
                    INFINITE_RETRY_ATTEMPTS
                } else {
                    retries.floor() as u32
                }
            }
            _ => DEFAULT_HEALTH_RETRIES,
        },
        Some(Value::String(retries)) => match retries.trim().parse::<u32>() {
            Ok(0) => INFINITE_RETRY_ATTEMPTS,
            Ok(retries) => retries,
            Err(_) => DEFAULT_HEALTH_RETRIES,
        },
        _ => DEFAULT_HEALTH_RETRIES,
    };
    let interval = health_duration(healthcheck.get("interval"), DEFAULT_HEALTH_INTERVAL);
    let timeout = health_duration(healthcheck.get("timeout"), DEFAULT_HEALTH_TIMEOUT);
    let start_period = health_duration(healthcheck.get("start_period"), DEFAULT_HEALTH_START_PERIOD);
    start_period.saturating_add(interval.max(timeout).saturating_mul(attempts))
}

fn health_duration(value: Option<&Value>, fallback: Duration) -> Duration {
    match value {
        Some(Value::Number(number)) => match number.as_f64() {
            Some(millis) => Duration::try_from_secs_f64(millis / 1000.0).unwrap_or(fallback),
            _ => fallback,
        },
        Some(Value::String(text)) => parse_go_duration(text).unwrap_or(fallback),
        _ => fallback,
    }
}

/// Parses Go-style durations such as `1m30s`, `500ms` or `1.5h`, rounded up to milliseconds.
fn parse_go_duration(text: &str) -> Option<Duration> {
    let text = text.trim().to_lowercase();
    if text.is_empty() || text == "disable" {
        return None;
    }

    let mut rest = text.as_str();
    let mut nanos = 0f64;
    while !rest.is_empty() {
        let number_length = rest.find(|char: char| !char.is_ascii_digit() && char != '.').unwrap_or(rest.len());
        let number = &rest[..number_length];
        if number.is_empty() || number.starts_with('.') || number.ends_with('.') || number.matches('.').count() > 1 {
            return None;
        }
        let amount: f64 = number.parse().ok()?;
        rest = &rest[number_length..];

        let (unit_nanos, unit_length) =
            [("ns", 1.0), ("us", 1e3), ("µs", 1e3), ("ms", 1e6), ("s", 1e9), ("m", 60e9), ("h", 3600e9)]
                .into_iter()
                .find_map(|(unit, nanos)| rest.starts_with(unit).then_some((nanos, unit.len())))?;
        nanos += amount * unit_nanos;
        rest = &rest[unit_length..];
    }

    Duration::try_from_secs_f64((nanos / 1e6).ceil() / 1e3).ok()
}

fn parse_dependencies(value: Option<&Value>) -> Vec<Dependency> {
    match value {
        Some(Value::Sequence(entries)) => entries
            .iter()
            .filter_map(Value::as_str)
            .filter(|service| !service.is_empty())
            .map(|service| Dependency { service: service.to_owned(), condition: Condition::Started })
            .collect(),
        Some(Value::Mapping(entries)) => entries
            .iter()
            .filter_map(|(service, value)| {
                let condition = match value {
                    Value::String(condition) => condition.as_str(),
                    value => mapping(Some(value))?.get("condition")?.as_str()?,
                };
                let condition = match condition {
                    "service_started" => Condition::Started,
                    "service_healthy" => Condition::Healthy,
                    _ => return None,
                };
                Some(Dependency { service: key_name(service)?, condition })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn is_qualified_image(image: &str) -> bool {
    image
        .split_once('/')
        .is_some_and(|(registry, _)| registry == "localhost" || registry.contains('.') || registry.contains(':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_unqualified_pullable_images() {
        let config = ComposeConfig::parse(
            "services:\n  api: {image: denoland/deno:2}\n  worker: {image: denoland/deno:2}\n  qualified: {image: docker.io/library/node:22}\n  port: {image: 'registry.example:5000/team/api:latest'}\n  local: {image: 'node:22'}\n  built: {image: local-api, build: .}\n  never: {image: unavailable, pull_policy: never}\n  host: {image: localhost/app}\n",
        )
        .unwrap();
        assert_eq!(config.pullable_short_images(), ["denoland/deno:2", "node:22"]);
    }

    #[test]
    fn rejects_non_mapping_documents() {
        assert!(ComposeConfig::parse("- a\n- b\n").is_err());
        assert!(ComposeConfig::parse("services: [").is_err());
        assert!(ComposeConfig::parse("{}").unwrap().services.is_empty());
    }

    #[test]
    fn computes_health_wait_policies() {
        let config = ComposeConfig::parse(
            "services:\n  a:\n    healthcheck: {interval: 10s, timeout: 5s, retries: 3}\n  b:\n    healthcheck: {interval: 1s, timeout: 1s, retries: 10, start_period: 1m30s}\n  c:\n    healthcheck: {test: [CMD, 'true'], retries: 0}\n  d:\n    image: x\n  e:\n    healthcheck: {interval: 'bogus', retries: '2'}\n",
        )
        .unwrap();
        let wait = |name: &str| config.services.iter().find(|service| service.name == name).unwrap().health_wait;
        assert_eq!(wait("a"), Some(Duration::from_secs(30)));
        assert_eq!(wait("b"), Some(Duration::from_secs(100)));
        assert_eq!(wait("c"), Some(Duration::from_secs(90)));
        assert_eq!(wait("d"), None);
        assert_eq!(wait("e"), Some(Duration::from_secs(60)));

        let huge = ComposeConfig::parse(
            "services:\n  a:\n    healthcheck: {interval: 100000000000h, retries: 100000, timeout: 1e300}\n",
        )
        .unwrap();
        assert!(huge.services[0].health_wait.is_some());
    }

    #[test]
    fn parses_go_durations() {
        assert_eq!(parse_go_duration("1m30s"), Some(Duration::from_secs(90)));
        assert_eq!(parse_go_duration("500ms"), Some(Duration::from_millis(500)));
        assert_eq!(parse_go_duration("1.5h"), Some(Duration::from_secs(5400)));
        assert_eq!(parse_go_duration("10us"), Some(Duration::from_millis(1)));
        assert_eq!(parse_go_duration("disable"), None);
        assert_eq!(parse_go_duration("1m 30s"), None);
        assert_eq!(parse_go_duration("5"), None);
        assert_eq!(parse_go_duration("s"), None);
    }

    #[test]
    fn parses_dependencies() {
        let config = ComposeConfig::parse(
            "services:\n  api:\n    depends_on:\n      db: {condition: service_healthy}\n      cache: {condition: service_started}\n      other: {restart: true}\n  worker:\n    depends_on: [api, '']\n",
        )
        .unwrap();
        assert_eq!(
            config.services[0].depends_on,
            [
                Dependency { service: "db".to_owned(), condition: Condition::Healthy },
                Dependency { service: "cache".to_owned(), condition: Condition::Started },
            ]
        );
        assert_eq!(
            config.services[1].depends_on,
            [Dependency { service: "api".to_owned(), condition: Condition::Started }]
        );
    }

    #[test]
    fn reads_startup_policy() {
        let text = "services:\n  api: {}\n  db: {}\nx-pm3:\n  web:\n    required_services: [api]\n    all: {health: {check_at: always}}\n    db: {health: {check_at: startup}}\n";
        let config = ComposeConfig::parse(text).unwrap();
        let startup = config.startup("web").unwrap().unwrap();
        assert_eq!(startup.required(), ["api"]);
        assert_eq!(startup.check_at("api"), CheckAt::Always);
        assert_eq!(startup.check_at("db"), CheckAt::Startup);
        assert!(config.startup("other").unwrap().is_none());

        let all =
            ComposeConfig::parse("services:\n  a: {}\n  b: {}\nx-pm3:\n  web: {required_services: all}\n").unwrap();
        assert_eq!(all.startup("web").unwrap().unwrap().required(), ["a", "b"]);

        let numeric = ComposeConfig::parse(
            "services:\n  1: {}\nx-pm3:\n  2048:\n    required_services: ['1']\n    1: {health: {check_at: always}}\n",
        )
        .unwrap();
        assert_eq!(numeric.startup("2048").unwrap().unwrap().check_at("1"), CheckAt::Always);

        let unknown =
            ComposeConfig::parse("services:\n  a: {}\nx-pm3:\n  web: {required_services: [a, b, c]}\n").unwrap();
        assert_eq!(unknown.startup("web").unwrap_err(), "Unknown x-pm3.web.required_services entries: b, c");
    }
}
