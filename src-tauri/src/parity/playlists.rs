//! Native playlist, folder, history, and snapshot persistence.
//!
//! The data model and mutation semantics intentionally mirror the Electron
//! backend.  Public functions accept a database path so they can be wrapped by
//! thin `#[tauri::command]` functions without exposing a SQLite connection to
//! the command layer.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_PLAYLIST_HISTORY: i64 = 100;
const MAX_PLAYLIST_SNAPSHOTS: i64 = 50;
const MAX_STATE_ITEMS: usize = 10_000;

pub type PlaylistResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaylistFolderState {
    pub id: String,
    pub name: String,
    #[serde(rename = "parentId", alias = "parent_id", default)]
    pub parent_id: Option<String>,
    #[serde(rename = "sortOrder", alias = "sort_order", default)]
    pub sort_order: i64,
    #[serde(rename = "createdAt", alias = "created_at", default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaylistStateItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "folderId", alias = "folder_id", default)]
    pub folder_id: Option<String>,
    #[serde(rename = "sortOrder", alias = "sort_order", default)]
    pub sort_order: i64,
    #[serde(rename = "sourcePath", alias = "source_path", default)]
    pub source_path: Option<String>,
    #[serde(rename = "sourceMtimeMs", alias = "source_mtime_ms", default)]
    pub source_mtime_ms: Option<f64>,
    #[serde(rename = "sourceSize", alias = "source_size", default)]
    pub source_size: Option<i64>,
    #[serde(rename = "sourceSyncError", alias = "source_sync_error", default)]
    pub source_sync_error: Option<String>,
    #[serde(rename = "lastSyncedAt", alias = "last_synced_at", default)]
    pub last_synced_at: Option<i64>,
    #[serde(rename = "createdAt", alias = "created_at", default)]
    pub created_at: i64,
    #[serde(rename = "trackIds", alias = "track_ids", default)]
    pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PlaylistState {
    #[serde(default)]
    pub playlists: Vec<PlaylistStateItem>,
    #[serde(default)]
    pub folders: Vec<PlaylistFolderState>,
}

/// Renderer-facing playlist representation.  These field names match the
/// existing Electron `load_playlists` response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistView {
    pub id: String,
    pub name: String,
    pub folder_id: Option<String>,
    pub sort_order: i64,
    pub source_path: Option<String>,
    pub source_mtime_ms: Option<f64>,
    pub source_size: Option<i64>,
    pub source_sync_error: Option<String>,
    pub last_synced_at: Option<i64>,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistFolderView {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCollection {
    pub playlists: Vec<PlaylistView>,
    pub folders: Vec<PlaylistFolderView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CountResult {
    pub deleted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistOrderItem {
    pub id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub action: String,
    pub created_at: String,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList {
    pub entries: Vec<HistoryEntry>,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRestore {
    pub id: i64,
    pub action: String,
    pub state: PlaylistState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSnapshot {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

fn now_unix() -> PlaylistResult<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|error| error.to_string())
}

fn now_iso() -> PlaylistResult<String> {
    let seconds = now_unix()?;
    Ok(chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0)
        .map(|value| value.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| seconds.to_string()))
}

fn open_database(db_path: &str) -> PlaylistResult<Connection> {
    if let Some(parent) = Path::new(db_path).parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    ensure_schema(&connection)?;
    Ok(connection)
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> PlaylistResult<bool> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    for current in columns {
        if current.map_err(|error| error.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> PlaylistResult<()> {
    if !column_exists(connection, table, column)? {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Creates the full Electron-compatible playlist schema and upgrades the
/// earlier Tauri schema in place.
pub fn ensure_schema(connection: &Connection) -> PlaylistResult<()> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS playlist_folders (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               parent_id TEXT REFERENCES playlist_folders(id) ON DELETE SET NULL,
               sort_order INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS playlists (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               folder_id TEXT REFERENCES playlist_folders(id) ON DELETE SET NULL,
               sort_order INTEGER NOT NULL DEFAULT 0,
               source_path TEXT,
               source_mtime_ms REAL,
               source_size INTEGER,
               source_sync_error TEXT,
               last_synced_at INTEGER,
               created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS playlist_tracks (
               playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
               track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
               position INTEGER NOT NULL,
               UNIQUE(playlist_id, track_id)
             );
             CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_idx
               ON playlist_tracks(playlist_id, position);
             CREATE TABLE IF NOT EXISTS playlist_history (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               action TEXT NOT NULL,
               before_json TEXT NOT NULL,
               after_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               undone INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS playlist_history_state_idx
               ON playlist_history(undone, id DESC);
             CREATE TABLE IF NOT EXISTS playlist_snapshots (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               state_json TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS playlist_snapshots_created_idx
               ON playlist_snapshots(created_at DESC);",
        )
        .map_err(|error| error.to_string())?;

    // The original Tauri schema only had id/name/created_at on playlists.
    add_column_if_missing(connection, "playlists", "folder_id", "TEXT")?;
    add_column_if_missing(
        connection,
        "playlists",
        "sort_order",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(connection, "playlists", "source_path", "TEXT")?;
    add_column_if_missing(connection, "playlists", "source_mtime_ms", "REAL")?;
    add_column_if_missing(connection, "playlists", "source_size", "INTEGER")?;
    add_column_if_missing(connection, "playlists", "source_sync_error", "TEXT")?;
    add_column_if_missing(connection, "playlists", "last_synced_at", "INTEGER")?;
    Ok(())
}

fn capture_state(connection: &Connection) -> PlaylistResult<PlaylistState> {
    let mut folder_statement = connection
        .prepare(
            "SELECT id, name, parent_id, sort_order, created_at
             FROM playlist_folders ORDER BY parent_id, sort_order, id",
        )
        .map_err(|error| error.to_string())?;
    let folders = folder_statement
        .query_map([], |row| {
            Ok(PlaylistFolderState {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut playlist_statement = connection
        .prepare(
            "SELECT id, name, folder_id, sort_order, source_path, source_mtime_ms,
                    source_size, source_sync_error, last_synced_at, created_at
             FROM playlists ORDER BY folder_id, sort_order, id",
        )
        .map_err(|error| error.to_string())?;
    let mut playlists = playlist_statement
        .query_map([], |row| {
            Ok(PlaylistStateItem {
                id: row.get(0)?,
                name: row.get(1)?,
                folder_id: row.get(2)?,
                sort_order: row.get(3)?,
                source_path: row.get(4)?,
                source_mtime_ms: row.get(5)?,
                source_size: row.get(6)?,
                source_sync_error: row.get(7)?,
                last_synced_at: row.get(8)?,
                created_at: row.get(9)?,
                track_ids: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut track_statement = connection
        .prepare(
            "SELECT track_id FROM playlist_tracks
             WHERE playlist_id = ?1 ORDER BY position ASC",
        )
        .map_err(|error| error.to_string())?;
    for playlist in &mut playlists {
        playlist.track_ids = track_statement
            .query_map([&playlist.id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
    }
    Ok(PlaylistState { playlists, folders })
}

/// Captures the complete persisted playlist state used by undo/redo and
/// snapshots.
pub fn capture_playlist_state(db_path: &str) -> PlaylistResult<PlaylistState> {
    let connection = open_database(db_path)?;
    capture_state(&connection)
}

fn clean_name(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn apply_state_changes(connection: &Connection, state: &PlaylistState) -> PlaylistResult<()> {
    if state.playlists.len() > MAX_STATE_ITEMS || state.folders.len() > MAX_STATE_ITEMS {
        return Err("Playlist state is too large".to_string());
    }
    let mut existing_tracks = HashSet::new();
    {
        let mut statement = connection
            .prepare("SELECT id FROM tracks")
            .map_err(|error| error.to_string())?;
        for id in statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
        {
            existing_tracks.insert(id.map_err(|error| error.to_string())?);
        }
    }
    let folder_ids: HashSet<&str> = state
        .folders
        .iter()
        .map(|folder| folder.id.as_str())
        .collect();

    connection
        .execute_batch(
            "DELETE FROM playlist_tracks;
             DELETE FROM playlists;
             DELETE FROM playlist_folders;",
        )
        .map_err(|error| error.to_string())?;

    let now = now_unix()?;
    for folder in &state.folders {
        connection
            .execute(
                "INSERT INTO playlist_folders(id, name, parent_id, sort_order, created_at)
                 VALUES (?1, ?2, NULL, ?3, ?4)",
                params![
                    folder.id,
                    clean_name(&folder.name, "Playlist Folder"),
                    folder.sort_order,
                    if folder.created_at == 0 {
                        now
                    } else {
                        folder.created_at
                    }
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    for folder in &state.folders {
        if let Some(parent_id) = folder.parent_id.as_deref() {
            if parent_id != folder.id && folder_ids.contains(parent_id) {
                connection
                    .execute(
                        "UPDATE playlist_folders SET parent_id = ?1 WHERE id = ?2",
                        params![parent_id, folder.id],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    for playlist in &state.playlists {
        let folder_id = playlist
            .folder_id
            .as_deref()
            .filter(|id| folder_ids.contains(*id));
        connection
            .execute(
                "INSERT INTO playlists(
                   id, name, folder_id, sort_order, source_path, source_mtime_ms,
                   source_size, source_sync_error, last_synced_at, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    playlist.id,
                    clean_name(&playlist.name, "Playlist"),
                    folder_id,
                    playlist.sort_order,
                    playlist.source_path,
                    playlist.source_mtime_ms,
                    playlist.source_size,
                    playlist.source_sync_error,
                    playlist.last_synced_at,
                    if playlist.created_at == 0 {
                        now
                    } else {
                        playlist.created_at
                    }
                ],
            )
            .map_err(|error| error.to_string())?;
        let mut seen = HashSet::new();
        let mut position = 0_i64;
        for track_id in &playlist.track_ids {
            if existing_tracks.contains(track_id) && seen.insert(track_id) {
                connection
                    .execute(
                        "INSERT INTO playlist_tracks(playlist_id, track_id, position)
                         VALUES (?1, ?2, ?3)",
                        params![playlist.id, track_id, position],
                    )
                    .map_err(|error| error.to_string())?;
                position += 1;
            }
        }
    }
    Ok(())
}

/// Replaces playlists/folders transactionally, filtering references to tracks
/// which are no longer in the library.
pub fn apply_playlist_state(db_path: &str, state: PlaylistState) -> PlaylistResult<()> {
    let mut connection = open_database(db_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    apply_state_changes(&transaction, &state)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn with_history<T, F>(connection: &mut Connection, action: &str, mutation: F) -> PlaylistResult<T>
where
    F: FnOnce(&Transaction<'_>) -> PlaylistResult<T>,
{
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let before = capture_state(&transaction)?;
    let result = mutation(&transaction)?;
    let after = capture_state(&transaction)?;
    let before_json = serde_json::to_string(&before).map_err(|error| error.to_string())?;
    let after_json = serde_json::to_string(&after).map_err(|error| error.to_string())?;
    if before_json != after_json {
        transaction
            .execute("DELETE FROM playlist_history WHERE undone = 1", [])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO playlist_history(action, before_json, after_json, created_at, undone)
                 VALUES (?1, ?2, ?3, ?4, 0)",
                params![
                    clean_name(action, "Playlist change"),
                    before_json,
                    after_json,
                    now_iso()?
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM playlist_history WHERE id NOT IN (
                   SELECT id FROM playlist_history ORDER BY id DESC LIMIT ?1
                 )",
                [MAX_PLAYLIST_HISTORY],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

fn next_playlist_order(connection: &Connection, folder_id: Option<&str>) -> PlaylistResult<i64> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM playlists
             WHERE folder_id = ?1 OR (folder_id IS NULL AND ?1 IS NULL)",
            [folder_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn next_folder_order(connection: &Connection, parent_id: Option<&str>) -> PlaylistResult<i64> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM playlist_folders
             WHERE parent_id = ?1 OR (parent_id IS NULL AND ?1 IS NULL)",
            [parent_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

pub fn load_playlists(db_path: &str) -> PlaylistResult<PlaylistCollection> {
    let connection = open_database(db_path)?;
    let state = capture_state(&connection)?;
    let playlists = state
        .playlists
        .into_iter()
        .map(|playlist| PlaylistView {
            id: playlist.id,
            name: playlist.name,
            folder_id: playlist.folder_id,
            sort_order: playlist.sort_order,
            source_path: playlist.source_path,
            source_mtime_ms: playlist.source_mtime_ms,
            source_size: playlist.source_size,
            source_sync_error: playlist.source_sync_error,
            last_synced_at: playlist.last_synced_at,
            track_ids: playlist.track_ids,
        })
        .collect();
    let folders = state
        .folders
        .into_iter()
        .map(|folder| PlaylistFolderView {
            id: folder.id,
            name: folder.name,
            parent_id: folder.parent_id,
            sort_order: folder.sort_order,
        })
        .collect();
    Ok(PlaylistCollection { playlists, folders })
}

pub fn create_playlist(
    db_path: &str,
    id: &str,
    name: &str,
    folder_id: Option<&str>,
    sort_order: Option<i64>,
    source_path: Option<&str>,
) -> PlaylistResult<()> {
    let mut connection = open_database(db_path)?;
    let id = id.trim().to_string();
    let name = name.trim().to_string();
    if id.is_empty() || name.is_empty() {
        return Err("Playlist id and name are required".to_string());
    }
    with_history(&mut connection, &format!("Create playlist: {name}"), |tx| {
        let order = sort_order.unwrap_or(next_playlist_order(tx, folder_id)?);
        tx.execute(
            "INSERT INTO playlists(id, name, folder_id, sort_order, source_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, folder_id, order, source_path, now_unix()?],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
}

pub fn update_playlist(
    db_path: &str,
    playlist_id: &str,
    name: Option<&str>,
    folder_id: Option<Option<&str>>,
    sort_order: Option<i64>,
) -> PlaylistResult<()> {
    let mut connection = open_database(db_path)?;
    let action = if name.is_some() {
        "Rename playlist"
    } else {
        "Move playlist"
    };
    with_history(&mut connection, action, |tx| {
        if let Some(value) = name {
            tx.execute(
                "UPDATE playlists SET name = ?1 WHERE id = ?2",
                params![value.trim(), playlist_id],
            )
            .map_err(|error| error.to_string())?;
        }
        if let Some(target_folder) = folder_id {
            let order = sort_order.unwrap_or(next_playlist_order(tx, target_folder)?);
            tx.execute(
                "UPDATE playlists SET folder_id = ?1, sort_order = ?2 WHERE id = ?3",
                params![target_folder, order, playlist_id],
            )
            .map_err(|error| error.to_string())?;
        } else if let Some(order) = sort_order {
            tx.execute(
                "UPDATE playlists SET sort_order = ?1 WHERE id = ?2",
                params![order, playlist_id],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

pub fn reorder_playlists(db_path: &str, items: Vec<PlaylistOrderItem>) -> PlaylistResult<()> {
    let mut connection = open_database(db_path)?;
    with_history(&mut connection, "Reorder playlists", |tx| {
        for item in &items {
            tx.execute(
                "UPDATE playlists SET folder_id = ?1, sort_order = ?2 WHERE id = ?3",
                params![item.folder_id, item.sort_order, item.id],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

pub fn delete_playlist(db_path: &str, playlist_id: &str) -> PlaylistResult<CountResult> {
    delete_playlists(db_path, vec![playlist_id.to_string()])
}

pub fn delete_playlists(db_path: &str, playlist_ids: Vec<String>) -> PlaylistResult<CountResult> {
    let ids: HashSet<String> = playlist_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(CountResult { deleted: 0 });
    }
    let mut connection = open_database(db_path)?;
    with_history(
        &mut connection,
        &format!("Delete {} playlists", ids.len()),
        |tx| {
            let mut deleted = 0;
            for id in &ids {
                deleted += tx
                    .execute("DELETE FROM playlists WHERE id = ?1", [id])
                    .map_err(|error| error.to_string())?;
            }
            Ok(CountResult { deleted })
        },
    )
}

pub fn restore_playlists(
    db_path: &str,
    playlists: Vec<PlaylistStateItem>,
) -> PlaylistResult<RestoreResult> {
    if playlists.is_empty() {
        return Ok(RestoreResult { restored: 0 });
    }
    let mut connection = open_database(db_path)?;
    with_history(
        &mut connection,
        &format!("Restore {} playlists", playlists.len()),
        |tx| {
            let mut existing_tracks = HashSet::new();
            {
                let mut statement = tx
                    .prepare("SELECT id FROM tracks")
                    .map_err(|error| error.to_string())?;
                for id in statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|error| error.to_string())?
                {
                    existing_tracks.insert(id.map_err(|error| error.to_string())?);
                }
            }
            let now = now_unix()?;
            let mut restored = 0;
            for playlist in &playlists {
                let id = playlist.id.trim();
                let name = playlist.name.trim();
                if id.is_empty() || name.is_empty() {
                    return Err("Invalid playlist restore payload".to_string());
                }
                tx.execute(
                    "INSERT INTO playlists(
                       id, name, folder_id, sort_order, source_path, source_mtime_ms,
                       source_size, source_sync_error, last_synced_at, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        id,
                        name,
                        playlist.folder_id,
                        playlist.sort_order,
                        playlist.source_path,
                        playlist.source_mtime_ms,
                        playlist.source_size,
                        playlist.source_sync_error,
                        playlist.last_synced_at,
                        now
                    ],
                )
                .map_err(|error| error.to_string())?;
                let mut seen = HashSet::new();
                let mut position = 0_i64;
                for track_id in &playlist.track_ids {
                    if existing_tracks.contains(track_id) && seen.insert(track_id) {
                        tx.execute(
                            "INSERT INTO playlist_tracks(playlist_id, track_id, position)
                             VALUES (?1, ?2, ?3)",
                            params![id, track_id, position],
                        )
                        .map_err(|error| error.to_string())?;
                        position += 1;
                    }
                }
                restored += 1;
            }
            Ok(RestoreResult { restored })
        },
    )
}

pub fn create_playlist_folder(
    db_path: &str,
    id: &str,
    name: &str,
    parent_id: Option<&str>,
    sort_order: Option<i64>,
) -> PlaylistResult<()> {
    let mut connection = open_database(db_path)?;
    let id = id.trim().to_string();
    let name = name.trim().to_string();
    if id.is_empty() || name.is_empty() {
        return Err("Playlist folder id and name are required".to_string());
    }
    with_history(
        &mut connection,
        &format!("Create playlist folder: {name}"),
        |tx| {
            let order = sort_order.unwrap_or(next_folder_order(tx, parent_id)?);
            tx.execute(
                "INSERT INTO playlist_folders(id, name, parent_id, sort_order, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, name, parent_id, order, now_unix()?],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        },
    )
}

pub fn update_playlist_folder(
    db_path: &str,
    folder_id: &str,
    name: Option<&str>,
    parent_id: Option<Option<&str>>,
    sort_order: Option<i64>,
) -> PlaylistResult<()> {
    let mut connection = open_database(db_path)?;
    let action = if name.is_some() {
        "Rename playlist folder"
    } else {
        "Move playlist folder"
    };
    with_history(&mut connection, action, |tx| {
        if let Some(value) = name {
            tx.execute(
                "UPDATE playlist_folders SET name = ?1 WHERE id = ?2",
                params![value.trim(), folder_id],
            )
            .map_err(|error| error.to_string())?;
        }
        if let Some(target_parent) = parent_id {
            if target_parent == Some(folder_id) {
                return Err("A playlist folder cannot contain itself".to_string());
            }
            tx.execute(
                "UPDATE playlist_folders SET parent_id = ?1 WHERE id = ?2",
                params![target_parent, folder_id],
            )
            .map_err(|error| error.to_string())?;
        }
        if let Some(order) = sort_order {
            tx.execute(
                "UPDATE playlist_folders SET sort_order = ?1 WHERE id = ?2",
                params![order, folder_id],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

/// Deletes a folder while promoting its playlists and child folders to the
/// deleted folder's parent, appending them in stable order.
pub fn delete_playlist_folder(db_path: &str, folder_id: &str) -> PlaylistResult<CountResult> {
    let mut connection = open_database(db_path)?;
    with_history(&mut connection, "Delete playlist folder", |tx| {
        let parent_id: Option<String> = tx
            .query_row(
                "SELECT parent_id FROM playlist_folders WHERE id = ?1",
                [folder_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        let mut playlist_order = next_playlist_order(tx, parent_id.as_deref())?;
        let playlist_ids = {
            let mut statement = tx
                .prepare("SELECT id FROM playlists WHERE folder_id = ?1 ORDER BY sort_order, id")
                .map_err(|error| error.to_string())?;
            let mapped = statement
                .query_map([folder_id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        for id in playlist_ids {
            tx.execute(
                "UPDATE playlists SET folder_id = ?1, sort_order = ?2 WHERE id = ?3",
                params![parent_id, playlist_order, id],
            )
            .map_err(|error| error.to_string())?;
            playlist_order += 1;
        }
        let mut folder_order = next_folder_order(tx, parent_id.as_deref())?;
        let folder_ids = {
            let mut statement = tx
                .prepare(
                    "SELECT id FROM playlist_folders WHERE parent_id = ?1 ORDER BY sort_order, id",
                )
                .map_err(|error| error.to_string())?;
            let mapped = statement
                .query_map([folder_id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        for id in folder_ids {
            tx.execute(
                "UPDATE playlist_folders SET parent_id = ?1, sort_order = ?2 WHERE id = ?3",
                params![parent_id, folder_order, id],
            )
            .map_err(|error| error.to_string())?;
            folder_order += 1;
        }
        let deleted = tx
            .execute("DELETE FROM playlist_folders WHERE id = ?1", [folder_id])
            .map_err(|error| error.to_string())?;
        Ok(CountResult { deleted })
    })
}

pub fn add_tracks_to_playlist(
    db_path: &str,
    playlist_id: &str,
    track_ids: Vec<String>,
) -> PlaylistResult<()> {
    if track_ids.is_empty() {
        return Ok(());
    }
    let mut connection = open_database(db_path)?;
    with_history(&mut connection, "Add tracks to playlist", |tx| {
        let mut position: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks
                 WHERE playlist_id = ?1",
                [playlist_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let mut seen = HashSet::new();
        for track_id in &track_ids {
            if track_id.is_empty() || !seen.insert(track_id) {
                continue;
            }
            let exists = tx
                .query_row(
                    "SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                    params![playlist_id, track_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .is_some();
            if !exists {
                tx.execute(
                    "INSERT INTO playlist_tracks(playlist_id, track_id, position)
                     VALUES (?1, ?2, ?3)",
                    params![playlist_id, track_id, position],
                )
                .map_err(|error| error.to_string())?;
                position += 1;
            }
        }
        Ok(())
    })
}

pub fn set_playlist_tracks(
    db_path: &str,
    playlist_id: &str,
    track_ids: Vec<String>,
) -> PlaylistResult<()> {
    let mut connection = open_database(db_path)?;
    with_history(&mut connection, "Reorder playlist tracks", |tx| {
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            [playlist_id],
        )
        .map_err(|error| error.to_string())?;
        let mut seen = HashSet::new();
        let mut position = 0_i64;
        for track_id in &track_ids {
            if track_id.is_empty() || !seen.insert(track_id) {
                continue;
            }
            tx.execute(
                "INSERT INTO playlist_tracks(playlist_id, track_id, position)
                 VALUES (?1, ?2, ?3)",
                params![playlist_id, track_id, position],
            )
            .map_err(|error| error.to_string())?;
            position += 1;
        }
        Ok(())
    })
}

pub fn remove_tracks_from_playlist(
    db_path: &str,
    playlist_id: &str,
    track_ids: Vec<String>,
) -> PlaylistResult<CountResult> {
    let ids: HashSet<String> = track_ids.into_iter().filter(|id| !id.is_empty()).collect();
    if ids.is_empty() {
        return Ok(CountResult { deleted: 0 });
    }
    let mut connection = open_database(db_path)?;
    with_history(&mut connection, "Remove tracks from playlist", |tx| {
        let mut deleted = 0;
        for id in &ids {
            deleted += tx
                .execute(
                    "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                    params![playlist_id, id],
                )
                .map_err(|error| error.to_string())?;
        }
        normalize_track_positions(tx, playlist_id)?;
        Ok(CountResult { deleted })
    })
}

pub fn remove_last_tracks_from_playlist(
    db_path: &str,
    playlist_id: &str,
    count: i64,
) -> PlaylistResult<CountResult> {
    if count <= 0 {
        return Ok(CountResult { deleted: 0 });
    }
    let mut connection = open_database(db_path)?;
    with_history(&mut connection, "Remove tracks from playlist", |tx| {
        let deleted = tx
            .execute(
                "DELETE FROM playlist_tracks WHERE rowid IN (
                   SELECT rowid FROM playlist_tracks WHERE playlist_id = ?1
                   ORDER BY position DESC LIMIT ?2
                 )",
                params![playlist_id, count],
            )
            .map_err(|error| error.to_string())?;
        Ok(CountResult { deleted })
    })
}

fn normalize_track_positions(connection: &Connection, playlist_id: &str) -> PlaylistResult<()> {
    let ids = {
        let mut statement = connection
            .prepare(
                "SELECT track_id FROM playlist_tracks
                 WHERE playlist_id = ?1 ORDER BY position, rowid",
            )
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([playlist_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    for (position, track_id) in ids.iter().enumerate() {
        connection
            .execute(
                "UPDATE playlist_tracks SET position = ?1
                 WHERE playlist_id = ?2 AND track_id = ?3",
                params![position as i64, playlist_id, track_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn list_playlist_history(db_path: &str, limit: Option<i64>) -> PlaylistResult<HistoryList> {
    let connection = open_database(db_path)?;
    let bounded = limit.unwrap_or(50).clamp(1, MAX_PLAYLIST_HISTORY);
    let mut statement = connection
        .prepare(
            "SELECT id, action, created_at, undone FROM playlist_history
             ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let entries = statement
        .query_map([bounded], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                action: row.get(1)?,
                created_at: row.get(2)?,
                undone: row.get::<_, i64>(3)? == 1,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let can_undo = connection
        .query_row(
            "SELECT 1 FROM playlist_history WHERE undone = 0 ORDER BY id DESC LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    let can_redo = connection
        .query_row(
            "SELECT 1 FROM playlist_history WHERE undone = 1 ORDER BY id ASC LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    Ok(HistoryList {
        entries,
        can_undo,
        can_redo,
    })
}

pub fn undo_playlist_history(db_path: &str) -> PlaylistResult<Option<HistoryRestore>> {
    restore_history_direction(db_path, false)
}

pub fn redo_playlist_history(db_path: &str) -> PlaylistResult<Option<HistoryRestore>> {
    restore_history_direction(db_path, true)
}

fn restore_history_direction(db_path: &str, redo: bool) -> PlaylistResult<Option<HistoryRestore>> {
    let mut connection = open_database(db_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let query = if redo {
        "SELECT id, action, after_json FROM playlist_history
         WHERE undone = 1 ORDER BY id ASC LIMIT 1"
    } else {
        "SELECT id, action, before_json FROM playlist_history
         WHERE undone = 0 ORDER BY id DESC LIMIT 1"
    };
    let entry: Option<(i64, String, String)> = transaction
        .query_row(query, [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((id, action, raw_state)) = entry else {
        return Ok(None);
    };
    let state: PlaylistState = serde_json::from_str(&raw_state)
        .map_err(|error| format!("Invalid playlist state: {error}"))?;
    apply_state_changes(&transaction, &state)?;
    transaction
        .execute(
            "UPDATE playlist_history SET undone = ?1 WHERE id = ?2",
            params![if redo { 0 } else { 1 }, id],
        )
        .map_err(|error| error.to_string())?;
    let restored_state = capture_state(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(Some(HistoryRestore {
        id,
        action,
        state: restored_state,
    }))
}

pub fn create_playlist_snapshot(db_path: &str, name: &str) -> PlaylistResult<PlaylistSnapshot> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Snapshot name is required".to_string());
    }
    let connection = open_database(db_path)?;
    let snapshot = PlaylistSnapshot {
        id: Uuid::new_v4().to_string(),
        name: trimmed.chars().take(120).collect(),
        created_at: now_iso()?,
    };
    let state_json =
        serde_json::to_string(&capture_state(&connection)?).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO playlist_snapshots(id, name, state_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![snapshot.id, snapshot.name, state_json, snapshot.created_at],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM playlist_snapshots WHERE id NOT IN (
               SELECT id FROM playlist_snapshots ORDER BY created_at DESC LIMIT ?1
             )",
            [MAX_PLAYLIST_SNAPSHOTS],
        )
        .map_err(|error| error.to_string())?;
    Ok(snapshot)
}

pub fn list_playlist_snapshots(db_path: &str) -> PlaylistResult<Vec<PlaylistSnapshot>> {
    let connection = open_database(db_path)?;
    let mut statement = connection
        .prepare("SELECT id, name, created_at FROM playlist_snapshots ORDER BY created_at DESC")
        .map_err(|error| error.to_string())?;
    let mapped = statement
        .query_map([], |row| {
            Ok(PlaylistSnapshot {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn restore_playlist_snapshot(
    db_path: &str,
    snapshot_id: &str,
) -> PlaylistResult<PlaylistState> {
    let mut connection = open_database(db_path)?;
    let snapshot: Option<(String, String)> = connection
        .query_row(
            "SELECT name, state_json FROM playlist_snapshots WHERE id = ?1",
            [snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((name, raw_state)) = snapshot else {
        return Err("Playlist snapshot was not found".to_string());
    };
    let state: PlaylistState = serde_json::from_str(&raw_state)
        .map_err(|error| format!("Invalid playlist state: {error}"))?;
    with_history(
        &mut connection,
        &format!("Restore snapshot: {name}"),
        |tx| apply_state_changes(tx, &state),
    )?;
    capture_state(&connection)
}

pub fn delete_playlist_snapshot(db_path: &str, snapshot_id: &str) -> PlaylistResult<CountResult> {
    let connection = open_database(db_path)?;
    let deleted = connection
        .execute(
            "DELETE FROM playlist_snapshots WHERE id = ?1",
            [snapshot_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(CountResult { deleted })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_database() -> String {
        let path = std::env::temp_dir().join(format!("muro-playlists-{}.sqlite", Uuid::new_v4()));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE tracks (id TEXT PRIMARY KEY);")
            .unwrap();
        connection
            .execute("INSERT INTO tracks(id) VALUES ('a'), ('b'), ('c')", [])
            .unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn playlist_mutations_are_ordered_and_undoable() {
        let path = test_database();
        create_playlist(&path, "p", "Test", None, None, None).unwrap();
        add_tracks_to_playlist(
            &path,
            "p",
            vec!["a".into(), "b".into(), "a".into(), "c".into()],
        )
        .unwrap();
        remove_tracks_from_playlist(&path, "p", vec!["b".into()]).unwrap();
        assert_eq!(
            load_playlists(&path).unwrap().playlists[0].track_ids,
            ["a", "c"]
        );

        undo_playlist_history(&path).unwrap();
        assert_eq!(
            load_playlists(&path).unwrap().playlists[0].track_ids,
            ["a", "b", "c"]
        );
        redo_playlist_history(&path).unwrap();
        assert_eq!(
            load_playlists(&path).unwrap().playlists[0].track_ids,
            ["a", "c"]
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn deleting_folder_promotes_children() {
        let path = test_database();
        create_playlist_folder(&path, "parent", "Parent", None, None).unwrap();
        create_playlist_folder(&path, "child", "Child", Some("parent"), None).unwrap();
        create_playlist(&path, "p", "Test", Some("parent"), None, None).unwrap();
        delete_playlist_folder(&path, "parent").unwrap();
        let data = load_playlists(&path).unwrap();
        assert_eq!(data.playlists[0].folder_id, None);
        assert_eq!(data.folders[0].parent_id, None);
        std::fs::remove_file(path).ok();
    }
}
