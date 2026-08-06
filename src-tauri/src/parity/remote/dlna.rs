//! SSDP discovery and a bounded UPnP AVTransport/RenderingControl client.

use super::{Device, DiscoverySnapshot, MediaStatus};
use native_tls::TlsConnector;
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::net::{IpAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use url::Url;

const SSDP_TARGET: &str = "239.255.255.250:1900";
const MEDIA_RENDERER: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_RESPONSE_HEADERS: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug)]
pub struct DeviceRecord {
    pub device: Device,
    pub av_transport_url: String,
    pub rendering_control_url: Option<String>,
    pub last_seen: Instant,
}

#[derive(Default)]
struct DiscoveryState {
    records: HashMap<String, DeviceRecord>,
    scanning: bool,
    error: Option<String>,
}

pub struct DlnaDiscovery {
    state: Arc<Mutex<DiscoveryState>>,
    shutdown: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for DlnaDiscovery {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            shutdown: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }
}

impl DlnaDiscovery {
    pub fn snapshot(&self) -> DiscoverySnapshot {
        snapshot_from(&self.state)
    }

    pub fn record(&self, id: &str) -> Option<DeviceRecord> {
        self.state.lock().ok()?.records.get(id).cloned()
    }

    pub fn start(&self, notify: Arc<dyn Fn(DiscoverySnapshot) + Send + Sync>) -> DiscoverySnapshot {
        if self
            .worker
            .lock()
            .ok()
            .and_then(|worker| worker.as_ref().map(|_| ()))
            .is_some()
        {
            return self.snapshot();
        }
        self.shutdown.store(false, Ordering::Release);
        if let Ok(mut state) = self.state.lock() {
            state.scanning = true;
            state.error = None;
        }
        let state = self.state.clone();
        let shutdown = self.shutdown.clone();
        let worker = thread::Builder::new()
            .name("muro-dlna-discovery".into())
            .spawn(move || {
                let socket = UdpSocket::bind("0.0.0.0:0");
                let Ok(socket) = socket else {
                    if let Ok(mut value) = state.lock() {
                        value.scanning = false;
                        value.error = Some(
                            "Could not open a local network socket for device discovery".into(),
                        );
                    }
                    notify(snapshot_from(&state));
                    return;
                };
                let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));
                let query = build_msearch();
                let mut last_query = Instant::now() - Duration::from_secs(10);
                let mut buffer = [0_u8; 64 * 1024];
                while !shutdown.load(Ordering::Acquire) {
                    if last_query.elapsed() >= Duration::from_secs(5) {
                        let _ = socket.send_to(&query, SSDP_TARGET);
                        let _ = socket.send_to(&query, SSDP_TARGET);
                        last_query = Instant::now();
                        prune(&state);
                        notify(snapshot_from(&state));
                    }
                    if let Ok((length, remote)) = socket.recv_from(&mut buffer) {
                        if let Some(response) =
                            parse_ssdp(std::str::from_utf8(&buffer[..length]).unwrap_or_default())
                        {
                            if let Some(record) = describe(&response, remote.ip()) {
                                if let Ok(mut value) = state.lock() {
                                    value.records.insert(record.device.id.clone(), record);
                                }
                                notify(snapshot_from(&state));
                            }
                        }
                    }
                }
                if let Ok(mut value) = state.lock() {
                    value.scanning = false;
                }
                notify(snapshot_from(&state));
            });
        match worker {
            Ok(worker) => {
                if let Ok(mut slot) = self.worker.lock() {
                    *slot = Some(worker);
                }
            }
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    state.scanning = false;
                    state.error = Some(error.to_string());
                }
            }
        }
        self.snapshot()
    }

    pub fn stop(&self) -> DiscoverySnapshot {
        self.shutdown.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = worker.join();
        }
        if let Ok(mut state) = self.state.lock() {
            state.scanning = false;
        }
        self.snapshot()
    }
}

impl Drop for DlnaDiscovery {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn snapshot_from(state: &Arc<Mutex<DiscoveryState>>) -> DiscoverySnapshot {
    let Ok(state) = state.lock() else {
        return DiscoverySnapshot::error("Discovery state unavailable");
    };
    let mut devices: Vec<_> = state
        .records
        .values()
        .map(|record| record.device.clone())
        .collect();
    devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    DiscoverySnapshot {
        devices,
        scanning: state.scanning,
        error: state.error.clone(),
    }
}

fn prune(state: &Arc<Mutex<DiscoveryState>>) {
    if let Ok(mut state) = state.lock() {
        state
            .records
            .retain(|_, record| record.last_seen.elapsed() < Duration::from_secs(30));
    }
}

pub fn build_msearch() -> Vec<u8> {
    format!("M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_TARGET}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {MEDIA_RENDERER}\r\n\r\n").into_bytes()
}

#[derive(Debug)]
struct SsdpResponse {
    location: String,
    usn: Option<String>,
}

fn parse_ssdp(text: &str) -> Option<SsdpResponse> {
    if !text
        .lines()
        .next()?
        .trim()
        .to_ascii_uppercase()
        .starts_with("HTTP/1.1 200")
    {
        return None;
    }
    let mut location = None;
    let mut usn = None;
    for line in text.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "location" => location = Some(value.trim().to_string()),
            "usn" => usn = Some(value.trim().to_string()),
            _ => {}
        }
    }
    Some(SsdpResponse {
        location: location?,
        usn,
    })
}

fn describe(response: &SsdpResponse, remote: IpAddr) -> Option<DeviceRecord> {
    let url = Url::parse(&response.location).ok()?;
    if !is_http_scheme(url.scheme())
        || url.username() != ""
        || url.password().is_some()
        || url.host_str()?.parse::<IpAddr>().ok()? != remote
    {
        return None;
    }
    let body = http_request("GET", &url, &[], None).ok()?;
    let base = xml_value(&body, "URLBase")
        .and_then(|value| Url::parse(&value).ok())
        .unwrap_or(url.clone());
    let services = service_urls(&body, &base, url.host_str()?);
    let av_transport_url = services.0?;
    let id = response
        .usn
        .as_deref()
        .and_then(usn_uuid)
        .unwrap_or_else(|| response.location.clone());
    let name = xml_value(&body, "friendlyName")
        .unwrap_or_else(|| url.host_str().unwrap_or("DLNA renderer").into());
    let manufacturer = xml_value(&body, "manufacturer").unwrap_or_default();
    let model_name = xml_value(&body, "modelName").unwrap_or_default();
    Some(DeviceRecord {
        device: Device {
            id,
            name,
            model: format!("{manufacturer} {model_name}").trim().into(),
            host: url.host_str()?.into(),
            port: url.port_or_known_default()?,
        },
        av_transport_url,
        rendering_control_url: services.1,
        last_seen: Instant::now(),
    })
}

fn service_urls(xml: &str, base: &Url, expected_host: &str) -> (Option<String>, Option<String>) {
    let mut av = None;
    let mut rendering = None;
    for block in xml_blocks(xml, "service") {
        let kind = xml_value(block, "serviceType").unwrap_or_default();
        let control = xml_value(block, "controlURL")
            .and_then(|value| base.join(&value).ok())
            .filter(|url| trusted_endpoint(url, expected_host))
            .map(|url| url.to_string());
        if kind.contains(":service:AVTransport:") {
            av = control;
        } else if kind.contains(":service:RenderingControl:") {
            rendering = control;
        }
    }
    (av, rendering)
}

fn is_http_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https")
}

fn trusted_endpoint(url: &Url, expected_host: &str) -> bool {
    is_http_scheme(url.scheme())
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == Some(expected_host)
}

fn usn_uuid(value: &str) -> Option<String> {
    let start = value.to_ascii_lowercase().find("uuid:")? + 5;
    let rest = &value[start..];
    Some(rest.split(':').next()?.trim().to_string())
}

#[derive(Clone)]
pub struct DlnaClient {
    av: Url,
    rendering: Option<Url>,
}

impl DlnaClient {
    pub fn new(record: &DeviceRecord) -> Result<Self, String> {
        let av = Url::parse(&record.av_transport_url).map_err(|error| error.to_string())?;
        if !trusted_endpoint(&av, &record.device.host) {
            return Err("Renderer control URL is not a trusted same-host HTTP(S) endpoint".into());
        }
        let rendering = record
            .rendering_control_url
            .as_deref()
            .map(Url::parse)
            .transpose()
            .map_err(|error| error.to_string())?;
        if rendering
            .as_ref()
            .is_some_and(|url| !trusted_endpoint(url, &record.device.host))
        {
            return Err("Renderer control URL is not a trusted same-host HTTP(S) endpoint".into());
        }
        Ok(Self { av, rendering })
    }
    fn av(&self, action: &str, args: &[(&str, String)]) -> Result<String, String> {
        soap(
            &self.av,
            "urn:schemas-upnp-org:service:AVTransport:1",
            action,
            args,
        )
    }
    pub fn set_uri(&self, url: &str, metadata: &str) -> Result<(), String> {
        self.av(
            "SetAVTransportURI",
            &[
                ("CurrentURI", xml_escape(url)),
                ("CurrentURIMetaData", xml_escape(metadata)),
            ],
        )
        .map(|_| ())
    }
    pub fn play(&self) -> Result<(), String> {
        self.av("Play", &[("Speed", "1".into())]).map(|_| ())
    }
    pub fn pause(&self) -> Result<(), String> {
        self.av("Pause", &[]).map(|_| ())
    }
    pub fn stop(&self) -> Result<(), String> {
        self.av("Stop", &[]).map(|_| ())
    }
    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        self.av(
            "Seek",
            &[
                ("Unit", "REL_TIME".into()),
                ("Target", seconds_to_hms(seconds)),
            ],
        )
        .map(|_| ())
    }
    pub fn set_volume(&self, value: f64) -> Result<(), String> {
        let Some(url) = &self.rendering else {
            return Ok(());
        };
        soap(
            url,
            "urn:schemas-upnp-org:service:RenderingControl:1",
            "SetVolume",
            &[
                ("Channel", "Master".into()),
                (
                    "DesiredVolume",
                    ((value.clamp(0.0, 1.0) * 100.0).round() as u32).to_string(),
                ),
            ],
        )
        .map(|_| ())
    }
    pub fn status(&self, duration_hint: Option<f64>) -> Result<MediaStatus, String> {
        let position = self.av("GetPositionInfo", &[])?;
        let transport = self.av("GetTransportInfo", &[])?;
        let state = xml_value(&transport, "CurrentTransportState").unwrap_or_default();
        Ok(MediaStatus {
            media_session_id: None,
            player_state: match state.as_str() {
                "PLAYING" => "playing",
                "PAUSED_PLAYBACK" | "PAUSED_RECORDING" => "paused",
                "TRANSITIONING" => "buffering",
                _ => "idle",
            }
            .into(),
            idle_reason: None,
            position: xml_value(&position, "RelTime")
                .and_then(|value| hms_seconds(&value))
                .unwrap_or(0.0),
            duration: xml_value(&position, "TrackDuration")
                .and_then(|value| hms_seconds(&value))
                .filter(|value| *value > 0.0)
                .or(duration_hint),
            content_id: None,
        })
    }
}

fn soap(url: &Url, service: &str, action: &str, args: &[(&str, String)]) -> Result<String, String> {
    let body_args: String = std::iter::once(("InstanceID", "0".into()))
        .chain(args.iter().cloned())
        .map(|(name, value)| format!("<{name}>{value}</{name}>"))
        .collect();
    let body = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service}\">{body_args}</u:{action}></s:Body></s:Envelope>");
    http_request(
        "POST",
        url,
        &[
            ("Content-Type", "text/xml; charset=\"utf-8\""),
            ("SOAPACTION", &format!("\"{service}#{action}\"")),
        ],
        Some(body.as_bytes()),
    )
}

fn http_request(
    method: &str,
    url: &Url,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> Result<String, String> {
    if !is_http_scheme(url.scheme()) || url.username() != "" || url.password().is_some() {
        return Err("Only trusted HTTP(S) renderer endpoints are supported".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Renderer URL has no host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Renderer URL has no known port".to_string())?;
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .collect();
    let stream = addresses
        .into_iter()
        .find_map(|address| TcpStream::connect_timeout(&address, TIMEOUT).ok())
        .ok_or_else(|| "Renderer connection timed out".to_string())?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|error| error.to_string())?;
    let path = if let Some(query) = url.query() {
        format!("{}?{query}", url.path())
    } else {
        url.path().into()
    };
    let bytes = body.unwrap_or_default();
    let host_header = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = Vec::new();
    write!(
        request,
        "{method} {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nContent-Length: {}\r\n",
        bytes.len()
    )
    .map_err(|error| error.to_string())?;
    for (name, value) in headers {
        write!(request, "{name}: {value}\r\n").map_err(|error| error.to_string())?;
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(bytes);
    let response = if url.scheme() == "https" {
        let connector = TlsConnector::new().map_err(|error| error.to_string())?;
        let mut stream = connector
            .connect(host, stream)
            .map_err(|error| format!("Renderer TLS handshake failed: {error}"))?;
        exchange(&mut stream, &request)?
    } else {
        let mut stream = stream;
        exchange(&mut stream, &request)?
    };
    Ok(String::from_utf8_lossy(&response).into_owned())
}

fn exchange(stream: &mut (impl Read + Write), request: &[u8]) -> Result<Vec<u8>, String> {
    stream
        .write_all(request)
        .and_then(|_| stream.flush())
        .map_err(|error| error.to_string())?;
    read_http_response(stream)
}

fn read_http_response(stream: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut received = Vec::new();
    let header_end = loop {
        if let Some(index) = received.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        if received.len() > MAX_RESPONSE_HEADERS {
            return Err("DLNA response headers exceed the allowed size".into());
        }
        let mut buffer = [0_u8; 8192];
        let length = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            return Err("Malformed HTTP response".into());
        }
        received.extend_from_slice(&buffer[..length]);
    };
    if header_end > MAX_RESPONSE_HEADERS {
        return Err("DLNA response headers exceed the allowed size".into());
    }
    let body_start = header_end + 4;
    let initial_body = received.split_off(body_start);
    received.truncate(header_end);
    let head = std::str::from_utf8(&received).map_err(|_| "Malformed HTTP response".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(format!("Renderer request failed (HTTP {status})"));
    }

    let mut content_length = None;
    let mut transfer_codings = Vec::new();
    for line in head.lines().skip(1) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| "Malformed HTTP response header".to_string())?;
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                let length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "Invalid DLNA Content-Length".to_string())?;
                if content_length.is_some_and(|previous| previous != length) {
                    return Err("Conflicting DLNA Content-Length headers".into());
                }
                content_length = Some(length);
            }
            "transfer-encoding" => transfer_codings.extend(
                value
                    .split(',')
                    .map(|value| value.trim().to_ascii_lowercase()),
            ),
            _ => {}
        }
    }

    let chunked = if transfer_codings.is_empty() {
        false
    } else if transfer_codings.last().map(String::as_str) == Some("chunked")
        && transfer_codings[..transfer_codings.len() - 1]
            .iter()
            .all(|coding| coding == "identity")
    {
        true
    } else {
        return Err("Unsupported DLNA Transfer-Encoding".into());
    };
    let mut body_reader = Cursor::new(initial_body).chain(stream);
    if chunked {
        decode_chunked_body(&mut body_reader)
    } else if let Some(length) = content_length {
        if length > MAX_RESPONSE {
            return Err("DLNA response exceeds the allowed size".into());
        }
        let mut body = vec![0_u8; length];
        body_reader
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
        Ok(body)
    } else {
        read_bounded_body(&mut body_reader)
    }
}

fn read_bounded_body(reader: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    reader
        .take((MAX_RESPONSE + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() > MAX_RESPONSE {
        return Err("DLNA response exceeds the allowed size".into());
    }
    Ok(body)
}

fn decode_chunked_body(reader: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    let mut metadata_bytes = 0;
    loop {
        let line = read_http_line(reader, &mut metadata_bytes)?;
        let size_text = std::str::from_utf8(&line)
            .map_err(|_| "Malformed DLNA chunk size".to_string())?
            .split(';')
            .next()
            .unwrap_or_default()
            .trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| "Malformed DLNA chunk size".to_string())?;
        if size == 0 {
            loop {
                if read_http_line(reader, &mut metadata_bytes)?.is_empty() {
                    return Ok(body);
                }
            }
        }
        let new_length = body
            .len()
            .checked_add(size)
            .filter(|length| *length <= MAX_RESPONSE)
            .ok_or_else(|| "DLNA response exceeds the allowed size".to_string())?;
        body.resize(new_length, 0);
        reader
            .read_exact(&mut body[new_length - size..])
            .map_err(|error| error.to_string())?;
        let mut terminator = [0_u8; 2];
        reader
            .read_exact(&mut terminator)
            .map_err(|error| error.to_string())?;
        if terminator != *b"\r\n" {
            return Err("Malformed DLNA chunk terminator".into());
        }
    }
}

fn read_http_line(reader: &mut impl Read, metadata_bytes: &mut usize) -> Result<Vec<u8>, String> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        reader
            .read_exact(&mut byte)
            .map_err(|error| error.to_string())?;
        *metadata_bytes = metadata_bytes
            .checked_add(1)
            .filter(|length| *length <= MAX_RESPONSE_HEADERS)
            .ok_or_else(|| "DLNA chunk metadata exceeds the allowed size".to_string())?;
        line.push(byte[0]);
        if line.ends_with(b"\r\n") {
            line.truncate(line.len() - 2);
            return Ok(line);
        }
    }
}

use std::net::ToSocketAddrs;

pub fn build_didl(
    url: &str,
    content_type: &str,
    title: &str,
    artist: &str,
    album: &str,
    art: Option<&str>,
    duration: Option<f64>,
) -> String {
    let art = art
        .map(|value| format!("<upnp:albumArtURI>{}</upnp:albumArtURI>", xml_escape(value)))
        .unwrap_or_default();
    let duration = duration
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| format!(" duration=\"{}\"", seconds_to_hms(value)))
        .unwrap_or_default();
    format!("<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"muro-track\" parentID=\"0\" restricted=\"1\"><upnp:class>object.item.audioItem.musicTrack</upnp:class><dc:title>{}</dc:title><upnp:artist>{}</upnp:artist><upnp:album>{}</upnp:album>{art}<res protocolInfo=\"http-get:*:{content_type}:DLNA.ORG_OP=01;DLNA.ORG_CI=0\"{duration}>{}</res></item></DIDL-Lite>", xml_escape(title), xml_escape(artist), xml_escape(album), xml_escape(url))
}

fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut result = Vec::new();
    let mut cursor = 0;
    while let Some(start) = lower[cursor..].find(&open).map(|value| cursor + value) {
        let Some(open_end) = lower[start..].find('>').map(|value| start + value + 1) else {
            break;
        };
        let Some(end) = lower[open_end..].find(&close).map(|value| open_end + value) else {
            break;
        };
        result.push(&xml[open_end..end]);
        cursor = end + close.len();
    }
    result
}

fn xml_value(xml: &str, tag: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let tag = tag.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(mark) = lower[cursor..].find(&tag).map(|value| cursor + value) {
        let before = &lower[..mark];
        let open = before.rfind('<')?;
        if !before[open + 1..]
            .trim_start_matches(|c: char| c.is_alphanumeric() || c == '-' || c == '_')
            .starts_with(':')
            && lower[open + 1..mark].contains(':')
        {
            cursor = mark + tag.len();
            continue;
        }
        let open_end = lower[mark..].find('>').map(|value| mark + value + 1)?;
        let close = format!("</{tag}>");
        if let Some(end) = lower[open_end..].find(&close).map(|value| open_end + value) {
            return Some(xml_unescape(xml[open_end..end].trim()));
        }
        let ns_close = format!(":{tag}>");
        if let Some(end_mark) = lower[open_end..]
            .find(&ns_close)
            .map(|value| open_end + value)
        {
            let end = lower[..end_mark].rfind('<')?;
            return Some(xml_unescape(xml[open_end..end].trim()));
        }
        cursor = open_end;
    }
    None
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
fn seconds_to_hms(value: f64) -> String {
    let value = value.max(0.0).floor() as u64;
    format!("{}:{:02}:{:02}", value / 3600, value / 60 % 60, value % 60)
}
fn hms_seconds(value: &str) -> Option<f64> {
    let values: Vec<f64> = value
        .split(':')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    (values.len() == 3).then(|| values[0] * 3600.0 + values[1] * 60.0 + values[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn msearch_has_required_headers() {
        let text = String::from_utf8(build_msearch()).unwrap();
        assert!(text.contains("M-SEARCH * HTTP/1.1"));
        assert!(text.contains(MEDIA_RENDERER));
    }
    #[test]
    fn parses_ssdp_and_uuid() {
        let response = parse_ssdp(
            "HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.2/x\r\nUSN: uuid:abc::urn:test\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            usn_uuid(response.usn.as_deref().unwrap()).as_deref(),
            Some("abc")
        );
    }
    #[test]
    fn time_round_trip() {
        assert_eq!(seconds_to_hms(3661.9), "1:01:01");
        assert_eq!(hms_seconds("1:01:01"), Some(3661.0));
    }
    #[test]
    fn didl_escapes_metadata() {
        let value = build_didl(
            "http://x/a?b=1&c=2",
            "audio/mpeg",
            "A&B",
            "<X>",
            "Q",
            None,
            Some(65.0),
        );
        assert!(value.contains("A&amp;B"));
        assert!(value.contains("0:01:05"));
    }
    #[test]
    fn accepts_only_same_host_http_or_https_control_urls() {
        let base = Url::parse("https://10.0.0.2:8443/device.xml").unwrap();
        let xml = "<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service>\
                   <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>https://10.0.0.3/render</controlURL></service>";
        let (av, rendering) = service_urls(xml, &base, "10.0.0.2");
        assert_eq!(av.as_deref(), Some("https://10.0.0.2:8443/av"));
        assert_eq!(rendering, None);
        assert!(!trusted_endpoint(
            &Url::parse("https://user@10.0.0.2/av").unwrap(),
            "10.0.0.2"
        ));
    }
    #[test]
    fn reads_content_length_without_requiring_connection_close() {
        let mut response =
            Cursor::new(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloignored".to_vec());
        assert_eq!(read_http_response(&mut response).unwrap(), b"hello");
    }
    #[test]
    fn decodes_bounded_chunked_response() {
        let mut response = Cursor::new(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;kind=test\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Test: yes\r\n\r\n"
                .to_vec(),
        );
        assert_eq!(read_http_response(&mut response).unwrap(), b"Wikipedia");
    }
    #[test]
    fn rejects_oversized_chunk_before_allocating_body() {
        let response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            MAX_RESPONSE + 1
        );
        let error = read_http_response(&mut Cursor::new(response.into_bytes())).unwrap_err();
        assert_eq!(error, "DLNA response exceeds the allowed size");
    }
}
