//! Google Cast discovery and CastV2 sender protocol (no Node runtime).

use super::{Device, DiscoverySnapshot, MediaStatus};
use native_tls::{TlsConnector, TlsStream};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const SERVICE: &str = "_googlecast._tcp.local";
const MDNS: &str = "224.0.0.251:5353";
const CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const MEDIA: &str = "urn:x-cast:com.google.cast.media";
const PLATFORM: &str = "receiver-0";
const MAX_FRAME: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct SeenDevice {
    device: Device,
    last_seen: Instant,
}

#[derive(Default)]
struct DiscoveryState {
    devices: HashMap<String, SeenDevice>,
    scanning: bool,
    error: Option<String>,
}

pub struct CastDiscovery {
    state: Arc<Mutex<DiscoveryState>>,
    shutdown: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for CastDiscovery {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            shutdown: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }
}

impl CastDiscovery {
    pub fn snapshot(&self) -> DiscoverySnapshot {
        snapshot_from(&self.state)
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
            .name("muro-cast-discovery".into())
            .spawn(move || {
                let socket = UdpSocket::bind("0.0.0.0:0");
                let Ok(socket) = socket else {
                    if let Ok(mut value) = state.lock() {
                        value.scanning = false;
                        value.error =
                            Some("Could not open a local network socket for Cast discovery".into());
                    }
                    notify(snapshot_from(&state));
                    return;
                };
                let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buffer = [0_u8; 64 * 1024];
                let mut last_query = Instant::now() - Duration::from_secs(10);
                while !shutdown.load(Ordering::Acquire) {
                    if last_query.elapsed() >= Duration::from_secs(5) {
                        let _ = socket.send_to(&build_ptr_query(), MDNS);
                        last_query = Instant::now();
                        if let Ok(mut value) = state.lock() {
                            value.devices.retain(|_, item| {
                                item.last_seen.elapsed() < Duration::from_secs(30)
                            });
                        }
                        notify(snapshot_from(&state));
                    }
                    if let Ok((length, _)) = socket.recv_from(&mut buffer) {
                        if let Ok(devices) = parse_devices(&buffer[..length]) {
                            if let Ok(mut value) = state.lock() {
                                for device in devices {
                                    value.devices.insert(
                                        device.id.clone(),
                                        SeenDevice {
                                            device,
                                            last_seen: Instant::now(),
                                        },
                                    );
                                }
                            }
                            notify(snapshot_from(&state));
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

impl Drop for CastDiscovery {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn snapshot_from(state: &Arc<Mutex<DiscoveryState>>) -> DiscoverySnapshot {
    let Ok(state) = state.lock() else {
        return DiscoverySnapshot::error("Discovery state unavailable");
    };
    let mut devices: Vec<_> = state
        .devices
        .values()
        .map(|item| item.device.clone())
        .collect();
    devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    DiscoverySnapshot {
        devices,
        scanning: state.scanning,
        error: state.error.clone(),
    }
}

fn encode_name(name: &str, output: &mut Vec<u8>) {
    for label in name.split('.').filter(|value| !value.is_empty()) {
        output.push(label.len() as u8);
        output.extend_from_slice(label.as_bytes());
    }
    output.push(0);
}

pub fn build_ptr_query() -> Vec<u8> {
    let mut bytes = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    encode_name(SERVICE, &mut bytes);
    bytes.extend_from_slice(&[0, 12, 0x80, 1]);
    bytes
}

#[derive(Clone)]
enum Record {
    Ptr {
        name: String,
        domain: String,
    },
    Srv {
        name: String,
        port: u16,
        target: String,
    },
    Txt {
        name: String,
        values: HashMap<String, String>,
    },
    A {
        name: String,
        address: String,
    },
}

fn read_name(bytes: &[u8], start: usize) -> Result<(String, usize), String> {
    let mut labels = Vec::new();
    let mut cursor = start;
    let mut next = start;
    let mut jumped = false;
    let mut hops = 0;
    loop {
        let length = *bytes.get(cursor).ok_or("Truncated DNS name")? as usize;
        if length == 0 {
            if !jumped {
                next = cursor + 1;
            }
            break;
        }
        if length & 0xc0 == 0xc0 {
            let tail = *bytes.get(cursor + 1).ok_or("Truncated DNS pointer")? as usize;
            if !jumped {
                next = cursor + 2;
            }
            jumped = true;
            cursor = ((length & 0x3f) << 8) | tail;
            hops += 1;
            if hops > 32 {
                return Err("DNS name pointer loop".into());
            }
            continue;
        }
        if length > 63 || cursor + 1 + length > bytes.len() {
            return Err("Invalid DNS label".into());
        }
        labels.push(String::from_utf8_lossy(&bytes[cursor + 1..cursor + 1 + length]).into_owned());
        cursor += 1 + length;
    }
    Ok((labels.join("."), next))
}

fn parse_devices(bytes: &[u8]) -> Result<Vec<Device>, String> {
    if bytes.len() < 12 {
        return Err("Truncated DNS response".into());
    }
    let questions = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
    let count = u16::from_be_bytes([bytes[6], bytes[7]]) as usize
        + u16::from_be_bytes([bytes[8], bytes[9]]) as usize
        + u16::from_be_bytes([bytes[10], bytes[11]]) as usize;
    if count > 4096 {
        return Err("Too many DNS records".into());
    }
    let mut cursor = 12;
    for _ in 0..questions {
        cursor = read_name(bytes, cursor)?.1 + 4;
        if cursor > bytes.len() {
            return Err("Truncated DNS question".into());
        }
    }
    let mut records = Vec::new();
    for _ in 0..count {
        let (name, next) = read_name(bytes, cursor)?;
        if next + 10 > bytes.len() {
            return Err("Truncated DNS record".into());
        }
        let kind = u16::from_be_bytes([bytes[next], bytes[next + 1]]);
        let length = u16::from_be_bytes([bytes[next + 8], bytes[next + 9]]) as usize;
        let data = next + 10;
        if data + length > bytes.len() {
            return Err("Truncated DNS data".into());
        }
        match kind {
            1 if length == 4 => records.push(Record::A {
                name,
                address: format!(
                    "{}.{}.{}.{}",
                    bytes[data],
                    bytes[data + 1],
                    bytes[data + 2],
                    bytes[data + 3]
                ),
            }),
            12 => records.push(Record::Ptr {
                name,
                domain: read_name(bytes, data)?.0,
            }),
            33 if length >= 6 => records.push(Record::Srv {
                name,
                port: u16::from_be_bytes([bytes[data + 4], bytes[data + 5]]),
                target: read_name(bytes, data + 6)?.0,
            }),
            16 => {
                let mut values = HashMap::new();
                let mut at = data;
                while at < data + length {
                    let size = bytes[at] as usize;
                    at += 1;
                    if at + size > data + length {
                        break;
                    }
                    let text = String::from_utf8_lossy(&bytes[at..at + size]);
                    if let Some((key, value)) = text.split_once('=') {
                        values.insert(key.into(), value.into());
                    }
                    at += size;
                }
                records.push(Record::Txt { name, values });
            }
            _ => {}
        }
        cursor = data + length;
    }
    let mut addresses = HashMap::new();
    let mut services: HashMap<String, (Option<u16>, Option<String>, HashMap<String, String>)> =
        HashMap::new();
    for record in &records {
        if let Record::A { name, address } = record {
            addresses.insert(name.to_lowercase(), address.clone());
        }
    }
    for record in records {
        match record {
            Record::Ptr { name, domain } if name.eq_ignore_ascii_case(SERVICE) => {
                services
                    .entry(domain.to_lowercase())
                    .or_insert((None, None, HashMap::new()));
            }
            Record::Srv { name, port, target } if name.to_lowercase().ends_with(SERVICE) => {
                let item =
                    services
                        .entry(name.to_lowercase())
                        .or_insert((None, None, HashMap::new()));
                item.0 = Some(port);
                item.1 = Some(target);
            }
            Record::Txt { name, values } if name.to_lowercase().ends_with(SERVICE) => {
                services
                    .entry(name.to_lowercase())
                    .or_insert((None, None, HashMap::new()))
                    .2 = values;
            }
            _ => {}
        }
    }
    Ok(services
        .into_iter()
        .filter_map(|(instance, (port, target, txt))| {
            let target = target?;
            let host = addresses.get(&target.to_lowercase())?.clone();
            let label = instance
                .strip_suffix(&format!(".{SERVICE}"))
                .unwrap_or(&instance);
            Some(Device {
                id: txt.get("id").cloned().unwrap_or_else(|| label.into()),
                name: txt.get("fn").cloned().unwrap_or_else(|| label.into()),
                model: txt.get("md").cloned().unwrap_or_default(),
                host,
                port: port?,
            })
        })
        .collect())
}

#[derive(Clone)]
pub struct CastClient {
    inner: Arc<Mutex<CastConnection>>,
    next_request: Arc<AtomicU64>,
    transport_id: Arc<Mutex<Option<String>>>,
    session_id: Arc<Mutex<Option<String>>>,
    media_session_id: Arc<Mutex<Option<i64>>>,
}

impl CastClient {
    pub fn connect(device: &Device) -> Result<Self, String> {
        let address = format!("{}:{}", device.host, device.port);
        let tcp = TcpStream::connect_timeout(
            &address.parse().map_err(|_| "Invalid Cast address")?,
            Duration::from_secs(8),
        )
        .map_err(|error| format!("CAST_CONNECT_FAILED: {error}"))?;
        tcp.set_read_timeout(Some(TIMEOUT))
            .map_err(|error| error.to_string())?;
        tcp.set_write_timeout(Some(TIMEOUT))
            .map_err(|error| error.to_string())?;
        let tls = TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(|error| error.to_string())?
            .connect(&device.host, tcp)
            .map_err(|error| format!("CAST_CONNECT_FAILED: {error}"))?;
        let client = Self {
            inner: Arc::new(Mutex::new(CastConnection { stream: tls })),
            next_request: Arc::new(AtomicU64::new(1)),
            transport_id: Arc::default(),
            session_id: Arc::default(),
            media_session_id: Arc::default(),
        };
        client.send(CONNECTION, PLATFORM, &json!({"type":"CONNECT"}))?;
        Ok(client)
    }
    pub fn launch(&self) -> Result<(), String> {
        let response = self.request(
            RECEIVER,
            PLATFORM,
            json!({"type":"LAUNCH","appId":"CC1AD845"}),
        )?;
        if response["type"] == "LAUNCH_ERROR" {
            return Err("CAST_CONNECT_FAILED: Receiver refused to launch".into());
        }
        let app = response
            .pointer("/status/applications/0")
            .ok_or("CAST_CONNECT_FAILED: Receiver did not report an application transport")?;
        *self.transport_id.lock().map_err(lock_error)? =
            app["transportId"].as_str().map(str::to_string);
        *self.session_id.lock().map_err(lock_error)? =
            app["sessionId"].as_str().map(str::to_string);
        let transport = self.transport()?;
        self.send(CONNECTION, &transport, &json!({"type":"CONNECT"}))
    }
    pub fn load(
        &self,
        content_id: &str,
        content_type: &str,
        title: &str,
        artist: &str,
        album: &str,
        image_url: Option<&str>,
        duration: Option<f64>,
        position: f64,
        autoplay: bool,
    ) -> Result<MediaStatus, String> {
        let transport = self.transport()?;
        let response = self.request(MEDIA, &transport, json!({"type":"LOAD","autoplay":autoplay,"currentTime":position.max(0.0),"media":{"contentId":content_id,"contentType":content_type,"streamType":"BUFFERED","duration":duration,"metadata":{"metadataType":3,"title":title,"artist":artist,"albumName":album,"images":image_url.map(|url| vec![json!({"url":url})]).unwrap_or_default()}}}))?;
        if matches!(
            response["type"].as_str(),
            Some("LOAD_FAILED" | "LOAD_CANCELLED" | "ERROR")
        ) {
            return Err("CAST_LOAD_FAILED: Receiver could not load the track".into());
        }
        self.status_from(&response)
    }
    pub fn play(&self) -> Result<MediaStatus, String> {
        self.media_command("PLAY", json!({}))
    }
    pub fn pause(&self) -> Result<MediaStatus, String> {
        self.media_command("PAUSE", json!({}))
    }
    pub fn seek(&self, value: f64) -> Result<MediaStatus, String> {
        self.media_command("SEEK", json!({"currentTime":value.max(0.0)}))
    }
    pub fn status(&self) -> Result<MediaStatus, String> {
        let transport = self.transport()?;
        let value = self.request(MEDIA, &transport, json!({"type":"GET_STATUS"}))?;
        self.status_from(&value)
    }
    pub fn volume(&self, value: f64) -> Result<(), String> {
        self.request(
            RECEIVER,
            PLATFORM,
            json!({"type":"SET_VOLUME","volume":{"level":value.clamp(0.0,1.0)}}),
        )
        .map(|_| ())
    }
    pub fn stop(&self) {
        if let Ok(Some(session)) = self.session_id.lock().map(|value| value.clone()) {
            let _ = self.request(
                RECEIVER,
                PLATFORM,
                json!({"type":"STOP","sessionId":session}),
            );
        }
    }
    fn media_command(&self, kind: &str, extra: Value) -> Result<MediaStatus, String> {
        let session = self
            .media_session_id
            .lock()
            .map_err(lock_error)?
            .ok_or("CAST_SESSION_ENDED: No media is loaded")?;
        let transport = self.transport()?;
        let mut body = json!({"type":kind,"mediaSessionId":session});
        if let (Some(target), Some(source)) = (body.as_object_mut(), extra.as_object()) {
            target.extend(source.clone());
        }
        let response = self.request(MEDIA, &transport, body)?;
        self.status_from(&response)
    }
    fn status_from(&self, response: &Value) -> Result<MediaStatus, String> {
        let raw = response["status"]
            .as_array()
            .and_then(|values| values.first())
            .cloned()
            .unwrap_or(Value::Null);
        let status = normalize_status(&raw);
        *self.media_session_id.lock().map_err(lock_error)? = status.media_session_id;
        Ok(status)
    }
    fn transport(&self) -> Result<String, String> {
        self.transport_id
            .lock()
            .map_err(lock_error)?
            .clone()
            .ok_or("CAST_SESSION_ENDED: No receiver application is running".into())
    }
    fn send(&self, namespace: &str, destination: &str, body: &Value) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(lock_error)?
            .send(namespace, destination, body)
    }
    fn request(
        &self,
        namespace: &str,
        destination: &str,
        mut body: Value,
    ) -> Result<Value, String> {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        body.as_object_mut()
            .ok_or("Invalid Cast request")?
            .insert("requestId".into(), id.into());
        self.inner
            .lock()
            .map_err(lock_error)?
            .request(namespace, destination, &body, id)
    }
}

struct CastConnection {
    stream: TlsStream<TcpStream>,
}
impl CastConnection {
    fn send(&mut self, namespace: &str, destination: &str, body: &Value) -> Result<(), String> {
        let message = encode_message("sender-0", destination, namespace, &body.to_string());
        self.stream
            .write_all(&(message.len() as u32).to_be_bytes())
            .and_then(|_| self.stream.write_all(&message))
            .map_err(|error| error.to_string())
    }
    fn request(
        &mut self,
        namespace: &str,
        destination: &str,
        body: &Value,
        request_id: u64,
    ) -> Result<Value, String> {
        self.send(namespace, destination, body)?;
        loop {
            let mut length = [0_u8; 4];
            self.stream
                .read_exact(&mut length)
                .map_err(|error| error.to_string())?;
            let length = u32::from_be_bytes(length) as usize;
            if length > MAX_FRAME {
                return Err("Cast frame exceeds sane size".into());
            }
            let mut bytes = vec![0; length];
            self.stream
                .read_exact(&mut bytes)
                .map_err(|error| error.to_string())?;
            let message = decode_message(&bytes)?;
            let payload: Value =
                serde_json::from_str(&message.payload).map_err(|error| error.to_string())?;
            if message.namespace == HEARTBEAT && payload["type"] == "PING" {
                self.send(HEARTBEAT, PLATFORM, &json!({"type":"PONG"}))?;
                continue;
            }
            if payload["requestId"].as_u64() == Some(request_id) {
                return Ok(payload);
            }
        }
    }
}

fn normalize_status(raw: &Value) -> MediaStatus {
    let state = match raw["playerState"].as_str() {
        Some("PLAYING") => "playing",
        Some("PAUSED") => "paused",
        Some("BUFFERING" | "LOADING") => "buffering",
        _ => "idle",
    };
    MediaStatus {
        media_session_id: raw["mediaSessionId"].as_i64(),
        player_state: state.into(),
        idle_reason: raw["idleReason"].as_str().map(str::to_string),
        position: raw["currentTime"].as_f64().unwrap_or(0.0),
        duration: raw.pointer("/media/duration").and_then(Value::as_f64),
        content_id: raw
            .pointer("/media/contentId")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn varint(mut value: u64, bytes: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if value == 0 {
            break;
        }
    }
}
fn field(number: u64, value: &[u8], bytes: &mut Vec<u8>) {
    varint(number << 3 | 2, bytes);
    varint(value.len() as u64, bytes);
    bytes.extend_from_slice(value);
}
fn encode_message(source: &str, destination: &str, namespace: &str, payload: &str) -> Vec<u8> {
    let mut bytes = vec![8, 0];
    field(2, source.as_bytes(), &mut bytes);
    field(3, destination.as_bytes(), &mut bytes);
    field(4, namespace.as_bytes(), &mut bytes);
    bytes.extend_from_slice(&[40, 0]);
    field(6, payload.as_bytes(), &mut bytes);
    bytes
}
fn read_varint(bytes: &[u8], cursor: &mut usize) -> Result<u64, String> {
    let mut result = 0;
    for shift in (0..=63).step_by(7) {
        let value = *bytes.get(*cursor).ok_or("Truncated Cast varint")?;
        *cursor += 1;
        result |= ((value & 0x7f) as u64) << shift;
        if value & 0x80 == 0 {
            return Ok(result);
        }
    }
    Err("Cast varint too long".into())
}
struct CastMessage {
    namespace: String,
    payload: String,
}
fn decode_message(bytes: &[u8]) -> Result<CastMessage, String> {
    let mut cursor = 0;
    let mut namespace = String::new();
    let mut payload = String::new();
    while cursor < bytes.len() {
        let tag = read_varint(bytes, &mut cursor)?;
        match tag & 7 {
            0 => {
                let _ = read_varint(bytes, &mut cursor)?;
            }
            2 => {
                let length = read_varint(bytes, &mut cursor)? as usize;
                if cursor + length > bytes.len() {
                    return Err("Truncated Cast field".into());
                }
                let value = String::from_utf8_lossy(&bytes[cursor..cursor + length]).into_owned();
                cursor += length;
                match tag >> 3 {
                    4 => namespace = value,
                    6 => payload = value,
                    _ => {}
                }
            }
            _ => return Err("Unsupported Cast wire type".into()),
        }
    }
    Ok(CastMessage { namespace, payload })
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Cast service state is unavailable".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_targets_googlecast() {
        let value = build_ptr_query();
        let (name, next) = read_name(&value, 12).unwrap();
        assert_eq!(name, SERVICE);
        assert_eq!(&value[next + 2..next + 4], &[0x80, 1]);
    }
    #[test]
    fn cast_message_round_trip() {
        let bytes = encode_message("sender-0", "receiver-0", MEDIA, "{\"type\":\"PING\"}");
        let decoded = decode_message(&bytes).unwrap();
        assert_eq!(decoded.namespace, MEDIA);
        assert!(decoded.payload.contains("PING"));
    }
    #[test]
    fn normalizes_finished_status() {
        let value = json!({"mediaSessionId":4,"playerState":"IDLE","idleReason":"FINISHED","currentTime":8.0,"media":{"duration":8.0,"contentId":"http://x"}});
        let status = normalize_status(&value);
        assert_eq!(status.player_state, "idle");
        assert_eq!(status.idle_reason.as_deref(), Some("FINISHED"));
    }
}
