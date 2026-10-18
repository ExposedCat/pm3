# Git pull progress

Generate three local Git projects from the repository root:

```sh
./test-projects/git/setup.sh
```

Register them with Git pulling enabled:

```sh
cargo run -- create test-projects/git/generated/no-changes --name git-no-changes --git
cargo run -- create test-projects/git/generated/pulled-commits --name git-pulled-commits --git
cargo run -- create test-projects/git/generated/failed-pull --name git-failed-pull --git
```

Run each case:

```sh
cargo run -- start git-no-changes
cargo run -- start git-pulled-commits
cargo run -- start git-failed-pull
```

The expected Git progress results are, in order:

```text
Synced git
    No changes
Synced git
    Pulled 2 commits
Failed to sync git
    Failed to pull (fatal: Not possible to fast-forward, aborting.)
```

Run `setup.sh` again to restore the initial states. Stop the successful projects
before resetting if their containers are still running.
