//! Native KeyFinder and AcoustID services.
//!
//! Key/BPM detection is delegated to the packaged `keyfinder-native` process.
//! It is a native C++ JSON-lines service, not a Node runtime. Chromaprint is
//! likewise provided by the packaged `fpcalc` executable. Rust owns process
//! supervision, command authorization, library-path resolution, caching and
//! the HTTPS request to AcoustID.

use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const PROTOCOL_VERSION: u64 = 1;
const ACOUSTID_LOOKUP_URL: &str = "https://api.acoustid.org/v2/lookup";
const LOOKUP_CACHE_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const MAX_ACOUSTID_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const CAMELOT_CODES: [&str; 25] = [
    "11B", "8A", "6B", "3A", "1B", "10A", "8B", "5A", "3B", "12A", "10B", "7A", "5B", "2A", "12B",
    "9A", "7B", "4A", "2B", "11A", "9B", "6A", "4B", "1A", "",
];

type PendingSender = oneshot::Sender<Result<Value, String>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyFinderHealth {
    pub service: String,
    pub engine_version: String,
    pub protocol_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistCredit {
    pub name: String,
    pub credited_name: String,
    pub join_phrase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub music_brainz_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcoustIdCandidate {
    pub id: String,
    pub acoustid_id: String,
    pub score: f64,
    pub recording_id: String,
    pub release_id: Option<String>,
    pub release_group_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub artist_credits: Vec<ArtistCredit>,
    pub album: String,
    pub album_artist: String,
    pub album_artist_credits: Vec<ArtistCredit>,
    pub year: Option<i32>,
    pub country: Option<String>,
    pub status: Option<String>,
    pub genre: Option<String>,
    pub album_match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcoustIdIdentificationResult {
    pub track_id: String,
    pub cached: bool,
    pub duration: i64,
    pub candidates: Vec<AcoustIdCandidate>,
}

#[derive(Debug, Clone)]
struct ActiveJob {
    generation: u64,
    public_job_id: String,
    owner: String,
    tracks: Vec<Value>,
}

struct EngineConnection {
    generation: u64,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, PendingSender>>>,
}

struct AnalysisShared {
    app: AppHandle,
    jobs_by_owner: Mutex<HashMap<String, ActiveJob>>,
    raw_jobs: Mutex<HashMap<String, (u64, String)>>,
}

/// Managed Tauri state. Construction is cheap and does not start a process.
pub struct NativeAnalysisService {
    keyfinder_path: Result<PathBuf, String>,
    fpcalc_path: Result<PathBuf, String>,
    engine: Mutex<Option<EngineConnection>>,
    shared: Arc<AnalysisShared>,
    next_request: AtomicU64,
    next_generation: AtomicU64,
    next_job: AtomicU64,
    client: Client,
    acoustid_queue: AsyncMutex<Instant>,
}

impl NativeAnalysisService {
    pub fn new(app: AppHandle) -> Self {
        let keyfinder_path =
            resolve_packaged_binary(&app, "keyfinder-native", "MURO_KEYFINDER_PATH");
        let fpcalc_path = resolve_packaged_binary(&app, "fpcalc", "FPCALC_PATH");
        let shared = Arc::new(AnalysisShared {
            app: app.clone(),
            jobs_by_owner: Mutex::new(HashMap::new()),
            raw_jobs: Mutex::new(HashMap::new()),
        });
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("MuroMusic/0.1.10")
            .build()
            .expect("the rustls HTTP client should initialize");
        Self {
            keyfinder_path,
            fpcalc_path,
            engine: Mutex::new(None),
            shared,
            next_request: AtomicU64::new(1),
            next_generation: AtomicU64::new(1),
            next_job: AtomicU64::new(1),
            client,
            acoustid_queue: AsyncMutex::new(Instant::now()),
        }
    }

    fn connection(&self) -> Result<ConnectionHandle, String> {
        let mut slot = self
            .engine
            .lock()
            .map_err(|_| "KeyFinder process lock is unavailable")?;
        if let Some(connection) = slot.as_mut() {
            if connection
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                *slot = None;
            }
        }
        if slot.is_none() {
            let path = self.keyfinder_path.as_ref().map_err(Clone::clone)?;
            let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
            *slot = Some(spawn_keyfinder(path, generation, self.shared.clone())?);
        }
        let connection = slot.as_ref().expect("connection was initialized");
        Ok(ConnectionHandle {
            generation: connection.generation,
            stdin: connection.stdin.clone(),
            pending: connection.pending.clone(),
        })
    }

    async fn call_on(
        &self,
        connection: &ConnectionHandle,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let request_id = format!(
            "tauri-{}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let envelope = json!({
            "version": PROTOCOL_VERSION,
            "requestId": request_id,
            "method": method,
            "params": params,
        });
        let (sender, receiver) = oneshot::channel();
        connection
            .pending
            .lock()
            .map_err(|_| "KeyFinder response router is unavailable")?
            .insert(request_id.clone(), sender);
        let write_result = {
            let mut stdin = connection
                .stdin
                .lock()
                .map_err(|_| "KeyFinder input is unavailable")?;
            stdin
                .write_all(format!("{envelope}\n").as_bytes())
                .and_then(|_| stdin.flush())
        };
        if let Err(error) = write_result {
            remove_pending(&connection.pending, &request_id);
            return Err(format!("Could not write to KeyFinder: {error}"));
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("KeyFinder response channel closed".into()),
            Err(_) => {
                remove_pending(&connection.pending, &request_id);
                Err(format!("KeyFinder {method} request timed out"))
            }
        }
    }

    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let connection = self.connection()?;
        self.call_on(&connection, method, params, timeout).await
    }
}

impl Drop for NativeAnalysisService {
    fn drop(&mut self) {
        if let Ok(slot) = self.engine.get_mut() {
            if let Some(connection) = slot.as_mut() {
                let _ = connection.child.kill();
                let _ = connection.child.wait();
            }
        }
    }
}

#[derive(Clone)]
struct ConnectionHandle {
    generation: u64,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, PendingSender>>>,
}

fn executable_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_owned()
    }
}

fn target_triple() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

fn resolve_packaged_binary(
    app: &AppHandle,
    base: &str,
    environment_key: &str,
) -> Result<PathBuf, String> {
    let plain = executable_name(base);
    let target = executable_name(&format!("{base}-{}", target_triple()));
    let architecture = executable_name(&format!("{base}-{}", std::env::consts::ARCH));
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os(environment_key).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for directory in [
            resource_dir.clone(),
            resource_dir.join(base),
            resource_dir.join("binaries"),
        ] {
            candidates.extend([
                directory.join(&target),
                directory.join(&architecture),
                directory.join(&plain),
            ]);
        }
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(directory) = current_exe.parent() {
            candidates.extend([
                directory.join(&target),
                directory.join(&architecture),
                directory.join(&plain),
            ]);
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("The packaged {base} native runtime is missing"))
}

fn spawn_keyfinder(
    path: &Path,
    generation: u64,
    shared: Arc<AnalysisShared>,
) -> Result<EngineConnection, String> {
    let mut child = Command::new(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start KeyFinder: {error}"))?;
    let stdin = Arc::new(Mutex::new(
        child.stdin.take().ok_or("KeyFinder stdin is unavailable")?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or("KeyFinder stdout is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("KeyFinder stderr is unavailable")?;
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => route_engine_message(&line, generation, &reader_pending, &shared),
                Err(error) => {
                    fail_all(
                        &reader_pending,
                        &format!("Could not read KeyFinder output: {error}"),
                    );
                    break;
                }
            }
        }
        fail_all(&reader_pending, "KeyFinder exited");
        fail_generation_jobs(&shared, generation);
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut sink = String::new();
        while reader.read_line(&mut sink).unwrap_or(0) > 0 {
            sink.clear();
        }
    });
    Ok(EngineConnection {
        generation,
        child,
        stdin,
        pending,
    })
}

fn route_engine_message(
    raw: &str,
    generation: u64,
    pending: &Arc<Mutex<HashMap<String, PendingSender>>>,
    shared: &Arc<AnalysisShared>,
) {
    let Ok(mut message) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    if let Some(request_id) = message
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        let sender = pending
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&request_id));
        if let Some(sender) = sender {
            let _ = sender.send(decode_envelope(&message, &request_id));
        }
        return;
    }
    let Some(owner) = message
        .get("owner")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let active = shared
        .jobs_by_owner
        .lock()
        .ok()
        .and_then(|jobs| jobs.get(&owner).cloned());
    let Some(active) = active.filter(|job| job.generation == generation) else {
        return;
    };
    if let Some(object) = message.as_object_mut() {
        object.insert("jobId".into(), Value::String(active.public_job_id.clone()));
    }
    let finished = message.get("event").and_then(Value::as_str) == Some("jobFinished");
    let _ = shared.app.emit("muro://keyfinder-analysis", message);
    if finished {
        if let Ok(mut jobs) = shared.jobs_by_owner.lock() {
            jobs.remove(&owner);
        }
        if let Ok(mut raw_jobs) = shared.raw_jobs.lock() {
            raw_jobs.remove(&active.public_job_id);
        }
    }
}

fn decode_envelope(message: &Value, request_id: &str) -> Result<Value, String> {
    if message.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err("KeyFinder returned an unsupported protocol version".into());
    }
    if message.get("requestId").and_then(Value::as_str) != Some(request_id) {
        return Err("KeyFinder returned a mismatched request ID".into());
    }
    match (message.get("result"), message.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => Err(format!(
            "{}: {}",
            error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("NATIVE_ERROR"),
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The native engine reported an error")
        )),
        _ => Err("KeyFinder returned an invalid response envelope".into()),
    }
}

fn remove_pending(pending: &Arc<Mutex<HashMap<String, PendingSender>>>, request_id: &str) {
    if let Ok(mut map) = pending.lock() {
        map.remove(request_id);
    }
}

fn fail_all(pending: &Arc<Mutex<HashMap<String, PendingSender>>>, message: &str) {
    let senders = pending
        .lock()
        .map(|mut map| map.drain().map(|(_, sender)| sender).collect::<Vec<_>>())
        .unwrap_or_default();
    for sender in senders {
        let _ = sender.send(Err(message.to_owned()));
    }
}

fn fail_generation_jobs(shared: &AnalysisShared, generation: u64) {
    let jobs = shared
        .jobs_by_owner
        .lock()
        .map(|mut active| {
            let owners = active
                .iter()
                .filter(|(_, job)| job.generation == generation)
                .map(|(owner, _)| owner.clone())
                .collect::<Vec<_>>();
            owners
                .into_iter()
                .filter_map(|owner| active.remove(&owner))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for job in jobs {
        let total = job.tracks.len();
        for track in job.tracks {
            let mut failed = track;
            if let Some(object) = failed.as_object_mut() {
                object.insert("status".into(), Value::String("failed".into()));
                object.insert(
                    "error".into(),
                    json!({
                        "code": "ENGINE_EXITED", "stage": "analysis",
                        "message": "The analysis engine stopped. This batch can be retried."
                    }),
                );
            }
            let _ = shared.app.emit(
                "muro://keyfinder-analysis",
                json!({
                    "version": 1, "event": "trackUpdated", "jobId": job.public_job_id,
                    "owner": job.owner, "sequence": 0, "payload": { "track": failed }
                }),
            );
        }
        let _ = shared.app.emit(
            "muro://keyfinder-analysis",
            json!({
                "version": 1, "event": "jobFinished", "jobId": job.public_job_id,
                "owner": job.owner, "sequence": 0,
                "payload": { "cancelled": false, "completed": total, "total": total }
            }),
        );
        if let Ok(mut raw_jobs) = shared.raw_jobs.lock() {
            raw_jobs.remove(&job.public_job_id);
        }
    }
}

fn clean_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn to_engine_track(raw: &Value) -> Value {
    let source_path = clean_text(raw.get("sourcePath"));
    let id = clean_text(raw.get("id"));
    let title = clean_text(raw.get("title"));
    let filename = Path::new(&source_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(if title.is_empty() { &id } else { &title })
        .to_owned();
    json!({
        "id": id, "path": source_path, "filename": filename,
        "title": title, "artist": clean_text(raw.get("artist")),
        "album": clean_text(raw.get("album")), "comment": clean_text(raw.get("comment")),
        "grouping": "", "initialKey": clean_text(raw.get("key")),
        "initialBpm": finite_number(raw.get("bpm")),
        "durationMs": finite_number(raw.get("durationSeconds")).map(|seconds| (seconds * 1000.0).round() as i64),
        "detectedKey": null, "detectedCode": "", "detectedBpm": null,
        "status": "ready", "error": null
    })
}

fn output_mode(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("prepend") => "prepend",
        Some("append") => "append",
        Some("overwrite") => "overwrite",
        _ => "none",
    }
}

fn normalize_analysis_settings(requested: Option<&Value>, write_authorization: bool) -> Value {
    let outputs = requested.and_then(|value| value.get("outputs"));
    let comment = output_mode(outputs.and_then(|value| value.get("comment")));
    let grouping = output_mode(outputs.and_then(|value| value.get("grouping")));
    let initial_key = output_mode(outputs.and_then(|value| value.get("initialKey")));
    let bpm = if outputs
        .and_then(|value| value.get("bpm"))
        .and_then(Value::as_str)
        == Some("overwrite")
    {
        "overwrite"
    } else {
        "none"
    };
    let automatic_writes = write_authorization
        && [comment, grouping, initial_key, bpm]
            .iter()
            .any(|mode| *mode != "none");
    let delimiter = requested
        .and_then(|value| value.get("delimiter"))
        .and_then(Value::as_str)
        .unwrap_or(" - ")
        .chars()
        .take(32)
        .collect::<String>();
    let notation = match requested
        .and_then(|value| value.get("notation"))
        .and_then(Value::as_str)
    {
        Some(value @ ("standard" | "custom" | "combined" | "djCombined")) => value,
        _ => "custom",
    };
    let requested_codes = requested
        .and_then(|value| value.get("customCodes"))
        .and_then(Value::as_array);
    let custom_codes = CAMELOT_CODES
        .iter()
        .enumerate()
        .map(|(index, fallback)| {
            requested_codes
                .and_then(|codes| codes.get(index))
                .and_then(Value::as_str)
                .unwrap_or(fallback)
                .chars()
                .take(32)
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": 2, "parallel": false, "bpmAnalysisEnabled": true,
        "maxDurationMinutes": 3600, "skipExisting": false, "automaticWrites": automatic_writes,
        "extensionFilterEnabled": false, "extensions": [],
        "outputs": { "title": "none", "artist": "none", "album": "none", "comment": comment,
            "grouping": grouping, "initialKey": initial_key, "bpm": bpm, "filename": "none" },
        "delimiter": delimiter, "notation": notation, "customCodes": custom_codes,
        "libraryPaths": { "itunes": "", "traktor": "", "serato": "" }
    })
}

#[tauri::command]
pub async fn keyfinder_health(
    service: State<'_, NativeAnalysisService>,
) -> Result<KeyFinderHealth, String> {
    let value = service
        .call("health", json!({}), Duration::from_secs(5))
        .await?;
    serde_json::from_value(value)
        .map_err(|error| format!("KeyFinder health response is invalid: {error}"))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_track_analysis(
    tracks: Value,
    settings: Option<Value>,
    write_authorization: Option<bool>,
    service: State<'_, NativeAnalysisService>,
) -> Result<Value, String> {
    let tracks = tracks
        .as_array()
        .ok_or("tracks must be an array")?
        .iter()
        .map(to_engine_track)
        .collect::<Vec<_>>();
    let public_job_id = format!("job-{}", service.next_job.fetch_add(1, Ordering::Relaxed));
    let owner = format!("muro-analysis-{public_job_id}");
    let connection = service.connection()?;
    service
        .shared
        .jobs_by_owner
        .lock()
        .map_err(|_| "Analysis job registry is unavailable")?
        .insert(
            owner.clone(),
            ActiveJob {
                generation: connection.generation,
                public_job_id: public_job_id.clone(),
                owner: owner.clone(),
                tracks: tracks.clone(),
            },
        );
    let normalized =
        normalize_analysis_settings(settings.as_ref(), write_authorization.unwrap_or(false));
    let result = service.call_on(&connection, "startAnalysis", json!({
        "owner": owner, "tracks": tracks, "settings": normalized,
        "writeAuthorization": normalized.get("automaticWrites").and_then(Value::as_bool).unwrap_or(false)
    }), Duration::from_secs(60)).await;
    let mut result = match result {
        Ok(value) => value,
        Err(error) => {
            if let Ok(mut jobs) = service.shared.jobs_by_owner.lock() {
                jobs.remove(&owner);
            }
            return Err(error);
        }
    };
    if let Some(raw_job_id) = result
        .get("jobId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        if service
            .shared
            .jobs_by_owner
            .lock()
            .map(|jobs| jobs.contains_key(&owner))
            .unwrap_or(false)
        {
            service
                .shared
                .raw_jobs
                .lock()
                .map_err(|_| "Analysis job registry is unavailable")?
                .insert(public_job_id.clone(), (connection.generation, raw_job_id));
        }
    }
    if let Some(object) = result.as_object_mut() {
        object.insert("jobId".into(), Value::String(public_job_id));
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_track_analysis(
    job_id: String,
    service: State<'_, NativeAnalysisService>,
) -> Result<Value, String> {
    let job = service
        .shared
        .raw_jobs
        .lock()
        .map_err(|_| "Analysis job registry is unavailable")?
        .get(&job_id)
        .cloned();
    let Some((generation, raw_job_id)) = job else {
        return Ok(json!({ "cancelled": false }));
    };
    let connection = service.connection()?;
    if connection.generation != generation {
        return Ok(json!({ "cancelled": false }));
    }
    service
        .call_on(
            &connection,
            "cancelJob",
            json!({ "jobId": raw_job_id }),
            Duration::from_secs(5),
        )
        .await
}

#[tauri::command]
pub fn recycle_keyfinder(service: State<'_, NativeAnalysisService>) -> Result<Value, String> {
    if service
        .shared
        .jobs_by_owner
        .lock()
        .map_err(|_| "Analysis job registry is unavailable")?
        .len()
        > 0
    {
        return Ok(json!({ "recycled": false }));
    }
    let mut slot = service
        .engine
        .lock()
        .map_err(|_| "KeyFinder process lock is unavailable")?;
    let Some(mut connection) = slot.take() else {
        return Ok(json!({ "recycled": false }));
    };
    let _ = connection.child.kill();
    let _ = connection.child.wait();
    Ok(json!({ "recycled": true }))
}

#[derive(Debug)]
struct Fingerprint {
    duration: i64,
    value: String,
}

fn fingerprint_audio(executable: &Path, source_path: &Path) -> Result<Fingerprint, String> {
    if !source_path.is_absolute() || !source_path.is_file() {
        return Err("The track audio file is unavailable".into());
    }
    let display_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio file");
    let mut child = Command::new(executable)
        .args(["-json", "-length", "120"])
        .arg(source_path)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error| format!("Could not fingerprint {display_name}. The fpcalc runtime is missing or unavailable. {error}"))?;
    let stdout = child.stdout.take().ok_or("fpcalc stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("fpcalc stderr is unavailable")?;
    let stdout_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(2 * 1024 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(180);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Could not fingerprint {display_name}. fpcalc timed out"
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(format!(
            "Could not fingerprint {display_name}. {}",
            if detail.is_empty() {
                "fpcalc failed"
            } else {
                &detail
            }
        ));
    }
    let payload: Value = serde_json::from_slice(&stdout)
        .map_err(|error| format!("fpcalc returned invalid JSON: {error}"))?;
    let duration = payload
        .get("duration")
        .and_then(Value::as_f64)
        .map(|value| value.round() as i64)
        .unwrap_or(0);
    let value = clean_text(payload.get("fingerprint"));
    if duration <= 0 || value.is_empty() {
        return Err("fpcalc returned an empty fingerprint".into());
    }
    Ok(Fingerprint { duration, value })
}

fn unix_seconds() -> Result<i64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64)
}

fn modified_millis(metadata: &fs::Metadata) -> Result<f64, String> {
    Ok(metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs_f64()
        * 1000.0)
}

fn valid_client_key(value: &str) -> bool {
    (6..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Debug)]
struct TrackIdentity {
    id: String,
    source_path: String,
    album: String,
}

fn open_track(
    db_path: &str,
    track_id: &str,
) -> Result<(Connection, TrackIdentity, PathBuf), String> {
    if !Path::new(db_path).is_file() {
        return Err("Track was not found in the library".into());
    }
    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    super::database::ensure_schema(&conn)?;
    let track = conn
        .query_row(
            "SELECT id,source_path,album FROM tracks WHERE id=?1",
            [track_id.trim()],
            |row| {
                Ok(TrackIdentity {
                    id: row.get(0)?,
                    source_path: row.get(1)?,
                    album: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("Track was not found in the library")?;
    let stored_root = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key='library_root'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let root = super::database::normalize_library_root(stored_root.as_deref());
    let source = super::database::resolve_stored_track_path(&track.source_path, root.as_deref())?;
    if !source.is_absolute() {
        return Err("Choose the music library folder to identify this track".into());
    }
    let source = source
        .canonicalize()
        .map_err(|_| "The track audio file is unavailable".to_string())?;
    if !source.is_file() {
        return Err("The track audio file is unavailable".into());
    }
    Ok((conn, track, source))
}

#[derive(Debug)]
struct CachedFingerprint {
    source_mtime_ms: f64,
    source_size: u64,
    duration: i64,
    fingerprint: String,
    result_json: Option<String>,
    looked_up_at: Option<i64>,
}

fn cached_fingerprint(
    conn: &Connection,
    track_id: &str,
) -> Result<Option<CachedFingerprint>, String> {
    conn.query_row("SELECT source_mtime_ms,source_size,duration_seconds,fingerprint,result_json,looked_up_at FROM acoustid_fingerprints WHERE track_id=?1", [track_id], |row| Ok(CachedFingerprint {
        source_mtime_ms: row.get(0)?, source_size: row.get::<_, i64>(1)?.max(0) as u64, duration: row.get(2)?, fingerprint: row.get(3)?, result_json: row.get(4)?, looked_up_at: row.get(5)?,
    })).optional().map_err(|error| error.to_string())
}

async fn acoustid_lookup(
    service: &NativeAnalysisService,
    client_key: &str,
    fingerprint: &Fingerprint,
) -> Result<Value, String> {
    let mut next = service.acoustid_queue.lock().await;
    if *next > Instant::now() {
        tokio::time::sleep_until(tokio::time::Instant::from_std(*next)).await;
    }
    *next = Instant::now() + Duration::from_millis(350);
    let fields = [
        ("client", client_key.to_owned()),
        ("duration", fingerprint.duration.to_string()),
        ("fingerprint", fingerprint.value.clone()),
        ("meta", "recordings releases releasegroups".into()),
        ("format", "json".into()),
    ];
    let response = service
        .client
        .post(ACOUSTID_LOOKUP_URL)
        .header("Accept", "application/json")
        .form(&fields)
        .send()
        .await
        .map_err(|error| format!("AcoustID is temporarily unreachable. {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the AcoustID response: {error}"))?;
    if bytes.len() > MAX_ACOUSTID_RESPONSE_BYTES {
        return Err("AcoustID returned an unexpectedly large response".into());
    }
    let payload = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(service_error_message(
            &payload,
            &format!("AcoustID lookup failed ({})", status.as_u16()),
        ));
    }
    Ok(payload)
}

fn service_error_message(payload: &Value, fallback: &str) -> String {
    let message = clean_text(payload.get("error").and_then(|error| error.get("message")));
    if message.to_ascii_lowercase().contains("invalid api key") {
        "AcoustID rejected this application API key. The personal user API key from your profile cannot be used for lookups; create or copy a key from My Applications.".into()
    } else if message.is_empty() {
        fallback.into()
    } else {
        message
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn identify_track_acoustid(
    db_path: String,
    track_id: String,
    client_key: String,
    force: Option<bool>,
    service: State<'_, NativeAnalysisService>,
) -> Result<AcoustIdIdentificationResult, String> {
    let client_key = client_key.trim().to_owned();
    if !valid_client_key(&client_key) {
        return Err("Add a valid AcoustID application key in Settings first".into());
    }
    let (conn, track, source_path) = open_track(&db_path, &track_id)?;
    let metadata = source_path.metadata().map_err(|error| error.to_string())?;
    let source_mtime_ms = modified_millis(&metadata)?;
    let source_size = metadata.len();
    let cached = cached_fingerprint(&conn, &track.id)?;
    let source_matches = cached.as_ref().is_some_and(|cached| {
        cached.source_mtime_ms == source_mtime_ms && cached.source_size == source_size
    });
    let now = unix_seconds()?;
    let cache_fresh = source_matches
        && cached
            .as_ref()
            .and_then(|cached| cached.result_json.as_ref())
            .is_some()
        && cached
            .as_ref()
            .and_then(|cached| cached.looked_up_at)
            .unwrap_or(0)
            >= now - LOOKUP_CACHE_TTL_SECONDS;
    if !force.unwrap_or(false) && cache_fresh {
        let cached = cached.expect("fresh cache exists");
        let candidates = serde_json::from_str(cached.result_json.as_deref().unwrap_or("[]"))
            .map_err(|error| format!("The AcoustID cache is invalid: {error}"))?;
        return Ok(AcoustIdIdentificationResult {
            track_id: track.id,
            cached: true,
            duration: cached.duration,
            candidates,
        });
    }
    let fingerprint = if source_matches
        && cached
            .as_ref()
            .is_some_and(|cached| !cached.fingerprint.is_empty())
    {
        let cached = cached.as_ref().expect("matching cache exists");
        Fingerprint {
            duration: cached.duration,
            value: cached.fingerprint.clone(),
        }
    } else {
        let executable = service.fpcalc_path.as_ref().map_err(Clone::clone)?.clone();
        let source = source_path.clone();
        tauri::async_runtime::spawn_blocking(move || fingerprint_audio(&executable, &source))
            .await
            .map_err(|error| error.to_string())??
    };
    conn.execute("INSERT INTO acoustid_fingerprints(track_id,source_mtime_ms,source_size,duration_seconds,fingerprint,result_json,looked_up_at,updated_at)
        VALUES(?1,?2,?3,?4,?5,NULL,NULL,?6) ON CONFLICT(track_id) DO UPDATE SET
        source_mtime_ms=excluded.source_mtime_ms,source_size=excluded.source_size,duration_seconds=excluded.duration_seconds,
        fingerprint=excluded.fingerprint,result_json=CASE WHEN acoustid_fingerprints.source_mtime_ms=excluded.source_mtime_ms AND acoustid_fingerprints.source_size=excluded.source_size THEN acoustid_fingerprints.result_json ELSE NULL END,
        looked_up_at=CASE WHEN acoustid_fingerprints.source_mtime_ms=excluded.source_mtime_ms AND acoustid_fingerprints.source_size=excluded.source_size THEN acoustid_fingerprints.looked_up_at ELSE NULL END,updated_at=excluded.updated_at",
        params![track.id, source_mtime_ms, source_size as i64, fingerprint.duration, fingerprint.value, now]).map_err(|error| error.to_string())?;
    let payload = acoustid_lookup(&service, &client_key, &fingerprint).await?;
    let candidates = parse_acoustid_candidates(&payload, &track.album)?;
    let result_json = serde_json::to_string(&candidates).map_err(|error| error.to_string())?;
    conn.execute("UPDATE acoustid_fingerprints SET result_json=?1,looked_up_at=?2,updated_at=?2 WHERE track_id=?3", params![result_json, now, track.id]).map_err(|error| error.to_string())?;
    Ok(AcoustIdIdentificationResult {
        track_id: track.id,
        cached: false,
        duration: fingerprint.duration,
        candidates,
    })
}

fn is_uuid_text(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn clean_id(value: Option<&Value>) -> Option<String> {
    let value = clean_text(value);
    is_uuid_text(&value).then_some(value)
}

fn first_field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| value.get(*name))
}

fn normalize_artist_credits(value: Option<&Value>) -> Vec<ArtistCredit> {
    let mut credits = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|raw| {
            let canonical = clean_text(
                raw.get("artist")
                    .and_then(|artist| artist.get("name"))
                    .or_else(|| first_field(raw, &["canonicalName", "canonical_name", "name"])),
            );
            let credited = clean_text(first_field(raw, &["creditedName", "credited_name", "name"]));
            let name = if canonical.is_empty() {
                credited.clone()
            } else {
                canonical
            };
            if name.is_empty() {
                return None;
            }
            let credited_name = if credited.is_empty() {
                name.clone()
            } else {
                credited
            };
            let music_brainz_id = clean_id(
                first_field(
                    raw,
                    &[
                        "musicbrainzId",
                        "musicBrainzId",
                        "musicbrainz_id",
                        "artistId",
                        "artist_id",
                        "id",
                    ],
                )
                .or_else(|| raw.get("artist").and_then(|artist| artist.get("id"))),
            );
            let join_phrase = first_field(raw, &["joinPhrase", "join_phrase", "joinphrase"])
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some((
                ArtistCredit {
                    name,
                    credited_name,
                    join_phrase: String::new(),
                    music_brainz_id,
                },
                join_phrase,
            ))
        })
        .collect::<Vec<_>>();
    let length = credits.len();
    credits
        .iter_mut()
        .enumerate()
        .map(|(index, (credit, requested_join))| {
            credit.join_phrase = requested_join.clone().unwrap_or_else(|| {
                if index + 1 < length {
                    ", ".into()
                } else {
                    String::new()
                }
            });
            credit.clone()
        })
        .collect()
}

fn display_credits(credits: &[ArtistCredit]) -> String {
    credits
        .iter()
        .map(|credit| format!("{}{}", credit.credited_name, credit.join_phrase))
        .collect()
}

fn embedded_release_group(release: &Value) -> Option<&Value> {
    first_field(release, &["releasegroup", "releaseGroup", "release-group"])
}

fn candidate_from_release(
    result: &Value,
    recording: &Value,
    release: Option<&Value>,
    release_group: Option<&Value>,
    track_album: &str,
) -> Option<AcoustIdCandidate> {
    let recording_id = clean_id(recording.get("id"))?;
    let release_id = release.and_then(|value| clean_id(value.get("id")));
    let nested_group = release.and_then(embedded_release_group);
    let release_group_id = clean_id(
        nested_group
            .and_then(|value| value.get("id"))
            .or_else(|| release_group.and_then(|value| value.get("id"))),
    );
    let title = clean_text(recording.get("title"));
    let artist_credits = normalize_artist_credits(recording.get("artists"));
    let artist = display_credits(&artist_credits);
    let album = clean_text(
        release
            .and_then(|value| value.get("title"))
            .or_else(|| release_group.and_then(|value| value.get("title"))),
    );
    let mut album_artist_credits = release
        .map(|value| normalize_artist_credits(value.get("artists")))
        .unwrap_or_default();
    if album_artist_credits.is_empty() {
        album_artist_credits =
            normalize_artist_credits(nested_group.and_then(|value| value.get("artists")));
    }
    if album_artist_credits.is_empty() {
        album_artist_credits =
            normalize_artist_credits(release_group.and_then(|value| value.get("artists")));
    }
    if album_artist_credits.is_empty() {
        album_artist_credits = artist_credits.clone();
    }
    let album_artist = {
        let value = display_credits(&album_artist_credits);
        if value.is_empty() {
            artist.clone()
        } else {
            value
        }
    };
    if title.is_empty() && artist.is_empty() {
        return None;
    }
    let acoustid_id = clean_text(result.get("id"));
    let score = result
        .get("score")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    let date = clean_text(
        release
            .and_then(|value| value.get("date"))
            .or_else(|| release_group.and_then(|value| value.get("firstreleasedate"))),
    );
    let year = date
        .get(..4)
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|year| (1000..=9999).contains(year));
    let country = release.and_then(|value| nonempty(value.get("country")));
    let status = release.and_then(|value| nonempty(value.get("status")));
    Some(AcoustIdCandidate {
        id: format!(
            "{acoustid_id}:{recording_id}:{}",
            release_id
                .as_deref()
                .or(release_group_id.as_deref())
                .unwrap_or("recording")
        ),
        acoustid_id,
        score,
        recording_id,
        release_id,
        release_group_id,
        title,
        artist,
        artist_credits,
        album_match: !album.is_empty() && album.to_lowercase() == track_album.trim().to_lowercase(),
        album,
        album_artist,
        album_artist_credits,
        year,
        country,
        status,
        genre: None,
    })
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    let text = clean_text(value);
    (!text.is_empty()).then_some(text)
}

pub fn parse_acoustid_candidates(
    payload: &Value,
    track_album: &str,
) -> Result<Vec<AcoustIdCandidate>, String> {
    if payload.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(service_error_message(
            payload,
            "AcoustID returned an invalid response",
        ));
    }
    let mut candidates = Vec::new();
    for result in payload
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for recording in result
            .get("recordings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let releases = recording
                .get("releases")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let groups = recording
                .get("releasegroups")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if !releases.is_empty() {
                for release in releases {
                    let nested_id =
                        clean_id(embedded_release_group(release).and_then(|group| group.get("id")));
                    let matched = nested_id.as_deref().and_then(|id| {
                        groups
                            .iter()
                            .find(|group| clean_id(group.get("id")).as_deref() == Some(id))
                    });
                    if let Some(candidate) = candidate_from_release(
                        result,
                        recording,
                        Some(release),
                        matched,
                        track_album,
                    ) {
                        candidates.push(candidate);
                    }
                }
            } else if !groups.is_empty() {
                for group in groups {
                    if let Some(candidate) =
                        candidate_from_release(result, recording, None, Some(group), track_album)
                    {
                        candidates.push(candidate);
                    }
                }
            } else if let Some(candidate) =
                candidate_from_release(result, recording, None, None, track_album)
            {
                candidates.push(candidate);
            }
        }
    }
    let mut unique = HashMap::<String, AcoustIdCandidate>::new();
    for candidate in candidates {
        let key = format!(
            "{}:{}",
            candidate.recording_id,
            candidate
                .release_id
                .as_deref()
                .or(candidate.release_group_id.as_deref())
                .unwrap_or_default()
        );
        if unique
            .get(&key)
            .is_none_or(|existing| candidate.score > existing.score)
        {
            unique.insert(key, candidate);
        }
    }
    let mut candidates = unique.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .album_match
            .cmp(&left.album_match)
            .then_with(|| right.score.total_cmp(&left.score))
            .then_with(|| left.title.cmp(&right.title))
    });
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_require_explicit_authorization_and_safe_fields() {
        let requested = json!({ "outputs": { "title": "overwrite", "comment": "append", "initialKey": "overwrite", "bpm": "overwrite", "filename": "overwrite" } });
        let denied = normalize_analysis_settings(Some(&requested), false);
        assert_eq!(denied["automaticWrites"], false);
        let allowed = normalize_analysis_settings(Some(&requested), true);
        assert_eq!(allowed["automaticWrites"], true);
        assert_eq!(allowed["outputs"]["title"], "none");
        assert_eq!(allowed["outputs"]["filename"], "none");
    }

    #[test]
    fn parses_and_prefers_album_matching_acoustid_candidates() {
        let payload = json!({ "status": "ok", "results": [{
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "score": 0.9,
            "recordings": [{ "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "title": "Song",
                "artists": [{ "name": "Main", "joinphrase": " feat. " }, { "name": "Guest" }],
                "releases": [{ "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "title": "Target", "date": "2024-01-02",
                    "releasegroup": { "id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } }]
            }]
        }] });
        let candidates =
            parse_acoustid_candidates(&payload, "target").expect("payload should parse");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].artist, "Main feat. Guest");
        assert!(candidates[0].album_match);
        assert_eq!(candidates[0].year, Some(2024));
    }

    #[test]
    fn rejects_personal_or_malformed_keys_before_network_use() {
        assert!(valid_client_key("client123"));
        assert!(!valid_client_key(""));
        assert!(!valid_client_key("contains a space"));
    }

    #[test]
    fn decodes_protocol_errors_without_accepting_mixed_envelopes() {
        let mixed = json!({ "version": 1, "requestId": "r1", "result": {}, "error": { "code": "BAD", "message": "bad" } });
        assert_eq!(
            decode_envelope(&mixed, "r1").unwrap_err(),
            "KeyFinder returned an invalid response envelope"
        );
    }
}
