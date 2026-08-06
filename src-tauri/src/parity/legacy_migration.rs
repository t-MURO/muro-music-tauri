use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

const DATABASE_FILENAME: &str = "muro.db";
const ELECTRON_APP_NAMES: [&str; 2] = ["Muro Music", "muro-music-electron"];

/// Result of checking for and, when safe, migrating the Electron database.
///
/// Electron/WebView `localStorage` preferences are intentionally not migrated: this
/// operation only copies the default SQLite library database.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    pub status: LegacyMigrationStatus,
    pub destination_path: String,
    pub source_path: Option<String>,
    pub candidates_checked: usize,
    pub invalid_candidates: usize,
    pub local_storage_migrated: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LegacyMigrationStatus {
    Migrated,
    DestinationAlreadyExists,
    NoLegacyDatabase,
    NoValidLegacyDatabase,
    Failed,
}

#[derive(Debug)]
struct CandidateSelection {
    selected: Option<PathBuf>,
    existing: usize,
    invalid: usize,
}

/// Performs the one-time default database migration suitable for calling from Tauri setup.
///
/// The destination is always `app_data_dir/muro.db`. If it already exists, it is never
/// opened or modified. Valid Electron databases are copied with SQLite's online backup API,
/// so a source using WAL mode is migrated as a consistent snapshot.
pub fn migrate_legacy_database_if_needed(app_data_dir: &Path) -> LegacyMigrationReport {
    migrate_from_candidates(app_data_dir, discover_legacy_database_candidates())
}

/// Returns plausible default Electron `userData` database locations for this application.
pub fn discover_legacy_database_candidates() -> Vec<PathBuf> {
    let mut bases = Vec::new();

    #[cfg(target_os = "windows")]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        bases.push(PathBuf::from(app_data));
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        bases.push(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support"),
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
            bases.push(PathBuf::from(config_home));
        } else if let Some(home) = std::env::var_os("HOME") {
            bases.push(PathBuf::from(home).join(".config"));
        }
    }

    candidate_paths_for_bases(bases)
}

fn candidate_paths_for_bases<I>(bases: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut seen = HashSet::<OsString>::new();
    let mut candidates = Vec::new();
    for base in bases {
        for app_name in ELECTRON_APP_NAMES {
            let candidate = base.join(app_name).join(DATABASE_FILENAME);
            let key = candidate.as_os_str().to_os_string();
            if seen.insert(key) {
                candidates.push(candidate);
            }
        }
    }
    candidates
}

fn migrate_from_candidates(app_data_dir: &Path, candidates: Vec<PathBuf>) -> LegacyMigrationReport {
    let destination = app_data_dir.join(DATABASE_FILENAME);
    if destination.exists() {
        return report(
            LegacyMigrationStatus::DestinationAlreadyExists,
            &destination,
            None,
            0,
            0,
            "The Tauri database already exists; legacy migration was skipped.",
        );
    }

    let selection = select_newest_valid_candidate(&candidates);
    let Some(source) = selection.selected else {
        let (status, message) = if selection.existing == 0 {
            (
                LegacyMigrationStatus::NoLegacyDatabase,
                "No default Electron database was found. WebView localStorage settings are not migrated.",
            )
        } else {
            (
                LegacyMigrationStatus::NoValidLegacyDatabase,
                "Electron database candidates were found, but none contained both tracks and playlists tables. WebView localStorage settings are not migrated.",
            )
        };
        return report(
            status,
            &destination,
            None,
            selection.existing,
            selection.invalid,
            message,
        );
    };

    if let Err(error) = std::fs::create_dir_all(app_data_dir) {
        return report(
            LegacyMigrationStatus::Failed,
            &destination,
            Some(&source),
            selection.existing,
            selection.invalid,
            &format!("Could not create the Tauri application data directory: {error}"),
        );
    }

    // Reserve the exact destination path atomically. This closes the race between the
    // initial existence check and opening SQLite, and guarantees that no existing DB is
    // ever overwritten.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
    {
        Ok(file) => drop(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return report(
                LegacyMigrationStatus::DestinationAlreadyExists,
                &destination,
                None,
                selection.existing,
                selection.invalid,
                "The Tauri database appeared while migration was starting; it was not modified.",
            );
        }
        Err(error) => {
            return report(
                LegacyMigrationStatus::Failed,
                &destination,
                Some(&source),
                selection.existing,
                selection.invalid,
                &format!("Could not reserve the Tauri database path: {error}"),
            );
        }
    }

    match backup_database(&source, &destination) {
        Ok(()) => report(
            LegacyMigrationStatus::Migrated,
            &destination,
            Some(&source),
            selection.existing,
            selection.invalid,
            "Migrated the Electron SQLite library. WebView localStorage settings were not migrated.",
        ),
        Err(error) => {
            cleanup_partial_destination(&destination);
            report(
                LegacyMigrationStatus::Failed,
                &destination,
                Some(&source),
                selection.existing,
                selection.invalid,
                &format!("Could not migrate the Electron database: {error}"),
            )
        }
    }
}

fn select_newest_valid_candidate(candidates: &[PathBuf]) -> CandidateSelection {
    let mut existing = 0;
    let mut invalid = 0;
    let mut valid = Vec::new();

    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        existing += 1;
        if validate_legacy_database(candidate).is_err() {
            invalid += 1;
            continue;
        }
        let modified = candidate
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        valid.push((modified, candidate.clone()));
    }

    valid.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    CandidateSelection {
        selected: valid.pop().map(|(_, path)| path),
        existing,
        invalid,
    }
}

fn validate_legacy_database(path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='table' AND name IN ('tracks','playlists')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if table_count != 2 {
        return Err("required tracks and playlists tables were not found".to_string());
    }
    let quick_check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !quick_check.eq_ignore_ascii_case("ok") {
        return Err(format!("SQLite quick_check failed: {quick_check}"));
    }
    Ok(())
}

fn backup_database(source_path: &Path, destination_path: &Path) -> Result<(), String> {
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let mut destination = Connection::open(destination_path).map_err(|error| error.to_string())?;
    {
        let backup = Backup::new(&source, &mut destination).map_err(|error| error.to_string())?;
        backup
            .run_to_completion(128, Duration::from_millis(10), None)
            .map_err(|error| error.to_string())?;
    }
    validate_legacy_connection(&destination)
}

fn validate_legacy_connection(connection: &Connection) -> Result<(), String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='table' AND name IN ('tracks','playlists')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    (count == 2)
        .then_some(())
        .ok_or_else(|| "backup is missing required tables".to_string())
}

fn cleanup_partial_destination(destination: &Path) {
    let _ = std::fs::remove_file(destination);
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = destination.as_os_str().to_os_string();
        sidecar.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(sidecar));
    }
}

fn report(
    status: LegacyMigrationStatus,
    destination: &Path,
    source: Option<&Path>,
    candidates_checked: usize,
    invalid_candidates: usize,
    message: &str,
) -> LegacyMigrationReport {
    LegacyMigrationReport {
        status,
        destination_path: destination.to_string_lossy().into_owned(),
        source_path: source.map(|path| path.to_string_lossy().into_owned()),
        candidates_checked,
        invalid_candidates,
        local_storage_migrated: false,
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = format!(
                "muro-legacy-migration-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn create_database(path: &Path, marker: &str, include_playlists: bool) -> Connection {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE tracks(id TEXT PRIMARY KEY,title TEXT NOT NULL);",
            )
            .unwrap();
        if include_playlists {
            connection
                .execute_batch("CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL);")
                .unwrap();
        }
        connection
            .execute("INSERT INTO tracks(id,title) VALUES('track',?1)", [marker])
            .unwrap();
        if include_playlists {
            connection
                .execute(
                    "INSERT INTO playlists(id,name) VALUES('playlist',?1)",
                    [marker],
                )
                .unwrap();
        }
        connection
    }

    #[test]
    fn candidate_helper_includes_product_and_package_names_once() {
        let root = PathBuf::from("config-root");
        let paths = candidate_paths_for_bases(vec![root.clone(), root.clone()]);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0], root.join("Muro Music").join("muro.db"));
        assert_eq!(paths[1], root.join("muro-music-electron").join("muro.db"));
    }

    #[test]
    fn schema_validation_requires_tracks_and_playlists() {
        let root = TestDirectory::new();
        let invalid = root.0.join("invalid.db");
        let connection = create_database(&invalid, "invalid", false);
        drop(connection);
        assert!(validate_legacy_database(&invalid).is_err());

        let valid = root.0.join("valid.db");
        let connection = create_database(&valid, "valid", true);
        drop(connection);
        assert!(validate_legacy_database(&valid).is_ok());
    }

    #[test]
    fn existing_destination_is_never_overwritten() {
        let root = TestDirectory::new();
        let source = root.0.join("electron").join("muro.db");
        let source_connection = create_database(&source, "source", true);
        let app_data = root.0.join("tauri");
        std::fs::create_dir_all(&app_data).unwrap();
        let destination = app_data.join("muro.db");
        std::fs::write(&destination, b"existing-tauri-data").unwrap();

        let result = migrate_from_candidates(&app_data, vec![source]);
        assert_eq!(
            result.status,
            LegacyMigrationStatus::DestinationAlreadyExists
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing-tauri-data");
        drop(source_connection);
    }

    #[test]
    fn backup_preserves_wal_visible_data_and_source() {
        let root = TestDirectory::new();
        let source = root.0.join("electron").join("muro.db");
        // Keep this connection open so the committed records remain WAL-visible while the
        // migration opens its own read-only source connection.
        let source_connection = create_database(&source, "from-electron", true);
        let app_data = root.0.join("tauri");

        let result = migrate_from_candidates(&app_data, vec![source.clone()]);
        assert_eq!(result.status, LegacyMigrationStatus::Migrated);
        assert_eq!(result.source_path.as_deref(), source.to_str());
        assert!(!result.local_storage_migrated);

        let destination = Connection::open(app_data.join("muro.db")).unwrap();
        let copied: (String, String) = destination
            .query_row(
                "SELECT t.title,p.name FROM tracks t CROSS JOIN playlists p",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(copied, ("from-electron".into(), "from-electron".into()));
        let original: String = source_connection
            .query_row("SELECT title FROM tracks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(original, "from-electron");
    }

    #[test]
    fn newest_valid_candidate_wins_and_invalid_newer_candidate_is_ignored() {
        let root = TestDirectory::new();
        let older = root.0.join("older").join("muro.db");
        let connection = create_database(&older, "older", true);
        drop(connection);
        std::thread::sleep(Duration::from_millis(25));
        let newer = root.0.join("newer").join("muro.db");
        let connection = create_database(&newer, "newer", true);
        drop(connection);
        std::thread::sleep(Duration::from_millis(25));
        let invalid = root.0.join("invalid").join("muro.db");
        let connection = create_database(&invalid, "invalid", false);
        drop(connection);

        let app_data = root.0.join("tauri");
        let result = migrate_from_candidates(&app_data, vec![older, invalid, newer.clone()]);
        assert_eq!(result.status, LegacyMigrationStatus::Migrated);
        assert_eq!(result.source_path.as_deref(), newer.to_str());
        assert_eq!(result.invalid_candidates, 1);
        let destination = Connection::open(app_data.join("muro.db")).unwrap();
        let title: String = destination
            .query_row("SELECT title FROM tracks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "newer");
    }
}
