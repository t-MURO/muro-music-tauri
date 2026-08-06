pub mod backfill;
pub mod cover_art;
pub mod import;
pub mod parity;
pub mod playback;
pub mod search;

use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use playback::{AudioPlayer, CurrentTrack, PlaybackState, SeekModePreference};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State, WindowEvent};

// Constants for import status values
const STATUS_STAGED: &str = "staged";
const STATUS_ACCEPTED: &str = "accepted";
const COVERS_DIR: &str = "covers";

fn import_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
    db_path: String,
) -> Result<Vec<import::ImportedTrack>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    // Resolve cover art cache directory
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(COVERS_DIR);

    import::import_files_with_progress(paths, &db_path, &cache_dir, |progress| {
        let _ = app.emit("muro://import-progress", progress);
    })
}

fn load_tracks(db_path: String) -> Result<import::LibrarySnapshot, String> {
    import::load_tracks(&db_path)
}

fn load_playlists(db_path: String) -> Result<import::PlaylistSnapshot, String> {
    import::load_playlists(&db_path)
}

#[tauri::command(rename_all = "camelCase")]
fn clear_tracks(app: tauri::AppHandle, db_path: String) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(COVERS_DIR);
    import::clear_tracks(&db_path, &cache_dir)
}

fn backfill_search_text(db_path: String) -> Result<usize, String> {
    backfill::run_backfill(&db_path)
}

#[tauri::command(rename_all = "camelCase")]
fn backfill_cover_art(app: tauri::AppHandle, db_path: String) -> Result<usize, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(COVERS_DIR);
    backfill::run_cover_art_backfill(&db_path, &cache_dir)
}

// Playback commands
#[tauri::command]
fn playback_play_file(
    player: State<'_, Arc<AudioPlayer>>,
    id: String,
    title: String,
    artist: String,
    album: String,
    source_path: String,
    duration_hint: f64,
    cover_art_path: Option<String>,
    cover_art_thumb_path: Option<String>,
) -> Result<(), String> {
    let track = CurrentTrack {
        id,
        title,
        artist,
        album,
        source_path,
        cover_art_path,
        cover_art_thumb_path,
    };
    player.play_file(track, duration_hint)
}

#[tauri::command]
fn playback_toggle(player: State<'_, Arc<AudioPlayer>>) -> bool {
    player.toggle_play()
}

#[tauri::command]
fn playback_play(player: State<'_, Arc<AudioPlayer>>) {
    player.play();
}

#[tauri::command]
fn playback_pause(player: State<'_, Arc<AudioPlayer>>) {
    player.pause();
}

#[tauri::command]
fn playback_stop(player: State<'_, Arc<AudioPlayer>>) {
    player.stop();
}

#[tauri::command]
fn playback_seek(player: State<'_, Arc<AudioPlayer>>, position_secs: f64) -> Result<(), String> {
    player.seek(position_secs)
}

#[tauri::command]
fn playback_set_volume(player: State<'_, Arc<AudioPlayer>>, volume: f64) {
    player.set_volume(volume);
}

#[tauri::command]
fn playback_set_seek_mode(player: State<'_, Arc<AudioPlayer>>, mode: String) {
    let preference = SeekModePreference::from_str(&mode);
    player.set_seek_mode(preference);
}

#[tauri::command]
fn playback_get_state(player: State<'_, Arc<AudioPlayer>>) -> PlaybackState {
    player.get_state()
}

#[tauri::command]
fn playback_is_finished(player: State<'_, Arc<AudioPlayer>>) -> bool {
    player.is_finished()
}

#[tauri::command]
fn get_track_source_path(db_path: String, track_id: String) -> Result<Option<String>, String> {
    if !Path::new(&db_path).exists() {
        return Ok(None);
    }

    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT source_path FROM tracks WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    let path: Option<String> = stmt.query_row([&track_id], |row| row.get(0)).ok();

    Ok(path)
}

#[tauri::command(rename_all = "camelCase")]
fn update_track_analysis(
    db_path: String,
    track_id: String,
    bpm: Option<f64>,
    key: Option<String>,
) -> Result<(), String> {
    if !Path::new(&db_path).exists() {
        return Err("Database not found".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE tracks SET bpm = ?1, key = ?2 WHERE id = ?3",
        rusqlite::params![bpm, key, track_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn record_track_play(db_path: String, track_id: String) -> Result<(), String> {
    if !Path::new(&db_path).exists() {
        return Err("Database not found".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    // Format timestamp as ISO 8601
    let formatted = chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default();

    conn.execute(
        "UPDATE tracks SET last_played_at = ?1, play_count = COALESCE(play_count, 0) + 1 WHERE id = ?2",
        rusqlite::params![formatted, track_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn load_recently_played(db_path: String, limit: i32) -> Result<Vec<import::ImportedTrack>, String> {
    if !Path::new(&db_path).exists() {
        return Ok(Vec::new());
    }

    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    import::ensure_schema(&conn)?;

    import::load_recently_played(&conn, limit)
}

fn create_playlist(db_path: String, id: String, name: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    import::ensure_playlist_schema(&conn)?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO playlists (id, name, created_at) VALUES (?1, ?2, ?3)",
        (&id, &name, timestamp),
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

fn add_tracks_to_playlist(
    db_path: String,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<(), String> {
    if track_ids.is_empty() {
        return Ok(());
    }

    let mut conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    import::ensure_playlist_schema(&conn)?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;

    // Get current max position for this playlist
    let max_position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?1",
            [&playlist_id],
            |row| row.get(0),
        )
        .unwrap_or(-1);

    let mut position = max_position + 1;
    for track_id in track_ids {
        tx.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
            (&playlist_id, &track_id, position),
        )
        .map_err(|error| error.to_string())?;
        position += 1;
    }

    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn remove_last_tracks_from_playlist(
    db_path: String,
    playlist_id: String,
    count: i64,
) -> Result<(), String> {
    if count <= 0 {
        return Ok(());
    }

    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;

    conn.execute(
        "DELETE FROM playlist_tracks WHERE rowid IN (
            SELECT rowid FROM playlist_tracks 
            WHERE playlist_id = ?1 
            ORDER BY position DESC 
            LIMIT ?2
        )",
        rusqlite::params![&playlist_id, count],
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

fn delete_playlist(db_path: String, playlist_id: String) -> Result<(), String> {
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM playlists WHERE id = ?1", [&playlist_id])
        .map_err(|error| error.to_string())?;

    Ok(())
}

/// Write metadata tags back to an audio file on disk.
/// Non-fatal: the DB is the source of truth; file write failures are logged.
fn write_tags_to_file(
    source_path: &str,
    updates: &HashMap<String, serde_json::Value>,
    cover_art_full_path: Option<&str>,
) -> Result<(), String> {
    let path = Path::new(source_path);
    if !path.exists() {
        return Err(format!("File not found: {}", source_path));
    }

    let mut tagged = Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    // Get or create the primary tag
    let file_type = tagged.file_type();
    if tagged.primary_tag().is_none() {
        let tag_type = match file_type {
            FileType::Mpeg | FileType::Aiff | FileType::Wav => TagType::Id3v2,
            FileType::Flac => TagType::VorbisComments,
            FileType::Mp4 => TagType::Mp4Ilst,
            _ => TagType::Id3v2,
        };
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged.primary_tag_mut().unwrap();

    for (key, value) in updates {
        let text_value = if value.is_null() {
            continue;
        } else if let Some(s) = value.as_str() {
            s.to_string()
        } else {
            value.to_string()
        };

        match key.as_str() {
            "title" => {
                tag.insert(TagItem::new(
                    ItemKey::TrackTitle,
                    ItemValue::Text(text_value),
                ));
            }
            "artist" => {
                tag.insert(TagItem::new(
                    ItemKey::TrackArtist,
                    ItemValue::Text(text_value),
                ));
            }
            "artists" => {
                tag.insert(TagItem::new(
                    ItemKey::AlbumArtist,
                    ItemValue::Text(text_value),
                ));
            }
            "album" => {
                tag.insert(TagItem::new(
                    ItemKey::AlbumTitle,
                    ItemValue::Text(text_value),
                ));
            }
            "trackNumber" => {
                tag.insert(TagItem::new(
                    ItemKey::TrackNumber,
                    ItemValue::Text(text_value),
                ));
            }
            "trackTotal" => {
                tag.insert(TagItem::new(
                    ItemKey::TrackTotal,
                    ItemValue::Text(text_value),
                ));
            }
            "discNumber" => {
                tag.insert(TagItem::new(
                    ItemKey::DiscNumber,
                    ItemValue::Text(text_value),
                ));
            }
            "discTotal" => {
                tag.insert(TagItem::new(
                    ItemKey::DiscTotal,
                    ItemValue::Text(text_value),
                ));
            }
            "year" => {
                tag.insert(TagItem::new(ItemKey::Year, ItemValue::Text(text_value)));
            }
            "genre" => {
                tag.insert(TagItem::new(ItemKey::Genre, ItemValue::Text(text_value)));
            }
            "comment" => {
                tag.insert(TagItem::new(ItemKey::Comment, ItemValue::Text(text_value)));
            }
            "label" => {
                tag.insert(TagItem::new(ItemKey::Label, ItemValue::Text(text_value)));
            }
            "bpm" => {
                tag.insert(TagItem::new(ItemKey::Bpm, ItemValue::Text(text_value)));
            }
            "key" => {
                tag.insert(TagItem::new(
                    ItemKey::InitialKey,
                    ItemValue::Text(text_value),
                ));
            }
            "rating" => {
                if file_type == FileType::Mpeg {
                    // Write POPM frame for MP3 files
                    if let Ok(rating_f) = text_value.parse::<f32>() {
                        let byte = (rating_f * 51.0).round() as u8;
                        let mut data = Vec::new();
                        data.push(0); // empty email, null-terminated
                        data.push(byte);
                        data.extend_from_slice(&[0, 0, 0, 0]); // play counter
                        tag.insert(TagItem::new(
                            ItemKey::Popularimeter,
                            ItemValue::Binary(data),
                        ));
                    }
                } else {
                    tag.insert(TagItem::new(
                        ItemKey::Unknown(String::from("RATING")),
                        ItemValue::Text(text_value),
                    ));
                }
            }
            _ => {} // Skip coverArtPath, coverArtThumbPath — handled below
        }
    }

    // Handle cover art
    if let Some(cover_path) = cover_art_full_path {
        let cover_bytes =
            std::fs::read(cover_path).map_err(|e| format!("Failed to read cover art: {}", e))?;
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            cover_bytes,
        ));
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Failed to save tags: {}", e))?;

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn update_track_metadata(
    db_path: String,
    track_ids: Vec<String>,
    updates: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    if track_ids.is_empty() || updates.is_empty() {
        return Ok(());
    }

    if !Path::new(&db_path).exists() {
        return Err("Database not found".to_string());
    }

    // Whitelist of allowed camelCase keys → snake_case DB columns
    let allowed: HashMap<&str, &str> = [
        ("title", "title"),
        ("artist", "artist"),
        ("artists", "album_artist"),
        ("album", "album"),
        ("trackNumber", "track_number"),
        ("trackTotal", "track_total"),
        ("discNumber", "disc_number"),
        ("discTotal", "disc_total"),
        ("year", "year"),
        ("genre", "genre_json"),
        ("comment", "comment_json"),
        ("label", "label"),
        ("bpm", "bpm"),
        ("key", "key"),
        ("rating", "rating"),
        ("coverArtPath", "cover_art_path"),
        ("coverArtThumbPath", "cover_art_thumb_path"),
    ]
    .into_iter()
    .collect();

    let mut set_clauses = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut param_index = 1;

    for (key, value) in &updates {
        let column = match allowed.get(key.as_str()) {
            Some(col) => *col,
            None => continue, // Skip unknown keys
        };

        // Special handling for genre and comment: comma-separated → JSON array
        if column == "genre_json" || column == "comment_json" {
            let json_value = if let Some(s) = value.as_str() {
                let items: Vec<String> = s
                    .split(',')
                    .map(|item| item.trim().to_string())
                    .filter(|item| !item.is_empty())
                    .collect();
                serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
            } else {
                "[]".to_string()
            };
            set_clauses.push(format!("{} = ?{}", column, param_index));
            params.push(Box::new(json_value));
            param_index += 1;
            continue;
        }

        set_clauses.push(format!("{} = ?{}", column, param_index));

        // Convert JSON value to appropriate SQL type
        if value.is_null() {
            params.push(Box::new(None::<String>));
        } else if let Some(s) = value.as_str() {
            params.push(Box::new(s.to_string()));
        } else if let Some(n) = value.as_f64() {
            params.push(Box::new(n));
        } else if let Some(n) = value.as_i64() {
            params.push(Box::new(n));
        } else {
            params.push(Box::new(value.to_string()));
        }

        param_index += 1;
    }

    if set_clauses.is_empty() {
        return Ok(());
    }

    // Add updated_at timestamp
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    set_clauses.push(format!("updated_at = ?{}", param_index));
    params.push(Box::new(now));
    param_index += 1;

    // Build WHERE IN clause
    let placeholders: Vec<String> = track_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", param_index + i))
        .collect();

    let sql = format!(
        "UPDATE tracks SET {} WHERE id IN ({})",
        set_clauses.join(", "),
        placeholders.join(", ")
    );

    for id in &track_ids {
        params.push(Box::new(id.clone()));
    }

    let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    tx.execute(&sql, param_refs.as_slice())
        .map_err(|e| e.to_string())?;

    // Regenerate search_text for affected tracks
    for track_id in &track_ids {
        let row = tx.query_row(
            "SELECT title, artist, album, album_artist, genre_json, comment_json, label, filename, year, track_number, disc_number FROM tracks WHERE id = ?1",
            [track_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i32>>(8)?,
                    row.get::<_, Option<i32>>(9)?,
                    row.get::<_, Option<i32>>(10)?,
                ))
            },
        );

        if let Ok((
            title,
            artist,
            album,
            album_artist,
            genre_json,
            comment_json,
            label,
            filename,
            year,
            track_number,
            disc_number,
        )) = row
        {
            let genres: Vec<String> = genre_json
                .and_then(|g| serde_json::from_str(&g).ok())
                .unwrap_or_default();
            let comments: Vec<String> = comment_json
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_default();
            let genre_refs: Vec<&str> = genres.iter().map(|s| s.as_str()).collect();
            let comment_refs: Vec<&str> = comments.iter().map(|s| s.as_str()).collect();

            let search_text = search::normalize_track_search_text(search::TrackSearchParts {
                title: title.as_deref(),
                artist: artist.as_deref(),
                album: album.as_deref(),
                album_artist: album_artist.as_deref(),
                genres: if genre_refs.is_empty() {
                    None
                } else {
                    Some(&genre_refs)
                },
                comments: if comment_refs.is_empty() {
                    None
                } else {
                    Some(&comment_refs)
                },
                label: label.as_deref(),
                filename: filename.as_deref(),
                year,
                track_number,
                disc_number,
            });

            tx.execute(
                "UPDATE tracks SET search_text = ?1 WHERE id = ?2",
                rusqlite::params![search_text, track_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    // Write tags back to audio files (non-fatal — DB is source of truth)
    let cover_art_full_path = updates
        .get("coverArtPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let conn_for_paths = Connection::open(&db_path).map_err(|e| e.to_string())?;
    for track_id in &track_ids {
        let source_path: Option<String> = conn_for_paths
            .query_row(
                "SELECT source_path FROM tracks WHERE id = ?1",
                [track_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(ref path) = source_path {
            if let Err(e) = write_tags_to_file(path, &updates, cover_art_full_path.as_deref()) {
                eprintln!("Warning: failed to write tags to file '{}': {}", path, e);
            }
        }
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedCoverResult {
    full_path: String,
    thumb_path: String,
}

#[tauri::command(rename_all = "camelCase")]
fn cache_cover_art_from_file(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<CachedCoverResult, String> {
    let bytes = std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(COVERS_DIR);

    let cached = cover_art::cache_cover_art(&bytes, &cache_dir)
        .ok_or_else(|| "Failed to cache cover art".to_string())?;

    Ok(CachedCoverResult {
        full_path: cached.full_path,
        thumb_path: cached.thumb_path,
    })
}

/// Execute a bulk operation on tracks by ID
fn execute_bulk_track_operation(
    db_path: &str,
    track_ids: &[String],
    sql_template: &str,
) -> Result<(), String> {
    if track_ids.is_empty() {
        return Ok(());
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;

    let placeholders: Vec<String> = track_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let sql = sql_template.replace("{}", &placeholders.join(", "));

    let params: Vec<&dyn rusqlite::ToSql> = track_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();
    conn.execute(&sql, params.as_slice())
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn accept_tracks(db_path: String, track_ids: Vec<String>) -> Result<(), String> {
    execute_bulk_track_operation(
        &db_path,
        &track_ids,
        &format!(
            "UPDATE tracks SET import_status = '{}' WHERE id IN ({{}})",
            STATUS_ACCEPTED
        ),
    )
}

fn unaccept_tracks(db_path: String, track_ids: Vec<String>) -> Result<(), String> {
    execute_bulk_track_operation(
        &db_path,
        &track_ids,
        &format!(
            "UPDATE tracks SET import_status = '{}' WHERE id IN ({{}})",
            STATUS_STAGED
        ),
    )
}

fn reject_tracks(db_path: String, track_ids: Vec<String>) -> Result<(), String> {
    execute_bulk_track_operation(&db_path, &track_ids, "DELETE FROM tracks WHERE id IN ({})")
}

#[tauri::command]
fn clipboard_has_image() -> Result<bool, String> {
    parity::desktop::clipboard_has_image()
}

#[tauri::command]
fn cache_clipboard_cover_art(
    app: tauri::AppHandle,
) -> Result<Option<parity::desktop::CachedClipboardCover>, String> {
    parity::desktop::cache_clipboard_cover_art(app)
}

#[tauri::command(rename_all = "camelCase")]
fn copy_image_to_clipboard(file_path: String) -> Result<bool, String> {
    parity::desktop::copy_image_to_clipboard(file_path)
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    parity::desktop::open_external(app, url)
}

#[tauri::command(rename_all = "camelCase")]
fn show_item_in_folder(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    parity::desktop::show_item_in_folder(app, file_path)
}
#[derive(Clone, Serialize)]
struct DragDropPayload {
    kind: &'static str,
    paths: Vec<String>,
}

fn emit_drag_event(window: &tauri::WebviewWindow, kind: &'static str, paths: Vec<String>) {
    let payload = DragDropPayload { kind, paths };
    let _ = window.emit("muro://native-drag", payload);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let audio_player = Arc::new(AudioPlayer::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(audio_player.clone())
        .setup(move |app| {
            // Initialize audio player with app handle
            audio_player.init(app.handle().clone());

            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "No main window found to enable drag drop.")?;
            let window_for_events = window.clone();

            window.on_window_event(move |event| {
                let WindowEvent::DragDrop(drag_event) = event else {
                    return;
                };

                match drag_event {
                    tauri::DragDropEvent::Enter { .. } => {
                        emit_drag_event(&window_for_events, "over", Vec::new());
                    }
                    tauri::DragDropEvent::Leave { .. } => {
                        emit_drag_event(&window_for_events, "leave", Vec::new());
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let string_paths = paths
                            .iter()
                            .map(|path| path.to_string_lossy().to_string())
                            .collect::<Vec<String>>();
                        emit_drag_event(&window_for_events, "drop", string_paths);
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parity::commands::import_files,
            parity::commands::backfill_search_text,
            backfill_cover_art,
            parity::commands::create_playlist,
            parity::commands::delete_playlist,
            parity::commands::add_tracks_to_playlist,
            parity::commands::remove_last_tracks_from_playlist,
            parity::database::load_tracks,
            parity::commands::load_playlists,
            parity::database::load_recently_played,
            clear_tracks,
            parity::commands::accept_tracks,
            parity::commands::unaccept_tracks,
            parity::commands::reject_tracks,
            parity::commands::delete_tracks,
            parity::commands::validate_library_structure,
            parity::commands::repair_library_structure,
            parity::commands::verify_library_files,
            parity::commands::list_missing_tracks,
            parity::commands::relink_track,
            parity::commands::auto_relink_missing,
            parity::commands::update_playlist,
            parity::commands::reorder_playlists,
            parity::commands::delete_playlists,
            parity::commands::restore_playlists,
            parity::commands::create_playlist_folder,
            parity::commands::update_playlist_folder,
            parity::commands::delete_playlist_folder,
            parity::commands::set_playlist_tracks,
            parity::commands::list_playlist_history,
            parity::commands::undo_playlist_history,
            parity::commands::redo_playlist_history,
            parity::commands::create_playlist_snapshot,
            parity::commands::list_playlist_snapshots,
            parity::commands::restore_playlist_snapshot,
            parity::commands::delete_playlist_snapshot,
            parity::commands::rebuild_search_index,
            parity::database::search_tracks,
            parity::database::migrate_artist_credits,
            playback_play_file,
            playback_toggle,
            playback_play,
            playback_pause,
            playback_stop,
            playback_seek,
            playback_set_volume,
            playback_set_seek_mode,
            playback_get_state,
            playback_is_finished,
            get_track_source_path,
            update_track_analysis,
            update_track_metadata,
            cache_cover_art_from_file,
            record_track_play,
            clipboard_has_image,
            cache_clipboard_cover_art,
            copy_image_to_clipboard,
            open_external,
            show_item_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
