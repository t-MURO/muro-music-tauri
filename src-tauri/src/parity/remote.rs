//! Native Cast and DLNA remote-output services.
//!
//! Manage `RemoteOutputService::new(app.handle().clone())` and register the
//! command functions below. Both protocols preserve the Electron renderer's
//! command DTOs and `muro://cast-*` / `muro://dlna-*` event contracts.

pub mod cast;
pub mod dlna;
pub mod media_server;

use cast::{CastClient, CastDiscovery};
use dlna::{build_didl, DlnaClient, DlnaDiscovery};
use media_server::{content_type, LanMediaServer, MediaKind};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub model: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoverySnapshot {
    pub devices: Vec<Device>,
    pub scanning: bool,
    pub error: Option<String>,
}
impl DiscoverySnapshot {
    pub fn error(message: &str) -> Self {
        Self {
            devices: Vec::new(),
            scanning: false,
            error: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub media_session_id: Option<i64>,
    pub player_state: String,
    pub idle_reason: Option<String>,
    pub position: f64,
    pub duration: Option<f64>,
    pub content_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTrack {
    pub track_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub state: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub media: Option<MediaStatus>,
    pub track: Option<LoadedTrack>,
    pub last_error: Option<ErrorPayload>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            device_id: None,
            device_name: None,
            media: None,
            track: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StateWithDiscovery {
    #[serde(flatten)]
    pub session: SessionState,
    pub discovery: DiscoverySnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
    pub last_position_secs: Option<f64>,
    pub track_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct MediaStatusEvent {
    status: MediaStatus,
    finished: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTrack {
    pub track_id: String,
    pub source_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_seconds: f64,
    pub cover_art_path: Option<String>,
    pub start_position_secs: Option<f64>,
    pub autoplay: Option<bool>,
}

struct Polling {
    stop: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

struct CastSession {
    client: CastClient,
    host: String,
}
struct CastController {
    app: AppHandle,
    discovery: CastDiscovery,
    server: LanMediaServer,
    public: Mutex<SessionState>,
    session: Mutex<Option<CastSession>>,
    poll: Mutex<Option<Polling>>,
}

impl CastController {
    fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            discovery: CastDiscovery::default(),
            server: LanMediaServer::new(),
            public: Mutex::new(SessionState::default()),
            session: Mutex::new(None),
            poll: Mutex::new(None),
        })
    }
    fn state(&self) -> SessionState {
        self.public
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }
    fn set_state(&self, name: &str, error: Option<ErrorPayload>) {
        if let Ok(mut state) = self.public.lock() {
            state.state = name.into();
            state.last_error = error;
            let _ = self.app.emit("muro://cast-state", state.clone());
        }
    }
    fn start_discovery(&self) -> DiscoverySnapshot {
        let app = self.app.clone();
        self.discovery.start(Arc::new(move |snapshot| {
            let _ = app.emit("muro://cast-devices", snapshot);
        }))
    }
    fn connect(self: &Arc<Self>, id: &str) -> Result<SessionState, String> {
        let device = self
            .discovery
            .snapshot()
            .devices
            .into_iter()
            .find(|device| device.id == id)
            .ok_or_else(|| {
                stable(
                    "CAST_DEVICE_NOT_FOUND",
                    "The selected cast device is no longer visible on this network",
                )
            })?;
        let _ = self.disconnect();
        self.set_state("connecting", None);
        let result: Result<CastClient, String> = (|| {
            let client = CastClient::connect(&device)?;
            client.launch()?;
            self.server.start()?;
            self.server.begin_session()?;
            Ok(client)
        })();
        let client = match result {
            Ok(client) => client,
            Err(error) => {
                let code = if error.contains("TIMEOUT") {
                    "CAST_CONNECT_TIMEOUT"
                } else {
                    "CAST_CONNECT_FAILED"
                };
                self.set_state(
                    "error",
                    Some(ErrorPayload {
                        code: code.into(),
                        message: clean_error(&error),
                    }),
                );
                return Err(stable(code, &clean_error(&error)));
            }
        };
        *self.session.lock().map_err(lock_error)? = Some(CastSession {
            client,
            host: device.host.clone(),
        });
        if let Ok(mut state) = self.public.lock() {
            state.device_id = Some(device.id);
            state.device_name = Some(device.name);
            state.media = None;
            state.track = None;
        }
        self.set_state("connected", None);
        self.start_poll();
        Ok(self.state())
    }
    fn start_poll(self: &Arc<Self>) {
        self.stop_poll();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let owner = self.clone();
        let join = thread::Builder::new()
            .name("muro-cast-status".into())
            .spawn(move || {
                let mut failures = 0;
                while !worker_stop.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_secs(1));
                    if worker_stop.load(Ordering::Acquire) {
                        break;
                    }
                    let client = owner
                        .session
                        .lock()
                        .ok()
                        .and_then(|session| session.as_ref().map(|value| value.client.clone()));
                    if let Some(client) = client {
                        match client.status() {
                            Ok(status) => {
                                failures = 0;
                                owner.update_status(status);
                            }
                            Err(_) => {
                                failures += 1;
                                if failures >= 5 {
                                    owner.set_state(
                                        "error",
                                        Some(ErrorPayload {
                                            code: "CAST_SESSION_ENDED".into(),
                                            message: "The cast device stopped responding".into(),
                                        }),
                                    );
                                    break;
                                }
                            }
                        }
                    }
                }
            })
            .expect("cast poll thread");
        if let Ok(mut poll) = self.poll.lock() {
            *poll = Some(Polling { stop, join });
        }
    }
    fn stop_poll(&self) {
        if let Some(poll) = self.poll.lock().ok().and_then(|mut value| value.take()) {
            poll.stop.store(true, Ordering::Release);
            let _ = poll.join.join();
        }
    }
    fn update_status(&self, status: MediaStatus) {
        let finished = self
            .public
            .lock()
            .ok()
            .and_then(|state| state.media.clone())
            .map(|previous| {
                previous.media_session_id.is_some()
                    && previous.player_state != "idle"
                    && status.player_state == "idle"
                    && status.idle_reason.as_deref() == Some("FINISHED")
            })
            .unwrap_or(false);
        if let Ok(mut state) = self.public.lock() {
            state.media = Some(status.clone());
            if !matches!(
                state.state.as_str(),
                "connecting" | "loading" | "disconnecting" | "error"
            ) {
                state.state = state_for(&status);
            }
            let _ = self.app.emit("muro://cast-state", state.clone());
        }
        let _ = self.app.emit(
            "muro://cast-media-status",
            MediaStatusEvent { status, finished },
        );
    }
    fn disconnect(&self) -> Result<DisconnectResult, String> {
        let recovery = recovery(&self.state());
        self.set_state("disconnecting", None);
        self.stop_poll();
        if let Some(session) = self.session.lock().map_err(lock_error)?.take() {
            session.client.stop();
        }
        self.server.end_session();
        if let Ok(mut state) = self.public.lock() {
            *state = SessionState::default();
        }
        self.set_state("idle", None);
        Ok(recovery)
    }
    fn load(&self, input: LoadTrack) -> Result<SessionState, String> {
        let content = cast_content_type(&input.source_path)
            .ok_or_else(|| stable("CAST_UNSUPPORTED_FORMAT", "This format cannot be cast yet"))?;
        ensure_file(&input.source_path, "CAST_LOAD_FAILED")?;
        self.server.revoke_authorizations();
        let (client, host) = self
            .session
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .map(|value| (value.client.clone(), value.host.clone()))
            .ok_or_else(|| stable("CAST_SESSION_ENDED", "No active cast session"))?;
        let media_path = self
            .server
            .authorize_file(Path::new(&input.source_path), MediaKind::Media)?;
        let media_url = self.server.url_for(&media_path, &host).ok_or_else(|| {
            stable(
                "CAST_MEDIA_SERVER_UNREACHABLE",
                "No local network address is reachable by the cast device",
            )
        })?;
        let art_url = input
            .cover_art_path
            .as_deref()
            .filter(|path| Path::new(path).is_file())
            .and_then(|path| {
                self.server
                    .authorize_file(Path::new(path), MediaKind::Artwork)
                    .ok()
            })
            .and_then(|path| self.server.url_for(&path, &host));
        self.set_state("loading", None);
        let status = client
            .load(
                &media_url,
                content,
                &input.title,
                &input.artist,
                &input.album,
                art_url.as_deref(),
                finite_positive(input.duration_seconds),
                input.start_position_secs.unwrap_or(0.0),
                input.autoplay.unwrap_or(true),
            )
            .map_err(|error| stable("CAST_LOAD_FAILED", &clean_error(&error)))?;
        if let Ok(mut state) = self.public.lock() {
            state.track = Some(loaded(&input));
        }
        self.update_status(status);
        Ok(self.state())
    }
    fn media_command(
        &self,
        operation: impl FnOnce(&CastClient) -> Result<MediaStatus, String>,
    ) -> Result<SessionState, String> {
        let client = self
            .session
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .map(|value| value.client.clone())
            .ok_or_else(|| stable("CAST_SESSION_ENDED", "No active cast session"))?;
        let status = operation(&client)
            .map_err(|error| stable("CAST_COMMAND_FAILED", &clean_error(&error)))?;
        self.update_status(status);
        Ok(self.state())
    }
    fn shutdown(&self) {
        let _ = self.disconnect();
        self.discovery.stop();
        self.server.stop();
    }
}

struct DlnaSession {
    client: DlnaClient,
    host: String,
}
struct DlnaController {
    app: AppHandle,
    discovery: DlnaDiscovery,
    server: LanMediaServer,
    public: Mutex<SessionState>,
    session: Mutex<Option<DlnaSession>>,
    poll: Mutex<Option<Polling>>,
}

impl DlnaController {
    fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            discovery: DlnaDiscovery::default(),
            server: LanMediaServer::new(),
            public: Mutex::new(SessionState::default()),
            session: Mutex::new(None),
            poll: Mutex::new(None),
        })
    }
    fn state(&self) -> SessionState {
        self.public
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }
    fn set_state(&self, name: &str, error: Option<ErrorPayload>) {
        if let Ok(mut state) = self.public.lock() {
            state.state = name.into();
            state.last_error = error;
            let _ = self.app.emit("muro://dlna-state", state.clone());
        }
    }
    fn start_discovery(&self) -> DiscoverySnapshot {
        let app = self.app.clone();
        self.discovery.start(Arc::new(move |snapshot| {
            let _ = app.emit("muro://dlna-devices", snapshot);
        }))
    }
    fn connect(self: &Arc<Self>, id: &str) -> Result<SessionState, String> {
        let record = self.discovery.record(id).ok_or_else(|| {
            stable(
                "DLNA_DEVICE_NOT_FOUND",
                "The selected device is no longer visible on this network",
            )
        })?;
        let _ = self.disconnect();
        self.set_state("connecting", None);
        let client =
            DlnaClient::new(&record).map_err(|error| stable("DLNA_CONNECT_FAILED", &error))?;
        client
            .status(None)
            .map_err(|error| stable("DLNA_CONNECT_FAILED", &error))?;
        self.server
            .start()
            .map_err(|error| stable("DLNA_CONNECT_FAILED", &error))?;
        self.server.begin_session()?;
        *self.session.lock().map_err(lock_error)? = Some(DlnaSession {
            client,
            host: record.device.host.clone(),
        });
        if let Ok(mut state) = self.public.lock() {
            state.device_id = Some(record.device.id);
            state.device_name = Some(record.device.name);
            state.media = None;
            state.track = None;
        }
        self.set_state("connected", None);
        self.start_poll();
        Ok(self.state())
    }
    fn start_poll(self: &Arc<Self>) {
        self.stop_poll();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let owner = self.clone();
        let join = thread::Builder::new()
            .name("muro-dlna-status".into())
            .spawn(move || {
                let mut failures = 0;
                while !worker_stop.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_secs(1));
                    let pair = owner
                        .session
                        .lock()
                        .ok()
                        .and_then(|session| session.as_ref().map(|value| value.client.clone()));
                    if let Some(client) = pair {
                        let duration = owner.state().track.and_then(|track| track.duration_seconds);
                        match client.status(duration) {
                            Ok(status) => {
                                failures = 0;
                                owner.update_status(status);
                            }
                            Err(_) => {
                                failures += 1;
                                if failures >= 5 {
                                    owner.set_state(
                                        "error",
                                        Some(ErrorPayload {
                                            code: "DLNA_SESSION_ENDED".into(),
                                            message: "The device stopped responding".into(),
                                        }),
                                    );
                                    break;
                                }
                            }
                        }
                    }
                }
            })
            .expect("dlna poll thread");
        if let Ok(mut poll) = self.poll.lock() {
            *poll = Some(Polling { stop, join });
        }
    }
    fn stop_poll(&self) {
        if let Some(poll) = self.poll.lock().ok().and_then(|mut value| value.take()) {
            poll.stop.store(true, Ordering::Release);
            let _ = poll.join.join();
        }
    }
    fn update_status(&self, status: MediaStatus) {
        let previous = self
            .public
            .lock()
            .ok()
            .and_then(|state| state.media.clone());
        let finished = previous
            .as_ref()
            .map(|value| {
                matches!(value.player_state.as_str(), "playing" | "buffering")
                    && status.player_state == "idle"
                    && value
                        .duration
                        .map(|duration| duration - value.position <= 5.0)
                        .unwrap_or(false)
            })
            .unwrap_or(false);
        if let Ok(mut state) = self.public.lock() {
            state.media = Some(status.clone());
            if !matches!(
                state.state.as_str(),
                "connecting" | "loading" | "disconnecting" | "error"
            ) {
                state.state = state_for(&status);
            }
            let _ = self.app.emit("muro://dlna-state", state.clone());
        }
        let _ = self.app.emit(
            "muro://dlna-media-status",
            MediaStatusEvent { status, finished },
        );
    }
    fn disconnect(&self) -> Result<DisconnectResult, String> {
        let recovery = recovery(&self.state());
        self.set_state("disconnecting", None);
        self.stop_poll();
        if let Some(session) = self.session.lock().map_err(lock_error)?.take() {
            let _ = session.client.stop();
        }
        self.server.end_session();
        if let Ok(mut state) = self.public.lock() {
            *state = SessionState::default();
        }
        self.set_state("idle", None);
        Ok(recovery)
    }
    fn load(&self, input: LoadTrack) -> Result<SessionState, String> {
        let content = dlna_content_type(&input.source_path).ok_or_else(|| {
            stable(
                "DLNA_UNSUPPORTED_FORMAT",
                "This format cannot be played on this device yet",
            )
        })?;
        ensure_file(&input.source_path, "DLNA_LOAD_FAILED")?;
        self.server.revoke_authorizations();
        let (client, host) = self
            .session
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .map(|value| (value.client.clone(), value.host.clone()))
            .ok_or_else(|| stable("DLNA_SESSION_ENDED", "No active playback session"))?;
        let path = self
            .server
            .authorize_file(Path::new(&input.source_path), MediaKind::Media)?;
        let url = self.server.url_for(&path, &host).ok_or_else(|| {
            stable(
                "DLNA_MEDIA_SERVER_UNREACHABLE",
                "No local network address is reachable by the device",
            )
        })?;
        let art = input
            .cover_art_path
            .as_deref()
            .filter(|path| Path::new(path).is_file())
            .and_then(|path| {
                self.server
                    .authorize_file(Path::new(path), MediaKind::Artwork)
                    .ok()
            })
            .and_then(|path| self.server.url_for(&path, &host));
        self.set_state("loading", None);
        let metadata = build_didl(
            &url,
            content,
            &input.title,
            &input.artist,
            &input.album,
            art.as_deref(),
            finite_positive(input.duration_seconds),
        );
        client
            .set_uri(&url, &metadata)
            .and_then(|_| client.play())
            .map_err(|error| stable("DLNA_LOAD_FAILED", &error))?;
        let start = input.start_position_secs.unwrap_or(0.0).max(0.0);
        if start > 0.0 {
            let _ = client.seek(start);
        }
        if let Ok(mut state) = self.public.lock() {
            state.track = Some(loaded(&input));
        }
        self.update_status(MediaStatus {
            media_session_id: None,
            player_state: "buffering".into(),
            idle_reason: None,
            position: start,
            duration: finite_positive(input.duration_seconds),
            content_id: None,
        });
        self.set_state("playing", None);
        Ok(self.state())
    }
    fn command(
        &self,
        operation: impl FnOnce(&DlnaClient) -> Result<(), String>,
    ) -> Result<SessionState, String> {
        let client = self
            .session
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .map(|value| value.client.clone())
            .ok_or_else(|| stable("DLNA_SESSION_ENDED", "No active playback session"))?;
        operation(&client).map_err(|error| stable("DLNA_COMMAND_FAILED", &error))?;
        if let Ok(status) =
            client.status(self.state().track.and_then(|track| track.duration_seconds))
        {
            self.update_status(status);
        }
        Ok(self.state())
    }
    fn shutdown(&self) {
        let _ = self.disconnect();
        self.discovery.stop();
        self.server.stop();
    }
}

#[derive(Clone)]
pub struct RemoteOutputService {
    cast: Arc<CastController>,
    dlna: Arc<DlnaController>,
}
impl RemoteOutputService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            cast: CastController::new(app.clone()),
            dlna: DlnaController::new(app),
        }
    }
    pub fn shutdown(&self) {
        self.cast.shutdown();
        self.dlna.shutdown();
    }
}

fn state_for(status: &MediaStatus) -> String {
    match status.player_state.as_str() {
        "playing" => "playing",
        "paused" => "paused",
        "buffering" => "buffering",
        _ => "connected",
    }
    .into()
}
fn loaded(input: &LoadTrack) -> LoadedTrack {
    LoadedTrack {
        track_id: Some(input.track_id.clone()),
        title: input.title.clone(),
        artist: input.artist.clone(),
        album: input.album.clone(),
        duration_seconds: finite_positive(input.duration_seconds),
    }
}
fn recovery(state: &SessionState) -> DisconnectResult {
    DisconnectResult {
        last_position_secs: state.media.as_ref().map(|media| media.position),
        track_id: state
            .track
            .as_ref()
            .and_then(|track| track.track_id.clone()),
    }
}
fn finite_positive(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0).then_some(value)
}
fn ensure_file(path: &str, code: &str) -> Result<(), String> {
    Path::new(path)
        .is_file()
        .then_some(())
        .ok_or_else(|| stable(code, "The track file is missing or unreadable"))
}
fn clean_error(value: &str) -> String {
    value
        .split_once(": ")
        .map(|(_, message)| message)
        .unwrap_or(value)
        .to_string()
}
fn stable(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Remote output state is unavailable".into()
}
fn cast_content_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" | "flac" | "wav" | "ogg" | "oga" | "opus" => Some(content_type(Path::new(path))),
        _ => None,
    }
}
fn dlna_content_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" | "flac" | "wav" | "ogg" | "oga" | "opus" | "m4a" | "mp4" | "aac" | "aif"
        | "aiff" | "alac" => Some(content_type(Path::new(path))),
        _ => None,
    }
}

#[tauri::command]
pub async fn cast_start_discovery(
    service: State<'_, RemoteOutputService>,
) -> Result<DiscoverySnapshot, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || cast.start_discovery())
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn cast_stop_discovery(
    service: State<'_, RemoteOutputService>,
) -> Result<DiscoverySnapshot, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || cast.discovery.stop())
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub fn cast_get_devices(service: State<'_, RemoteOutputService>) -> DiscoverySnapshot {
    service.cast.discovery.snapshot()
}
#[tauri::command(rename_all = "camelCase")]
pub async fn cast_connect(
    service: State<'_, RemoteOutputService>,
    device_id: String,
) -> Result<SessionState, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || cast.connect(&device_id))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn cast_disconnect(
    service: State<'_, RemoteOutputService>,
) -> Result<DisconnectResult, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || cast.disconnect())
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command(rename_all = "camelCase")]
pub async fn cast_load_track(
    service: State<'_, RemoteOutputService>,
    track_id: String,
    source_path: String,
    title: String,
    artist: String,
    album: String,
    duration_seconds: f64,
    cover_art_path: Option<String>,
    start_position_secs: Option<f64>,
    autoplay: Option<bool>,
) -> Result<SessionState, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || {
        cast.load(LoadTrack {
            track_id,
            source_path,
            title,
            artist,
            album,
            duration_seconds,
            cover_art_path,
            start_position_secs,
            autoplay,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn cast_play(service: State<'_, RemoteOutputService>) -> Result<SessionState, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || cast.media_command(CastClient::play))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn cast_pause(service: State<'_, RemoteOutputService>) -> Result<SessionState, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || cast.media_command(CastClient::pause))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command(rename_all = "camelCase")]
pub async fn cast_seek(
    service: State<'_, RemoteOutputService>,
    position_secs: f64,
) -> Result<SessionState, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || {
        cast.media_command(|client| client.seek(position_secs))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn cast_set_volume(
    service: State<'_, RemoteOutputService>,
    volume: f64,
) -> Result<SessionState, String> {
    let cast = service.cast.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = cast
            .session
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .map(|value| value.client.clone())
            .ok_or_else(|| stable("CAST_SESSION_ENDED", "No active cast session"))?;
        client
            .volume(volume)
            .map_err(|error| stable("CAST_COMMAND_FAILED", &error))?;
        Ok(cast.state())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn cast_get_state(service: State<'_, RemoteOutputService>) -> StateWithDiscovery {
    StateWithDiscovery {
        session: service.cast.state(),
        discovery: service.cast.discovery.snapshot(),
    }
}

#[tauri::command]
pub async fn dlna_start_discovery(
    service: State<'_, RemoteOutputService>,
) -> Result<DiscoverySnapshot, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.start_discovery())
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn dlna_stop_discovery(
    service: State<'_, RemoteOutputService>,
) -> Result<DiscoverySnapshot, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.discovery.stop())
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub fn dlna_get_devices(service: State<'_, RemoteOutputService>) -> DiscoverySnapshot {
    service.dlna.discovery.snapshot()
}
#[tauri::command(rename_all = "camelCase")]
pub async fn dlna_connect(
    service: State<'_, RemoteOutputService>,
    device_id: String,
) -> Result<SessionState, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.connect(&device_id))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn dlna_disconnect(
    service: State<'_, RemoteOutputService>,
) -> Result<DisconnectResult, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.disconnect())
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command(rename_all = "camelCase")]
pub async fn dlna_load_track(
    service: State<'_, RemoteOutputService>,
    track_id: String,
    source_path: String,
    title: String,
    artist: String,
    album: String,
    duration_seconds: f64,
    cover_art_path: Option<String>,
    start_position_secs: Option<f64>,
    autoplay: Option<bool>,
) -> Result<SessionState, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || {
        dlna.load(LoadTrack {
            track_id,
            source_path,
            title,
            artist,
            album,
            duration_seconds,
            cover_art_path,
            start_position_secs,
            autoplay,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn dlna_play(service: State<'_, RemoteOutputService>) -> Result<SessionState, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.command(DlnaClient::play))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn dlna_pause(service: State<'_, RemoteOutputService>) -> Result<SessionState, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.command(DlnaClient::pause))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command(rename_all = "camelCase")]
pub async fn dlna_seek(
    service: State<'_, RemoteOutputService>,
    position_secs: f64,
) -> Result<SessionState, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.command(|client| client.seek(position_secs)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn dlna_set_volume(
    service: State<'_, RemoteOutputService>,
    volume: f64,
) -> Result<SessionState, String> {
    let dlna = service.dlna.clone();
    tauri::async_runtime::spawn_blocking(move || dlna.command(|client| client.set_volume(volume)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn dlna_get_state(service: State<'_, RemoteOutputService>) -> StateWithDiscovery {
    StateWithDiscovery {
        session: service.dlna.state(),
        discovery: service.dlna.discovery.snapshot(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_allowlists_match_electron() {
        assert_eq!(cast_content_type("x.mp3"), Some("audio/mpeg"));
        assert_eq!(cast_content_type("x.m4a"), None);
        assert_eq!(dlna_content_type("x.m4a"), Some("audio/mp4"));
    }
    #[test]
    fn recovery_preserves_position_and_track() {
        let state = SessionState {
            media: Some(MediaStatus {
                media_session_id: None,
                player_state: "paused".into(),
                idle_reason: None,
                position: 14.0,
                duration: Some(20.0),
                content_id: None,
            }),
            track: Some(LoadedTrack {
                track_id: Some("t".into()),
                title: "".into(),
                artist: "".into(),
                album: "".into(),
                duration_seconds: None,
            }),
            ..SessionState::default()
        };
        let value = recovery(&state);
        assert_eq!(value.last_position_secs, Some(14.0));
        assert_eq!(value.track_id.as_deref(), Some("t"));
    }
    #[test]
    fn finished_state_mapping_is_protocol_neutral() {
        let status = MediaStatus {
            media_session_id: None,
            player_state: "buffering".into(),
            idle_reason: None,
            position: 0.0,
            duration: None,
            content_id: None,
        };
        assert_eq!(state_for(&status), "buffering");
    }
}
