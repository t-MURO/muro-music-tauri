pub mod backfill;
pub mod cover_art;
pub mod import;
pub mod parity;
pub mod search;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{Emitter, Manager, WindowEvent};

const COVERS_DIR: &str = "covers";

#[tauri::command(rename_all = "camelCase")]
fn clear_tracks(app: tauri::AppHandle, db_path: String) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(COVERS_DIR);
    import::clear_tracks(&db_path, &cache_dir)
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
#[tauri::command(rename_all = "camelCase")]
async fn start_file_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    file_paths: Vec<String>,
) -> Result<(), String> {
    parity::desktop::start_file_drag(app, window, file_paths).await
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(parity::watched_folder::WatchedFolderService::new())
        .manage(parity::library_exports::PlaylistSyncService::new())
        .manage(parity::media_protocol::MediaProtocolService::default())
        .setup(move |app| {
            match app.path().app_data_dir() {
                Ok(app_data_dir) => {
                    let report = parity::legacy_migration::migrate_legacy_database_if_needed(
                        &app_data_dir,
                    );
                    match serde_json::to_string(&report) {
                        Ok(report) => eprintln!("[muro][legacy-migration] {report}"),
                        Err(error) => eprintln!(
                            "[muro][legacy-migration] completed, but its report could not be serialized: {error}"
                        ),
                    }
                }
                Err(error) => eprintln!(
                    "[muro][legacy-migration] skipped because app_data_dir could not be resolved: {error}"
                ),
            }

            let native_playback =
                parity::native_playback::NativePlaybackService::new(app.handle().clone())?;
            app.manage(native_playback);
            let remote_output = parity::remote::RemoteOutputService::new(app.handle().clone());
            app.manage(remote_output);
            app.manage(parity::native_analysis::NativeAnalysisService::new(
                app.handle().clone(),
            ));
            let artist_cache = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?
                .join("artists");
            app.manage(parity::artist_profiles::ArtistProfileState::new(
                artist_cache,
            )?);

            let cover_cache = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?
                .join(COVERS_DIR);
            app.manage(parity::metadata_online::MetadataOnlineState::new(
                cover_cache,
            )?);

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
            parity::playlist_files::list_playlist_files,
            parity::playlist_files::import_playlist_file,
            parity::playlist_files::export_playlist_file,
            parity::playlist_files::export_all_playlists,
            parity::library_exports::export_itunes_library,
            parity::library_exports::export_organized_library,
            parity::library_exports::configure_playlist_sync,
            parity::library_exports::sync_playlist_source,
            parity::commands::rebuild_search_index,
            parity::database::search_tracks,
            parity::database::migrate_artist_credits,
            parity::database::merge_artists,
            parity::native_playback::playback_play_file,
            parity::native_playback::playback_preload_next,
            parity::native_playback::playback_clear_preload,
            parity::native_playback::playback_set_gapless,
            parity::native_playback::playback_set_crossfade,
            parity::native_playback::playback_set_track_gain,
            parity::native_playback::playback_toggle,
            parity::native_playback::playback_play,
            parity::native_playback::playback_pause,
            parity::native_playback::playback_stop,
            parity::native_playback::playback_seek,
            parity::native_playback::playback_set_volume,
            parity::native_playback::playback_set_seek_mode,
            parity::native_playback::playback_set_output_device,
            parity::native_playback::playback_get_output_device,
            parity::native_playback::playback_list_output_devices,
            parity::native_playback::playback_get_state,
            parity::native_playback::playback_is_finished,
            parity::native_playback::playback_transition_to,
            parity::native_playback::playback_cancel_transition,
            parity::remote::cast_start_discovery,
            parity::remote::cast_stop_discovery,
            parity::remote::cast_get_devices,
            parity::remote::cast_connect,
            parity::remote::cast_disconnect,
            parity::remote::cast_load_track,
            parity::remote::cast_play,
            parity::remote::cast_pause,
            parity::remote::cast_seek,
            parity::remote::cast_set_volume,
            parity::remote::cast_get_state,
            parity::remote::dlna_start_discovery,
            parity::remote::dlna_stop_discovery,
            parity::remote::dlna_get_devices,
            parity::remote::dlna_connect,
            parity::remote::dlna_disconnect,
            parity::remote::dlna_load_track,
            parity::remote::dlna_play,
            parity::remote::dlna_pause,
            parity::remote::dlna_seek,
            parity::remote::dlna_set_volume,
            parity::remote::dlna_get_state,
            get_track_source_path,
            update_track_analysis,
            parity::metadata_write::update_track_metadata,
            cache_cover_art_from_file,
            parity::history_stats::record_track_play,
            parity::history_stats::update_play_history,
            parity::history_stats::load_listening_statistics,
            parity::metadata_core::update_track_beat_grid,
            parity::metadata_core::scan_technical_metadata,
            parity::metadata_core::list_tracks_needing_loudness,
            parity::metadata_core::update_track_loudness,
            parity::metadata_core::recompute_album_gain,
            parity::metadata_core::list_metadata_history,
            parity::metadata_write::rollback_metadata_change,
            clipboard_has_image,
            cache_clipboard_cover_art,
            copy_image_to_clipboard,
            open_external,
            show_item_in_folder,
            start_file_drag,
            parity::watched_folder::set_watched_folder,
            parity::watched_folder::scan_watched_folder,
            parity::watched_folder::watched_folder_status,
            parity::metadata_online::search_track_metadata,
            parity::metadata_online::search_album_metadata,
            parity::metadata_online::load_album_metadata,
            parity::metadata_online::fetch_track_cover_art,
            parity::metadata_online::search_album_cover_images,
            parity::metadata_online::cache_album_cover_candidate,
            parity::backup::create_library_backup,
            parity::backup::restore_library_backup,
            parity::native_analysis::keyfinder_health,
            parity::native_analysis::start_track_analysis,
            parity::native_analysis::cancel_track_analysis,
            parity::native_analysis::recycle_keyfinder,
            parity::native_analysis::identify_track_acoustid,
            parity::waveform::generate_track_waveform,
            parity::media_protocol::authorize_local_media,
            parity::media_protocol::revoke_local_media,
            parity::artist_profiles::load_cached_artist_profiles,
            parity::artist_profiles::get_artist_profile,
            parity::artist_profiles::search_artist_images,
            parity::artist_profiles::set_artist_image,
            parity::artist_profiles::scan_artist_profiles
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app_handle
                    .state::<parity::native_playback::NativePlaybackService>()
                    .shutdown();
                app_handle
                    .state::<parity::remote::RemoteOutputService>()
                    .shutdown();
            }
        });
}
