//! Native playback-history persistence and listening statistics.
//!
//! The command and response shapes intentionally match the Electron backend so
//! the current renderer can use this module without an adapter.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::database::ensure_schema;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordedPlay {
    pub history_id: i64,
    pub played_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlayHistoryUpdate {
    pub updated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningRank {
    pub name: String,
    pub plays: i64,
    pub listening_seconds: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyListening {
    pub month: String,
    pub plays: i64,
    pub listening_seconds: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeglectedTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub last_played_at: Option<String>,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningStatistics {
    pub listening_seconds: f64,
    pub plays: i64,
    pub unique_tracks: i64,
    pub discovery_rate: f64,
    pub top_artists: Vec<ListeningRank>,
    pub top_albums: Vec<ListeningRank>,
    pub monthly: Vec<MonthlyListening>,
    pub neglected_tracks: Vec<NeglectedTrack>,
}

struct TrackPlaySnapshot {
    duration_seconds: Option<f64>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    added_at: Option<i64>,
}

#[derive(Debug)]
struct MonthlyRow {
    plays: i64,
    listening_seconds: f64,
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
    ensure_schema(&conn)?;
    Ok(conn)
}

fn current_iso_timestamp() -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let millis = i64::try_from(millis).map_err(|_| "System time is out of range".to_string())?;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .map(|timestamp| timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| "System time is out of range".to_string())
}

fn text_or(value: Option<String>, fallback: &str) -> String {
    value
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn record_track_play_at(
    conn: &mut Connection,
    track_id: &str,
    played_at: String,
) -> Result<RecordedPlay, String> {
    let transaction = conn.transaction().map_err(db_error)?;
    let track = transaction
        .query_row(
            r#"
SELECT duration_seconds, title, artist, album, added_at
FROM tracks
WHERE id = ?1
"#,
            [track_id],
            |row| {
                Ok(TrackPlaySnapshot {
                    duration_seconds: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    album: row.get(3)?,
                    added_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Track was not found".to_string())?;

    transaction
        .execute(
            r#"
UPDATE tracks
SET last_played_at = ?1, play_count = COALESCE(play_count, 0) + 1
WHERE id = ?2
"#,
            params![played_at, track_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            r#"
INSERT INTO play_history(
  track_id, played_at, listened_seconds, duration_seconds,
  title, artist, album, track_added_at
) VALUES (?1, ?2, 30, ?3, ?4, ?5, ?6, ?7)
"#,
            params![
                track_id,
                played_at,
                track.duration_seconds,
                text_or(track.title, "Unknown Title"),
                text_or(track.artist, "Unknown Artist"),
                text_or(track.album, "Unknown Album"),
                track.added_at,
            ],
        )
        .map_err(db_error)?;
    let history_id = transaction.last_insert_rowid();
    transaction.commit().map_err(db_error)?;

    Ok(RecordedPlay {
        history_id,
        played_at,
    })
}

/// Record a play once the renderer's 30-second threshold is reached.
#[tauri::command(rename_all = "camelCase")]
pub fn record_track_play(db_path: String, track_id: String) -> Result<RecordedPlay, String> {
    let mut conn = open_database(&db_path)?;
    let played_at = current_iso_timestamp()?;
    record_track_play_at(&mut conn, &track_id, played_at)
}

/// Replace the detailed listening duration for an existing history row.
#[tauri::command(rename_all = "camelCase")]
pub fn update_play_history(
    db_path: String,
    history_id: i64,
    listened_seconds: f64,
) -> Result<PlayHistoryUpdate, String> {
    let conn = open_database(&db_path)?;
    let value = if listened_seconds.is_finite() {
        listened_seconds.clamp(0.0, 86_400.0)
    } else {
        0.0
    };
    let changed = conn
        .execute(
            "UPDATE play_history SET listened_seconds = ?1 WHERE id = ?2",
            params![value, history_id],
        )
        .map_err(db_error)?;
    Ok(PlayHistoryUpdate {
        updated: changed > 0,
    })
}

fn load_ranking(conn: &Connection, field: &str) -> Result<Vec<ListeningRank>, String> {
    debug_assert!(matches!(field, "artist" | "album"));
    let sql = format!(
        r#"
SELECT {field} AS name, COUNT(*) AS plays,
       COALESCE(SUM(listened_seconds), 0) AS listening_seconds
FROM play_history
GROUP BY {field}
ORDER BY listening_seconds DESC, plays DESC, name COLLATE NOCASE
LIMIT 10
"#
    );
    let mut statement = conn.prepare(&sql).map_err(db_error)?;
    let mapped = statement
        .query_map([], |row| {
            Ok(ListeningRank {
                name: row.get(0)?,
                plays: row.get(1)?,
                listening_seconds: row.get(2)?,
            })
        })
        .map_err(db_error)?;
    mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn load_monthly(conn: &Connection) -> Result<Vec<MonthlyListening>, String> {
    let mut statement = conn
        .prepare(
            r#"
SELECT strftime('%Y-%m', played_at) AS month,
       COUNT(*) AS plays,
       COALESCE(SUM(listened_seconds), 0) AS listening_seconds
FROM play_history
WHERE played_at >= datetime('now', '-11 months', 'start of month')
GROUP BY month
"#,
        )
        .map_err(db_error)?;
    let mapped = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                MonthlyRow {
                    plays: row.get(1)?,
                    listening_seconds: row.get(2)?,
                },
            ))
        })
        .map_err(db_error)?;
    let rows = mapped
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(db_error)?;

    let mut monthly = Vec::with_capacity(12);
    let mut month_statement = conn
        .prepare("SELECT strftime('%Y-%m', 'now', ?1, 'start of month')")
        .map_err(db_error)?;
    for offset in (0..=11).rev() {
        let modifier = if offset == 0 {
            "0 months".to_string()
        } else {
            format!("-{offset} months")
        };
        let month: String = month_statement
            .query_row([modifier], |row| row.get(0))
            .map_err(db_error)?;
        let row = rows.get(&month);
        monthly.push(MonthlyListening {
            month,
            plays: row.map_or(0, |item| item.plays),
            listening_seconds: row.map_or(0.0, |item| item.listening_seconds),
        });
    }
    Ok(monthly)
}

fn load_neglected_tracks(conn: &Connection) -> Result<Vec<NeglectedTrack>, String> {
    let mut statement = conn
        .prepare(
            r#"
SELECT id, title, artist, album, last_played_at, play_count
FROM tracks
WHERE import_status = 'accepted'
  AND (last_played_at IS NULL OR last_played_at < datetime('now', '-180 days'))
ORDER BY CASE WHEN last_played_at IS NULL THEN 0 ELSE 1 END,
         last_played_at ASC, added_at ASC
LIMIT 50
"#,
        )
        .map_err(db_error)?;
    let mapped = statement
        .query_map([], |row| {
            Ok(NeglectedTrack {
                id: row.get::<_, String>(0)?,
                title: text_or(row.get(1)?, "Unknown Title"),
                artist: text_or(row.get(2)?, "Unknown Artist"),
                album: text_or(row.get(3)?, "Unknown Album"),
                last_played_at: row.get(4)?,
                play_count: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            })
        })
        .map_err(db_error)?;
    mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

/// Aggregate all-time, ranking, monthly, discovery, and neglected-track data.
#[tauri::command(rename_all = "camelCase")]
pub fn load_listening_statistics(db_path: String) -> Result<ListeningStatistics, String> {
    let conn = open_database(&db_path)?;
    let (listening_seconds, plays, unique_tracks, discovery_plays): (f64, i64, i64, i64) =
        conn.query_row(
            r#"
SELECT COALESCE(SUM(listened_seconds), 0) AS listening_seconds,
       COUNT(*) AS plays,
       COUNT(DISTINCT track_id) AS unique_tracks,
       COALESCE(SUM(
         CASE WHEN track_added_at IS NOT NULL
           AND julianday(played_at) - julianday(datetime(track_added_at, 'unixepoch')) BETWEEN 0 AND 30
         THEN 1 ELSE 0 END
       ), 0) AS discovery_plays
FROM play_history
"#,
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(db_error)?;

    Ok(ListeningStatistics {
        listening_seconds,
        plays,
        unique_tracks,
        discovery_rate: if plays > 0 {
            discovery_plays as f64 / plays as f64 * 100.0
        } else {
            0.0
        },
        top_artists: load_ranking(&conn, "artist")?,
        top_albums: load_ranking(&conn, "album")?,
        monthly: load_monthly(&conn)?,
        neglected_tracks: load_neglected_tracks(&conn)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct TestDatabase {
        path: PathBuf,
    }

    impl TestDatabase {
        fn new() -> Self {
            Self {
                path: std::env::temp_dir()
                    .join(format!("muro-history-stats-{}.db", Uuid::new_v4())),
            }
        }

        fn path(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_file(self.path.with_extension("db-wal"));
            let _ = fs::remove_file(self.path.with_extension("db-shm"));
        }
    }

    fn insert_track(
        conn: &Connection,
        id: &str,
        status: &str,
        added_at: i64,
    ) -> Result<(), String> {
        conn.execute(
            r#"
INSERT INTO tracks(
  id, title, artist, album, source_path, import_status,
  duration_seconds, added_at, play_count
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 240, ?7, 0)
"#,
            params![
                id,
                format!("Title {id}"),
                "Test Artist",
                "Test Album",
                format!("{id}.flac"),
                status,
                added_at,
            ],
        )
        .map_err(db_error)?;
        Ok(())
    }

    #[test]
    fn records_updates_and_aggregates_electron_compatible_history() -> Result<(), String> {
        let database = TestDatabase::new();
        let mut conn = open_database(&database.path())?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs() as i64;
        insert_track(&conn, "played", "accepted", now)?;
        insert_track(&conn, "neglected", "accepted", now - 200 * 86_400)?;
        insert_track(&conn, "inbox", "staged", now - 200 * 86_400)?;

        let played_at = chrono::DateTime::<chrono::Utc>::from_timestamp(now, 0)
            .ok_or_else(|| "test timestamp is out of range".to_string())?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let recorded = record_track_play_at(&mut conn, "played", played_at.clone())?;
        assert_eq!(recorded.history_id, 1);
        assert_eq!(recorded.played_at, played_at);

        let (last_played_at, play_count): (String, i64) = conn
            .query_row(
                "SELECT last_played_at, play_count FROM tracks WHERE id = 'played'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        assert_eq!(last_played_at, played_at);
        assert_eq!(play_count, 1);
        let initial_seconds: f64 = conn
            .query_row(
                "SELECT listened_seconds FROM play_history WHERE id = ?1",
                [recorded.history_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        assert_eq!(initial_seconds, 30.0);
        drop(conn);

        let updated = update_play_history(database.path(), recorded.history_id, 125.0)?;
        assert!(updated.updated);
        let statistics = load_listening_statistics(database.path())?;
        assert_eq!(statistics.listening_seconds, 125.0);
        assert_eq!(statistics.plays, 1);
        assert_eq!(statistics.unique_tracks, 1);
        assert_eq!(statistics.discovery_rate, 100.0);
        assert_eq!(statistics.top_artists[0].name, "Test Artist");
        assert_eq!(statistics.top_artists[0].listening_seconds, 125.0);
        assert_eq!(statistics.top_albums[0].name, "Test Album");
        assert_eq!(statistics.monthly.len(), 12);
        assert_eq!(
            statistics
                .monthly
                .iter()
                .map(|month| month.plays)
                .sum::<i64>(),
            1
        );
        assert_eq!(statistics.neglected_tracks.len(), 1);
        assert_eq!(statistics.neglected_tracks[0].id, "neglected");

        let json = serde_json::to_value(&statistics).map_err(|error| error.to_string())?;
        assert!(json.get("listeningSeconds").is_some());
        assert!(json.get("uniqueTracks").is_some());
        assert!(json.get("discoveryRate").is_some());
        assert!(json.get("topArtists").is_some());
        assert!(json.get("neglectedTracks").is_some());
        Ok(())
    }

    #[test]
    fn rejects_unknown_tracks_and_clamps_history_updates() -> Result<(), String> {
        let database = TestDatabase::new();
        let mut conn = open_database(&database.path())?;
        let error =
            record_track_play_at(&mut conn, "missing", "2026-01-01T00:00:00.000Z".to_string())
                .expect_err("an unknown track must fail");
        assert_eq!(error, "Track was not found");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM play_history", [], |row| row.get(0))
            .map_err(db_error)?;
        assert_eq!(count, 0);

        insert_track(&conn, "played", "accepted", 1_735_689_600)?;
        let recorded =
            record_track_play_at(&mut conn, "played", "2026-01-01T00:00:00.000Z".to_string())?;
        drop(conn);
        assert!(update_play_history(database.path(), recorded.history_id, 100_000.0)?.updated);
        let conn = open_database(&database.path())?;
        let seconds: f64 = conn
            .query_row(
                "SELECT listened_seconds FROM play_history WHERE id = ?1",
                [recorded.history_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        assert_eq!(seconds, 86_400.0);
        assert!(!update_play_history(database.path(), 999_999, 10.0)?.updated);
        Ok(())
    }
}
