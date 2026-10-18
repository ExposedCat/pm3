use std::collections::HashSet;
use std::io::{IsTerminal, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::task::JoinHandle;

pub fn paint(code: &str, value: &str) -> String {
    format!("\x1b[{code}m{value}\x1b[0m")
}

pub fn red(value: &str) -> String {
    paint("31", value)
}

pub fn green(value: &str) -> String {
    paint("32", value)
}

pub fn yellow(value: &str) -> String {
    paint("33", value)
}

pub fn blue(value: &str) -> String {
    paint("34", value)
}

pub fn magenta(value: &str) -> String {
    paint("35", value)
}

pub fn cyan(value: &str) -> String {
    paint("36", value)
}

pub fn underline(value: &str) -> String {
    paint("4", value)
}

pub fn orange(value: &str) -> String {
    paint("38;5;208", value)
}

/// Writes a line to stdout. Returns `false` once stdout is gone (closed pipe or terminal),
/// instead of panicking like `println!`.
pub fn print_line(line: &str) -> bool {
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(line.as_bytes()).and_then(|()| stdout.write_all(b"\n")).is_ok()
}

pub fn eprint_line(line: &str) {
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(line.as_bytes()).and_then(|()| stderr.write_all(b"\n"));
}

pub fn stdout_is_terminal() -> bool {
    std::io::stdout().is_terminal()
}

pub fn all_streams_are_terminals() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal() && std::io::stderr().is_terminal()
}

pub fn terminal_columns() -> Option<usize> {
    // SAFETY: TIOCGWINSZ only writes into the provided, properly sized winsize struct.
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) };
    (result == 0 && size.ws_col > 0).then_some(usize::from(size.ws_col))
}

/// Removes ANSI CSI escape sequences (`ESC [ params intermediates final`).
pub fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(char) = chars.next() {
        if char != '\x1b' || chars.peek() != Some(&'[') {
            output.push(char);
            continue;
        }

        chars.next();
        while chars.next_if(|next| ('0'..='?').contains(next)).is_some() {}
        while chars.next_if(|next| (' '..='/').contains(next)).is_some() {}
        chars.next_if(|next| ('@'..='~').contains(next));
    }

    output
}

/// Left-aligns columns separated by two spaces. `format_cell` receives the column header and
/// the padded value, so it can colorize content while keeping the padding intact.
pub fn format_table(rows: &[Vec<String>], format_cell: impl Fn(&str, &str) -> String) -> String {
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (index, value) in row.iter().enumerate() {
            let length = value.chars().count();
            match widths.get_mut(index) {
                Some(width) => *width = (*width).max(length),
                None => widths.push(length),
            }
        }
    }

    let headers = rows.first();
    rows.iter()
        .map(|row| {
            let cells: Vec<String> = row
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let padding = widths[index].saturating_sub(value.chars().count());
                    let padded = format!("{value}{}", " ".repeat(padding));
                    let header = headers.and_then(|headers| headers.get(index)).map_or("", String::as_str);
                    format_cell(header, &padded)
                })
                .collect();
            cells.join("  ").trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Splits a padded table cell into its content and trailing padding.
pub fn split_padding(value: &str) -> (&str, &str) {
    let content = value.trim_end();
    (content, &value[content.len()..])
}

/// Length of an SGR (color/style) escape sequence at the start of `text`.
pub fn sgr_sequence_length(text: &str) -> Option<usize> {
    let rest = text.strip_prefix("\x1b[")?;
    let parameters = rest.bytes().take_while(|byte| byte.is_ascii_digit() || *byte == b';').count();
    rest[parameters..].starts_with('m').then_some(2 + parameters + 1)
}

pub fn visible_width(text: &str) -> usize {
    let mut width = 0;
    let mut index = 0;
    while index < text.len() {
        if let Some(length) = sgr_sequence_length(&text[index..]) {
            index += length;
            continue;
        }
        let char = text[index..].chars().next().unwrap_or(' ');
        index += char.len_utf8();
        width += 1;
    }
    width
}

pub fn truncate_visible(text: &str, width: usize) -> String {
    let mut output = String::new();
    let mut visible = 0;
    let mut index = 0;
    let mut styled = false;
    while index < text.len() && visible < width {
        if let Some(length) = sgr_sequence_length(&text[index..]) {
            output.push_str(&text[index..index + length]);
            index += length;
            styled = true;
            continue;
        }
        let char = text[index..].chars().next().unwrap_or(' ');
        output.push(char);
        index += char.len_utf8();
        visible += 1;
    }
    if styled && !output.ends_with("\x1b[0m") {
        output.push_str("\x1b[0m");
    }
    output
}

/// Pads or truncates (with `...`) to exactly `width` visible characters, keeping colors.
pub fn fit_column(value: &str, width: usize) -> String {
    let normalized = value.replace('\t', " ").replace('\r', "");
    let visible = visible_width(&normalized);
    if visible <= width {
        return format!("{normalized}{}", " ".repeat(width - visible));
    }
    if width <= 3 {
        return truncate_visible(&normalized, width);
    }
    format!("{}...", truncate_visible(&normalized, width - 3))
}

/// Skips `skip` visible characters and keeps at most `width`, preserving colors.
pub fn slice_visible(text: &str, skip: usize, width: usize) -> String {
    let mut output = String::new();
    let mut visible = 0;
    let mut index = 0;
    let mut styled = false;
    while index < text.len() && visible < skip + width {
        if let Some(length) = sgr_sequence_length(&text[index..]) {
            output.push_str(&text[index..index + length]);
            index += length;
            styled = true;
            continue;
        }
        let char = text[index..].chars().next().unwrap_or(' ');
        if visible >= skip {
            output.push(char);
        }
        index += char.len_utf8();
        visible += 1;
    }
    if styled && !output.ends_with("\x1b[0m") {
        output.push_str("\x1b[0m");
    }
    output
}

/// Makes text safe to place on a full-screen display: keeps colors, drops other escape
/// sequences and control characters, and expands tabs.
pub fn sanitize(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        if let Some(length) = sgr_sequence_length(&text[index..]) {
            output.push_str(&text[index..index + length]);
            index += length;
            continue;
        }
        let char = text[index..].chars().next().unwrap_or(' ');
        index += char.len_utf8();
        match char {
            '\x1b' => {
                let rest = &text[index..];
                let skipped = if let Some(csi) = rest.strip_prefix('[') {
                    1 + csi.find(|char: char| ('@'..='~').contains(&char)).map_or(csi.len(), |end| end + 1)
                } else if let Some(osc) = rest.strip_prefix(']') {
                    1 + osc.find(['\x07', '\x1b']).map_or(osc.len(), |end| end + 1)
                } else {
                    rest.chars().next().map_or(0, char::len_utf8)
                };
                index += skipped.min(rest.len());
            }
            '\t' => output.push_str("    "),
            char if char.is_control() => {}
            char => output.push(char),
        }
    }
    output
}

const LOADER_FRAMES: [char; 4] = ['-', '\\', '|', '/'];
const LOADER_INTERVAL: Duration = Duration::from_millis(100);
const CHECKING_HEALTH: &str = "Checking health";
const HEALTHCHECK_TIMEOUT: &str = "Healthcheck timeout";

/// Multi-line progress output. On a terminal it renders an animated spinner block that is
/// redrawn in place; otherwise it prints plain lines as they start and finish.
pub struct Loader {
    state: Option<Arc<Mutex<LoaderState>>>,
    ticker: Option<JoinHandle<()>>,
}

enum LoaderState {
    Plain(PlainLoader),
    Terminal(TerminalLoader),
    Stopped,
}

impl Loader {
    pub fn start(label: String, enabled: bool) -> Self {
        if !enabled || !stdout_is_terminal() {
            let state = LoaderState::Plain(PlainLoader::default());
            return Self { state: Some(Arc::new(Mutex::new(state))), ticker: None };
        }

        let mut terminal = TerminalLoader { label, frame: 0, rendered_rows: 0, lines: Vec::new() };
        terminal.render();
        let state = Arc::new(Mutex::new(LoaderState::Terminal(terminal)));
        let ticker_state = Arc::clone(&state);
        let ticker = tokio::spawn(async move {
            let mut interval = tokio::time::interval(LOADER_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                if let LoaderState::Terminal(terminal) = &mut *lock(&ticker_state) {
                    terminal.tick();
                }
            }
        });

        Self { state: Some(state), ticker: Some(ticker) }
    }

    /// A loader that discards all output.
    #[cfg(test)]
    pub fn silent() -> Self {
        Self { state: None, ticker: None }
    }

    pub fn start_line(&self, id: &str, text: &str) {
        self.with_state(|state| match state {
            LoaderState::Plain(plain) => plain.start_line(id, text, false),
            LoaderState::Terminal(terminal) => terminal.insert(None, id, text, true),
            LoaderState::Stopped => {}
        });
    }

    pub fn start_line_after(&self, parent_id: &str, id: &str, text: &str) {
        self.with_state(|state| match state {
            LoaderState::Plain(plain) => plain.start_line(id, text, true),
            LoaderState::Terminal(terminal) => terminal.insert(Some(parent_id), id, text, true),
            LoaderState::Stopped => {}
        });
    }

    pub fn write_line(&self, id: &str, text: &str) {
        self.with_state(|state| match state {
            LoaderState::Plain(_) => {
                print_line(text);
            }
            LoaderState::Terminal(terminal) => terminal.insert(None, id, text, false),
            LoaderState::Stopped => {}
        });
    }

    pub fn write_line_after(&self, parent_id: &str, id: &str, text: &str) {
        self.with_state(|state| match state {
            LoaderState::Plain(_) => {
                print_line(&format!("    {text}"));
            }
            LoaderState::Terminal(terminal) => terminal.insert(Some(parent_id), id, text, false),
            LoaderState::Stopped => {}
        });
    }

    pub fn finish_line(&self, id: &str, text: &str) {
        self.with_state(|state| match state {
            LoaderState::Plain(plain) => plain.finish_line(id, text),
            LoaderState::Terminal(terminal) => terminal.finish_line(id, text),
            LoaderState::Stopped => {}
        });
    }

    /// Renders the final state. Idempotent; also runs on drop.
    pub fn stop(&self) {
        if let Some(ticker) = &self.ticker {
            ticker.abort();
        }
        self.with_state(|state| {
            match state {
                LoaderState::Plain(plain) => plain.stop(),
                LoaderState::Terminal(terminal) => terminal.stop(),
                LoaderState::Stopped => {}
            }
            *state = LoaderState::Stopped;
        });
    }

    fn with_state(&self, action: impl FnOnce(&mut LoaderState)) {
        if let Some(state) = &self.state {
            action(&mut lock(state));
        }
    }
}

impl Drop for Loader {
    fn drop(&mut self) {
        self.stop();
    }
}

fn lock(state: &Mutex<LoaderState>) -> MutexGuard<'_, LoaderState> {
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Default)]
struct PlainLoader {
    child_lines: HashSet<String>,
    active_lines: Vec<(String, String)>,
}

impl PlainLoader {
    fn start_line(&mut self, id: &str, text: &str, child: bool) {
        self.active_lines.retain(|(active_id, _)| active_id != id);
        self.active_lines.push((id.to_owned(), text.to_owned()));
        if child {
            self.child_lines.insert(id.to_owned());
            print_line(&format!("    {text}..."));
        } else {
            print_line(text);
        }
    }

    fn finish_line(&mut self, id: &str, text: &str) {
        self.active_lines.retain(|(active_id, _)| active_id != id);
        let indent = if self.child_lines.contains(id) { "    " } else { "" };
        print_line(&format!("{indent}{text}"));
    }

    fn stop(&mut self) {
        for (id, text) in self.active_lines.drain(..) {
            if self.child_lines.contains(&id) && strip_ansi(&text) == CHECKING_HEALTH {
                print_line(&format!("    {}", text.replace(CHECKING_HEALTH, HEALTHCHECK_TIMEOUT)));
            }
        }
    }
}

struct TerminalLoader {
    label: String,
    frame: usize,
    rendered_rows: usize,
    lines: Vec<TerminalLine>,
}

struct TerminalLine {
    active: bool,
    child: bool,
    id: String,
    text: String,
}

impl TerminalLoader {
    fn insert(&mut self, parent_id: Option<&str>, id: &str, text: &str, active: bool) {
        if self.lines.iter().any(|line| line.id == id) {
            return;
        }

        let line = TerminalLine { active, child: parent_id.is_some(), id: id.to_owned(), text: text.to_owned() };
        let position = parent_id
            .and_then(|parent_id| self.lines.iter().position(|line| line.id == parent_id))
            .map_or(self.lines.len(), |index| index + 1);
        self.lines.insert(position, line);
        self.render();
    }

    fn finish_line(&mut self, id: &str, text: &str) {
        if let Some(line) = self.lines.iter_mut().find(|line| line.id == id) {
            line.active = false;
            text.clone_into(&mut line.text);
            self.render();
        }
    }

    fn tick(&mut self) {
        if !self.lines.is_empty() && !self.lines.iter().any(|line| line.active) {
            return;
        }
        self.frame += 1;
        self.render();
    }

    fn stop(&mut self) {
        if self.lines.is_empty() {
            write_raw(&clear_rows(self.rendered_rows));
            self.rendered_rows = 0;
            return;
        }

        for line in &mut self.lines {
            if line.active && line.child && strip_ansi(&line.text) == CHECKING_HEALTH {
                line.text = line.text.replace(CHECKING_HEALTH, HEALTHCHECK_TIMEOUT);
            }
            line.active = false;
        }
        self.render();
    }

    fn render(&mut self) {
        let frame = LOADER_FRAMES[self.frame % LOADER_FRAMES.len()];
        let rendered: Vec<String> = if self.lines.is_empty() {
            vec![format!("{frame} {}...", self.label)]
        } else {
            self.lines
                .iter()
                .map(|line| {
                    let indent = if line.child { "  " } else { "" };
                    if line.active {
                        format!("{frame} {indent}{}...", line.text)
                    } else {
                        format!("  {indent}{}", line.text)
                    }
                })
                .collect()
        };

        let mut output = clear_rows(self.rendered_rows);
        for line in &rendered {
            output.push_str("\r\x1b[K");
            output.push_str(line);
            output.push('\n');
        }
        write_raw(&output);

        let columns = terminal_columns().unwrap_or(80);
        self.rendered_rows = rendered.iter().map(|line| count_rows(line, columns)).sum();
    }
}

fn write_raw(output: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(output.as_bytes()).and_then(|()| stdout.flush());
}

fn clear_rows(rows: usize) -> String {
    if rows == 0 { String::new() } else { format!("\x1b[{rows}A\r\x1b[J") }
}

fn count_rows(line: &str, columns: usize) -> usize {
    strip_ansi(line)
        .split('\n')
        .map(|segment| segment.trim_end_matches('\r').chars().count().div_ceil(columns).max(1))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_column_text_around_ansi_sequences() {
        assert_eq!(fit_column("abc", 5), "abc  ");
        assert_eq!(fit_column("\x1b[31mabc\x1b[0m", 5), "\x1b[31mabc\x1b[0m  ");
        assert_eq!(fit_column("abcdefghij", 6), "abc...");
        assert_eq!(fit_column("\x1b[31mabcdefghij\x1b[0m", 6), "\x1b[31mabc\x1b[0m...");
        assert_eq!(fit_column("a\tb\r", 4), "a b ");
        assert_eq!(fit_column("abcdef", 2), "ab");
    }

    #[test]
    fn slices_and_sanitizes_display_text() {
        assert_eq!(slice_visible("abcdef", 2, 3), "cde");
        assert_eq!(slice_visible("\x1b[31mabcdef\x1b[0m", 4, 10), "\x1b[31mef\x1b[0m");
        assert_eq!(sanitize("a\tb\x1b[2Jc\x1b]0;title\x07d\x1b[32me\x1b[0m\x08"), "a    bcd\x1b[32me\x1b[0m");
    }

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m plain \x1b[38;5;208morange\x1b[0m"), "red plain orange");
        assert_eq!(strip_ansi("\x1b[2K\x1b[1Aline"), "line");
    }

    #[test]
    fn formats_tables_with_padding_outside_cells() {
        let rows = vec![vec!["NAME".to_owned(), "STATE".to_owned()], vec!["website".to_owned(), "up".to_owned()]];
        let table = format_table(&rows, |header, value| {
            if header == "STATE" {
                let (content, padding) = split_padding(value);
                format!("[{content}]{padding}")
            } else {
                value.to_owned()
            }
        });
        assert_eq!(table, "NAME     [STATE]\nwebsite  [up]");
    }

    #[test]
    fn counts_wrapped_rows() {
        assert_eq!(count_rows("abcdef", 3), 2);
        assert_eq!(count_rows("", 3), 1);
        assert_eq!(count_rows("ab\ncdefg", 3), 3);
    }
}
