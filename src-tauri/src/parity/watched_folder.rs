//! Polling watched-folder service compatible with the Electron command/event contract.
//!
//! This intentionally uses only `std`: it is a portable fallback until a native
//! `notify` watcher is wired in. Existing files are snapshotted when watching starts;
//! `scan_watched_folder` is the explicit catch-up operation for files added while the
//! application was closed.

use crate::import::ImportedTrack;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use super::library_ops;

const SETTLE_DELAY: Duration = Duration::from_millis(1_500);
const MAX_SETTLE: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const AUDIO_EXTENSIONS: [&str; 10] = [
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "alac",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WatchedFolderStatus {
    pub enabled: bool,
    pub watching: Option<String>,
    pub pending: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WatchedFolderScanResult {
    pub imported: usize,
    pub scanned: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchedFolderImportEvent {
    track: ImportedTrack,
    source_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchedFolderErrorEvent {
    source_path: String,
    message: String,
}

#[derive(Debug, Default)]
struct ServiceState {
    enabled: bool,
    watching: Option<PathBuf>,
    db_path: Option<String>,
    pending: HashSet<String>,
}

impl ServiceState {
    fn public_status(&self) -> WatchedFolderStatus {
        WatchedFolderStatus {
            enabled: self.enabled,
            watching: self.watching.as_deref().map(path_string),
            pending: self.pending.len(),
        }
    }
}

#[derive(Debug, Default)]
struct ServiceInner {
    generation: AtomicU64,
    state: Mutex<ServiceState>,
}

/// Tauri-managed state. Register once with `app.manage(WatchedFolderService::new())`.
#[derive(Debug, Clone, Default)]
pub struct WatchedFolderService {
    inner: Arc<ServiceInner>,
}

impl WatchedFolderService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> WatchedFolderStatus {
        lock_state(&self.inner).public_status()
    }

    pub fn stop(&self) -> WatchedFolderStatus {
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        let mut state = lock_state(&self.inner);
        state.enabled = false;
        state.watching = None;
        state.pending.clear();
        state.public_status()
    }

    fn set_folder(
        &self,
        app: AppHandle,
        db_path: String,
        folder: Option<String>,
        enabled: bool,
    ) -> Result<WatchedFolderStatus, String> {
        let requested = folder.unwrap_or_default();
        let requested = requested.trim();
        let requested_path = if requested.is_empty() {
            None
        } else {
            let candidate = absolute_lexical(Path::new(requested));
            if !candidate.is_dir() {
                return Err("The watched folder is unavailable".to_string());
            }
            library_ops::configure_library_root(&db_path, Some(requested))?;
            Some(candidate)
        };

        let watching = if enabled { requested_path } else { None };

        {
            let state = lock_state(&self.inner);
            let unchanged_root = match (&state.watching, &watching) {
                (Some(current), Some(next)) => path_key(current) == path_key(next),
                (None, None) => true,
                _ => false,
            };
            if state.enabled == enabled
                && state.db_path.as_deref() == Some(db_path.as_str())
                && unchanged_root
            {
                return Ok(state.public_status());
            }
        }

        let generation = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;

        let status = {
            let mut state = lock_state(&self.inner);
            state.enabled = enabled;
            state.watching = watching.clone();
            state.db_path = Some(db_path.clone());
            state.pending.clear();
            state.public_status()
        };

        if let Some(root) = watching {
            let service = self.clone();
            thread::Builder::new()
                .name("muro-watched-folder".to_string())
                .spawn(move || service.run_polling_worker(app, db_path, root, generation))
                .map_err(|error| error.to_string())?;
        }
        Ok(status)
    }

    fn run_polling_worker(self, app: AppHandle, db_path: String, root: PathBuf, generation: u64) {
        let cache_dir = match app.path().app_cache_dir() {
            Ok(path) => path.join("covers"),
            Err(error) => {
                emit_error(&app, &root, error.to_string());
                return;
            }
        };
        let mut seen = match collect_audio_paths(&root) {
            Ok(paths) => paths
                .into_iter()
                .map(|path| path_key(&path))
                .collect::<HashSet<_>>(),
            Err(message) => {
                emit_error(&app, &root, message);
                HashSet::new()
            }
        };
        let started = Instant::now();
        let mut pending: HashMap<String, PendingFile> = HashMap::new();

        while self.is_current(generation, &root) {
            thread::sleep(POLL_INTERVAL);
            if !self.is_current(generation, &root) {
                break;
            }

            let paths = match collect_audio_paths(&root) {
                Ok(paths) => paths,
                Err(message) => {
                    emit_error(&app, &root, message);
                    continue;
                }
            };
            let current = paths
                .iter()
                .map(|path| (path_key(path), path.clone()))
                .collect::<HashMap<_, _>>();
            seen.retain(|key| current.contains_key(key));

            for (key, path) in &current {
                if !seen.contains(key) && !pending.contains_key(key) {
                    pending.insert(
                        key.clone(),
                        PendingFile::new(path.clone(), started.elapsed()),
                    );
                }
            }

            let now = started.elapsed();
            let mut ready = Vec::new();
            let mut abandoned = Vec::new();
            for (key, candidate) in &mut pending {
                match observe_file(&candidate.path) {
                    Some(observation) if candidate.observe(now, observation) => {
                        ready.push(key.clone());
                    }
                    Some(_) if candidate.expired(now) => abandoned.push(key.clone()),
                    None => abandoned.push(key.clone()),
                    _ => {}
                }
            }
            for key in abandoned {
                pending.remove(&key);
                seen.insert(key);
            }
            self.replace_pending(generation, pending.keys().cloned().collect());

            for key in ready {
                let Some(candidate) = pending.remove(&key) else {
                    continue;
                };
                if !self.is_current(generation, &root) {
                    break;
                }
                let source_path = path_string(&candidate.path);
                match library_ops::import_files(
                    vec![source_path.clone()],
                    &db_path,
                    &cache_dir,
                    None,
                ) {
                    Ok(result) => {
                        for track in result.imported {
                            let _ = app.emit(
                                "muro://watched-folder-import",
                                WatchedFolderImportEvent {
                                    track,
                                    source_path: source_path.clone(),
                                },
                            );
                        }
                        for failure in result.failures {
                            emit_error(&app, Path::new(&failure.path), failure.message);
                        }
                    }
                    Err(message) => emit_error(&app, &candidate.path, message),
                }
                seen.insert(key);
            }
            self.replace_pending(generation, pending.keys().cloned().collect());
        }
        self.replace_pending(generation, HashSet::new());
    }

    fn is_current(&self, generation: u64, root: &Path) -> bool {
        if self.inner.generation.load(Ordering::Acquire) != generation {
            return false;
        }
        let state = lock_state(&self.inner);
        state.enabled
            && state
                .watching
                .as_deref()
                .map(|current| path_key(current) == path_key(root))
                .unwrap_or(false)
    }

    fn replace_pending(&self, generation: u64, pending: HashSet<String>) {
        if self.inner.generation.load(Ordering::Acquire) != generation {
            return;
        }
        lock_state(&self.inner).pending = pending;
    }
}

impl Drop for WatchedFolderService {
    fn drop(&mut self) {
        // Only the final state owner cancels the worker. Temporary command/thread
        // clones must not stop a live watcher when they leave scope.
        if Arc::strong_count(&self.inner) == 1 {
            self.inner.generation.fetch_add(1, Ordering::AcqRel);
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_watched_folder(
    app: AppHandle,
    service: State<'_, WatchedFolderService>,
    db_path: String,
    folder: Option<String>,
    is_enabled: bool,
) -> Result<WatchedFolderStatus, String> {
    service.set_folder(app, db_path, folder, is_enabled)
}

#[tauri::command(rename_all = "camelCase")]
pub fn scan_watched_folder(
    app: AppHandle,
    service: State<'_, WatchedFolderService>,
    db_path: String,
    folder: Option<String>,
) -> Result<WatchedFolderScanResult, String> {
    let requested = folder.unwrap_or_default();
    let root = if requested.trim().is_empty() {
        lock_state(&service.inner).watching.clone()
    } else {
        Some(absolute_lexical(Path::new(requested.trim())))
    };
    let Some(root) = root else {
        return Ok(WatchedFolderScanResult {
            imported: 0,
            scanned: 0,
        });
    };
    if !root.is_dir() {
        return Err("The watched folder is unavailable".to_string());
    }
    let root_string = path_string(&root);
    library_ops::configure_library_root(&db_path, Some(&root_string))?;
    let paths = collect_audio_paths(&root)?;
    let scanned = paths.len();
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("covers");
    let mut imported = 0;

    for path in paths {
        let source_path = path_string(&path);
        match library_ops::import_files(vec![source_path.clone()], &db_path, &cache_dir, None) {
            Ok(result) => {
                imported += result.imported.len();
                for track in result.imported {
                    let _ = app.emit(
                        "muro://watched-folder-import",
                        WatchedFolderImportEvent {
                            track,
                            source_path: source_path.clone(),
                        },
                    );
                }
                for failure in result.failures {
                    eprintln!(
                        "Watched-folder scan failed for {}: {}",
                        failure.path, failure.message
                    );
                }
            }
            Err(error) => eprintln!("Watched-folder scan failed for {source_path}: {error}"),
        }
    }
    Ok(WatchedFolderScanResult { imported, scanned })
}

#[tauri::command]
pub fn watched_folder_status(service: State<'_, WatchedFolderService>) -> WatchedFolderStatus {
    service.status()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileObservation {
    size: u64,
    modified_nanos: u128,
}

#[derive(Debug)]
struct PendingFile {
    path: PathBuf,
    first_seen: Duration,
    last_observation: Option<FileObservation>,
    stable_since: Option<Duration>,
}

impl PendingFile {
    fn new(path: PathBuf, now: Duration) -> Self {
        Self {
            path,
            first_seen: now,
            last_observation: None,
            stable_since: None,
        }
    }

    fn observe(&mut self, now: Duration, observation: FileObservation) -> bool {
        if self.last_observation == Some(observation) && observation.size > 0 {
            let stable_since = *self.stable_since.get_or_insert(now);
            if now.saturating_sub(stable_since) >= SETTLE_DELAY {
                return true;
            }
        } else {
            self.last_observation = Some(observation);
            self.stable_since = None;
        }
        false
    }

    fn expired(&self, now: Duration) -> bool {
        now.saturating_sub(self.first_seen) >= MAX_SETTLE
    }
}

fn observe_file(path: &Path) -> Option<FileObservation> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(FileObservation {
        size: metadata.len(),
        modified_nanos: system_time_nanos(metadata.modified().ok()?),
    })
}

fn system_time_nanos(value: SystemTime) -> u128 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn collect_audio_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_audio_path(root, &mut files)?;
    files.sort_by_key(|path| path_key(path));
    files.dedup_by(|left, right| path_key(left) == path_key(right));
    Ok(files)
}

fn collect_audio_path(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            collect_audio_path(&entry.map_err(|error| error.to_string())?.path(), files)?;
        }
    } else if is_audio_path(path) {
        files.push(absolute_lexical(path));
    }
    Ok(())
}

fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| AUDIO_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn emit_error(app: &AppHandle, path: &Path, message: String) {
    let _ = app.emit(
        "muro://watched-folder-error",
        WatchedFolderErrorEvent {
            source_path: path_string(path),
            message,
        },
    );
}

fn lock_state(inner: &ServiceInner) -> std::sync::MutexGuard<'_, ServiceState> {
    inner
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn path_key(path: &Path) -> String {
    let value = path_string(&absolute_lexical(path)).replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn absolute_lexical(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_keys_dedupe_platform_equivalent_paths() {
        let first = absolute_lexical(Path::new("music/../music/Track.MP3"));
        let second = absolute_lexical(Path::new("music/Track.MP3"));
        assert_eq!(path_key(&first), path_key(&second));
        if cfg!(windows) {
            assert_eq!(
                path_key(Path::new("C:/Music/A.mp3")),
                path_key(Path::new("c:/music/a.mp3"))
            );
        }
    }

    #[test]
    fn file_must_remain_unchanged_for_full_settle_delay() {
        let mut pending = PendingFile::new(PathBuf::from("song.mp3"), Duration::ZERO);
        let first = FileObservation {
            size: 10,
            modified_nanos: 1,
        };
        assert!(!pending.observe(Duration::ZERO, first));
        assert!(!pending.observe(Duration::from_millis(500), first));
        assert!(!pending.observe(Duration::from_millis(1_500), first));
        assert!(pending.observe(Duration::from_millis(2_000), first));
    }

    #[test]
    fn growth_resets_stability_and_timeout_is_bounded() {
        let mut pending = PendingFile::new(PathBuf::from("song.mp3"), Duration::ZERO);
        let initial = FileObservation {
            size: 10,
            modified_nanos: 1,
        };
        let grown = FileObservation {
            size: 20,
            modified_nanos: 2,
        };
        assert!(!pending.observe(Duration::ZERO, initial));
        assert!(!pending.observe(Duration::from_millis(500), initial));
        assert!(!pending.observe(Duration::from_millis(1_500), grown));
        assert!(!pending.observe(Duration::from_millis(2_000), grown));
        assert!(pending.observe(Duration::from_millis(3_500), grown));
        assert!(!pending.expired(Duration::from_secs(119)));
        assert!(pending.expired(Duration::from_secs(120)));
    }

    #[test]
    fn public_status_reports_enabled_root_and_pending_count() {
        let mut state = ServiceState {
            enabled: true,
            watching: Some(PathBuf::from("C:/Music")),
            db_path: Some("library.db".to_string()),
            pending: HashSet::new(),
        };
        state.pending.insert("one".to_string());
        state.pending.insert("two".to_string());
        let status = state.public_status();
        assert!(status.enabled);
        assert_eq!(status.pending, 2);
        assert!(status.watching.is_some());
    }
}
