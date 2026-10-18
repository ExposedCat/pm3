use serde::{Deserialize, Serialize};

use crate::Context;
use crate::compose::containers::snapshot_services;
use crate::compose::{self, StartOptions};
use crate::daemon::ipc::{DaemonMessage, Notifier, ServiceHealth, ServiceState};
use crate::db::Project;
use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleOperation {
    Start,
    Stop,
    Restart,
}

impl LifecycleOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LifecycleRequest {
    pub operation: LifecycleOperation,
    pub start: StartOptions,
    /// Extra `podman-compose down` arguments for `stop`.
    pub down_args: Vec<String>,
}

/// Runs a start/stop/restart and reports its begin, end state or abort to the daemon.
pub async fn run(ctx: &Context, project: &Project, request: &LifecycleRequest, notifier: &mut Notifier) -> Result<()> {
    let operation = request.operation;
    let stop_state = if operation == LifecycleOperation::Stop && notifier.is_active() {
        snapshot(project).await.1
    } else {
        Vec::new()
    };

    notifier.send(DaemonMessage::Begin { project_id: project.id, project: project.name.clone(), operation }).await;
    let result = match operation {
        LifecycleOperation::Start => compose::start(ctx, project, &request.start).await,
        LifecycleOperation::Restart => compose::restart(ctx, project, &request.start).await,
        LifecycleOperation::Stop => compose::stop(ctx, project, &request.down_args, request.start.detached).await,
    };

    match result {
        Ok(()) => {
            if notifier.is_active() {
                let (health, state) = if operation == LifecycleOperation::Stop {
                    (Vec::new(), stop_state)
                } else {
                    snapshot(project).await
                };
                let message = DaemonMessage::End {
                    project_id: project.id,
                    project: project.name.clone(),
                    operation,
                    health,
                    state,
                };
                notifier.send(message).await;
            }
            Ok(())
        }
        Err(error) => {
            notifier
                .send(DaemonMessage::Abort { project_id: project.id, project: project.name.clone(), operation })
                .await;
            Err(error)
        }
    }
}

/// Current per-service health and state of a project.
pub async fn snapshot(project: &Project) -> (Vec<ServiceHealth>, Vec<ServiceState>) {
    let containers = compose::project_containers(project).await.unwrap_or_default();
    let services = snapshot_services(&containers);
    let health = services
        .iter()
        .filter_map(|service| Some(ServiceHealth { service: service.service.clone(), status: service.health? }))
        .collect();
    let state =
        services.into_iter().map(|service| ServiceState { service: service.service, status: service.status }).collect();
    (health, state)
}
