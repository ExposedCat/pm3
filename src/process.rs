use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::Write;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

const OUTPUT_TAIL_LIMIT: usize = 64 * 1024;
const STOP_GRACE: Duration = Duration::from_secs(1);
/// How long a cancelled process gets between SIGTERM and SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(10);
/// How long output is still read after a process exited. Background processes that inherited
/// the pipes must not keep us waiting.
pub const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Default)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    /// The most relevant diagnostic text: stderr, then stdout.
    pub fn detail(&self) -> Option<&str> {
        [self.stderr.trim(), self.stdout.trim()].into_iter().find(|text| !text.is_empty())
    }
}

pub fn command<I, S>(program: &str, args: I, cwd: Option<&Path>) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    // pm3 keeps lifecycle work running when the terminal hangs up, so its children must too.
    // SAFETY: signal() is async-signal-safe and only affects the forked child.
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            Ok(())
        });
    }
    command
}

pub fn spawn(command: &mut Command) -> Result<Child> {
    command.spawn().map_err(|error| spawn_error(command, &error))
}

fn spawn_error(command: &Command, error: &std::io::Error) -> Error {
    let command = command.as_std();
    let program = command.get_program().to_string_lossy();
    match command.get_current_dir() {
        Some(cwd) if !cwd.is_dir() => {
            Error::failure(format!("Failed to run {program}: directory not found: {}", cwd.display()))
        }
        _ => Error::failure(format!("Failed to run {program}: {error}")),
    }
}

pub fn exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

pub fn terminate(child: &Child) {
    if let Some(pid) = child.id() {
        // SAFETY: sending a signal to our own child process id has no memory-safety implications.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

/// Waits for the child, sending SIGTERM once `cancel` fires and SIGKILL if it doesn't exit.
pub async fn wait_cancellable(child: &mut Child, cancel: Option<&CancellationToken>) -> Result<ExitStatus> {
    if let Some(cancel) = cancel {
        tokio::select! {
            status = child.wait() => return Ok(status?),
            () = cancel.cancelled() => terminate(child),
        }
        if let Ok(status) = tokio::time::timeout(KILL_GRACE, child.wait()).await {
            return Ok(status?);
        }
        let _ = child.start_kill();
    }
    Ok(child.wait().await?)
}

/// Output collected by a reader task, or what's empty if it didn't finish in time.
async fn drain(mut reader: JoinHandle<String>) -> String {
    match tokio::time::timeout(DRAIN_GRACE, &mut reader).await {
        Ok(Ok(text)) => text,
        _ => {
            reader.abort();
            String::new()
        }
    }
}

/// Runs a command to completion, capturing trimmed stdout and stderr.
pub async fn capture(mut command: Command, cancel: Option<&CancellationToken>) -> Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn(&mut command)?;
    let stdout = tokio::spawn(read_all(child.stdout.take()));
    let stderr = tokio::spawn(read_all(child.stderr.take()));
    let status = wait_cancellable(&mut child, cancel).await;
    let (stdout, stderr) = tokio::join!(drain(stdout), drain(stderr));

    Ok(Output { code: exit_code(status?), stdout: stdout.trim_end().to_owned(), stderr: stderr.trim_end().to_owned() })
}

async fn read_all(stream: Option<impl AsyncRead + Unpin>) -> String {
    let mut bytes = Vec::new();
    if let Some(mut stream) = stream {
        let _ = stream.read_to_end(&mut bytes).await;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Runs a command with inherited stdio, so it can prompt the user.
pub async fn run_interactive(mut command: Command, cancel: Option<&CancellationToken>) -> Result<Output> {
    command.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    let mut child = spawn(&mut command)?;
    let status = wait_cancellable(&mut child, cancel).await?;
    Ok(Output { code: exit_code(status), ..Output::default() })
}

/// Runs a command, echoing its output live while keeping a bounded tail for diagnostics.
pub async fn run_echoed(mut command: Command, cancel: Option<&CancellationToken>) -> Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn(&mut command)?;
    let stdout = tokio::spawn(echo_stream(child.stdout.take(), false));
    let stderr = tokio::spawn(echo_stream(child.stderr.take(), true));
    let status = wait_cancellable(&mut child, cancel).await;
    let (stdout, stderr) = tokio::join!(drain(stdout), drain(stderr));

    Ok(Output { code: exit_code(status?), stdout: stdout.trim_end().to_owned(), stderr: stderr.trim_end().to_owned() })
}

async fn echo_stream(stream: Option<impl AsyncRead + Unpin>, to_stderr: bool) -> String {
    let Some(mut stream) = stream else { return String::new() };
    let mut tail = OutputTail::default();
    let mut buffer = vec![0u8; 8192];

    while let Ok(read) = stream.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        let _ = if to_stderr {
            std::io::stderr().lock().write_all(chunk)
        } else {
            std::io::stdout().lock().write_all(chunk).and_then(|()| std::io::stdout().flush())
        };
        tail.push_str(&String::from_utf8_lossy(chunk));
    }

    tail.into_string()
}

/// Starts a process that outlives this one: new session, no stdio. The child is reaped in the
/// background while this process keeps running.
pub fn spawn_detached(mut command: Command) -> Result<()> {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(false);
    // SAFETY: setsid is async-signal-safe and only affects the forked child.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = spawn(&mut command)?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

/// Keeps roughly the last [`OUTPUT_TAIL_LIMIT`] bytes of a text stream, line by line.
#[derive(Default)]
pub struct OutputTail {
    lines: VecDeque<String>,
    bytes: usize,
}

impl OutputTail {
    pub fn push_line(&mut self, line: &str) {
        self.bytes += line.len() + 1;
        self.lines.push_back(line.to_owned());
        while self.bytes > OUTPUT_TAIL_LIMIT && self.lines.len() > 1 {
            if let Some(removed) = self.lines.pop_front() {
                self.bytes -= removed.len() + 1;
            }
        }
    }

    fn push_str(&mut self, text: &str) {
        let mut segments = text.split('\n');
        if let Some(first) = segments.next() {
            match self.lines.back_mut() {
                Some(last) => {
                    self.bytes += first.len();
                    last.push_str(first);
                }
                None => self.push_line(first),
            }
        }
        for segment in segments {
            self.push_line(segment);
        }
    }

    pub fn lines(&self) -> impl Iterator<Item = &str> {
        self.lines.iter().map(String::as_str)
    }

    pub fn into_string(self) -> String {
        Vec::from(self.lines).join("\n")
    }
}

/// Reads lines from a byte stream, replacing invalid UTF-8 and stripping `\r\n`/`\n`.
pub struct LineReader<R> {
    reader: BufReader<R>,
    buffer: Vec<u8>,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    pub fn new(reader: R) -> Self {
        Self { reader: BufReader::new(reader), buffer: Vec::new() }
    }

    /// Next line, `None` at end of stream. Cancel-safe: a partially read line is kept and
    /// completed by the next call.
    pub async fn next_line(&mut self) -> Option<String> {
        let read = self.reader.read_until(b'\n', &mut self.buffer).await;
        if matches!(read, Ok(0) | Err(_)) && self.buffer.is_empty() {
            return None;
        }
        let line = String::from_utf8_lossy(&self.buffer);
        let line = line.strip_suffix('\n').unwrap_or(&line);
        let line = line.strip_suffix('\r').unwrap_or(line).to_owned();
        self.buffer.clear();
        Some(line)
    }
}

/// A long-running process whose stdout is consumed line by line (e.g. `podman events`).
pub struct LineStream {
    child: Child,
    lines: LineReader<ChildStdout>,
}

impl LineStream {
    pub fn spawn(mut command: Command) -> Result<Self> {
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = spawn(&mut command)?;
        let stdout = child.stdout.take().ok_or_else(|| Error::failure("Failed to capture process output"))?;
        Ok(Self { child, lines: LineReader::new(stdout) })
    }

    /// Next non-empty line; `None` once the stream ends. Cancel-safe.
    pub async fn next_line(&mut self) -> Option<String> {
        loop {
            match self.lines.next_line().await {
                Some(line) if line.is_empty() => {}
                line => return line,
            }
        }
    }

    pub async fn stop(mut self) {
        terminate(&self.child);
        if tokio::time::timeout(STOP_GRACE, self.child.wait()).await.is_err() {
            let _ = self.child.start_kill();
            let _ = tokio::time::timeout(STOP_GRACE, self.child.wait()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_tail_keeps_recent_lines() {
        let mut tail = OutputTail::default();
        let line = "x".repeat(1000);
        for _ in 0..100 {
            tail.push_line(&line);
        }
        tail.push_line("last");
        assert!(tail.bytes <= OUTPUT_TAIL_LIMIT);
        assert_eq!(tail.lines().last(), Some("last"));
    }

    #[test]
    fn output_tail_joins_partial_chunks() {
        let mut tail = OutputTail::default();
        tail.push_str("hello ");
        tail.push_str("world\nnext");
        assert_eq!(tail.into_string(), "hello world\nnext");
    }

    #[tokio::test]
    async fn reads_lines_lossily() {
        let mut lines = LineReader::new(&b"one\r\ntw\xffo\n\nlast"[..]);
        assert_eq!(lines.next_line().await.as_deref(), Some("one"));
        assert_eq!(lines.next_line().await.as_deref(), Some("tw\u{fffd}o"));
        assert_eq!(lines.next_line().await.as_deref(), Some(""));
        assert_eq!(lines.next_line().await.as_deref(), Some("last"));
        assert_eq!(lines.next_line().await, None);
    }

    #[tokio::test]
    async fn captures_output_and_exit_codes() {
        let output = capture(command("sh", ["-c", "echo out; echo err >&2; exit 3"], None), None).await.unwrap();
        assert_eq!(output.code, 3);
        assert_eq!(output.stdout, "out");
        assert_eq!(output.stderr, "err");
        assert_eq!(output.detail(), Some("err"));
    }

    #[tokio::test]
    async fn reports_missing_working_directory() {
        let error = capture(command("true", [""; 0], Some(Path::new("/nonexistent/pm3"))), None).await.unwrap_err();
        assert!(error.message.contains("directory not found: /nonexistent/pm3"), "{}", error.message);
    }

    #[tokio::test]
    async fn stops_waiting_for_pipes_held_by_background_processes() {
        let started = std::time::Instant::now();
        let output = capture(command("sh", ["-c", "sleep 30 & echo done"], None), None).await.unwrap();
        assert_eq!(output.code, 0);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn children_ignore_hangups() {
        let output = capture(command("sh", ["-c", "kill -HUP $$; echo alive"], None), None).await.unwrap();
        assert_eq!(output.stdout, "alive");
    }

    #[tokio::test]
    async fn cancellation_terminates_the_child() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let output = capture(command("sleep", ["30"], None), Some(&cancel)).await.unwrap();
        assert_eq!(output.code, 128 + libc::SIGTERM);
    }
}
