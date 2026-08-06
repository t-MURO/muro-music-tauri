use super::{library_ops, playlists};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command(rename_all = "camelCase")]
pub async fn import_files(
    app: AppHandle,
    paths: Vec<String>,
    db_path: String,
    library_folder: Option<String>,
) -> Result<library_ops::ImportFilesResult, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("covers");
    tauri::async_runtime::spawn_blocking(move || {
        library_ops::import_files_with_progress(
            paths,
            &db_path,
            &cache_dir,
            library_folder.as_deref(),
            move |progress| {
                let _ = app.emit("muro://import-progress", progress);
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn accept_tracks(
    db_path: String,
    track_ids: Vec<String>,
    organize: Option<bool>,
    library_folder: Option<String>,
) -> Result<library_ops::AcceptTracksResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library_ops::accept_tracks(
            &db_path,
            track_ids,
            organize.unwrap_or(false),
            library_folder.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub fn unaccept_tracks(db_path: String, track_ids: Vec<String>) -> Result<usize, String> {
    library_ops::unaccept_tracks(&db_path, track_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn reject_tracks(db_path: String, track_ids: Vec<String>) -> Result<usize, String> {
    library_ops::reject_tracks(&db_path, track_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_tracks(
    db_path: String,
    track_ids: Vec<String>,
    delete_from_disk: bool,
) -> Result<library_ops::DeleteTracksResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library_ops::delete_tracks(&db_path, track_ids, delete_from_disk)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn validate_library_structure(
    db_path: String,
    library_root: Option<String>,
) -> Result<library_ops::ValidateStructureResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library_ops::validate_library_structure(&db_path, library_root.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn repair_library_structure(
    db_path: String,
    library_root: Option<String>,
    track_ids: Vec<String>,
) -> Result<library_ops::RepairStructureResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library_ops::repair_library_structure(&db_path, library_root.as_deref(), track_ids)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn verify_library_files(
    db_path: String,
) -> Result<library_ops::VerifyLibraryResult, String> {
    tauri::async_runtime::spawn_blocking(move || library_ops::verify_library_files(&db_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_missing_tracks(db_path: String) -> Result<Vec<library_ops::MissingTrack>, String> {
    library_ops::list_missing_tracks(&db_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn relink_track(
    db_path: String,
    track_id: String,
    new_path: String,
) -> Result<library_ops::RelinkTrackResult, String> {
    library_ops::relink_track(&db_path, &track_id, &new_path)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auto_relink_missing(
    db_path: String,
    search_dir: String,
    dry_run: bool,
) -> Result<library_ops::AutoRelinkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library_ops::auto_relink_missing(&db_path, &search_dir, dry_run)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_playlists(
    db_path: String,
    library_root: Option<String>,
) -> Result<playlists::PlaylistCollection, String> {
    let _ = library_root;
    playlists::load_playlists(&db_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_playlist(
    db_path: String,
    id: String,
    name: String,
    folder_id: Option<String>,
    sort_order: Option<i64>,
    source_path: Option<String>,
) -> Result<(), String> {
    playlists::create_playlist(
        &db_path,
        &id,
        &name,
        folder_id.as_deref(),
        sort_order,
        source_path.as_deref(),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_playlist(
    db_path: String,
    playlist_id: String,
    name: Option<String>,
    folder_id: Option<String>,
    sort_order: Option<i64>,
) -> Result<(), String> {
    playlists::update_playlist(
        &db_path,
        &playlist_id,
        name.as_deref(),
        folder_id.as_ref().map(|value| Some(value.as_str())),
        sort_order,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn reorder_playlists(
    db_path: String,
    items: Vec<playlists::PlaylistOrderItem>,
) -> Result<(), String> {
    playlists::reorder_playlists(&db_path, items)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_playlist(
    db_path: String,
    playlist_id: String,
) -> Result<playlists::CountResult, String> {
    playlists::delete_playlist(&db_path, &playlist_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_playlists(
    db_path: String,
    playlist_ids: Vec<String>,
) -> Result<playlists::CountResult, String> {
    playlists::delete_playlists(&db_path, playlist_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_playlists(
    db_path: String,
    playlists: Vec<playlists::PlaylistStateItem>,
) -> Result<playlists::RestoreResult, String> {
    playlists::restore_playlists(&db_path, playlists)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_playlist_folder(
    db_path: String,
    id: String,
    name: String,
    parent_id: Option<String>,
    sort_order: Option<i64>,
) -> Result<(), String> {
    playlists::create_playlist_folder(&db_path, &id, &name, parent_id.as_deref(), sort_order)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_playlist_folder(
    db_path: String,
    folder_id: String,
    name: Option<String>,
    parent_id: Option<String>,
    sort_order: Option<i64>,
) -> Result<(), String> {
    playlists::update_playlist_folder(
        &db_path,
        &folder_id,
        name.as_deref(),
        parent_id.as_ref().map(|value| Some(value.as_str())),
        sort_order,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_playlist_folder(
    db_path: String,
    folder_id: String,
) -> Result<playlists::CountResult, String> {
    playlists::delete_playlist_folder(&db_path, &folder_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn add_tracks_to_playlist(
    db_path: String,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<(), String> {
    playlists::add_tracks_to_playlist(&db_path, &playlist_id, track_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_playlist_tracks(
    db_path: String,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<(), String> {
    playlists::set_playlist_tracks(&db_path, &playlist_id, track_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn remove_last_tracks_from_playlist(
    db_path: String,
    playlist_id: String,
    count: i64,
) -> Result<playlists::CountResult, String> {
    playlists::remove_last_tracks_from_playlist(&db_path, &playlist_id, count)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_playlist_history(
    db_path: String,
    limit: Option<i64>,
) -> Result<playlists::HistoryList, String> {
    playlists::list_playlist_history(&db_path, limit)
}

#[tauri::command(rename_all = "camelCase")]
pub fn undo_playlist_history(db_path: String) -> Result<Option<playlists::HistoryRestore>, String> {
    playlists::undo_playlist_history(&db_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn redo_playlist_history(db_path: String) -> Result<Option<playlists::HistoryRestore>, String> {
    playlists::redo_playlist_history(&db_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_playlist_snapshot(
    db_path: String,
    name: String,
) -> Result<playlists::PlaylistSnapshot, String> {
    playlists::create_playlist_snapshot(&db_path, &name)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_playlist_snapshots(
    db_path: String,
) -> Result<Vec<playlists::PlaylistSnapshot>, String> {
    playlists::list_playlist_snapshots(&db_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_playlist_snapshot(
    db_path: String,
    snapshot_id: String,
) -> Result<playlists::PlaylistState, String> {
    playlists::restore_playlist_snapshot(&db_path, &snapshot_id)
}

#[derive(Serialize)]
pub struct DeletedFlag {
    deleted: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_playlist_snapshot(
    db_path: String,
    snapshot_id: String,
) -> Result<DeletedFlag, String> {
    playlists::delete_playlist_snapshot(&db_path, &snapshot_id).map(|result| DeletedFlag {
        deleted: result.deleted > 0,
    })
}
#[tauri::command(rename_all = "camelCase")]
pub fn backfill_search_text(db_path: String) -> Result<usize, String> {
    super::database::backfill_search(db_path, Some(true))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuiltFlag {
    rebuilt: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub fn rebuild_search_index(db_path: String) -> Result<RebuiltFlag, String> {
    super::database::rebuild_search(db_path)?;
    Ok(RebuiltFlag { rebuilt: true })
}
