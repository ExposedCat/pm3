use std::fmt;

/// Classifies failures so callers can map them to exit codes or HTTP statuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Invalid command-line usage.
    Usage,
    /// The request is valid but cannot be applied to the current input/state.
    Input,
    /// Runtime failure of an external command or the system.
    Failure,
}

#[derive(Debug)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn usage(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Usage, message: message.into() }
    }

    pub fn input(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Input, message: message.into() }
    }

    pub fn failure(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Failure, message: message.into() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::FromSqlConversionFailure(_, _, cause) => Self::failure(cause.to_string()),
            error => Self::failure(format!("Database error: {error}")),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::failure(error.to_string())
    }
}
