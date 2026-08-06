use crate::cover_art;
use crate::search;
use chrono::{DateTime, Utc};
use lofty::file::FileType;
use lofty::file::TaggedFile;
use lofty::id3::v2::Popularimeter;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemValue, Tag, TagItem, TagType};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const AUDIO_EXTENSIONS: [&str; 10] = [
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "alac",
];
const STATUS_STAGED: &str = "staged";
const STATUS_ACCEPTED: &str = "accepted";
const DEFAULT_DURATION: &str = "--:--";
const DEFAULT_BITRATE: &str = "--";
const UNKNOWN_TITLE: &str = "Unknown Title";
const UNKNOWN_ARTIST: &str = "Unknown Artist";
const UNKNOWN_ALBUM: &str = "Unknown Album";

#[derive(Debug, Serialize, Clone)]
pub struct ImportedTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artists: Option<String>,
    pub album: String,
    pub track_number: Option<i32>,
    pub track_total: Option<i32>,
    pub key: Option<String>,
    pub bpm: Option<f64>,
    pub year: Option<i32>,
    pub date: Option<String>,
    pub date_added: Option<String>,
    pub date_modified: Option<String>,
    pub duration: String,
    pub duration_seconds: f64,
    pub bitrate: String,
    pub rating: f32,
    pub source_path: String,
    pub cover_art_path: Option<String>,
    pub cover_art_thumb_path: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub label: Option<String>,
    pub disc_number: Option<i32>,
    pub disc_total: Option<i32>,
    pub last_played_at: Option<String>,
    pub play_count: i32,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportProgress {
    pub imported: usize,
    pub total: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct LibrarySnapshot {
    pub library: Vec<ImportedTrack>,
    pub inbox: Vec<ImportedTrack>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PlaylistSnapshot {
    pub playlists: Vec<PlaylistRow>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PlaylistRow {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct ImportedArtistCredit {
    name: String,
    credited_name: String,
    join_phrase: String,
    musicbrainz_id: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct TechnicalMetadata {
    sample_rate_hz: i64,
    bit_depth: i64,
    file_size_bytes: i64,
    updated_at: i64,
}

impl TechnicalMetadata {
    fn loudness_source(metadata: &NormalizedMetadata) -> Option<&'static str> {
        (metadata.replaygain_track_gain_db.is_some() || metadata.replaygain_album_gain_db.is_some())
            .then_some("tag")
    }
}

#[derive(Debug, Default, Clone)]
struct NormalizedMetadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    genres: Vec<String>,
    comments: Vec<String>,
    label: Option<String>,
    filename: String,
    year: Option<i32>,
    date: Option<String>,
    original_date: Option<String>,
    original_year: Option<i32>,
    track_number: Option<i32>,
    track_total: Option<i32>,
    disc_number: Option<i32>,
    disc_total: Option<i32>,
    key: Option<String>,
    bpm: Option<f64>,
    rating: Option<f32>,
    isrc: Vec<String>,
    encoder: Option<String>,
    encoder_tag: Option<String>,
    encoder_tool: Option<String>,
    raw_tags: serde_json::Value,
    musicbrainz_albumid: Option<String>,
    musicbrainz_artistid: Option<String>,
    musicbrainz_albumartistid: Option<String>,
    musicbrainz_releasegroupid: Option<String>,
    musicbrainz_trackid: Option<String>,
    musicbrainz_releasetrackid: Option<String>,
    musicbrainz_albumstatus: Option<String>,
    musicbrainz_albumtype: Option<String>,
    acoustid_id: Option<String>,
    replaygain_track_gain_db: Option<f64>,
    replaygain_track_peak: Option<f64>,
    replaygain_album_gain_db: Option<f64>,
    replaygain_album_peak: Option<f64>,
    artist_credits: Vec<ImportedArtistCredit>,
    album_artist_credits: Vec<ImportedArtistCredit>,
}

pub fn import_files(
    paths: Vec<String>,
    db_path: &str,
    cache_dir: &Path,
) -> Result<Vec<ImportedTrack>, String> {
    import_files_with_progress(paths, db_path, cache_dir, |_| {})
}

pub fn import_files_with_progress<F>(
    paths: Vec<String>,
    db_path: &str,
    cache_dir: &Path,
    mut on_progress: F,
) -> Result<Vec<ImportedTrack>, String>
where
    F: FnMut(ImportProgress),
{
    let mut file_paths = Vec::new();
    for path in paths {
        collect_audio_paths(Path::new(&path), &mut file_paths)?;
    }

    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    if let Some(parent) = Path::new(db_path).parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    // Ensure cover art cache directory exists
    std::fs::create_dir_all(cache_dir).map_err(|error| error.to_string())?;

    let mut conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    ensure_schema(&conn)?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut imported = Vec::new();
    let now = current_timestamp();
    let total = file_paths.len();
    let mut processed = 0;
    on_progress(ImportProgress {
        imported: processed,
        total,
    });

    for path in file_paths {
        match import_single(&tx, &path, now, cache_dir) {
            Ok(Some(track)) => imported.push(track),
            Ok(None) => {} // Duplicate, silently skipped
            Err(error) => {
                eprintln!("Import failed for {}: {}", path.display(), error);
            }
        }
        processed += 1;
        on_progress(ImportProgress {
            imported: processed,
            total,
        });
    }

    tx.commit().map_err(|error| error.to_string())?;
    Ok(imported)
}

pub fn load_tracks(db_path: &str) -> Result<LibrarySnapshot, String> {
    if !Path::new(db_path).exists() {
        return Ok(LibrarySnapshot {
            library: Vec::new(),
            inbox: Vec::new(),
        });
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    ensure_schema(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, title, artist, album_artist, album, track_number, track_total,
                    key, bpm, year, date, added_at, updated_at, rating, duration_seconds,
                    bitrate_kbps, import_status, source_path, cover_art_path,
                    cover_art_thumb_path, last_played_at, play_count,
                    genre_json, comment_json, label, disc_number, disc_total
             FROM tracks ORDER BY added_at DESC",
        )
        .map_err(|error| error.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            let artist: Option<String> = row.get(2)?;
            let album_artist: Option<String> = row.get(3)?;
            let album: Option<String> = row.get(4)?;
            let track_number: Option<i32> = row.get(5)?;
            let track_total: Option<i32> = row.get(6)?;
            let key: Option<String> = row.get(7)?;
            let bpm: Option<f64> = row.get(8)?;
            let year: Option<i32> = row.get(9)?;
            let date: Option<String> = row.get(10)?;
            let added_at: Option<i64> = row.get(11)?;
            let updated_at: Option<i64> = row.get(12)?;
            let rating: Option<f64> = row.get(13)?;
            let duration_seconds: Option<f64> = row.get(14)?;
            let bitrate_kbps: Option<i32> = row.get(15)?;
            let import_status: Option<String> = row.get(16)?;
            let source_path: Option<String> = row.get(17)?;
            let cover_art_path: Option<String> = row.get(18)?;
            let cover_art_thumb_path: Option<String> = row.get(19)?;
            let last_played_at: Option<String> = row.get(20)?;
            let play_count: Option<i32> = row.get(21)?;
            let genre_json: Option<String> = row.get(22)?;
            let comment_json: Option<String> = row.get(23)?;
            let label: Option<String> = row.get(24)?;
            let disc_number: Option<i32> = row.get(25)?;
            let disc_total: Option<i32> = row.get(26)?;

            let duration = duration_seconds
                .map(|value| format_duration(value as f32))
                .unwrap_or_else(|| DEFAULT_DURATION.to_string());
            let bitrate = bitrate_kbps
                .filter(|value| *value > 0)
                .map(|value| format!("{} kbps", value))
                .unwrap_or_else(|| DEFAULT_BITRATE.to_string());

            let date_added = added_at.map(format_timestamp);
            let date_modified = updated_at.map(format_timestamp);

            Ok((
                ImportedTrack {
                    id,
                    title: title.unwrap_or_else(|| UNKNOWN_TITLE.to_string()),
                    artist: artist.unwrap_or_else(|| UNKNOWN_ARTIST.to_string()),
                    artists: album_artist,
                    album: album.unwrap_or_else(|| UNKNOWN_ALBUM.to_string()),
                    track_number,
                    track_total,
                    key,
                    bpm,
                    year,
                    date,
                    date_added,
                    date_modified,
                    duration,
                    duration_seconds: duration_seconds.unwrap_or(0.0),
                    bitrate,
                    rating: rating.unwrap_or(0.0) as f32,
                    source_path: source_path.unwrap_or_default(),
                    cover_art_path,
                    cover_art_thumb_path,
                    genre: json_array_to_csv(&genre_json),
                    comment: json_array_to_csv(&comment_json),
                    label,
                    disc_number,
                    disc_total,
                    last_played_at,
                    play_count: play_count.unwrap_or(0),
                },
                import_status.unwrap_or_else(|| STATUS_ACCEPTED.to_string()),
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut library = Vec::new();
    let mut inbox = Vec::new();

    for row in rows {
        let (track, status) = row.map_err(|error| error.to_string())?;
        if status == STATUS_STAGED {
            inbox.push(track);
        } else {
            library.push(track);
        }
    }

    Ok(LibrarySnapshot { library, inbox })
}

pub fn ensure_playlist_schema(conn: &Connection) -> Result<(), String> {
    // Enable foreign key constraints
    conn.execute("PRAGMA foreign_keys = ON", [])
        .map_err(|error| error.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
        [],
    )
    .map_err(|error| error.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            position INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|error| error.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_idx ON playlist_tracks (playlist_id, position)",
        [],
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

pub fn load_playlists(db_path: &str) -> Result<PlaylistSnapshot, String> {
    if !Path::new(db_path).exists() {
        return Ok(PlaylistSnapshot {
            playlists: Vec::new(),
        });
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    ensure_playlist_schema(&conn)?;

    // Load all playlists with their track IDs in a single query using LEFT JOIN
    // This avoids the N+1 query problem
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, p.created_at, pt.track_id
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
             ORDER BY p.created_at DESC, pt.position ASC",
        )
        .map_err(|error| error.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let track_id: Option<String> = row.get(3)?;
            Ok((id, name, track_id))
        })
        .map_err(|error| error.to_string())?;

    // Group results by playlist
    let mut playlist_map: std::collections::HashMap<String, PlaylistRow> =
        std::collections::HashMap::new();
    let mut playlist_order: Vec<String> = Vec::new();

    for row in rows {
        let (id, name, track_id) = row.map_err(|error| error.to_string())?;

        let playlist = playlist_map.entry(id.clone()).or_insert_with(|| {
            playlist_order.push(id.clone());
            PlaylistRow {
                id,
                name,
                track_ids: Vec::new(),
            }
        });

        if let Some(tid) = track_id {
            playlist.track_ids.push(tid);
        }
    }

    // Maintain original order (by created_at DESC)
    let playlists = playlist_order
        .into_iter()
        .filter_map(|id| playlist_map.remove(&id))
        .collect();

    Ok(PlaylistSnapshot { playlists })
}

pub fn load_recently_played(conn: &Connection, limit: i32) -> Result<Vec<ImportedTrack>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, artist, album_artist, album, track_number, track_total,
                    key, bpm, year, date, added_at, updated_at, rating, duration_seconds,
                    bitrate_kbps, import_status, source_path, cover_art_path,
                    cover_art_thumb_path, last_played_at, play_count,
                    genre_json, comment_json, label, disc_number, disc_total
             FROM tracks
             WHERE last_played_at IS NOT NULL
             ORDER BY last_played_at DESC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;

    let rows = stmt
        .query_map([limit], |row| {
            let id: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            let artist: Option<String> = row.get(2)?;
            let album_artist: Option<String> = row.get(3)?;
            let album: Option<String> = row.get(4)?;
            let track_number: Option<i32> = row.get(5)?;
            let track_total: Option<i32> = row.get(6)?;
            let key: Option<String> = row.get(7)?;
            let bpm: Option<f64> = row.get(8)?;
            let year: Option<i32> = row.get(9)?;
            let date: Option<String> = row.get(10)?;
            let added_at: Option<i64> = row.get(11)?;
            let updated_at: Option<i64> = row.get(12)?;
            let rating: Option<f64> = row.get(13)?;
            let duration_seconds: Option<f64> = row.get(14)?;
            let bitrate_kbps: Option<i32> = row.get(15)?;
            let source_path: Option<String> = row.get(17)?;
            let cover_art_path: Option<String> = row.get(18)?;
            let cover_art_thumb_path: Option<String> = row.get(19)?;
            let last_played_at: Option<String> = row.get(20)?;
            let play_count: Option<i32> = row.get(21)?;
            let genre_json: Option<String> = row.get(22)?;
            let comment_json: Option<String> = row.get(23)?;
            let label: Option<String> = row.get(24)?;
            let disc_number: Option<i32> = row.get(25)?;
            let disc_total: Option<i32> = row.get(26)?;

            let duration = duration_seconds
                .map(|value| format_duration(value as f32))
                .unwrap_or_else(|| DEFAULT_DURATION.to_string());
            let bitrate = bitrate_kbps
                .filter(|value| *value > 0)
                .map(|value| format!("{} kbps", value))
                .unwrap_or_else(|| DEFAULT_BITRATE.to_string());

            let date_added = added_at.map(format_timestamp);
            let date_modified = updated_at.map(format_timestamp);

            Ok(ImportedTrack {
                id,
                title: title.unwrap_or_else(|| UNKNOWN_TITLE.to_string()),
                artist: artist.unwrap_or_else(|| UNKNOWN_ARTIST.to_string()),
                artists: album_artist,
                album: album.unwrap_or_else(|| UNKNOWN_ALBUM.to_string()),
                track_number,
                track_total,
                key,
                bpm,
                year,
                date,
                date_added,
                date_modified,
                duration,
                duration_seconds: duration_seconds.unwrap_or(0.0),
                bitrate,
                rating: rating.unwrap_or(0.0) as f32,
                source_path: source_path.unwrap_or_default(),
                cover_art_path,
                cover_art_thumb_path,
                genre: json_array_to_csv(&genre_json),
                comment: json_array_to_csv(&comment_json),
                label,
                disc_number,
                disc_total,
                last_played_at,
                play_count: play_count.unwrap_or(0),
            })
        })
        .map_err(|error| error.to_string())?;

    let mut tracks = Vec::new();
    for row in rows {
        tracks.push(row.map_err(|error| error.to_string())?);
    }

    Ok(tracks)
}

pub fn clear_tracks(db_path: &str, cache_dir: &Path) -> Result<(), String> {
    // Clear cover art cache directory
    if cache_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }

    // Clear database
    if !Path::new(db_path).exists() {
        return Ok(());
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM tracks", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn collect_audio_paths(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            collect_audio_paths(&entry.path(), files)?;
        }
        return Ok(());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if AUDIO_EXTENSIONS.iter().any(|item| *item == extension) {
        files.push(path.to_path_buf());
    }
    Ok(())
}

fn import_single(
    conn: &Connection,
    path: &Path,
    now: i64,
    cache_dir: &Path,
) -> Result<Option<ImportedTrack>, String> {
    conn.execute_batch("SAVEPOINT muro_import_one")
        .map_err(|error| error.to_string())?;
    match import_single_inner(conn, path, now, cache_dir) {
        Ok(value) => {
            conn.execute_batch("RELEASE SAVEPOINT muro_import_one")
                .map_err(|error| error.to_string())?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT muro_import_one; RELEASE SAVEPOINT muro_import_one",
            );
            Err(error)
        }
    }
}

fn import_single_inner(
    conn: &Connection,
    path: &Path,
    now: i64,
    cache_dir: &Path,
) -> Result<Option<ImportedTrack>, String> {
    let tagged = Probe::open(path)
        .map_err(|error| error.to_string())?
        .read()
        .map_err(|error| error.to_string())?;
    let properties = tagged.properties();
    let file_metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let updated_at = file_metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs() as i64)
        .unwrap_or(now);
    let technical = TechnicalMetadata {
        sample_rate_hz: properties.sample_rate().unwrap_or(0) as i64,
        bit_depth: properties.bit_depth().unwrap_or(0) as i64,
        file_size_bytes: i64::try_from(file_metadata.len()).unwrap_or(i64::MAX),
        updated_at,
    };
    let metadata = normalize_metadata(&tagged, path)?;

    let title = metadata
        .title
        .clone()
        .unwrap_or_else(|| fallback_title(path));
    let artist = metadata
        .artist
        .clone()
        .unwrap_or_else(|| UNKNOWN_ARTIST.to_string());
    let album = metadata
        .album
        .clone()
        .unwrap_or_else(|| UNKNOWN_ALBUM.to_string());
    let rating = metadata.rating.unwrap_or(0.0);
    let artist_credits = if metadata.artist_credits.is_empty() {
        infer_artist_credits(&artist, &[artist.clone()], &[])
    } else {
        metadata.artist_credits.clone()
    };
    let album_artist_credits = metadata.album_artist_credits.clone();
    let loudness_source = TechnicalMetadata::loudness_source(&metadata);

    // Extract and cache cover art
    let cached_cover = cover_art::process_cover_art(&tagged, cache_dir);
    let cover_art_path = cached_cover.as_ref().map(|c| c.full_path.clone());
    let cover_art_thumb_path = cached_cover.as_ref().map(|c| c.thumb_path.clone());

    let duration_seconds = properties.duration().as_secs_f32();
    let bitrate = properties.audio_bitrate().unwrap_or(0) as i32;
    let duration_text = format_duration(duration_seconds);
    let bitrate_text = if bitrate > 0 {
        format!("{} kbps", bitrate)
    } else {
        DEFAULT_BITRATE.to_string()
    };

    let id = Uuid::new_v4().to_string();
    let genre_refs: Vec<&str> = metadata.genres.iter().map(|value| value.as_str()).collect();
    let comment_refs: Vec<&str> = metadata
        .comments
        .iter()
        .map(|value| value.as_str())
        .collect();
    let search_text = search::normalize_track_search_text(search::TrackSearchParts {
        title: Some(&title),
        artist: metadata.artist.as_deref(),
        album: metadata.album.as_deref(),
        album_artist: metadata.album_artist.as_deref(),
        genres: if genre_refs.is_empty() {
            None
        } else {
            Some(genre_refs.as_slice())
        },
        comments: if comment_refs.is_empty() {
            None
        } else {
            Some(comment_refs.as_slice())
        },
        label: metadata.label.as_deref(),
        filename: Some(&metadata.filename),
        year: metadata.year,
        track_number: metadata.track_number,
        disc_number: metadata.disc_number,
    });

    let genre_json = serde_json::to_string(&metadata.genres).unwrap_or_else(|_| "[]".to_string());
    let comment_json =
        serde_json::to_string(&metadata.comments).unwrap_or_else(|_| "[]".to_string());
    let isrc_json = serde_json::to_string(&metadata.isrc).unwrap_or_else(|_| "[]".to_string());
    let raw_tags_json =
        serde_json::to_string(&metadata.raw_tags).unwrap_or_else(|_| "{}".to_string());

    conn.execute(
        "INSERT OR IGNORE INTO tracks (
            id, title, artist, album, album_artist, genre_json, comment_json, label, filename,
            year, date, original_date, original_year, track_number, track_total, disc_number,
            disc_total, key, bpm, rating, isrc_json, encoder, encoder_tag, encoder_tool, raw_tags_json,
            musicbrainz_albumid, musicbrainz_artistid, musicbrainz_albumartistid,
            musicbrainz_releasegroupid, musicbrainz_trackid, musicbrainz_releasetrackid,
            musicbrainz_albumstatus, musicbrainz_albumtype, acoustid_id, source_path, search_text,
            import_status, duration_seconds, bitrate_kbps, sample_rate_hz, bit_depth, file_size_bytes,
            added_at, updated_at, is_missing, cover_art_path, cover_art_thumb_path,
            replaygain_track_gain_db, replaygain_track_peak, replaygain_album_gain_db,
            replaygain_album_peak, loudness_source
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14, ?15, ?16,
            ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
            ?26, ?27, ?28, ?29, ?30, ?31,
            ?32, ?33, ?34, ?35, ?36,
            ?37, ?38, ?39, ?40, ?41, ?42,
            ?43, ?44, ?45, ?46, ?47,
            ?48, ?49, ?50, ?51, ?52
        )",
        params![
            id,
            title,
            artist,
            album,
            metadata.album_artist,
            genre_json,
            comment_json,
            metadata.label,
            metadata.filename,
            metadata.year,
            metadata.date,
            metadata.original_date,
            metadata.original_year,
            metadata.track_number,
            metadata.track_total,
            metadata.disc_number,
            metadata.disc_total,
            metadata.key,
            metadata.bpm,
            rating,
            isrc_json,
            metadata.encoder,
            metadata.encoder_tag,
            metadata.encoder_tool,
            raw_tags_json,
            metadata.musicbrainz_albumid,
            metadata.musicbrainz_artistid,
            metadata.musicbrainz_albumartistid,
            metadata.musicbrainz_releasegroupid,
            metadata.musicbrainz_trackid,
            metadata.musicbrainz_releasetrackid,
            metadata.musicbrainz_albumstatus,
            metadata.musicbrainz_albumtype,
            metadata.acoustid_id,
            path.to_string_lossy().to_string(),
            search_text,
            STATUS_STAGED,
            duration_seconds,
            bitrate,
            technical.sample_rate_hz,
            technical.bit_depth,
            technical.file_size_bytes,
            now,
            technical.updated_at,
            0,
            cover_art_path,
            cover_art_thumb_path,
            metadata.replaygain_track_gain_db,
            metadata.replaygain_track_peak,
            metadata.replaygain_album_gain_db,
            metadata.replaygain_album_peak,
            loudness_source
        ],
    )
    .map_err(|error| error.to_string())?;

    // If no rows were inserted (duplicate source_path), return None
    if conn.changes() == 0 {
        return Ok(None);
    }

    persist_artist_credits(conn, &id, "track", &artist, &artist_credits, now)?;
    if let Some(album_artist) = metadata.album_artist.as_deref() {
        persist_artist_credits(conn, &id, "album", album_artist, &album_artist_credits, now)?;
    }

    let date_added = Some(format_timestamp(now));

    let genre_csv = if metadata.genres.is_empty() {
        None
    } else {
        Some(metadata.genres.join(", "))
    };
    let comment_csv = if metadata.comments.is_empty() {
        None
    } else {
        Some(metadata.comments.join(", "))
    };

    Ok(Some(ImportedTrack {
        id,
        title,
        artist,
        artists: metadata.album_artist.clone(),
        album,
        track_number: metadata.track_number,
        track_total: metadata.track_total,
        key: metadata.key.clone(),
        bpm: metadata.bpm,
        year: metadata.year,
        date: metadata.date.clone(),
        date_added: date_added.clone(),
        date_modified: Some(format_timestamp(technical.updated_at)),
        duration: duration_text,
        duration_seconds: duration_seconds as f64,
        bitrate: bitrate_text,
        rating,
        source_path: path.to_string_lossy().to_string(),
        cover_art_path,
        cover_art_thumb_path,
        genre: genre_csv,
        comment: comment_csv,
        label: metadata.label.clone(),
        disc_number: metadata.disc_number,
        disc_total: metadata.disc_total,
        last_played_at: None,
        play_count: 0,
    }))
}

fn normalize_metadata(tagged: &TaggedFile, path: &Path) -> Result<NormalizedMetadata, String> {
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();

    if let Some(tag) = tag {
        let mut meta = NormalizedMetadata::default();
        meta.title = tag.get_string(&ItemKey::TrackTitle).map(str::to_string);
        meta.artist = tag.get_string(&ItemKey::TrackArtist).map(str::to_string);
        meta.album = tag.get_string(&ItemKey::AlbumTitle).map(str::to_string);
        meta.album_artist = tag.get_string(&ItemKey::AlbumArtist).map(str::to_string);
        meta.label = tag
            .get_string(&ItemKey::Label)
            .or_else(|| tag.get_string(&ItemKey::Publisher))
            .map(str::to_string);
        meta.date = tag.get_string(&ItemKey::RecordingDate).map(str::to_string);
        meta.original_date = tag
            .get_string(&ItemKey::OriginalReleaseDate)
            .map(str::to_string);
        meta.original_year = tag
            .get_string(&ItemKey::OriginalReleaseDate)
            .and_then(|value| parse_year(value));
        meta.year = tag
            .get_string(&ItemKey::Year)
            .and_then(|value| value.parse::<i32>().ok())
            .or_else(|| meta.date.as_ref().and_then(|value| parse_year(value)));
        meta.key = tag
            .get_string(&ItemKey::InitialKey)
            .map(|value| value.trim().to_string());
        // BPM can be in TBPM (ID3), BPM (generic), or tempo field
        meta.bpm = tag
            .get_string(&ItemKey::Bpm)
            .and_then(|value| value.trim().parse::<f64>().ok())
            .or_else(|| {
                tag.get_string(&ItemKey::Unknown("TBPM".to_string()))
                    .and_then(|value| value.trim().parse::<f64>().ok())
            })
            .or_else(|| {
                tag.get_string(&ItemKey::Unknown("BPM".to_string()))
                    .and_then(|value| value.trim().parse::<f64>().ok())
            });
        meta.encoder_tag = tag
            .get_string(&ItemKey::EncoderSoftware)
            .map(str::to_string)
            .or_else(|| {
                tag.get_string(&ItemKey::EncoderSettings)
                    .map(str::to_string)
            });
        meta.encoder = meta.encoder_tag.clone();

        meta.genres = collect_values(tag, ItemKey::Genre, split_genres);
        meta.comments = collect_values(tag, ItemKey::Comment, split_comments);
        meta.isrc = collect_values(tag, ItemKey::Isrc, split_passthrough);

        let track_value = tag.get_string(&ItemKey::TrackNumber).unwrap_or("");
        let (track_number, track_total_from_pair) = parse_number_pair(track_value);
        meta.track_number = track_number;
        // FLAC/Vorbis uses separate TRACKTOTAL field
        meta.track_total = tag
            .get_string(&ItemKey::TrackTotal)
            .and_then(|v| v.trim().parse::<i32>().ok())
            .or(track_total_from_pair);

        let disc_value = tag.get_string(&ItemKey::DiscNumber).unwrap_or("");
        let (disc_number, disc_total_from_pair) = parse_number_pair(disc_value);
        meta.disc_number = disc_number;
        // FLAC/Vorbis uses separate DISCTOTAL field
        meta.disc_total = tag
            .get_string(&ItemKey::DiscTotal)
            .and_then(|v| v.trim().parse::<i32>().ok())
            .or(disc_total_from_pair);

        let popm_rating = parse_popm_rating(tag);
        let rating_tag = tag
            .get_string(&ItemKey::Unknown("RATING".to_string()))
            .and_then(parse_rating_value);
        let is_mp3 = tagged.file_type() == FileType::Mpeg;
        meta.rating = if is_mp3 {
            popm_rating.or(rating_tag)
        } else {
            rating_tag.or(popm_rating)
        };

        meta.musicbrainz_albumid = tag
            .get_string(&ItemKey::MusicBrainzReleaseId)
            .map(str::to_string);
        meta.musicbrainz_artistid = tag
            .get_string(&ItemKey::MusicBrainzArtistId)
            .map(str::to_string);
        meta.musicbrainz_albumartistid = tag
            .get_string(&ItemKey::MusicBrainzReleaseArtistId)
            .map(str::to_string);
        meta.musicbrainz_releasegroupid = tag
            .get_string(&ItemKey::MusicBrainzReleaseGroupId)
            .map(str::to_string);
        meta.musicbrainz_trackid = tag
            .get_string(&ItemKey::MusicBrainzRecordingId)
            .map(str::to_string);
        meta.musicbrainz_releasetrackid = tag
            .get_string(&ItemKey::MusicBrainzTrackId)
            .map(str::to_string);
        meta.musicbrainz_albumstatus = tag
            .get_string(&ItemKey::Unknown("MusicBrainz Album Status".to_string()))
            .map(str::to_string);
        meta.musicbrainz_albumtype = tag
            .get_string(&ItemKey::Unknown("MusicBrainz Album Type".to_string()))
            .map(str::to_string);

        meta.acoustid_id = first_unknown_value(tagged, &["ACOUSTID_ID", "ACOUSTID ID"]);
        meta.replaygain_track_gain_db = first_key_value(tagged, &ItemKey::ReplayGainTrackGain)
            .and_then(|value| parse_replaygain(&value));
        meta.replaygain_track_peak = first_key_value(tagged, &ItemKey::ReplayGainTrackPeak)
            .and_then(|value| parse_replaygain(&value));
        meta.replaygain_album_gain_db = first_key_value(tagged, &ItemKey::ReplayGainAlbumGain)
            .and_then(|value| parse_replaygain(&value));
        meta.replaygain_album_peak = first_key_value(tagged, &ItemKey::ReplayGainAlbumPeak)
            .and_then(|value| parse_replaygain(&value));

        let artist_names = credit_names(tagged, "ARTISTS", &ItemKey::TrackArtist);
        let artist_ids = values_for_key(tagged, &ItemKey::MusicBrainzArtistId);
        meta.artist_credits = infer_artist_credits(
            meta.artist.as_deref().unwrap_or_default(),
            &artist_names,
            &artist_ids,
        );
        let album_artist_names = credit_names(tagged, "ALBUMARTISTS", &ItemKey::AlbumArtist);
        let album_artist_ids = values_for_key(tagged, &ItemKey::MusicBrainzReleaseArtistId);
        meta.album_artist_credits = infer_artist_credits(
            meta.album_artist.as_deref().unwrap_or_default(),
            &album_artist_names,
            &album_artist_ids,
        );
        meta.musicbrainz_artistid = meta
            .artist_credits
            .first()
            .and_then(|credit| credit.musicbrainz_id.clone())
            .or(meta.musicbrainz_artistid);
        meta.musicbrainz_albumartistid = meta
            .album_artist_credits
            .first()
            .and_then(|credit| credit.musicbrainz_id.clone())
            .or(meta.musicbrainz_albumartistid);

        meta.filename = filename;
        meta.raw_tags = collect_raw_tags(tagged);
        return Ok(meta);
    }

    Ok(NormalizedMetadata {
        filename,
        raw_tags: json!({}),
        ..Default::default()
    })
}

fn normalized_unknown_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

fn text_item_value(item: &TagItem) -> Option<String> {
    match item.value() {
        ItemValue::Text(value) | ItemValue::Locator(value) => Some(value.clone()),
        ItemValue::Binary(_) => None,
    }
}

fn values_for_key(tagged: &TaggedFile, key: &ItemKey) -> Vec<String> {
    tagged
        .tags()
        .iter()
        .flat_map(|tag| tag.items())
        .filter(|item| item.key() == key)
        .filter_map(text_item_value)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn unknown_values(tagged: &TaggedFile, aliases: &[&str]) -> Vec<String> {
    let aliases: Vec<String> = aliases
        .iter()
        .map(|value| normalized_unknown_key(value))
        .collect();
    tagged
        .tags()
        .iter()
        .flat_map(|tag| tag.items())
        .filter_map(|item| {
            let ItemKey::Unknown(key) = item.key() else {
                return None;
            };
            aliases
                .contains(&normalized_unknown_key(key))
                .then(|| text_item_value(item))
                .flatten()
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn first_unknown_value(tagged: &TaggedFile, aliases: &[&str]) -> Option<String> {
    unknown_values(tagged, aliases).into_iter().next()
}

fn first_key_value(tagged: &TaggedFile, key: &ItemKey) -> Option<String> {
    values_for_key(tagged, key).into_iter().next()
}

fn credit_names(tagged: &TaggedFile, property_name: &str, fallback: &ItemKey) -> Vec<String> {
    let explicit = unknown_values(tagged, &[property_name]);
    if explicit.is_empty() {
        values_for_key(tagged, fallback)
    } else {
        explicit
    }
}

fn clean_artist_name(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn infer_join_phrases(display: &str, names: &[String]) -> Option<Vec<String>> {
    if names.is_empty() {
        return Some(Vec::new());
    }
    if names.len() == 1 {
        return (display == names[0]).then(|| vec![String::new()]);
    }
    let mut starts = Vec::with_capacity(names.len());
    let mut cursor = 0;
    for (index, name) in names.iter().enumerate() {
        let relative = display.get(cursor..)?.find(name)?;
        let start = cursor + relative;
        if index == 0 && start != 0 {
            return None;
        }
        starts.push(start);
        cursor = start + name.len();
    }
    Some(
        names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                let end = starts[index] + name.len();
                if index + 1 < names.len() {
                    display[end..starts[index + 1]].to_string()
                } else {
                    display[end..].to_string()
                }
            })
            .collect(),
    )
}

fn infer_artist_credits(
    display: &str,
    raw_names: &[String],
    raw_ids: &[String],
) -> Vec<ImportedArtistCredit> {
    let names: Vec<String> = raw_names
        .iter()
        .filter(|name| !name.trim().is_empty())
        .cloned()
        .collect();
    let display = if display.trim().is_empty() {
        names.join(", ")
    } else {
        display.to_string()
    };
    if display.trim().is_empty() {
        return Vec::new();
    }
    let names = if names.is_empty() {
        vec![display.clone()]
    } else {
        names
    };
    let ids: Vec<String> = raw_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    let Some(joins) = infer_join_phrases(&display, &names) else {
        return vec![ImportedArtistCredit {
            name: clean_artist_name(&display),
            credited_name: display,
            join_phrase: String::new(),
            musicbrainz_id: (names.len() == 1 && ids.len() == 1).then(|| ids[0].clone()),
        }];
    };
    let positional_ids = (ids.len() == names.len()).then_some(ids);
    names
        .into_iter()
        .enumerate()
        .map(|(index, name)| ImportedArtistCredit {
            name: clean_artist_name(&name),
            credited_name: name,
            join_phrase: joins.get(index).cloned().unwrap_or_default(),
            musicbrainz_id: positional_ids
                .as_ref()
                .and_then(|values| values.get(index).cloned()),
        })
        .collect()
}

fn parse_replaygain(value: &str) -> Option<f64> {
    value
        .trim()
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}
fn normalized_artist_key(value: &str) -> String {
    clean_artist_name(value).to_lowercase()
}

fn find_or_create_artist(
    conn: &Connection,
    credit: &ImportedArtistCredit,
    now: i64,
) -> Result<String, String> {
    if let Some(mbid) = credit.musicbrainz_id.as_deref() {
        if let Some(id) = conn
            .query_row(
                "SELECT id FROM artist_entities WHERE musicbrainz_id=?1 COLLATE NOCASE",
                [mbid],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
        {
            return Ok(id);
        }
    }
    let normalized = normalized_artist_key(&credit.name);
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM artist_entities
             WHERE normalized_name=?1
               AND (?2 IS NULL OR musicbrainz_id IS NULL OR musicbrainz_id=?2 COLLATE NOCASE)
             ORDER BY created_at,id LIMIT 1",
            params![normalized, credit.musicbrainz_id.as_deref()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    {
        if let Some(mbid) = credit.musicbrainz_id.as_deref() {
            conn.execute(
                "UPDATE artist_entities SET musicbrainz_id=COALESCE(musicbrainz_id,?1),updated_at=?2 WHERE id=?3",
                params![mbid, now, id],
            )
            .map_err(|error| error.to_string())?;
        }
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO artist_entities(id,canonical_name,normalized_name,musicbrainz_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
        params![id, credit.name, normalized, credit.musicbrainz_id, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(id)
}

fn persist_artist_credits(
    conn: &Connection,
    track_id: &str,
    scope: &str,
    display: &str,
    credits: &[ImportedArtistCredit],
    now: i64,
) -> Result<(), String> {
    if display.trim().is_empty() || credits.is_empty() {
        return Ok(());
    }
    let rendered: String = credits
        .iter()
        .map(|credit| format!("{}{}", credit.credited_name, credit.join_phrase))
        .collect();
    if rendered != display {
        return Err(
            "Artist credit names and join phrases do not reproduce the display value".into(),
        );
    }
    conn.execute(
        "INSERT INTO track_artist_credit_sets(track_id,scope,display_text,provenance,confidence,needs_review,created_at,updated_at) VALUES(?1,?2,?3,'file-tags',100,0,?4,?4)",
        params![track_id, scope, display, now],
    )
    .map_err(|error| error.to_string())?;
    for (position, credit) in credits.iter().enumerate() {
        let artist_id = find_or_create_artist(conn, credit, now)?;
        conn.execute(
            "INSERT INTO track_artist_credits(track_id,scope,position,artist_id,credited_name,join_phrase,role) VALUES(?1,?2,?3,?4,?5,?6,NULL)",
            params![
                track_id,
                scope,
                position as i64,
                artist_id,
                credit.credited_name,
                credit.join_phrase
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}
fn collect_raw_tags(tagged: &TaggedFile) -> serde_json::Value {
    let mut map = BTreeMap::new();
    for tag in tagged.tags() {
        let mut tag_map = BTreeMap::new();
        for item in tag.items() {
            let key = format!("{:?}", item.key());
            let value = item_value_to_string(item);
            tag_map
                .entry(key)
                .and_modify(|entry: &mut Vec<String>| entry.push(value.clone()))
                .or_insert_with(|| vec![value]);
        }
        map.insert(tag_type_label(tag.tag_type()), tag_map);
    }
    json!(map)
}

fn tag_type_label(tag_type: TagType) -> String {
    format!("{:?}", tag_type).to_ascii_lowercase()
}

fn item_value_to_string(item: &TagItem) -> String {
    match item.value() {
        ItemValue::Text(text) => text.to_string(),
        ItemValue::Locator(text) => text.to_string(),
        ItemValue::Binary(data) => format!("{:?}", data),
    }
}

fn collect_values(tag: &Tag, key: ItemKey, split: fn(&str) -> Vec<String>) -> Vec<String> {
    let mut values = Vec::new();
    for item in tag.items().filter(|item| item.key() == &key) {
        let value = item_value_to_string(item);
        values.extend(split(&value));
    }
    values
}

fn split_genres(value: &str) -> Vec<String> {
    value
        .split(['/', ';', ','])
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect()
}

fn split_comments(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Vec::new()
    } else {
        vec![trimmed.to_string()]
    }
}

fn split_passthrough(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Vec::new()
    } else {
        vec![trimmed.to_string()]
    }
}

fn parse_number_pair(value: &str) -> (Option<i32>, Option<i32>) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, None);
    }

    let mut parts = trimmed.split('/');
    let first = parts
        .next()
        .and_then(|item| item.trim().parse::<i32>().ok());
    let second = parts
        .next()
        .and_then(|item| item.trim().parse::<i32>().ok());
    (first, second)
}

fn parse_year(value: &str) -> Option<i32> {
    value
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .get(0..4)
        .and_then(|slice| slice.parse::<i32>().ok())
}

fn parse_rating_value(value: &str) -> Option<f32> {
    let parsed = value.trim().parse::<f32>().ok()?;
    if parsed <= 5.0 {
        return Some(parsed);
    }
    Some((parsed / 100.0 * 5.0 * 2.0).round() / 2.0)
}

fn parse_popm_rating(tag: &Tag) -> Option<f32> {
    let mut best: Option<u8> = None;
    for item in tag
        .items()
        .filter(|item| item.key() == &ItemKey::Popularimeter)
    {
        let ItemValue::Binary(data) = item.value() else {
            continue;
        };
        let mut cursor = Cursor::new(data);
        if let Ok(popm) = Popularimeter::parse(&mut cursor) {
            if popm.rating > 0 {
                best = Some(best.map_or(popm.rating, |current| current.max(popm.rating)));
            }
        }
    }

    best.map(|rating| ((rating as f32 / 255.0) * 10.0).round() / 2.0)
}

fn format_duration(seconds: f32) -> String {
    if seconds <= 0.0 {
        return DEFAULT_DURATION.to_string();
    }
    let total = seconds.round() as i64;
    let minutes = total / 60;
    let secs = total % 60;
    format!("{}:{:02}", minutes, secs)
}

fn format_timestamp(timestamp: i64) -> String {
    DateTime::<Utc>::from_timestamp(timestamp, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default()
}

fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(search::strip_leading_track_number)
        .unwrap_or(UNKNOWN_TITLE)
        .to_string()
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or_default()
}

fn json_array_to_csv(json: &Option<String>) -> Option<String> {
    json.as_ref().and_then(|s| {
        let items: Vec<String> = serde_json::from_str(s).ok()?;
        if items.is_empty() {
            None
        } else {
            Some(items.join(", "))
        }
    })
}

pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            title TEXT,
            artist TEXT,
            album TEXT,
            album_artist TEXT,
            genre_json TEXT,
            comment_json TEXT,
            label TEXT,
            filename TEXT,
            year INTEGER,
            date TEXT,
            original_date TEXT,
            original_year INTEGER,
            track_number INTEGER,
            track_total INTEGER,
            disc_number INTEGER,
            disc_total INTEGER,
            key TEXT,
            bpm REAL,
            rating REAL,
            isrc_json TEXT,
            encoder TEXT,
            encoder_tag TEXT,
            encoder_tool TEXT,
            raw_tags_json TEXT,
            musicbrainz_albumid TEXT,
            musicbrainz_artistid TEXT,
            musicbrainz_albumartistid TEXT,
            musicbrainz_releasegroupid TEXT,
            musicbrainz_trackid TEXT,
            musicbrainz_releasetrackid TEXT,
            musicbrainz_albumstatus TEXT,
            musicbrainz_albumtype TEXT,
            source_path TEXT UNIQUE,
            search_text TEXT,
            import_status TEXT,
            duration_seconds REAL,
            bitrate_kbps INTEGER,
            added_at INTEGER,
            updated_at INTEGER,
            last_write_error TEXT,
            is_missing INTEGER DEFAULT 0,
            cover_art_path TEXT,
            cover_art_thumb_path TEXT
        );",
    )
    .map_err(|error| error.to_string())?;

    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS artist_entities (
           id TEXT PRIMARY KEY,
           canonical_name TEXT NOT NULL,
           normalized_name TEXT NOT NULL,
           musicbrainz_id TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS artist_entities_normalized_name_idx
           ON artist_entities(normalized_name);
         CREATE UNIQUE INDEX IF NOT EXISTS artist_entities_musicbrainz_id_uidx
           ON artist_entities(musicbrainz_id COLLATE NOCASE)
           WHERE musicbrainz_id IS NOT NULL AND trim(musicbrainz_id) <> '';
         CREATE TABLE IF NOT EXISTS track_artist_credit_sets (
           track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
           scope TEXT NOT NULL CHECK(scope IN ('track', 'album')),
           display_text TEXT NOT NULL,
           provenance TEXT NOT NULL,
           confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
           needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0, 1)),
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY(track_id, scope)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS track_artist_credits (
           track_id TEXT NOT NULL,
           scope TEXT NOT NULL CHECK(scope IN ('track', 'album')),
           position INTEGER NOT NULL CHECK(position >= 0),
           artist_id TEXT NOT NULL REFERENCES artist_entities(id) ON DELETE RESTRICT,
           credited_name TEXT NOT NULL,
           join_phrase TEXT NOT NULL DEFAULT '',
           role TEXT,
           PRIMARY KEY(track_id, scope, position),
           FOREIGN KEY(track_id, scope)
             REFERENCES track_artist_credit_sets(track_id, scope) ON DELETE CASCADE
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS track_artist_credits_artist_idx
           ON track_artist_credits(artist_id, scope, track_id);",
    )
    .map_err(|error| error.to_string())?;

    for (name, sql_type) in [
        ("acoustid_id", "TEXT"),
        ("sample_rate_hz", "INTEGER"),
        ("bit_depth", "INTEGER"),
        ("file_size_bytes", "INTEGER"),
        ("replaygain_track_gain_db", "REAL"),
        ("replaygain_track_peak", "REAL"),
        ("replaygain_album_gain_db", "REAL"),
        ("replaygain_album_peak", "REAL"),
        ("loudness_source", "TEXT"),
    ] {
        let statement = format!("ALTER TABLE tracks ADD COLUMN {name} {sql_type}");
        let _ = conn.execute(&statement, []);
    }
    // Add columns if they don't exist (for existing databases)
    let _ = conn.execute("ALTER TABLE tracks ADD COLUMN cover_art_path TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE tracks ADD COLUMN cover_art_thumb_path TEXT",
        [],
    );
    let _ = conn.execute("ALTER TABLE tracks ADD COLUMN bpm REAL", []);
    let _ = conn.execute("ALTER TABLE tracks ADD COLUMN last_played_at TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE tracks ADD COLUMN play_count INTEGER DEFAULT 0",
        [],
    );

    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_extension_allowlist_includes_opus_and_both_aiff_suffixes() {
        assert!(AUDIO_EXTENSIONS.contains(&"opus"));
        assert!(AUDIO_EXTENSIONS.contains(&"aif"));
        assert!(AUDIO_EXTENSIONS.contains(&"aiff"));
    }

    #[test]
    fn replaygain_values_accept_db_suffix_and_reject_non_finite_data() {
        assert_eq!(parse_replaygain("-7.25 dB"), Some(-7.25));
        assert_eq!(parse_replaygain("0.9821"), Some(0.9821));
        assert_eq!(parse_replaygain("NaN dB"), None);
        assert_eq!(parse_replaygain("not-a-number"), None);
    }

    #[test]
    fn structured_credits_preserve_exact_join_phrases_and_positional_mbids() {
        let credits = infer_artist_credits(
            "Alpha feat. Beta & Gamma",
            &["Alpha".into(), "Beta".into(), "Gamma".into()],
            &["mb-a".into(), "mb-b".into(), "mb-c".into()],
        );
        assert_eq!(credits.len(), 3);
        assert_eq!(credits[0].join_phrase, " feat. ");
        assert_eq!(credits[1].join_phrase, " & ");
        assert_eq!(credits[2].join_phrase, "");
        assert_eq!(credits[1].musicbrainz_id.as_deref(), Some("mb-b"));
        let rendered: String = credits
            .iter()
            .map(|credit| format!("{}{}", credit.credited_name, credit.join_phrase))
            .collect();
        assert_eq!(rendered, "Alpha feat. Beta & Gamma");
    }

    #[test]
    fn credit_persistence_does_not_depend_on_migration_state() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO tracks(id,artist,source_path) VALUES('track','Alpha feat. Beta','x')",
            [],
        )
        .unwrap();
        let credits = infer_artist_credits(
            "Alpha feat. Beta",
            &["Alpha".into(), "Beta".into()],
            &["mb-a".into(), "mb-b".into()],
        );
        persist_artist_credits(&conn, "track", "track", "Alpha feat. Beta", &credits, 10).unwrap();
        let rows: Vec<(String, String, Option<String>)> = conn
            .prepare(
                "SELECT c.credited_name,c.join_phrase,e.musicbrainz_id
                 FROM track_artist_credits c JOIN artist_entities e ON e.id=c.artist_id
                 WHERE c.track_id='track' ORDER BY c.position",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows[0],
            ("Alpha".into(), " feat. ".into(), Some("mb-a".into()))
        );
        assert_eq!(rows[1], ("Beta".into(), "".into(), Some("mb-b".into())));
    }

    #[test]
    fn minimal_wav_import_persists_technical_file_metadata() {
        let root = std::env::temp_dir().join(format!("muro-import-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let audio = root.join("tone.wav");
        let db = root.join("library.sqlite");
        let cache = root.join("covers");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&44_100_u32.to_le_bytes());
        wav.extend_from_slice(&88_200_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2_u32.to_le_bytes());
        wav.extend_from_slice(&0_i16.to_le_bytes());
        std::fs::write(&audio, &wav).unwrap();

        let imported = import_files(
            vec![audio.to_string_lossy().into_owned()],
            &db.to_string_lossy(),
            &cache,
        )
        .unwrap();
        assert_eq!(imported.len(), 1);
        let conn = Connection::open(&db).unwrap();
        let values: (i64, i64, i64) = conn
            .query_row(
                "SELECT sample_rate_hz,bit_depth,file_size_bytes FROM tracks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(values, (44_100, 16, wav.len() as i64));

        conn.execute(
            "UPDATE tracks SET title='User title',rating=4.5,import_status='accepted'",
            [],
        )
        .unwrap();
        drop(conn);
        let duplicate = import_files(
            vec![audio.to_string_lossy().into_owned()],
            &db.to_string_lossy(),
            &cache,
        )
        .unwrap();
        assert!(duplicate.is_empty());
        let conn = Connection::open(&db).unwrap();
        let preserved: (String, f64, String) = conn
            .query_row("SELECT title,rating,import_status FROM tracks", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(preserved, ("User title".into(), 4.5, "accepted".into()));
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }
}
