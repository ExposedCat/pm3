use std::fmt::Write;

use crate::error::{Error, Result};
use crate::lifecycle::LifecycleOperation;
use crate::logs::LogsOptions;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub command: Command,
    pub verbose: bool,
    pub yes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Create { workdir: String, name: Option<String>, git: Option<bool>, compose_args: Vec<String> },
    Enable { name: Option<String>, now: bool },
    Disable { name: Option<String>, now: bool },
    Git { enable: bool, name: Option<String> },
    Lifecycle(LifecycleCommand),
    Logs { name: Option<String>, options: LogsOptions },
    List { detailed: bool },
    View { name: Option<String> },
    Remove { name: Option<String>, force: bool },
    Daemon,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleCommand {
    pub operation: LifecycleOperation,
    pub name: Option<String>,
    pub build: bool,
    pub detach: bool,
    pub git: Option<bool>,
    pub no_cache: bool,
    /// Arguments after `--`, appended to `up` (start) or `down` (stop).
    pub operation_args: Vec<String>,
}

pub fn parse(args: Vec<String>) -> Result<Invocation> {
    let mut command_args = Vec::with_capacity(args.len());
    let mut verbose = false;
    let mut yes = false;
    let mut passthrough = false;

    for arg in args {
        match arg.as_str() {
            "--" => passthrough = true,
            "-v" | "--verbose" if !passthrough => {
                verbose = true;
                continue;
            }
            "-y" | "--yes" if !passthrough => {
                yes = true;
                continue;
            }
            _ => {}
        }
        command_args.push(arg);
    }

    let mut command_args = command_args.into_iter();
    let command = match command_args.next() {
        None => Command::Help,
        Some(name) => {
            let rest: Vec<String> = command_args.collect();
            match name.as_str() {
                "create" => parse_create(rest)?,
                "enable" => parse_toggle("enable", rest, |name, now| Command::Enable { name, now })?,
                "disable" => parse_toggle("disable", rest, |name, now| Command::Disable { name, now })?,
                "git" => parse_git(rest)?,
                "start" => parse_lifecycle(LifecycleOperation::Start, rest)?,
                "stop" => parse_lifecycle(LifecycleOperation::Stop, rest)?,
                "restart" => parse_lifecycle(LifecycleOperation::Restart, rest)?,
                "logs" => parse_logs(rest)?,
                "list" => parse_list(rest)?,
                "view" => parse_view(rest)?,
                "rm" | "remove" => parse_remove(rest)?,
                "daemon" => {
                    no_extra_args("daemon", &rest)?;
                    Command::Daemon
                }
                "help" | "--help" | "-h" => {
                    no_extra_args("help", &rest)?;
                    Command::Help
                }
                _ => return Err(Error::usage(format!("Unknown command: {name}"))),
            }
        }
    };

    Ok(Invocation { command, verbose, yes })
}

fn no_extra_args(command: &str, args: &[String]) -> Result<()> {
    match args.first() {
        Some(arg) => Err(Error::usage(format!("Unexpected argument for {command}: {arg}"))),
        None => Ok(()),
    }
}

fn option_value(option: &str, value: Option<String>) -> Result<String> {
    value.filter(|value| !value.is_empty()).ok_or_else(|| Error::usage(format!("Missing value for {option}.")))
}

fn set_git(command: &str, current: Option<bool>, next: bool) -> Result<Option<bool>> {
    match current {
        Some(current) if current != next => Err(Error::usage(format!("Cannot use --git with --local for {command}"))),
        _ => Ok(Some(next)),
    }
}

fn parse_create(args: Vec<String>) -> Result<Command> {
    let mut workdir = None;
    let mut name = None;
    let mut git = None;
    let mut compose_args = Vec::new();
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" => {
                compose_args = args.collect();
                break;
            }
            "--name" => name = Some(option_value("--name", args.next())?),
            "-g" | "--git" => git = set_git("create", git, true)?,
            "-l" | "--local" => git = set_git("create", git, false)?,
            _ => {
                if let Some(value) = arg.strip_prefix("--name=") {
                    name = Some(option_value("--name", Some(value.to_owned()))?);
                } else if arg.starts_with('-') {
                    return Err(Error::usage(format!("Unknown option for create: {arg}")));
                } else if workdir.is_some() {
                    return Err(Error::usage(format!("Unexpected argument for create: {arg}")));
                } else {
                    workdir = Some(arg);
                }
            }
        }
    }

    let workdir = workdir.filter(|workdir| !workdir.is_empty()).ok_or_else(|| Error::usage("Missing workdir."))?;
    Ok(Command::Create { workdir, name, git, compose_args })
}

fn parse_toggle(
    command: &str,
    args: Vec<String>,
    build: impl FnOnce(Option<String>, bool) -> Command,
) -> Result<Command> {
    let mut name = None;
    let mut now = false;
    for arg in args {
        match arg.as_str() {
            "-n" | "--now" => now = true,
            _ if arg.starts_with('-') => return Err(Error::usage(format!("Unknown option for {command}: {arg}"))),
            _ if name.is_some() => return Err(Error::usage(format!("Unexpected argument for {command}: {arg}"))),
            _ => name = Some(arg),
        }
    }
    Ok(build(name, now))
}

fn parse_git(args: Vec<String>) -> Result<Command> {
    let mut args = args.into_iter();
    let mode = args.next().filter(|mode| !mode.is_empty()).ok_or_else(|| Error::usage("Missing git mode."))?;
    let name = args.next();
    no_extra_args("git", &args.collect::<Vec<_>>())?;

    let enable = match mode.to_lowercase().as_str() {
        "on" | "y" | "yes" | "enable" => true,
        "off" | "n" | "no" | "disable" => false,
        _ => return Err(Error::usage(format!("Invalid git mode: {mode}"))),
    };
    Ok(Command::Git { enable, name })
}

fn parse_lifecycle(operation: LifecycleOperation, args: Vec<String>) -> Result<Command> {
    let kind = operation.as_str();
    let builds = operation != LifecycleOperation::Stop;
    let builds_by_default = operation == LifecycleOperation::Restart;
    let mut command = LifecycleCommand {
        operation,
        name: None,
        build: builds_by_default,
        detach: false,
        git: None,
        no_cache: false,
        operation_args: Vec::new(),
    };
    let mut no_build = false;
    let unknown = |arg: &str| Error::usage(format!("Unknown option for {kind}: {arg}"));
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" if operation != LifecycleOperation::Restart => {
                command.operation_args = args.collect();
                break;
            }
            "-d" | "--detach" => command.detach = true,
            "-b" if builds => {
                if builds_by_default {
                    command.build = false;
                    no_build = true;
                } else {
                    command.build = true;
                }
            }
            "--build" if builds => command.build |= !builds_by_default,
            "--no-build" if builds_by_default => {
                command.build = false;
                no_build = true;
            }
            "-c" | "--no-cache" if builds => {
                command.build |= !builds_by_default;
                command.no_cache = true;
            }
            "-g" | "--git" if builds => command.git = set_git(kind, command.git, true)?,
            "-l" | "--local" if builds => command.git = set_git(kind, command.git, false)?,
            _ if arg.starts_with('-') => return Err(unknown(&arg)),
            _ if command.name.is_some() => return Err(Error::usage(format!("Unexpected argument for {kind}: {arg}"))),
            _ => command.name = Some(arg),
        }
    }

    if no_build && command.no_cache {
        return Err(Error::usage("Cannot use --no-cache with --no-build"));
    }
    Ok(Command::Lifecycle(command))
}

fn parse_logs(args: Vec<String>) -> Result<Command> {
    let mut name = None;
    let mut options = LogsOptions::default();
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-s" | "--since" => options.since = Some(option_value(&arg, args.next())?),
            "-l" | "--lines" => {
                let value = option_value(&arg, args.next())?;
                let lines = value
                    .trim()
                    .parse::<u64>()
                    .ok()
                    .filter(|_| !value.trim().starts_with('+'))
                    .ok_or_else(|| Error::usage(format!("Invalid value for {arg}: {value}")))?;
                options.lines = Some(lines);
            }
            "-r" | "--raw" => options.raw = true,
            "-o" | "--once" => options.once = true,
            "-f" | "--flat" => options.flat = true,
            _ if arg.starts_with('-') => return Err(Error::usage(format!("Unknown option for logs: {arg}"))),
            _ if name.is_none() => name = Some(arg),
            _ => options.services.push(arg),
        }
    }

    Ok(Command::Logs { name, options })
}

fn parse_list(args: Vec<String>) -> Result<Command> {
    let mut detailed = false;
    let mut rest = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-d" | "--detailed" => detailed = true,
            _ => rest.push(arg),
        }
    }
    no_extra_args("list", &rest)?;
    Ok(Command::List { detailed })
}

fn parse_view(args: Vec<String>) -> Result<Command> {
    let mut args = args.into_iter();
    let name = args.next();
    no_extra_args("view", &args.collect::<Vec<_>>())?;
    Ok(Command::View { name })
}

fn parse_remove(args: Vec<String>) -> Result<Command> {
    let mut name = None;
    let mut force = false;
    for arg in args {
        match arg.as_str() {
            "-f" | "--force" => force = true,
            _ if arg.starts_with('-') => return Err(Error::usage(format!("Unknown option for remove: {arg}"))),
            _ if name.is_some() => return Err(Error::usage(format!("Unexpected argument for remove: {arg}"))),
            _ => name = Some(arg),
        }
    }
    Ok(Command::Remove { name, force })
}

/// Usage line arguments and description per command, in help order.
const COMMAND_USAGE: [(&str, &str, &str); 13] = [
    (
        "create",
        "WORKDIR [--name NAME] [-g|--git] [-l|--local] [-- PODMAN-COMPOSE-ARGS...]",
        "Register project; pass podman-compose arguments after --",
    ),
    ("enable", "[NAME] [-n|--now]", "Enable project startup"),
    ("disable", "[NAME] [-n|--now]", "Disable project startup"),
    ("git", "ON|Y|YES|ENABLE|OFF|N|NO|DISABLE [NAME]", "Enable or disable Git pulls"),
    (
        "start",
        "[NAME] [-d|--detach] [-b|--build] [-c|--no-cache] [-g|--git] [-l|--local] [-- PODMAN-COMPOSE-ARGS...]",
        "Start the project",
    ),
    ("stop", "[NAME] [-d|--detach] [-- PODMAN-COMPOSE-ARGS...]", "Stop the project"),
    ("restart", "[NAME] [-d|--detach] [-b|--no-build] [-c|--no-cache] [-g|--git] [-l|--local]", "Restart the project"),
    (
        "logs",
        "[NAME] [SERVICES...] [-s|--since VALUE] [-l|--lines COUNT] [-r|--raw] [-o|--once] [-f|--flat]",
        "Show project logs",
    ),
    ("list", "[-d|--detailed]", "List projects."),
    ("view", "[PROJECT]", "View project details per service"),
    ("rm", "[NAME] [-f|--force]", "Remove the project and its Podman artifacts"),
    ("daemon", "", "Run autostart daemon"),
    ("help", "", "Show this help"),
];

pub fn help_text() -> String {
    let usages: Vec<(String, &str)> = COMMAND_USAGE
        .iter()
        .map(|(name, args, description)| {
            let (positional, options) = split_usage(args);
            let usage = [*name, positional, "[-v|--verbose] [-y|--yes]", options]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            (usage, *description)
        })
        .collect();
    let width = usages.iter().map(|(usage, _)| usage.len()).max().unwrap_or(0);

    let mut text = String::from("pm3 = pm2 + podman\n\nUsage:\n");
    for (usage, description) in usages {
        let _ = writeln!(text, "  pm3 {usage:width$}  {description}");
    }
    text.trim_end().to_owned()
}

/// Splits usage into positional arguments and options (which start with `[-`).
fn split_usage(args: &str) -> (&str, &str) {
    match args.find("[-") {
        Some(index) => (args[..index].trim_end(), &args[index..]),
        None => (args, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> Result<Invocation> {
        parse(args.iter().map(|arg| (*arg).to_owned()).collect())
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn lifecycle(args: &[&str]) -> LifecycleCommand {
        match parse_args(args).unwrap().command {
            Command::Lifecycle(command) => command,
            command => panic!("unexpected {command:?}"),
        }
    }

    #[test]
    fn create_parses_compose_arguments_after_the_separator() {
        let invocation = parse_args(&[
            "create",
            "./app",
            "--name",
            "api",
            "--",
            "-f",
            "compose.prod.yaml",
            "--profile",
            "production",
        ])
        .unwrap();
        assert_eq!(
            invocation.command,
            Command::Create {
                workdir: "./app".to_owned(),
                name: Some("api".to_owned()),
                git: None,
                compose_args: strings(&["-f", "compose.prod.yaml", "--profile", "production"]),
            }
        );
    }

    #[test]
    fn create_preserves_global_looking_compose_arguments() {
        let invocation = parse_args(&["--verbose", "create", "./app", "--", "--verbose", "-v"]).unwrap();
        assert!(invocation.verbose);
        let Command::Create { compose_args, .. } = invocation.command else { panic!() };
        assert_eq!(compose_args, ["--verbose", "-v"]);
    }

    #[test]
    fn create_rejects_unknown_and_conflicting_options() {
        assert_eq!(
            parse_args(&["create", "./app", "--compose", "c.yaml"]).unwrap_err().message,
            "Unknown option for create: --compose"
        );
        assert_eq!(
            parse_args(&["create", "./app", "-g", "-l"]).unwrap_err().message,
            "Cannot use --git with --local for create"
        );
        assert_eq!(parse_args(&["create"]).unwrap_err().message, "Missing workdir.");
        assert_eq!(parse_args(&["create", "a", "b"]).unwrap_err().message, "Unexpected argument for create: b");
        assert_eq!(parse_args(&["create", "a", "--name"]).unwrap_err().message, "Missing value for --name.");
        let Command::Create { name, git, .. } = parse_args(&["create", "a", "--name=web", "--git"]).unwrap().command
        else {
            panic!()
        };
        assert_eq!((name.as_deref(), git), (Some("web"), Some(true)));
    }

    #[test]
    fn git_parses_aliases_and_rejects_bad_arguments() {
        for alias in ["on", "y", "yes", "enable", "ON"] {
            assert_eq!(
                parse_args(&["git", alias, "api"]).unwrap().command,
                Command::Git { enable: true, name: Some("api".to_owned()) }
            );
        }
        for alias in ["off", "n", "no", "disable"] {
            assert_eq!(parse_args(&["git", alias]).unwrap().command, Command::Git { enable: false, name: None });
        }
        assert_eq!(parse_args(&["git"]).unwrap_err().message, "Missing git mode.");
        assert_eq!(parse_args(&["git", "maybe"]).unwrap_err().message, "Invalid git mode: maybe");
        assert_eq!(
            parse_args(&["git", "on", "api", "extra"]).unwrap_err().message,
            "Unexpected argument for git: extra"
        );
    }

    #[test]
    fn enable_rejects_git_options() {
        assert_eq!(parse_args(&["enable", "api", "--git"]).unwrap_err().message, "Unknown option for enable: --git");
        assert_eq!(
            parse_args(&["disable", "api", "--local"]).unwrap_err().message,
            "Unknown option for disable: --local"
        );
        assert_eq!(
            parse_args(&["enable", "api", "-n"]).unwrap().command,
            Command::Enable { name: Some("api".to_owned()), now: true }
        );
    }

    #[test]
    fn lifecycle_parses_operation_arguments() {
        let invocation = parse_args(&["--verbose", "start", "api", "--", "--profile", "workers", "--verbose"]).unwrap();
        assert!(invocation.verbose);
        assert_eq!(
            lifecycle(&["start", "api", "--", "--profile", "workers", "--verbose"]).operation_args,
            ["--profile", "workers", "--verbose"]
        );
        assert_eq!(lifecycle(&["stop", "api", "--", "--timeout", "30"]).operation_args, ["--timeout", "30"]);
        assert_eq!(
            parse_args(&["restart", "api", "--", "--timeout", "30"]).unwrap_err().message,
            "Unknown option for restart: --"
        );
    }

    #[test]
    fn lifecycle_build_flags_depend_on_the_command() {
        assert!(!lifecycle(&["start", "api"]).build);
        assert!(lifecycle(&["start", "api", "-b"]).build);
        assert!(lifecycle(&["start", "api", "--build"]).build);
        let no_cache = lifecycle(&["start", "api", "-c"]);
        assert!(no_cache.build && no_cache.no_cache);

        assert!(lifecycle(&["restart", "api"]).build);
        assert!(!lifecycle(&["restart", "api", "-b"]).build);
        assert!(!lifecycle(&["restart", "api", "--no-build"]).build);
        assert!(lifecycle(&["restart", "api", "--build"]).build);
        assert_eq!(
            parse_args(&["restart", "api", "-b", "-c"]).unwrap_err().message,
            "Cannot use --no-cache with --no-build"
        );
        assert_eq!(
            parse_args(&["start", "api", "--no-build"]).unwrap_err().message,
            "Unknown option for start: --no-build"
        );
        assert_eq!(parse_args(&["stop", "api", "-b"]).unwrap_err().message, "Unknown option for stop: -b");
        assert_eq!(parse_args(&["stop", "api", "-g"]).unwrap_err().message, "Unknown option for stop: -g");
        assert_eq!(parse_args(&["start", "-g", "-l"]).unwrap_err().message, "Cannot use --git with --local for start");
        assert_eq!(lifecycle(&["restart", "--local", "-d"]).git, Some(false));
        assert!(lifecycle(&["stop", "-d"]).detach);
    }

    #[test]
    fn yes_is_global_except_after_the_separator() {
        assert!(parse_args(&["--yes", "enable"]).unwrap().yes);
        assert!(parse_args(&["enable", "-y"]).unwrap().yes);
        let invocation = parse_args(&["start", "api", "--", "--yes"]).unwrap();
        assert!(!invocation.yes);
        let Command::Lifecycle(command) = invocation.command else { panic!() };
        assert_eq!(command.operation_args, ["--yes"]);
    }

    #[test]
    fn logs_parse_options_and_services() {
        let Command::Logs { name, options } =
            parse_args(&["logs", "web", "api", "worker", "-s", "10m", "-l", "20", "-r", "-o"]).unwrap().command
        else {
            panic!()
        };
        assert_eq!(name.as_deref(), Some("web"));
        assert_eq!(options.services, ["api", "worker"]);
        assert_eq!(options.since.as_deref(), Some("10m"));
        assert_eq!(options.lines, Some(20));
        assert!(options.raw && options.once);
        assert_eq!(parse_args(&["logs", "web", "-l", "x"]).unwrap_err().message, "Invalid value for -l: x");
        assert_eq!(parse_args(&["logs", "web", "--lines", "-1"]).unwrap_err().message, "Invalid value for --lines: -1");
        assert_eq!(parse_args(&["logs", "web", "--since"]).unwrap_err().message, "Missing value for --since.");
        assert_eq!(parse_args(&["logs", "--bogus"]).unwrap_err().message, "Unknown option for logs: --bogus");
    }

    #[test]
    fn parses_remaining_commands() {
        assert_eq!(parse_args(&[]).unwrap().command, Command::Help);
        assert_eq!(parse_args(&["-h"]).unwrap().command, Command::Help);
        assert_eq!(parse_args(&["list", "--detailed"]).unwrap().command, Command::List { detailed: true });
        assert_eq!(parse_args(&["list", "x"]).unwrap_err().message, "Unexpected argument for list: x");
        assert_eq!(parse_args(&["view"]).unwrap().command, Command::View { name: None });
        assert_eq!(parse_args(&["view", "a", "b"]).unwrap_err().message, "Unexpected argument for view: b");
        assert_eq!(
            parse_args(&["remove", "a", "-f"]).unwrap().command,
            Command::Remove { name: Some("a".to_owned()), force: true }
        );
        assert_eq!(parse_args(&["rm", "-x"]).unwrap_err().message, "Unknown option for remove: -x");
        assert_eq!(parse_args(&["daemon", "x"]).unwrap_err().message, "Unexpected argument for daemon: x");
        assert_eq!(parse_args(&["show", "api"]).unwrap_err().message, "Unknown command: show");
        assert_eq!(parse_args(&["help", "x"]).unwrap_err().message, "Unexpected argument for help: x");
    }

    #[test]
    fn help_lists_every_command() {
        let help = help_text();
        assert!(
            help.starts_with(
                "pm3 = pm2 + podman\n\nUsage:\n  pm3 create WORKDIR [-v|--verbose] [-y|--yes] [--name NAME]"
            )
        );
        assert!(help.contains("  pm3 rm [NAME] [-v|--verbose] [-y|--yes] [-f|--force]"));
        assert!(help.lines().last().unwrap().starts_with("  pm3 help [-v|--verbose] [-y|--yes]"));
    }
}
