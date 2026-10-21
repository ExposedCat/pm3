//! Full-screen log viewer. Lines stream into an on-disk spool while the user scrolls, searches
//! and switches layouts; the view stays pinned to the newest line until the user scrolls up.

use std::fs::File;
use std::future::Future;
use std::io::{self, Write};
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::PathBuf;
use std::time::Duration;

use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{column_width, format_row, row_values, target_color};
use crate::Context;
use crate::error::{Error, Result};
use crate::term::{sanitize, slice_visible, strip_ansi};

/// Spool bytes kept in memory before being written to the spool file.
const SPOOL_BUFFER: usize = 64 * 1024;
/// Lines taken from the channel per wakeup before the view gets a chance to redraw.
const INGEST_BATCH: usize = 4096;
const FRAME_INTERVAL: Duration = Duration::from_millis(40);
const PRODUCER_GRACE: Duration = Duration::from_secs(3);
const HORIZONTAL_STEP: usize = 8;
const HELP: [(&str, &str); 13] = [
    ("q  Esc  Ctrl-C", "quit"),
    ("↑ ↓  k j  mouse wheel", "scroll by line"),
    ("PgUp PgDn  b space", "scroll by page"),
    ("Ctrl-U  Ctrl-D", "scroll by half a page"),
    ("g  Home", "first line"),
    ("G  End", "newest line, keep following"),
    ("← →  h l  ^", "scroll sideways, back to start"),
    ("1-9  0", "show only that service, all services"),
    ("/", "search (backward from the newest line while following)"),
    ("n  N", "next match in search direction, opposite direction"),
    ("Enter on empty search", "clear search"),
    ("r", "switch between columns and one line per entry"),
    ("?", "toggle this help"),
];

pub struct LogLine {
    pub target: usize,
    pub text: String,
}

pub struct PagerOptions {
    pub title: String,
    pub labels: Vec<String>,
    /// Start in the one-line-per-entry layout instead of columns.
    pub flat: bool,
    /// Lines keep arriving after the history.
    pub live: bool,
}

/// Shows streamed log lines until the user quits, driving `producer` alongside; on quit the
/// producer is stopped through `stop_producer` and awaited, so its podman processes exit.
pub async fn run(
    ctx: &Context,
    options: PagerOptions,
    mut lines: mpsc::Receiver<LogLine>,
    producer: impl Future<Output = Result<()>>,
    stop_producer: &CancellationToken,
) -> Result<()> {
    let mut viewer = Viewer::new(options, Spool::create()?);
    let terminal = TerminalGuard::enter()?;
    viewer.resize(crossterm::terminal::size()?);

    let mut events = EventStream::new();
    let mut frames = tokio::time::interval(FRAME_INTERVAL);
    frames.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tokio::pin!(producer);
    let mut producing = true;
    let mut receiving = true;
    let mut dirty = true;

    loop {
        tokio::select! {
            event = events.next() => match event {
                Some(Ok(event)) => {
                    if viewer.handle(event) == Flow::Quit {
                        break;
                    }
                    viewer.render()?;
                    dirty = false;
                }
                Some(Err(_)) | None => break,
            },
            line = lines.recv(), if receiving => match line {
                Some(line) => {
                    viewer.push(&line)?;
                    for _ in 1..INGEST_BATCH {
                        let Ok(line) = lines.try_recv() else { break };
                        viewer.push(&line)?;
                    }
                    dirty = true;
                }
                None => {
                    receiving = false;
                    viewer.loading = false;
                    dirty = true;
                }
            },
            result = &mut producer, if producing => {
                producing = false;
                viewer.error = result.err().map(|error| error.message);
                dirty = true;
            }
            _ = frames.tick(), if dirty => {
                viewer.render()?;
                dirty = false;
            }
            () = ctx.cancel.cancelled() => break,
        }
    }

    drop(terminal);
    stop_producer.cancel();
    drop(lines);
    if producing {
        let _ = tokio::time::timeout(PRODUCER_GRACE, producer).await;
    }
    viewer.error.map_or(Ok(()), |error| Err(Error::failure(error)))
}

/// Raw mode on the alternate screen; restored on drop and on panic.
struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<Self> {
        crossterm::terminal::enable_raw_mode()?;
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore_terminal();
            previous(info);
        }));
        // Alternate screen, hidden cursor, and mouse wheel as arrow keys (keeps text selection).
        write_terminal("\x1b[?1049h\x1b[?25l\x1b[?1007h");
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

fn restore_terminal() {
    write_terminal("\x1b[?1007l\x1b[0m\x1b[?25h\x1b[?1049l");
    let _ = crossterm::terminal::disable_raw_mode();
}

fn write_terminal(output: &str) {
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(output.as_bytes()).and_then(|()| stdout.flush());
}

fn named_spool_file(dir: &std::path::Path) -> Result<File> {
    for attempt in 0u32.. {
        let path = dir.join(format!("logs-{}-{}-{attempt}.spool", std::process::id(), crate::time::unix_now_millis()));
        match File::options().read(true).write(true).create_new(true).open(&path) {
            Ok(file) => {
                std::fs::remove_file(&path)?;
                return Ok(file);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::failure("Failed to create the log spool"))
}

/// Append-only line store on disk: memory holds only offsets and targets per line.
struct Spool {
    file: File,
    written: u64,
    pending: Vec<u8>,
    offsets: Vec<u64>,
    targets: Vec<u16>,
}

impl Spool {
    /// Creates an anonymous file in the user cache directory (on disk, unlike tmpfs `/tmp`).
    fn create() -> Result<Self> {
        let dir = std::env::var_os("XDG_CACHE_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
            .unwrap_or_else(std::env::temp_dir)
            .join("pm3");
        std::fs::create_dir_all(&dir)?;
        let file = match File::options().read(true).write(true).custom_flags(libc::O_TMPFILE).open(&dir) {
            Ok(file) => file,
            // Filesystems without O_TMPFILE: create a uniquely named file and unlink it right away.
            Err(_) => named_spool_file(&dir)?,
        };
        Ok(Self {
            file,
            written: 0,
            pending: Vec::with_capacity(SPOOL_BUFFER),
            offsets: Vec::new(),
            targets: Vec::new(),
        })
    }

    fn len(&self) -> usize {
        self.offsets.len()
    }

    /// Spool indices of every line from `target`.
    fn indices_of(&self, target: usize) -> Vec<usize> {
        self.targets
            .iter()
            .enumerate()
            .filter(|(_, line)| usize::from(**line) == target)
            .map(|(index, _)| index)
            .collect()
    }

    fn push(&mut self, target: usize, text: &str) -> io::Result<()> {
        self.offsets.push(self.written + self.pending.len() as u64);
        self.targets.push(u16::try_from(target).unwrap_or(u16::MAX));
        self.pending.extend_from_slice(text.as_bytes());
        if self.pending.len() >= SPOOL_BUFFER {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.write_all_at(&self.pending, self.written)?;
        self.written += self.pending.len() as u64;
        self.pending.clear();
        Ok(())
    }

    fn end(&self, index: usize) -> u64 {
        self.offsets.get(index + 1).copied().unwrap_or(self.written + self.pending.len() as u64)
    }

    fn get(&self, index: usize) -> io::Result<(usize, String)> {
        let (start, end) = (self.offsets[index], self.end(index));
        let mut bytes = vec![0; usize::try_from(end - start).unwrap_or(0)];
        let from_file = usize::try_from(self.written.saturating_sub(start)).unwrap_or(usize::MAX).min(bytes.len());
        self.file.read_exact_at(&mut bytes[..from_file], start)?;
        let pending_start = usize::try_from(start.saturating_sub(self.written)).unwrap_or(0);
        let rest = bytes.len() - from_file;
        bytes[from_file..].copy_from_slice(&self.pending[pending_start..pending_start + rest]);
        Ok((usize::from(self.targets[index]), String::from_utf8_lossy(&bytes).into_owned()))
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Continue,
    Quit,
}

/// Scroll positions (`top`, `first_visible`, ...) index the view: every spool line, or only the
/// lines of the `filter` service through `filtered`. Search matches are spool indices.
struct Viewer {
    options: PagerOptions,
    spool: Spool,
    /// Service whose lines are shown alone, full width.
    filter: Option<usize>,
    /// Spool indices of the `filter` service's lines.
    filtered: Vec<usize>,
    width: usize,
    height: usize,
    /// First visible view position while not following.
    top: usize,
    /// Pinned to the newest line; turns off when scrolling up, back on at the bottom.
    following: bool,
    /// Lines that arrived while not following.
    unseen: usize,
    horizontal: usize,
    loading: bool,
    search: Option<String>,
    /// Direction of the last search; `n` repeats it, `N` reverses it.
    search_backward: bool,
    help: bool,
    prompt: Option<String>,
    current_match: Option<usize>,
    notice: Option<String>,
    error: Option<String>,
}

impl Viewer {
    fn new(options: PagerOptions, spool: Spool) -> Self {
        Self {
            options,
            spool,
            filter: None,
            filtered: Vec::new(),
            width: 80,
            height: 24,
            top: 0,
            following: true,
            unseen: 0,
            horizontal: 0,
            loading: true,
            search: None,
            search_backward: false,
            help: false,
            prompt: None,
            current_match: None,
            notice: None,
            error: None,
        }
    }

    fn resize(&mut self, (columns, rows): (u16, u16)) {
        self.width = usize::from(columns).max(1);
        self.height = usize::from(rows).max(2);
        self.top = self.top.min(self.max_top());
    }

    fn push(&mut self, line: &LogLine) -> Result<()> {
        self.spool.push(line.target, &sanitize(&line.text))?;
        let visible = self.filter.is_none_or(|target| target == line.target);
        if visible && self.filter.is_some() {
            self.filtered.push(self.spool.len() - 1);
        }
        if visible && !self.following {
            self.unseen += 1;
        }
        Ok(())
    }

    fn view_len(&self) -> usize {
        if self.filter.is_some() { self.filtered.len() } else { self.spool.len() }
    }

    fn spool_index(&self, position: usize) -> usize {
        if self.filter.is_some() { self.filtered[position] } else { position }
    }

    /// View position of a spool line, or of the first shown line after it.
    fn view_position(&self, index: usize) -> usize {
        if self.filter.is_some() { self.filtered.partition_point(|&shown| shown < index) } else { index }
    }

    /// Shows only `target`'s lines, or every line for `None`, keeping the first visible line in place.
    fn set_filter(&mut self, filter: Option<usize>) {
        let anchor = (!self.following && self.view_len() > 0).then(|| self.spool_index(self.first_visible()));
        self.filter = filter;
        self.filtered = filter.map_or_else(Vec::new, |target| self.spool.indices_of(target));
        self.current_match = None;
        self.unseen = 0;
        if let Some(anchor) = anchor {
            self.top = self.view_position(anchor).min(self.max_top());
        }
    }

    fn header_rows(&self) -> usize {
        usize::from(!self.options.flat || self.filter.is_some())
    }

    fn body_rows(&self) -> usize {
        self.height.saturating_sub(1 + self.header_rows()).max(1)
    }

    fn max_top(&self) -> usize {
        self.view_len().saturating_sub(self.body_rows())
    }

    fn first_visible(&self) -> usize {
        if self.following { self.max_top() } else { self.top.min(self.max_top()) }
    }

    fn scroll_up(&mut self, lines: usize) {
        if self.following {
            self.top = self.max_top();
            self.following = false;
            self.unseen = 0;
        }
        self.top = self.top.saturating_sub(lines);
    }

    fn scroll_down(&mut self, lines: usize) {
        if self.following {
            return;
        }
        self.top = (self.top + lines).min(self.max_top());
        if self.top == self.max_top() {
            self.follow();
        }
    }

    fn follow(&mut self) {
        self.following = true;
        self.unseen = 0;
    }

    fn jump_to(&mut self, position: usize) {
        self.following = false;
        self.unseen = 0;
        self.top = position.saturating_sub(self.body_rows() / 3).min(self.max_top());
    }

    fn handle(&mut self, event: Event) -> Flow {
        match event {
            Event::Resize(columns, rows) => {
                self.resize((columns, rows));
                Flow::Continue
            }
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                self.notice = None;
                if self.prompt.is_some() { self.handle_prompt(key) } else { self.handle_key(key) }
            }
            _ => Flow::Continue,
        }
    }

    fn handle_prompt(&mut self, key: KeyEvent) -> Flow {
        let Some(prompt) = &mut self.prompt else { return Flow::Continue };
        match key.code {
            KeyCode::Esc => self.prompt = None,
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => self.prompt = None,
            KeyCode::Backspace => {
                if prompt.pop().is_none() {
                    self.prompt = None;
                }
            }
            KeyCode::Enter => {
                let query = self.prompt.take().unwrap_or_default();
                if query.is_empty() {
                    self.search = None;
                    self.current_match = None;
                } else {
                    self.search = Some(query.to_lowercase());
                    self.search_backward = self.following;
                    self.current_match = None;
                    self.find(!self.search_backward);
                }
            }
            KeyCode::Char(char) => prompt.push(char),
            _ => {}
        }
        Flow::Continue
    }

    fn handle_key(&mut self, key: KeyEvent) -> Flow {
        let page = self.body_rows().saturating_sub(1).max(1);
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => return Flow::Quit,
            KeyCode::Char('c') if control => return Flow::Quit,
            KeyCode::Up | KeyCode::Char('k') => self.scroll_up(1),
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Enter => self.scroll_down(1),
            KeyCode::Char('u') if control => self.scroll_up(page / 2),
            KeyCode::Char('d') if control => self.scroll_down(page / 2),
            KeyCode::PageUp | KeyCode::Char('b') => self.scroll_up(page),
            KeyCode::PageDown | KeyCode::Char(' ' | 'f') => self.scroll_down(page),
            KeyCode::Home | KeyCode::Char('g') => {
                self.following = false;
                self.unseen = 0;
                self.top = 0;
            }
            KeyCode::End | KeyCode::Char('G') => self.follow(),
            KeyCode::Left | KeyCode::Char('h') => self.horizontal = self.horizontal.saturating_sub(HORIZONTAL_STEP),
            KeyCode::Right | KeyCode::Char('l') => self.horizontal += HORIZONTAL_STEP,
            KeyCode::Char('^') => self.horizontal = 0,
            KeyCode::Char('0') => self.set_filter(None),
            KeyCode::Char(digit @ '1'..='9') => {
                let target = digit as usize - '1' as usize;
                if target < self.options.labels.len() {
                    self.set_filter(if self.filter == Some(target) { None } else { Some(target) });
                }
            }
            KeyCode::Char('r') => {
                let first = self.first_visible();
                self.options.flat = !self.options.flat;
                if !self.following {
                    self.top = first.min(self.max_top());
                }
            }
            KeyCode::Char('/') => self.prompt = Some(String::new()),
            KeyCode::Char('n') => self.find(!self.search_backward),
            KeyCode::Char('N') => self.find(self.search_backward),
            KeyCode::Char('?') => self.help = !self.help,
            _ => {}
        }
        Flow::Continue
    }

    /// Moves to the next (or previous) line containing the search text, wrapping around.
    fn find(&mut self, forward: bool) {
        let Some(query) = self.search.clone() else {
            self.notice = Some("No search; press / to search".to_owned());
            return;
        };
        let total = self.view_len();
        if total == 0 {
            self.notice = Some(format!("Not found: {query}"));
            return;
        }

        let start = match (self.current_match.map(|index| self.view_position(index)), forward) {
            (Some(position), true) => position + 1,
            (Some(position), false) => position + total - 1,
            (None, true) => self.first_visible(),
            (None, false) => self.first_visible() + self.body_rows() + total - 1,
        };
        for step in 0..total {
            let position = if forward { (start + step) % total } else { (start + total - step % total) % total };
            let index = self.spool_index(position);
            let matches =
                self.spool.get(index).is_ok_and(|(_, text)| strip_ansi(&text).to_lowercase().contains(&query));
            if matches {
                if forward && position < start % total || !forward && position > start % total {
                    self.notice = Some("Search wrapped".to_owned());
                }
                self.current_match = Some(index);
                self.jump_to(position);
                return;
            }
        }
        self.notice = Some(format!("Not found: {query}"));
    }

    fn render(&self) -> Result<()> {
        let mut frame = String::with_capacity(self.width * self.height * 2);
        // Synchronized update: the terminal shows the frame only once it is complete.
        frame.push_str("\x1b[?2026h");
        let mut row = 1;

        let width = column_width(self.options.labels.len(), self.width);
        if let Some(header) = self.header(width) {
            self.push_row(&mut frame, row, &slice_visible(&header, 0, self.width));
            row += 1;
        }

        let first = self.first_visible();
        let last = (first + self.body_rows()).min(self.view_len());
        if self.help {
            for (keys, action) in HELP.iter().take(self.body_rows()) {
                let line = format!("  \x1b[1m{keys:<24}\x1b[0m {action}");
                self.push_row(&mut frame, row, &slice_visible(&line, 0, self.width));
                row += 1;
            }
        } else {
            for position in first..last {
                let line = self.render_line(self.spool_index(position), width)?;
                self.push_row(&mut frame, row, &line);
                row += 1;
            }
        }
        while row < self.height {
            self.push_row(&mut frame, row, "");
            row += 1;
        }

        let status = self.status_line(first, last);
        self.push_row(&mut frame, self.height, &format!("\x1b[7m{status}\x1b[0m"));
        frame.push_str("\x1b[?2026l");

        let mut stdout = io::stdout().lock();
        stdout.write_all(frame.as_bytes())?;
        stdout.flush()?;
        Ok(())
    }

    /// Numbered service names: column titles, or a tab bar while one service is shown alone.
    fn header(&self, width: usize) -> Option<String> {
        let number = |index: usize| if index < 9 { format!("[{}] ", index + 1) } else { String::new() };
        let labels = self.options.labels.iter().enumerate();
        match self.filter {
            Some(active) => {
                let tabs: String = labels
                    .map(|(index, label)| {
                        if index == active {
                            format!("\x1b[1;7m {}{label} \x1b[0m ", number(index))
                        } else {
                            format!(" {}{} ", number(index), target_color(index)(label))
                        }
                    })
                    .collect();
                Some(format!(" [0] all {tabs}"))
            }
            None if !self.options.flat => {
                let names: Vec<String> = labels
                    .map(|(index, label)| format!("\x1b[1m{}{}", number(index), target_color(index)(label)))
                    .collect();
                Some(format_row(&names, width))
            }
            None => None,
        }
    }

    fn push_row(&self, frame: &mut String, row: usize, content: &str) {
        frame.push_str(&format!("\x1b[{row};1H\x1b[2K{content}\x1b[0m"));
    }

    fn render_line(&self, index: usize, width: usize) -> Result<String> {
        let (target, text) = self.spool.get(index)?;
        let line = if self.filter.is_some() {
            slice_visible(&text, self.horizontal, self.width)
        } else if self.options.flat {
            let prefix = if self.options.labels.len() > 1 {
                let label = self.options.labels.get(target).map_or("", String::as_str);
                format!("{} | ", target_color(target)(label))
            } else {
                String::new()
            };
            let available = self.width.saturating_sub(strip_ansi(&prefix).chars().count());
            format!("{prefix}{}", slice_visible(&text, self.horizontal, available))
        } else {
            let text = slice_visible(&text, self.horizontal, usize::MAX);
            slice_visible(&format_row(&row_values(self.options.labels.len(), target, &text), width), 0, self.width)
        };

        let Some(query) = &self.search else { return Ok(line) };
        let plain = strip_ansi(&line);
        if self.current_match == Some(index) {
            let padding = self.width.saturating_sub(plain.chars().count());
            return Ok(format!("\x1b[7m{plain}{}\x1b[27m", " ".repeat(padding)));
        }
        Ok(if plain.to_lowercase().contains(query.as_str()) { highlight(&plain, query) } else { line })
    }

    fn status_line(&self, first: usize, last: usize) -> String {
        if let Some(prompt) = &self.prompt {
            return pad(&format!("/{prompt}\u{2588}"), self.width);
        }

        let total = self.view_len();
        let position = if total == 0 { "0 lines".to_owned() } else { format!("{}-{last}/{total}", first + 1) };
        let state = match (&self.error, self.loading, self.options.live, self.following) {
            (Some(error), ..) => format!("error: {error}"),
            (None, true, false, _) => "loading…".to_owned(),
            (None, _, true, true) => "● live".to_owned(),
            (None, _, true, false) if self.unseen > 0 => format!("paused +{} new", self.unseen),
            (None, _, true, false) => "paused".to_owned(),
            (None, false, false, _) => "end".to_owned(),
        };
        let layout = match self.filter {
            Some(target) => self.options.labels.get(target).map_or("", String::as_str),
            None if self.options.flat => "lines",
            None => "columns",
        };
        let left = format!(" {} │ {position} │ {state} │ {layout} ", self.options.title);
        let right = self.notice.clone().unwrap_or_else(|| {
            if self.help { "? close help ".to_owned() } else { "/ search  r layout  ? help  q quit ".to_owned() }
        });

        let left_width = left.chars().count();
        let right_width = right.chars().count();
        if left_width + right_width < self.width {
            format!("{left}{}{right}", " ".repeat(self.width - left_width - right_width))
        } else {
            pad(&left, self.width)
        }
    }
}

fn pad(text: &str, width: usize) -> String {
    let text: String = text.chars().take(width).collect();
    let padding = width.saturating_sub(text.chars().count());
    format!("{text}{}", " ".repeat(padding))
}

/// Marks every case-insensitive occurrence of `query` (already lowercase) in plain text.
fn highlight(plain: &str, query: &str) -> String {
    let lower = plain.to_lowercase();
    if lower.len() != plain.len() {
        return plain.to_owned();
    }
    let mut output = String::with_capacity(plain.len() + 16);
    let mut index = 0;
    while let Some(found) = lower[index..].find(query) {
        let start = index + found;
        output.push_str(&plain[index..start]);
        output.push_str("\x1b[30;43m");
        output.push_str(&plain[start..start + query.len()]);
        output.push_str("\x1b[0m");
        index = start + query.len();
    }
    output.push_str(&plain[index..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer(lines: &[&str]) -> Viewer {
        let options = PagerOptions { title: "app".to_owned(), labels: vec!["web".to_owned()], flat: true, live: true };
        let mut viewer = Viewer::new(options, Spool::create().unwrap());
        viewer.resize((40, 6));
        for line in lines {
            viewer.push(&LogLine { target: 0, text: (*line).to_owned() }).unwrap();
        }
        viewer
    }

    #[test]
    fn spool_reads_back_lines_across_flushes() {
        let mut spool = Spool::create().unwrap();
        let long = "x".repeat(SPOOL_BUFFER);
        spool.push(0, "first").unwrap();
        spool.push(1, &long).unwrap();
        spool.push(2, "pending").unwrap();
        assert_eq!(spool.get(0).unwrap(), (0, "first".to_owned()));
        assert_eq!(spool.get(1).unwrap(), (1, long));
        assert_eq!(spool.get(2).unwrap(), (2, "pending".to_owned()));
        assert_eq!(spool.len(), 3);
    }

    #[test]
    fn follows_until_scrolled_up_and_resumes_at_the_bottom() {
        let lines: Vec<String> = (0..20).map(|index| format!("line {index}")).collect();
        let mut viewer = viewer(&lines.iter().map(String::as_str).collect::<Vec<_>>());
        assert!(viewer.following);
        assert_eq!(viewer.first_visible(), 15);

        viewer.scroll_up(3);
        assert!(!viewer.following);
        assert_eq!(viewer.first_visible(), 12);
        viewer.push(&LogLine { target: 0, text: "new".to_owned() }).unwrap();
        assert_eq!(viewer.unseen, 1);
        assert_eq!(viewer.first_visible(), 12);

        viewer.scroll_down(10);
        assert!(viewer.following);
        assert_eq!(viewer.first_visible(), 16);
    }

    #[test]
    fn searches_forward_and_backward_with_wrapping() {
        let mut viewer = viewer(&["alpha", "beta ERROR", "gamma", "delta error", "omega"]);
        viewer.search = Some("error".to_owned());
        viewer.find(true);
        assert_eq!(viewer.current_match, Some(1));
        viewer.find(true);
        assert_eq!(viewer.current_match, Some(3));
        viewer.find(true);
        assert_eq!(viewer.current_match, Some(1));
        viewer.find(false);
        assert_eq!(viewer.current_match, Some(3));
        viewer.follow();
        viewer.search_backward = true;
        viewer.current_match = None;
        viewer.find(false);
        assert_eq!(viewer.current_match, Some(3), "backward search from the live end finds the newest match");

        viewer.search = Some("missing".to_owned());
        viewer.find(true);
        assert_eq!(viewer.notice.as_deref(), Some("Not found: missing"));
    }

    #[test]
    fn filters_to_one_service_and_back_keeping_position() {
        let options = PagerOptions {
            title: "app".to_owned(),
            labels: vec!["web".to_owned(), "db".to_owned()],
            flat: false,
            live: true,
        };
        let mut viewer = Viewer::new(options, Spool::create().unwrap());
        viewer.resize((40, 6));
        for index in 0..20 {
            viewer.push(&LogLine { target: index % 2, text: format!("line {index}") }).unwrap();
        }
        let press = |viewer: &mut Viewer, key: char| {
            viewer.handle(Event::Key(KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE)));
        };

        press(&mut viewer, '3');
        assert_eq!(viewer.filter, None, "keys past the last service are ignored");
        press(&mut viewer, '2');
        assert_eq!(viewer.filter, Some(1));
        assert_eq!(viewer.filtered, vec![1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
        assert_eq!(viewer.spool_index(viewer.first_visible()), 13);

        viewer.push(&LogLine { target: 0, text: "web".to_owned() }).unwrap();
        viewer.push(&LogLine { target: 1, text: "db".to_owned() }).unwrap();
        assert_eq!(viewer.filtered.last(), Some(&21));
        assert_eq!(viewer.view_len(), 11);

        viewer.scroll_up(4);
        assert_eq!(viewer.spool_index(viewer.first_visible()), 7);
        viewer.push(&LogLine { target: 0, text: "hidden".to_owned() }).unwrap();
        assert_eq!(viewer.unseen, 0, "lines of other services are not counted as new");

        viewer.search = Some("line 1".to_owned());
        viewer.find(true);
        assert_eq!(viewer.current_match, Some(11), "search only visits the shown service");

        press(&mut viewer, '0');
        assert_eq!(viewer.filter, None);
        assert_eq!(viewer.current_match, None);
        assert!(!viewer.following);
        assert_eq!(viewer.first_visible(), 9, "the first line shown before stays first");
        assert_eq!(viewer.view_len(), 23);

        press(&mut viewer, '1');
        press(&mut viewer, '1');
        assert_eq!(viewer.filter, None, "pressing the shown service again shows all");
    }

    #[test]
    fn highlights_matches_case_insensitively() {
        assert_eq!(highlight("An Error here", "error"), "An \x1b[30;43mError\x1b[0m here");
    }
}
