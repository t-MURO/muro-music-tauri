//! Native library lifecycle operations matching the Electron backend contracts.
//!
//! This module deliberately contains no Tauri-specific state. Command wrappers can
//! pass the database/cache paths supplied by the application and serialize the
//! returned structures directly.

use crate::import;
use lofty::prelude::AudioFile;
use lofty::probe::Probe;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

const LIBRARY_ROOT_KEY: &str = "library_root";
const STATUS_STAGED: &str = "staged";
const STATUS_ACCEPTED: &str = "accepted";
const AUDIO_EXTENSIONS: [&str; 10] = [
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "alac",
];
const NATIVE_IMPORT_EXTENSIONS: [&str; 10] = [
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "alac",
];

#[derive(Debug, Serialize, Clone)]
pub struct ImportFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportFilesResult {
    pub imported: Vec<import::ImportedTrack>,
    pub scanned: usize,
    pub failures: Vec<ImportFailure>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CompatibleImportProgress {
    pub imported: usize,
    pub total: usize,
    pub phase: &'static str,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureLibraryRootResult {
    pub library_root: Option<String>,
    pub migrated: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MovedTrack {
    pub track_id: String,
    pub source_path: String,
    pub filename: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackFailure {
    pub track_id: String,
    pub source_path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AcceptTracksResult {
    pub accepted: usize,
    pub accepted_track_ids: Vec<String>,
    pub moved: Vec<MovedTrack>,
    pub failures: Vec<TrackFailure>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub track_id: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTracksResult {
    pub deleted_track_ids: Vec<String>,
    pub failures: Vec<DeleteFailure>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StructureIssue {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub filename: String,
    pub current_path: String,
    pub current_folder: String,
    pub expected_folder: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ValidateStructureResult {
    pub checked: usize,
    pub unavailable: usize,
    pub outside_root: usize,
    pub misplaced: Vec<StructureIssue>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepairStructureResult {
    pub requested: usize,
    pub moved: Vec<MovedTrack>,
    pub skipped: usize,
    pub failures: Vec<TrackFailure>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VerifyLibraryResult {
    pub checked: usize,
    pub newly_missing: usize,
    pub restored: usize,
    pub missing: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct MissingTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub source_path: String,
    pub filename: String,
    pub duration_seconds: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelinkTrackResult {
    pub relinked: bool,
    pub source_path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelinkMatch {
    pub track_id: String,
    pub source_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AutoRelinkResult {
    pub matched: usize,
    pub relinked: usize,
    pub matches: Vec<RelinkMatch>,
}

#[derive(Debug, Clone)]
struct OrganizerTrack {
    id: String,
    title: String,
    artist: String,
    album_artist: String,
    album: String,
    source_path: String,
}

#[derive(Debug)]
struct MissingRow {
    id: String,
    filename: String,
    source_path: String,
    duration_seconds: f64,
}

/// Electron-compatible import result (`imported`, `scanned`, `failures`).
pub fn import_files(
    paths: Vec<String>,
    db_path: &str,
    cache_dir: &Path,
    library_folder: Option<&str>,
) -> Result<ImportFilesResult, String> {
    import_files_with_progress(paths, db_path, cache_dir, library_folder, |_| {})
}

pub fn import_files_with_progress<F>(
    paths: Vec<String>,
    db_path: &str,
    cache_dir: &Path,
    library_folder: Option<&str>,
    mut on_progress: F,
) -> Result<ImportFilesResult, String>
where
    F: FnMut(CompatibleImportProgress),
{
    let audio_paths = collect_audio_paths(&paths)?;
    if let Some(root) = library_folder.filter(|value| !value.trim().is_empty()) {
        configure_library_root(db_path, Some(root))?;
    }

    let mut imported_tracks = Vec::new();
    let mut failures = Vec::new();
    let total = audio_paths.len();
    for (index, audio_path) in audio_paths.into_iter().enumerate() {
        let display_path = path_string(&audio_path);
        let extension = extension_lowercase(&audio_path);
        let result = if NATIVE_IMPORT_EXTENSIONS.contains(&extension.as_str()) {
            Probe::open(&audio_path)
                .map_err(|error| error.to_string())
                .and_then(|probe| probe.read().map_err(|error| error.to_string()))
                .and_then(|_| import::import_files(vec![display_path.clone()], db_path, cache_dir))
        } else {
            Err(format!(
                "The native importer does not yet support .{} files",
                extension
            ))
        };

        match result {
            Ok(mut tracks) => {
                normalize_new_import_paths(db_path, &tracks)?;
                imported_tracks.append(&mut tracks);
            }
            Err(message) => failures.push(ImportFailure {
                path: display_path,
                message,
            }),
        }
        on_progress(CompatibleImportProgress {
            imported: index + 1,
            total,
            phase: "importing",
        });
    }

    Ok(ImportFilesResult {
        imported: imported_tracks,
        scanned: total,
        failures,
    })
}

pub fn get_library_root(db_path: &str) -> Result<Option<String>, String> {
    let conn = open_connection(db_path)?;
    let root: Option<String> = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key = ?1",
            [LIBRARY_ROOT_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(root
        .as_deref()
        .and_then(normalize_library_root)
        .map(|path| path_string(&path)))
}

/// Configure the sole library root and migrate files beneath it to portable paths.
/// Accepted tracks outside a newly selected root return to the Inbox.
pub fn configure_library_root(
    db_path: &str,
    requested_root: Option<&str>,
) -> Result<ConfigureLibraryRootResult, String> {
    let requested = requested_root.unwrap_or_default().trim();
    if requested.is_empty() {
        return Ok(ConfigureLibraryRootResult {
            library_root: get_library_root(db_path)?,
            migrated: 0,
        });
    }

    let root = normalize_library_root(requested)
        .ok_or_else(|| "Choose the music library folder first".to_string())?;
    let mut conn = open_connection(db_path)?;
    let previous_root: Option<PathBuf> = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key = ?1",
            [LIBRARY_ROOT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .as_deref()
        .and_then(normalize_library_root);
    let root_changed = previous_root
        .as_ref()
        .map(|previous| path_key(previous) != path_key(&root))
        .unwrap_or(true);

    let rows = {
        let mut statement = conn
            .prepare("SELECT id, source_path, import_status FROM tracks")
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?
                        .unwrap_or_else(|| STATUS_ACCEPTED.to_string()),
                ))
            })
            .map_err(|error| error.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    let mut used: HashMap<String, String> = rows
        .iter()
        .map(|(id, source, _)| (portable_key(source), id.clone()))
        .collect();
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO app_metadata(key, value) VALUES (?1, ?2)\n             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![LIBRARY_ROOT_KEY, path_string(&root)],
        )
        .map_err(|error| error.to_string())?;

    let mut migrated = 0;
    for (id, stored, status) in rows {
        let resolved = resolve_stored_track_path(&stored, previous_root.as_deref())?;
        let portable = to_stored_track_path(&resolved, Some(&root));
        let mut effective = stored.clone();
        if !portable.is_empty() && portable != stored {
            let collision = used.get(&portable_key(&portable));
            if collision.is_none() || collision == Some(&id) {
                transaction
                    .execute(
                        "UPDATE tracks SET source_path = ?1 WHERE id = ?2",
                        params![portable, id],
                    )
                    .map_err(|error| error.to_string())?;
                used.remove(&portable_key(&stored));
                used.insert(portable_key(&portable), id.clone());
                effective = portable;
                migrated += 1;
            }
        }

        let resolved_for_new_root = if is_absolute_track_path(&path_string(&resolved)) {
            resolved
        } else {
            resolve_stored_track_path(&effective, Some(&root))?
        };
        if root_changed
            && status != STATUS_STAGED
            && !is_path_inside_or_equal(&resolved_for_new_root, &root)
        {
            transaction
                .execute(
                    "UPDATE tracks SET import_status = ?1 WHERE id = ?2",
                    params![STATUS_STAGED, id],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;

    Ok(ConfigureLibraryRootResult {
        library_root: Some(path_string(&root)),
        migrated,
    })
}

pub fn accept_tracks(
    db_path: &str,
    track_ids: Vec<String>,
    organize: bool,
    library_folder: Option<&str>,
) -> Result<AcceptTracksResult, String> {
    let ids = clean_ids(track_ids);
    if ids.is_empty() {
        return Ok(AcceptTracksResult {
            accepted: 0,
            accepted_track_ids: Vec::new(),
            moved: Vec::new(),
            failures: Vec::new(),
        });
    }
    let root = configured_library_root(db_path, library_folder)?;
    let conn = open_connection(db_path)?;
    let tracks = select_organizer_tracks(&conn, &ids, Some(STATUS_STAGED))?;
    let now = current_timestamp();
    let mut accepted_track_ids = Vec::new();
    let mut moved = Vec::new();
    let mut failures = Vec::new();

    for track in tracks {
        let mut source_path = resolve_stored_track_path(&track.source_path, Some(&root))?;
        if !source_path.is_file() {
            failures.push(TrackFailure {
                track_id: track.id,
                source_path: path_string(&source_path),
                message: "Source path is not a file".to_string(),
            });
            continue;
        }

        let already_in_library = is_path_inside_or_equal(&source_path, &root);
        let requested_destination = if organize {
            accepted_track_destination(&track, &source_path, &root)
        } else if already_in_library {
            source_path.clone()
        } else {
            root.join(source_path.file_name().unwrap_or_default())
        };

        if paths_equal(&source_path, &requested_destination) {
            match conn.execute(
                "UPDATE tracks SET import_status = ?1, is_missing = 0,\n                 move_to_watched_folder_on_accept = 0, updated_at = ?2 WHERE id = ?3",
                params![STATUS_ACCEPTED, now, track.id],
            ) {
                Ok(_) => accepted_track_ids.push(track.id),
                Err(error) => failures.push(TrackFailure {
                    track_id: track.id,
                    source_path: path_string(&source_path),
                    message: error.to_string(),
                }),
            }
            continue;
        }

        match move_without_overwrite(&source_path, &requested_destination) {
            Ok(destination) => {
                source_path = destination;
                let stored = to_stored_track_path(&source_path, Some(&root));
                let filename = file_name_string(&source_path);
                match conn.execute(
                    "UPDATE tracks SET source_path = ?1, filename = ?2, is_missing = 0,\n                     import_status = ?3, move_to_watched_folder_on_accept = 0, updated_at = ?4\n                     WHERE id = ?5",
                    params![stored, filename, STATUS_ACCEPTED, now, track.id],
                ) {
                    Ok(_) => {
                        accepted_track_ids.push(track.id.clone());
                        moved.push(MovedTrack {
                            track_id: track.id,
                            source_path: path_string(&source_path),
                            filename,
                        });
                    }
                    Err(error) => {
                        let _ = move_without_overwrite(&source_path, &resolve_stored_track_path(&track.source_path, Some(&root))?);
                        failures.push(TrackFailure {
                            track_id: track.id,
                            source_path: path_string(&source_path),
                            message: error.to_string(),
                        });
                    }
                }
            }
            Err(error) => failures.push(TrackFailure {
                track_id: track.id,
                source_path: path_string(&source_path),
                message: error.to_string(),
            }),
        }
    }

    Ok(AcceptTracksResult {
        accepted: accepted_track_ids.len(),
        accepted_track_ids,
        moved,
        failures,
    })
}

pub fn unaccept_tracks(db_path: &str, track_ids: Vec<String>) -> Result<usize, String> {
    bulk_track_operation(
        db_path,
        track_ids,
        "UPDATE tracks SET import_status = 'staged' WHERE id IN",
    )
}

pub fn reject_tracks(db_path: &str, track_ids: Vec<String>) -> Result<usize, String> {
    bulk_track_operation(db_path, track_ids, "DELETE FROM tracks WHERE id IN")
}

pub fn delete_tracks(
    db_path: &str,
    track_ids: Vec<String>,
    delete_from_disk: bool,
) -> Result<DeleteTracksResult, String> {
    let ids = clean_ids(track_ids);
    if ids.is_empty() {
        return Ok(DeleteTracksResult {
            deleted_track_ids: Vec::new(),
            failures: Vec::new(),
        });
    }
    if !delete_from_disk {
        bulk_track_operation(db_path, ids.clone(), "DELETE FROM tracks WHERE id IN")?;
        return Ok(DeleteTracksResult {
            deleted_track_ids: ids,
            failures: Vec::new(),
        });
    }

    let conn = open_connection(db_path)?;
    let root = library_root_from_connection(&conn)?;
    let mut deleted_track_ids = Vec::new();
    let mut failures = Vec::new();
    for id in ids {
        let stored: Option<String> = conn
            .query_row(
                "SELECT source_path FROM tracks WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(stored) = stored else { continue };
        let source_path = resolve_stored_track_path(&stored, root.as_deref())?;
        match fs::remove_file(&source_path) {
            Ok(()) => deleted_track_ids.push(id),
            Err(error) if error.kind() == io::ErrorKind::NotFound => deleted_track_ids.push(id),
            Err(error) => failures.push(DeleteFailure {
                track_id: id,
                path: path_string(&source_path),
                message: error.to_string(),
            }),
        }
    }
    bulk_track_operation(
        db_path,
        deleted_track_ids.clone(),
        "DELETE FROM tracks WHERE id IN",
    )?;
    Ok(DeleteTracksResult {
        deleted_track_ids,
        failures,
    })
}

pub fn validate_library_structure(
    db_path: &str,
    library_root: Option<&str>,
) -> Result<ValidateStructureResult, String> {
    let root = configured_library_root(db_path, library_root)?;
    let conn = open_connection(db_path)?;
    let tracks = select_organizer_tracks(&conn, &[], Some("!staged"))?;
    let mut result = ValidateStructureResult {
        checked: 0,
        unavailable: 0,
        outside_root: 0,
        misplaced: Vec::new(),
    };

    for track in tracks {
        let source_path = match resolve_stored_track_path(&track.source_path, Some(&root)) {
            Ok(path) => path,
            Err(_) => {
                result.unavailable += 1;
                continue;
            }
        };
        if !source_path.is_file() {
            result.unavailable += 1;
            continue;
        }
        if !is_path_inside_or_equal(&source_path, &root) {
            result.outside_root += 1;
            continue;
        }
        result.checked += 1;
        if let Some(issue) = structure_issue(&track, &source_path, &root) {
            result.misplaced.push(issue);
        }
    }
    Ok(result)
}

pub fn repair_library_structure(
    db_path: &str,
    library_root: Option<&str>,
    track_ids: Vec<String>,
) -> Result<RepairStructureResult, String> {
    let root = configured_library_root(db_path, library_root)?;
    let ids = clean_ids(track_ids);
    if ids.is_empty() {
        return Ok(RepairStructureResult {
            requested: 0,
            moved: Vec::new(),
            skipped: 0,
            failures: Vec::new(),
        });
    }
    let conn = open_connection(db_path)?;
    let tracks = select_organizer_tracks(&conn, &ids, Some("!staged"))?;
    let mut skipped = ids.len().saturating_sub(tracks.len());
    let mut moved = Vec::new();
    let mut failures = Vec::new();
    let now = current_timestamp();

    for track in tracks {
        let source_path = resolve_stored_track_path(&track.source_path, Some(&root))?;
        if !source_path.is_file() || !is_path_inside_or_equal(&source_path, &root) {
            skipped += 1;
            continue;
        }
        let Some(issue) = structure_issue(&track, &source_path, &root) else {
            skipped += 1;
            continue;
        };
        let requested_destination =
            PathBuf::from(&issue.expected_folder).join(source_path.file_name().unwrap_or_default());
        match move_without_overwrite(&source_path, &requested_destination) {
            Ok(destination) => {
                let stored = to_stored_track_path(&destination, Some(&root));
                let filename = file_name_string(&destination);
                match conn.execute(
                    "UPDATE tracks SET source_path = ?1, filename = ?2, is_missing = 0,\n                     updated_at = ?3 WHERE id = ?4",
                    params![stored, filename, now, track.id],
                ) {
                    Ok(_) => moved.push(MovedTrack {
                        track_id: track.id,
                        source_path: path_string(&destination),
                        filename,
                    }),
                    Err(error) => {
                        let _ = move_without_overwrite(&destination, &source_path);
                        failures.push(TrackFailure {
                            track_id: track.id,
                            source_path: path_string(&source_path),
                            message: error.to_string(),
                        });
                    }
                }
            }
            Err(error) => failures.push(TrackFailure {
                track_id: track.id,
                source_path: path_string(&source_path),
                message: error.to_string(),
            }),
        }
    }

    Ok(RepairStructureResult {
        requested: ids.len(),
        moved,
        skipped,
        failures,
    })
}

pub fn verify_library_files(db_path: &str) -> Result<VerifyLibraryResult, String> {
    let mut conn = open_connection(db_path)?;
    let root = library_root_from_connection(&conn)?;
    let rows = {
        let mut statement = conn
            .prepare("SELECT id, source_path, is_missing FROM tracks")
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0) == 1,
                ))
            })
            .map_err(|error| error.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let mut newly_missing = 0;
    let mut restored = 0;
    let mut missing = 0;
    for (id, stored, was_missing) in &rows {
        let source_path = resolve_stored_track_path(stored, root.as_deref())?;
        let exists = source_path.is_absolute() && source_path.exists();
        if !exists {
            missing += 1;
            if !was_missing {
                transaction
                    .execute("UPDATE tracks SET is_missing = 1 WHERE id = ?1", [id])
                    .map_err(|error| error.to_string())?;
                newly_missing += 1;
            }
        } else if *was_missing {
            transaction
                .execute("UPDATE tracks SET is_missing = 0 WHERE id = ?1", [id])
                .map_err(|error| error.to_string())?;
            restored += 1;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(VerifyLibraryResult {
        checked: rows.len(),
        newly_missing,
        restored,
        missing,
    })
}

pub fn list_missing_tracks(db_path: &str) -> Result<Vec<MissingTrack>, String> {
    let conn = open_connection(db_path)?;
    let root = library_root_from_connection(&conn)?;
    let mut statement = conn
        .prepare(
            "SELECT id, title, artist, album, source_path, filename, duration_seconds\n             FROM tracks WHERE is_missing = 1\n             ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, track_number",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut missing = Vec::new();
    for row in rows {
        let (id, title, artist, album, stored, filename, duration_seconds) =
            row.map_err(|error| error.to_string())?;
        missing.push(MissingTrack {
            id,
            title,
            artist,
            album,
            source_path: path_string(&resolve_stored_track_path(&stored, root.as_deref())?),
            filename,
            duration_seconds,
        });
    }
    Ok(missing)
}

pub fn relink_track(
    db_path: &str,
    track_id: &str,
    new_path: &str,
) -> Result<RelinkTrackResult, String> {
    let track_id = track_id.trim();
    if track_id.is_empty() {
        return Err("A track is required".to_string());
    }
    let resolved = absolute_lexical(Path::new(new_path.trim()));
    if !resolved.is_file() {
        return Err("The selected file does not exist".to_string());
    }
    if !is_audio_path(&resolved) {
        return Err("The selected file is not a supported audio format".to_string());
    }

    let conn = open_connection(db_path)?;
    let root = library_root_from_connection(&conn)?;
    let stored = to_stored_track_path(&resolved, root.as_deref());
    let clash: Option<String> = conn
        .query_row(
            "SELECT id FROM tracks WHERE source_path = ?1 AND id != ?2",
            params![stored, track_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if clash.is_some() {
        return Err("Another track already uses that file".to_string());
    }
    conn.execute(
        "UPDATE tracks SET source_path = ?1, filename = ?2, is_missing = 0,\n         updated_at = ?3 WHERE id = ?4",
        params![stored, file_name_string(&resolved), current_timestamp(), track_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(RelinkTrackResult {
        relinked: true,
        source_path: path_string(&resolved),
    })
}

pub fn auto_relink_missing(
    db_path: &str,
    search_dir: &str,
    dry_run: bool,
) -> Result<AutoRelinkResult, String> {
    let root = absolute_lexical(Path::new(search_dir.trim()));
    if !root.is_dir() {
        return Err("Choose a folder to search".to_string());
    }
    let mut conn = open_connection(db_path)?;
    let library_root = library_root_from_connection(&conn)?;
    let missing = load_missing_rows(&conn)?;
    if missing.is_empty() {
        return Ok(AutoRelinkResult {
            matched: 0,
            relinked: 0,
            matches: Vec::new(),
        });
    }

    let known_paths: HashSet<String> = {
        let mut statement = conn
            .prepare("SELECT source_path FROM tracks WHERE is_missing = 0")
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([], |row| row.get::<_, Option<String>>(0))
            .map_err(|error| error.to_string())?;
        mapped
            .filter_map(Result::ok)
            .flatten()
            .filter_map(|stored| {
                resolve_stored_track_path(&stored, library_root.as_deref())
                    .ok()
                    .filter(|path| path.is_absolute())
                    .map(|path| path_key(&path))
            })
            .collect()
    };
    let candidates = collect_audio_paths(&[path_string(&root)])?;
    let mut by_name: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for candidate in candidates {
        if known_paths.contains(&path_key(&candidate)) {
            continue;
        }
        by_name
            .entry(file_name_string(&candidate).to_lowercase())
            .or_default()
            .push(candidate);
    }

    let mut matches = Vec::new();
    let mut taken = HashSet::new();
    for track in missing {
        let filename = if track.filename.trim().is_empty() {
            resolve_stored_track_path(&track.source_path, library_root.as_deref())
                .ok()
                .map(|path| file_name_string(&path))
                .unwrap_or_default()
        } else {
            track.filename
        };
        let Some(bucket) = by_name.get(&filename.to_lowercase()) else {
            continue;
        };
        if track.duration_seconds <= 0.0 {
            continue;
        }
        let mut chosen = None;
        for candidate in bucket {
            if taken.contains(&path_key(candidate)) {
                continue;
            }
            let duration = read_audio_duration(candidate).unwrap_or(0.0);
            if duration > 0.0 && (duration - track.duration_seconds).abs() <= 1.0 {
                chosen = Some(candidate.clone());
                break;
            }
        }
        if let Some(candidate) = chosen {
            taken.insert(path_key(&candidate));
            matches.push(RelinkMatch {
                track_id: track.id,
                source_path: path_string(&candidate),
            });
        }
    }

    if !dry_run && !matches.is_empty() {
        let now = current_timestamp();
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        for matched in &matches {
            let source_path = Path::new(&matched.source_path);
            transaction
                .execute(
                    "UPDATE tracks SET source_path = ?1, filename = ?2, is_missing = 0,\n                     updated_at = ?3 WHERE id = ?4",
                    params![
                        to_stored_track_path(source_path, library_root.as_deref()),
                        file_name_string(source_path),
                        now,
                        matched.track_id
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
    }

    Ok(AutoRelinkResult {
        matched: matches.len(),
        relinked: if dry_run { 0 } else { matches.len() },
        matches,
    })
}

pub fn normalize_library_root(value: &str) -> Option<PathBuf> {
    let candidate = value.trim();
    if candidate.is_empty() || candidate.contains('\0') {
        None
    } else {
        Some(absolute_lexical(Path::new(candidate)))
    }
}

pub fn is_absolute_track_path(value: &str) -> bool {
    let candidate = value.trim();
    Path::new(candidate).is_absolute() || is_windows_absolute(candidate)
}

pub fn normalize_portable_track_path(value: &str) -> Option<String> {
    let candidate = value.trim().replace('\\', "/");
    if candidate.is_empty() || is_absolute_track_path(&candidate) {
        return None;
    }
    let segments: Vec<&str> = candidate.split('/').collect();
    if segments.iter().any(|segment| {
        segment.is_empty() || *segment == "." || *segment == ".." || segment.contains('\0')
    }) {
        return None;
    }
    Some(segments.join("/"))
}

pub fn is_path_inside_or_equal(candidate: &Path, root: &Path) -> bool {
    let candidate = absolute_lexical(candidate);
    let root = absolute_lexical(root);
    let candidate_components = comparable_components(&candidate);
    let root_components = comparable_components(&root);
    candidate_components.len() >= root_components.len()
        && candidate_components[..root_components.len()] == root_components
}

pub fn to_stored_track_path(file_path: &Path, library_root: Option<&Path>) -> String {
    let input = path_string(file_path);
    if let Some(portable) = normalize_portable_track_path(&input) {
        return portable;
    }
    if input.trim().is_empty() {
        return String::new();
    }
    let absolute = absolute_lexical(file_path);
    let Some(root) = library_root else {
        return path_string(&absolute);
    };
    if !is_path_inside_or_equal(&absolute, root) {
        return path_string(&absolute);
    }
    relative_path(&absolute, root)
        .and_then(|relative| normalize_portable_track_path(&path_string(&relative)))
        .unwrap_or_else(|| path_string(&absolute))
}

pub fn resolve_stored_track_path(
    stored_path: &str,
    library_root: Option<&Path>,
) -> Result<PathBuf, String> {
    let candidate = stored_path.trim();
    if candidate.is_empty() {
        return Ok(PathBuf::new());
    }
    let Some(portable) = normalize_portable_track_path(candidate) else {
        return Ok(lexically_normalize(Path::new(candidate)));
    };
    let Some(root) = library_root else {
        return Ok(PathBuf::from(portable));
    };
    let resolved = portable
        .split('/')
        .fold(absolute_lexical(root), |path, segment| path.join(segment));
    let resolved = lexically_normalize(&resolved);
    if !is_path_inside_or_equal(&resolved, root) {
        return Err("Stored track path escapes the library root".to_string());
    }
    Ok(resolved)
}

fn open_connection(db_path: &str) -> Result<Connection, String> {
    if let Some(parent) = Path::new(db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    super::database::ensure_schema(&conn)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\n         CREATE TABLE IF NOT EXISTS app_metadata (\n           key TEXT PRIMARY KEY, value TEXT NOT NULL\n         );",
    )
    .map_err(|error| error.to_string())?;
    let _ = conn.execute("ALTER TABLE tracks ADD COLUMN filename TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE tracks ADD COLUMN move_to_watched_folder_on_accept INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE tracks ADD COLUMN is_missing INTEGER DEFAULT 0",
        [],
    );
    Ok(conn)
}

fn configured_library_root(db_path: &str, requested_root: Option<&str>) -> Result<PathBuf, String> {
    let requested = requested_root.unwrap_or_default().trim();
    let root = if requested.is_empty() {
        get_library_root(db_path)?.map(PathBuf::from)
    } else {
        normalize_library_root(requested)
    }
    .ok_or_else(|| "Choose the music library folder first".to_string())?;
    if !root.is_dir() {
        return Err("The music library folder is unavailable".to_string());
    }
    if !requested.is_empty() {
        configure_library_root(db_path, Some(requested))?;
    }
    Ok(root)
}

fn library_root_from_connection(conn: &Connection) -> Result<Option<PathBuf>, String> {
    let root: Option<String> = conn
        .query_row(
            "SELECT value FROM app_metadata WHERE key = ?1",
            [LIBRARY_ROOT_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(root.as_deref().and_then(normalize_library_root))
}

fn normalize_new_import_paths(
    db_path: &str,
    imported_tracks: &[import::ImportedTrack],
) -> Result<(), String> {
    if imported_tracks.is_empty() {
        return Ok(());
    }
    let conn = open_connection(db_path)?;
    let root = library_root_from_connection(&conn)?;
    for track in imported_tracks {
        let source_path = Path::new(&track.source_path);
        conn.execute(
            "UPDATE tracks SET source_path = ?1, filename = ?2 WHERE id = ?3",
            params![
                to_stored_track_path(source_path, root.as_deref()),
                file_name_string(source_path),
                track.id
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn bulk_track_operation(
    db_path: &str,
    track_ids: Vec<String>,
    sql_prefix: &str,
) -> Result<usize, String> {
    let ids = clean_ids(track_ids);
    if ids.is_empty() {
        return Ok(0);
    }
    let conn = open_connection(db_path)?;
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!("{} ({})", sql_prefix, placeholders),
        params_from_iter(ids.iter()),
    )
    .map_err(|error| error.to_string())
}

fn select_organizer_tracks(
    conn: &Connection,
    ids: &[String],
    status_filter: Option<&str>,
) -> Result<Vec<OrganizerTrack>, String> {
    let mut sql =
        String::from("SELECT id, title, artist, album_artist, album, source_path FROM tracks");
    let mut clauses = Vec::new();
    if !ids.is_empty() {
        clauses.push(format!(
            "id IN ({})",
            std::iter::repeat("?")
                .take(ids.len())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(filter) = status_filter {
        clauses.push(if filter == "!staged" {
            "import_status != 'staged'".to_string()
        } else {
            "import_status = 'staged'".to_string()
        });
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE");
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok(OrganizerTrack {
                id: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                artist: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                album_artist: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                album: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                source_path: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn structure_issue(
    track: &OrganizerTrack,
    source_path: &Path,
    root: &Path,
) -> Option<StructureIssue> {
    let current_folder = source_path.parent().unwrap_or_else(|| Path::new(""));
    let destination = accepted_track_destination(track, source_path, root);
    let expected_folder = destination.parent().unwrap_or_else(|| Path::new(""));
    if paths_equal(current_folder, expected_folder) {
        return None;
    }
    Some(StructureIssue {
        track_id: track.id.clone(),
        title: track.title.clone(),
        artist: track.artist.clone(),
        album_artist: track.album_artist.clone(),
        album: track.album.clone(),
        filename: file_name_string(source_path),
        current_path: path_string(source_path),
        current_folder: path_string(current_folder),
        expected_folder: path_string(expected_folder),
    })
}

fn accepted_track_destination(track: &OrganizerTrack, source_path: &Path, root: &Path) -> PathBuf {
    let artist = if track.album_artist.trim().is_empty() {
        &track.artist
    } else {
        &track.album_artist
    };
    root.join(sanitize_export_segment(artist, "Unknown Artist"))
        .join(sanitize_export_segment(&track.album, "Unknown Album"))
        .join(safe_source_filename(track, source_path))
}

fn safe_source_filename(track: &OrganizerTrack, source_path: &Path) -> String {
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(&track.title);
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 12
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .map(|value| format!(".{}", value))
        .unwrap_or_default();
    format!(
        "{}{}",
        sanitize_export_segment(stem, "Unknown Track"),
        extension
    )
}

fn sanitize_export_segment(value: &str, fallback: &str) -> String {
    let normalized: String = value.nfc().collect();
    let mut cleaned = String::new();
    let mut previous_whitespace = false;
    for character in normalized.chars() {
        let forbidden = character <= '\u{1f}'
            || character == '\u{7f}'
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            );
        let character = if forbidden { '-' } else { character };
        if character.is_whitespace() {
            if !previous_whitespace {
                cleaned.push(' ');
            }
            previous_whitespace = true;
        } else {
            cleaned.push(character);
            previous_whitespace = false;
        }
    }
    let cleaned = cleaned
        .trim()
        .trim_end_matches([' ', '.'])
        .chars()
        .take(120)
        .collect::<String>();
    let cleaned = cleaned.trim().trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return fallback.to_string();
    }
    let lower = cleaned.to_ascii_lowercase();
    let base = lower.split('.').next().unwrap_or_default();
    let reserved = matches!(base, "con" | "prn" | "aux" | "nul")
        || (base.len() == 4
            && (base.starts_with("com") || base.starts_with("lpt"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        format!("_{}", cleaned)
    } else {
        cleaned
    }
}

fn move_without_overwrite(source: &Path, requested_destination: &Path) -> io::Result<PathBuf> {
    if paths_equal(source, requested_destination) {
        return Ok(absolute_lexical(source));
    }
    let metadata = fs::metadata(source)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Source path is not a file",
        ));
    }
    if let Some(parent) = requested_destination.parent() {
        fs::create_dir_all(parent)?;
    }

    for suffix in 1..10_000 {
        let destination = suffixed_path(requested_destination, suffix);
        match fs::hard_link(source, &destination) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                let mut input = fs::File::open(source)?;
                let mut output = match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&destination)
                {
                    Ok(file) => file,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                };
                if let Err(error) = io::copy(&mut input, &mut output) {
                    let _ = fs::remove_file(&destination);
                    return Err(error);
                }
                let _ = fs::set_permissions(&destination, metadata.permissions());
            }
        }
        if let Err(error) = fs::remove_file(source) {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
        return Ok(destination);
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Could not find an available destination filename",
    ))
}

fn suffixed_path(path: &Path, suffix: usize) -> PathBuf {
    if suffix == 1 {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value))
        .unwrap_or_default();
    path.with_file_name(format!("{} ({}){}", stem, suffix, extension))
}

fn collect_audio_paths(input_paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for path in input_paths {
        collect_audio_path(Path::new(path), &mut files)?;
    }
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

fn load_missing_rows(conn: &Connection) -> Result<Vec<MissingRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, filename, source_path, duration_seconds FROM tracks WHERE is_missing = 1",
        )
        .map_err(|error| error.to_string())?;
    let mapped = statement
        .query_map([], |row| {
            Ok(MissingRow {
                id: row.get(0)?,
                filename: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                source_path: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                duration_seconds: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            })
        })
        .map_err(|error| error.to_string())?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn read_audio_duration(path: &Path) -> Result<f64, String> {
    let tagged = Probe::open(path)
        .map_err(|error| error.to_string())?
        .read()
        .map_err(|error| error.to_string())?;
    Ok(tagged.properties().duration().as_secs_f64())
}

fn clean_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect()
}

fn is_audio_path(path: &Path) -> bool {
    AUDIO_EXTENSIONS.contains(&extension_lowercase(path).as_str())
}

fn extension_lowercase(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    path_key(&absolute_lexical(left)) == path_key(&absolute_lexical(right))
}

fn path_key(path: &Path) -> String {
    let value = path_string(&lexically_normalize(path)).replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn portable_key(value: &str) -> String {
    let value = value.replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn comparable_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let value = component.as_os_str().to_string_lossy().to_string();
            if cfg!(windows) {
                value.to_lowercase()
            } else {
                value
            }
        })
        .collect()
}

fn relative_path(candidate: &Path, root: &Path) -> Option<PathBuf> {
    if !is_path_inside_or_equal(candidate, root) {
        return None;
    }
    let candidate = absolute_lexical(candidate);
    let root = absolute_lexical(root);
    let mut relative = PathBuf::new();
    for component in candidate.components().skip(root.components().count()) {
        relative.push(component.as_os_str());
    }
    Some(relative)
}

fn absolute_lexical(path: &Path) -> PathBuf {
    if path.is_absolute() || is_windows_absolute(&path_string(path)) {
        lexically_normalize(path)
    } else {
        std::env::current_dir()
            .map(|current| lexically_normalize(&current.join(path)))
            .unwrap_or_else(|_| lexically_normalize(path))
    }
}

fn lexically_normalize(path: &Path) -> PathBuf {
    let mut prefix: Option<OsString> = None;
    let mut rooted = false;
    let mut segments: Vec<OsString> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(value) => prefix = Some(value.as_os_str().to_os_string()),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => {
                if segments.last().is_some_and(|value| value != "..") {
                    segments.pop();
                } else if !rooted {
                    segments.push(OsString::from(".."));
                }
            }
            Component::Normal(value) => segments.push(value.to_os_string()),
        }
    }
    let mut normalized = PathBuf::new();
    if let Some(prefix) = prefix {
        normalized.push(prefix);
    }
    if rooted {
        normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR));
    }
    for segment in segments {
        normalized.push(segment);
    }
    normalized
}

fn is_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\'))
        || value.starts_with("\\\\")
        || value.starts_with("//")
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn file_name_string(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_import_extensions_match_scanner_extensions() {
        for extension in ["opus", "aif", "aiff"] {
            assert!(AUDIO_EXTENSIONS.contains(&extension));
            assert!(NATIVE_IMPORT_EXTENSIONS.contains(&extension));
        }
    }

    #[test]
    fn portable_paths_reject_absolute_and_traversal_segments() {
        assert_eq!(
            normalize_portable_track_path("Artist/Album/song.flac"),
            Some("Artist/Album/song.flac".to_string())
        );
        assert_eq!(
            normalize_portable_track_path("Artist\\Album\\song.flac"),
            Some("Artist/Album/song.flac".to_string())
        );
        assert_eq!(normalize_portable_track_path("../outside.mp3"), None);
        assert_eq!(normalize_portable_track_path("Artist//song.mp3"), None);
        assert_eq!(normalize_portable_track_path("C:\\Music\\song.mp3"), None);
        assert_eq!(normalize_portable_track_path("/music/song.mp3"), None);
    }

    #[test]
    fn containment_uses_components_not_string_prefixes() {
        let base = std::env::temp_dir().join("muro-library-root");
        assert!(is_path_inside_or_equal(
            &base.join("Artist/song.mp3"),
            &base
        ));
        assert!(is_path_inside_or_equal(&base, &base));
        assert!(!is_path_inside_or_equal(
            &base
                .with_file_name("muro-library-root-other")
                .join("song.mp3"),
            &base
        ));
        assert!(!is_path_inside_or_equal(
            &base.join("../escape/song.mp3"),
            &base
        ));
    }

    #[test]
    fn stored_paths_round_trip_inside_root() {
        let root = absolute_lexical(&std::env::temp_dir().join("muro-portable-root"));
        let source = root.join("Artist").join("Album").join("song.flac");
        let stored = to_stored_track_path(&source, Some(&root));
        assert_eq!(stored, "Artist/Album/song.flac");
        assert_eq!(
            resolve_stored_track_path(&stored, Some(&root)).unwrap(),
            source
        );
    }

    #[test]
    fn sanitizer_blocks_reserved_names_and_path_separators() {
        assert_eq!(sanitize_export_segment("CON", "Unknown"), "_CON");
        assert_eq!(sanitize_export_segment("A/B:*?", "Unknown"), "A-B---");
        assert_eq!(sanitize_export_segment(" .. ", "Unknown"), "Unknown");
    }

    #[test]
    fn collision_safe_move_never_overwrites_existing_file() {
        let root = std::env::temp_dir().join(format!(
            "muro-library-ops-{}",
            current_timestamp().saturating_mul(1_000_000) + std::process::id() as i64
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("incoming.mp3");
        let destination = root.join("song.mp3");
        fs::write(&source, b"new").unwrap();
        fs::write(&destination, b"existing").unwrap();

        let moved = move_without_overwrite(&source, &destination).unwrap();
        assert_eq!(moved, root.join("song (2).mp3"));
        assert_eq!(fs::read(&destination).unwrap(), b"existing");
        assert_eq!(fs::read(&moved).unwrap(), b"new");
        assert!(!source.exists());

        fs::remove_dir_all(&root).unwrap();
    }
}
