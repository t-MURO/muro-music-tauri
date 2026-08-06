//! Token-authorized ranged HTTP server shared by Cast and DLNA.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use uuid::Uuid;

const IO_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Media,
    Artwork,
}

impl MediaKind {
    fn segment(self) -> &'static str {
        match self {
            Self::Media => "media",
            Self::Artwork => "artwork",
        }
    }
}

#[derive(Clone)]
struct AuthorizedFile {
    path: PathBuf,
    kind: MediaKind,
}

#[derive(Default)]
struct ServerState {
    session_token: Option<String>,
    authorized: HashMap<String, AuthorizedFile>,
}

struct RunningServer {
    port: u16,
    shutdown: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Clone, Default)]
pub struct LanMediaServer {
    state: Arc<Mutex<ServerState>>,
    running: Arc<Mutex<Option<RunningServer>>>,
}

impl LanMediaServer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self) -> Result<u16, String> {
        let mut running = self.running.lock().map_err(lock_error)?;
        if let Some(server) = running.as_ref() {
            return Ok(server.port);
        }
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|error| format!("Remote media server could not start: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = shutdown.clone();
        let state = self.state.clone();
        let thread = thread::Builder::new()
            .name("muro-remote-media".into())
            .spawn(move || {
                while !worker_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let state = state.clone();
                            let _ = thread::Builder::new()
                                .name("muro-remote-http".into())
                                .spawn(move || {
                                    let _ = handle_connection(stream, &state);
                                });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20))
                        }
                        Err(_) => thread::sleep(Duration::from_millis(50)),
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        *running = Some(RunningServer {
            port,
            shutdown,
            thread,
        });
        Ok(port)
    }

    pub fn stop(&self) {
        let current = self.running.lock().ok().and_then(|mut value| value.take());
        if let Some(server) = current {
            server.shutdown.store(true, Ordering::Release);
            let _ = server.thread.join();
        }
        self.end_session();
    }

    pub fn begin_session(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(lock_error)?;
        state.session_token = Some(random_token());
        state.authorized.clear();
        Ok(())
    }

    pub fn end_session(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.session_token = None;
            state.authorized.clear();
        }
    }

    pub fn revoke_authorizations(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.authorized.clear();
        }
    }

    pub fn authorize_file(&self, path: &Path, kind: MediaKind) -> Result<String, String> {
        let canonical = path
            .canonicalize()
            .map_err(|_| "The selected media file is missing or unreadable".to_string())?;
        if !canonical.is_file() {
            return Err("The selected media path is not a file".into());
        }
        let mut state = self.state.lock().map_err(lock_error)?;
        let session = state
            .session_token
            .clone()
            .ok_or_else(|| "No active remote media session".to_string())?;
        let token = random_token();
        state.authorized.insert(
            token.clone(),
            AuthorizedFile {
                path: canonical,
                kind,
            },
        );
        Ok(format!("/{}/{session}/{token}", kind.segment()))
    }

    /// Selects the interface the OS routes toward the receiver, avoiding VPN adapters.
    pub fn url_for(&self, path: &str, receiver_host: &str) -> Option<String> {
        let port = self
            .running
            .lock()
            .ok()?
            .as_ref()
            .map(|server| server.port)?;
        let receiver: IpAddr = receiver_host.parse().ok()?;
        if !receiver.is_ipv4() {
            return None;
        }
        let socket = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)).ok()?;
        socket.connect(SocketAddr::new(receiver, 9)).ok()?;
        let local = socket.local_addr().ok()?.ip();
        (!local.is_loopback() && !local.is_unspecified())
            .then(|| format!("http://{local}:{port}{path}"))
    }
}

impl Drop for LanMediaServer {
    fn drop(&mut self) {
        if Arc::strong_count(&self.running) == 1 {
            self.stop();
        }
    }
}

fn random_token() -> String {
    Uuid::new_v4().simple().to_string()
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Remote media service state is unavailable".into()
}

fn handle_connection(
    mut stream: TcpStream,
    state: &Arc<Mutex<ServerState>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let mut request = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 2048];
    while request.len() < 32 * 1024 {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let Some((method, target, range)) = parse_request(&request) else {
        return write_empty(&mut stream, 400, "Bad Request", &[]);
    };
    if method != "GET" && method != "HEAD" {
        return write_empty(
            &mut stream,
            405,
            "Method Not Allowed",
            &[("Allow", "GET, HEAD")],
        );
    }
    let segments: Vec<_> = target
        .split('?')
        .next()
        .unwrap_or_default()
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let entry = if segments.len() == 3 {
        state.lock().ok().and_then(|state| {
            let file = state.authorized.get(segments[2])?;
            (segments[0] == file.kind.segment()
                && state.session_token.as_deref() == Some(segments[1]))
            .then(|| file.clone())
        })
    } else {
        None
    };
    let Some(entry) = entry else {
        return write_empty(
            &mut stream,
            404,
            "Not Found",
            &[("Cache-Control", "no-store")],
        );
    };
    serve_file(&mut stream, method == "HEAD", &entry.path, range.as_deref())
}

fn parse_request(request: &[u8]) -> Option<(String, String, Option<String>)> {
    let text = std::str::from_utf8(request).ok()?;
    let mut lines = text.split("\r\n");
    let mut start = lines.next()?.split_whitespace();
    let method = start.next()?.to_ascii_uppercase();
    let target = start.next()?.to_string();
    if start.next()? != "HTTP/1.1"
        || start.next().is_some()
        || !target.starts_with('/')
        || target.contains('#')
    {
        return None;
    }
    let range = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range")
            .then(|| value.trim().to_string())
    });
    Some((method, target, range))
}

fn serve_file(
    stream: &mut TcpStream,
    head: bool,
    path: &Path,
    range: Option<&str>,
) -> std::io::Result<()> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return write_empty(stream, 404, "Not Found", &[]),
    };
    let size = file.metadata()?.len();
    let selected = match range {
        Some(value) => match parse_range(value, size) {
            Some(range) => Some(range),
            None => {
                return write_empty(
                    stream,
                    416,
                    "Range Not Satisfiable",
                    &[("Content-Range", &format!("bytes */{size}"))],
                )
            }
        },
        None => None,
    };
    let (status, reason, start, end) = selected
        .map(|(start, end)| (206, "Partial Content", start, end))
        .unwrap_or((200, "OK", 0, size.saturating_sub(1)));
    let length = if size == 0 { 0 } else { end - start + 1 };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {length}\r\n"
    )?;
    write!(
        stream,
        "Content-Type: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\n",
        content_type(path)
    )?;
    write!(stream, "Connection: close\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\ntransferMode.dlna.org: Streaming\r\n")?;
    if status == 206 {
        write!(stream, "Content-Range: bytes {start}-{end}/{size}\r\n")?;
    }
    write!(stream, "\r\n")?;
    if head || length == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = length;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let wanted = remaining.min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..wanted])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn write_empty(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n"
    )?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")
}

fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let bytes = value.strip_prefix("bytes=")?;
    if bytes.contains(',') {
        return None;
    }
    let (left, right) = bytes.split_once('-')?;
    if left.is_empty() {
        let suffix: u64 = right.parse().ok()?;
        return (suffix > 0).then(|| (size.saturating_sub(suffix), size - 1));
    }
    let start: u64 = left.parse().ok()?;
    if start >= size {
        return None;
    }
    let end = if right.is_empty() {
        size - 1
    } else {
        right.parse::<u64>().ok()?.min(size - 1)
    };
    (end >= start).then_some((start, end))
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" | "mp4" | "alac" => "audio/mp4",
        "aac" => "audio/aac",
        "aif" | "aiff" => "audio/aiff",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=2-6", 10), Some((2, 6)));
        assert_eq!(parse_range("bytes=7-", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=-4", 10), Some((6, 9)));
        assert_eq!(parse_range("bytes=20-", 10), None);
        assert_eq!(parse_range("bytes=1-2,4-5", 10), None);
    }
    #[test]
    fn recognizes_types() {
        assert_eq!(content_type(Path::new("song.flac")), "audio/flac");
        assert_eq!(content_type(Path::new("cover.webp")), "image/webp");
    }
    #[test]
    fn validates_request_target() {
        assert!(parse_request(b"GET media/x/y HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_request(b"POST /media/x/y HTTP/1.1\r\n\r\n").is_some());
    }
}
