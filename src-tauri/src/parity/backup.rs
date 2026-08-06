//! Native `.murobackup` creation and restore.
//!
//! Archive version 3 is compatible with the Electron implementation. Restore
//! also accepts versions 1 and 2, while adding bounded ZIP reads and traversal
//! rejection before any archive content is trusted.

use rusqlite::{backup::Backup, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::database::ensure_schema;
use super::playlists::capture_playlist_state;

const ARCHIVE_FORMAT: &str = "muro-library-backup";
const ARCHIVE_VERSION: u32 = 3;
const MAX_SETTINGS_BYTES: usize = 10 * 1024 * 1024;
const MAX_SMART_CRATES_BYTES: usize = 10 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_ARTWORK_INDEX_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DATABASE_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_ARTWORK_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const SENSITIVE_SETTING_KEYS: [&str; 7] = [
    "lastFmApiKey",
    "theAudioDbApiKey",
    "fanartApiKey",
    "braveSearchApiKey",
    "acoustIdClientKey",
    "watchedFolder",
    "watchedFolders",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupCounts {
    #[serde(default)]
    pub tracks: u64,
    #[serde(default)]
    pub playlists: u64,
    #[serde(default)]
    pub playlist_folders: u64,
    #[serde(default)]
    pub playlist_entries: u64,
    #[serde(default)]
    pub artwork_files: u64,
    #[serde(default)]
    pub smart_crates: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format: String,
    pub version: u32,
    pub backup_id: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub app: String,
    #[serde(default = "default_database_file")]
    pub database_file: String,
    #[serde(default = "default_settings_file")]
    pub settings_file: String,
    #[serde(default = "default_smart_crates_file")]
    pub smart_crates_file: String,
    #[serde(default = "default_playlist_file")]
    pub playlist_file: String,
    #[serde(default = "default_artwork_index_file")]
    pub artwork_index_file: String,
    #[serde(default)]
    pub counts: BackupCounts,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackupResult {
    pub destination_path: String,
    pub manifest: BackupManifest,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRestoreResult {
    pub archive_path: String,
    pub recovery_path: Option<String>,
    pub settings_json: String,
    pub smart_crates_json: String,
    pub manifest: BackupManifest,
    pub restored_artwork_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ArtworkIndexEntry {
    original_path: String,
    archive_path: String,
}

struct WorkingDirectory {
    path: PathBuf,
}

impl WorkingDirectory {
    fn create(prefix: &str) -> Result<Self, String> {
        for _ in 0..32 {
            let path = std::env::temp_dir().join(format!("{prefix}{}", Uuid::new_v4()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("Could not create a temporary backup directory".to_string())
    }
}

impl Drop for WorkingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn default_database_file() -> String {
    "database/muro.db".to_string()
}

fn default_settings_file() -> String {
    "settings/muro-settings.json".to_string()
}

fn default_smart_crates_file() -> String {
    "settings/muro-smart-crates.json".to_string()
}

fn default_playlist_file() -> String {
    "playlists/playlists.json".to_string()
}

fn default_artwork_index_file() -> String {
    "artwork/index.json".to_string()
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn zip_error(error: zip::result::ZipError) -> String {
    error.to_string()
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, String> {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
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

fn current_iso_timestamp() -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let millis = i64::try_from(millis).map_err(|_| "System time is out of range".to_string())?;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .map(|timestamp| timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| "System time is out of range".to_string())
}

fn current_epoch_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())
        .map(|duration| duration.as_millis())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(db_error)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn parse_json_payload(value: &str, max_bytes: usize, label: &str) -> Result<Option<Value>, String> {
    if value.len() > max_bytes {
        return Err(format!("The {label} payload is too large"));
    }
    if value.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(value)
        .map(Some)
        .map_err(|_| format!("The {label} payload is not valid JSON"))
}

fn sanitize_settings(settings_json: &str) -> Result<String, String> {
    let Some(persisted) = parse_json_payload(settings_json, MAX_SETTINGS_BYTES, "settings")? else {
        return Ok(String::new());
    };
    let mut object = persisted
        .as_object()
        .cloned()
        .ok_or_else(|| "The settings payload is not valid persisted state".to_string())?;
    let mut state = object
        .remove("state")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for key in SENSITIVE_SETTING_KEYS {
        state.remove(key);
    }
    object.insert("state".to_string(), Value::Object(state));
    serde_json::to_string(&Value::Object(object)).map_err(|error| error.to_string())
}

fn validate_smart_crates(smart_crates_json: &str) -> Result<(String, usize), String> {
    let Some(persisted) =
        parse_json_payload(smart_crates_json, MAX_SMART_CRATES_BYTES, "Smart Crates")?
    else {
        return Ok((String::new(), 0));
    };
    let crates = persisted
        .get("state")
        .and_then(|state| state.get("smartCrates"))
        .and_then(Value::as_array)
        .ok_or_else(|| "The Smart Crates payload is not valid persisted state".to_string())?;
    if crates.len() > 10_000 {
        return Err("The Smart Crates payload is too large".to_string());
    }
    Ok((smart_crates_json.to_string(), crates.len()))
}

fn count_table(conn: &Connection, table: &str) -> Result<u64, String> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    conn.query_row(&sql, [], |row| row.get::<_, i64>(0))
        .map_err(db_error)
        .and_then(|count| u64::try_from(count).map_err(|error| error.to_string()))
}

fn collect_artwork_paths(conn: &Connection) -> Result<Vec<PathBuf>, String> {
    let mut paths = HashSet::new();
    let mut add = |candidate: Option<String>| {
        let Some(candidate) = candidate.filter(|value| !value.trim().is_empty()) else {
            return;
        };
        if let Ok(resolved) = absolute_lexical(Path::new(&candidate)) {
            if resolved.is_file() {
                paths.insert(resolved);
            }
        }
    };

    {
        let mut statement = conn
            .prepare("SELECT cover_art_path, cover_art_thumb_path FROM tracks")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .map_err(db_error)?;
        for row in mapped {
            let (full, thumb) = row.map_err(db_error)?;
            add(full);
            add(thumb);
        }
    }
    {
        let mut statement = conn
            .prepare("SELECT full_path, thumb_path FROM album_cover_cache")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .map_err(db_error)?;
        for row in mapped {
            let (full, thumb) = row.map_err(db_error)?;
            add(full);
            add(thumb);
        }
    }
    {
        let mut statement = conn
            .prepare("SELECT profile_json FROM artist_profiles")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        for row in mapped {
            let profile = serde_json::from_str::<Value>(&row.map_err(db_error)?)
                .unwrap_or_else(|_| Value::Object(Map::new()));
            add(profile
                .get("imagePath")
                .and_then(Value::as_str)
                .map(str::to_string));
        }
    }
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn safe_extension(path: &Path) -> String {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return String::new();
    };
    let extension = format!(".{extension}");
    extension.chars().take(12).collect()
}

fn archive_name_for_artwork(path: &Path) -> String {
    let normalized = path.to_string_lossy();
    let hash = Sha256::digest(normalized.as_bytes());
    format!(
        "artwork/files/{}{}",
        hex::encode(hash),
        safe_extension(path)
    )
}

fn create_sqlite_snapshot(source: &Connection, destination: &Path) -> Result<(), String> {
    let mut target = Connection::open(destination).map_err(db_error)?;
    {
        let backup = Backup::new(source, &mut target).map_err(db_error)?;
        backup
            .run_to_completion(64, Duration::from_millis(25), None)
            .map_err(db_error)?;
    }
    target
        .execute("DELETE FROM app_metadata WHERE key = 'library_root'", [])
        .map_err(db_error)?;
    target
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(db_error)?;
    Ok(())
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
}

fn write_zip_bytes(writer: &mut ZipWriter<File>, name: &str, bytes: &[u8]) -> Result<(), String> {
    writer.start_file(name, zip_options()).map_err(zip_error)?;
    writer.write_all(bytes).map_err(|error| error.to_string())
}

fn write_zip_file(writer: &mut ZipWriter<File>, name: &str, path: &Path) -> Result<(), String> {
    writer.start_file(name, zip_options()).map_err(zip_error)?;
    let mut source = File::open(path).map_err(|error| error.to_string())?;
    std::io::copy(&mut source, writer).map_err(|error| error.to_string())?;
    Ok(())
}

fn create_library_backup_impl(
    db_path: &str,
    destination_path: &str,
    settings_json: &str,
    smart_crates_json: &str,
) -> Result<LibraryBackupResult, String> {
    let db_path = absolute_lexical(Path::new(db_path))?;
    let destination = absolute_lexical(Path::new(destination_path))?;
    let source = open_database(&db_path)?;
    let settings_json = sanitize_settings(settings_json)?;
    let (smart_crates_json, smart_crate_count) = validate_smart_crates(smart_crates_json)?;
    let working = WorkingDirectory::create("muro-backup-")?;
    let snapshot_path = working.path.join("muro.db");
    create_sqlite_snapshot(&source, &snapshot_path)?;
    let playlist_state = capture_playlist_state(db_path.to_string_lossy().as_ref())?;
    let playlist_json =
        serde_json::to_vec_pretty(&playlist_state).map_err(|error| error.to_string())?;
    let artwork_paths = collect_artwork_paths(&source)?;
    let artwork_index = artwork_paths
        .iter()
        .map(|path| ArtworkIndexEntry {
            original_path: path.to_string_lossy().into_owned(),
            archive_path: archive_name_for_artwork(path),
        })
        .collect::<Vec<_>>();
    let manifest = BackupManifest {
        format: ARCHIVE_FORMAT.to_string(),
        version: ARCHIVE_VERSION,
        backup_id: Uuid::new_v4().to_string(),
        created_at: current_iso_timestamp()?,
        app: "Muro Music".to_string(),
        database_file: default_database_file(),
        settings_file: default_settings_file(),
        smart_crates_file: default_smart_crates_file(),
        playlist_file: default_playlist_file(),
        artwork_index_file: default_artwork_index_file(),
        counts: BackupCounts {
            tracks: count_table(&source, "tracks")?,
            playlists: count_table(&source, "playlists")?,
            playlist_folders: count_table(&source, "playlist_folders")?,
            playlist_entries: count_table(&source, "playlist_tracks")?,
            artwork_files: artwork_index.len() as u64,
            smart_crates: smart_crate_count as u64,
        },
    };

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let file = File::create(&destination).map_err(|error| error.to_string())?;
    let mut writer = ZipWriter::new(file);
    write_zip_file(&mut writer, "database/muro.db", &snapshot_path)?;
    write_zip_bytes(&mut writer, "playlists/playlists.json", &playlist_json)?;
    write_zip_bytes(
        &mut writer,
        "settings/muro-settings.json",
        settings_json.as_bytes(),
    )?;
    write_zip_bytes(
        &mut writer,
        "settings/muro-smart-crates.json",
        smart_crates_json.as_bytes(),
    )?;
    for (path, index) in artwork_paths.iter().zip(&artwork_index) {
        write_zip_file(&mut writer, &index.archive_path, path)?;
    }
    write_zip_bytes(
        &mut writer,
        "artwork/index.json",
        &serde_json::to_vec_pretty(&artwork_index).map_err(|error| error.to_string())?,
    )?;
    write_zip_bytes(
        &mut writer,
        "manifest.json",
        &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;
    writer.finish().map_err(zip_error)?;
    let bytes = fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    Ok(LibraryBackupResult {
        destination_path: destination.to_string_lossy().into_owned(),
        manifest,
        bytes,
    })
}

/// Create a portable, versioned backup without exposing API keys or host paths.
#[tauri::command(rename_all = "camelCase")]
pub async fn create_library_backup(
    db_path: String,
    destination_path: String,
    settings_json: String,
    smart_crates_json: String,
) -> Result<LibraryBackupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_library_backup_impl(
            &db_path,
            &destination_path,
            &settings_json,
            &smart_crates_json,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn validate_manifest(manifest: &BackupManifest) -> Result<(), String> {
    if manifest.format != ARCHIVE_FORMAT
        || !matches!(manifest.version, 1 | 2 | ARCHIVE_VERSION)
        || Uuid::parse_str(&manifest.backup_id).is_err()
    {
        return Err("This is not a supported Muro library backup".to_string());
    }
    Ok(())
}

fn unsafe_archive_name(name: &str) -> bool {
    name.is_empty()
        || name.contains('\0')
        || name.starts_with('/')
        || name.starts_with('\\')
        || name
            .split(['/', '\\'])
            .any(|component| matches!(component, ".." | "."))
}

fn validate_archive(archive: &mut ZipArchive<File>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("The backup contains too many files".to_string());
    }
    let mut total = 0_u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(zip_error)?;
        let name = entry.name().to_string();
        if entry.enclosed_name().is_none() || unsafe_archive_name(&name) {
            return Err(format!("Backup contains an unsafe path: {name}"));
        }
        if !names.insert(name.clone()) {
            return Err(format!("Backup contains duplicate entry: {name}"));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| "The backup is too large".to_string())?;
        if total > MAX_ARCHIVE_BYTES {
            return Err("The backup is too large".to_string());
        }
    }
    Ok(())
}

fn read_zip_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
    max_bytes: u64,
    required: bool,
) -> Result<Option<Vec<u8>>, String> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) if !required => return Ok(None),
        Err(zip::result::ZipError::FileNotFound) => {
            return Err(format!("Backup is missing {name}"));
        }
        Err(error) => return Err(zip_error(error)),
    };
    if entry.size() > max_bytes {
        return Err(format!("Backup entry is too large: {name}"));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
    entry
        .by_ref()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("Backup entry is too large: {name}"));
    }
    Ok(Some(bytes))
}

fn extract_zip_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
    destination: &Path,
    max_bytes: u64,
) -> Result<(), String> {
    let mut entry = archive.by_name(name).map_err(|error| match error {
        zip::result::ZipError::FileNotFound => format!("Backup is missing {name}"),
        other => other.to_string(),
    })?;
    if entry.size() > max_bytes {
        return Err(format!("Backup entry is too large: {name}"));
    }
    let mut output = File::create(destination).map_err(|error| error.to_string())?;
    let copied = std::io::copy(&mut entry.by_ref().take(max_bytes + 1), &mut output)
        .map_err(|error| error.to_string())?;
    if copied > max_bytes {
        return Err(format!("Backup entry is too large: {name}"));
    }
    output.sync_all().map_err(|error| error.to_string())
}

fn path_key(path: &Path) -> Result<String, String> {
    let value = absolute_lexical(path)?.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    })
}

fn restored_extension(archive_path: &str) -> String {
    let extension = safe_extension(Path::new(archive_path));
    if extension.strip_prefix('.').is_some_and(|value| {
        value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    }) {
        extension
    } else {
        String::new()
    }
}

fn remap_path(value: Option<String>, artwork_map: &HashMap<String, PathBuf>) -> Option<String> {
    value.map(|path| {
        path_key(Path::new(&path))
            .ok()
            .and_then(|key| artwork_map.get(&key))
            .map(|mapped| mapped.to_string_lossy().into_owned())
            .unwrap_or(path)
    })
}

fn replace_artwork_strings(value: &mut Value, artwork_map: &HashMap<String, PathBuf>) {
    match value {
        Value::String(path) => {
            if let Ok(key) = path_key(Path::new(path)) {
                if let Some(mapped) = artwork_map.get(&key) {
                    *path = mapped.to_string_lossy().into_owned();
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                replace_artwork_strings(item, artwork_map);
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                replace_artwork_strings(item, artwork_map);
            }
        }
        _ => {}
    }
}

fn restore_artwork_references(
    conn: &Connection,
    artwork_map: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    let tracks = {
        let mut statement = conn
            .prepare("SELECT id, cover_art_path, cover_art_thumb_path FROM tracks")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut update_track = conn
        .prepare("UPDATE tracks SET cover_art_path = ?1, cover_art_thumb_path = ?2 WHERE id = ?3")
        .map_err(db_error)?;
    for (id, full, thumb) in tracks {
        update_track
            .execute(params![
                remap_path(full, artwork_map),
                remap_path(thumb, artwork_map),
                id
            ])
            .map_err(db_error)?;
    }

    let albums = {
        let mut statement = conn
            .prepare("SELECT cover_key, full_path, thumb_path FROM album_cover_cache")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut update_album = conn
        .prepare(
            "UPDATE album_cover_cache SET full_path = ?1, thumb_path = ?2 WHERE cover_key = ?3",
        )
        .map_err(db_error)?;
    for (key, full, thumb) in albums {
        update_album
            .execute(params![
                remap_path(full, artwork_map),
                remap_path(thumb, artwork_map),
                key
            ])
            .map_err(db_error)?;
    }

    let artists = {
        let mut statement = conn
            .prepare("SELECT artist_key, profile_json FROM artist_profiles")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut update_artist = conn
        .prepare("UPDATE artist_profiles SET profile_json = ?1 WHERE artist_key = ?2")
        .map_err(db_error)?;
    for (key, profile_json) in artists {
        if let Ok(mut profile) = serde_json::from_str::<Value>(&profile_json) {
            replace_artwork_strings(&mut profile, artwork_map);
            update_artist
                .execute(params![
                    serde_json::to_string(&profile).map_err(|error| error.to_string())?,
                    key
                ])
                .map_err(db_error)?;
        }
    }
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn restore_library_backup_impl(
    db_path: &str,
    archive_path: &str,
    artwork_root: &Path,
) -> Result<LibraryRestoreResult, String> {
    let db_path = absolute_lexical(Path::new(db_path))?;
    let archive_path = absolute_lexical(Path::new(archive_path))?;
    let archive_file = File::open(&archive_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(archive_file).map_err(zip_error)?;
    validate_archive(&mut archive)?;
    let manifest_bytes = read_zip_entry(&mut archive, "manifest.json", MAX_MANIFEST_BYTES, true)?
        .ok_or_else(|| "Backup is missing manifest.json".to_string())?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "This is not a supported Muro library backup".to_string())?;
    validate_manifest(&manifest)?;
    let settings_json = read_zip_entry(
        &mut archive,
        "settings/muro-settings.json",
        MAX_SETTINGS_BYTES as u64,
        false,
    )?
    .map(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
    .transpose()?
    .unwrap_or_default();
    let settings_json = sanitize_settings(&settings_json)?;
    let smart_crates_json = read_zip_entry(
        &mut archive,
        "settings/muro-smart-crates.json",
        MAX_SMART_CRATES_BYTES as u64,
        false,
    )?
    .map(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
    .transpose()?
    .unwrap_or_default();
    let (smart_crates_json, _) = validate_smart_crates(&smart_crates_json)?;
    let artwork_index = read_zip_entry(
        &mut archive,
        "artwork/index.json",
        MAX_ARTWORK_INDEX_BYTES,
        false,
    )?
    .map(|bytes| serde_json::from_slice::<Vec<ArtworkIndexEntry>>(&bytes).unwrap_or_default())
    .unwrap_or_default();

    let working = WorkingDirectory::create("muro-restore-")?;
    let restored_db_path = working.path.join("muro.db");
    extract_zip_entry(
        &mut archive,
        "database/muro.db",
        &restored_db_path,
        MAX_DATABASE_BYTES,
    )?;
    let validation = Connection::open_with_flags(
        &restored_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(db_error)?;
    let integrity: String = validation
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(db_error)?;
    if integrity != "ok" {
        return Err(format!(
            "Backup database integrity check failed: {integrity}"
        ));
    }
    drop(validation);

    let restore_root = absolute_lexical(artwork_root)?
        .join("restored-artwork")
        .join(&manifest.backup_id);
    let mut artwork_map = HashMap::new();
    for (index, item) in artwork_index.iter().enumerate() {
        if !item.archive_path.starts_with("artwork/files/")
            || unsafe_archive_name(&item.archive_path)
        {
            continue;
        }
        let extension = restored_extension(&item.archive_path);
        let restored_path = restore_root.join(format!("{index:05}{extension}"));
        if let Some(parent) = restored_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        match extract_zip_entry(
            &mut archive,
            &item.archive_path,
            &restored_path,
            MAX_ARTWORK_BYTES,
        ) {
            Ok(()) => {
                if let Ok(key) = path_key(Path::new(&item.original_path)) {
                    artwork_map.insert(key, restored_path);
                }
            }
            Err(error) if error.starts_with("Backup is missing ") => {}
            Err(error) => return Err(error),
        }
    }

    let current_library_root = if db_path.exists() {
        let current = open_database(&db_path)?;
        current
            .query_row(
                "SELECT value FROM app_metadata WHERE key = 'library_root'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
    } else {
        None
    };
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let recovery_path = PathBuf::from(format!(
        "{}.before-restore-{}.bak",
        db_path.to_string_lossy(),
        current_epoch_millis()?
    ));
    remove_file_if_exists(&PathBuf::from(format!("{}-wal", db_path.to_string_lossy())))?;
    remove_file_if_exists(&PathBuf::from(format!("{}-shm", db_path.to_string_lossy())))?;
    let mut original_moved = false;

    let replacement = (|| -> Result<(), String> {
        if db_path.exists() {
            fs::rename(&db_path, &recovery_path).map_err(|error| error.to_string())?;
            original_moved = true;
        }
        fs::rename(&restored_db_path, &db_path).map_err(|error| error.to_string())?;
        let mut restored = open_database(&db_path)?;
        let transaction = restored.transaction().map_err(db_error)?;
        restore_artwork_references(&transaction, &artwork_map)?;
        if let Some(library_root) = &current_library_root {
            transaction
                .execute(
                    r#"
INSERT INTO app_metadata(key, value) VALUES ('library_root', ?1)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
"#,
                    [library_root],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    })();

    if let Err(error) = replacement {
        let _ = remove_file_if_exists(&db_path);
        let _ = remove_file_if_exists(&PathBuf::from(format!("{}-wal", db_path.to_string_lossy())));
        let _ = remove_file_if_exists(&PathBuf::from(format!("{}-shm", db_path.to_string_lossy())));
        if original_moved && recovery_path.exists() {
            fs::rename(&recovery_path, &db_path).map_err(|rollback| {
                format!("{error}; restoring the recovery database failed: {rollback}")
            })?;
        }
        return Err(error);
    }

    Ok(LibraryRestoreResult {
        archive_path: archive_path.to_string_lossy().into_owned(),
        recovery_path: original_moved.then(|| recovery_path.to_string_lossy().into_owned()),
        settings_json,
        smart_crates_json,
        manifest,
        restored_artwork_files: artwork_map.len(),
    })
}

/// Restore a backup and keep the replaced database as a recovery copy.
#[tauri::command(rename_all = "camelCase")]
pub async fn restore_library_backup(
    app: tauri::AppHandle,
    db_path: String,
    archive_path: String,
) -> Result<LibraryRestoreResult, String> {
    let artwork_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        restore_library_backup_impl(&db_path, &archive_path, &artwork_root)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot {
        path: PathBuf,
    }

    impl TestRoot {
        fn new() -> Result<Self, String> {
            let path = std::env::temp_dir().join(format!("muro-backup-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            Ok(Self { path })
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) -> Result<(), String> {
        let file = File::create(path).map_err(|error| error.to_string())?;
        let mut writer = ZipWriter::new(file);
        for (name, bytes) in entries {
            write_zip_bytes(&mut writer, name, bytes)?;
        }
        writer.finish().map_err(zip_error)?;
        Ok(())
    }

    #[test]
    fn redacts_secrets_and_host_paths_from_settings() -> Result<(), String> {
        let sanitized = sanitize_settings(
            r#"{"state":{"theme":"dark","braveSearchApiKey":"secret","watchedFolder":"C:\\Music","watchedFolders":["C:\\Old"]},"version":4}"#,
        )?;
        let parsed: Value = serde_json::from_str(&sanitized).map_err(|error| error.to_string())?;
        assert_eq!(parsed["state"]["theme"], "dark");
        assert!(parsed["state"].get("braveSearchApiKey").is_none());
        assert!(parsed["state"].get("watchedFolder").is_none());
        assert!(parsed["state"].get("watchedFolders").is_none());
        Ok(())
    }

    #[test]
    fn rejects_invalid_manifests_and_traversal_entries() -> Result<(), String> {
        let manifest = BackupManifest {
            format: "not-muro".to_string(),
            version: 3,
            backup_id: Uuid::new_v4().to_string(),
            created_at: String::new(),
            app: String::new(),
            database_file: default_database_file(),
            settings_file: default_settings_file(),
            smart_crates_file: default_smart_crates_file(),
            playlist_file: default_playlist_file(),
            artwork_index_file: default_artwork_index_file(),
            counts: BackupCounts::default(),
        };
        assert_eq!(
            validate_manifest(&manifest).unwrap_err(),
            "This is not a supported Muro library backup"
        );

        let root = TestRoot::new()?;
        let archive_path = root.path.join("unsafe.murobackup");
        write_test_zip(&archive_path, &[("../outside", b"bad")])?;
        let file = File::open(&archive_path).map_err(|error| error.to_string())?;
        let mut archive = ZipArchive::new(file).map_err(zip_error)?;
        assert!(validate_archive(&mut archive)
            .unwrap_err()
            .contains("unsafe path"));
        assert!(!root.path.join("outside").exists());
        Ok(())
    }

    #[test]
    fn creates_and_restores_a_portable_round_trip() -> Result<(), String> {
        let root = TestRoot::new()?;
        let db_path = root.path.join("library.db");
        let artwork = root.path.join("cover.png");
        fs::write(&artwork, b"png artwork").map_err(|error| error.to_string())?;
        let conn = open_database(&db_path)?;
        conn.execute(
            "INSERT INTO app_metadata(key, value) VALUES ('library_root', ?1)",
            [root.path.join("Original Music").to_string_lossy().as_ref()],
        )
        .map_err(db_error)?;
        conn.execute(
            r#"
INSERT INTO tracks(
 id, title, artist, album, source_path, import_status, cover_art_path, added_at
) VALUES ('track-1', 'Original title', 'Artist', 'Album', 'song.flac', 'accepted', ?1, 1)
"#,
            [artwork.to_string_lossy().as_ref()],
        )
        .map_err(db_error)?;
        conn.execute(
            "INSERT INTO playlists(id, name, sort_order, created_at) VALUES ('playlist-1', 'Mix', 0, 1)",
            [],
        )
        .map_err(db_error)?;
        conn.execute(
            "INSERT INTO playlist_tracks(playlist_id, track_id, position) VALUES ('playlist-1', 'track-1', 0)",
            [],
        )
        .map_err(db_error)?;
        drop(conn);

        let backup_path = root.path.join("library.murobackup");
        let backup = create_library_backup_impl(
            db_path.to_string_lossy().as_ref(),
            backup_path.to_string_lossy().as_ref(),
            r#"{"state":{"theme":"dark","acoustIdClientKey":"secret"},"version":4}"#,
            r#"{"state":{"smartCrates":[{"id":"crate-1"}]},"version":0}"#,
        )?;
        assert_eq!(backup.manifest.version, 3);
        assert_eq!(backup.manifest.counts.tracks, 1);
        assert_eq!(backup.manifest.counts.playlists, 1);
        assert_eq!(backup.manifest.counts.artwork_files, 1);
        assert_eq!(backup.manifest.counts.smart_crates, 1);

        let conn = open_database(&db_path)?;
        conn.execute("UPDATE tracks SET title = 'After backup'", [])
            .map_err(db_error)?;
        let destination_root = root.path.join("Destination Music");
        conn.execute(
            "UPDATE app_metadata SET value = ?1 WHERE key = 'library_root'",
            [destination_root.to_string_lossy().as_ref()],
        )
        .map_err(db_error)?;
        drop(conn);

        let restored = restore_library_backup_impl(
            db_path.to_string_lossy().as_ref(),
            backup_path.to_string_lossy().as_ref(),
            &root.path.join("App Data"),
        )?;
        assert!(restored
            .recovery_path
            .as_ref()
            .is_some_and(|path| Path::new(path).is_file()));
        assert_eq!(restored.restored_artwork_files, 1);
        assert!(restored.settings_json.contains("dark"));
        assert!(!restored.settings_json.contains("secret"));
        assert!(restored.smart_crates_json.contains("crate-1"));

        let restored_db = open_database(&db_path)?;
        let title: String = restored_db
            .query_row("SELECT title FROM tracks WHERE id = 'track-1'", [], |row| {
                row.get(0)
            })
            .map_err(db_error)?;
        assert_eq!(title, "Original title");
        let library_root: String = restored_db
            .query_row(
                "SELECT value FROM app_metadata WHERE key = 'library_root'",
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        assert_eq!(library_root, destination_root.to_string_lossy());
        let restored_artwork: String = restored_db
            .query_row(
                "SELECT cover_art_path FROM tracks WHERE id = 'track-1'",
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        assert!(Path::new(&restored_artwork).is_file());

        let file = File::open(&backup_path).map_err(|error| error.to_string())?;
        let mut archive = ZipArchive::new(file).map_err(zip_error)?;
        let working = WorkingDirectory::create("muro-portable-check-")?;
        let snapshot = working.path.join("snapshot.db");
        extract_zip_entry(
            &mut archive,
            "database/muro.db",
            &snapshot,
            MAX_DATABASE_BYTES,
        )?;
        let snapshot_db = Connection::open(snapshot).map_err(db_error)?;
        let archived_root: Option<String> = snapshot_db
            .query_row(
                "SELECT value FROM app_metadata WHERE key = 'library_root'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        assert!(archived_root.is_none());
        Ok(())
    }
}
