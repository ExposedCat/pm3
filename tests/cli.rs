//! End-to-end CLI tests against fake `podman`, `podman-compose` and `git` executables that
//! record their arguments and replay canned output from the fixture directory.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const FAKE_TOOL: &str = r#"#!/bin/sh
tool=$(basename "$0")
printf '%s %s\n' "$tool" "$*" >> "$FAKE_DIR/calls.log"
case "$tool $*" in
  "git rev-parse --is-inside-work-tree") cat "$FAKE_DIR/git-repo" 2>/dev/null || echo true ;;
  "git rev-parse --verify HEAD") echo abc123 ;;
  "git rev-list "*) echo 2 ;;
  "git "*) ;;
  "podman ps "*) cat "$FAKE_DIR/ps.json" 2>/dev/null || echo '[]' ;;
  "podman image exists "*) ;;
  "podman events "*) ;;
  "podman logs "*)
    for id; do :; done
    cat "$FAKE_DIR/logs-$id.txt" 2>/dev/null ;;
  "podman-compose"*" config --services") cat "$FAKE_DIR/services.txt" 2>/dev/null ;;
  "podman-compose"*" config") cat "$FAKE_DIR/config.yaml" 2>/dev/null || echo 'services: {}' ;;
  "podman-compose"*" ps "*) cat "$FAKE_DIR/compose-ps.json" 2>/dev/null || echo '[]' ;;
  "podman-compose "*) cat "$FAKE_DIR/compose-output.txt" 2>/dev/null; exit $(cat "$FAKE_DIR/compose-exit" 2>/dev/null || echo 0) ;;
esac
"#;

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "pm3-cli-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for tool in ["podman", "podman-compose", "git"] {
            let path = bin.join(tool);
            fs::write(&path, FAKE_TOOL).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::create_dir_all(dir.join("project")).unwrap();
        fs::write(dir.join("project/compose.yaml"), "services: {}\n").unwrap();
        Self { dir }
    }

    fn project_dir(&self) -> String {
        fs::canonicalize(self.dir.join("project")).unwrap().to_string_lossy().into_owned()
    }

    fn write(&self, name: &str, content: &str) {
        fs::write(self.dir.join(name), content).unwrap();
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pm3"));
        command
            .args(args)
            .env("PATH", format!("{}:/usr/bin:/bin", self.dir.join("bin").display()))
            .env("FAKE_DIR", &self.dir)
            .env("PM3_DATABASE_PATH", self.dir.join("pm3.sqlite"))
            .env("PM3_DAEMON_SOCKET", self.dir.join("daemon.sock"))
            .env_remove("COMPOSE_FILE")
            .stdin(Stdio::null());
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn run_with_input(&self, args: &[&str], input: &str) -> Output {
        let mut child = self.command(args).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.join("calls.log")).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    fn clear_calls(&self) {
        let _ = fs::remove_file(self.dir.join("calls.log"));
    }

    fn create(&self, name: &str, workdir: &str, compose_args: &[&str]) {
        let mut args = vec!["create", workdir, "--name", name];
        if !compose_args.is_empty() {
            args.push("--");
            args.extend(compose_args);
        }
        assert_success(&self.run(&args));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn plain(text: &str) -> String {
    let mut output = String::new();
    let mut chars = text.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\x1b' && chars.peek() == Some(&'[') {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            output.push(char);
        }
    }
    output
}

fn assert_success(output: &Output) {
    assert!(output.status.success(), "stdout: {}\nstderr: {}", stdout(output), stderr(output));
}

fn assert_failure(output: &Output, message: &str) {
    assert!(!output.status.success(), "unexpected success: {}", stdout(output));
    assert_eq!(stderr(output).trim_end(), message);
}

#[test]
fn create_reports_duplicates_and_resolves_paths() {
    let fixture = Fixture::new();
    let project = fixture.project_dir();
    let output =
        fixture.run(&["create", &format!("{project}/../project/."), "--name", "api", "--", "-f", "compose.yaml"]);
    assert_success(&output);
    assert_eq!(stdout(&output), "Created api with compose arguments `-f compose.yaml`\nStart with `pm3 start api`\n");
    assert_failure(&fixture.run(&["create", "/second", "--name", "api"]), "Project api already exists");

    let view = plain(&stdout(&fixture.run(&["view", "api"])));
    assert!(view.contains(&format!("Workdir: {project}\n")), "{view}");
}

#[test]
fn start_and_stop_pass_operation_arguments() {
    let fixture = Fixture::new();
    fixture.create("api", &fixture.project_dir(), &["-f", "compose.yaml"]);

    assert_success(&fixture.run(&["start", "api", "--build", "--", "--scale", "worker=2"]));
    let calls = fixture.calls();
    assert!(calls.contains(&"podman-compose -f compose.yaml build".to_owned()), "{calls:?}");
    assert!(
        calls.contains(&"podman-compose -f compose.yaml up -d --force-recreate --scale worker=2".to_owned()),
        "{calls:?}"
    );

    fixture.clear_calls();
    assert_success(&fixture.run(&["stop", "api", "--", "--timeout", "30"]));
    assert!(fixture.calls().contains(&"podman-compose -f compose.yaml down --remove-orphans --timeout 30".to_owned()));

    fixture.clear_calls();
    assert_success(&fixture.run(&["restart", "api", "--no-build"]));
    let calls = fixture.calls();
    let down = calls.iter().position(|call| call.ends_with("down --remove-orphans")).unwrap();
    let up = calls.iter().position(|call| call.ends_with("up -d")).unwrap();
    assert!(down < up, "{calls:?}");
    assert!(!calls.iter().any(|call| call.ends_with(" build")), "{calls:?}");
}

#[test]
fn compose_failures_surface_their_output() {
    let fixture = Fixture::new();
    fixture.create("api", &fixture.project_dir(), &[]);
    fixture.write("compose-output.txt", "Error: something broke\n");
    fixture.write("compose-exit", "3");
    assert_failure(&fixture.run(&["stop", "api"]), "Error: something broke");
}

#[test]
fn detached_lifecycle_preserves_operation_arguments() {
    let fixture = Fixture::new();
    fixture.create("api", &fixture.project_dir(), &[]);
    assert_success(&fixture.run(&["start", "api", "--detach", "--", "--scale", "worker=2"]));

    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.calls().iter().any(|call| call == "podman-compose up -d --scale worker=2") {
        assert!(Instant::now() < deadline, "detached start never ran: {:?}", fixture.calls());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn remove_reports_invalid_cwd_and_force_removes() {
    let fixture = Fixture::new();
    let missing = fixture.dir.join("missing").to_string_lossy().into_owned();
    fixture.create("safe", &missing, &["-f", "compose.yaml"]);

    assert_failure(
        &fixture.run(&["rm", "safe"]),
        &format!("Project safe has invalid cwd '{missing}'\nRetry with `--force` to remove as is"),
    );
    assert!(fixture.calls().is_empty());

    assert_success(&fixture.run(&["rm", "safe", "--force"]));
    assert_failure(&fixture.run(&["view", "safe"]), "Project not found: safe");
    assert_failure(&fixture.run(&["rm", "safe"]), "Failed to remove project: \"safe\" not found");
}

#[test]
fn remove_refuses_running_projects() {
    let fixture = Fixture::new();
    let project = fixture.project_dir();
    fixture.create("api", &project, &[]);
    fixture.write(
        "ps.json",
        &format!(
            r#"[{{"Id":"a1","Names":["api_web_1"],"State":"running","Status":"Up","Labels":{{"io.podman.compose.project":"project","io.podman.compose.service":"web","com.docker.compose.project.working_dir":"{project}"}}}}]"#
        ),
    );
    assert_failure(&fixture.run(&["rm", "api"]), "Failed to remove project: \"api\" is running");

    fixture.write("ps.json", "[]");
    assert_success(&fixture.run(&["rm", "api"]));
    assert!(fixture.calls().contains(&"podman-compose down --volumes --rmi all --remove-orphans".to_owned()));
}

#[test]
fn list_marks_broken_projects_invalid() {
    let fixture = Fixture::new();
    let project = fixture.project_dir();
    fixture.create("broken", "/nonexistent/pm3/project", &["-f", "compose.yaml"]);
    fixture.create("working", &project, &[]);
    fixture.create("running", &project, &["-p", "running"]);
    fixture.write(
        "ps.json",
        &format!(
            r#"[{{"Id":"a1","Names":["running_web_1"],"State":"running","Status":"Up","Created":1,"StartedAt":1,"Ports":[{{"host_ip":"","container_port":80,"host_port":8080,"protocol":"tcp"}}],
                "Labels":{{"io.podman.compose.project":"running","io.podman.compose.service":"web","com.docker.compose.project.working_dir":"{project}"}}}}]"#
        ),
    );

    let output = fixture.run(&["list", "--detailed"]);
    assert_success(&output);
    let lines: Vec<String> =
        plain(&stdout(&output)).lines().map(|line| line.split_whitespace().collect::<Vec<_>>().join(" ")).collect();
    assert_eq!(lines[0], "NAME STATE STARTUP CREATED PORTS");
    assert!(lines[1].starts_with("broken invalid disabled"), "{lines:?}");
    assert!(lines[2].starts_with("running up ("), "{lines:?}");
    assert!(lines[2].ends_with("0.0.0.0:8080->80/tcp"), "{lines:?}");
    assert_eq!(lines[3], "working down disabled");

    // One listing for everything; podman-compose only resolves the directory shared by two projects.
    let calls = fixture.calls();
    assert_eq!(calls.iter().filter(|call| call.starts_with("podman ps")).count(), 1, "{calls:?}");
    assert_eq!(
        calls.iter().filter(|call| call.starts_with("podman-compose")).collect::<Vec<_>>(),
        ["podman-compose ps --format json"]
    );
}

#[test]
fn view_renders_services_and_errors() {
    let fixture = Fixture::new();
    let project = fixture.project_dir();
    fixture.create("api", &project, &["-f", "compose.yaml", "--profile", "production"]);
    fixture.write("services.txt", "web\nworker\n");
    fixture.write(
        "ps.json",
        &format!(
            r#"[{{"Id":"a1","Names":["project_web_1"],"State":"running","Status":"Up","Created":1,"StartedAt":1,
                "Ports":[{{"host_ip":"127.0.0.1","container_port":80,"host_port":8080,"protocol":"tcp"}}],
                "Labels":{{"io.podman.compose.project":"project","io.podman.compose.service":"web","com.docker.compose.project.working_dir":"{project}"}}}}]"#
        ),
    );

    let output = plain(&stdout(&fixture.run(&["view", "api"])));
    assert!(output.starts_with("● api - up"), "{output}");
    assert!(output.contains("Creation args: -f compose.yaml --profile production"));
    assert!(output.contains("● web - up"));
    assert!(output.contains("Published ports: 127.0.0.1:8080->80/tcp"));
    assert!(output.contains("● worker - down\n        Published ports: -"));

    fixture.create("broken", &project, &["-f", "missing.yaml"]);
    let output = plain(&stdout(&fixture.run(&["view", "broken"])));
    assert!(output.starts_with("● broken - invalid"), "{output}");
    assert!(output.contains("Failed to inspect containers: Missing compose files: missing.yaml"), "{output}");
}

#[test]
fn git_mode_validates_repositories() {
    let fixture = Fixture::new();
    fixture.create("api", &fixture.project_dir(), &[]);

    fixture.write("git-repo", "false");
    assert_failure(&fixture.run(&["git", "yes", "api"]), "Project is not a git repository: api");
    fixture.write("git-repo", "true");
    let output = fixture.run(&["git", "on", "api"]);
    assert_success(&output);
    assert_eq!(stdout(&output), "Git pulling enabled for api\n");
    assert!(fixture.calls().contains(&"git rev-parse --is-inside-work-tree".to_owned()));

    fixture.clear_calls();
    assert_success(&fixture.run(&["start", "api"]));
    let calls = fixture.calls();
    let pull = calls.iter().position(|call| call == "git pull --ff-only").expect("git pull");
    let up = calls.iter().position(|call| call.ends_with("up -d")).expect("compose up");
    assert!(pull < up, "{calls:?}");

    fixture.clear_calls();
    assert_success(&fixture.run(&["start", "api", "--local"]));
    assert!(!fixture.calls().iter().any(|call| call.starts_with("git")));

    assert_eq!(stdout(&fixture.run(&["git", "disable", "api"])), "Git pulling disabled for api\n");
}

#[test]
fn commands_without_a_project_confirm_first() {
    let fixture = Fixture::new();
    fixture.create("api", &fixture.project_dir(), &[]);
    fixture.create("web", &fixture.project_dir(), &[]);

    let output = fixture.run_with_input(&["enable"], "n\n");
    assert_success(&output);
    assert_eq!(stdout(&output), "Are you sure to execute 'enable' on 2 projects? [Y/n] Aborted\n");

    let output = fixture.run(&["enable", "--yes"]);
    assert_eq!(stdout(&output), "Enabled api\nEnabled web\n");
    let output = fixture.run_with_input(&["disable"], "y\n");
    assert_eq!(stdout(&output), "Are you sure to execute 'disable' on 2 projects? [Y/n] Disabled api\nDisabled web\n");
    assert_eq!(stdout(&fixture.run(&["enable", "api"])), "Enabled api\n");

    let list = plain(&stdout(&fixture.run(&["list", "-d"])));
    assert!(list.contains("api   down   enabled"), "{list}");
    assert!(list.contains("web   down   disabled"), "{list}");
}

#[test]
fn logs_merge_services_chronologically() {
    let fixture = Fixture::new();
    let project = fixture.project_dir();
    fixture.create("api", &project, &[]);
    let container = |id: &str, service: &str| {
        format!(
            r#"{{"Id":"{id}","Names":["project_{service}_1"],"State":"running","Status":"Up",
                "Labels":{{"io.podman.compose.project":"project","io.podman.compose.service":"{service}","com.docker.compose.project.working_dir":"{project}"}}}}"#
        )
    };
    fixture.write("ps.json", &format!("[{},{}]", container("w1", "web"), container("d1", "db")));
    fixture.write(
        "logs-w1.txt",
        "2026-01-01T00:00:01.000000000+00:00 web one\n2026-01-01T00:00:03.000000000+00:00 web three\n",
    );
    fixture.write("logs-d1.txt", "2026-01-01T01:00:02.000000000+01:00 db two\n");

    let output = fixture.run(&["logs", "api", "--since", "start", "--once", "--raw"]);
    assert_success(&output);
    assert_eq!(plain(&stdout(&output)), "web | web one\ndb | db two\nweb | web three\n");
    assert!(fixture.calls().contains(&"podman logs --timestamps w1".to_owned()));

    let output = fixture.run(&["logs", "api", "db", "--lines", "5", "--once", "--raw"]);
    assert_eq!(plain(&stdout(&output)), "db two\n");
    assert!(fixture.calls().contains(&"podman logs --timestamps --tail 5 d1".to_owned()));

    assert_failure(&fixture.run(&["logs", "api", "cache"]), "No compose containers found for service: cache");

    // Two containers of one service: `--lines` applies to the service, lines carry the container name.
    let replica = container("w2", "web").replace("project_web_1", "project_web_2");
    fixture.write("ps.json", &format!("[{},{replica}]", container("w1", "web")));
    fixture.write("logs-w2.txt", "2026-01-01T00:00:02.000000000+00:00 web two\n");
    let output = fixture.run(&["logs", "api", "--lines", "2", "--once", "--raw"]);
    assert_eq!(plain(&stdout(&output)), "project_web_2 web two\nproject_web_1 web three\n");
}

#[test]
fn usage_errors_exit_with_failure() {
    let fixture = Fixture::new();
    assert_failure(&fixture.run(&["show", "api"]), "Unknown command: show");
    assert_failure(&fixture.run(&["restart", "api", "--", "-t"]), "Unknown option for restart: --");
    assert_failure(&fixture.run(&["start"]), "No projects registered.");
    let help = fixture.run(&[]);
    assert_success(&help);
    assert!(stdout(&help).starts_with("pm3 = pm2 + podman\n\nUsage:\n"));
    assert!(Path::new(&fixture.dir.join("pm3.sqlite")).exists());
}
