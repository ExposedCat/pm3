use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};

use crate::error::{Error, Result};
use crate::time::now_iso;

const DATABASE_PATH_ENV: &str = "PM3_DATABASE_PATH";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Ordered schema migrations. Names match the original Kysely migrations so existing
/// databases keep their history and are migrated in place.
const MIGRATIONS: [(&str, &str); 7] = [
    (
        "2026-04-22-create-projects",
        r#"create table if not exists "projects" ("id" integer primary key autoincrement, "name" text not null unique, "workingDir" text not null);"#,
    ),
    ("2026-04-27-add-project-enabled", r#"alter table "projects" add column "enabled" integer default 0 not null;"#),
    (
        "2026-05-02-add-project-service-health",
        r#"create table if not exists "projectServiceHealth" ("projectId" integer not null references "projects" ("id") on delete cascade, "service" text not null, "status" text not null, "updatedAt" text not null, constraint "projectServiceHealthPrimary" primary key ("projectId", "service"));"#,
    ),
    (
        "2026-05-02-add-project-service-state",
        r#"create table if not exists "projectServiceState" ("projectId" integer not null references "projects" ("id") on delete cascade, "service" text not null, "status" text not null, "updatedAt" text not null, constraint "projectServiceStatePrimary" primary key ("projectId", "service"));"#,
    ),
    ("2026-07-16-add-project-git", r#"alter table "projects" add column "git" integer default 0 not null;"#),
    ("2026-07-20-add-project-compose-file", r#"alter table "projects" add column "composeFile" text;"#),
    (
        "2026-08-15-replace-project-compose-file-with-args",
        r#"alter table "projects" add column "composeArgs" text default '[]' not null;
           update "projects" set "composeArgs" = json_array('-f', "composeFile") where "composeFile" is not null;
           alter table "projects" drop column "composeFile";"#,
    ),
];

pub fn resolve_path() -> Result<PathBuf> {
    if let Some(path) = non_empty_env(DATABASE_PATH_ENV) {
        return Ok(PathBuf::from(path));
    }

    let data_dir = match non_empty_env("XDG_DATA_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => non_empty_env("HOME")
            .map(|home| Path::new(&home).join(".local").join("share"))
            .ok_or_else(|| Error::failure("HOME is required to resolve the pm3 database path."))?,
    };
    Ok(data_dir.join("pm3").join("pm3.sqlite"))
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Opens the database, creating and migrating it as needed.
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| Error::failure(format!("Failed to create {}: {error}", parent.display())))?;
    }
    let mut connection = connect(path)?;
    migrate(&mut connection)?;
    Ok(connection)
}

/// Opens an already migrated database.
pub fn connect(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<()> {
    connection.execute_batch(
        r#"create table if not exists "kysely_migration" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null);
           create table if not exists "kysely_migration_lock" ("id" varchar(255) not null primary key, "is_locked" integer default 0 not null);
           insert or ignore into "kysely_migration_lock" ("id", "is_locked") values ('migration_lock', 0);"#,
    )?;

    if pending_migrations(connection)?.is_empty() {
        return Ok(());
    }

    // Re-read under the write lock, so concurrent first runs apply each migration once.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (name, sql) in pending_migrations(&transaction)? {
        transaction
            .execute_batch(sql)
            .map_err(|error| Error::failure(format!("Database migration {name} failed: {error}")))?;
        transaction.execute(
            r#"insert into "kysely_migration" ("name", "timestamp") values (?1, ?2)"#,
            params![name, now_iso()],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn pending_migrations(connection: &Connection) -> Result<Vec<(&'static str, &'static str)>> {
    let applied: Vec<String> = connection
        .prepare(r#"select "name" from "kysely_migration""#)?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(MIGRATIONS.into_iter().filter(|(name, _)| !applied.iter().any(|applied| applied == name)).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub working_dir: String,
    pub enabled: bool,
    pub git: bool,
    pub compose_args: Vec<String>,
}

const PROJECT_COLUMNS: &str = r#""id", "name", "workingDir", "enabled", "git", "composeArgs""#;

fn read_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    let name: String = row.get(1)?;
    let compose_args: String = row.get(5)?;
    let compose_args = serde_json::from_str(&compose_args).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            format!("Invalid compose arguments for project: {name}").into(),
        )
    })?;

    Ok(Project {
        id: row.get(0)?,
        name,
        working_dir: row.get(2)?,
        enabled: row.get::<_, i64>(3)? == 1,
        git: row.get::<_, i64>(4)? == 1,
        compose_args,
    })
}

pub fn list_projects(connection: &Connection) -> Result<Vec<Project>> {
    let mut statement =
        connection.prepare_cached(&format!(r#"select {PROJECT_COLUMNS} from "projects" order by "name" asc"#))?;
    let projects = statement.query_map([], read_project)?.collect::<rusqlite::Result<_>>()?;
    Ok(projects)
}

pub fn project_by_name(connection: &Connection, name: &str) -> Result<Option<Project>> {
    let mut statement =
        connection.prepare_cached(&format!(r#"select {PROJECT_COLUMNS} from "projects" where "name" = ?1"#))?;
    Ok(statement.query_row([name], read_project).optional()?)
}

pub struct NewProject<'a> {
    pub name: &'a str,
    pub working_dir: &'a str,
    pub compose_args: &'a [String],
    pub git: bool,
}

pub fn add_project(connection: &Connection, project: &NewProject<'_>) -> Result<Project> {
    let compose_args =
        serde_json::to_string(project.compose_args).map_err(|error| Error::failure(error.to_string()))?;
    let result = connection.execute(
        r#"insert into "projects" ("name", "workingDir", "composeArgs", "git") values (?1, ?2, ?3, ?4)"#,
        params![project.name, project.working_dir, compose_args, i64::from(project.git)],
    );

    match result {
        Err(rusqlite::Error::SqliteFailure(error, _))
            if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            Err(Error::input(format!("Project {} already exists", project.name)))
        }
        Err(error) => Err(error.into()),
        Ok(_) => project_by_name(connection, project.name)?
            .ok_or_else(|| Error::failure("Project was inserted but could not be loaded.")),
    }
}

pub fn delete_project(connection: &Connection, id: i64) -> Result<()> {
    connection.execute(r#"delete from "projects" where "id" = ?1"#, [id])?;
    Ok(())
}

pub fn set_project_enabled(connection: &Connection, id: i64, enabled: bool) -> Result<()> {
    connection.execute(r#"update "projects" set "enabled" = ?1 where "id" = ?2"#, params![i64::from(enabled), id])?;
    Ok(())
}

pub fn set_project_git(connection: &Connection, id: i64, git: bool) -> Result<()> {
    connection.execute(r#"update "projects" set "git" = ?1 where "id" = ?2"#, params![i64::from(git), id])?;
    Ok(())
}

/// Which persisted per-service status table to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceTable {
    Health,
    State,
}

impl ServiceTable {
    fn name(self) -> &'static str {
        match self {
            Self::Health => "projectServiceHealth",
            Self::State => "projectServiceState",
        }
    }
}

pub struct ServiceRecord {
    pub project_id: i64,
    pub service: String,
    pub status: String,
}

pub fn list_service_records(connection: &Connection, table: ServiceTable) -> Result<Vec<ServiceRecord>> {
    let mut statement =
        connection.prepare_cached(&format!(r#"select "projectId", "service", "status" from "{}""#, table.name()))?;
    let records = statement
        .query_map([], |row| Ok(ServiceRecord { project_id: row.get(0)?, service: row.get(1)?, status: row.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(records)
}

pub fn set_service_record(
    connection: &Connection,
    table: ServiceTable,
    project_id: i64,
    service: &str,
    status: &str,
) -> Result<()> {
    let mut statement = connection.prepare_cached(&format!(
        r#"insert into "{}" ("projectId", "service", "status", "updatedAt") values (?1, ?2, ?3, ?4)
           on conflict ("projectId", "service") do update set "status" = excluded."status", "updatedAt" = excluded."updatedAt""#,
        table.name()
    ))?;
    statement.execute(params![project_id, service, status, now_iso()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_database() -> (tempdir::TempDir, Connection) {
        let directory = tempdir::TempDir::new();
        let connection = open(&directory.path().join("pm3.sqlite")).unwrap();
        (directory, connection)
    }

    #[test]
    fn persists_compose_arguments_in_order() {
        let (_directory, connection) = temp_database();
        let args = ["-f", "compose.prod.yaml", "--profile", "production"].map(String::from);
        add_project(&connection, &NewProject { name: "api", working_dir: "/project", compose_args: &args, git: false })
            .unwrap();

        let project = project_by_name(&connection, "api").unwrap().unwrap();
        assert_eq!(project.compose_args, args);
        assert!(!project.enabled);
        assert!(!project.git);
    }

    #[test]
    fn reports_duplicate_project_names() {
        let (_directory, connection) = temp_database();
        let project = NewProject { name: "api", working_dir: "/first", compose_args: &[], git: false };
        add_project(&connection, &project).unwrap();
        let error = add_project(&connection, &NewProject { working_dir: "/second", ..project }).unwrap_err();
        assert_eq!(error.message, "Project api already exists");
    }

    #[test]
    fn migrates_legacy_compose_files_to_arguments() {
        let directory = tempdir::TempDir::new();
        let path = directory.path().join("pm3.sqlite");
        drop(open(&path).unwrap());

        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                r"alter table projects add column composeFile text;
                   delete from kysely_migration where name = '2026-08-15-replace-project-compose-file-with-args';
                   alter table projects drop column composeArgs;
                   insert into projects (name, workingDir, enabled, git, composeFile) values ('api', '/project', 0, 0, '/project/compose.prod.yaml');",
            )
            .unwrap();
        drop(legacy);

        let connection = open(&path).unwrap();
        let project = project_by_name(&connection, "api").unwrap().unwrap();
        assert_eq!(project.compose_args, ["-f", "/project/compose.prod.yaml"]);
    }

    #[test]
    fn reports_invalid_compose_arguments() {
        let (_directory, connection) = temp_database();
        connection
            .execute(r#"insert into projects (name, workingDir, composeArgs) values ('bad', '/p', '{"a":1}')"#, [])
            .unwrap();
        assert_eq!(list_projects(&connection).unwrap_err().message, "Invalid compose arguments for project: bad");
    }

    #[test]
    fn cascades_service_records_on_project_delete() {
        let (_directory, connection) = temp_database();
        let project =
            add_project(&connection, &NewProject { name: "api", working_dir: "/p", compose_args: &[], git: true })
                .unwrap();
        set_service_record(&connection, ServiceTable::State, project.id, "web", "started").unwrap();
        set_service_record(&connection, ServiceTable::State, project.id, "web", "stopped").unwrap();
        set_service_record(&connection, ServiceTable::Health, project.id, "web", "healthy").unwrap();

        let states = list_service_records(&connection, ServiceTable::State).unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].status, "stopped");

        delete_project(&connection, project.id).unwrap();
        assert!(list_service_records(&connection, ServiceTable::State).unwrap().is_empty());
        assert!(list_service_records(&connection, ServiceTable::Health).unwrap().is_empty());
    }

    /// Minimal self-cleaning temporary directory for tests.
    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicUsize, Ordering};

        pub struct TempDir(PathBuf);

        impl TempDir {
            pub fn new() -> Self {
                static COUNTER: AtomicUsize = AtomicUsize::new(0);
                let path = std::env::temp_dir().join(format!(
                    "pm3-test-{}-{}",
                    std::process::id(),
                    COUNTER.fetch_add(1, Ordering::Relaxed)
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
