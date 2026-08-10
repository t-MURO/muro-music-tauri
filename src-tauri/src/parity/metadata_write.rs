//! Native, auditable metadata writes.
//!
//! The database remains the source of truth: its transaction commits before
//! file I/O, and every file failure is reported and persisted independently.

use crate::parity::database::{find_bound_artist_id, find_unidentified_artist_id};
use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::id3::v2::Popularimeter;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use uuid::Uuid;

const MP3_POPM_BY_HALF_STAR: [u8; 11] = [0, 13, 1, 54, 64, 118, 128, 186, 196, 242, 255];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteError {
    pub track_id: String,
    pub file_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataWriteResult {
    pub updated: usize,
    pub files_written: usize,
    pub file_write_errors: Vec<FileWriteError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArtistCredit {
    artist_id: Option<String>,
    name: String,
    credited_name: String,
    join_phrase: String,
    musicbrainz_id: Option<String>,
    role: Option<String>,
}

#[derive(Debug, Clone)]
struct CreditPlan {
    scope: &'static str,
    display_key: &'static str,
    display_text: String,
    credits: Vec<ArtistCredit>,
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn open_database(db_path: &str) -> Result<Connection, String> {
    let path = Path::new(db_path);
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(db_error)?;
    super::database::ensure_schema(&conn)?;
    Ok(conn)
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn now_iso8601() -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(now_seconds(), 0)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
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

fn canonical_updates(mut updates: Map<String, Value>) -> Map<String, Value> {
    if let Some(album_artist) = updates.remove("albumArtist") {
        updates.insert("artists".to_string(), album_artist);
    }
    if updates.contains_key("artistCredits") && !updates.contains_key("artist") {
        let display = normalize_credits(updates.get("artistCredits"))
            .iter()
            .map(|credit| format!("{}{}", credit.credited_name, credit.join_phrase))
            .collect::<String>();
        updates.insert("artist".to_string(), Value::String(display));
    }
    if updates.contains_key("albumArtistCredits") && !updates.contains_key("artists") {
        let display = normalize_credits(updates.get("albumArtistCredits"))
            .iter()
            .map(|credit| format!("{}{}", credit.credited_name, credit.join_phrase))
            .collect::<String>();
        updates.insert("artists".to_string(), Value::String(display));
    }
    updates
}

fn text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn normalize_credits(value: Option<&Value>) -> Vec<ArtistCredit> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|raw| {
            let credited_name = raw
                .get("creditedName")
                .or_else(|| raw.get("credited_name"))
                .or_else(|| raw.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = raw
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&credited_name)
                .trim()
                .to_string();
            if name.is_empty() || credited_name.is_empty() {
                return None;
            }
            let optional = |camel: &str, snake: &str| {
                raw.get(camel)
                    .or_else(|| raw.get(snake))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            Some(ArtistCredit {
                artist_id: optional("artistId", "artist_id"),
                name,
                credited_name,
                join_phrase: raw
                    .get("joinPhrase")
                    .or_else(|| raw.get("join_phrase"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                musicbrainz_id: optional("musicBrainzId", "musicbrainz_id"),
                role: raw
                    .get("role")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            })
        })
        .collect()
}

fn legacy_credit(display: &str) -> Vec<ArtistCredit> {
    let name = display.trim();
    if name.is_empty() {
        Vec::new()
    } else {
        vec![ArtistCredit {
            artist_id: None,
            name: name.to_string(),
            credited_name: display.to_string(),
            join_phrase: String::new(),
            musicbrainz_id: None,
            role: None,
        }]
    }
}

fn credit_plans(updates: &Map<String, Value>) -> Vec<CreditPlan> {
    [
        ("track", "artist", "artistCredits"),
        ("album", "artists", "albumArtistCredits"),
    ]
    .into_iter()
    .filter_map(|(scope, display_key, credits_key)| {
        if !updates.contains_key(display_key) && !updates.contains_key(credits_key) {
            return None;
        }
        let display_text = text_value(updates.get(display_key));
        let credits = if updates.contains_key(credits_key) {
            normalize_credits(updates.get(credits_key))
        } else {
            legacy_credit(&display_text)
        };
        Some(CreditPlan {
            scope,
            display_key,
            display_text,
            credits,
        })
    })
    .collect()
}

fn list_value(value: &Value) -> Vec<String> {
    match value {
        Value::Array(values) => values
            .iter()
            .filter_map(|value| match value {
                Value::String(value) => Some(value.clone()),
                Value::Null => None,
                value => Some(value.to_string()),
            })
            .flat_map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .collect(),
        Value::Null => Vec::new(),
        Value::String(value) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        value => value
            .to_string()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
    }
}

fn sql_value(field: &str, value: &Value) -> Result<SqlValue, String> {
    if matches!(field, "genre" | "comment") {
        return serde_json::to_string(&list_value(value))
            .map(SqlValue::Text)
            .map_err(|error| error.to_string());
    }
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) if value.is_i64() => SqlValue::Integer(value.as_i64().unwrap()),
        Value::Number(value) if value.is_u64() => {
            let number = value.as_u64().unwrap();
            if number > i64::MAX as u64 {
                return Err(format!("Metadata value for {field} is out of range"));
            }
            SqlValue::Integer(number as i64)
        }
        Value::Number(value) => SqlValue::Real(
            value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("Metadata value for {field} is invalid"))?,
        ),
        Value::String(value) => SqlValue::Text(value.clone()),
        value => SqlValue::Text(value.to_string()),
    })
}

fn json_from_sql(field: &str, value: SqlValue) -> Value {
    if matches!(field, "genre" | "comment") {
        return match value {
            SqlValue::Text(value) => serde_json::from_str(&value).unwrap_or_else(|_| json!([])),
            _ => json!([]),
        };
    }
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(value) => json!(value),
        SqlValue::Real(value) => json!(value),
        SqlValue::Text(value) => json!(value),
        SqlValue::Blob(_) => Value::Null,
    }
}

fn credit_json(credits: &[ArtistCredit]) -> Value {
    Value::Array(
        credits
            .iter()
            .map(|credit| {
                json!({
                    "name": credit.name,
                    "creditedName": credit.credited_name,
                    "joinPhrase": credit.join_phrase,
                    "musicBrainzId": credit.musicbrainz_id,
                    "role": credit.role,
                })
            })
            .collect(),
    )
}

fn credits_equal(left: &[ArtistCredit], right: &[ArtistCredit]) -> bool {
    credit_json(left) == credit_json(right)
}

fn load_credits(
    conn: &Connection,
    track_id: &str,
    scope: &str,
    display: &str,
) -> Result<Vec<ArtistCredit>, String> {
    let mut statement = conn
        .prepare(
            "SELECT c.artist_id,e.canonical_name,c.credited_name,c.join_phrase,e.musicbrainz_id,c.role
             FROM track_artist_credit_sets s
             JOIN track_artist_credits c ON c.track_id=s.track_id AND c.scope=s.scope
             JOIN artist_entities e ON e.id=c.artist_id
             WHERE s.track_id=?1 AND s.scope=?2 AND s.display_text=?3 ORDER BY c.position",
        )
        .map_err(db_error)?;
    let mapped = statement
        .query_map(params![track_id, scope, display], |row| {
            Ok(ArtistCredit {
                artist_id: row.get(0)?,
                name: row.get(1)?,
                credited_name: row.get(2)?,
                join_phrase: row.get(3)?,
                musicbrainz_id: row.get(4)?,
                role: row.get(5)?,
            })
        })
        .map_err(db_error)?;
    let values = mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
    Ok(if values.is_empty() {
        legacy_credit(display)
    } else {
        values
    })
}

fn normalize_name(value: &str) -> String {
    value
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn find_or_create_artist(conn: &Connection, credit: &ArtistCredit) -> Result<String, String> {
    if let Some(id) = credit
        .artist_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let stored_musicbrainz_id = conn
            .query_row(
                "SELECT musicbrainz_id FROM artist_entities WHERE id=?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(stored_musicbrainz_id) = stored_musicbrainz_id {
            let conflicts = credit
                .musicbrainz_id
                .as_deref()
                .zip(stored_musicbrainz_id.as_deref())
                .is_some_and(|(requested, stored)| !requested.eq_ignore_ascii_case(stored));
            if !conflicts {
                return Ok(id.to_string());
            }
        }
    }
    let by_musicbrainz = if let Some(mbid) = credit.musicbrainz_id.as_deref() {
        conn.query_row(
            "SELECT id FROM artist_entities WHERE musicbrainz_id=?1 COLLATE NOCASE",
            [mbid],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
    } else {
        None
    };
    if let Some(id) = by_musicbrainz {
        return Ok(id);
    }
    let normalized = normalize_name(&credit.name);
    let bound = if credit.musicbrainz_id.is_none() {
        find_bound_artist_id(conn, &normalized)?
    } else {
        None
    };
    let by_name = if bound.is_none() {
        find_unidentified_artist_id(conn, &normalized)?
    } else {
        None
    };
    if let Some(id) = bound.or(by_name) {
        if let Some(mbid) = credit.musicbrainz_id.as_deref() {
            conn.execute(
                "UPDATE artist_entities SET musicbrainz_id=COALESCE(musicbrainz_id,?1),updated_at=?2 WHERE id=?3",
                params![mbid, now_seconds(), id],
            )
            .map_err(db_error)?;
        }
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let now = now_seconds();
    conn.execute(
        "INSERT INTO artist_entities(id,canonical_name,normalized_name,musicbrainz_id,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?5)",
        params![id, credit.name, normalized, credit.musicbrainz_id, now],
    )
    .map_err(db_error)?;
    Ok(id)
}

fn replace_credits(
    conn: &Connection,
    track_id: &str,
    plan: &CreditPlan,
    source: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM track_artist_credit_sets WHERE track_id=?1 AND scope=?2",
        params![track_id, plan.scope],
    )
    .map_err(db_error)?;
    if plan.display_text.trim().is_empty() || plan.credits.is_empty() {
        return Ok(());
    }
    let now = now_seconds();
    conn.execute(
        "INSERT INTO track_artist_credit_sets(
           track_id,scope,display_text,provenance,confidence,needs_review,created_at,updated_at
         ) VALUES(?1,?2,?3,?4,100,0,?5,?5)",
        params![track_id, plan.scope, plan.display_text, source, now],
    )
    .map_err(db_error)?;
    for (position, credit) in plan.credits.iter().enumerate() {
        let artist_id = find_or_create_artist(conn, credit)?;
        conn.execute(
            "INSERT INTO track_artist_credits(
               track_id,scope,position,artist_id,credited_name,join_phrase,role
             ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                track_id,
                plan.scope,
                position as i64,
                artist_id,
                credit.credited_name,
                credit.join_phrase,
                credit.role
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
    parts.extend(fields.11);
    parts.extend(fields.12.map(|value| value.to_string()));
    conn.execute(
        "UPDATE tracks SET search_text=?1 WHERE id=?2",
        params![super::database::normalize_search_text(&parts), track_id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn configured_library_root(conn: &Connection) -> Result<Option<PathBuf>, String> {
    let value = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key='library_root'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    Ok(super::database::normalize_library_root(value.as_deref()))
}

fn set_text(tag: &mut Tag, key: ItemKey, value: &Value) {
    tag.remove_key(&key);
    let value = text_value(Some(value));
    if !value.is_empty() {
        tag.insert(TagItem::new(key, ItemValue::Text(value)));
    }
}

fn set_custom_values(tag: &mut Tag, key: &str, values: &[String], file_type: FileType) {
    let item_key = ItemKey::Unknown(key.to_string());
    tag.remove_key(&item_key);
    if values.is_empty() {
        return;
    }
    if file_type == FileType::Mpeg {
        tag.insert_unchecked(TagItem::new(item_key, ItemValue::Text(values.join("\0"))));
    } else {
        for value in values {
            tag.push_unchecked(TagItem::new(
                item_key.clone(),
                ItemValue::Text(value.clone()),
            ));
        }
    }
}

fn set_mapped_values(tag: &mut Tag, key: ItemKey, values: &[String], file_type: FileType) {
    tag.remove_key(&key);
    if file_type == FileType::Mpeg && !values.is_empty() {
        tag.insert(TagItem::new(key, ItemValue::Text(values.join("\0"))));
    } else {
        for value in values {
            tag.push(TagItem::new(key.clone(), ItemValue::Text(value.clone())));
        }
    }
}

fn value_strings(tag: &Tag, key: &ItemKey) -> Vec<String> {
    tag.items()
        .filter(|item| item.key() == key)
        .filter_map(|item| item.value().text())
        .flat_map(|value| value.split('\0').map(str::to_string).collect::<Vec<_>>())
        .collect()
}

fn rating_stars(value: &Value) -> f64 {
    let numeric = match value {
        Value::Number(value) => value.as_f64().unwrap_or_default(),
        Value::String(value) => value.parse::<f64>().unwrap_or_default(),
        _ => 0.0,
    };
    (numeric.clamp(0.0, 5.0) * 2.0).round() / 2.0
}

fn set_rating(tag: &mut Tag, file_type: FileType, extension: &str, stars: f64) {
    tag.remove_key(&ItemKey::Popularimeter);
    tag.remove_key(&ItemKey::Unknown("RATING".to_string()));
    if stars <= 0.0 {
        return;
    }
    if file_type == FileType::Mpeg {
        let raw = MP3_POPM_BY_HALF_STAR[(stars * 2.0).round() as usize];
        let bytes = Popularimeter {
            email: String::new(),
            rating: raw,
            counter: 0,
        }
        .as_bytes();
        tag.insert(TagItem::new(
            ItemKey::Popularimeter,
            ItemValue::Binary(bytes),
        ));
    } else {
        let serialized = if matches!(extension, "flac" | "ogg" | "opus") {
            (stars * 20.0).round().to_string()
        } else {
            (stars / 5.0).to_string()
        };
        tag.insert_unchecked(TagItem::new(
            ItemKey::Unknown("RATING".to_string()),
            ItemValue::Text(serialized),
        ));
    }
}

fn read_rating(tag: &Tag, file_type: FileType, extension: &str) -> f64 {
    if file_type == FileType::Mpeg {
        for item in tag
            .items()
            .filter(|item| item.key() == &ItemKey::Popularimeter)
        {
            if let ItemValue::Binary(bytes) = item.value() {
                if let Ok(popm) = Popularimeter::parse(&mut Cursor::new(bytes)) {
                    let exact = MP3_POPM_BY_HALF_STAR
                        .iter()
                        .position(|value| *value == popm.rating);
                    return exact
                        .map(|position| position as f64 / 2.0)
                        .unwrap_or_else(|| ((popm.rating as f64 / 255.0) * 10.0).round() / 2.0);
                }
            }
        }
        return 0.0;
    }
    let raw = tag
        .get_string(&ItemKey::Unknown("RATING".to_string()))
        .or_else(|| tag.get_string(&ItemKey::Popularimeter))
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or_default();
    if matches!(extension, "flac" | "ogg" | "opus") {
        if raw <= 5.0 && raw.fract() == 0.0 {
            raw
        } else {
            (raw / 20.0 * 2.0).round() / 2.0
        }
    } else if raw <= 1.0 {
        (raw * 10.0).round() / 2.0
    } else {
        raw.clamp(0.0, 5.0)
    }
}

fn picture_mime(bytes: &[u8]) -> MimeType {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        MimeType::Png
    } else if bytes.starts_with(b"GIF8") {
        MimeType::Gif
    } else if bytes.starts_with(b"BM") {
        MimeType::Bmp
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        MimeType::Tiff
    } else {
        MimeType::Jpeg
    }
}

fn write_metadata_to_file(
    source_path: &Path,
    updates: &Map<String, Value>,
    plans: &[CreditPlan],
) -> Result<(), String> {
    if !source_path.is_file() {
        return Err(format!("File not found: {}", source_path.display()));
    }
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let expected_rating = updates.get("rating").map(rating_stars);
    if expected_rating.is_some() && matches!(extension.as_str(), "wav" | "aif" | "aiff") {
        return Err(format!(
            "The {} format does not support embedded ratings",
            extension.to_ascii_uppercase()
        ));
    }
    let cover = updates
        .get("coverArtPath")
        .filter(|value| !value.is_null())
        .map(|value| {
            std::fs::read(text_value(Some(value)))
                .map_err(|error| format!("Failed to read cover art: {error}"))
        })
        .transpose()?;
    let mut tagged = Probe::open(source_path)
        .map_err(|error| error.to_string())?
        .read()
        .map_err(|error| error.to_string())?;
    let file_type = tagged.file_type();
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tagged.primary_tag_type()));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "Audio format has no writable primary tag".to_string())?;
    for (field, key) in [
        ("title", ItemKey::TrackTitle),
        ("artist", ItemKey::TrackArtist),
        ("artists", ItemKey::AlbumArtist),
        ("album", ItemKey::AlbumTitle),
        ("trackNumber", ItemKey::TrackNumber),
        ("trackTotal", ItemKey::TrackTotal),
        ("discNumber", ItemKey::DiscNumber),
        ("discTotal", ItemKey::DiscTotal),
        ("year", ItemKey::Year),
        ("label", ItemKey::Label),
        ("bpm", ItemKey::Bpm),
        ("key", ItemKey::InitialKey),
        ("musicBrainzTrackId", ItemKey::MusicBrainzRecordingId),
        ("musicBrainzAlbumId", ItemKey::MusicBrainzReleaseId),
        (
            "musicBrainzReleaseGroupId",
            ItemKey::MusicBrainzReleaseGroupId,
        ),
        ("acoustIdId", ItemKey::Unknown("ACOUSTID_ID".to_string())),
    ] {
        if let Some(value) = updates.get(field) {
            set_text(tag, key, value);
        }
    }
    for (field, key) in [("genre", ItemKey::Genre), ("comment", ItemKey::Comment)] {
        if let Some(value) = updates.get(field) {
            let joined = Value::String(list_value(value).join(", "));
            set_text(tag, key, &joined);
        }
    }
    for plan in plans {
        let names = plan
            .credits
            .iter()
            .map(|credit| credit.credited_name.clone())
            .collect::<Vec<_>>();
        let ids = if plan
            .credits
            .iter()
            .all(|credit| credit.musicbrainz_id.is_some())
        {
            plan.credits
                .iter()
                .filter_map(|credit| credit.musicbrainz_id.clone())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if plan.scope == "track" {
            set_custom_values(tag, "ARTISTS", &names, file_type);
            set_mapped_values(tag, ItemKey::MusicBrainzArtistId, &ids, file_type);
        } else {
            set_custom_values(tag, "ALBUMARTISTS", &names, file_type);
            set_mapped_values(tag, ItemKey::MusicBrainzReleaseArtistId, &ids, file_type);
        }
    }
    if let Some(stars) = expected_rating {
        set_rating(tag, file_type, &extension, stars);
    }
    if let Some(bytes) = cover.as_ref() {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(picture_mime(bytes)),
            Some("Front Cover".to_string()),
            bytes.clone(),
        ));
    }
    tagged
        .save_to_path(source_path, WriteOptions::default())
        .map_err(|error| format!("Failed to save tags: {error}"))?;

    if cover.is_some() || expected_rating.is_some() || !plans.is_empty() {
        let verified = Probe::open(source_path)
            .map_err(|error| error.to_string())?
            .read()
            .map_err(|error| error.to_string())?;
        let tag = verified
            .primary_tag()
            .or_else(|| verified.first_tag())
            .ok_or_else(|| "The audio format did not retain metadata".to_string())?;
        if cover.is_some() && tag.get_picture_type(PictureType::CoverFront).is_none() {
            return Err("The audio format did not retain the embedded front cover".to_string());
        }
        if let Some(expected) = expected_rating {
            if read_rating(tag, verified.file_type(), &extension) != expected {
                return Err(format!("The audio format did not retain the embedded rating ({expected} stars requested)"));
            }
        }
        for plan in plans {
            let display_key = if plan.scope == "track" {
                ItemKey::TrackArtist
            } else {
                ItemKey::AlbumArtist
            };
            if tag.get_string(&display_key).unwrap_or_default() != plan.display_text {
                return Err(format!(
                    "The audio format did not retain the {} artist display credit",
                    plan.scope
                ));
            }
            if matches!(
                extension.as_str(),
                "mp3" | "flac" | "m4a" | "alac" | "aac" | "ogg" | "opus"
            ) {
                let key = if plan.scope == "track" {
                    "ARTISTS"
                } else {
                    "ALBUMARTISTS"
                };
                let expected = plan
                    .credits
                    .iter()
                    .map(|credit| credit.credited_name.clone())
                    .collect::<Vec<_>>();
                if value_strings(tag, &ItemKey::Unknown(key.to_string())) != expected {
                    return Err(format!(
                        "The audio format did not retain the structured {} artists",
                        plan.scope
                    ));
                }
                let mb_key = if plan.scope == "track" {
                    ItemKey::MusicBrainzArtistId
                } else {
                    ItemKey::MusicBrainzReleaseArtistId
                };
                let persisted = value_strings(tag, &mb_key);
                let expected_ids = if plan
                    .credits
                    .iter()
                    .all(|credit| credit.musicbrainz_id.is_some())
                {
                    plan.credits
                        .iter()
                        .filter_map(|credit| credit.musicbrainz_id.clone())
                        .collect()
                } else {
                    Vec::new()
                };
                if persisted != expected_ids {
                    return Err(format!(
                        "The audio format did not retain the {} artist identifiers",
                        plan.scope
                    ));
                }
            }
        }
    }
    Ok(())
}

fn update_impl(
    db_path: &str,
    track_ids: Vec<String>,
    updates: Map<String, Value>,
    source: &str,
) -> Result<MetadataWriteResult, String> {
    let updates = canonical_updates(updates);
    if track_ids.is_empty() || updates.is_empty() {
        return Ok(MetadataWriteResult {
            updated: 0,
            files_written: 0,
            file_write_errors: Vec::new(),
        });
    }
    let fields = updates
        .iter()
        .filter_map(|(field, value)| {
            metadata_column(field).map(|column| (field.clone(), column, value.clone()))
        })
        .collect::<Vec<_>>();
    if fields.is_empty() {
        return Ok(MetadataWriteResult {
            updated: 0,
            files_written: 0,
            file_write_errors: Vec::new(),
        });
    }
    let plans = credit_plans(&updates);
    let mut conn = open_database(db_path)?;
    let tx = conn.transaction().map_err(db_error)?;
    let changed_at = now_iso8601();
    for track_id in &track_ids {
        let exists = tx
            .query_row("SELECT 1 FROM tracks WHERE id=?1", [track_id], |_| Ok(()))
            .optional()
            .map_err(db_error)?
            .is_some();
        if !exists {
            continue;
        }
        let mut changes = Map::new();
        for (field, column, requested) in &fields {
            let current = tx
                .query_row(
                    &format!("SELECT {column} FROM tracks WHERE id=?1"),
                    [track_id],
                    |row| row.get::<_, SqlValue>(0),
                )
                .map_err(db_error)?;
            let before = json_from_sql(field, current);
            let after = json_from_sql(field, sql_value(field, requested)?);
            if before != after {
                changes.insert(field.clone(), json!({ "before": before, "after": after }));
            }
        }
        for plan in &plans {
            let column = metadata_column(plan.display_key).unwrap();
            let before_display = tx
                .query_row(
                    &format!("SELECT COALESCE({column},'') FROM tracks WHERE id=?1"),
                    [track_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(db_error)?;
            let before_credits = load_credits(&tx, track_id, plan.scope, &before_display)?;
            if !credits_equal(&before_credits, &plan.credits) {
                let change = changes.entry(plan.display_key.to_string()).or_insert_with(
                    || json!({ "before": before_display, "after": plan.display_text }),
                );
                let object = change.as_object_mut().expect("metadata change object");
                object.insert("beforeCredits".to_string(), credit_json(&before_credits));
                object.insert("afterCredits".to_string(), credit_json(&plan.credits));
            }
        }
        if !changes.is_empty() {
            tx.execute(
                "INSERT INTO metadata_change_history(track_id,changed_at,source,changes_json) VALUES(?1,?2,?3,?4)",
                params![track_id, changed_at, source, Value::Object(changes).to_string()],
            ).map_err(db_error)?;
        }
        for (field, column, requested) in &fields {
            tx.execute(
                &format!("UPDATE tracks SET {column}=?1 WHERE id=?2"),
                params![sql_value(field, requested)?, track_id],
            )
            .map_err(db_error)?;
        }
        tx.execute(
            "UPDATE tracks SET updated_at=?1 WHERE id=?2",
            params![now_seconds(), track_id],
        )
        .map_err(db_error)?;
        for plan in &plans {
            replace_credits(&tx, track_id, plan, source)?;
        }
        refresh_search_text(&tx, track_id)?;
    }
    tx.commit().map_err(db_error)?;

    let root = configured_library_root(&conn)?;
    let mut result = MetadataWriteResult {
        updated: track_ids.len(),
        files_written: 0,
        file_write_errors: Vec::new(),
    };
    for track_id in track_ids {
        let stored = conn
            .query_row(
                "SELECT source_path FROM tracks WHERE id=?1",
                [&track_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(stored) = stored else { continue };
        let (path, write_result) =
            match super::database::resolve_stored_track_path(&stored, root.as_deref()) {
                Ok(path) => {
                    let write_result = write_metadata_to_file(&path, &updates, &plans);
                    (path, write_result)
                }
                Err(message) => (PathBuf::from(&stored), Err(message)),
            };
        match write_result {
            Ok(()) => {
                conn.execute(
                    "UPDATE tracks SET last_write_error=NULL WHERE id=?1",
                    [&track_id],
                )
                .map_err(db_error)?;
                result.files_written += 1;
            }
            Err(message) => {
                conn.execute(
                    "UPDATE tracks SET last_write_error=?1 WHERE id=?2",
                    params![message, track_id],
                )
                .map_err(db_error)?;
                result.file_write_errors.push(FileWriteError {
                    track_id,
                    file_name: path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string(),
                    message,
                });
            }
        }
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_track_metadata(
    db_path: String,
    track_ids: Vec<String>,
    updates: HashMap<String, Value>,
) -> Result<MetadataWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_impl(&db_path, track_ids, updates.into_iter().collect(), "user")
    })
    .await
    .map_err(|error| error.to_string())?
}

fn rollback_metadata_change_impl(
    db_path: String,
    history_id: i64,
    field: String,
) -> Result<MetadataWriteResult, String> {
    if metadata_column(&field).is_none() {
        return Err("That field is not part of this metadata change".to_string());
    }
    let conn = open_database(&db_path)?;
    let (track_id, raw) = conn
        .query_row(
            "SELECT track_id,changes_json FROM metadata_change_history WHERE id=?1",
            [history_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Metadata history entry was not found".to_string())?;
    let changes: Value =
        serde_json::from_str(&raw).map_err(|_| "Metadata history entry is invalid".to_string())?;
    let change = changes
        .get(&field)
        .and_then(Value::as_object)
        .ok_or_else(|| "That field is not part of this metadata change".to_string())?;
    let mut updates = Map::new();
    updates.insert(
        field.clone(),
        change
            .get("before")
            .cloned()
            .ok_or_else(|| "Metadata history entry has no previous value".to_string())?,
    );
    if field == "artist" {
        if let Some(credits) = change.get("beforeCredits") {
            updates.insert("artistCredits".to_string(), credits.clone());
        }
    } else if matches!(field.as_str(), "artists" | "albumArtist") {
        if let Some(credits) = change.get("beforeCredits") {
            updates.insert("albumArtistCredits".to_string(), credits.clone());
        }
    }
    drop(conn);
    update_impl(&db_path, vec![track_id], updates, "rollback")
}

#[tauri::command(rename_all = "camelCase")]
pub async fn rollback_metadata_change(
    db_path: String,
    history_id: i64,
    field: String,
) -> Result<MetadataWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rollback_metadata_change_impl(db_path, history_id, field)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_database() -> PathBuf {
        let path = std::env::temp_dir().join(format!("muro-metadata-write-{}.db", Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        super::super::database::ensure_schema(&conn).unwrap();
        path
    }

    #[test]
    fn canonicalizes_alias_and_credit_only_updates() {
        let updates = canonical_updates(Map::from_iter([
            ("albumArtist".to_string(), json!("Alice & Bob")),
            (
                "artistCredits".to_string(),
                json!([
                    { "name": "Alice", "creditedName": "Alice", "joinPhrase": " & " },
                    { "name": "Bob", "creditedName": "Bob", "joinPhrase": "" }
                ]),
            ),
        ]));
        assert_eq!(updates.get("artists"), Some(&json!("Alice & Bob")));
        assert_eq!(updates.get("artist"), Some(&json!("Alice & Bob")));
        assert!(!updates.contains_key("albumArtist"));
    }

    #[test]
    fn rating_mapping_preserves_every_half_star() {
        for step in 0..=10 {
            let stars = step as f64 / 2.0;
            let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
            set_rating(&mut tag, FileType::Mpeg, "mp3", stars);
            assert_eq!(read_rating(&tag, FileType::Mpeg, "mp3"), stars);
        }
    }

    #[test]
    fn database_commit_survives_a_file_write_failure_and_records_history() {
        let path = test_database();
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO tracks(id,title,artist,album,source_path,import_status,added_at,updated_at)
             VALUES('track-1','Before','Artist','Album','missing.flac','accepted',1,1)",
            [],
        ).unwrap();
        drop(conn);
        let result = update_impl(
            path.to_str().unwrap(),
            vec!["track-1".to_string()],
            Map::from_iter([("title".to_string(), json!("After"))]),
            "user",
        )
        .unwrap();
        assert_eq!(result.updated, 1);
        assert_eq!(result.files_written, 0);
        assert_eq!(result.file_write_errors.len(), 1);
        let conn = Connection::open(&path).unwrap();
        let row: (String, String, i64) = conn.query_row(
            "SELECT title,last_write_error,(SELECT count(*) FROM metadata_change_history) FROM tracks WHERE id='track-1'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(row.0, "After");
        assert!(row.1.contains("File not found"));
        assert_eq!(row.2, 1);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rollback_uses_the_same_writer_and_creates_a_rollback_history_entry() {
        let path = test_database();
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO tracks(id,title,artist,album,source_path,import_status,added_at,updated_at)
             VALUES('track-1','After','Artist','Album','missing.mp3','accepted',1,1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO metadata_change_history(track_id,changed_at,source,changes_json)
             VALUES('track-1','2026-01-01T00:00:00.000Z','user',?1)",
            [json!({"title":{"before":"Before","after":"After"}}).to_string()],
        )
        .unwrap();
        let history_id = conn.last_insert_rowid();
        drop(conn);
        let result = rollback_metadata_change_impl(
            path.to_string_lossy().into_owned(),
            history_id,
            "title".to_string(),
        )
        .unwrap();
        assert_eq!(result.updated, 1);
        assert_eq!(result.file_write_errors.len(), 1);
        let conn = Connection::open(&path).unwrap();
        let title: String = conn
            .query_row("SELECT title FROM tracks WHERE id='track-1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let source: String = conn
            .query_row(
                "SELECT source FROM metadata_change_history ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Before");
        assert_eq!(source, "rollback");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
