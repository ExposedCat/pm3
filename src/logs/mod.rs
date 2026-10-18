mod pager;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{IsTerminal, Write};
use std::os::fd::OwnedFd;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use futures_util::future::join_all;
use tokio::net::unix::pipe;
use tokio::process::Child;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{mpsc, watch};

use self::pager::{LogLine, PagerOptions};
use crate::Context;
use crate::compose::{self, PODMAN};
use crate::db::Project;
use crate::error::{Error, Result};
use crate::process::{self, LineReader};
use crate::term::{
    blue, cyan, fit_column, green, magenta, print_line, red, stdout_is_terminal, terminal_columns, yellow,
};
use crate::time::{now_iso, parse_rfc3339_nanos};

const PALETTE: [fn(&str) -> String; 6] = [cyan, green, yellow, blue, magenta, red];
const MIN_COLUMN_WIDTH: usize = 12;
const DEFAULT_CONSOLE_WIDTH: usize = 120;
const STOP_GRACE: Duration = Duration::from_secs(1);
/// Rows kept to re-layout column output after a terminal resize.
const SCREEN_ROWS: usize = 10_000;
/// Window drags emit bursts of resize signals; redraw once they settle.
const RESIZE_DEBOUNCE: Duration = Duration::from_millis(80);
/// Lines buffered between the log readers and the pager.
const PAGER_BACKLOG: usize = 4096;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogsOptions {
    pub services: Vec<String>,
    pub since: Option<String>,
    pub lines: Option<u64>,
    pub raw: bool,
    pub once: bool,
    /// Stream plain output instead of opening the pager.
    pub flat: bool,
}

/// One displayed log source: a service, possibly backed by several containers.
struct Target {
    label: String,
    containers: Vec<(String, String)>,
}

pub async fn show(ctx: &Context, projects: &[Project], options: &LogsOptions) -> Result<()> {
    let mut targets = Vec::new();
    for project in projects {
        let label_prefix = (projects.len() > 1).then(|| format!("{}/", project.name));
        for (service, containers) in resolve_targets(project, options).await? {
            let label = format!("{}{service}", label_prefix.as_deref().unwrap_or(""));
            targets.push(Target { label, containers });
        }
    }

    let labels: Vec<String> = targets.iter().map(|target| target.label.clone()).collect();
    let sources: Vec<Source> = targets
        .iter()
        .enumerate()
        .flat_map(|(target, entry)| {
            let named = entry.containers.len() > 1;
            entry.containers.iter().map(move |(id, name)| Source {
                target,
                id: id.clone(),
                prefix: named.then(|| name.clone()),
            })
        })
        .collect();

    if !options.flat && stdout_is_terminal() && std::io::stdin().is_terminal() {
        let title = projects.iter().map(|project| project.name.as_str()).collect::<Vec<_>>().join(", ");
        let (sender, receiver) = mpsc::channel(PAGER_BACKLOG);
        // The producer gets its own token, so quitting the pager stops it without interrupting pm3.
        let producer_ctx = Context { verbose: ctx.verbose, cancel: ctx.cancel.child_token() };
        let producer = async {
            let sink = Sink::Pager(sender);
            produce(&producer_ctx, &sources, options, &sink).await
        };
        let pager_options = PagerOptions { title, labels, flat: options.raw, live: !options.once };
        return pager::run(ctx, pager_options, receiver, producer, &producer_ctx.cancel).await;
    }

    let screen = (!options.raw && stdout_is_terminal())
        .then(watch_resizes)
        .flatten()
        .map(|resizes| RefCell::new(Screen { rows: VecDeque::new(), resizes }));
    let printer = Printer { raw: options.raw, labels, screen };
    if !options.raw && !printer.header() {
        return Ok(());
    }
    produce(ctx, &sources, options, &Sink::Print(printer)).await
}

/// Reads the requested history and/or live logs of all sources into `sink`.
async fn produce(ctx: &Context, sources: &[Source], options: &LogsOptions, sink: &Sink) -> Result<()> {
    if options.once {
        let since = since_argument(options);
        return print_history(ctx, sources, sink, since.as_deref(), None, options.lines).await;
    }

    if options.lines.is_none() && options.since.is_none() {
        let streams = spawn_follow_streams(sources, &now_iso())?;
        return consume_follow_streams(ctx, sources, sink, streams).await;
    }

    let checkpoint = now_iso();
    let follow_streams = spawn_follow_streams(sources, &checkpoint)?;
    let since = since_argument(options);
    print_history(ctx, sources, sink, since.as_deref(), Some(&checkpoint), options.lines).await?;
    consume_follow_streams(ctx, sources, sink, follow_streams).await
}

async fn resolve_targets(project: &Project, options: &LogsOptions) -> Result<Vec<(String, Vec<(String, String)>)>> {
    if !compose::has_compose_file(project) {
        return Err(Error::input(format!("Compose file not found for project: {}", project.name)));
    }

    let containers = compose::project_containers(project).await.map_err(Error::failure)?;
    let mut by_service: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for container in
        containers.into_iter().filter(|container| !container.service.is_empty() && !container.id.is_empty())
    {
        let entry = (container.id, container.name);
        match by_service.iter_mut().find(|(service, _)| *service == container.service) {
            Some((_, containers)) => containers.push(entry),
            None => by_service.push((container.service, vec![entry])),
        }
    }

    let targets = if options.services.is_empty() {
        by_service
    } else {
        options
            .services
            .iter()
            .map(|service| {
                by_service
                    .iter()
                    .find(|(candidate, _)| candidate == service)
                    .cloned()
                    .ok_or_else(|| Error::input(format!("No compose containers found for service: {service}")))
            })
            .collect::<Result<_>>()?
    };

    if targets.is_empty() {
        return Err(Error::input(format!("No compose containers found for project: {}", project.name)));
    }
    Ok(targets)
}

/// `--since` for podman: explicit value, none for `start` or `--lines`, otherwise "now".
fn since_argument(options: &LogsOptions) -> Option<String> {
    match options.since.as_deref() {
        Some("start") => None,
        Some(since) => Some(since.to_owned()),
        None if options.lines.is_some() => None,
        None => Some(now_iso()),
    }
}

struct Source {
    target: usize,
    id: String,
    /// Container name shown before each line when a service has several containers.
    prefix: Option<String>,
}

impl Source {
    fn label_line(&self, message: &str) -> String {
        match &self.prefix {
            Some(name) => format!("{name} {message}"),
            None => message.to_owned(),
        }
    }
}

/// Where log lines go: straight to the terminal, or into the pager.
enum Sink {
    Print(Printer),
    Pager(mpsc::Sender<LogLine>),
}

impl Sink {
    /// Emits one line. Returns `false` once the consumer is gone (closed stdout, quit pager).
    async fn emit(&self, source: &Source, message: &str) -> bool {
        match self {
            Self::Print(printer) => printer.line(source.target, &source.label_line(message)),
            Self::Pager(sender) => {
                sender.send(LogLine { target: source.target, text: source.label_line(message) }).await.is_ok()
            }
        }
    }
}

struct LogProcess {
    child: Child,
    reader: LineReader<pipe::Receiver>,
}

/// Starts `podman logs` with stdout and stderr on one pipe, so lines keep podman's order.
fn spawn_logs(source: &Source, args: &[String]) -> Result<LogProcess> {
    let (reader, writer) = std::io::pipe()?;
    let child = {
        let mut command = process::command(PODMAN, args.iter().chain([&source.id]), None::<&Path>);
        command.stdout(Stdio::from(writer.try_clone()?)).stderr(Stdio::from(writer));
        process::spawn(&mut command)?
    };
    let reader = pipe::Receiver::from_owned_fd(OwnedFd::from(reader))?;
    Ok(LogProcess { child, reader: LineReader::new(reader) })
}

async fn read_line(reader: &mut LineReader<pipe::Receiver>) -> Option<String> {
    reader.next_line().await.map(|line| line.replace('\r', ""))
}

/// Stops all `podman logs` processes and returns the first real failure. Processes killed by a
/// signal (e.g. the user's Ctrl-C reaching the whole process group) don't count as failures.
async fn stop_processes(children: impl IntoIterator<Item = &mut Child>) -> Option<i32> {
    let children: Vec<&mut Child> = children.into_iter().collect();
    for child in &children {
        process::terminate(child);
    }
    let codes = join_all(children.into_iter().map(|child| async move {
        let status = match tokio::time::timeout(STOP_GRACE, child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                process::kill(child);
                child.wait().await.ok()
            }
        };
        status.map(process::exit_code)
    }))
    .await;
    codes.into_iter().flatten().find(|code| *code != 0 && *code <= 128)
}

struct HistoryStream<'a> {
    source: &'a Source,
    process: LogProcess,
    head: Option<(i128, String)>,
    last_timestamp: i128,
    done: bool,
}

impl HistoryStream<'_> {
    async fn fill(&mut self) {
        while self.head.is_none() && !self.done {
            match read_line(&mut self.process.reader).await {
                None => self.done = true,
                Some(line) => {
                    let (timestamp, message) = match line.split_once(' ') {
                        Some((timestamp, message)) => match parse_rfc3339_nanos(timestamp) {
                            Some(timestamp) => (timestamp, message.to_owned()),
                            None => (self.last_timestamp, line),
                        },
                        None => match parse_rfc3339_nanos(&line) {
                            Some(timestamp) => (timestamp, String::new()),
                            None => (self.last_timestamp, line),
                        },
                    };
                    self.last_timestamp = timestamp;
                    if !message.is_empty() {
                        self.head = Some((timestamp, message));
                    }
                }
            }
        }
    }
}

/// Prints a bounded log range of all sources, merged chronologically while streaming.
async fn print_history(
    ctx: &Context,
    sources: &[Source],
    sink: &Sink,
    since: Option<&str>,
    until: Option<&str>,
    tail: Option<u64>,
) -> Result<()> {
    let mut args = vec!["logs".to_owned(), "--timestamps".to_owned()];
    if let Some(since) = since {
        args.extend(["--since".to_owned(), since.to_owned()]);
    }
    if let Some(until) = until {
        args.extend(["--until".to_owned(), until.to_owned()]);
    }
    if let Some(tail) = tail {
        args.extend(["--tail".to_owned(), tail.to_string()]);
    }

    let mut streams = Vec::with_capacity(sources.len());
    for source in sources {
        streams.push(HistoryStream {
            source,
            process: spawn_logs(source, &args)?,
            head: None,
            last_timestamp: i128::MIN,
            done: false,
        });
    }

    // podman applies `--tail` per container; services with several containers are cut to the
    // requested count after merging. The buffer is bounded by tail × containers.
    let per_service_tail = tail.filter(|_| sources.iter().any(|source| source.prefix.is_some()));
    let mut buffered: Vec<(&Source, String)> = Vec::new();
    let merge = async {
        loop {
            for stream in &mut streams {
                stream.fill().await;
            }
            let Some(next) = streams
                .iter_mut()
                .filter(|stream| stream.head.is_some())
                .min_by_key(|stream| stream.head.as_ref().map(|(timestamp, _)| *timestamp))
            else {
                return true;
            };
            let (_, message) = next.head.take().unwrap_or_default();
            if per_service_tail.is_some() {
                buffered.push((next.source, message));
            } else if !sink.emit(next.source, &message).await {
                return false;
            }
        }
    };

    let mut completed = tokio::select! {
        completed = merge => completed,
        () = ctx.cancel.cancelled() => false,
    };
    if let (Some(tail), true) = (per_service_tail, completed) {
        completed = emit_last_per_target(sink, &buffered, tail).await;
    }
    let failure = stop_processes(streams.iter_mut().map(|stream| &mut stream.process.child)).await;
    match failure {
        Some(code) if completed && !ctx.cancel.is_cancelled() => {
            Err(Error::failure(format!("{PODMAN} logs exited with code {code}")))
        }
        _ => Ok(()),
    }
}

async fn emit_last_per_target(sink: &Sink, lines: &[(&Source, String)], tail: u64) -> bool {
    let targets = lines.iter().map(|(source, _)| source.target + 1).max().unwrap_or(0);
    let mut remaining: Vec<u64> = vec![tail; targets];
    let mut keep = vec![false; lines.len()];
    for (index, (source, _)) in lines.iter().enumerate().rev() {
        if remaining[source.target] > 0 {
            remaining[source.target] -= 1;
            keep[index] = true;
        }
    }
    for ((source, message), keep) in lines.iter().zip(keep) {
        if keep && !sink.emit(source, message).await {
            return false;
        }
    }
    true
}

fn spawn_follow_streams(sources: &[Source], since: &str) -> Result<Vec<LogProcess>> {
    let args = ["logs".to_owned(), "--follow".to_owned(), "--since".to_owned(), since.to_owned()];
    sources.iter().map(|source| spawn_logs(source, &args)).collect()
}

/// Emits followed lines in arrival order until every stream ends or the consumer stops.
async fn consume_follow_streams(
    ctx: &Context,
    sources: &[Source],
    sink: &Sink,
    streams: Vec<LogProcess>,
) -> Result<()> {
    let (sender, mut receiver) = mpsc::channel::<(usize, String)>(1024);
    let mut children = Vec::with_capacity(streams.len());
    for (index, LogProcess { child, mut reader }) in streams.into_iter().enumerate() {
        children.push(child);
        let sender = sender.clone();
        tokio::spawn(async move {
            while let Some(line) = read_line(&mut reader).await {
                if sender.send((index, line)).await.is_err() {
                    break;
                }
            }
        });
    }
    drop(sender);

    let screen = match sink {
        Sink::Print(printer) => printer.screen.as_ref(),
        Sink::Pager(_) => None,
    };
    let mut resizes = screen.map(|screen| screen.borrow().resizes.clone());
    let completed = loop {
        tokio::select! {
            Some(Ok(())) = async { Some(resizes.as_mut()?.changed().await) } => {
                if let Sink::Print(printer) = sink {
                    if !printer.redraw() {
                        break false;
                    }
                }
            },
            message = receiver.recv() => match message {
                Some((index, line)) => {
                    if !sink.emit(&sources[index], &line).await {
                        break false;
                    }
                }
                None => break true,
            },
            () = ctx.cancel.cancelled() => break false,
        }
    };

    let failure = stop_processes(children.iter_mut()).await;
    match failure {
        Some(code) if completed && !ctx.cancel.is_cancelled() => {
            Err(Error::failure(format!("{PODMAN} logs exited with code {code}")))
        }
        _ => Ok(()),
    }
}

/// Plain streaming output for `--flat`, pipes and redirects.
struct Printer {
    raw: bool,
    labels: Vec<String>,
    /// Column output on a terminal, re-laid out when the terminal is resized.
    screen: Option<RefCell<Screen>>,
}

struct Screen {
    rows: VecDeque<(usize, String)>,
    resizes: watch::Receiver<()>,
}

/// Notifies about terminal resizes, coalescing bursts.
fn watch_resizes() -> Option<watch::Receiver<()>> {
    let mut resizes = signal(SignalKind::window_change()).ok()?;
    let (sender, receiver) = watch::channel(());
    tokio::spawn(async move {
        while resizes.recv().await.is_some() {
            tokio::time::sleep(RESIZE_DEBOUNCE).await;
            if sender.send(()).is_err() {
                break;
            }
        }
    });
    Some(receiver)
}

impl Printer {
    fn header_rows(&self, width: usize) -> String {
        let names: Vec<String> =
            self.labels.iter().enumerate().map(|(index, label)| target_color(index)(label)).collect();
        format!("{}\n{}", format_row(&names, width), format_row(&vec![String::new(); self.labels.len()], width))
    }

    /// Prints the column header. Returns `false` once stdout is closed.
    fn header(&self) -> bool {
        print_line(&self.header_rows(self.width()))
    }

    fn width(&self) -> usize {
        column_width(self.labels.len(), terminal_columns().unwrap_or(DEFAULT_CONSOLE_WIDTH))
    }

    fn line(&self, target: usize, message: &str) -> bool {
        if self.raw {
            let color = target_color(target);
            return if self.labels.len() > 1 {
                print_line(&format!("{} | {message}", color(&self.labels[target])))
            } else {
                print_line(&color(message))
            };
        }

        if let Some(screen) = &self.screen {
            if screen.borrow().resizes.has_changed().unwrap_or(false) && !self.redraw() {
                return false;
            }
            let mut screen = screen.borrow_mut();
            if screen.rows.len() == SCREEN_ROWS {
                screen.rows.pop_front();
            }
            screen.rows.push_back((target, message.to_owned()));
        }
        print_line(&format_row(&row_values(self.labels.len(), target, message), self.width()))
    }

    /// Clears the terminal (including scrollback laid out for the old width) and re-renders the
    /// header and kept rows for the current width.
    fn redraw(&self) -> bool {
        let Some(screen) = &self.screen else { return true };
        let mut screen = screen.borrow_mut();
        screen.resizes.mark_unchanged();

        let width = self.width();
        let mut output = String::from("\x1b[H\x1b[2J\x1b[3J");
        output.push_str(&self.header_rows(width));
        output.push('\n');
        for (target, message) in &screen.rows {
            output.push_str(&format_row(&row_values(self.labels.len(), *target, message), width));
            output.push('\n');
        }
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(output.as_bytes()).and_then(|()| stdout.flush()).is_ok()
    }
}

/// Width of each column when `count` columns share `total` terminal columns.
fn column_width(count: usize, total: usize) -> usize {
    let count = count.max(1);
    (total.saturating_sub(3 * (count - 1)) / count).max(MIN_COLUMN_WIDTH)
}

fn row_values(count: usize, target: usize, message: &str) -> Vec<String> {
    (0..count).map(|index| if index == target { message.to_owned() } else { String::new() }).collect()
}

fn target_color(target: usize) -> fn(&str) -> String {
    PALETTE[target % PALETTE.len()]
}

fn format_row(values: &[String], width: usize) -> String {
    values.iter().map(|value| fit_column(value, width)).collect::<Vec<_>>().join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_the_since_argument() {
        let options = |since: Option<&str>, lines: Option<u64>| LogsOptions {
            since: since.map(str::to_owned),
            lines,
            ..LogsOptions::default()
        };
        assert_eq!(since_argument(&options(Some("start"), None)), None);
        assert_eq!(since_argument(&options(Some("10m"), Some(5))).as_deref(), Some("10m"));
        assert_eq!(since_argument(&options(None, Some(5))), None);
        assert!(since_argument(&options(None, None)).is_some_and(|since| since.ends_with('Z')));
    }

    #[tokio::test]
    async fn merges_combined_output_in_order() {
        let (reader, writer) = std::io::pipe().unwrap();
        let mut command =
            process::command("sh", ["-c", "echo one; echo two >&2; printf 'three\\r\\n'; printf 'tail'"], None);
        command.stdout(Stdio::from(writer.try_clone().unwrap())).stderr(Stdio::from(writer));
        let mut child = process::spawn(&mut command).unwrap();
        drop(command);
        let mut reader = LineReader::new(pipe::Receiver::from_owned_fd(OwnedFd::from(reader)).unwrap());
        let mut lines = Vec::new();
        while let Some(line) = read_line(&mut reader).await {
            lines.push(line);
        }
        child.wait().await.unwrap();
        assert_eq!(lines, ["one", "two", "three", "tail"]);
    }
}
