//! SQLite compatibility layer for databases written by the Electron app.
//!
//! This module deliberately owns no global connection cache. Tauri commands are
//! short lived and `rusqlite` connections are cheap; opening one per command also
//! avoids carrying a connection across async/runtime threads.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use uuid::Uuid;

const SEARCH_TEXT_VERSION: i64 = 3;
const LIBRARY_ROOT_KEY: &str = "library_root";
const ARTIST_MIGRATION_KEY: &str = "artist_credit_migration_v1";

const TRACK_COLUMNS: &[(&str, &str)] = &[
    ("album_artist", "TEXT"),
    ("genre_json", "TEXT"),
    ("comment_json", "TEXT"),
    ("label", "TEXT"),
    ("filename", "TEXT"),
    ("year", "INTEGER"),
    ("date", "TEXT"),
    ("original_date", "TEXT"),
    ("original_year", "INTEGER"),
    ("track_number", "INTEGER"),
    ("track_total", "INTEGER"),
    ("disc_number", "INTEGER"),
    ("disc_total", "INTEGER"),
    ("key", "TEXT"),
    ("bpm", "REAL"),
    ("rating", "REAL"),
    ("isrc_json", "TEXT"),
    ("encoder", "TEXT"),
    ("encoder_tag", "TEXT"),
    ("encoder_tool", "TEXT"),
    ("raw_tags_json", "TEXT"),
    ("musicbrainz_albumid", "TEXT"),
    ("musicbrainz_artistid", "TEXT"),
    ("musicbrainz_albumartistid", "TEXT"),
    ("musicbrainz_releasegroupid", "TEXT"),
    ("musicbrainz_trackid", "TEXT"),
    ("musicbrainz_releasetrackid", "TEXT"),
    ("musicbrainz_albumstatus", "TEXT"),
    ("musicbrainz_albumtype", "TEXT"),
    ("acoustid_id", "TEXT"),
    ("source_path", "TEXT"),
    ("search_text", "TEXT"),
    ("import_status", "TEXT DEFAULT 'staged'"),
    (
        "move_to_watched_folder_on_accept",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("duration_seconds", "REAL"),
    ("bitrate_kbps", "INTEGER"),
    ("sample_rate_hz", "INTEGER"),
    ("bit_depth", "INTEGER"),
    ("file_size_bytes", "INTEGER"),
    ("added_at", "INTEGER"),
    ("updated_at", "INTEGER"),
    ("last_write_error", "TEXT"),
    ("is_missing", "INTEGER DEFAULT 0"),
    ("cover_art_path", "TEXT"),
    ("cover_art_thumb_path", "TEXT"),
    ("last_played_at", "TEXT"),
    ("play_count", "INTEGER DEFAULT 0"),
    ("beat_grid_json", "TEXT"),
    ("loudness_lufs", "REAL"),
    ("replaygain_track_gain_db", "REAL"),
    ("replaygain_track_peak", "REAL"),
    ("replaygain_album_gain_db", "REAL"),
    ("replaygain_album_peak", "REAL"),
    ("loudness_source", "TEXT"),
];

const TRACK_SELECT: &str = r#"
SELECT id, title, artist, album_artist, album, track_number, track_total,
  key, bpm, year, date, added_at, updated_at, rating, duration_seconds,
  bitrate_kbps, sample_rate_hz, bit_depth, file_size_bytes, import_status,
  source_path, cover_art_path, cover_art_thumb_path, last_played_at, play_count,
  genre_json, comment_json, label, disc_number, disc_total, beat_grid_json,
  musicbrainz_trackid, musicbrainz_albumid, musicbrainz_artistid,
  musicbrainz_albumartistid, musicbrainz_releasegroupid, acoustid_id,
  loudness_lufs, replaygain_track_gain_db, replaygain_track_peak,
  replaygain_album_gain_db, replaygain_album_peak, loudness_source, is_missing
FROM tracks"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistCredit {
    pub artist_id: String,
    pub name: String,
    pub credited_name: String,
    pub join_phrase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub music_brainz_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artist_credits: Vec<ArtistCredit>,
    pub album_artist: Option<String>,
    pub album_artist_credits: Vec<ArtistCredit>,
    pub artists: Option<String>,
    pub album: String,
    pub track_number: Option<i64>,
    pub track_total: Option<i64>,
    pub key: Option<String>,
    pub bpm: Option<f64>,
    pub year: Option<i64>,
    pub date: Option<String>,
    pub date_added: Option<String>,
    pub date_modified: Option<String>,
    pub duration: String,
    pub duration_seconds: f64,
    pub bitrate: String,
    pub sample_rate_hz: Option<i64>,
    pub bit_depth: Option<i64>,
    pub file_size_bytes: Option<i64>,
    pub rating: f64,
    pub source_path: String,
    pub cover_art_path: Option<String>,
    pub cover_art_thumb_path: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub label: Option<String>,
    pub disc_number: Option<i64>,
    pub disc_total: Option<i64>,
    pub last_played_at: Option<String>,
    pub play_count: i64,
    pub beat_grid_json: Option<String>,
    pub loudness_lufs: Option<f64>,
    pub replaygain_track_gain_db: Option<f64>,
    pub replaygain_track_peak: Option<f64>,
    pub replaygain_album_gain_db: Option<f64>,
    pub replaygain_album_peak: Option<f64>,
    pub loudness_source: Option<String>,
    pub is_missing: i64,
    pub musicbrainz_trackid: Option<String>,
    pub musicbrainz_albumid: Option<String>,
    pub musicbrainz_releasegroupid: Option<String>,
    pub acoustid_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibrarySnapshot {
    pub library: Vec<Track>,
    pub inbox: Vec<Track>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Playlist {
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

#[derive(Debug, Clone, Serialize)]
pub struct PlaylistFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaylistSnapshot {
    pub playlists: Vec<Playlist>,
    pub folders: Vec<PlaylistFolder>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistMigrationResult {
    pub skipped: bool,
    pub tracks_checked: usize,
    pub sets_created: usize,
    pub sets_replaced: usize,
    pub credits_created: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRootResult {
    pub library_root: String,
    pub migrated: usize,
}

#[derive(Debug, Clone)]
struct RawTrack {
    track: Track,
    import_status: String,
    legacy_artist_mb_id: Option<String>,
    legacy_album_artist_mb_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedArtistCredit {
    pub name: String,
    pub credited_name: String,
    pub join_phrase: String,
    pub musicbrainz_id: Option<String>,
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn columns(conn: &Connection, table: &str) -> Result<BTreeSet<String>, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info(\"{}\")", table))
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?;
    rows.collect::<Result<BTreeSet<_>, _>>().map_err(db_error)
}

fn add_missing_columns(
    conn: &Connection,
    table: &str,
    required: &[(&str, &str)],
) -> Result<BTreeSet<String>, String> {
    let existing = columns(conn, table)?;
    for (name, definition) in required {
        if !existing.contains(*name) {
            conn.execute_batch(&format!(
                "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}",
                table, name, definition
            ))
            .map_err(db_error)?;
        }
    }
    Ok(existing)
}

/// Create every table/index used by the Electron database and migrate legacy
/// Tauri databases in place. Safe to call before every database operation.
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, album_artist TEXT,
  genre_json TEXT, comment_json TEXT, label TEXT, filename TEXT, year INTEGER,
  date TEXT, original_date TEXT, original_year INTEGER, track_number INTEGER,
  track_total INTEGER, disc_number INTEGER, disc_total INTEGER, key TEXT,
  bpm REAL, rating REAL, isrc_json TEXT, encoder TEXT, encoder_tag TEXT,
  encoder_tool TEXT, raw_tags_json TEXT, musicbrainz_albumid TEXT,
  musicbrainz_artistid TEXT, musicbrainz_albumartistid TEXT,
  musicbrainz_releasegroupid TEXT, musicbrainz_trackid TEXT,
  musicbrainz_releasetrackid TEXT, musicbrainz_albumstatus TEXT,
  musicbrainz_albumtype TEXT, acoustid_id TEXT, source_path TEXT UNIQUE NOT NULL,
  search_text TEXT, import_status TEXT NOT NULL DEFAULT 'staged',
  move_to_watched_folder_on_accept INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL, bitrate_kbps INTEGER, sample_rate_hz INTEGER,
  bit_depth INTEGER, file_size_bytes INTEGER, added_at INTEGER,
  updated_at INTEGER, last_write_error TEXT, is_missing INTEGER DEFAULT 0,
  cover_art_path TEXT, cover_art_thumb_path TEXT, last_played_at TEXT,
  play_count INTEGER DEFAULT 0, beat_grid_json TEXT, loudness_lufs REAL,
  replaygain_track_gain_db REAL, replaygain_track_peak REAL,
  replaygain_album_gain_db REAL, replaygain_album_peak REAL, loudness_source TEXT
);
CREATE INDEX IF NOT EXISTS tracks_import_status_idx ON tracks(import_status);
CREATE INDEX IF NOT EXISTS tracks_last_played_idx ON tracks(last_played_at DESC);
"#,
    )
    .map_err(db_error)?;
    add_missing_columns(conn, "tracks", TRACK_COLUMNS)?;

    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS playlist_folders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  parent_id TEXT REFERENCES playlist_folders(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  folder_id TEXT REFERENCES playlist_folders(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, source_path TEXT, source_mtime_ms REAL,
  source_size INTEGER, source_sync_error TEXT, last_synced_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, UNIQUE(playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_idx
  ON playlist_tracks(playlist_id, position);
CREATE TABLE IF NOT EXISTS artist_profiles (
  artist_key TEXT PRIMARY KEY, requested_name TEXT NOT NULL,
  profile_json TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artist_profiles_fetched_at_idx
  ON artist_profiles(fetched_at DESC);
CREATE TABLE IF NOT EXISTS album_cover_cache (
  cover_key TEXT PRIMARY KEY, kind TEXT NOT NULL, musicbrainz_id TEXT NOT NULL,
  status TEXT NOT NULL, full_path TEXT, thumb_path TEXT, source_url TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS album_cover_cache_fetched_at_idx
  ON album_cover_cache(fetched_at DESC);
CREATE TABLE IF NOT EXISTS acoustid_fingerprints (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  source_mtime_ms REAL NOT NULL, source_size INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT,
  looked_up_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS acoustid_fingerprints_looked_up_idx
  ON acoustid_fingerprints(looked_up_at DESC);
CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL, played_at TEXT NOT NULL,
  listened_seconds REAL NOT NULL DEFAULT 0, duration_seconds REAL,
  title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
  track_added_at INTEGER
);
CREATE INDEX IF NOT EXISTS play_history_played_at_idx ON play_history(played_at DESC);
CREATE INDEX IF NOT EXISTS play_history_track_idx ON play_history(track_id, played_at DESC);
CREATE TABLE IF NOT EXISTS metadata_change_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user',
  changes_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS metadata_change_track_idx
  ON metadata_change_history(track_id, changed_at DESC);
CREATE TABLE IF NOT EXISTS playlist_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS playlist_history_state_idx
  ON playlist_history(undone, id DESC);
CREATE TABLE IF NOT EXISTS playlist_snapshots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_snapshots_created_idx
  ON playlist_snapshots(created_at DESC);
CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
"#,
    )
    .map_err(db_error)?;

    let old_playlist_columns = add_missing_columns(
        conn,
        "playlists",
        &[
            ("folder_id", "TEXT"),
            ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
            ("source_path", "TEXT"),
            ("source_mtime_ms", "REAL"),
            ("source_size", "INTEGER"),
            ("source_sync_error", "TEXT"),
            ("last_synced_at", "INTEGER"),
        ],
    )?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS playlists_source_path_idx ON playlists(source_path)",
    )
    .map_err(db_error)?;
    let old_folder_columns = add_missing_columns(
        conn,
        "playlist_folders",
        &[
            ("parent_id", "TEXT"),
            ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ],
    )?;
    if !old_playlist_columns.contains("sort_order") {
        backfill_playlist_sort_order(conn)?;
    }
    if !old_folder_columns.contains("sort_order") {
        backfill_folder_sort_order(conn)?;
    }

    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS artist_entities (
  id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL, musicbrainz_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artist_entities_normalized_name_idx
  ON artist_entities(normalized_name);
CREATE UNIQUE INDEX IF NOT EXISTS artist_entities_musicbrainz_id_uidx
  ON artist_entities(musicbrainz_id COLLATE NOCASE)
  WHERE musicbrainz_id IS NOT NULL AND trim(musicbrainz_id) <> '';
CREATE TABLE IF NOT EXISTS track_artist_credit_sets (
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('track', 'album')),
  display_text TEXT NOT NULL, provenance TEXT NOT NULL,
  confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0, 1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(track_id, scope)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS track_artist_credits (
  track_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('track', 'album')),
  position INTEGER NOT NULL CHECK(position >= 0),
  artist_id TEXT NOT NULL REFERENCES artist_entities(id) ON DELETE RESTRICT,
  credited_name TEXT NOT NULL, join_phrase TEXT NOT NULL DEFAULT '', role TEXT,
  PRIMARY KEY(track_id, scope, position),
  FOREIGN KEY(track_id, scope)
    REFERENCES track_artist_credit_sets(track_id, scope) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS track_artist_credits_artist_idx
  ON track_artist_credits(artist_id, scope, track_id);
CREATE TRIGGER IF NOT EXISTS tracks_artist_credits_invalidate
AFTER UPDATE OF artist ON tracks WHEN OLD.artist IS NOT NEW.artist BEGIN
  DELETE FROM track_artist_credit_sets WHERE track_id = NEW.id AND scope = 'track';
END;
CREATE TRIGGER IF NOT EXISTS tracks_album_artist_credits_invalidate
AFTER UPDATE OF album_artist ON tracks WHEN OLD.album_artist IS NOT NEW.album_artist BEGIN
  DELETE FROM track_artist_credit_sets WHERE track_id = NEW.id AND scope = 'album';
END;
"#,
    )
    .map_err(db_error)?;

    let had_fts = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tracks_fts'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(db_error)?
        .is_some();
    conn.execute_batch(
        r#"
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  search_text, content='tracks', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS tracks_fts_insert AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS tracks_fts_delete AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS tracks_fts_update AFTER UPDATE OF search_text ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO tracks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
"#,
    )
    .map_err(db_error)?;

    let version = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key='search_text_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if version < SEARCH_TEXT_VERSION {
        backfill_search_text_conn(conn, true)?;
        conn.execute(
            "INSERT INTO app_metadata(key,value) VALUES('search_text_version',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [SEARCH_TEXT_VERSION.to_string()],
        )
        .map_err(db_error)?;
        rebuild_search_index_conn(conn)?;
    } else if !had_fts {
        rebuild_search_index_conn(conn)?;
    }
    Ok(())
}

fn backfill_playlist_sort_order(conn: &Connection) -> Result<(), String> {
    let mut statement = conn
        .prepare("SELECT id, folder_id FROM playlists ORDER BY folder_id, created_at DESC, id")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut positions: HashMap<Option<String>, i64> = HashMap::new();
    for (id, folder) in rows {
        let position = positions.entry(folder).or_default();
        conn.execute(
            "UPDATE playlists SET sort_order=?1 WHERE id=?2",
            params![*position, id],
        )
        .map_err(db_error)?;
        *position += 1;
    }
    Ok(())
}

fn backfill_folder_sort_order(conn: &Connection) -> Result<(), String> {
    let mut statement = conn
        .prepare("SELECT id, parent_id FROM playlist_folders ORDER BY parent_id, created_at, name COLLATE NOCASE, id")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut positions: HashMap<Option<String>, i64> = HashMap::new();
    for (id, parent) in rows {
        let position = positions.entry(parent).or_default();
        conn.execute(
            "UPDATE playlist_folders SET sort_order=?1 WHERE id=?2",
            params![*position, id],
        )
        .map_err(db_error)?;
        *position += 1;
    }
    Ok(())
}

fn open_database(db_path: &str) -> Result<Connection, String> {
    if let Some(parent) = Path::new(db_path).parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(db_path).map_err(db_error)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn normalize_artist_name(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn canonical_artist_name(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse the legacy display value while retaining separators byte-for-byte.
pub fn parse_legacy_artist_credits(
    display: &str,
    exceptions: &[String],
) -> Vec<ParsedArtistCredit> {
    if display.trim().is_empty() {
        return Vec::new();
    }
    if exceptions
        .iter()
        .any(|item| normalize_artist_name(item) == normalize_artist_name(display))
    {
        return vec![ParsedArtistCredit {
            name: canonical_artist_name(display),
            credited_name: display.to_string(),
            join_phrase: String::new(),
            musicbrainz_id: None,
        }];
    }

    let lower = display.to_lowercase();
    let bytes = display.as_bytes();
    let lower_bytes = lower.as_bytes();
    let protected = exception_ranges(display, exceptions);
    let mut separators = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let found = if bytes[index] == b',' {
            Some(index + 1)
        } else if bytes[index] == b'&'
            && index > 0
            && index + 1 < bytes.len()
            && bytes[index - 1].is_ascii_whitespace()
            && bytes[index + 1].is_ascii_whitespace()
        {
            Some(index + 1)
        } else if lower_bytes
            .get(index..)
            .is_some_and(|tail| tail.starts_with(b"feat"))
            && index > 0
            && bytes[index - 1].is_ascii_whitespace()
        {
            let mut end = index + 4;
            if bytes.get(end) == Some(&b'.') {
                end += 1;
            }
            if bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
                Some(end)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(mut end) = found {
            while end < bytes.len() && bytes[end].is_ascii_whitespace() {
                end += 1;
            }
            let mut start = index;
            while start > 0 && bytes[start - 1].is_ascii_whitespace() {
                start -= 1;
            }
            if !protected
                .iter()
                .any(|(left, right)| start < *right && end > *left)
            {
                separators.push((start, end));
            }
            index = end;
        } else {
            index += display[index..]
                .chars()
                .next()
                .map(char::len_utf8)
                .unwrap_or(1);
        }
    }
    if separators.is_empty() {
        return vec![ParsedArtistCredit {
            name: canonical_artist_name(display),
            credited_name: display.to_string(),
            join_phrase: String::new(),
            musicbrainz_id: None,
        }];
    }

    let mut result = Vec::new();
    let mut cursor = 0;
    for (start, end) in separators {
        let name = &display[cursor..start];
        if name.trim().is_empty() {
            return vec![ParsedArtistCredit {
                name: canonical_artist_name(display),
                credited_name: display.to_string(),
                join_phrase: String::new(),
                musicbrainz_id: None,
            }];
        }
        result.push(ParsedArtistCredit {
            name: canonical_artist_name(name),
            credited_name: name.to_string(),
            join_phrase: display[start..end].to_string(),
            musicbrainz_id: None,
        });
        cursor = end;
    }
    let final_name = &display[cursor..];
    if final_name.trim().is_empty() {
        return vec![ParsedArtistCredit {
            name: canonical_artist_name(display),
            credited_name: display.to_string(),
            join_phrase: String::new(),
            musicbrainz_id: None,
        }];
    }
    result.push(ParsedArtistCredit {
        name: canonical_artist_name(final_name),
        credited_name: final_name.to_string(),
        join_phrase: String::new(),
        musicbrainz_id: None,
    });
    result
}

fn exception_ranges(display: &str, exceptions: &[String]) -> Vec<(usize, usize)> {
    let lower = display.to_lowercase();
    let mut ranges = Vec::new();
    for exception in exceptions {
        let needle = exception.trim().to_lowercase();
        if needle.is_empty() {
            continue;
        }
        let mut offset = 0;
        while let Some(relative) = lower[offset..].find(&needle) {
            let start = offset + relative;
            ranges.push((start, start + needle.len()));
            offset = start + needle.len();
        }
    }
    ranges
}

fn migration_state(exceptions: &[String]) -> String {
    let normalized: BTreeSet<String> = exceptions
        .iter()
        .map(|item| normalize_artist_name(item))
        .filter(|item| !item.is_empty())
        .collect();
    serde_json::json!({ "version": 1, "exceptions": normalized }).to_string()
}

fn find_or_create_artist(conn: &Connection, credit: &ParsedArtistCredit) -> Result<String, String> {
    let normalized = normalize_artist_name(&credit.name);
    let by_mb_id = if let Some(mb_id) = credit.musicbrainz_id.as_deref() {
        conn.query_row(
            "SELECT id FROM artist_entities WHERE musicbrainz_id=?1 COLLATE NOCASE",
            [mb_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
    } else {
        None
    };
    if let Some(id) = by_mb_id {
        return Ok(id);
    }
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM artist_entities WHERE normalized_name=?1 ORDER BY created_at,id LIMIT 1",
            [&normalized],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
    {
        if let Some(mb_id) = credit.musicbrainz_id.as_deref() {
            conn.execute(
                "UPDATE artist_entities SET musicbrainz_id=COALESCE(musicbrainz_id,?1),updated_at=?2 WHERE id=?3",
                params![mb_id, now_seconds(), id],
            )
            .map_err(db_error)?;
        }
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let timestamp = now_seconds();
    conn.execute(
        "INSERT INTO artist_entities(id,canonical_name,normalized_name,musicbrainz_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
        params![id, credit.name, normalized, credit.musicbrainz_id, timestamp],
    )
    .map_err(db_error)?;
    Ok(id)
}

fn replace_artist_set(
    conn: &Connection,
    track_id: &str,
    scope: &str,
    display: &str,
    credits: &[ParsedArtistCredit],
) -> Result<(), String> {
    let timestamp = now_seconds();
    conn.execute(
        "DELETE FROM track_artist_credit_sets WHERE track_id=?1 AND scope=?2",
        params![track_id, scope],
    )
    .map_err(db_error)?;
    conn.execute(
        "INSERT INTO track_artist_credit_sets(track_id,scope,display_text,provenance,confidence,needs_review,created_at,updated_at) VALUES(?1,?2,?3,'legacy',?4,?5,?6,?6)",
        params![track_id, scope, display, if credits.len()>1 {75} else {100}, if credits.len()>1 {1} else {0}, timestamp],
    )
    .map_err(db_error)?;
    for (position, credit) in credits.iter().enumerate() {
        let artist_id = find_or_create_artist(conn, credit)?;
        conn.execute(
            "INSERT INTO track_artist_credits(track_id,scope,position,artist_id,credited_name,join_phrase,role) VALUES(?1,?2,?3,?4,?5,?6,NULL)",
            params![track_id, scope, position as i64, artist_id, credit.credited_name, credit.join_phrase],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

/// Idempotent legacy scalar -> structured artist-credit migration.
pub fn migrate_artist_credits_impl(
    conn: &Connection,
    exceptions: &[String],
) -> Result<ArtistMigrationResult, String> {
    let state = migration_state(exceptions);
    let stored = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key=?1",
            [ARTIST_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    if stored.as_deref() == Some(state.as_str()) {
        return Ok(ArtistMigrationResult {
            skipped: true,
            ..Default::default()
        });
    }
    let tracks = {
        let mut statement = conn
            .prepare("SELECT id,artist,album_artist,musicbrainz_artistid,musicbrainz_albumartistid FROM tracks")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut result = ArtistMigrationResult {
        tracks_checked: tracks.len(),
        ..Default::default()
    };
    for (track_id, artist, album_artist, artist_mb, album_artist_mb) in tracks {
        for (scope, value, mb_id) in [
            ("track", artist, artist_mb),
            ("album", album_artist, album_artist_mb),
        ] {
            let Some(display) = value.filter(|value| !value.trim().is_empty()) else {
                continue;
            };
            let existing: Option<(String, String)> = conn
                .query_row(
                    "SELECT display_text,provenance FROM track_artist_credit_sets WHERE track_id=?1 AND scope=?2",
                    params![track_id, scope],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?;
            if existing.as_ref().is_some_and(|(old_display, provenance)| {
                old_display == &display && provenance != "legacy"
            }) {
                continue;
            }
            let mut credits = parse_legacy_artist_credits(&display, exceptions);
            if credits.len() == 1 {
                credits[0].musicbrainz_id = mb_id.filter(|value| !value.trim().is_empty());
            }
            let was_existing = existing.is_some();
            replace_artist_set(conn, &track_id, scope, &display, &credits)?;
            if was_existing {
                result.sets_replaced += 1;
            } else {
                result.sets_created += 1;
            }
            result.credits_created += credits.len();
        }
        refresh_search_text(conn, &track_id)?;
    }
    conn.execute(
        "INSERT INTO app_metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![ARTIST_MIGRATION_KEY, state],
    )
    .map_err(db_error)?;
    rebuild_search_index_conn(conn)?;
    Ok(result)
}

fn load_artist_credits(
    conn: &Connection,
    track_ids: &[String],
) -> Result<HashMap<String, (Vec<ArtistCredit>, Vec<ArtistCredit>)>, String> {
    if track_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let wanted: BTreeSet<&str> = track_ids.iter().map(String::as_str).collect();
    let mut statement = conn
        .prepare(
            r#"SELECT s.track_id,s.scope,c.artist_id,e.canonical_name,c.credited_name,
 c.join_phrase,e.musicbrainz_id,c.role
FROM track_artist_credit_sets s
JOIN tracks t ON t.id=s.track_id
JOIN track_artist_credits c ON c.track_id=s.track_id AND c.scope=s.scope
JOIN artist_entities e ON e.id=c.artist_id
WHERE s.display_text=CASE s.scope WHEN 'track' THEN t.artist ELSE t.album_artist END
ORDER BY s.track_id,s.scope,c.position"#,
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                ArtistCredit {
                    artist_id: row.get(2)?,
                    name: row.get(3)?,
                    credited_name: row.get(4)?,
                    join_phrase: row.get(5)?,
                    music_brainz_id: row.get(6)?,
                    role: row.get(7)?,
                },
            ))
        })
        .map_err(db_error)?;
    let mut result: HashMap<String, (Vec<ArtistCredit>, Vec<ArtistCredit>)> = HashMap::new();
    for row in rows {
        let (track_id, scope, credit) = row.map_err(db_error)?;
        if !wanted.contains(track_id.as_str()) {
            continue;
        }
        let pair = result.entry(track_id).or_default();
        if scope == "album" {
            pair.1.push(credit);
        } else {
            pair.0.push(credit);
        }
    }
    Ok(result)
}

fn fallback_credits(
    display: Option<&str>,
    mb_id: Option<&str>,
    exceptions: &[String],
) -> Vec<ArtistCredit> {
    let Some(display) = display.filter(|value| !value.trim().is_empty()) else {
        return Vec::new();
    };
    let parsed = parse_legacy_artist_credits(display, exceptions);
    let single_mb = (parsed.len() == 1)
        .then(|| mb_id)
        .flatten()
        .map(str::to_string);
    parsed
        .into_iter()
        .map(|credit| ArtistCredit {
            artist_id: format!("legacy:{}", normalize_artist_name(&credit.name)),
            name: credit.name,
            credited_name: credit.credited_name,
            join_phrase: credit.join_phrase,
            music_brainz_id: single_mb.clone(),
            role: None,
        })
        .collect()
}

fn iso_timestamp(seconds: Option<i64>) -> Option<String> {
    seconds.and_then(|value| {
        chrono::DateTime::from_timestamp(value, 0)
            .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    })
}

fn json_list(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let values = serde_json::from_str::<Vec<String>>(&raw).ok()?;
    (!values.is_empty()).then(|| values.join(", "))
}

fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "--:--".to_string();
    }
    let rounded = seconds.round() as i64;
    format!("{}:{:02}", rounded / 60, rounded % 60)
}

fn positive_i64(value: Option<i64>) -> Option<i64> {
    value.filter(|number| *number > 0)
}

fn row_to_raw_track(row: &Row<'_>, library_root: Option<&Path>) -> rusqlite::Result<RawTrack> {
    let artist: Option<String> = row.get(2)?;
    let album_artist: Option<String> = row.get(3)?;
    let duration_seconds = row.get::<_, Option<f64>>(14)?.unwrap_or(0.0);
    let bitrate = row.get::<_, Option<i64>>(15)?.unwrap_or(0);
    let stored_path = row.get::<_, Option<String>>(20)?.unwrap_or_default();
    let source_path = resolve_stored_track_path(&stored_path, library_root)
        .unwrap_or_else(|_| PathBuf::from(&stored_path));
    let source_absolute = is_absolute_any_platform(source_path.to_string_lossy().as_ref());
    let marked_missing = row.get::<_, Option<i64>>(43)?.unwrap_or(0) == 1;
    Ok(RawTrack {
        track: Track {
            id: row.get::<_, String>(0)?,
            title: row
                .get::<_, Option<String>>(1)?
                .unwrap_or_else(|| "Unknown Title".into()),
            artist: artist.clone().unwrap_or_else(|| "Unknown Artist".into()),
            artist_credits: Vec::new(),
            album_artist: album_artist.clone(),
            album_artist_credits: Vec::new(),
            artists: album_artist,
            album: row
                .get::<_, Option<String>>(4)?
                .unwrap_or_else(|| "Unknown Album".into()),
            track_number: row.get(5)?,
            track_total: row.get(6)?,
            key: row.get(7)?,
            bpm: row.get(8)?,
            year: row.get(9)?,
            date: row.get(10)?,
            date_added: iso_timestamp(row.get(11)?),
            date_modified: iso_timestamp(row.get(12)?),
            rating: row.get::<_, Option<f64>>(13)?.unwrap_or(0.0),
            duration: format_duration(duration_seconds),
            duration_seconds,
            bitrate: if bitrate > 0 {
                format!("{bitrate} kbps")
            } else {
                "--".into()
            },
            sample_rate_hz: positive_i64(row.get(16)?),
            bit_depth: positive_i64(row.get(17)?),
            file_size_bytes: row.get::<_, Option<i64>>(18)?.filter(|value| *value >= 0),
            source_path: source_path.to_string_lossy().into_owned(),
            cover_art_path: row.get(21)?,
            cover_art_thumb_path: row.get(22)?,
            last_played_at: row.get(23)?,
            play_count: row.get::<_, Option<i64>>(24)?.unwrap_or(0),
            genre: json_list(row.get(25)?),
            comment: json_list(row.get(26)?),
            label: row.get(27)?,
            disc_number: row.get(28)?,
            disc_total: row.get(29)?,
            beat_grid_json: row.get(30)?,
            musicbrainz_trackid: row.get(31)?,
            musicbrainz_albumid: row.get(32)?,
            musicbrainz_releasegroupid: row.get(35)?,
            acoustid_id: row.get(36)?,
            loudness_lufs: row.get(37)?,
            replaygain_track_gain_db: row.get(38)?,
            replaygain_track_peak: row.get(39)?,
            replaygain_album_gain_db: row.get(40)?,
            replaygain_album_peak: row.get(41)?,
            loudness_source: row.get(42)?,
            is_missing: if marked_missing || !source_absolute {
                1
            } else {
                0
            },
        },
        import_status: row
            .get::<_, Option<String>>(19)?
            .unwrap_or_else(|| "accepted".into()),
        legacy_artist_mb_id: row.get(33)?,
        legacy_album_artist_mb_id: row.get(34)?,
    })
}

fn hydrate_tracks(
    conn: &Connection,
    mut rows: Vec<RawTrack>,
    exceptions: &[String],
) -> Result<Vec<RawTrack>, String> {
    let ids = rows
        .iter()
        .map(|row| row.track.id.clone())
        .collect::<Vec<_>>();
    let mut structured = load_artist_credits(conn, &ids)?;
    for raw in &mut rows {
        let pair = structured.remove(&raw.track.id).unwrap_or_default();
        raw.track.artist_credits = if pair.0.is_empty() {
            fallback_credits(
                Some(&raw.track.artist),
                raw.legacy_artist_mb_id.as_deref(),
                exceptions,
            )
        } else {
            pair.0
        };
        raw.track.album_artist_credits = if pair.1.is_empty() {
            fallback_credits(
                raw.track.album_artist.as_deref(),
                raw.legacy_album_artist_mb_id.as_deref(),
                exceptions,
            )
        } else {
            pair.1
        };
    }
    Ok(rows)
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_tracks(
    db_path: String,
    library_root: Option<String>,
    artist_separator_exceptions: Option<Vec<String>>,
) -> Result<LibrarySnapshot, String> {
    let conn = open_database(&db_path)?;
    let root = effective_library_root(&conn, library_root.as_deref())?;
    let mut statement = conn
        .prepare(&format!("{TRACK_SELECT} ORDER BY added_at DESC"))
        .map_err(db_error)?;
    let raw = statement
        .query_map([], |row| row_to_raw_track(row, root.as_deref()))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    let hydrated = hydrate_tracks(
        &conn,
        raw,
        artist_separator_exceptions.as_deref().unwrap_or_default(),
    )?;
    let mut snapshot = LibrarySnapshot {
        library: Vec::new(),
        inbox: Vec::new(),
    };
    for raw in hydrated {
        if raw.import_status == "staged" {
            snapshot.inbox.push(raw.track);
        } else {
            snapshot.library.push(raw.track);
        }
    }
    Ok(snapshot)
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_recently_played(
    db_path: String,
    limit: Option<i64>,
    library_root: Option<String>,
    artist_separator_exceptions: Option<Vec<String>>,
) -> Result<Vec<Track>, String> {
    let conn = open_database(&db_path)?;
    let root = effective_library_root(&conn, library_root.as_deref())?;
    let sql = format!(
        "{TRACK_SELECT} WHERE last_played_at IS NOT NULL ORDER BY last_played_at DESC LIMIT ?1"
    );
    let mut statement = conn.prepare(&sql).map_err(db_error)?;
    let raw = statement
        .query_map([limit.unwrap_or(50).max(0)], |row| {
            row_to_raw_track(row, root.as_deref())
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    Ok(hydrate_tracks(
        &conn,
        raw,
        artist_separator_exceptions.as_deref().unwrap_or_default(),
    )?
    .into_iter()
    .map(|raw| raw.track)
    .collect())
}

pub fn load_playlists(
    db_path: String,
    library_root: Option<String>,
) -> Result<PlaylistSnapshot, String> {
    let conn = open_database(&db_path)?;
    let root = effective_library_root(&conn, library_root.as_deref())?;
    let mut tracks_by_playlist: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT playlist_id,track_id FROM playlist_tracks ORDER BY playlist_id,position",
            )
            .map_err(db_error)?;
        for row in statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
        {
            let (playlist, track) = row.map_err(db_error)?;
            tracks_by_playlist.entry(playlist).or_default().push(track);
        }
    }
    let playlists = {
        let mut statement = conn.prepare("SELECT id,name,folder_id,sort_order,source_path,source_mtime_ms,source_size,source_sync_error,last_synced_at FROM playlists ORDER BY folder_id,sort_order,created_at DESC,id").map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let stored: Option<String> = row.get(4)?;
                Ok(Playlist {
                    id: id.clone(),
                    name: row.get(1)?,
                    folder_id: row.get(2)?,
                    sort_order: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    source_path: stored.map(|path| {
                        resolve_stored_track_path(&path, root.as_deref())
                            .unwrap_or_else(|_| PathBuf::from(path))
                            .to_string_lossy()
                            .into_owned()
                    }),
                    source_mtime_ms: row.get(5)?,
                    source_size: row.get(6)?,
                    source_sync_error: row.get(7)?,
                    last_synced_at: row.get(8)?,
                    track_ids: tracks_by_playlist.remove(&id).unwrap_or_default(),
                })
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let folders = {
        let mut statement = conn.prepare("SELECT id,name,parent_id,sort_order FROM playlist_folders ORDER BY parent_id,sort_order,created_at,name COLLATE NOCASE").map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok(PlaylistFolder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    sort_order: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                })
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    Ok(PlaylistSnapshot { playlists, folders })
}

pub fn normalize_search_text(values: &[String]) -> String {
    let joined = values.join(" ");
    let mut result = String::new();
    let mut space = true;
    for ch in joined.nfkd().filter(|ch| !is_combining_mark(*ch)) {
        let separator = ch.is_whitespace() || matches!(ch, '.' | '_' | '\\' | '/' | ':' | '-');
        if separator {
            if !space {
                result.push(' ');
                space = true;
            }
        } else {
            for lower in ch.to_lowercase() {
                result.push(lower);
            }
            space = false;
        }
    }
    result.trim().to_string()
}

fn json_values(raw: Option<String>) -> Vec<String> {
    raw.and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default()
}

fn refresh_search_text(conn: &Connection, track_id: &str) -> Result<bool, String> {
    type SearchTuple = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<f64>,
    );
    let row: Option<SearchTuple> = conn.query_row(
        "SELECT title,artist,album,album_artist,genre_json,comment_json,label,filename,year,track_number,disc_number,key,bpm FROM tracks WHERE id=?1",
        [track_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?)))
        .optional().map_err(db_error)?;
    let Some((
        title,
        artist,
        album,
        album_artist,
        genre,
        comment,
        label,
        filename,
        year,
        track_number,
        disc_number,
        key,
        bpm,
    )) = row
    else {
        return Ok(false);
    };
    let credits = load_artist_credits(conn, &[track_id.to_string()])?
        .remove(track_id)
        .unwrap_or_default();
    let mut values = Vec::new();
    values.extend([title, artist, album, album_artist].into_iter().flatten());
    for credit in credits.0.into_iter().chain(credits.1) {
        values.push(credit.name);
        values.push(credit.credited_name);
    }
    values.extend(json_values(genre));
    values.extend(json_values(comment));
    values.extend([label, filename].into_iter().flatten());
    values.extend(
        [year, track_number, disc_number]
            .into_iter()
            .flatten()
            .map(|value| value.to_string()),
    );
    if let Some(key) = key {
        values.push(key);
    }
    if let Some(bpm) = bpm {
        values.push(bpm.to_string());
    }
    conn.execute(
        "UPDATE tracks SET search_text=?1 WHERE id=?2",
        params![normalize_search_text(&values), track_id],
    )
    .map_err(db_error)?;
    Ok(true)
}

fn backfill_search_text_conn(conn: &Connection, all: bool) -> Result<usize, String> {
    let query = if all {
        "SELECT id FROM tracks"
    } else {
        "SELECT id FROM tracks WHERE search_text IS NULL OR search_text=''"
    };
    let ids = {
        let mut statement = conn.prepare(query).map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut count = 0;
    for id in ids {
        if refresh_search_text(conn, &id)? {
            count += 1;
        }
    }
    Ok(count)
}

fn rebuild_search_index_conn(conn: &Connection) -> Result<(), String> {
    conn.execute("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')", [])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn backfill_search(db_path: String, all: Option<bool>) -> Result<usize, String> {
    let conn = open_database(&db_path)?;
    let count = backfill_search_text_conn(&conn, all.unwrap_or(false))?;
    rebuild_search_index_conn(&conn)?;
    Ok(count)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rebuild_search(db_path: String) -> Result<(), String> {
    let conn = open_database(&db_path)?;
    rebuild_search_index_conn(&conn)
}

pub fn build_search_match_query(query: &str) -> Option<String> {
    let normalized = normalize_search_text(&[query.to_string()]);
    let terms = normalized
        .split_whitespace()
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

#[tauri::command(rename_all = "camelCase")]
pub fn search_tracks(
    db_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Option<Vec<String>>, String> {
    let Some(expression) = build_search_match_query(&query) else {
        return Ok(None);
    };
    let conn = open_database(&db_path)?;
    let bounded = limit
        .filter(|value| *value > 0)
        .unwrap_or(100_000)
        .min(100_000) as i64;
    let mut statement = conn.prepare("SELECT t.id FROM tracks_fts f JOIN tracks t ON t.rowid=f.rowid WHERE tracks_fts MATCH ?1 ORDER BY bm25(tracks_fts) LIMIT ?2").map_err(db_error)?;
    let result =
        match statement.query_map(params![expression, bounded], |row| row.get::<_, String>(0)) {
            Ok(rows) => Ok(Some(rows.filter_map(Result::ok).collect())),
            Err(_) => Ok(None),
        };
    result
}

fn windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\'))
        || value.starts_with("\\\\")
}

fn is_absolute_any_platform(value: &str) -> bool {
    Path::new(value).is_absolute() || windows_absolute(value)
}

pub fn normalize_portable_track_path(value: &str) -> Option<String> {
    let candidate = value.trim().replace('\\', "/");
    if candidate.is_empty() || is_absolute_any_platform(&candidate) {
        return None;
    }
    let segments = candidate.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        segment.is_empty() || matches!(*segment, "." | "..") || segment.contains('\0')
    }) {
        return None;
    }
    Some(segments.join("/"))
}

pub fn normalize_library_root(value: Option<&str>) -> Option<PathBuf> {
    let candidate = value?.trim();
    if candidate.is_empty() {
        return None;
    }
    let path = PathBuf::from(candidate);
    if path.is_absolute() || windows_absolute(candidate) {
        Some(path)
    } else {
        std::env::current_dir().ok().map(|cwd| cwd.join(path))
    }
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

pub fn is_path_inside_library_root(candidate: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        let candidate = path_key(candidate);
        let root = path_key(root).trim_end_matches('/').to_string();
        candidate == root || candidate.starts_with(&(root + "/"))
    } else {
        candidate.starts_with(root)
    }
}

pub fn to_stored_track_path(file_path: &str, root: Option<&Path>) -> String {
    if let Some(portable) = normalize_portable_track_path(file_path) {
        return portable;
    }
    let candidate = file_path.trim();
    if candidate.is_empty() {
        return String::new();
    }
    let path = PathBuf::from(candidate);
    let absolute = if path.is_absolute() || windows_absolute(candidate) {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let Some(root) = root else {
        return absolute.to_string_lossy().into_owned();
    };
    if !is_path_inside_library_root(&absolute, root) {
        return absolute.to_string_lossy().into_owned();
    }
    absolute
        .strip_prefix(root)
        .ok()
        .and_then(|relative| {
            let parts = relative
                .components()
                .filter_map(|part| match part {
                    Component::Normal(value) => value.to_str(),
                    _ => None,
                })
                .collect::<Vec<_>>();
            normalize_portable_track_path(&parts.join("/"))
        })
        .unwrap_or_else(|| absolute.to_string_lossy().into_owned())
}

pub fn resolve_stored_track_path(
    stored_path: &str,
    root: Option<&Path>,
) -> Result<PathBuf, String> {
    let candidate = stored_path.trim();
    if candidate.is_empty() {
        return Ok(PathBuf::new());
    }
    let Some(portable) = normalize_portable_track_path(candidate) else {
        return Ok(PathBuf::from(candidate));
    };
    let Some(root) = root else {
        return Ok(PathBuf::from(portable));
    };
    let resolved = portable
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    if !is_path_inside_library_root(&resolved, root) {
        return Err("Stored track path escapes the library root".into());
    }
    Ok(resolved)
}

fn effective_library_root(
    conn: &Connection,
    requested: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if let Some(root) = normalize_library_root(requested) {
        conn.execute("INSERT INTO app_metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![LIBRARY_ROOT_KEY,root.to_string_lossy()]).map_err(db_error)?;
        return Ok(Some(root));
    }
    let value = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key=?1",
            [LIBRARY_ROOT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    Ok(normalize_library_root(value.as_deref()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_library_root(db_path: String) -> Result<Option<String>, String> {
    let conn = open_database(&db_path)?;
    Ok(effective_library_root(&conn, None)?.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn configure_library_root(
    db_path: String,
    requested_root: String,
) -> Result<LibraryRootResult, String> {
    let conn = open_database(&db_path)?;
    let root = normalize_library_root(Some(&requested_root))
        .ok_or_else(|| "Library root cannot be empty".to_string())?;
    let previous = effective_library_root(&conn, None)?;
    let rows = {
        let mut statement = conn
            .prepare("SELECT id,source_path,import_status FROM tracks")
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    conn.execute("INSERT INTO app_metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![LIBRARY_ROOT_KEY,root.to_string_lossy()]).map_err(db_error)?;
    let mut migrated = 0;
    let mut used: BTreeMap<String, String> = rows
        .iter()
        .map(|(id, path, _)| (path_key(Path::new(path)), id.clone()))
        .collect();
    let root_changed = previous.as_deref().map(path_key) != Some(path_key(&root));
    for (id, stored, status) in rows {
        let resolved = resolve_stored_track_path(&stored, previous.as_deref())?;
        let portable = to_stored_track_path(resolved.to_string_lossy().as_ref(), Some(&root));
        if portable != stored
            && used
                .get(&path_key(Path::new(&portable)))
                .is_none_or(|other| other == &id)
        {
            conn.execute(
                "UPDATE tracks SET source_path=?1 WHERE id=?2",
                params![portable, id],
            )
            .map_err(db_error)?;
            migrated += 1;
            used.insert(path_key(Path::new(&portable)), id.clone());
        }
        if root_changed && status != "staged" && !is_path_inside_library_root(&resolved, &root) {
            conn.execute("UPDATE tracks SET import_status='staged' WHERE id=?1", [id])
                .map_err(db_error)?;
        }
    }
    Ok(LibraryRootResult {
        library_root: root.to_string_lossy().into_owned(),
        migrated,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn resolve_library_path(
    db_path: String,
    stored_path: String,
    library_root: Option<String>,
) -> Result<String, String> {
    let conn = open_database(&db_path)?;
    let root = effective_library_root(&conn, library_root.as_deref())?;
    Ok(resolve_stored_track_path(&stored_path, root.as_deref())?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub fn store_library_path(
    db_path: String,
    file_path: String,
    library_root: Option<String>,
) -> Result<String, String> {
    let conn = open_database(&db_path)?;
    let root = effective_library_root(&conn, library_root.as_deref())?;
    Ok(to_stored_track_path(&file_path, root.as_deref()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn migrate_artist_credits(
    db_path: String,
    exceptions: Option<Vec<String>>,
) -> Result<ArtistMigrationResult, String> {
    let conn = open_database(&db_path)?;
    migrate_artist_credits_impl(&conn, exceptions.as_deref().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn schema_is_idempotent_and_has_electron_tables() {
        let conn = memory_db();
        ensure_schema(&conn).unwrap();
        for table in [
            "tracks",
            "playlist_folders",
            "play_history",
            "artist_entities",
            "tracks_fts",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "missing {table}");
        }
        assert!(columns(&conn, "tracks")
            .unwrap()
            .contains("loudness_source"));
    }

    #[test]
    fn legacy_artist_parser_preserves_join_phrases() {
        let credits = parse_legacy_artist_credits("A, B & C feat. D", &[]);
        assert_eq!(credits.len(), 4);
        assert_eq!(
            credits
                .iter()
                .map(|credit| format!("{}{}", credit.credited_name, credit.join_phrase))
                .collect::<String>(),
            "A, B & C feat. D"
        );
    }

    #[test]
    fn exact_artist_exception_is_atomic() {
        let credits =
            parse_legacy_artist_credits("Earth, Wind & Fire", &["Earth, Wind & Fire".into()]);
        assert_eq!(credits.len(), 1);
    }

    #[test]
    fn search_is_diacritic_insensitive_and_prefix_based() {
        assert_eq!(normalize_search_text(&["Björk: Jóga".into()]), "bjork joga");
        assert_eq!(
            build_search_match_query("Björ jo"),
            Some("\"bjor\"* AND \"jo\"*".into())
        );
    }

    #[test]
    fn portable_paths_round_trip_under_root() {
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\Music")
        } else {
            PathBuf::from("/music")
        };
        let absolute = root.join("Artist").join("Track.flac");
        let stored = to_stored_track_path(absolute.to_string_lossy().as_ref(), Some(&root));
        assert_eq!(stored, "Artist/Track.flac");
        assert_eq!(
            resolve_stored_track_path(&stored, Some(&root)).unwrap(),
            absolute
        );
        assert!(normalize_portable_track_path("../escape.flac").is_none());
    }

    #[test]
    fn fts_backfill_finds_track() {
        let conn = memory_db();
        conn.execute("INSERT INTO tracks(id,title,artist,album,source_path,import_status) VALUES('1','Hyper-Ballad','Björk','Post','x.flac','accepted')",[]).unwrap();
        backfill_search_text_conn(&conn, true).unwrap();
        rebuild_search_index_conn(&conn).unwrap();
        let expression = build_search_match_query("hyper bjo").unwrap();
        let id: String = conn.query_row("SELECT t.id FROM tracks_fts f JOIN tracks t ON t.rowid=f.rowid WHERE tracks_fts MATCH ?1",[expression],|row|row.get(0)).unwrap();
        assert_eq!(id, "1");
    }

    #[test]
    fn artist_migration_is_durable_and_skips_same_state() {
        let conn = memory_db();
        conn.execute("INSERT INTO tracks(id,title,artist,album,source_path,import_status) VALUES('1','Song','A & B','Album','x.flac','accepted')",[]).unwrap();
        let first = migrate_artist_credits_impl(&conn, &[]).unwrap();
        assert_eq!(first.credits_created, 2);
        assert!(migrate_artist_credits_impl(&conn, &[]).unwrap().skipped);
        let count: i64 = conn
            .query_row("SELECT count(*) FROM track_artist_credits", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
    }
}
