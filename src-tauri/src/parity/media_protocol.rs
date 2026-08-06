//! Secure, streaming access to renderer-visible local media.
//!
//! Tauri's v2 custom URI protocol callback produces a `Cow<[u8]>`, which
//! requires buffering the complete response. Audio and waveform readers need
//! real byte-range streaming, so this service exposes a loopback-only HTTP
//! endpoint backed by short-lived, unguessable capabilities. A URL contains
//! only a token; the canonical filesystem path never crosses the protocol.

use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{File, Metadata},
    io::{self, Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::State;
use uuid::Uuid;

const TOKEN_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const MAX_REQUEST_HEADER_BYTES: usize = 16 * 1024;
const STREAM_BUFFER_BYTES: usize = 64 * 1024;
const MAX_FLAC_METADATA_BLOCKS: usize = 128;
const MAX_FLAC_RECOVERY_SCAN_BYTES: usize = 1024 * 1024;
const MAX_FLAC_FRAME_HEADER_BYTES: usize = 32;
const MAX_RECOVERY_CACHE_ENTRIES: usize = 512;

#[derive(Clone)]
pub struct MediaProtocolService {
    inner: Arc<Inner>,
}

struct Inner {
    endpoint: Mutex<Option<SocketAddr>>,
    grants: Mutex<HashMap<String, Grant>>,
    recovery_cache: Mutex<HashMap<PathBuf, CachedRecovery>>,
}

struct Grant {
    path: PathBuf,
    expires_at: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlacPrefixRecovery {
    pub skip_start: u64,
    pub skip_end: u64,
    pub skipped_bytes: u64,
    pub virtual_size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileFingerprint {
    size: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

#[derive(Clone, Copy)]
struct CachedRecovery {
    fingerprint: FileFingerprint,
    recovery: Option<FlacPrefixRecovery>,
    last_used: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedMediaUrl {
    pub url: String,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidRange;

impl Default for MediaProtocolService {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                endpoint: Mutex::new(None),
                grants: Mutex::new(HashMap::new()),
                recovery_cache: Mutex::new(HashMap::new()),
            }),
        }
    }
}

impl MediaProtocolService {
    pub fn authorize(&self, file_path: impl AsRef<Path>) -> Result<AuthorizedMediaUrl, String> {
        let canonical = canonical_supported_file(file_path.as_ref())?;
        let endpoint = self.ensure_server()?;
        let token = Uuid::new_v4().simple().to_string();
        let mut grants = self.inner.grants.lock().map_err(lock_error)?;
        let now = Instant::now();
        grants.retain(|_, grant| grant.expires_at > now);
        grants.insert(
            token.clone(),
            Grant {
                path: canonical,
                expires_at: now + TOKEN_TTL,
            },
        );
        Ok(AuthorizedMediaUrl {
            url: format!("http://{endpoint}/muro-media/{token}"),
            expires_in_seconds: TOKEN_TTL.as_secs(),
        })
    }

    pub fn revoke(&self, url_or_token: &str) -> bool {
        let token = url_or_token
            .rsplit_once("/muro-media/")
            .map_or(url_or_token, |(_, token)| token);
        if !valid_token(token) {
            return false;
        }
        self.inner
            .grants
            .lock()
            .map(|mut grants| grants.remove(token).is_some())
            .unwrap_or(false)
    }

    fn ensure_server(&self) -> Result<SocketAddr, String> {
        let mut endpoint = self.inner.endpoint.lock().map_err(lock_error)?;
        if let Some(address) = *endpoint {
            return Ok(address);
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| format!("Could not bind the local media protocol: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure the local media protocol: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the local media protocol: {error}"))?;
        let inner = Arc::downgrade(&self.inner);
        thread::Builder::new()
            .name("muro-media-protocol".to_string())
            .spawn(move || accept_loop(listener, inner))
            .map_err(|error| format!("Could not start the local media protocol: {error}"))?;
        *endpoint = Some(address);
        Ok(address)
    }
}

#[tauri::command]
pub fn authorize_local_media(
    state: State<'_, MediaProtocolService>,
    file_path: String,
) -> Result<AuthorizedMediaUrl, String> {
    state.authorize(file_path)
}

#[tauri::command]
pub fn revoke_local_media(state: State<'_, MediaProtocolService>, url_or_token: String) -> bool {
    state.revoke(&url_or_token)
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    format!("Local media protocol state is unavailable: {error}")
}

fn accept_loop(listener: TcpListener, inner: Weak<Inner>) {
    while let Some(inner) = inner.upgrade() {
        match listener.accept() {
            Ok((stream, peer)) if peer.ip().is_loopback() => {
                thread::spawn(move || {
                    let _ = handle_connection(stream, &inner);
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
}

fn handle_connection(mut stream: TcpStream, inner: &Inner) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(status) => return write_error(&mut stream, status, "Invalid media request"),
    };

    if request.method != "GET" && request.method != "HEAD" {
        return write_error_with_headers(
            &mut stream,
            405,
            "Method Not Allowed",
            "Method not allowed",
            &[("Allow", "GET, HEAD".to_string())],
        );
    }

    let Some(token) = request.target.strip_prefix("/muro-media/") else {
        return write_error(&mut stream, 404, "Media grant not found");
    };
    if !valid_token(token) {
        return write_error(&mut stream, 404, "Media grant not found");
    }

    let path = {
        let mut grants = match inner.grants.lock() {
            Ok(grants) => grants,
            Err(_) => return write_error(&mut stream, 500, "Media protocol unavailable"),
        };
        let now = Instant::now();
        grants.retain(|_, grant| grant.expires_at > now);
        grants.get(token).map(|grant| grant.path.clone())
    };
    let Some(path) = path else {
        return write_error(&mut stream, 404, "Media grant not found");
    };

    // Re-resolve immediately before opening. A path that was replaced with a
    // symlink after authorization must not change what the capability grants.
    if path.canonicalize().ok().as_deref() != Some(path.as_path()) {
        return write_error(&mut stream, 404, "Media file not found");
    }

    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return write_error(&mut stream, 404, "Media file not found"),
    };
    let metadata = match file.metadata() {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return write_error(&mut stream, 404, "Media file not found"),
    };
    let recovery = cached_flac_recovery(inner, &path, &metadata, &mut file).unwrap_or(None);
    let size = recovery.map_or(metadata.len(), |value| value.virtual_size);
    let range = match request.range.as_deref() {
        Some(value) => match parse_byte_range(value, size) {
            Ok(range) => Some(range),
            Err(_) => {
                return write_error_with_headers(
                    &mut stream,
                    416,
                    "Range Not Satisfiable",
                    "",
                    &[
                        ("Accept-Ranges", "bytes".to_string()),
                        ("Content-Range", format!("bytes */{size}")),
                    ],
                )
            }
        },
        None => None,
    };
    let start = range.map_or(0, |value| value.start);
    let end = range.map_or_else(|| size.saturating_sub(1), |value| value.end);
    let content_length = if size == 0 { 0 } else { end - start + 1 };
    let status = if range.is_some() { 206 } else { 200 };
    let reason = if status == 206 {
        "Partial Content"
    } else {
        "OK"
    };

    write!(stream, "HTTP/1.1 {status} {reason}\r\n")?;
    write!(stream, "Accept-Ranges: bytes\r\n")?;
    write!(stream, "Cache-Control: no-store\r\n")?;
    write!(stream, "Content-Length: {content_length}\r\n")?;
    write!(stream, "Content-Type: {}\r\n", mime_type(&path).unwrap())?;
    write!(stream, "Cross-Origin-Resource-Policy: cross-origin\r\n")?;
    write_cors_headers(&mut stream, request.origin.as_deref())?;
    if let Some(range) = range {
        write!(
            stream,
            "Content-Range: bytes {}-{}/{}\r\n",
            range.start, range.end, size
        )?;
    }
    if recovery.is_some() {
        write!(stream, "X-Muro-Recovered-Media: flac-frame-resync\r\n")?;
    }
    write!(stream, "Connection: close\r\n\r\n")?;
    if request.method == "HEAD" || size == 0 {
        return stream.flush();
    }

    for segment in original_segments_for_virtual_range(start, end, recovery) {
        stream_file_segment(&mut stream, &mut file, segment)?;
    }
    stream.flush()
}

struct ParsedRequest {
    method: String,
    target: String,
    range: Option<String>,
    origin: Option<String>,
}

fn read_request(stream: &mut TcpStream) -> Result<ParsedRequest, u16> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).map_err(|_| 400_u16)?;
        if read == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if bytes.len() > MAX_REQUEST_HEADER_BYTES {
            return Err(431);
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| 400_u16)?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines.next().ok_or(400_u16)?.split_ascii_whitespace();
    let method = request_line.next().ok_or(400_u16)?.to_string();
    let target = request_line.next().ok_or(400_u16)?.to_string();
    let version = request_line.next().ok_or(400_u16)?;
    if request_line.next().is_some()
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || target.contains(['?', '#'])
    {
        return Err(400);
    }
    let mut range = None;
    let mut origin = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(400_u16)?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("range") {
            if range.replace(value.to_string()).is_some() {
                return Err(400);
            }
        } else if name.eq_ignore_ascii_case("origin") {
            origin = Some(value.to_string());
        }
    }
    Ok(ParsedRequest {
        method,
        target,
        range,
        origin,
    })
}

fn write_error(stream: &mut TcpStream, status: u16, message: &str) -> io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        404 => "Not Found",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    };
    write_error_with_headers(stream, status, reason, message, &[])
}

fn write_error_with_headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    message: &str,
    headers: &[(&str, String)],
) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status} {reason}\r\n")?;
    write!(stream, "Cache-Control: no-store\r\n")?;
    write!(stream, "Content-Type: text/plain; charset=utf-8\r\n")?;
    write!(stream, "Content-Length: {}\r\n", message.len())?;
    write!(stream, "Cross-Origin-Resource-Policy: cross-origin\r\n")?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "Connection: close\r\n\r\n{message}")?;
    stream.flush()
}

fn write_cors_headers(stream: &mut TcpStream, origin: Option<&str>) -> io::Result<()> {
    if let Some(origin) = origin.filter(|origin| allowed_origin(origin)) {
        write!(stream, "Access-Control-Allow-Origin: {origin}\r\n")?;
        write!(stream, "Vary: Origin\r\n")?;
    }
    Ok(())
}

fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || cfg!(debug_assertions)
        && matches!(origin, "http://localhost:1420" | "http://127.0.0.1:1420")
}

fn canonical_supported_file(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Local media path must be absolute".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Local media file was not found".to_string())?;
    if mime_type(&canonical).is_none() {
        return Err("Unsupported local media type".to_string());
    }
    if !canonical
        .metadata()
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return Err("Local media file was not found".to_string());
    }
    Ok(canonical)
}

fn valid_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "aac" => "audio/aac",
        "aif" | "aiff" => "audio/aiff",
        "alac" | "m4a" | "mp4" => "audio/mp4",
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "oga" | "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "gif" => "image/gif",
        "jpeg" | "jpg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return None,
    })
}

pub fn parse_byte_range(value: &str, size: u64) -> Result<ByteRange, InvalidRange> {
    let value = value.trim();
    let spec = value.strip_prefix("bytes=").ok_or(InvalidRange)?;
    if spec.contains(',') || size == 0 {
        return Err(InvalidRange);
    }
    let (start_text, end_text) = spec.split_once('-').ok_or(InvalidRange)?;
    if start_text.is_empty() && end_text.is_empty() {
        return Err(InvalidRange);
    }
    let (start, end) = if start_text.is_empty() {
        let suffix = end_text.parse::<u64>().map_err(|_| InvalidRange)?;
        if suffix == 0 {
            return Err(InvalidRange);
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start_text.parse::<u64>().map_err(|_| InvalidRange)?;
        let end = if end_text.is_empty() {
            size - 1
        } else {
            end_text.parse::<u64>().map_err(|_| InvalidRange)?
        };
        (start, end.min(size - 1))
    };
    if start >= size || end < start {
        return Err(InvalidRange);
    }
    Ok(ByteRange { start, end })
}

fn original_segments_for_virtual_range(
    start: u64,
    end: u64,
    recovery: Option<FlacPrefixRecovery>,
) -> Vec<ByteRange> {
    let Some(recovery) = recovery else {
        return vec![ByteRange { start, end }];
    };
    let mut segments = Vec::with_capacity(2);
    if start < recovery.skip_start {
        segments.push(ByteRange {
            start,
            end: end.min(recovery.skip_start - 1),
        });
    }
    if end >= recovery.skip_start {
        segments.push(ByteRange {
            start: start.max(recovery.skip_start) + recovery.skipped_bytes,
            end: end + recovery.skipped_bytes,
        });
    }
    segments
}

fn stream_file_segment(
    stream: &mut TcpStream,
    file: &mut File,
    segment: ByteRange,
) -> io::Result<()> {
    file.seek(SeekFrom::Start(segment.start))?;
    let mut remaining = segment.end - segment.start + 1;
    let mut buffer = [0_u8; STREAM_BUFFER_BYTES];
    while remaining > 0 {
        let wanted = remaining.min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "media file changed while streaming",
            ));
        }
        stream.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn cached_flac_recovery(
    inner: &Inner,
    path: &Path,
    metadata: &Metadata,
    file: &mut File,
) -> io::Result<Option<FlacPrefixRecovery>> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("flac"))
        .unwrap_or(true)
    {
        return Ok(None);
    }
    let fingerprint = FileFingerprint {
        size: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
    };
    if let Ok(mut cache) = inner.recovery_cache.lock() {
        if let Some(cached) = cache.get_mut(path) {
            if cached.fingerprint == fingerprint {
                cached.last_used = Instant::now();
                return Ok(cached.recovery);
            }
        }
    }

    let recovery = detect_flac_prefix_recovery(file, metadata.len())?;
    if let Ok(mut cache) = inner.recovery_cache.lock() {
        if cache.len() >= MAX_RECOVERY_CACHE_ENTRIES {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            path.to_path_buf(),
            CachedRecovery {
                fingerprint,
                recovery,
                last_used: Instant::now(),
            },
        );
    }
    Ok(recovery)
}

pub fn detect_flac_prefix_recovery(
    file: &mut File,
    file_size: u64,
) -> io::Result<Option<FlacPrefixRecovery>> {
    let Some(metadata_end) = read_flac_metadata_end(file, file_size)? else {
        return Ok(None);
    };
    if metadata_end >= file_size {
        return Ok(None);
    }
    let initial_length = MAX_FLAC_FRAME_HEADER_BYTES.min((file_size - metadata_end) as usize);
    let initial = read_at(file, metadata_end, initial_length)?;
    if is_valid_flac_frame_header(&initial, 0) {
        return Ok(None);
    }

    let available = file_size - metadata_end;
    let scan_length =
        available.min((MAX_FLAC_RECOVERY_SCAN_BYTES + MAX_FLAC_FRAME_HEADER_BYTES) as u64) as usize;
    let scan = read_at(file, metadata_end, scan_length)?;
    let final_candidate = MAX_FLAC_RECOVERY_SCAN_BYTES.min(scan.len().saturating_sub(6));
    for relative in 0..=final_candidate {
        if !is_valid_flac_frame_header(&scan, relative) {
            continue;
        }
        if relative == 0 {
            return Ok(None);
        }
        let skipped_bytes = relative as u64;
        return Ok(Some(FlacPrefixRecovery {
            skip_start: metadata_end,
            skip_end: metadata_end + skipped_bytes,
            skipped_bytes,
            virtual_size: file_size - skipped_bytes,
        }));
    }
    Ok(None)
}

fn read_flac_metadata_end(file: &mut File, file_size: u64) -> io::Result<Option<u64>> {
    if file_size < 4 + 4 + 34 {
        return Ok(None);
    }
    if read_at(file, 0, 4)?.as_slice() != b"fLaC" {
        return Ok(None);
    }
    let mut position = 4_u64;
    for index in 0..MAX_FLAC_METADATA_BLOCKS {
        let header = read_at(file, position, 4)?;
        if header.len() != 4 {
            return Ok(None);
        }
        let block_type = header[0] & 0x7f;
        let block_length = u32::from_be_bytes([0, header[1], header[2], header[3]]) as u64;
        if block_type == 0x7f || (index == 0 && (block_type != 0 || block_length != 34)) {
            return Ok(None);
        }
        let Some(block_end) = position
            .checked_add(4)
            .and_then(|value| value.checked_add(block_length))
        else {
            return Ok(None);
        };
        if block_end > file_size {
            return Ok(None);
        }
        position = block_end;
        if header[0] & 0x80 != 0 {
            return Ok(Some(position));
        }
    }
    Ok(None)
}

fn read_at(file: &mut File, position: u64, length: usize) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(position))?;
    let mut buffer = vec![0_u8; length];
    let mut read = 0;
    while read < length {
        let count = file.read(&mut buffer[read..])?;
        if count == 0 {
            break;
        }
        read += count;
    }
    buffer.truncate(read);
    Ok(buffer)
}

fn flac_header_crc8(buffer: &[u8], start: usize, end: usize) -> u8 {
    let mut crc = 0_u8;
    for byte in &buffer[start..end] {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn utf8_integer_length(first: u8) -> usize {
    match first {
        value if value & 0x80 == 0 => 1,
        value if value & 0xe0 == 0xc0 => 2,
        value if value & 0xf0 == 0xe0 => 3,
        value if value & 0xf8 == 0xf0 => 4,
        value if value & 0xfc == 0xf8 => 5,
        value if value & 0xfe == 0xfc => 6,
        0xfe => 7,
        _ => 0,
    }
}

fn is_valid_flac_frame_header(buffer: &[u8], start: usize) -> bool {
    if start.checked_add(6).map_or(true, |end| end > buffer.len())
        || buffer[start] != 0xff
        || buffer[start + 1] & 0xfe != 0xf8
    {
        return false;
    }
    let block_size_code = buffer[start + 2] >> 4;
    let sample_rate_code = buffer[start + 2] & 0x0f;
    let channel_assignment = buffer[start + 3] >> 4;
    if block_size_code == 0
        || sample_rate_code == 0x0f
        || channel_assignment > 10
        || buffer[start + 3] & 0x01 != 0
    {
        return false;
    }
    let number_length = utf8_integer_length(buffer[start + 4]);
    if number_length == 0 || start + 4 + number_length > buffer.len() {
        return false;
    }
    for index in 1..number_length {
        if buffer[start + 4 + index] & 0xc0 != 0x80 {
            return false;
        }
    }
    let block_size_bytes = match block_size_code {
        6 => 1,
        7 => 2,
        _ => 0,
    };
    let sample_rate_bytes = match sample_rate_code {
        12 => 1,
        13 | 14 => 2,
        _ => 0,
    };
    let crc_position = start + 4 + number_length + block_size_bytes + sample_rate_bytes;
    crc_position < buffer.len()
        && flac_header_crc8(buffer, start, crc_position) == buffer[crc_position]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(
            parse_byte_range("bytes=2-5", 10),
            Ok(ByteRange { start: 2, end: 5 })
        );
        assert_eq!(
            parse_byte_range("bytes=7-", 10),
            Ok(ByteRange { start: 7, end: 9 })
        );
        assert_eq!(
            parse_byte_range("bytes=-3", 10),
            Ok(ByteRange { start: 7, end: 9 })
        );
        assert!(parse_byte_range("bytes=20-30", 10).is_err());
        assert!(parse_byte_range("bytes=0-1,4-5", 10).is_err());
        assert!(parse_byte_range("bytes=0-", 0).is_err());
    }

    #[test]
    fn flac_recovery_matches_electron_contract() {
        let directory = std::env::temp_dir().join(format!("muro-media-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let recovered_path = directory.join("recovered.flac");
        let valid_path = directory.join("valid.flac");
        let mut stream_info = b"fLaC".to_vec();
        stream_info.extend_from_slice(&[0x80, 0, 0, 0x22]);
        stream_info.extend_from_slice(&[0; 34]);
        let invalid_prefix = [0x3a, 0x7e, 0xff, 0xf8, 0, 0, 0, 0xaa];
        let valid_frame = [0xff, 0xf8, 0xc9, 0x18, 0, 0xc2, 0x40, 1, 2, 3, 4, 5];
        let mut recovered_bytes = stream_info.clone();
        recovered_bytes.extend_from_slice(&invalid_prefix);
        recovered_bytes.extend_from_slice(&valid_frame);
        fs::write(&recovered_path, &recovered_bytes).unwrap();
        let mut valid_bytes = stream_info.clone();
        valid_bytes.extend_from_slice(&valid_frame);
        fs::write(&valid_path, &valid_bytes).unwrap();

        let mut recovered_file = File::open(&recovered_path).unwrap();
        let recovered_size = recovered_file.metadata().unwrap().len();
        let recovery = detect_flac_prefix_recovery(&mut recovered_file, recovered_size)
            .unwrap()
            .unwrap();
        assert_eq!(recovery.skip_start, stream_info.len() as u64);
        assert_eq!(recovery.skipped_bytes, invalid_prefix.len() as u64);
        assert_eq!(recovery.virtual_size, valid_bytes.len() as u64);
        assert_eq!(
            original_segments_for_virtual_range(
                stream_info.len() as u64 - 2,
                stream_info.len() as u64 + 3,
                Some(recovery)
            ),
            vec![
                ByteRange {
                    start: stream_info.len() as u64 - 2,
                    end: stream_info.len() as u64 - 1,
                },
                ByteRange {
                    start: (stream_info.len() + invalid_prefix.len()) as u64,
                    end: (stream_info.len() + invalid_prefix.len() + 3) as u64,
                },
            ]
        );

        let mut valid_file = File::open(&valid_path).unwrap();
        let valid_size = valid_file.metadata().unwrap().len();
        assert_eq!(
            detect_flac_prefix_recovery(&mut valid_file, valid_size).unwrap(),
            None
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_non_media_and_relative_paths() {
        assert!(canonical_supported_file(Path::new("cover.jpg")).is_err());
        assert!(mime_type(Path::new("C:/private.txt")).is_none());
        assert_eq!(mime_type(Path::new("C:/cover.JPG")), Some("image/jpeg"));
    }

    #[test]
    fn capability_route_rejects_traversal_and_queries() {
        assert!(valid_token("0123456789abcdef0123456789ABCDEF"));
        assert!(!valid_token("../0123456789abcdef0123456789abcdef"));
        assert!(!valid_token("0123456789abcdef0123456789abcdef?x"));
    }
}
