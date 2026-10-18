use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::compose::events::{HealthStatus, ServiceStatus};
use crate::error::{Error, Result};
use crate::lifecycle::LifecycleOperation;
use crate::process::LineReader;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceHealth {
    pub service: String,
    pub status: HealthStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceState {
    pub service: String,
    pub status: ServiceStatus,
}

/// Lifecycle notifications sent by CLI commands to a running daemon (JSON lines).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DaemonMessage {
    #[serde(rename = "lifecycle.begin")]
    Begin {
        #[serde(rename = "projectId")]
        project_id: i64,
        project: String,
        operation: LifecycleOperation,
    },
    #[serde(rename = "lifecycle.end")]
    End {
        #[serde(rename = "projectId")]
        project_id: i64,
        project: String,
        operation: LifecycleOperation,
        health: Vec<ServiceHealth>,
        state: Vec<ServiceState>,
    },
    #[serde(rename = "lifecycle.abort")]
    Abort {
        #[serde(rename = "projectId")]
        project_id: i64,
        project: String,
        operation: LifecycleOperation,
    },
}

impl DaemonMessage {
    pub fn project(&self) -> &str {
        match self {
            Self::Begin { project, .. } | Self::End { project, .. } | Self::Abort { project, .. } => project,
        }
    }
}

pub fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("PM3_DAEMON_SOCKET") {
        return PathBuf::from(path);
    }
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
    runtime_dir.join("pm3").join("daemon.sock")
}

/// Where lifecycle progress is reported: a daemon socket, the daemon's own queue, or nowhere.
pub enum Notifier {
    Disabled,
    Socket(UnixStream),
    Queue(mpsc::UnboundedSender<DaemonMessage>),
}

impl Notifier {
    /// Connects to the daemon if one is running.
    pub async fn connect() -> Self {
        match UnixStream::connect(socket_path()).await {
            Ok(stream) => Self::Socket(stream),
            Err(_) => Self::Disabled,
        }
    }

    pub fn is_active(&self) -> bool {
        !matches!(self, Self::Disabled)
    }

    pub async fn send(&mut self, message: DaemonMessage) {
        match self {
            Self::Disabled => {}
            Self::Socket(stream) => {
                let Ok(mut line) = serde_json::to_vec(&message) else { return };
                line.push(b'\n');
                if stream.write_all(&line).await.is_err() {
                    *self = Self::Disabled;
                }
            }
            Self::Queue(sender) => {
                let _ = sender.send(message);
            }
        }
    }
}

/// Accepts lifecycle notifications on the daemon socket and forwards them to `sender`.
pub struct IpcServer {
    path: PathBuf,
    task: JoinHandle<()>,
}

impl IpcServer {
    pub async fn start(sender: mpsc::UnboundedSender<DaemonMessage>) -> Result<Self> {
        let path = socket_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        remove_stale_socket(&path).await?;

        let listener = UnixListener::bind(&path)
            .map_err(|error| Error::failure(format!("Failed to listen on {}: {error}", path.display())))?;
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(read_messages(stream, sender.clone()));
            }
        });
        Ok(Self { path, task })
    }

    pub async fn stop(self) {
        self.task.abort();
        let _ = tokio::fs::remove_file(&self.path).await;
    }
}

async fn read_messages(stream: UnixStream, sender: mpsc::UnboundedSender<DaemonMessage>) {
    let mut lines = LineReader::new(stream);
    while let Some(line) = lines.next_line().await {
        if let Ok(message) = serde_json::from_str::<DaemonMessage>(line.trim()) {
            if sender.send(message).is_err() {
                break;
            }
        }
    }
}

async fn remove_stale_socket(path: &Path) -> Result<()> {
    match UnixStream::connect(path).await {
        Ok(_) => Err(Error::failure(format!("PM3 daemon socket is already in use: {}", path.display()))),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            match tokio::fs::remove_file(path).await {
                Err(error) if error.kind() != ErrorKind::NotFound => Err(error.into()),
                _ => Ok(()),
            }
        }
        Err(error) => Err(Error::failure(format!("Failed to check daemon socket {}: {error}", path.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_wire_format() {
        let message = DaemonMessage::End {
            project_id: 3,
            project: "web".to_owned(),
            operation: LifecycleOperation::Restart,
            health: vec![ServiceHealth { service: "db".to_owned(), status: HealthStatus::Degraded }],
            state: vec![ServiceState { service: "db".to_owned(), status: ServiceStatus::Started }],
        };
        let json = serde_json::to_string(&message).unwrap();
        assert_eq!(
            json,
            r#"{"type":"lifecycle.end","projectId":3,"project":"web","operation":"restart","health":[{"service":"db","status":"degraded"}],"state":[{"service":"db","status":"started"}]}"#
        );
        assert_eq!(serde_json::from_str::<DaemonMessage>(&json).unwrap(), message);
        assert!(
            serde_json::from_str::<DaemonMessage>(
                r#"{"type":"lifecycle.begin","projectId":1,"project":"a","operation":"start"}"#
            )
            .is_ok()
        );
        assert!(serde_json::from_str::<DaemonMessage>(r#"{"type":"other","projectId":1}"#).is_err());
    }
}
