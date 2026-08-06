//! Native library export and source-linked playlist synchronization.
//!
//! The public commands intentionally mirror the Electron bridge while keeping
//! filesystem access, SQLite updates, and playlist watching in Rust.

use crate::import::ImportedTrack;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use unicode_normalization::UnicodeNormalization;
use url::Url;

use super::database::ensure_schema;
use super::library_ops::{
    self, normalize_library_root, resolve_stored_track_path, to_stored_track_path,
};

const LIBRARY_ROOT_KEY: &str = "library_root";
const WATCH_INTERVAL: Duration = Duration::from_millis(400);
const AUDIO_EXTENSIONS: [&str; 10] = [
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "alac",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItunesLibraryExportResult {
    pub destination_path: String,
    pub tracks_exported: usize,
    pub missing_tracks_referenced: usize,
    pub playlist_folders_exported: usize,
    pub playlists_exported: usize,
    pub playlist_entries_exported: usize,
    pub playlist_entries_skipped: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizedLibraryFailure {
    pub track_id: String,
    pub source_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizedLibraryExportResult {
    pub export_root: String,
    pub tracks: usize,
    pub files_copied: usize,
    pub tracks_failed: usize,
    pub playlists_exported: usize,
    pub playlist_entries_exported: usize,
    pub playlist_entries_missing: usize,
    pub library_switch_requested: bool,
    pub library_switched: bool,
    pub library_switch_error: Option<String>,
    pub failures: Vec<OrganizedLibraryFailure>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistSyncReason {
    Startup,
    Watch,
    Manual,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSourceSyncResult {
    pub playlist_id: String,
    pub name: String,
    pub source_path: String,
    pub track_ids: Vec<String>,
    pub imported: Vec<ImportedTrack>,
    pub added: usize,
    pub removed: usize,
    pub skipped: usize,
    pub changed: bool,
    pub source_sync_error: Option<String>,
    pub error_changed: bool,
    pub reason: PlaylistSyncReason,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlaylistSyncConfiguration {
    pub linked: usize,
    pub synced: usize,
    pub changed: usize,
}

#[derive(Debug, Clone)]
struct TrackExportRow {
    id: String,
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    genre_json: Option<String>,
    comment_json: Option<String>,
    year: Option<i64>,
    track_number: Option<i64>,
    track_total: Option<i64>,
    disc_number: Option<i64>,
    disc_total: Option<i64>,
    bpm: Option<f64>,
    rating: Option<f64>,
    source_path: PathBuf,
    duration_seconds: Option<f64>,
    bitrate_kbps: Option<i64>,
    sample_rate_hz: Option<i64>,
    file_size_bytes: Option<i64>,
    added_at: Option<i64>,
    updated_at: Option<i64>,
    last_played_at: Option<String>,
    play_count: Option<i64>,
    is_missing: bool,
}

#[derive(Debug, Clone)]
struct PlaylistFolderRow {
    id: String,
    name: String,
    parent_id: Option<String>,
}

#[derive(Debug, Clone)]
struct PlaylistRow {
    id: String,
    name: String,
    folder_id: Option<String>,
}

#[derive(Debug, Clone)]
struct OrganizedTrackRow {
    id: String,
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    disc_number: Option<i64>,
    disc_total: Option<i64>,
    duration_seconds: Option<f64>,
    stored_source_path: String,
}

#[derive(Debug, Clone)]
struct LinkedPlaylistRow {
    id: String,
    name: String,
    source_path: String,
    source_mtime_ms: Option<f64>,
    source_size: Option<u64>,
    source_sync_error: Option<String>,
}

#[derive(Debug, Default)]
struct PlaylistSyncInner {
    generation: AtomicU64,
    database: Mutex<Option<String>>,
    sync_lock: Mutex<()>,
}

/// Register with `app.manage(PlaylistSyncService::new())`.
#[derive(Debug, Clone, Default)]
pub struct PlaylistSyncService {
    inner: Arc<PlaylistSyncInner>,
}

impl PlaylistSyncService {
    pub fn new() -> Self {
        Self::default()
    }

    fn configure(
        &self,
        app: AppHandle,
        db_path: String,
    ) -> Result<PlaylistSyncConfiguration, String> {
        let generation = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *lock(&self.inner.database) = Some(db_path.clone());
        let cache_dir = cover_cache_dir(&app)?;
        let playlist_ids = linked_playlist_ids(&db_path)?;
        let mut synced = 0;
        let mut changed = 0;
        {
            let _guard = lock(&self.inner.sync_lock);
            for playlist_id in &playlist_ids {
                if let Some(result) = sync_linked_playlist(
                    &db_path,
                    playlist_id,
                    &cache_dir,
                    true,
                    PlaylistSyncReason::Startup,
                )? {
                    synced += 1;
                    changed += usize::from(result.changed);
                }
            }
        }
        let service = self.clone();
        thread::Builder::new()
            .name("muro-playlist-sync".to_string())
            .spawn(move || service.watch_sources(app, db_path, generation))
            .map_err(|error| error.to_string())?;
        Ok(PlaylistSyncConfiguration {
            linked: playlist_ids.len(),
            synced,
            changed,
        })
    }

    fn sync_manual(
        &self,
        app: &AppHandle,
        db_path: String,
        playlist_id: String,
    ) -> Result<Option<PlaylistSourceSyncResult>, String> {
        *lock(&self.inner.database) = Some(db_path.clone());
        let cache_dir = cover_cache_dir(app)?;
        let _guard = lock(&self.inner.sync_lock);
        sync_linked_playlist(
            &db_path,
            &playlist_id,
            &cache_dir,
            true,
            PlaylistSyncReason::Manual,
        )
    }

    fn watch_sources(self, app: AppHandle, db_path: String, generation: u64) {
        let Ok(cache_dir) = cover_cache_dir(&app) else {
            return;
        };
        // Reconcile every linked source once after the watcher starts. This
        // closes the small race where a file changes during startup sync.
        let mut observed = HashMap::new();
        while self.inner.generation.load(Ordering::Acquire) == generation {
            thread::sleep(WATCH_INTERVAL);
            if self.inner.generation.load(Ordering::Acquire) != generation {
                break;
            }
            let Ok(sources) = linked_source_stamps(&db_path) else {
                continue;
            };
            let source_ids = sources
                .iter()
                .map(|(playlist_id, _)| playlist_id.clone())
                .collect::<HashSet<_>>();
            observed.retain(|playlist_id, _| source_ids.contains(playlist_id));
            let _guard = lock(&self.inner.sync_lock);
            for (playlist_id, stamp) in sources {
                let should_sync = match observed.insert(playlist_id.clone(), stamp) {
                    Some(previous) => previous != stamp,
                    None => true,
                };
                if !should_sync {
                    continue;
                }
                let Ok(Some(result)) = sync_linked_playlist(
                    &db_path,
                    &playlist_id,
                    &cache_dir,
                    true,
                    PlaylistSyncReason::Watch,
                ) else {
                    continue;
                };
                if result.changed || !result.imported.is_empty() || result.error_changed {
                    let _ = app.emit("muro://playlist-source-synced", result);
                }
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

fn open_database(db_path: &str) -> Result<Connection, String> {
    let path = Path::new(db_path);
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let conn = Connection::open(path).map_err(db_error)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn effective_library_root(conn: &Connection) -> Result<Option<PathBuf>, String> {
    let value = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key = ?1",
            [LIBRARY_ROOT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    Ok(value.as_deref().and_then(normalize_library_root))
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, String> {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    Ok(normalized)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn path_key(path: &Path) -> String {
    let value = path_string(path).replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn portable_path_key(path: &Path) -> String {
    path_string(path).replace('\\', "/").to_lowercase()
}

fn extension_lowercase(path: &Path) -> String {
    path.extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_lowercase()
}

fn is_audio_file(path: &Path) -> bool {
    AUDIO_EXTENSIONS.contains(&extension_lowercase(path).as_str())
}

pub fn sanitize_export_segment(value: &str, fallback: &str) -> String {
    let mut cleaned = String::new();
    let mut previous_space = false;
    for character in value.nfc() {
        let invalid = character <= '\u{1f}'
            || character == '\u{7f}'
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            );
        let character = if invalid { '-' } else { character };
        if character.is_whitespace() {
            if !previous_space {
                cleaned.push(' ');
            }
            previous_space = true;
        } else {
            cleaned.push(character);
            previous_space = false;
        }
    }
    let mut cleaned = cleaned
        .trim()
        .trim_end_matches([' ', '.'])
        .chars()
        .take(120)
        .collect::<String>();
    cleaned = cleaned.trim().trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return fallback.to_string();
    }
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || stem
            .strip_prefix("com")
            .or_else(|| stem.strip_prefix("lpt"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if reserved {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

fn unique_name(directory: &Path, requested: &str, used: &mut HashSet<String>) -> String {
    let requested_path = Path::new(requested);
    let stem = requested_path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or(requested);
    let extension = requested_path.extension().and_then(OsStr::to_str);
    let mut candidate = requested.to_string();
    let mut suffix = 2;
    while used.contains(&portable_path_key(&directory.join(&candidate))) {
        candidate = match extension {
            Some(extension) => format!("{stem} ({suffix}).{extension}"),
            None => format!("{stem} ({suffix})"),
        };
        suffix += 1;
    }
    used.insert(portable_path_key(&directory.join(&candidate)));
    candidate
}

fn create_named_export_root(destination: &Path, root_name: &str) -> Result<PathBuf, String> {
    let destination = absolute_lexical(destination)?;
    if !destination.is_dir() {
        return Err("The export destination is not a directory".to_string());
    }
    for suffix in 1..10_000 {
        let name = if suffix == 1 {
            root_name.to_string()
        } else {
            format!("{root_name} ({suffix})")
        };
        let export_root = destination.join(name);
        match fs::create_dir(&export_root) {
            Ok(()) => return Ok(export_root),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "Could not create a unique {root_name} export folder"
    ))
}

fn playlist_text(value: Option<&str>, fallback: &str) -> String {
    let mut cleaned = value.unwrap_or(fallback).replace(['\r', '\n'], " ");
    cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn xml_text(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if matches!(character as u32, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f) {
            continue;
        }
        match character {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&apos;"),
            _ => result.push(character),
        }
    }
    result
}

fn plist_key(lines: &mut Vec<String>, level: usize, key: impl ToString) {
    lines.push(format!(
        "{}<key>{}</key>",
        "  ".repeat(level),
        xml_text(&key.to_string())
    ));
}

fn plist_string(lines: &mut Vec<String>, level: usize, key: &str, value: Option<&str>) {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    plist_key(lines, level, key);
    lines.push(format!(
        "{}<string>{}</string>",
        "  ".repeat(level),
        xml_text(value)
    ));
}

fn plist_integer(
    lines: &mut Vec<String>,
    level: usize,
    key: &str,
    value: Option<f64>,
    minimum: i64,
) {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return;
    };
    let value = value.round() as i64;
    if value < minimum {
        return;
    }
    plist_key(lines, level, key);
    lines.push(format!("{}<integer>{value}</integer>", "  ".repeat(level)));
}

fn plist_boolean(lines: &mut Vec<String>, level: usize, key: &str, value: bool) {
    plist_key(lines, level, key);
    lines.push(format!(
        "{}<{}{}/>",
        "  ".repeat(level),
        if value { "true" } else { "false" },
        ""
    ));
}

fn plist_date(lines: &mut Vec<String>, level: usize, key: &str, value: Option<&str>) {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return;
    };
    plist_key(lines, level, key);
    lines.push(format!(
        "{}<date>{}</date>",
        "  ".repeat(level),
        xml_text(value)
    ));
}

fn epoch_date(seconds: Option<i64>) -> Option<String> {
    let seconds = seconds?;
    let time = UNIX_EPOCH.checked_add(Duration::from_secs(seconds.max(0) as u64))?;
    Some(system_time_iso(time))
}

fn existing_date(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(
            date.with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string(),
        );
    }
    if let Ok(milliseconds) = value.parse::<i64>() {
        let seconds = if milliseconds > 10_000_000_000 {
            milliseconds / 1000
        } else {
            milliseconds
        };
        return epoch_date(Some(seconds));
    }
    None
}

fn system_time_iso(value: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value)
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

fn json_text(value: Option<&str>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(serde_json::Value::Array(values)) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect::<Vec<_>>()
            .join(", "),
        Ok(serde_json::Value::Null) => String::new(),
        Ok(serde_json::Value::String(value)) => value,
        Ok(value) => value.to_string(),
        Err(_) => value.to_string(),
    }
}

fn persistent_id(kind: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("{kind}:{value}").as_bytes());
    hex::encode(digest)[..16].to_ascii_uppercase()
}

fn itunes_file_url(path: &Path, directory: bool) -> String {
    let absolute = absolute_lexical(path).unwrap_or_else(|_| path.to_path_buf());
    let mut href = Url::from_file_path(&absolute)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| format!("file:///{}", path_string(&absolute).replace('\\', "/")));
    if let Some(rest) = href.strip_prefix("file:///") {
        href = format!("file://localhost/{rest}");
    }
    if directory && !href.ends_with('/') {
        href.push('/');
    }
    href
}

fn itunes_kind(path: &Path) -> &'static str {
    match extension_lowercase(path).as_str() {
        "mp3" => "MPEG audio file",
        "m4a" => "Apple MPEG-4 audio file",
        "m4b" => "Protected MPEG-4 audio file",
        "aac" => "AAC audio file",
        "aif" | "aiff" => "AIFF audio file",
        "wav" => "WAV audio file",
        "flac" => "FLAC audio file",
        "ogg" => "Ogg Vorbis audio file",
        "opus" => "Opus audio file",
        "wma" => "Windows Media audio file",
        _ => "Audio file",
    }
}

fn common_music_directory(tracks: &[TrackExportRow]) -> Option<PathBuf> {
    let directories = tracks
        .iter()
        .filter_map(|track| track.source_path.parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    let mut common = directories.first()?.clone();
    while !directories
        .iter()
        .all(|directory| directory.starts_with(&common))
    {
        if !common.pop() {
            break;
        }
    }
    Some(common)
}

fn load_playlist_folders(conn: &Connection) -> Result<Vec<PlaylistFolderRow>, String> {
    let mut statement = conn
        .prepare("SELECT id,name,parent_id FROM playlist_folders ORDER BY parent_id,sort_order,name COLLATE NOCASE")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(PlaylistFolderRow {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn load_playlists(conn: &Connection) -> Result<Vec<PlaylistRow>, String> {
    let mut statement = conn
        .prepare("SELECT id,name,folder_id FROM playlists ORDER BY folder_id,sort_order,name COLLATE NOCASE")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(PlaylistRow {
                id: row.get(0)?,
                name: row.get(1)?,
                folder_id: row.get(2)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn load_playlist_entries(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut statement = conn
        .prepare("SELECT playlist_id,track_id FROM playlist_tracks ORDER BY playlist_id,position")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn load_itunes_tracks(conn: &Connection) -> Result<Vec<TrackExportRow>, String> {
    let root = effective_library_root(conn)?;
    let mut statement = conn.prepare(
        "SELECT id,title,artist,album_artist,album,genre_json,comment_json,year,track_number,track_total,disc_number,disc_total,bpm,rating,source_path,duration_seconds,bitrate_kbps,sample_rate_hz,file_size_bytes,added_at,updated_at,last_played_at,play_count,is_missing FROM tracks WHERE import_status != 'staged' ORDER BY artist COLLATE NOCASE,album COLLATE NOCASE,COALESCE(disc_number,1),COALESCE(track_number,0),title COLLATE NOCASE",
    ).map_err(db_error)?;
    let mapped = statement
        .query_map([], |row| {
            let stored: String = row.get(14)?;
            Ok((
                stored,
                TrackExportRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    album_artist: row.get(3)?,
                    album: row.get(4)?,
                    genre_json: row.get(5)?,
                    comment_json: row.get(6)?,
                    year: row.get(7)?,
                    track_number: row.get(8)?,
                    track_total: row.get(9)?,
                    disc_number: row.get(10)?,
                    disc_total: row.get(11)?,
                    bpm: row.get(12)?,
                    rating: row.get(13)?,
                    source_path: PathBuf::new(),
                    duration_seconds: row.get(15)?,
                    bitrate_kbps: row.get(16)?,
                    sample_rate_hz: row.get(17)?,
                    file_size_bytes: row.get(18)?,
                    added_at: row.get(19)?,
                    updated_at: row.get(20)?,
                    last_played_at: row.get(21)?,
                    play_count: row.get(22)?,
                    is_missing: row.get::<_, Option<i64>>(23)?.unwrap_or(0) == 1,
                },
            ))
        })
        .map_err(db_error)?;
    let mut tracks = Vec::new();
    for row in mapped {
        let (stored, mut track) = row.map_err(db_error)?;
        track.source_path = resolve_stored_track_path(&stored, root.as_deref())?;
        tracks.push(track);
    }
    Ok(tracks)
}

fn write_itunes_library(
    db_path: &str,
    destination_path: &str,
) -> Result<ItunesLibraryExportResult, String> {
    let conn = open_database(db_path)?;
    let tracks = load_itunes_tracks(&conn)?;
    let folders = load_playlist_folders(&conn)?;
    let playlists = load_playlists(&conn)?;
    let playlist_entries = load_playlist_entries(&conn)?;
    let destination = absolute_lexical(Path::new(destination_path))?;
    if !extension_lowercase(&destination).eq("xml") {
        return Err("The iTunes-compatible export must use an .xml file".to_string());
    }
    let numeric_by_id = tracks
        .iter()
        .enumerate()
        .map(|(index, track)| (track.id.clone(), index + 1))
        .collect::<HashMap<_, _>>();
    let mut entries_by_playlist: HashMap<String, Vec<usize>> = HashMap::new();
    let mut entries_exported = 0;
    let mut entries_skipped = 0;
    for (playlist_id, track_id) in playlist_entries {
        if let Some(track_id) = numeric_by_id.get(&track_id) {
            entries_by_playlist
                .entry(playlist_id)
                .or_default()
                .push(*track_id);
            entries_exported += 1;
        } else {
            entries_skipped += 1;
        }
    }
    let db_absolute = absolute_lexical(Path::new(db_path))?;
    let library_id = persistent_id("library", &path_string(&db_absolute));
    let folder_ids = folders
        .iter()
        .map(|folder| {
            (
                folder.id.clone(),
                persistent_id("playlist-folder", &folder.id),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut lines = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_string(),
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">".to_string(),
        "<plist version=\"1.0\">".to_string(), "<dict>".to_string(),
    ];
    plist_integer(&mut lines, 1, "Major Version", Some(1.0), 0);
    plist_integer(&mut lines, 1, "Minor Version", Some(1.0), 0);
    let now = system_time_iso(SystemTime::now());
    plist_date(&mut lines, 1, "Date", Some(&now));
    plist_string(&mut lines, 1, "Application Version", Some("Muro Music"));
    plist_integer(&mut lines, 1, "Features", Some(5.0), 0);
    plist_string(&mut lines, 1, "Library Persistent ID", Some(&library_id));
    if let Some(directory) = common_music_directory(&tracks) {
        let url = itunes_file_url(&directory, true);
        plist_string(&mut lines, 1, "Music Folder", Some(&url));
    }
    plist_key(&mut lines, 1, "Tracks");
    lines.push("  <dict>".to_string());
    for (index, track) in tracks.iter().enumerate() {
        let track_id = index + 1;
        plist_key(&mut lines, 2, track_id);
        lines.push("    <dict>".to_string());
        plist_integer(&mut lines, 3, "Track ID", Some(track_id as f64), 0);
        let id = persistent_id("track", &track.id);
        plist_string(&mut lines, 3, "Persistent ID", Some(&id));
        plist_string(
            &mut lines,
            3,
            "Name",
            Some(
                track
                    .title
                    .as_deref()
                    .filter(|v| !v.is_empty())
                    .unwrap_or("Unknown Title"),
            ),
        );
        plist_string(
            &mut lines,
            3,
            "Artist",
            Some(
                track
                    .artist
                    .as_deref()
                    .filter(|v| !v.is_empty())
                    .unwrap_or("Unknown Artist"),
            ),
        );
        plist_string(&mut lines, 3, "Album Artist", track.album_artist.as_deref());
        plist_string(
            &mut lines,
            3,
            "Album",
            Some(
                track
                    .album
                    .as_deref()
                    .filter(|v| !v.is_empty())
                    .unwrap_or("Unknown Album"),
            ),
        );
        let genre = json_text(track.genre_json.as_deref());
        let comment = json_text(track.comment_json.as_deref());
        plist_string(&mut lines, 3, "Genre", Some(&genre));
        plist_string(&mut lines, 3, "Comments", Some(&comment));
        plist_string(&mut lines, 3, "Kind", Some(itunes_kind(&track.source_path)));
        plist_integer(
            &mut lines,
            3,
            "Size",
            track.file_size_bytes.map(|v| v as f64),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Total Time",
            track.duration_seconds.map(|v| v * 1000.0),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Disc Number",
            track.disc_number.map(|v| v as f64),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Disc Count",
            track.disc_total.map(|v| v as f64),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Track Number",
            track.track_number.map(|v| v as f64),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Track Count",
            track.track_total.map(|v| v as f64),
            1,
        );
        plist_integer(&mut lines, 3, "Year", track.year.map(|v| v as f64), 1);
        plist_integer(&mut lines, 3, "BPM", track.bpm, 1);
        plist_integer(
            &mut lines,
            3,
            "Bit Rate",
            track.bitrate_kbps.map(|v| v as f64),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Sample Rate",
            track.sample_rate_hz.map(|v| v as f64),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Rating",
            track.rating.map(|v| (v * 20.0).clamp(0.0, 100.0)),
            1,
        );
        plist_integer(
            &mut lines,
            3,
            "Play Count",
            track.play_count.map(|v| v as f64),
            1,
        );
        let modified = epoch_date(track.updated_at);
        let added = epoch_date(track.added_at);
        let played = existing_date(track.last_played_at.as_deref());
        plist_date(&mut lines, 3, "Date Modified", modified.as_deref());
        plist_date(&mut lines, 3, "Date Added", added.as_deref());
        plist_date(&mut lines, 3, "Play Date UTC", played.as_deref());
        plist_string(&mut lines, 3, "Track Type", Some("File"));
        let location = itunes_file_url(&track.source_path, false);
        plist_string(&mut lines, 3, "Location", Some(&location));
        lines.push("    </dict>".to_string());
    }
    lines.push("  </dict>".to_string());
    plist_key(&mut lines, 1, "Playlists");
    lines.push("  <array>".to_string());
    lines.push("    <dict>".to_string());
    plist_string(&mut lines, 3, "Name", Some("Library"));
    plist_boolean(&mut lines, 3, "Master", true);
    plist_integer(&mut lines, 3, "Playlist ID", Some(1.0), 0);
    let master_id = persistent_id("master", &library_id);
    plist_string(&mut lines, 3, "Playlist Persistent ID", Some(&master_id));
    plist_boolean(&mut lines, 3, "Visible", false);
    plist_boolean(&mut lines, 3, "All Items", true);
    plist_key(&mut lines, 3, "Playlist Items");
    lines.push("      <array>".to_string());
    for track_id in 1..=tracks.len() {
        lines.push("        <dict>".to_string());
        plist_integer(&mut lines, 5, "Track ID", Some(track_id as f64), 0);
        lines.push("        </dict>".to_string());
    }
    lines.push("      </array>".to_string());
    lines.push("    </dict>".to_string());
    let mut next_playlist_id = 2;
    for folder in &folders {
        lines.push("    <dict>".to_string());
        plist_string(
            &mut lines,
            3,
            "Name",
            Some(if folder.name.is_empty() {
                "Playlist Folder"
            } else {
                &folder.name
            }),
        );
        plist_integer(
            &mut lines,
            3,
            "Playlist ID",
            Some(next_playlist_id as f64),
            0,
        );
        next_playlist_id += 1;
        plist_string(
            &mut lines,
            3,
            "Playlist Persistent ID",
            folder_ids.get(&folder.id).map(String::as_str),
        );
        if let Some(parent_id) = &folder.parent_id {
            plist_string(
                &mut lines,
                3,
                "Parent Persistent ID",
                folder_ids.get(parent_id).map(String::as_str),
            );
        }
        plist_boolean(&mut lines, 3, "Folder", true);
        lines.push("    </dict>".to_string());
    }
    for playlist in &playlists {
        lines.push("    <dict>".to_string());
        plist_string(
            &mut lines,
            3,
            "Name",
            Some(if playlist.name.is_empty() {
                "Playlist"
            } else {
                &playlist.name
            }),
        );
        plist_integer(
            &mut lines,
            3,
            "Playlist ID",
            Some(next_playlist_id as f64),
            0,
        );
        next_playlist_id += 1;
        let persistent = persistent_id("playlist", &playlist.id);
        plist_string(&mut lines, 3, "Playlist Persistent ID", Some(&persistent));
        if let Some(folder_id) = &playlist.folder_id {
            plist_string(
                &mut lines,
                3,
                "Parent Persistent ID",
                folder_ids.get(folder_id).map(String::as_str),
            );
        }
        plist_boolean(&mut lines, 3, "All Items", true);
        plist_key(&mut lines, 3, "Playlist Items");
        lines.push("      <array>".to_string());
        for track_id in entries_by_playlist.get(&playlist.id).into_iter().flatten() {
            lines.push("        <dict>".to_string());
            plist_integer(&mut lines, 5, "Track ID", Some(*track_id as f64), 0);
            lines.push("        </dict>".to_string());
        }
        lines.push("      </array>".to_string());
        lines.push("    </dict>".to_string());
    }
    lines.extend([
        "  </array>".to_string(),
        "</dict>".to_string(),
        "</plist>".to_string(),
        String::new(),
    ]);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    fs::write(&destination, lines.join("\n")).map_err(io_error)?;
    Ok(ItunesLibraryExportResult {
        destination_path: path_string(&destination),
        tracks_exported: tracks.len(),
        missing_tracks_referenced: tracks.iter().filter(|track| track.is_missing).count(),
        playlist_folders_exported: folders.len(),
        playlists_exported: playlists.len(),
        playlist_entries_exported: entries_exported,
        playlist_entries_skipped: entries_skipped,
    })
}

fn album_artist_or_artist(track: &OrganizedTrackRow) -> &str {
    track
        .album_artist
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| track.artist.as_deref().filter(|v| !v.trim().is_empty()))
        .unwrap_or("Unknown Artist")
}

fn album_key(track: &OrganizedTrackRow) -> String {
    format!(
        "{}\0{}",
        album_artist_or_artist(track).to_lowercase(),
        track
            .album
            .as_deref()
            .unwrap_or("Unknown Album")
            .trim()
            .to_lowercase()
    )
}

fn multi_disc_albums(tracks: &[OrganizedTrackRow]) -> HashSet<String> {
    let mut discs: HashMap<String, HashSet<i64>> = HashMap::new();
    let mut result = HashSet::new();
    for track in tracks {
        let key = album_key(track);
        if track.disc_total.unwrap_or(0) > 1 || track.disc_number.unwrap_or(0) > 1 {
            result.insert(key.clone());
        }
        if let Some(disc) = track.disc_number.filter(|disc| *disc > 0) {
            discs.entry(key).or_default().insert(disc);
        }
    }
    result.extend(
        discs
            .into_iter()
            .filter_map(|(key, discs)| (discs.len() > 1).then_some(key)),
    );
    result
}

fn source_file_name(track: &OrganizedTrackRow, source: &Path) -> String {
    let base = source
        .file_stem()
        .and_then(OsStr::to_str)
        .or(track.title.as_deref())
        .unwrap_or("Unknown Track");
    let base = sanitize_export_segment(base, "Unknown Track");
    let extension = source
        .extension()
        .and_then(OsStr::to_str)
        .filter(|extension| {
            !extension.is_empty()
                && extension.len() <= 12
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        });
    extension
        .map(|extension| format!("{base}.{extension}"))
        .unwrap_or(base)
}

fn build_playlist_folder_paths(folders: &[PlaylistFolderRow]) -> HashMap<String, PathBuf> {
    fn resolve(
        id: &str,
        by_id: &HashMap<String, PlaylistFolderRow>,
        resolved: &mut HashMap<String, PathBuf>,
        used: &mut HashSet<String>,
        ancestors: &mut HashSet<String>,
    ) -> PathBuf {
        if let Some(path) = resolved.get(id) {
            return path.clone();
        }
        let Some(folder) = by_id.get(id) else {
            return PathBuf::new();
        };
        if !ancestors.insert(id.to_string()) {
            return PathBuf::new();
        }
        let parent = folder
            .parent_id
            .as_deref()
            .filter(|parent| !ancestors.contains(*parent))
            .map(|parent| resolve(parent, by_id, resolved, used, ancestors))
            .unwrap_or_default();
        ancestors.remove(id);
        let requested = sanitize_export_segment(&folder.name, "Playlist Folder");
        let segment = unique_name(&parent, &requested, used);
        let path = parent.join(segment);
        resolved.insert(id.to_string(), path.clone());
        path
    }
    let by_id = folders
        .iter()
        .cloned()
        .map(|folder| (folder.id.clone(), folder))
        .collect::<HashMap<_, _>>();
    let mut resolved = HashMap::new();
    let mut used = HashSet::new();
    for folder in folders {
        resolve(
            &folder.id,
            &by_id,
            &mut resolved,
            &mut used,
            &mut HashSet::new(),
        );
    }
    resolved
}

fn load_organized_tracks(conn: &Connection) -> Result<Vec<OrganizedTrackRow>, String> {
    let mut statement = conn.prepare("SELECT id,title,artist,album_artist,album,disc_number,disc_total,duration_seconds,source_path FROM tracks ORDER BY COALESCE(NULLIF(album_artist,''),artist) COLLATE NOCASE,album COLLATE NOCASE,COALESCE(disc_number,1),COALESCE(track_number,0),title COLLATE NOCASE").map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(OrganizedTrackRow {
                id: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                album_artist: row.get(3)?,
                album: row.get(4)?,
                disc_number: row.get(5)?,
                disc_total: row.get(6)?,
                duration_seconds: row.get(7)?,
                stored_source_path: row.get(8)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn copy_exclusive(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = fs::File::open(source).map_err(io_error)?;
    if !input.metadata().map_err(io_error)?.is_file() {
        return Err("Source path is not a file".to_string());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(io_error)?;
    if let Err(error) = io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(error.to_string());
    }
    output.flush().map_err(io_error)
}

fn relative_slash(from: &Path, to: &Path) -> String {
    let from_components = from.components().collect::<Vec<_>>();
    let to_components = to.components().collect::<Vec<_>>();
    let mut common = 0;
    while common < from_components.len()
        && common < to_components.len()
        && from_components[common] == to_components[common]
    {
        common += 1;
    }
    let mut result = PathBuf::new();
    for _ in common..from_components.len() {
        result.push("..");
    }
    for component in &to_components[common..] {
        result.push(component.as_os_str());
    }
    path_string(&result).replace('\\', "/")
}

fn export_organized_library_impl(
    db_path: &str,
    destination_path: &str,
    use_as_current_library: bool,
) -> Result<OrganizedLibraryExportResult, String> {
    let mut conn = open_database(db_path)?;
    let current_root = effective_library_root(&conn)?;
    let tracks = load_organized_tracks(&conn)?;
    let folders = load_playlist_folders(&conn)?;
    let playlists = load_playlists(&conn)?;
    let playlist_entries = load_playlist_entries(&conn)?;
    let export_root = create_named_export_root(Path::new(destination_path), "Muro Library")?;
    let multi_disc = multi_disc_albums(&tracks);
    let mut used_audio = HashSet::new();
    let mut by_track = HashMap::<String, PathBuf>::new();
    let mut by_source = HashMap::<String, PathBuf>::new();
    let mut failures = Vec::new();
    let mut files_copied = 0;
    for track in &tracks {
        let source = resolve_stored_track_path(&track.stored_source_path, current_root.as_deref())?;
        let source_key = path_key(&source);
        if let Some(existing) = by_source.get(&source_key) {
            by_track.insert(track.id.clone(), existing.clone());
            continue;
        }
        let artist = sanitize_export_segment(album_artist_or_artist(track), "Unknown Artist");
        let album = sanitize_export_segment(track.album.as_deref().unwrap_or(""), "Unknown Album");
        let mut directory = PathBuf::from(artist).join(album);
        if multi_disc.contains(&album_key(track)) {
            directory.push(format!("Disc {}", track.disc_number.unwrap_or(1).max(1)));
        }
        let requested = source_file_name(track, &source);
        let filename = unique_name(&directory, &requested, &mut used_audio);
        let relative = directory.join(filename);
        let output = export_root.join(&relative);
        let result = fs::create_dir_all(output.parent().unwrap_or(&export_root))
            .map_err(io_error)
            .and_then(|_| copy_exclusive(&source, &output));
        match result {
            Ok(()) => {
                by_track.insert(track.id.clone(), relative.clone());
                by_source.insert(source_key, relative);
                files_copied += 1;
            }
            Err(message) => failures.push(OrganizedLibraryFailure {
                track_id: track.id.clone(),
                source_path: path_string(&source),
                message,
            }),
        }
    }
    let entries_by_playlist = playlist_entries.into_iter().fold(
        HashMap::<String, Vec<String>>::new(),
        |mut map, (playlist, track)| {
            map.entry(playlist).or_default().push(track);
            map
        },
    );
    let tracks_by_id = tracks
        .iter()
        .map(|track| (track.id.clone(), track))
        .collect::<HashMap<_, _>>();
    let playlists_root = export_root.join("Playlists");
    fs::create_dir_all(&playlists_root).map_err(io_error)?;
    let folder_paths = build_playlist_folder_paths(&folders);
    let mut used_playlists = HashSet::new();
    let mut playlist_entries_exported = 0;
    let mut playlist_entries_missing = 0;
    for playlist in &playlists {
        let directory = playlist
            .folder_id
            .as_ref()
            .and_then(|id| folder_paths.get(id))
            .cloned()
            .unwrap_or_default();
        let requested = format!(
            "{}.m3u8",
            sanitize_export_segment(&playlist.name, "Playlist")
        );
        let filename = unique_name(&directory, &requested, &mut used_playlists);
        let playlist_path = playlists_root.join(&directory).join(filename);
        let mut lines = vec!["#EXTM3U".to_string()];
        for track_id in entries_by_playlist.get(&playlist.id).into_iter().flatten() {
            let (Some(relative), Some(track)) =
                (by_track.get(track_id), tracks_by_id.get(track_id))
            else {
                playlist_entries_missing += 1;
                continue;
            };
            let duration = track
                .duration_seconds
                .filter(|value| *value != 0.0)
                .unwrap_or(-1.0)
                .round()
                .max(-1.0) as i64;
            lines.push(format!(
                "#EXTINF:{duration},{} - {}",
                playlist_text(track.artist.as_deref(), "Unknown Artist"),
                playlist_text(track.title.as_deref(), "Unknown Title")
            ));
            lines.push(relative_slash(
                playlist_path.parent().unwrap_or(&playlists_root),
                &export_root.join(relative),
            ));
            playlist_entries_exported += 1;
        }
        if let Some(parent) = playlist_path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::write(&playlist_path, format!("{}\r\n", lines.join("\r\n"))).map_err(io_error)?;
    }
    let mut library_switched = false;
    let mut switch_error = None;
    if use_as_current_library {
        if !failures.is_empty() {
            switch_error = Some("Some music files could not be copied".to_string());
        } else {
            let switch = (|| -> Result<(), String> {
                let transaction = conn.transaction().map_err(db_error)?;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                for track in &tracks {
                    let relative = by_track.get(&track.id).ok_or_else(|| {
                        format!("No exported file was recorded for track {}", track.id)
                    })?;
                    let absolute = export_root.join(relative);
                    transaction.execute("UPDATE tracks SET source_path=?1,filename=?2,is_missing=0,updated_at=?3 WHERE id=?4", params![to_stored_track_path(&absolute, Some(&export_root)), absolute.file_name().and_then(OsStr::to_str).unwrap_or_default(), now, track.id]).map_err(db_error)?;
                }
                transaction.execute("INSERT INTO app_metadata(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![LIBRARY_ROOT_KEY, path_string(&export_root)]).map_err(db_error)?;
                transaction.commit().map_err(db_error)
            })();
            match switch {
                Ok(()) => library_switched = true,
                Err(message) => switch_error = Some(message),
            }
        }
    }
    Ok(OrganizedLibraryExportResult {
        export_root: path_string(&export_root),
        tracks: tracks.len(),
        files_copied,
        tracks_failed: failures.len(),
        playlists_exported: playlists.len(),
        playlist_entries_exported,
        playlist_entries_missing,
        library_switch_requested: use_as_current_library,
        library_switched,
        library_switch_error: switch_error,
        failures,
    })
}

fn decode_playlist_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string()
    }
}

fn playlist_file_path(value: &str, directory: &Path) -> Option<PathBuf> {
    let value = value.trim().trim_matches('"');
    if value.is_empty() {
        return None;
    }
    if value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
    {
        let mut url = Url::parse(value).ok()?;
        if url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("localhost"))
        {
            url.set_host(None).ok()?;
        }
        return url
            .to_file_path()
            .ok()
            .and_then(|path| absolute_lexical(&path).ok());
    }
    absolute_lexical(&if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        directory.join(value)
    })
    .ok()
}

fn parse_playlist_file(path: &Path) -> Result<Vec<PathBuf>, String> {
    if !matches!(extension_lowercase(path).as_str(), "m3u" | "m3u8" | "pls") {
        return Err("Unsupported playlist format".to_string());
    }
    let text = decode_playlist_text(&fs::read(path).map_err(io_error)?);
    let is_pls = extension_lowercase(path) == "pls";
    let directory = path.parent().unwrap_or_else(|| Path::new(""));
    Ok(text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let entry = if is_pls {
                let (key, value) = line.split_once('=')?;
                (key.len() > 4
                    && key[..4].eq_ignore_ascii_case("File")
                    && key[4..].chars().all(|c| c.is_ascii_digit()))
                .then_some(value)?
            } else {
                if line.is_empty() || line.starts_with('#') {
                    return None;
                }
                line
            };
            playlist_file_path(entry, directory)
        })
        .collect())
}

fn linked_playlist_ids(db_path: &str) -> Result<Vec<String>, String> {
    let conn = open_database(db_path)?;
    let mut statement = conn
        .prepare("SELECT id FROM playlists WHERE source_path IS NOT NULL AND source_path<>''")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn linked_source_stamps(db_path: &str) -> Result<Vec<(String, Option<(u128, u64)>)>, String> {
    let conn = open_database(db_path)?;
    let root = effective_library_root(&conn)?;
    let mut statement = conn
        .prepare(
            "SELECT id,source_path FROM playlists WHERE source_path IS NOT NULL AND source_path<>''",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows
        .into_iter()
        .map(|(playlist_id, stored)| {
            let stamp = resolve_stored_track_path(&stored, root.as_deref())
                .ok()
                .filter(|path| path.is_absolute())
                .and_then(|path| fs::metadata(path).ok())
                .filter(|metadata| metadata.is_file())
                .and_then(|metadata| {
                    let modified = metadata.modified().ok()?;
                    let milliseconds = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
                    Some((milliseconds, metadata.len()))
                });
            (playlist_id, stamp)
        })
        .collect())
}

fn playlist_track_ids(conn: &Connection, playlist_id: &str) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id=?1 ORDER BY position")
        .map_err(db_error)?;
    let rows = statement
        .query_map([playlist_id], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn linked_playlist(
    conn: &Connection,
    playlist_id: &str,
) -> Result<Option<LinkedPlaylistRow>, String> {
    conn.query_row("SELECT id,name,source_path,source_mtime_ms,source_size,source_sync_error FROM playlists WHERE id=?1", [playlist_id], |row| Ok(LinkedPlaylistRow { id: row.get(0)?, name: row.get(1)?, source_path: row.get::<_, Option<String>>(2)?.unwrap_or_default(), source_mtime_ms: row.get(3)?, source_size: row.get::<_, Option<i64>>(4)?.map(|v| v.max(0) as u64), source_sync_error: row.get(5)? })).optional().map_err(db_error)
}

fn update_sync_error(conn: &Connection, playlist_id: &str, message: &str) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE playlists SET source_sync_error=?1,last_synced_at=?2 WHERE id=?3",
        params![message, now, playlist_id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn file_stamp(path: &Path) -> Result<(f64, u64), String> {
    let metadata = fs::metadata(path).map_err(io_error)?;
    if !metadata.is_file() {
        return Err("Playlist source is not a file".to_string());
    }
    let modified = metadata
        .modified()
        .map_err(io_error)?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    Ok((modified.as_secs_f64() * 1000.0, metadata.len()))
}

fn cover_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("covers");
    fs::create_dir_all(&path).map_err(io_error)?;
    Ok(path)
}

fn sync_linked_playlist(
    db_path: &str,
    playlist_id: &str,
    cache_dir: &Path,
    force: bool,
    reason: PlaylistSyncReason,
) -> Result<Option<PlaylistSourceSyncResult>, String> {
    let mut conn = open_database(db_path)?;
    let Some(playlist) = linked_playlist(&conn, playlist_id)? else {
        return Ok(None);
    };
    if playlist.source_path.trim().is_empty() {
        return Ok(None);
    }
    let root = effective_library_root(&conn)?;
    let source = resolve_stored_track_path(&playlist.source_path, root.as_deref())?;
    let previous_ids = playlist_track_ids(&conn, playlist_id)?;
    let unavailable = || PlaylistSourceSyncResult {
        playlist_id: playlist.id.clone(),
        name: playlist.name.clone(),
        source_path: path_string(&source),
        track_ids: previous_ids.clone(),
        imported: Vec::new(),
        added: 0,
        removed: 0,
        skipped: 0,
        changed: false,
        source_sync_error: Some("The playlist source file is unavailable".to_string()),
        error_changed: playlist.source_sync_error.as_deref()
            != Some("The playlist source file is unavailable"),
        reason,
    };
    if !source.is_absolute() {
        update_sync_error(
            &conn,
            playlist_id,
            "The playlist source file is unavailable",
        )?;
        return Ok(Some(unavailable()));
    }
    let (mtime_ms, source_size) = match file_stamp(&source) {
        Ok(stamp) => stamp,
        Err(_) => {
            update_sync_error(
                &conn,
                playlist_id,
                "The playlist source file is unavailable",
            )?;
            return Ok(Some(unavailable()));
        }
    };
    if !force
        && playlist.source_mtime_ms == Some(mtime_ms)
        && playlist.source_size == Some(source_size)
        && playlist.source_sync_error.is_none()
    {
        return Ok(Some(PlaylistSourceSyncResult {
            playlist_id: playlist.id,
            name: playlist.name,
            source_path: path_string(&source),
            track_ids: previous_ids,
            imported: Vec::new(),
            added: 0,
            removed: 0,
            skipped: 0,
            changed: false,
            source_sync_error: None,
            error_changed: false,
            reason,
        }));
    }
    let entries = match parse_playlist_file(&source) {
        Ok(entries) => entries,
        Err(message) => {
            update_sync_error(&conn, playlist_id, &message)?;
            return Ok(Some(PlaylistSourceSyncResult {
                playlist_id: playlist.id,
                name: playlist.name,
                source_path: path_string(&source),
                track_ids: previous_ids,
                imported: Vec::new(),
                added: 0,
                removed: 0,
                skipped: 0,
                changed: false,
                source_sync_error: Some(message.clone()),
                error_changed: playlist.source_sync_error.as_deref() != Some(&message),
                reason,
            }));
        }
    };
    let mut track_by_path = HashMap::new();
    {
        let mut statement = conn
            .prepare("SELECT id,source_path FROM tracks")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for (id, stored) in rows {
            if let Ok(path) = resolve_stored_track_path(&stored, root.as_deref()) {
                track_by_path.insert(path_key(&path), id);
            }
        }
    }
    let mut imported = Vec::new();
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped = 0;
    for entry in entries {
        let key = path_key(&entry);
        let mut track_id = track_by_path.get(&key).cloned();
        if track_id.is_none() && entry.is_file() && is_audio_file(&entry) {
            if let Ok(mut result) =
                library_ops::import_files(vec![path_string(&entry)], db_path, cache_dir, None)
            {
                if let Some(track) = result.imported.first() {
                    track_id = Some(track.id.clone());
                    track_by_path.insert(key.clone(), track.id.clone());
                } else {
                    let stored = to_stored_track_path(&entry, root.as_deref());
                    track_id = conn
                        .query_row(
                            "SELECT id FROM tracks WHERE source_path=?1",
                            [stored],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(db_error)?;
                }
                imported.append(&mut result.imported);
            }
        }
        let Some(track_id) = track_id else {
            skipped += 1;
            continue;
        };
        if seen.insert(track_id.clone()) {
            ordered.push(track_id);
        }
    }
    let previous_set = previous_ids.iter().collect::<HashSet<_>>();
    let next_set = ordered.iter().collect::<HashSet<_>>();
    let added = ordered
        .iter()
        .filter(|id| !previous_set.contains(id))
        .count();
    let removed = previous_ids
        .iter()
        .filter(|id| !next_set.contains(id))
        .count();
    let changed = previous_ids != ordered;
    let sync_error = (skipped > 0).then(|| {
        format!(
            "{skipped} playlist {} unavailable",
            if skipped == 1 {
                "entry is"
            } else {
                "entries are"
            }
        )
    });
    let error_changed = playlist.source_sync_error != sync_error;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let transaction = conn.transaction().map_err(db_error)?;
    if changed {
        transaction
            .execute(
                "DELETE FROM playlist_tracks WHERE playlist_id=?1",
                [playlist_id],
            )
            .map_err(db_error)?;
        for (position, track_id) in ordered.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES (?1,?2,?3)",
                    params![playlist_id, track_id, position as i64],
                )
                .map_err(db_error)?;
        }
    }
    transaction.execute("UPDATE playlists SET source_path=?1,source_mtime_ms=?2,source_size=?3,source_sync_error=?4,last_synced_at=?5 WHERE id=?6", params![to_stored_track_path(&source, root.as_deref()), mtime_ms, source_size as i64, sync_error, now, playlist_id]).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    Ok(Some(PlaylistSourceSyncResult {
        playlist_id: playlist.id,
        name: playlist.name,
        source_path: path_string(&source),
        track_ids: ordered,
        imported,
        added,
        removed,
        skipped,
        changed,
        source_sync_error: sync_error,
        error_changed,
        reason,
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn export_itunes_library(
    db_path: String,
    destination_path: String,
) -> Result<ItunesLibraryExportResult, String> {
    write_itunes_library(&db_path, &destination_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn export_organized_library(
    db_path: String,
    destination_path: String,
    use_as_current_library: bool,
) -> Result<OrganizedLibraryExportResult, String> {
    export_organized_library_impl(&db_path, &destination_path, use_as_current_library)
}

#[tauri::command(rename_all = "camelCase")]
pub fn configure_playlist_sync(
    app: AppHandle,
    service: State<'_, PlaylistSyncService>,
    db_path: String,
) -> Result<PlaylistSyncConfiguration, String> {
    service.configure(app, db_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn sync_playlist_source(
    app: AppHandle,
    service: State<'_, PlaylistSyncService>,
    db_path: String,
    playlist_id: String,
) -> Result<Option<PlaylistSourceSyncResult>, String> {
    service.sync_manual(&app, db_path, playlist_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("muro-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn sanitizes_reserved_and_invalid_export_names() {
        assert_eq!(sanitize_export_segment("  A/B:*  ", "Unknown"), "A-B-");
        assert_eq!(sanitize_export_segment("con.txt", "Unknown"), "_con.txt");
        assert_eq!(sanitize_export_segment("..", "Unknown"), "Unknown");
    }

    #[test]
    fn unique_names_are_portably_case_insensitive() {
        let mut used = HashSet::new();
        assert_eq!(
            unique_name(Path::new("Artist"), "Mix.MP3", &mut used),
            "Mix.MP3"
        );
        assert_eq!(
            unique_name(Path::new("artist"), "mix.mp3", &mut used),
            "mix (2).mp3"
        );
    }

    #[test]
    fn parses_relative_m3u_and_pls_entries() {
        let root = temp_directory("playlist-parse");
        let first = root.join("one.mp3");
        let second = root.join("two.flac");
        fs::write(root.join("list.m3u8"), "#EXTM3U\none.mp3\n\"two.flac\"\n").unwrap();
        fs::write(
            root.join("list.pls"),
            "[playlist]\nFile1=one.mp3\nFile2=two.flac\n",
        )
        .unwrap();
        assert_eq!(
            parse_playlist_file(&root.join("list.m3u8")).unwrap(),
            vec![first.clone(), second.clone()]
        );
        assert_eq!(
            parse_playlist_file(&root.join("list.pls")).unwrap(),
            vec![first, second]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_sync_replaces_membership_and_reuses_portable_paths() {
        let root = temp_directory("playlist-sync");
        let db_path = root.join("library.sqlite");
        let audio = root.join("song.mp3");
        fs::write(
            &audio,
            b"not decoded because it already exists in the database",
        )
        .unwrap();
        let playlist = root.join("source.m3u8");
        fs::write(&playlist, "#EXTM3U\nsong.mp3\nmissing.mp3\n").unwrap();
        let conn = open_database(&path_string(&db_path)).unwrap();
        conn.execute(
            "INSERT INTO app_metadata(key,value) VALUES (?1,?2)",
            params![LIBRARY_ROOT_KEY, path_string(&root)],
        )
        .unwrap();
        conn.execute("INSERT INTO tracks(id,title,artist,album,filename,source_path,import_status) VALUES ('track-1','Song','Artist','Album','song.mp3','song.mp3','accepted')", []).unwrap();
        conn.execute("INSERT INTO playlists(id,name,source_path,created_at) VALUES ('playlist-1','Source','source.m3u8',0)", []).unwrap();
        drop(conn);
        let result = sync_linked_playlist(
            &path_string(&db_path),
            "playlist-1",
            &root.join("cache"),
            true,
            PlaylistSyncReason::Manual,
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.track_ids, vec!["track-1"]);
        assert_eq!((result.added, result.removed, result.skipped), (1, 0, 1));
        assert_eq!(
            result.source_sync_error.as_deref(),
            Some("1 playlist entry is unavailable")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn organized_export_uses_disc_folders_and_relative_playlists() {
        let root = temp_directory("organized-export");
        let source_root = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source_root.join("one.mp3"), b"one").unwrap();
        let db_path = root.join("library.sqlite");
        let conn = open_database(&path_string(&db_path)).unwrap();
        conn.execute(
            "INSERT INTO app_metadata(key,value) VALUES (?1,?2)",
            params![LIBRARY_ROOT_KEY, path_string(&source_root)],
        )
        .unwrap();
        conn.execute("INSERT INTO tracks(id,title,artist,album,filename,source_path,import_status,disc_number,disc_total,duration_seconds) VALUES ('track-1','One','Artist','Album','one.mp3','one.mp3','accepted',1,2,10)", []).unwrap();
        conn.execute(
            "INSERT INTO playlists(id,name,created_at) VALUES ('playlist-1','Favorites',0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES ('playlist-1','track-1',0)", []).unwrap();
        drop(conn);
        let result = export_organized_library_impl(
            &path_string(&db_path),
            &path_string(&destination),
            false,
        )
        .unwrap();
        let export = PathBuf::from(result.export_root);
        assert_eq!(
            fs::read(export.join("Artist/Album/Disc 1/one.mp3")).unwrap(),
            b"one"
        );
        let playlist = fs::read_to_string(export.join("Playlists/Favorites.m3u8")).unwrap();
        assert!(playlist.contains("../Artist/Album/Disc 1/one.mp3"));
        fs::remove_dir_all(root).unwrap();
    }
}
