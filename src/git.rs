use std::path::Path;

use crate::Context;
use crate::db::Project;
use crate::error::{Error, Result};
use crate::process::{self, Output};
use crate::term::Loader;

const PULL_LINE: &str = "git:pull";

async fn git(ctx: &Context, project: &Project, args: &[&str]) -> Result<Output> {
    process::capture(process::command("git", args, Some(Path::new(&project.working_dir))), Some(&ctx.cancel)).await
}

pub async fn require_repository(ctx: &Context, project: &Project) -> Result<()> {
    let output = git(ctx, project, &["rev-parse", "--is-inside-work-tree"]).await;
    ctx.ensure_active()?;
    match output {
        Ok(output) if output.code == 0 && output.stdout.trim() == "true" => Ok(()),
        _ => Err(Error::input(format!("Project is not a git repository: {}", project.name))),
    }
}

/// Fast-forwards the project's repository, reporting how many commits arrived.
pub async fn pull(ctx: &Context, project: &Project) -> Result<()> {
    let loader = Loader::start("Pulling git".to_owned(), !ctx.verbose);
    loader.start_line(PULL_LINE, "Pulling git");

    match pull_commits(ctx, project).await {
        Ok(commits) => {
            loader.finish_line(PULL_LINE, "Synced git");
            let result = match commits {
                0 => "No changes".to_owned(),
                1 => "Pulled 1 commit".to_owned(),
                commits => format!("Pulled {commits} commits"),
            };
            loader.write_line_after(PULL_LINE, "git:pull-result", &result);
            loader.stop();
            Ok(())
        }
        Err(error) => {
            loader.finish_line(PULL_LINE, "Failed to sync git");
            let summary = error.message.split_whitespace().collect::<Vec<_>>().join(" ");
            loader.write_line_after(PULL_LINE, "git:pull-result", &format!("Failed to pull ({summary})"));
            loader.stop();
            Err(error)
        }
    }
}

async fn pull_commits(ctx: &Context, project: &Project) -> Result<u64> {
    require_repository(ctx, project).await?;

    let head = git(ctx, project, &["rev-parse", "--verify", "HEAD"]).await?;
    let previous_head = (head.code == 0).then(|| head.stdout.trim().to_owned()).filter(|head| !head.is_empty());

    let pull = process::command("git", ["pull", "--ff-only"], Some(Path::new(&project.working_dir)));
    let output = if ctx.verbose {
        process::run_echoed(pull, Some(&ctx.cancel)).await?
    } else {
        process::capture(pull, Some(&ctx.cancel)).await?
    };
    ctx.ensure_active()?;
    if output.code != 0 {
        let message = [output.stderr.as_str(), output.stdout.as_str()]
            .into_iter()
            .find(|text| !text.is_empty())
            .map_or_else(|| format!("Failed to pull git for project: {}", project.name), str::to_owned);
        return Err(Error::failure(message));
    }

    let range = previous_head.map_or_else(|| "HEAD".to_owned(), |head| format!("{head}..HEAD"));
    let count = git(ctx, project, &["rev-list", "--count", &range]).await?;
    let text = count.stdout.trim();
    match text.parse() {
        Ok(commits) if count.code == 0 && text.bytes().all(|byte| byte.is_ascii_digit()) => Ok(commits),
        _ => Err(Error::failure(count.detail().map_or_else(
            || format!("Failed to count pulled git commits for project: {}", project.name),
            str::to_owned,
        ))),
    }
}
