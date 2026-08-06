//! Native playlist-file scanning, parsing, import matching, and M3U8 export.
//!
//! DTO names intentionally follow the Electron bridge: scan/export objects use
//! camelCase, while imported playlist rows retain their established snake_case
//! fields consumed by `importedTrackToTrack` and `usePlaylistTransfer`.

#[cfg(test)]
use rusqlite::params;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;
use url::Url;

use super::database::{ensure_schema, normalize_library_root, resolve_stored_track_path};

const PLAYLIST_EXTENSIONS: [&str; 3] = ["m3u", "m3u8", "pls"];
const AUDIO_EXTENSIONS: [&str; 10] = [
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "alac",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistScanEntry {
    pub path: String,
    pub relative_path: String,
    pub folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistScanFolder {
    pub path: String,
    pub name: String,
    pub parent_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistFolderImportScan {
    pub name: String,
    pub audio_file_count: usize,
    pub files: Vec<String>,
    pub entries: Vec<PlaylistScanEntry>,
    pub folders: Vec<PlaylistScanFolder>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportedPlaylistEntry {
    pub path: String,
    pub track_id: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportedPlaylistFile {
    pub name: String,
    pub source_path: String,
    pub entries: Vec<ImportedPlaylistEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistExportResult {
    pub exported: usize,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCollectionExportResult {
    pub export_root: String,
    pub playlists_exported: usize,
    pub playlist_entries_exported: usize,
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
struct PlaylistTrackRow {
    source_path: String,
    duration_seconds: Option<f64>,
    artist: Option<String>,
    title: Option<String>,
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn io_error(error: std::io::Error) -> String {
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
    let stored = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key = 'library_root'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    Ok(normalize_library_root(stored.as_deref()))
}

fn extension_lowercase(path: &Path) -> String {
    path.extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_lowercase()
}

fn is_playlist_file(path: &Path) -> bool {
    PLAYLIST_EXTENSIONS.contains(&extension_lowercase(path).as_str())
}

fn is_audio_file(path: &Path) -> bool {
    AUDIO_EXTENSIONS.contains(&extension_lowercase(path).as_str())
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

fn normalized_path_key(path: &Path) -> Result<String, String> {
    let value = absolute_lexical(path)?.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    })
}

fn slash_relative(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|error| error.to_string())
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn scan_directory(
    directory: &Path,
    playlist_files: &mut Vec<PathBuf>,
    audio_file_count: &mut usize,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    entries.sort_by(|left, right| {
        left.file_name()
            .to_string_lossy()
            .cmp(&right.file_name().to_string_lossy())
    });
    for entry in entries {
        let file_type = entry.file_type().map_err(io_error)?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            scan_directory(&path, playlist_files, audio_file_count)?;
        } else if file_type.is_file() {
            if is_playlist_file(&path) {
                playlist_files.push(path.clone());
            }
            if is_audio_file(&path) {
                *audio_file_count += 1;
            }
        }
    }
    Ok(())
}

fn list_playlist_files_impl(directory_path: &Path) -> Result<PlaylistFolderImportScan, String> {
    let root = absolute_lexical(directory_path)?;
    if !fs::metadata(&root).map_err(io_error)?.is_dir() {
        return Err("Playlist import path is not a directory".to_string());
    }
    let mut files = Vec::new();
    let mut audio_file_count = 0;
    scan_directory(&root, &mut files, &mut audio_file_count)?;
    files.sort_by_key(|path| slash_relative(&root, path).unwrap_or_default());

    let mut entries = Vec::with_capacity(files.len());
    let mut folder_paths = HashSet::new();
    for file_path in &files {
        let relative_path = slash_relative(&root, file_path)?;
        let parent = Path::new(&relative_path)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        if let Some(folder_path) = &parent {
            let segments = folder_path.split('/').collect::<Vec<_>>();
            for end in 1..=segments.len() {
                folder_paths.insert(segments[..end].join("/"));
            }
        }
        entries.push(PlaylistScanEntry {
            path: file_path.to_string_lossy().into_owned(),
            relative_path,
            folder_path: parent,
        });
    }

    let mut folder_paths = folder_paths.into_iter().collect::<Vec<_>>();
    folder_paths.sort_by(|left, right| {
        left.split('/')
            .count()
            .cmp(&right.split('/').count())
            .then_with(|| left.cmp(right))
    });
    let folders = folder_paths
        .into_iter()
        .map(|path| {
            let mut segments = path.split('/').collect::<Vec<_>>();
            let name = segments.pop().unwrap_or_default().to_string();
            let parent_path = (!segments.is_empty()).then(|| segments.join("/"));
            PlaylistScanFolder {
                path,
                name,
                parent_path,
            }
        })
        .collect();
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    Ok(PlaylistFolderImportScan {
        name,
        audio_file_count,
        files: files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        entries,
        folders,
    })
}

/// Recursively list importable playlists and their folder hierarchy.
#[tauri::command(rename_all = "camelCase")]
pub fn list_playlist_files(directory_path: String) -> Result<PlaylistFolderImportScan, String> {
    list_playlist_files_impl(Path::new(&directory_path))
}

fn decode_playlist_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        let decoded = String::from_utf8_lossy(bytes);
        decoded
            .strip_prefix('\u{feff}')
            .unwrap_or(decoded.as_ref())
            .to_string()
    }
}

fn unquote(value: &str) -> &str {
    let value = value.strip_prefix('"').unwrap_or(value);
    value.strip_suffix('"').unwrap_or(value)
}

fn file_url_path(value: &str) -> Option<PathBuf> {
    let mut url = Url::parse(value).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    if url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("localhost"))
    {
        url.set_host(None).ok()?;
    }
    url.to_file_path().ok()
}

fn resolve_playlist_entry(entry: &str, playlist_directory: &Path) -> Option<PathBuf> {
    let trimmed = unquote(entry.trim());
    if trimmed.is_empty() {
        return None;
    }
    if trimmed
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
    {
        return file_url_path(trimmed).and_then(|path| absolute_lexical(&path).ok());
    }
    absolute_lexical(&if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        playlist_directory.join(trimmed)
    })
    .ok()
}

fn pls_entry(line: &str) -> Option<&str> {
    let (key, value) = line.split_once('=')?;
    if key.len() <= 4
        || !key
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("File"))
    {
        return None;
    }
    key[4..]
        .chars()
        .all(|character| character.is_ascii_digit())
        .then_some(value)
}

fn parse_playlist_file_impl(file_path: &Path) -> Result<Vec<PathBuf>, String> {
    let resolved = absolute_lexical(file_path)?;
    if !is_playlist_file(&resolved) {
        return Err("Unsupported playlist format".to_string());
    }
    let bytes = fs::read(&resolved).map_err(io_error)?;
    let text = decode_playlist_text(&bytes);
    let is_pls = extension_lowercase(&resolved) == "pls";
    let directory = resolved.parent().unwrap_or_else(|| Path::new(""));
    Ok(text
        .lines()
        .filter_map(|line| {
            if is_pls {
                pls_entry(line.trim())
            } else {
                let line = line.trim();
                (!line.is_empty() && !line.starts_with('#')).then_some(line)
            }
        })
        .filter_map(|entry| resolve_playlist_entry(entry, directory))
        .collect())
}

fn import_playlist_file_impl(
    conn: &Connection,
    file_path: &Path,
) -> Result<ImportedPlaylistFile, String> {
    let resolved = absolute_lexical(file_path)?;
    let parsed_entries = parse_playlist_file_impl(&resolved)?;
    let library_root = effective_library_root(conn)?;
    let mut statement = conn
        .prepare("SELECT id, source_path FROM tracks")
        .map_err(db_error)?;
    let mapped = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    let rows = mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
    let mut track_id_by_path = HashMap::new();
    for (id, stored_path) in rows {
        if let Ok(path) = resolve_stored_track_path(&stored_path, library_root.as_deref()) {
            if let Ok(key) = normalized_path_key(&path) {
                track_id_by_path.insert(key, id);
            }
        }
    }
    let entries = parsed_entries
        .into_iter()
        .map(|path| {
            let track_id = normalized_path_key(&path)
                .ok()
                .and_then(|key| track_id_by_path.get(&key).cloned());
            ImportedPlaylistEntry {
                exists: path.exists(),
                path: path.to_string_lossy().into_owned(),
                track_id,
            }
        })
        .collect();
    Ok(ImportedPlaylistFile {
        name: resolved
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        source_path: resolved.to_string_lossy().into_owned(),
        entries,
    })
}

/// Parse an M3U/M3U8/PLS file and match its entries to library tracks.
#[tauri::command(rename_all = "camelCase")]
pub fn import_playlist_file(
    db_path: String,
    file_path: String,
) -> Result<ImportedPlaylistFile, String> {
    let conn = open_database(&db_path)?;
    import_playlist_file_impl(&conn, Path::new(&file_path))
}

fn playlist_text(value: Option<&str>, fallback: &str) -> String {
    let raw = value.filter(|value| !value.is_empty()).unwrap_or(fallback);
    let mut result = String::new();
    let mut replacing_newline = false;
    for character in raw.chars() {
        if matches!(character, '\r' | '\n') {
            if !replacing_newline {
                result.push(' ');
            }
            replacing_newline = true;
        } else {
            result.push(character);
            replacing_newline = false;
        }
    }
    let trimmed = result.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn extinf_duration(duration: Option<f64>) -> i64 {
    let value = duration.filter(|value| *value != 0.0).unwrap_or(-1.0);
    (value.round() as i64).max(-1)
}

fn m3u8_text(rows: &[PlaylistTrackRow], root: Option<&Path>) -> Result<String, String> {
    let mut lines = vec!["#EXTM3U".to_string()];
    for row in rows {
        let artist = playlist_text(row.artist.as_deref(), "Unknown Artist");
        let title = playlist_text(row.title.as_deref(), "Unknown Title");
        let source_path = resolve_stored_track_path(&row.source_path, root)?;
        lines.push(format!(
            "#EXTINF:{},{} - {}",
            extinf_duration(row.duration_seconds),
            artist,
            title
        ));
        lines.push(source_path.to_string_lossy().into_owned());
    }
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

fn playlist_tracks(conn: &Connection, playlist_id: &str) -> Result<Vec<PlaylistTrackRow>, String> {
    let mut statement = conn
        .prepare(
            r#"
SELECT t.source_path, t.duration_seconds, t.artist, t.title
FROM playlist_tracks pt
JOIN tracks t ON t.id = pt.track_id
WHERE pt.playlist_id = ?1
ORDER BY pt.position ASC
"#,
        )
        .map_err(db_error)?;
    let mapped = statement
        .query_map([playlist_id], |row| {
            Ok(PlaylistTrackRow {
                source_path: row.get(0)?,
                duration_seconds: row.get(1)?,
                artist: row.get(2)?,
                title: row.get(3)?,
            })
        })
        .map_err(db_error)?;
    mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

/// Export one playlist as an absolute-path UTF-8 EXT-M3U8 file.
#[tauri::command(rename_all = "camelCase")]
pub fn export_playlist_file(
    db_path: String,
    playlist_id: String,
    file_path: String,
) -> Result<PlaylistExportResult, String> {
    let conn = open_database(&db_path)?;
    let root = effective_library_root(&conn)?;
    let rows = playlist_tracks(&conn, &playlist_id)?;
    let resolved_output = absolute_lexical(Path::new(&file_path))?;
    if let Some(parent) = resolved_output.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    fs::write(Path::new(&file_path), m3u8_text(&rows, root.as_deref())?).map_err(io_error)?;
    Ok(PlaylistExportResult {
        exported: rows.len(),
        file_path,
    })
}

fn invalid_export_character(character: char) -> bool {
    character <= '\u{1f}'
        || character == '\u{7f}'
        || matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        )
}

fn windows_reserved_name(value: &str) -> bool {
    let lower = value.to_lowercase();
    let stem = lower.split('.').next().unwrap_or_default();
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn sanitize_export_segment(value: &str, fallback: &str) -> String {
    let normalized = value.nfc().collect::<String>();
    let mut invalid_collapsed = String::new();
    let mut replacing_invalid = false;
    for character in normalized.chars() {
        if invalid_export_character(character) {
            if !replacing_invalid {
                invalid_collapsed.push('-');
            }
            replacing_invalid = true;
        } else {
            invalid_collapsed.push(character);
            replacing_invalid = false;
        }
    }
    let mut whitespace_collapsed = String::new();
    let mut replacing_whitespace = false;
    for character in invalid_collapsed.chars() {
        if character.is_whitespace() {
            if !replacing_whitespace {
                whitespace_collapsed.push(' ');
            }
            replacing_whitespace = true;
        } else {
            whitespace_collapsed.push(character);
            replacing_whitespace = false;
        }
    }
    let cleaned = whitespace_collapsed
        .trim()
        .trim_end_matches(|character| matches!(character, ' ' | '.'))
        .chars()
        .take(120)
        .collect::<String>();
    let cleaned = if cleaned.is_empty() || matches!(cleaned.as_str(), "." | "..") {
        fallback.to_string()
    } else {
        cleaned
    };
    if windows_reserved_name(&cleaned) {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

fn portable_export_key(directory: &Path, name: &str) -> String {
    directory
        .join(name)
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn unique_name(directory: &Path, requested_name: &str, used: &mut HashSet<String>) -> String {
    let requested = Path::new(requested_name);
    let stem = requested.file_stem().unwrap_or_default().to_string_lossy();
    let extension = requested
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let mut candidate = requested_name.to_string();
    let mut suffix = 2;
    while used.contains(&portable_export_key(directory, &candidate)) {
        candidate = format!("{stem} ({suffix}){extension}");
        suffix += 1;
    }
    used.insert(portable_export_key(directory, &candidate));
    candidate
}

fn create_named_export_root(destination: &Path, root_name: &str) -> Result<PathBuf, String> {
    let destination = absolute_lexical(destination)?;
    if !fs::metadata(&destination).map_err(io_error)?.is_dir() {
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
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "Could not create a unique {root_name} export folder"
    ))
}

fn load_folders(conn: &Connection) -> Result<Vec<PlaylistFolderRow>, String> {
    let mut statement = conn
        .prepare(
            r#"
SELECT id, name, parent_id
FROM playlist_folders
ORDER BY parent_id, sort_order, name COLLATE NOCASE
"#,
        )
        .map_err(db_error)?;
    let mapped = statement
        .query_map([], |row| {
            Ok(PlaylistFolderRow {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
            })
        })
        .map_err(db_error)?;
    mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn load_playlists(conn: &Connection) -> Result<Vec<PlaylistRow>, String> {
    let mut statement = conn
        .prepare(
            r#"
SELECT id, name, folder_id
FROM playlists
ORDER BY folder_id, sort_order, name COLLATE NOCASE
"#,
        )
        .map_err(db_error)?;
    let mapped = statement
        .query_map([], |row| {
            Ok(PlaylistRow {
                id: row.get(0)?,
                name: row.get(1)?,
                folder_id: row.get(2)?,
            })
        })
        .map_err(db_error)?;
    mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn resolve_folder_path(
    folder_id: &str,
    folder_by_id: &HashMap<String, PlaylistFolderRow>,
    paths: &mut HashMap<String, PathBuf>,
    used: &mut HashSet<String>,
    ancestors: &HashSet<String>,
) -> PathBuf {
    if let Some(path) = paths.get(folder_id) {
        return path.clone();
    }
    let Some(folder) = folder_by_id.get(folder_id) else {
        return PathBuf::new();
    };
    let mut next_ancestors = ancestors.clone();
    next_ancestors.insert(folder_id.to_string());
    let parent_path = folder
        .parent_id
        .as_deref()
        .filter(|parent_id| !next_ancestors.contains(*parent_id))
        .map(|parent_id| resolve_folder_path(parent_id, folder_by_id, paths, used, &next_ancestors))
        .unwrap_or_default();
    let segment = unique_name(
        &parent_path,
        &sanitize_export_segment(&folder.name, "Playlist Folder"),
        used,
    );
    let path = parent_path.join(segment);
    paths.insert(folder_id.to_string(), path.clone());
    path
}

fn build_playlist_folder_paths(folders: &[PlaylistFolderRow]) -> HashMap<String, PathBuf> {
    let folder_by_id = folders
        .iter()
        .cloned()
        .map(|folder| (folder.id.clone(), folder))
        .collect::<HashMap<_, _>>();
    let mut paths = HashMap::new();
    let mut used = HashSet::new();
    for folder in folders {
        resolve_folder_path(
            &folder.id,
            &folder_by_id,
            &mut paths,
            &mut used,
            &HashSet::new(),
        );
    }
    paths
}

/// Export every playlist as M3U8 while preserving the playlist-folder tree.
#[tauri::command(rename_all = "camelCase")]
pub fn export_all_playlists(
    db_path: String,
    destination_path: String,
) -> Result<PlaylistCollectionExportResult, String> {
    let conn = open_database(&db_path)?;
    let root = effective_library_root(&conn)?;
    let folders = load_folders(&conn)?;
    let playlists = load_playlists(&conn)?;
    let export_root = create_named_export_root(Path::new(&destination_path), "Muro Playlists")?;
    let folder_paths = build_playlist_folder_paths(&folders);
    for path in folder_paths.values() {
        fs::create_dir_all(export_root.join(path)).map_err(io_error)?;
    }

    let mut used_playlist_paths = HashSet::new();
    let mut playlist_entries_exported = 0;
    for playlist in &playlists {
        let relative_directory = playlist
            .folder_id
            .as_ref()
            .and_then(|folder_id| folder_paths.get(folder_id))
            .cloned()
            .unwrap_or_default();
        let requested_name = format!(
            "{}.m3u8",
            sanitize_export_segment(&playlist.name, "Playlist")
        );
        let file_name = unique_name(
            &relative_directory,
            &requested_name,
            &mut used_playlist_paths,
        );
        let output = export_root.join(&relative_directory).join(file_name);
        let rows = playlist_tracks(&conn, &playlist.id)?;
        playlist_entries_exported += rows.len();
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::write(output, m3u8_text(&rows, root.as_deref())?).map_err(io_error)?;
    }

    Ok(PlaylistCollectionExportResult {
        export_root: export_root.to_string_lossy().into_owned(),
        playlists_exported: playlists.len(),
        playlist_entries_exported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use uuid::Uuid;

    struct TestRoot {
        path: PathBuf,
    }

    impl TestRoot {
        fn new() -> Result<Self, String> {
            let path = std::env::temp_dir().join(format!("muro-playlists-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).map_err(io_error)?;
            Ok(Self { path })
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_utf16le(path: &Path, text: &str) -> Result<(), String> {
        let mut bytes = vec![0xff, 0xfe];
        for word in text.encode_utf16() {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        fs::write(path, bytes).map_err(io_error)
    }

    fn seed_database(root: &Path) -> Result<(PathBuf, PathBuf), String> {
        let db_path = root.join("library.db");
        let music_root = root.join("Music");
        fs::create_dir_all(&music_root).map_err(io_error)?;
        let song = music_root.join("Artist").join("song.flac");
        fs::create_dir_all(song.parent().unwrap_or(&music_root)).map_err(io_error)?;
        fs::write(&song, b"audio").map_err(io_error)?;
        let conn = open_database(db_path.to_string_lossy().as_ref())?;
        conn.execute(
            "INSERT INTO app_metadata(key, value) VALUES ('library_root', ?1)",
            [music_root.to_string_lossy().as_ref()],
        )
        .map_err(db_error)?;
        conn.execute(
            r#"
INSERT INTO tracks(
 id, title, artist, album, source_path, import_status, duration_seconds, added_at
) VALUES ('track-1', 'Song\nTitle', 'Artist\rName', 'Album', 'Artist/song.flac', 'accepted', 123.6, ?1)
"#,
            [SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_secs() as i64],
        )
        .map_err(db_error)?;
        Ok((db_path, song))
    }

    #[test]
    fn parses_utf8_m3u_and_utf16le_pls() -> Result<(), String> {
        let root = TestRoot::new()?;
        let music = root.path.join("music");
        fs::create_dir_all(&music).map_err(io_error)?;
        let first = music.join("first.flac");
        let second = music.join("second.mp3");
        fs::write(&first, b"one").map_err(io_error)?;
        fs::write(&second, b"two").map_err(io_error)?;
        let file_url = Url::from_file_path(&second)
            .map_err(|_| "could not create file URL".to_string())?
            .to_string();
        let m3u = root.path.join("mix.m3u8");
        fs::write(
            &m3u,
            format!("\u{feff}#EXTM3U\n# ignored\n\"music/first.flac\"\n{file_url}\n"),
        )
        .map_err(io_error)?;
        let parsed = parse_playlist_file_impl(&m3u)?;
        assert_eq!(parsed, vec![first.clone(), second.clone()]);

        let pls = root.path.join("mix.pls");
        write_utf16le(
            &pls,
            "[playlist]\r\nFile1=music/first.flac\r\nTitle1=First\r\nFile2=music/second.mp3\r\n",
        )?;
        assert_eq!(parse_playlist_file_impl(&pls)?, vec![first, second]);
        Ok(())
    }

    #[test]
    fn scans_hierarchy_counts_audio_and_matches_portable_track_paths() -> Result<(), String> {
        let root = TestRoot::new()?;
        let (db_path, song) = seed_database(&root.path)?;
        let lists = root.path.join("Lists");
        let nested = lists.join("Sets").join("Night");
        fs::create_dir_all(&nested).map_err(io_error)?;
        fs::write(lists.join("loose.opus"), b"audio").map_err(io_error)?;
        fs::write(nested.join("ignored.txt"), b"text").map_err(io_error)?;
        let playlist = nested.join("set.m3u");
        fs::write(&playlist, format!("{}\n", song.to_string_lossy())).map_err(io_error)?;

        let scan = list_playlist_files_impl(&lists)?;
        assert_eq!(scan.audio_file_count, 1);
        assert_eq!(scan.files, vec![playlist.to_string_lossy().into_owned()]);
        assert_eq!(scan.entries[0].folder_path.as_deref(), Some("Sets/Night"));
        assert_eq!(
            scan.folders
                .iter()
                .map(|folder| folder.path.as_str())
                .collect::<Vec<_>>(),
            vec!["Sets", "Sets/Night"]
        );

        let conn = open_database(db_path.to_string_lossy().as_ref())?;
        let imported = import_playlist_file_impl(&conn, &playlist)?;
        assert_eq!(imported.name, "set");
        assert_eq!(imported.entries.len(), 1);
        assert_eq!(imported.entries[0].track_id.as_deref(), Some("track-1"));
        assert!(imported.entries[0].exists);
        Ok(())
    }

    #[test]
    fn exports_single_and_collision_safe_nested_playlist_collection() -> Result<(), String> {
        let root = TestRoot::new()?;
        let (db_path, song) = seed_database(&root.path)?;
        let conn = open_database(db_path.to_string_lossy().as_ref())?;
        conn.execute(
            "INSERT INTO playlist_folders(id, name, parent_id, sort_order, created_at) VALUES ('folder-1', 'CON', NULL, 0, 1)",
            [],
        )
        .map_err(db_error)?;
        conn.execute(
            "INSERT INTO playlist_folders(id, name, parent_id, sort_order, created_at) VALUES ('folder-2', 'Nested:*', 'folder-1', 0, 1)",
            [],
        )
        .map_err(db_error)?;
        for (id, order) in [("playlist-1", 0), ("playlist-2", 1)] {
            conn.execute(
                "INSERT INTO playlists(id, name, folder_id, sort_order, created_at) VALUES (?1, 'Mix?', 'folder-2', ?2, 1)",
                params![id, order],
            )
            .map_err(db_error)?;
            conn.execute(
                "INSERT INTO playlist_tracks(playlist_id, track_id, position) VALUES (?1, 'track-1', 0)",
                [id],
            )
            .map_err(db_error)?;
        }
        drop(conn);

        let single = root.path.join("single.m3u8");
        let result = export_playlist_file(
            db_path.to_string_lossy().into_owned(),
            "playlist-1".to_string(),
            single.to_string_lossy().into_owned(),
        )?;
        assert_eq!(result.exported, 1);
        let bytes = fs::read(&single).map_err(io_error)?;
        let expected_path = song.to_string_lossy();
        assert_eq!(
            String::from_utf8_lossy(&bytes),
            format!("#EXTM3U\r\n#EXTINF:124,Artist Name - Song Title\r\n{expected_path}\r\n")
        );

        let destination = root.path.join("Exports");
        fs::create_dir_all(&destination).map_err(io_error)?;
        let collection = export_all_playlists(
            db_path.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
        )?;
        assert_eq!(collection.playlists_exported, 2);
        assert_eq!(collection.playlist_entries_exported, 2);
        let export_root = PathBuf::from(collection.export_root);
        assert!(export_root.ends_with("Muro Playlists"));
        let nested = export_root.join("_CON").join("Nested-");
        assert!(nested.join("Mix-.m3u8").is_file());
        assert!(nested.join("Mix- (2).m3u8").is_file());

        let second = export_all_playlists(
            db_path.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
        )?;
        assert!(PathBuf::from(second.export_root).ends_with("Muro Playlists (2)"));
        Ok(())
    }
}
