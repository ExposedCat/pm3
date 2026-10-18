mod cli;
mod commands;
mod compose;
mod daemon;
mod db;
mod error;
mod git;
mod lifecycle;
mod logs;
mod process;
mod term;
mod time;

use std::process::ExitCode;

use tokio::signal::unix::{SignalKind, signal};
use tokio_util::sync::CancellationToken;

use crate::cli::Command;
use crate::error::{Error, Result};
use crate::term::eprint_line;

/// Per-invocation runtime settings shared by all operations.
#[derive(Clone)]
pub struct Context {
    pub verbose: bool,
    /// Fires on SIGINT/SIGTERM for commands that shut down gracefully.
    pub cancel: CancellationToken,
}

impl Context {
    /// Fails with `Interrupted` once the user asked to stop.
    pub fn ensure_active(&self) -> Result<()> {
        if self.cancel.is_cancelled() { Err(Error::failure("Interrupted")) } else { Ok(()) }
    }
}

fn main() -> ExitCode {
    let args = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
    let invocation = match cli::parse(args) {
        Ok(invocation) => invocation,
        Err(error) => {
            eprint_line(&error.message);
            return ExitCode::FAILURE;
        }
    };

    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprint_line(&format!("Failed to start runtime: {error}"));
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(async {
        let ctx = Context { verbose: invocation.verbose, cancel: CancellationToken::new() };
        if let Err(error) = install_signal_handlers(&invocation.command, &ctx.cancel) {
            eprint_line(&format!("Failed to install signal handlers: {error}"));
            return ExitCode::FAILURE;
        }

        match commands::run(&ctx, invocation.command, invocation.yes).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprint_line(if error.message.is_empty() { "Command failed" } else { &error.message });
                ExitCode::FAILURE
            }
        }
    })
}

/// Commands that drive podman processes stop them cleanly on the first interrupt; a second
/// interrupt exits immediately. Other commands keep the default signal behavior.
fn install_signal_handlers(command: &Command, cancel: &CancellationToken) -> std::io::Result<()> {
    let graceful = matches!(
        command,
        Command::Lifecycle(_)
            | Command::Logs { .. }
            | Command::Daemon
            | Command::Remove { .. }
            | Command::Enable { now: true, .. }
            | Command::Disable { now: true, .. }
    );
    if !graceful {
        return Ok(());
    }

    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut hangup = signal(SignalKind::hangup())?;
    // Lifecycle work keeps running when the terminal goes away; following logs does not.
    let stop_on_hangup = matches!(command, Command::Logs { .. });
    let cancel = cancel.clone();

    tokio::spawn(async move {
        let mut received = false;
        loop {
            let signal = tokio::select! {
                _ = interrupt.recv() => libc::SIGINT,
                _ = terminate.recv() => libc::SIGTERM,
                _ = hangup.recv() => {
                    if !stop_on_hangup {
                        continue;
                    }
                    libc::SIGHUP
                }
            };
            if received {
                std::process::exit(128 + signal);
            }
            received = true;
            cancel.cancel();
        }
    });
    Ok(())
}
