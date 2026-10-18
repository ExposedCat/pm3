use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{ALLOW, CONTENT_TYPE, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::task::TaskTracker;

use super::ipc::{DaemonMessage, Notifier};
use crate::Context;
use crate::compose::containers::{Container, compare_names, summarize};
use crate::compose::{self, StartOptions};
use crate::db::{self, Project};
use crate::error::{Error, ErrorKind, Result};
use crate::lifecycle::{self, LifecycleOperation, LifecycleRequest};
use crate::term::{eprint_line, print_line};

const DEFAULT_ADDRESS: &str = "127.0.0.1:46373";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(60);

struct ApiState {
    ctx: Context,
    database_path: PathBuf,
    messages: mpsc::UnboundedSender<DaemonMessage>,
    /// Lifecycle operations run outside request handling, so a disconnecting client can't
    /// abort them halfway.
    operations: TaskTracker,
}

pub struct ApiServer {
    task: JoinHandle<()>,
    operations: TaskTracker,
}

impl ApiServer {
    pub async fn start(
        ctx: Context,
        database_path: PathBuf,
        messages: mpsc::UnboundedSender<DaemonMessage>,
    ) -> Result<Self> {
        let address = std::env::var("PM3_API_ADDRESS")
            .ok()
            .filter(|address| !address.is_empty())
            .unwrap_or_else(|| DEFAULT_ADDRESS.to_owned());
        let address: SocketAddr =
            address.parse().map_err(|_| Error::failure(format!("Invalid PM3_API_ADDRESS: {address}")))?;
        let listener = TcpListener::bind(address)
            .await
            .map_err(|error| Error::failure(format!("Failed to listen on {address}: {error}")))?;
        print_line(&format!("PM3 API listening on http://{address}"));

        let operations = TaskTracker::new();
        let state = Arc::new(ApiState { ctx, database_path, messages, operations: operations.clone() });
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        let state = Arc::clone(&state);
                        async move { Ok::<_, Infallible>(handle(&state, request).await) }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                });
            }
        });
        Ok(Self { task, operations })
    }

    /// Stops accepting requests and lets running lifecycle operations finish.
    pub async fn stop(self) {
        self.task.abort();
        self.operations.close();
        if tokio::time::timeout(SHUTDOWN_GRACE, self.operations.wait()).await.is_err() {
            eprint_line("Lifecycle operations did not finish before shutdown");
        }
    }
}

fn json_response(status: StatusCode, body: &Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
    *response.status_mut() = status;
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    response
}

fn error_response(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    json_response(status, &json!({ "error": message }))
}

fn failure_response(error: &Error) -> Response<Full<Bytes>> {
    let status = match error.kind {
        ErrorKind::Usage | ErrorKind::Input => StatusCode::BAD_REQUEST,
        ErrorKind::Failure => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let message = if error.message.is_empty() { "Command failed" } else { &error.message };
    error_response(status, message)
}

async fn handle(state: &ApiState, request: Request<Incoming>) -> Response<Full<Bytes>> {
    let path = request.uri().path().trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    let query = parse_query(request.uri().query().unwrap_or(""));

    if request.method() == Method::GET && path == "/projects" {
        return match flag(&query, &Map::new(), &["detailed", "d"]) {
            Ok(detailed) => list_projects(state, detailed.unwrap_or(false)).await,
            Err(error) => failure_response(&error),
        };
    }

    let Some((name, action)) = path
        .strip_prefix("/projects/")
        .and_then(|rest| rest.split_once('/'))
        .filter(|(name, action)| !name.is_empty() && matches!(*action, "start" | "stop" | "restart" | "show"))
    else {
        return error_response(StatusCode::NOT_FOUND, "Not found");
    };

    if request.method() != Method::POST {
        let mut response =
            error_response(StatusCode::METHOD_NOT_ALLOWED, &format!("Method {} not allowed", request.method()));
        response.headers_mut().insert(ALLOW, HeaderValue::from_static("POST"));
        return response;
    }

    let Some(name) = percent_decode(name, false) else {
        return error_response(StatusCode::BAD_REQUEST, "Invalid project name");
    };
    let project = match db::connect(&state.database_path).and_then(|connection| db::project_by_name(&connection, &name))
    {
        Ok(Some(project)) => project,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, &format!("Project not found: {name}")),
        Err(error) => return failure_response(&error),
    };

    let operation = match action {
        "start" => LifecycleOperation::Start,
        "stop" => LifecycleOperation::Stop,
        "restart" => LifecycleOperation::Restart,
        _ => return show_response(&project).await,
    };

    let body = match request.into_body().collect().await {
        Ok(body) => body.to_bytes(),
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Failed to read request body"),
    };
    let Some(body) = parse_body(&body) else {
        return error_response(StatusCode::BAD_REQUEST, "Request body must be valid JSON");
    };
    let start = match lifecycle_options(operation, &query, &body) {
        Ok(start) => start,
        Err(error) => return failure_response(&error),
    };

    let request = LifecycleRequest { operation, start, down_args: Vec::new() };
    let mut notifier = Notifier::Queue(state.messages.clone());
    let ctx = state.ctx.clone();
    let operation_project = project.clone();
    let operation =
        state.operations.spawn(async move { lifecycle::run(&ctx, &operation_project, &request, &mut notifier).await });
    match operation.await {
        Ok(Ok(())) => show_response(&project).await,
        Ok(Err(error)) => failure_response(&error),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "Command failed"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListItem {
    created: String,
    enabled: bool,
    name: String,
    ports: String,
    state: String,
    working_dir: String,
}

async fn list_projects(state: &ApiState, detailed: bool) -> Response<Full<Bytes>> {
    let projects = match db::connect(&state.database_path).and_then(|connection| db::list_projects(&connection)) {
        Ok(projects) => projects,
        Err(error) => return failure_response(&error),
    };
    let summaries = compose::summarize_projects(&projects, detailed).await;
    let projects: Vec<ProjectListItem> = projects
        .into_iter()
        .zip(summaries)
        .map(|(project, summary)| ProjectListItem {
            created: summary.created,
            enabled: project.enabled,
            name: project.name,
            ports: summary.ports,
            state: summary.state,
            working_dir: project.working_dir,
        })
        .collect();
    json_response(StatusCode::OK, &json!({ "projects": projects }))
}

#[derive(Serialize)]
struct ServiceItem {
    ports: String,
    service: String,
    state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDetails {
    created: String,
    enabled: bool,
    name: String,
    ports: String,
    services: Vec<ServiceItem>,
    state: String,
    working_dir: String,
}

async fn show_response(project: &Project) -> Response<Full<Bytes>> {
    match project_details(project).await {
        Ok(details) => json_response(StatusCode::OK, &json!({ "project": details })),
        Err(error) => failure_response(&error),
    }
}

async fn project_details(project: &Project) -> Result<ProjectDetails> {
    let (containers, services) = tokio::join!(compose::project_containers(project), compose::list_services(project));
    let containers = containers.map_err(Error::failure)?;
    let services = services
        .map_err(|message| Error::input(format!("Failed to list compose services for {}: {message}", project.name)))?;

    let mut names: Vec<String> = services.unwrap_or_else(|| {
        let mut names: Vec<String> = Vec::new();
        for container in &containers {
            if !container.service.is_empty() && !names.contains(&container.service) {
                names.push(container.service.clone());
            }
        }
        names
    });
    names.sort_by(|left, right| compare_names(left, right));
    names.dedup();

    let summary = summarize(&containers.iter().collect::<Vec<_>>(), true);
    let services = names
        .into_iter()
        .map(|service| {
            let service_containers: Vec<&Container> =
                containers.iter().filter(|container| container.service == service).collect();
            let summary = summarize(&service_containers, true);
            ServiceItem { ports: summary.ports, service, state: summary.state }
        })
        .collect();

    Ok(ProjectDetails {
        created: summary.created,
        enabled: project.enabled,
        name: project.name.clone(),
        ports: summary.ports,
        services,
        state: summary.state,
        working_dir: project.working_dir.clone(),
    })
}

fn parse_body(body: &[u8]) -> Option<Map<String, Value>> {
    let text = std::str::from_utf8(body).ok()?;
    if text.trim().is_empty() {
        return Some(Map::new());
    }
    match serde_json::from_str::<Value>(text).ok()? {
        Value::Object(object) => Some(object),
        _ => Some(Map::new()),
    }
}

fn lifecycle_options(
    operation: LifecycleOperation,
    query: &[(String, String)],
    body: &Map<String, Value>,
) -> Result<StartOptions> {
    let build = flag(query, body, &["build", "b"])?;
    let no_build = flag(query, body, &["noBuild", "no-build"])?;
    let git = flag(query, body, &["git", "g"])?;
    let local = flag(query, body, &["local", "l"])?;
    if git == Some(true) && local == Some(true) {
        return Err(Error::input("Cannot use git with local"));
    }

    Ok(StartOptions {
        build: if no_build == Some(true) { false } else { build.unwrap_or(operation == LifecycleOperation::Restart) },
        git: if local == Some(true) { Some(false) } else { git },
        no_cache: flag(query, body, &["noCache", "no-cache", "c"])?.unwrap_or(false),
        up_args: Vec::new(),
        detached: false,
        track_health: true,
    })
}

/// Reads a boolean flag from the JSON body first, then from the query string.
fn flag(query: &[(String, String)], body: &Map<String, Value>, names: &[&str]) -> Result<Option<bool>> {
    for name in names {
        if let Some(value) = body.get(*name) {
            return parse_boolean(value, name).map(Some);
        }
    }
    for name in names {
        if let Some((_, value)) = query.iter().find(|(key, _)| key == name) {
            return parse_boolean(&Value::String(value.clone()), name).map(Some);
        }
    }
    Ok(None)
}

fn parse_boolean(value: &Value, name: &str) -> Result<bool> {
    match value {
        Value::Bool(value) => return Ok(*value),
        Value::Number(number) if number.as_f64() == Some(1.0) => return Ok(true),
        Value::Number(number) if number.as_f64() == Some(0.0) => return Ok(false),
        Value::String(text) => match text.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => return Ok(true),
            "" | "0" | "false" | "no" | "off" => return Ok(false),
            _ => {}
        },
        _ => {}
    }
    Err(Error::input(format!("Invalid boolean value for {name}")))
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let decode = |text: &str| percent_decode(text, true).unwrap_or_else(|| text.replace('+', " "));
            (decode(key), decode(value))
        })
        .collect()
}

/// Decodes `%XX` escapes (and `+` as space in query strings). `None` for malformed input.
fn percent_decode(text: &str, plus_as_space: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = text.get(index + 1..index + 3)?;
                decoded.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'+' if plus_as_space => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_queries_and_percent_escapes() {
        assert_eq!(
            parse_query("build=1&name=a%20b+c&d"),
            [("build", "1"), ("name", "a b c"), ("d", "")].map(|(key, value)| (key.to_owned(), value.to_owned()))
        );
        assert_eq!(percent_decode("my%2Fapp", false).as_deref(), Some("my/app"));
        assert_eq!(percent_decode("a+b", false).as_deref(), Some("a+b"));
        assert_eq!(percent_decode("bad%zz", false), None);
        assert_eq!(percent_decode("bad%f", false), None);
    }

    #[test]
    fn reads_lifecycle_flags_from_body_then_query() {
        let query = parse_query("build=0&g=yes");
        let body = parse_body(br#"{"build": true, "noCache": 1}"#).unwrap();
        let options = lifecycle_options(LifecycleOperation::Start, &query, &body).unwrap();
        assert!(options.build && options.no_cache);
        assert_eq!(options.git, Some(true));

        let restart = lifecycle_options(LifecycleOperation::Restart, &[], &Map::new()).unwrap();
        assert!(restart.build && !restart.no_cache && restart.git.is_none());
        let no_build =
            lifecycle_options(LifecycleOperation::Restart, &parse_query("no-build=true"), &Map::new()).unwrap();
        assert!(!no_build.build);
        let local = lifecycle_options(LifecycleOperation::Start, &parse_query("l=1"), &Map::new()).unwrap();
        assert_eq!(local.git, Some(false));

        assert_eq!(
            lifecycle_options(LifecycleOperation::Start, &parse_query("git=1&local=1"), &Map::new())
                .unwrap_err()
                .message,
            "Cannot use git with local"
        );
        assert_eq!(
            lifecycle_options(LifecycleOperation::Start, &parse_query("build=maybe"), &Map::new()).unwrap_err().message,
            "Invalid boolean value for build"
        );
    }

    #[test]
    fn parses_request_bodies() {
        assert_eq!(parse_body(b"").unwrap().len(), 0);
        assert_eq!(parse_body(b"  ").unwrap().len(), 0);
        assert_eq!(parse_body(b"[1]").unwrap().len(), 0);
        assert!(parse_body(b"{bad").is_none());
    }
}
