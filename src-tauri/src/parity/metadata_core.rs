//! Native metadata-adjacent commands that do not require online services.
//!
//! The functions in this module intentionally open a short-lived SQLite
//! connection per command, matching the rest of the parity backend. Audio
//! property extraction is performed by Lofty; no Node runtime is involved.

use lofty::prelude::AudioFile;
use lofty::probe::Probe;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use uuid::Uuid;

const DEFAULT_TECHNICAL_BATCH_SIZE: i64 = 25;
const MAX_TECHNICAL_BATCH_SIZE: i64 = 200;
const DEFAULT_LOUDNESS_BATCH_SIZE: i64 = 250;
const MAX_LOUDNESS_BATCH_SIZE: i64 = 2_000;
const DEFAULT_HISTORY_LIMIT: i64 = 100;
const MAX_HISTORY_LIMIT: i64 = 500;
const DEFAULT_REFERENCE_LUFS: f64 = -18.0;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TechnicalMetadataScanResult {
    pub checked: usize,
    pub updated: usize,
    pub failed: usize,
    pub remaining: usize,
}

/// Electron currently consumes `source_path`; `sourcePath` is included as the
/// canonical camelCase field so new callers can migrate without another native
/// API change.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingLoudnessTrack {
    pub id: String,
    pub source_path: String,
    #[serde(rename = "source_path")]
    pub legacy_source_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub updated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumGainResult {
    pub albums: usize,
    pub updated: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataHistoryEntry {
    pub id: i64,
    pub track_id: String,
    pub changed_at: String,
    pub source: String,
    pub changes: Value,
    pub title: String,
    pub artist: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataWriteFailure {
    pub track_id: String,
    pub file_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataWriteResult {
    pub updated: usize,
    pub files_written: usize,
    pub file_write_errors: Vec<MetadataWriteFailure>,
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn now_iso8601() -> String {
    // SQLite can format a stable UTC timestamp without adding a time crate.
    // Fall back to Unix seconds only if the in-memory helper unexpectedly fails.
    Connection::open_in_memory()
        .and_then(|conn| {
            conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
                row.get(0)
            })
        })
        .unwrap_or_else(|_| now_seconds().to_string())
}

fn open_database(db_path: &str) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(db_error)?;
    super::database::ensure_schema(&conn)?;
    Ok(conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_track_beat_grid(
    db_path: String,
    track_id: String,
    beat_grid_json: String,
) -> Result<UpdateResult, String> {
    let invalid = || "Invalid beat grid payload".to_string();
    if track_id.is_empty() || beat_grid_json.len() > 4_096 {
        return Err(invalid());
    }
    let parsed: Value = serde_json::from_str(&beat_grid_json).map_err(|_| invalid())?;
    if !parsed
        .as_object()
        .and_then(|object| object.get("bpm"))
        .is_some_and(Value::is_number)
    {
        return Err(invalid());
    }
    let connection = open_database(&db_path)?;
    let changed = connection
        .execute(
            "UPDATE tracks SET beat_grid_json=?1,updated_at=?2 WHERE id=?3",
            params![beat_grid_json, now_seconds(), track_id],
        )
        .map_err(db_error)?;
    Ok(UpdateResult {
        updated: changed > 0,
    })
}

fn bounded_limit(requested: Option<i64>, default: i64, maximum: i64) -> i64 {
    requested.unwrap_or(default).clamp(1, maximum)
}

fn library_root(conn: &Connection) -> Result<Option<PathBuf>, String> {
    let value = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key='library_root'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    Ok(value
        .as_deref()
        .and_then(super::library_ops::normalize_library_root))
}

fn resolve_track_path(stored_path: &str, root: Option<&Path>) -> Result<PathBuf, String> {
    super::library_ops::resolve_stored_track_path(stored_path, root)
}

fn extract_technical_metadata(source_path: &Path) -> Result<(i64, i64, i64), String> {
    let tagged = Probe::open(source_path)
        .map_err(|error| error.to_string())?
        .read()
        .map_err(|error| error.to_string())?;
    let properties = tagged.properties();
    let size = std::fs::metadata(source_path)
        .map_err(|error| error.to_string())?
        .len();
    let size = i64::try_from(size).map_err(|_| "Audio file is too large".to_string())?;
    Ok((
        properties.sample_rate().unwrap_or_default() as i64,
        properties.bit_depth().unwrap_or_default() as i64,
        size,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn scan_technical_metadata(
    db_path: String,
    limit: Option<i64>,
) -> Result<TechnicalMetadataScanResult, String> {
    let conn = open_database(&db_path)?;
    let root = library_root(&conn)?;
    let limit = bounded_limit(
        limit,
        DEFAULT_TECHNICAL_BATCH_SIZE,
        MAX_TECHNICAL_BATCH_SIZE,
    );
    let rows = {
        let mut statement = conn
            .prepare(
                "SELECT id,source_path FROM tracks
                 WHERE sample_rate_hz IS NULL OR file_size_bytes IS NULL
                 ORDER BY added_at DESC LIMIT ?1",
            )
            .map_err(db_error)?;
        let mapped = statement
            .query_map([limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut updated = 0;
    let mut failed = 0;
    let mut update = conn
        .prepare("UPDATE tracks SET sample_rate_hz=?1,bit_depth=?2,file_size_bytes=?3 WHERE id=?4")
        .map_err(db_error)?;
    for (track_id, stored_path) in &rows {
        let technical = resolve_track_path(stored_path, root.as_deref())
            .and_then(|path| extract_technical_metadata(&path));
        match technical {
            Ok((sample_rate, bit_depth, file_size)) => {
                update
                    .execute(params![sample_rate, bit_depth, file_size, track_id])
                    .map_err(db_error)?;
                updated += 1;
            }
            Err(_) => {
                // Match Electron: mark unreadable sources as scanned so one bad
                // file cannot permanently block all subsequent batches.
                update
                    .execute(params![0_i64, 0_i64, 0_i64, track_id])
                    .map_err(db_error)?;
                failed += 1;
            }
        }
    }
    drop(update);
    let remaining = conn
        .query_row(
            "SELECT COUNT(*) FROM tracks WHERE sample_rate_hz IS NULL OR file_size_bytes IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?
        .max(0) as usize;
    Ok(TechnicalMetadataScanResult {
        checked: rows.len(),
        updated,
        failed,
        remaining,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_tracks_needing_loudness(
    db_path: String,
    limit: Option<i64>,
) -> Result<Vec<PendingLoudnessTrack>, String> {
    let conn = open_database(&db_path)?;
    let root = library_root(&conn)?;
    let limit = bounded_limit(limit, DEFAULT_LOUDNESS_BATCH_SIZE, MAX_LOUDNESS_BATCH_SIZE);
    let mut statement = conn
        .prepare(
            "SELECT id,source_path FROM tracks
             WHERE replaygain_track_gain_db IS NULL
               AND import_status != 'staged'
               AND COALESCE(is_missing,0)=0
             ORDER BY added_at DESC LIMIT ?1",
        )
        .map_err(db_error)?;
    let mapped = statement
        .query_map([limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    mapped
        .map(|row| {
            let (id, stored_path) = row.map_err(db_error)?;
            let resolved = resolve_track_path(&stored_path, root.as_deref())?
                .to_string_lossy()
                .into_owned();
            Ok(PendingLoudnessTrack {
                id,
                source_path: resolved.clone(),
                legacy_source_path: resolved,
            })
        })
        .collect()
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|number| number.is_finite())
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_track_loudness(
    db_path: String,
    track_id: String,
    integrated_lufs: Option<f64>,
    gain_db: Option<f64>,
    peak: Option<f64>,
    source: Option<String>,
) -> Result<UpdateResult, String> {
    if track_id.is_empty() {
        return Err("Invalid loudness payload".to_string());
    }
    let conn = open_database(&db_path)?;
    let changed = conn
        .execute(
            "UPDATE tracks SET loudness_lufs=?1,replaygain_track_gain_db=?2,
             replaygain_track_peak=?3,loudness_source=?4 WHERE id=?5",
            params![
                finite(integrated_lufs),
                finite(gain_db),
                finite(peak),
                if source.as_deref() == Some("tag") {
                    "tag"
                } else {
                    "analyzed"
                },
                track_id
            ],
        )
        .map_err(db_error)?;
    Ok(UpdateResult {
        updated: changed > 0,
    })
}

#[derive(Default)]
struct AlbumBucket {
    track_ids: Vec<String>,
    energy: Vec<f64>,
    peak: f64,
}

#[tauri::command(rename_all = "camelCase")]
pub fn recompute_album_gain(
    db_path: String,
    reference_lufs: Option<f64>,
) -> Result<AlbumGainResult, String> {
    let mut conn = open_database(&db_path)?;
    let reference = finite(reference_lufs).unwrap_or(DEFAULT_REFERENCE_LUFS);
    let rows = {
        let mut statement = conn
            .prepare(
                "SELECT id,album,COALESCE(NULLIF(album_artist,''),artist),
                        loudness_lufs,replaygain_track_peak
                 FROM tracks
                 WHERE loudness_lufs IS NOT NULL AND album IS NOT NULL AND album != ''",
            )
            .map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                ))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut albums = std::collections::BTreeMap::<String, AlbumBucket>::new();
    for (id, album, artist, lufs, peak) in rows {
        if !lufs.is_finite() {
            continue;
        }
        let key = format!("{}\0{}", artist.to_lowercase(), album.to_lowercase());
        let bucket = albums.entry(key).or_default();
        bucket.track_ids.push(id);
        bucket.energy.push(10_f64.powf((lufs + 0.691) / 10.0));
        if let Some(peak) = finite(peak) {
            bucket.peak = bucket.peak.max(peak);
        }
    }
    let tx = conn.transaction().map_err(db_error)?;
    let mut updated = 0;
    {
        let mut update = tx
            .prepare(
                "UPDATE tracks SET replaygain_album_gain_db=?1,replaygain_album_peak=?2 WHERE id=?3",
            )
            .map_err(db_error)?;
        for bucket in albums.values() {
            let mean = bucket.energy.iter().sum::<f64>() / bucket.energy.len() as f64;
            if !(mean > 0.0) || !mean.is_finite() {
                continue;
            }
            let album_lufs = -0.691 + 10.0 * mean.log10();
            let album_gain = reference - album_lufs;
            let peak = (bucket.peak > 0.0).then_some(bucket.peak);
            for id in &bucket.track_ids {
                updated += update
                    .execute(params![album_gain, peak, id])
                    .map_err(db_error)?;
            }
        }
    }
    tx.commit().map_err(db_error)?;
    Ok(AlbumGainResult {
        albums: albums.len(),
        updated,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_metadata_history(
    db_path: String,
    track_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MetadataHistoryEntry>, String> {
    let conn = open_database(&db_path)?;
    let limit = bounded_limit(limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    let (query, values): (&str, Vec<SqlValue>) = if let Some(track_id) = track_id {
        (
            "SELECT h.id,h.track_id,h.changed_at,h.source,h.changes_json,t.title,t.artist
             FROM metadata_change_history h LEFT JOIN tracks t ON t.id=h.track_id
             WHERE h.track_id=?1 ORDER BY h.id DESC LIMIT ?2",
            vec![SqlValue::Text(track_id), SqlValue::Integer(limit)],
        )
    } else {
        (
            "SELECT h.id,h.track_id,h.changed_at,h.source,h.changes_json,t.title,t.artist
             FROM metadata_change_history h LEFT JOIN tracks t ON t.id=h.track_id
             ORDER BY h.id DESC LIMIT ?1",
            vec![SqlValue::Integer(limit)],
        )
    };
    let mut statement = conn.prepare(query).map_err(db_error)?;
    let mapped = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            let raw: String = row.get(4)?;
            Ok(MetadataHistoryEntry {
                id: row.get(0)?,
                track_id: row.get(1)?,
                changed_at: row.get(2)?,
                source: row.get(3)?,
                changes: serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
                title: row
                    .get::<_, Option<String>>(5)?
                    .unwrap_or_else(|| "Unknown Title".to_string()),
                artist: row
                    .get::<_, Option<String>>(6)?
                    .unwrap_or_else(|| "Unknown Artist".to_string()),
            })
        })
        .map_err(db_error)?;
    mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn metadata_column(field: &str) -> Option<&'static str> {
    Some(match field {
        "title" => "title",
        "artist" => "artist",
        "artists" | "albumArtist" => "album_artist",
        "album" => "album",
        "trackNumber" => "track_number",
        "trackTotal" => "track_total",
        "discNumber" => "disc_number",
        "discTotal" => "disc_total",
        "year" => "year",
        "genre" => "genre_json",
        "comment" => "comment_json",
        "label" => "label",
        "bpm" => "bpm",
        "key" => "key",
        "rating" => "rating",
        "coverArtPath" => "cover_art_path",
        "coverArtThumbPath" => "cover_art_thumb_path",
        "musicBrainzTrackId" => "musicbrainz_trackid",
        "musicBrainzAlbumId" => "musicbrainz_albumid",
        "musicBrainzReleaseGroupId" => "musicbrainz_releasegroupid",
        "acoustIdId" => "acoustid_id",
        _ => return None,
    })
}

fn metadata_json_from_sql(field: &str, value: SqlValue) -> Value {
    if matches!(field, "genre" | "comment") {
        if let SqlValue::Text(text) = value {
            return serde_json::from_str(&text).unwrap_or_else(|_| json!([]));
        }
        return json!([]);
    }
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(value) => json!(value),
        SqlValue::Real(value) => json!(value),
        SqlValue::Text(value) => json!(value),
        SqlValue::Blob(_) => Value::Null,
    }
}

fn metadata_sql_value(field: &str, value: &Value) -> Result<SqlValue, String> {
    if matches!(field, "genre" | "comment") {
        let values = match value {
            Value::Array(items) => items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
            Value::String(text) => text
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect(),
            Value::Null => Vec::new(),
            _ => return Err(format!("Invalid rollback value for {field}")),
        };
        return serde_json::to_string(&values)
            .map(SqlValue::Text)
            .map_err(|error| error.to_string());
    }
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::String(value) => Ok(SqlValue::Text(value.clone())),
        Value::Number(value) if value.is_i64() => Ok(SqlValue::Integer(value.as_i64().unwrap())),
        Value::Number(value) => value
            .as_f64()
            .filter(|number| number.is_finite())
            .map(SqlValue::Real)
            .ok_or_else(|| format!("Invalid rollback value for {field}")),
        _ => Err(format!("Invalid rollback value for {field}")),
    }
}

fn normalize_name(value: &str) -> String {
    value
        .nfkd()
        .filter(|ch| !is_combining_mark(*ch))
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn restore_credits(
    conn: &Connection,
    track_id: &str,
    scope: &str,
    display: &str,
    credits: Option<&Value>,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM track_artist_credit_sets WHERE track_id=?1 AND scope=?2",
        params![track_id, scope],
    )
    .map_err(db_error)?;
    let Some(items) = credits.and_then(Value::as_array) else {
        return Ok(());
    };
    if display.trim().is_empty() || items.is_empty() {
        return Ok(());
    }
    let now = now_seconds();
    conn.execute(
        "INSERT INTO track_artist_credit_sets(
           track_id,scope,display_text,provenance,confidence,needs_review,created_at,updated_at
         ) VALUES(?1,?2,?3,'rollback',100,0,?4,?4)",
        params![track_id, scope, display, now],
    )
    .map_err(db_error)?;
    for (position, item) in items.iter().enumerate() {
        let credited_name = item
            .get("creditedName")
            .or_else(|| item.get("credited_name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(credited_name)
            .trim();
        if name.is_empty() || credited_name.trim().is_empty() {
            return Err("Metadata history contains an invalid artist credit".to_string());
        }
        let musicbrainz_id = item
            .get("musicBrainzId")
            .or_else(|| item.get("musicbrainz_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let existing = if let Some(musicbrainz_id) = musicbrainz_id {
            conn.query_row(
                "SELECT id FROM artist_entities WHERE musicbrainz_id=?1 COLLATE NOCASE",
                [musicbrainz_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
        } else {
            None
        };
        let normalized = normalize_name(name);
        let by_name = if existing.is_none() {
            conn.query_row(
                "SELECT id FROM artist_entities WHERE normalized_name=?1 ORDER BY created_at,id LIMIT 1",
                [&normalized],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
        } else {
            None
        };
        let artist_id = if let Some(id) = existing.or(by_name) {
            id
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO artist_entities(
                   id,canonical_name,normalized_name,musicbrainz_id,created_at,updated_at
                 ) VALUES(?1,?2,?3,?4,?5,?5)",
                params![id, name, normalized, musicbrainz_id, now],
            )
            .map_err(db_error)?;
            id
        };
        let join_phrase = item
            .get("joinPhrase")
            .or_else(|| item.get("join_phrase"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let role = item.get("role").and_then(Value::as_str);
        conn.execute(
            "INSERT INTO track_artist_credits(
               track_id,scope,position,artist_id,credited_name,join_phrase,role
             ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                track_id,
                scope,
                position as i64,
                artist_id,
                credited_name,
                join_phrase,
                role
            ],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn refresh_search_text(conn: &Connection, track_id: &str) -> Result<(), String> {
    type SearchFields = (
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
    let fields: SearchFields = conn
        .query_row(
            "SELECT title,artist,album,album_artist,genre_json,comment_json,label,filename,
                    year,track_number,disc_number,key,bpm FROM tracks WHERE id=?1",
            [track_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                ))
            },
        )
        .map_err(db_error)?;
    let mut parts = Vec::new();
    parts.extend(
        [fields.0, fields.1, fields.2, fields.3]
            .into_iter()
            .flatten(),
    );
    for raw in [fields.4, fields.5].into_iter().flatten() {
        parts.extend(serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default());
    }
    parts.extend([fields.6, fields.7].into_iter().flatten());
    parts.extend(
        [fields.8, fields.9, fields.10]
            .into_iter()
            .flatten()
            .map(|value| value.to_string()),
    );
    if let Some(key) = fields.11 {
        parts.push(key);
    }
    if let Some(bpm) = fields.12 {
        parts.push(bpm.to_string());
    }
    conn.execute(
        "UPDATE tracks SET search_text=?1 WHERE id=?2",
        params![super::database::normalize_search_text(&parts), track_id],
    )
    .map_err(db_error)?;
    Ok(())
}

pub fn rollback_metadata_change(
    db_path: String,
    history_id: i64,
    field: String,
) -> Result<MetadataWriteResult, String> {
    let mut conn = open_database(&db_path)?;
    let row = conn
        .query_row(
            "SELECT track_id,changes_json FROM metadata_change_history WHERE id=?1",
            [history_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Metadata history entry was not found".to_string())?;
    let changes: Value = serde_json::from_str(&row.1)
        .map_err(|_| "Metadata history entry is invalid".to_string())?;
    let change = changes
        .get(&field)
        .and_then(Value::as_object)
        .ok_or_else(|| "That field is not part of this metadata change".to_string())?;
    let column = metadata_column(&field)
        .ok_or_else(|| "That field is not part of this metadata change".to_string())?;
    let rollback_value = change
        .get("before")
        .ok_or_else(|| "Metadata history entry has no previous value".to_string())?;
    let sql_value = metadata_sql_value(&field, rollback_value)?;
    let tx = conn.transaction().map_err(db_error)?;
    let current = tx
        .query_row(
            &format!("SELECT {column} FROM tracks WHERE id=?1"),
            [&row.0],
            |row| row.get::<_, SqlValue>(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Track was not found in the library".to_string())?;
    tx.execute(
        &format!("UPDATE tracks SET {column}=?1,updated_at=?2 WHERE id=?3"),
        params![sql_value, now_seconds(), row.0],
    )
    .map_err(db_error)?;
    if matches!(field.as_str(), "artist" | "artists" | "albumArtist") {
        let display = rollback_value.as_str().unwrap_or_default();
        restore_credits(
            &tx,
            &row.0,
            if field == "artist" { "track" } else { "album" },
            display,
            change.get("beforeCredits"),
        )?;
    }
    refresh_search_text(&tx, &row.0)?;
    let mut rollback_changes = Map::new();
    rollback_changes.insert(
        field.clone(),
        json!({
            "before": metadata_json_from_sql(&field, current),
            "after": rollback_value,
        }),
    );
    tx.execute(
        "INSERT INTO metadata_change_history(track_id,changed_at,source,changes_json)
         VALUES(?1,?2,'rollback',?3)",
        params![
            row.0,
            now_iso8601(),
            Value::Object(rollback_changes).to_string()
        ],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    // File writes intentionally remain the responsibility of the full metadata
    // writer. This isolated core performs a safe, auditable DB rollback only.
    Ok(MetadataWriteResult {
        updated: 1,
        files_written: 0,
        file_write_errors: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_database() -> PathBuf {
        let path = std::env::temp_dir().join(format!("muro-metadata-core-{}.db", Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        super::super::database::ensure_schema(&conn).unwrap();
        path
    }

    fn insert_track(conn: &Connection, id: &str, status: &str, source_path: &str) {
        conn.execute(
            "INSERT INTO tracks(
               id,title,artist,album,source_path,import_status,added_at,updated_at
             ) VALUES(?1,'Title','Artist','Album',?2,?3,10,10)",
            params![id, source_path, status],
        )
        .unwrap();
    }

    #[test]
    fn loudness_track_serialization_supports_camel_and_legacy_paths() {
        let value = serde_json::to_value(PendingLoudnessTrack {
            id: "track".into(),
            source_path: "C:/Music/track.flac".into(),
            legacy_source_path: "C:/Music/track.flac".into(),
        })
        .unwrap();
        assert_eq!(value["sourcePath"], "C:/Music/track.flac");
        assert_eq!(value["source_path"], "C:/Music/track.flac");
    }
    #[test]
    fn technical_scan_marks_an_unreadable_source_as_scanned() {
        let path = test_database();
        let conn = Connection::open(&path).unwrap();
        insert_track(&conn, "missing", "accepted", "definitely-missing.flac");
        drop(conn);

        let result =
            scan_technical_metadata(path.to_string_lossy().into_owned(), Some(25)).unwrap();
        assert_eq!(result.checked, 1);
        assert_eq!(result.failed, 1);
        assert_eq!(result.remaining, 0);
        let conn = Connection::open(&path).unwrap();
        let values: (i64, i64, i64) = conn
            .query_row(
                "SELECT sample_rate_hz,bit_depth,file_size_bytes FROM tracks WHERE id='missing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(values, (0, 0, 0));
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn loudness_queue_filters_staged_missing_and_existing_gain() {
        let path = test_database();
        let conn = Connection::open(&path).unwrap();
        for (id, status) in [
            ("ready", "accepted"),
            ("staged", "staged"),
            ("missing", "accepted"),
            ("tagged", "accepted"),
        ] {
            insert_track(&conn, id, status, &format!("{id}.flac"));
        }
        conn.execute("UPDATE tracks SET is_missing=1 WHERE id='missing'", [])
            .unwrap();
        conn.execute(
            "UPDATE tracks SET replaygain_track_gain_db=-7 WHERE id='tagged'",
            [],
        )
        .unwrap();
        drop(conn);

        let tracks =
            list_tracks_needing_loudness(path.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].id, "ready");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn album_gain_uses_energy_domain_and_peak_maximum() {
        let path = test_database();
        let conn = Connection::open(&path).unwrap();
        insert_track(&conn, "a", "accepted", "a.flac");
        insert_track(&conn, "b", "accepted", "b.flac");
        conn.execute(
            "UPDATE tracks SET loudness_lufs=-18,replaygain_track_peak=.5 WHERE id='a'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE tracks SET loudness_lufs=-12,replaygain_track_peak=.9 WHERE id='b'",
            [],
        )
        .unwrap();
        drop(conn);

        let result =
            recompute_album_gain(path.to_string_lossy().into_owned(), Some(-18.0)).unwrap();
        assert_eq!(result.albums, 1);
        assert_eq!(result.updated, 2);
        let conn = Connection::open(&path).unwrap();
        let (gain_a, gain_b, peak): (f64, f64, f64) = conn.query_row(
            "SELECT a.replaygain_album_gain_db,b.replaygain_album_gain_db,a.replaygain_album_peak
             FROM tracks a JOIN tracks b ON b.id='b' WHERE a.id='a'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert!((gain_a - gain_b).abs() < 1e-9);
        assert!(gain_a < 0.0);
        assert!((peak - 0.9).abs() < 1e-9);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn history_listing_and_scalar_rollback_are_auditable() {
        let path = test_database();
        let conn = Connection::open(&path).unwrap();
        insert_track(&conn, "track", "accepted", "track.flac");
        conn.execute("UPDATE tracks SET rating=4.5 WHERE id='track'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO metadata_change_history(track_id,changed_at,source,changes_json)
             VALUES('track','2026-01-01T00:00:00.000Z','user',?1)",
            [json!({"rating":{"before":2.0,"after":4.5}}).to_string()],
        )
        .unwrap();
        drop(conn);

        let before = list_metadata_history(
            path.to_string_lossy().into_owned(),
            Some("track".into()),
            None,
        )
        .unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].track_id, "track");
        let result = rollback_metadata_change(
            path.to_string_lossy().into_owned(),
            before[0].id,
            "rating".into(),
        )
        .unwrap();
        assert_eq!(result.updated, 1);
        let conn = Connection::open(&path).unwrap();
        let rating: f64 = conn
            .query_row("SELECT rating FROM tracks WHERE id='track'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!((rating - 2.0).abs() < 1e-9);
        let sources: Vec<String> = {
            let mut statement = conn
                .prepare("SELECT source FROM metadata_change_history ORDER BY id")
                .unwrap();
            let mapped = statement.query_map([], |row| row.get(0)).unwrap();
            mapped.collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(sources, vec!["user", "rollback"]);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
