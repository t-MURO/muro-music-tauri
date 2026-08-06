//! Rust-native artist profile enrichment and image selection.
//!
//! Provider credentials are accepted per command and are never stored. Remote
//! JSON and image requests use HTTPS allowlists, bounded bodies, short timeouts,
//! and final-URL validation after redirects.

use reqwest::{Client, StatusCode, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::{sleep_until, Instant};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const PROFILE_VERSION: i64 = 2;
const CACHE_TTL: i64 = 30 * 24 * 60 * 60;
const NOT_FOUND_TTL: i64 = 7 * 24 * 60 * 60;
const SCAN_BACKOFF: i64 = 30 * 60;
const MUSICBRAINZ_INTERVAL: Duration = Duration::from_millis(1_100);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const USER_AGENT: &str = "MuroMusic/0.1.2 (https://github.com/t-MURO/muro-music-electron)";

pub struct ArtistProfileState {
    client: Client,
    cache_dir: PathBuf,
    next_musicbrainz_request: Mutex<Instant>,
    scan_retry_after: Mutex<HashMap<String, i64>>,
    scan_lock: Mutex<()>,
}

impl ArtistProfileState {
    pub fn new(cache_dir: PathBuf) -> Result<Self, String> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            cache_dir,
            next_musicbrainz_request: Mutex::new(Instant::now()),
            scan_retry_after: Mutex::new(HashMap::new()),
            scan_lock: Mutex::new(()),
        })
    }

    async fn json(
        &self,
        url: Url,
        allowed: fn(&Url) -> bool,
        context: &str,
    ) -> Result<Value, String> {
        if !allowed(&url) {
            return Err(format!("{context} URL is not allowed"));
        }
        let response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| format!("{context} request failed"))?;
        if !allowed(response.url()) {
            return Err(format!("{context} redirect is not allowed"));
        }
        if !response.status().is_success() {
            return Err(format!(
                "{context} request failed ({})",
                response.status().as_u16()
            ));
        }
        bounded_json(response, context).await
    }

    async fn musicbrainz_json(&self, url: Url) -> Result<Value, String> {
        let mut next = self.next_musicbrainz_request.lock().await;
        if *next > Instant::now() {
            sleep_until(*next).await;
        }
        *next = Instant::now() + MUSICBRAINZ_INTERVAL;
        drop(next);
        self.json(url, is_musicbrainz, "MusicBrainz").await
    }

    async fn keyed_json(
        &self,
        url: Url,
        allowed: fn(&Url) -> bool,
        header: &'static str,
        key: &str,
        context: &str,
    ) -> Result<Option<Value>, String> {
        if key.trim().is_empty() {
            return Ok(None);
        }
        if !allowed(&url) {
            return Err(format!("{context} URL is not allowed"));
        }
        let response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(header, key.trim())
            .send()
            .await
            .map_err(|_| format!("{context} request failed"))?;
        if !allowed(response.url()) {
            return Err(format!("{context} redirect is not allowed"));
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(format!("{context} API key was rejected"));
        }
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err(format!("{context} rate limit was reached"));
        }
        if !response.status().is_success() {
            return Err(format!(
                "{context} request failed ({})",
                response.status().as_u16()
            ));
        }
        bounded_json(response, context).await.map(Some)
    }

    async fn cache_image(
        &self,
        cache_key: &str,
        image_url: &str,
        provider: &str,
    ) -> Result<PathBuf, String> {
        let url = Url::parse(image_url).map_err(|_| "Invalid artist picture URL".to_string())?;
        if !allowed_image(provider, &url) {
            return Err("The selected artist picture URL is not allowed".into());
        }
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("Artist image request failed: {error}"))?;
        if !allowed_image(provider, response.url()) {
            return Err("The selected artist picture redirect is not allowed".into());
        }
        if !response.status().is_success() {
            return Err(format!(
                "Artist image request failed ({})",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_IMAGE_BYTES as u64)
        {
            return Err("Artist image is too large".into());
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.starts_with("image/") {
            return Err("Artist picture response was not an image".into());
        }
        let extension = image_extension(&content_type, response.url());
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Could not download artist image: {error}"))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("Artist image is too large".into());
        }
        image::load_from_memory(&bytes)
            .map_err(|_| "Artist picture data is invalid".to_string())?;
        fs::create_dir_all(&self.cache_dir).map_err(|error| error.to_string())?;
        let name = format!(
            "{}{}",
            hex::encode(Sha256::digest(cache_key.as_bytes())),
            extension
        );
        let path = self.cache_dir.join(name);
        let temporary = self.cache_dir.join(format!(
            ".{}.{}.tmp",
            hex::encode(Sha256::digest(cache_key.as_bytes())),
            Uuid::new_v4()
        ));
        fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        fs::rename(&temporary, &path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            error.to_string()
        })?;
        Ok(path)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistImageCandidate {
    pub id: String,
    pub provider: String,
    pub image_url: String,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub attribution: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub license_url: Option<String>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub score: Option<i64>,
    #[serde(default)]
    pub current: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistProfileScanResult {
    checked: usize,
    updated: usize,
    failed: usize,
    queued: usize,
    remaining: usize,
    total_artists: usize,
}

#[derive(Clone)]
struct CachedProfile {
    profile: Value,
    fetched_at: i64,
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn iso_now() -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(now_seconds(), 0)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}
fn db(path: &str) -> Result<Connection, String> {
    Connection::open(path).map_err(|error| error.to_string())
}
fn normalize_artist_key(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn host(url: &Url, expected: &str) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| h.eq_ignore_ascii_case(expected))
}
fn host_or_subdomain(url: &Url, expected: &str) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|h| {
            h.eq_ignore_ascii_case(expected)
                || h.to_ascii_lowercase().ends_with(&format!(".{expected}"))
        })
}
fn is_musicbrainz(url: &Url) -> bool {
    host(url, "musicbrainz.org")
}
fn is_wikidata(url: &Url) -> bool {
    host(url, "www.wikidata.org")
}
fn is_wikipedia(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| h.to_ascii_lowercase().ends_with(".wikipedia.org"))
}
fn is_commons(url: &Url) -> bool {
    host(url, "commons.wikimedia.org")
}
fn is_fanart(url: &Url) -> bool {
    host(url, "webservice.fanart.tv")
}
fn is_audiodb(url: &Url) -> bool {
    host(url, "www.theaudiodb.com")
}
fn is_lastfm(url: &Url) -> bool {
    host(url, "ws.audioscrobbler.com")
}
fn is_deezer_api(url: &Url) -> bool {
    host(url, "api.deezer.com")
}
fn is_brave_api(url: &Url) -> bool {
    host(url, "api.search.brave.com")
}
fn is_secure_url(value: &str) -> Option<String> {
    Url::parse(value)
        .ok()
        .filter(|url| url.scheme() == "https")
        .map(|url| url.to_string())
}
fn allowed_image(provider: &str, url: &Url) -> bool {
    match provider {
        "wikimedia-commons" | "wikipedia" => {
            host(url, "upload.wikimedia.org") || host_or_subdomain(url, "wikimedia.org")
        }
        "fanart.tv" => host_or_subdomain(url, "fanart.tv"),
        "theaudiodb" => host_or_subdomain(url, "theaudiodb.com"),
        "deezer" => host(url, "cdn-images.dzcdn.net"),
        "brave-search" => host(url, "imgs.search.brave.com"),
        _ => false,
    }
}
fn image_extension(content_type: &str, url: &Url) -> &'static str {
    if content_type.starts_with("image/png") {
        ".png"
    } else if content_type.starts_with("image/webp") {
        ".webp"
    } else if content_type.starts_with("image/gif") {
        ".gif"
    } else if url.path().to_ascii_lowercase().ends_with(".png") {
        ".png"
    } else if url.path().to_ascii_lowercase().ends_with(".webp") {
        ".webp"
    } else {
        ".jpg"
    }
}
async fn bounded_json(response: reqwest::Response, context: &str) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_JSON_BYTES as u64)
    {
        return Err(format!("{context} response is too large"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("{context} response failed: {error}"))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(format!("{context} response is too large"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("{context} returned invalid JSON: {error}"))
}
fn uuid_text(value: &str) -> Option<String> {
    value
        .split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .find_map(|part| Uuid::parse_str(part).ok().map(|id| id.to_string()))
}
fn artist_key(name: &str, artist_id: &str, musicbrainz_id: &str) -> String {
    if let Some(id) =
        uuid_text(musicbrainz_id).or_else(|| artist_id.strip_prefix("mbid:").and_then(uuid_text))
    {
        return format!("mbid:{id}");
    }
    let identity = artist_id.trim();
    if !identity.is_empty() && !identity.starts_with("legacy:") {
        identity.to_string()
    } else {
        normalize_artist_key(name)
    }
}
fn read_cached(path: &str, key: &str) -> Result<Option<CachedProfile>, String> {
    let conn = db(path)?;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT profile_json,fetched_at FROM artist_profiles WHERE artist_key=?1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(json, fetched_at)| {
        serde_json::from_str(&json)
            .ok()
            .map(|profile| CachedProfile {
                profile,
                fetched_at,
            })
    }))
}
fn write_cached(
    path: &str,
    key: &str,
    requested_name: &str,
    profile: &Value,
) -> Result<(), String> {
    db(path)?.execute("INSERT INTO artist_profiles(artist_key,requested_name,profile_json,fetched_at) VALUES(?1,?2,?3,?4) ON CONFLICT(artist_key) DO UPDATE SET requested_name=excluded.requested_name,profile_json=excluded.profile_json,fetched_at=excluded.fetched_at", params![key, requested_name, profile.to_string(), now_seconds()]).map_err(|e| e.to_string())?;
    Ok(())
}
fn cache_needs_refresh(cached: &CachedProfile, fanart: &str, lastfm: &str, audiodb: &str) -> bool {
    let status = cached
        .profile
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let ttl = if status == "not-found" {
        NOT_FOUND_TTL
    } else {
        CACHE_TTL
    };
    cached.profile.get("profileVersion").and_then(Value::as_i64) != Some(PROFILE_VERSION)
        || (!lastfm.trim().is_empty()
            && status == "ready"
            && cached
                .profile
                .get("lastFmAttempted")
                .and_then(Value::as_bool)
                != Some(true))
        || (!audiodb.trim().is_empty()
            && status == "ready"
            && cached
                .profile
                .get("theAudioDbAttempted")
                .and_then(Value::as_bool)
                != Some(true))
        || (!fanart.trim().is_empty()
            && status == "ready"
            && cached.profile.get("imageSelection").and_then(Value::as_str) != Some("manual")
            && cached
                .profile
                .get("fanartAttempted")
                .and_then(Value::as_bool)
                != Some(true))
        || now_seconds() - cached.fetched_at >= ttl
}
fn find_stored_mbid(path: &str, name: &str, artist_id: &str, supplied: &str) -> Option<String> {
    if let Some(id) =
        uuid_text(supplied).or_else(|| artist_id.strip_prefix("mbid:").and_then(uuid_text))
    {
        return Some(id);
    }
    let conn = db(path).ok()?;
    if !artist_id.trim().is_empty() && !artist_id.contains(':') {
        if let Ok(Some(id)) = conn.query_row("SELECT musicbrainz_id FROM artist_entities WHERE id=?1 AND musicbrainz_id IS NOT NULL LIMIT 1", [artist_id], |r| r.get::<_, String>(0)).optional() { if let Some(id) = uuid_text(&id) { return Some(id); } }
    }
    let key = normalize_artist_key(name);
    if let Ok(Some(id)) = conn.query_row("SELECT e.musicbrainz_id FROM artist_entities e JOIN track_artist_credits c ON c.artist_id=e.id WHERE e.normalized_name=?1 AND e.musicbrainz_id IS NOT NULL ORDER BY c.scope='track' DESC,c.position LIMIT 1", [&key], |r| r.get::<_, String>(0)).optional() { if let Some(id) = uuid_text(&id) { return Some(id); } }
    conn.query_row("SELECT musicbrainz_artistid FROM tracks WHERE LOWER(TRIM(artist))=LOWER(TRIM(?1)) AND musicbrainz_artistid IS NOT NULL AND TRIM(musicbrainz_artistid)<>'' LIMIT 1", [name], |r| r.get::<_, String>(0)).optional().ok().flatten().and_then(|id| uuid_text(&id))
}
fn clean_text(value: Option<&Value>, max: usize) -> Option<String> {
    let raw = value
        .and_then(Value::as_str)?
        .replace("<br>", " ")
        .replace("<br />", " ");
    let mut out = String::new();
    let mut tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => tag = true,
            '>' => tag = false,
            _ if !tag => out.push(ch),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!out.is_empty()).then(|| out.chars().take(max).collect())
}

fn clean_string(value: Option<&str>, max: usize) -> Option<String> {
    value.and_then(|value| clean_text(Some(&Value::String(value.to_string())), max))
}
fn relation<'a>(artist: &'a Value, kind: &str) -> Option<&'a str> {
    artist
        .get("relations")?
        .as_array()?
        .iter()
        .find(|r| r.get("type").and_then(Value::as_str) == Some(kind))?
        .pointer("/url/resource")?
        .as_str()
}
fn wikipedia_target(value: &str) -> Option<(String, String, String)> {
    let url = Url::parse(value).ok()?;
    if !is_wikipedia(&url) || !url.path().starts_with("/wiki/") {
        return None;
    }
    Some((
        url.host_str()?.to_string(),
        url.path().trim_start_matches("/wiki/").to_string(),
        url.to_string(),
    ))
}
fn candidate_id(provider: &str, url: &str) -> String {
    hex::encode(Sha256::digest(format!("{provider}:{url}").as_bytes()))
}
fn profile_current_image(profile: &Value) -> Option<ArtistImageCandidate> {
    let provider = profile.get("imageProvider")?.as_str()?;
    let image_url = profile.get("imageUrl")?.as_str()?;
    let parsed = Url::parse(image_url).ok()?;
    if !allowed_image(provider, &parsed) {
        return None;
    }
    Some(ArtistImageCandidate {
        id: candidate_id(provider, image_url),
        provider: provider.into(),
        image_url: image_url.into(),
        source_url: profile
            .get("imageSourceUrl")
            .and_then(Value::as_str)
            .and_then(is_secure_url),
        source_name: None,
        title: None,
        attribution: clean_text(profile.get("imageAttribution"), 500),
        license: clean_text(profile.get("imageLicense"), 200),
        license_url: profile
            .get("imageLicenseUrl")
            .and_then(Value::as_str)
            .and_then(is_secure_url),
        width: None,
        height: None,
        score: Some(i64::MAX),
        current: Some(true),
    })
}

fn choose_musicbrainz_artist(payload: &Value, requested: &str) -> Option<(String, i64)> {
    let key = normalize_artist_key(requested);
    let artists = payload.get("artists")?.as_array()?;
    let exact: Vec<&Value> = artists
        .iter()
        .filter(|a| {
            normalize_artist_key(a.get("name").and_then(Value::as_str).unwrap_or("")) == key
                || a.get("aliases")
                    .and_then(Value::as_array)
                    .is_some_and(|xs| {
                        xs.iter().any(|x| {
                            normalize_artist_key(
                                x.get("name").and_then(Value::as_str).unwrap_or(""),
                            ) == key
                        })
                    })
        })
        .collect();
    let pool: Vec<&Value> = if exact.is_empty() {
        artists.iter().collect()
    } else {
        exact
    };
    pool.into_iter()
        .max_by_key(|a| a.get("score").and_then(Value::as_i64).unwrap_or(0))
        .and_then(|a| {
            Some((
                a.get("id")?.as_str()?.into(),
                a.get("score").and_then(Value::as_i64).unwrap_or(0),
            ))
        })
}

async fn wikidata_profile(state: &ArtistProfileState, resource: &str) -> Option<Value> {
    let id = resource
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|p| p.starts_with('Q') && p[1..].chars().all(|c| c.is_ascii_digit()))?;
    let url = Url::parse(&format!(
        "https://www.wikidata.org/wiki/Special:EntityData/{}.json",
        id.to_ascii_uppercase()
    ))
    .ok()?;
    state
        .json(url, is_wikidata, "Wikidata")
        .await
        .ok()?
        .get("entities")?
        .get(id.to_ascii_uppercase())
        .cloned()
}
fn wikidata_image(entity: &Value) -> Option<String> {
    entity
        .pointer("/claims/P18")?
        .as_array()?
        .iter()
        .find_map(|s| {
            s.pointer("/mainsnak/datavalue/value")?
                .as_str()
                .map(str::to_string)
        })
}
fn wikidata_wikipedia(entity: &Value) -> Option<(String, String, String)> {
    let sites = entity.get("sitelinks")?.as_object()?;
    let (key, site) = sites.get_key_value("enwiki").or_else(|| {
        sites
            .iter()
            .find(|(k, _)| k.ends_with("wiki") && !k.contains("commons"))
    })?;
    let title = site.get("title")?.as_str()?.replace(' ', "_");
    let language = key.trim_end_matches("wiki");
    let host = format!(
        "{}.wikipedia.org",
        if language.is_empty() { "en" } else { language }
    );
    let url = format!("https://{host}/wiki/{}", title);
    Some((host, title, url))
}
async fn wikipedia_summary(
    state: &ArtistProfileState,
    target: &(String, String, String),
) -> Option<Value> {
    let mut url = Url::parse(&format!("https://{}/api/rest_v1/page/summary/", target.0)).ok()?;
    url.path_segments_mut().ok()?.push(&target.1);
    let value = state.json(url, is_wikipedia, "Wikipedia").await.ok()?;
    (value.get("type").and_then(Value::as_str) != Some("disambiguation")).then_some(value)
}
async fn commons_image(state: &ArtistProfileState, file: &str) -> Option<Value> {
    let mut url = Url::parse("https://commons.wikimedia.org/w/api.php").ok()?;
    url.query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("format", "json")
        .append_pair("formatversion", "2")
        .append_pair("prop", "imageinfo")
        .append_pair("iiprop", "url|extmetadata")
        .append_pair("iiurlwidth", "800")
        .append_pair("iiextmetadatalanguage", "en")
        .append_pair(
            "titles",
            &format!("File:{}", file.trim_start_matches("File:")),
        );
    state
        .json(url, is_commons, "Wikimedia Commons")
        .await
        .ok()?
        .pointer("/query/pages/0/imageinfo/0")
        .cloned()
}
async fn optional_providers(
    state: &ArtistProfileState,
    mbid: &str,
    lastfm: &str,
    audiodb: &str,
    fanart: &str,
) -> (Option<Value>, Option<Value>, Option<Value>) {
    let mut last_url = Url::parse("https://ws.audioscrobbler.com/2.0/").unwrap();
    last_url
        .query_pairs_mut()
        .append_pair("method", "artist.getinfo")
        .append_pair("mbid", mbid)
        .append_pair("api_key", lastfm.trim())
        .append_pair("format", "json")
        .append_pair("autocorrect", "1")
        .append_pair("lang", "en");
    let last = if lastfm.trim().is_empty() {
        None
    } else {
        state
            .json(last_url, is_lastfm, "Last.fm")
            .await
            .ok()
            .and_then(|v| v.get("artist").cloned())
    };
    let audio_url = Url::parse(&format!(
        "https://www.theaudiodb.com/api/v2/json/lookup/artist_mb/{mbid}"
    ))
    .unwrap();
    let audio = state
        .keyed_json(audio_url, is_audiodb, "X-API-KEY", audiodb, "TheAudioDB")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.pointer("/lookup/0").cloned());
    let fan_url = Url::parse(&format!("https://webservice.fanart.tv/v3.2/music/{mbid}")).unwrap();
    let fan = state
        .keyed_json(fan_url, is_fanart, "api-key", fanart, "Fanart.tv")
        .await
        .ok()
        .flatten();
    (last, audio, fan)
}

async fn fetch_profile(
    state: &ArtistProfileState,
    db_path: &str,
    name: &str,
    key: &str,
    artist_id: &str,
    supplied_mbid: &str,
    fanart_key: &str,
    lastfm_key: &str,
    audiodb_key: &str,
) -> Result<Value, String> {
    let mut mbid = find_stored_mbid(db_path, name, artist_id, supplied_mbid);
    if mbid.is_none() {
        let mut url = Url::parse("https://musicbrainz.org/ws/2/artist/").unwrap();
        url.query_pairs_mut()
            .append_pair("query", name)
            .append_pair("dismax", "true")
            .append_pair("fmt", "json")
            .append_pair("limit", "5");
        let found = choose_musicbrainz_artist(&state.musicbrainz_json(url).await?, name);
        if found.as_ref().is_none_or(|(_, score)| *score < 70) {
            return Ok(
                json!({"profileVersion":PROFILE_VERSION,"artistKey":key,"requestedName":name,"name":name,"status":"not-found","fetchedAt":iso_now()}),
            );
        }
        mbid = found.map(|v| v.0);
    }
    let mbid = mbid.unwrap();
    let mut url = Url::parse(&format!("https://musicbrainz.org/ws/2/artist/{mbid}")).unwrap();
    url.query_pairs_mut()
        .append_pair("inc", "url-rels+genres")
        .append_pair("fmt", "json");
    let artist = state.musicbrainz_json(url).await?;
    let mut target = relation(&artist, "wikipedia").and_then(wikipedia_target);
    let wikidata = match relation(&artist, "wikidata") {
        Some(resource) => wikidata_profile(state, resource).await,
        None => None,
    };
    if target.is_none() {
        target = wikidata.as_ref().and_then(wikidata_wikipedia)
    }
    let wikipedia = match target.as_ref() {
        Some(t) => wikipedia_summary(state, t).await,
        None => None,
    };
    let mut wikidata = wikidata;
    if wikidata.is_none() {
        if let Some(id) = wikipedia
            .as_ref()
            .and_then(|value| value.get("wikibase_item"))
            .and_then(Value::as_str)
        {
            wikidata = wikidata_profile(state, id).await;
        }
    }
    let commons = match wikidata.as_ref().and_then(wikidata_image) {
        Some(file) => commons_image(state, &file).await,
        None => None,
    };
    let (last, audio, fan) =
        optional_providers(state, &mbid, lastfm_key, audiodb_key, fanart_key).await;
    let commons_url = commons
        .as_ref()
        .and_then(|v| v.get("thumburl").or_else(|| v.get("url")))
        .and_then(Value::as_str)
        .and_then(|v| Url::parse(v).ok())
        .filter(|u| allowed_image("wikimedia-commons", u))
        .map(|u| u.to_string());
    let wiki_url = wikipedia
        .as_ref()
        .and_then(|v| {
            v.pointer("/thumbnail/source")
                .or_else(|| v.pointer("/originalimage/source"))
        })
        .and_then(Value::as_str)
        .and_then(|v| Url::parse(v).ok())
        .filter(|u| allowed_image("wikipedia", u))
        .map(|u| u.to_string());
    let fan_url = fan
        .as_ref()
        .and_then(|v| v.get("artistthumb"))
        .and_then(Value::as_array)
        .and_then(|xs| {
            xs.iter().max_by_key(|x| {
                x.get("likes")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(0)
            })
        })
        .and_then(|x| x.get("url"))
        .and_then(Value::as_str)
        .and_then(is_secure_url);
    let audio_url = audio.as_ref().and_then(|v| {
        [
            "strArtistThumb",
            "strArtistFanart",
            "strArtistFanart2",
            "strArtistFanart3",
        ]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str).and_then(is_secure_url))
    });
    let (image_url, provider) = if let Some(v) = commons_url {
        (Some(v), Some("wikimedia-commons"))
    } else if let Some(v) = wiki_url {
        (Some(v), Some("wikipedia"))
    } else if let Some(v) = fan_url {
        (Some(v), Some("fanart.tv"))
    } else if let Some(v) = audio_url {
        (Some(v), Some("theaudiodb"))
    } else {
        (None, None)
    };
    let image_path = match (image_url.as_deref(), provider) {
        (Some(url), Some(p)) => state
            .cache_image(key, url, p)
            .await
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        _ => None,
    };
    let mb_genres: Vec<String> = artist
        .get("genres")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
        .take(8)
        .collect();
    let last_genres: Vec<String> = last
        .as_ref()
        .and_then(|v| v.pointer("/tags/tag"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
        .take(8)
        .collect();
    let audio_genres: Vec<String> = audio
        .as_ref()
        .into_iter()
        .flat_map(|v| {
            ["strGenre", "strStyle"]
                .iter()
                .filter_map(|k| v.get(*k).and_then(Value::as_str))
        })
        .flat_map(|s| s.split([',', ';', '/']))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .take(8)
        .collect();
    let genres = if !mb_genres.is_empty() {
        mb_genres
    } else if !last_genres.is_empty() {
        last_genres
    } else {
        audio_genres
    };
    let similar:Vec<Value>=last.as_ref().and_then(|v|v.pointer("/similar/artist")).and_then(Value::as_array).into_iter().flatten().filter_map(|v|{let n=v.get("name")?.as_str()?;Some(json!({"name":n,"musicBrainzId":v.get("mbid").and_then(Value::as_str).and_then(uuid_text),"url":v.get("url").and_then(Value::as_str).and_then(is_secure_url)}))}).take(8).collect();
    let audio_id = audio
        .as_ref()
        .and_then(|v| v.get("idArtist"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());
    let biography = wikipedia
        .as_ref()
        .and_then(|v| v.get("extract"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            last.as_ref().and_then(|v| {
                clean_text(
                    v.pointer("/bio/content")
                        .or_else(|| v.pointer("/bio/summary")),
                    8000,
                )
            })
        })
        .or_else(|| {
            audio
                .as_ref()
                .and_then(|v| v.get("strBiographyEN").or_else(|| v.get("strBiography")))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Ok(
        json!({"profileVersion":PROFILE_VERSION,"artistKey":key,"requestedName":name,"name":artist.get("name").and_then(Value::as_str).unwrap_or(name),"sortName":artist.get("sort-name"),"disambiguation":artist.get("disambiguation"),"status":"ready","type":artist.get("type"),"country":artist.get("country").or_else(||audio.as_ref().and_then(|v|v.get("strCountry"))),"area":artist.pointer("/area/name").or_else(||artist.pointer("/begin-area/name")),"begin":artist.pointer("/life-span/begin").or_else(||audio.as_ref().and_then(|v|v.get("intFormedYear").or_else(||v.get("intBornYear")))),"end":artist.pointer("/life-span/end"),"ended":artist.pointer("/life-span/ended").and_then(Value::as_bool).unwrap_or(false),"genres":genres,"description":wikipedia.as_ref().and_then(|v|v.get("description")),"biography":biography,"imagePath":image_path,"imageUrl":image_url,"imageProvider":provider,"imageAttribution":match provider{Some("wikimedia-commons")=>commons.as_ref().and_then(|v|clean_text(v.pointer("/extmetadata/Artist/value").or_else(||v.pointer("/extmetadata/Credit/value")),1000)),Some("fanart.tv")=>Some("Fanart.tv contributor".into()),Some("theaudiodb")=>Some("TheAudioDB contributor".into()),Some("wikipedia")=>Some("Wikipedia contributor".into()),_=>None},"imageLicense":commons.as_ref().and_then(|v|clean_text(v.pointer("/extmetadata/LicenseShortName/value").or_else(||v.pointer("/extmetadata/UsageTerms/value")),200)),"imageLicenseUrl":commons.as_ref().and_then(|v|v.pointer("/extmetadata/LicenseUrl/value")).and_then(Value::as_str).and_then(is_secure_url),"imageSelection":"automatic","lastFmAttempted":!lastfm_key.trim().is_empty(),"lastFmUrl":last.as_ref().and_then(|v|v.get("url")).and_then(Value::as_str).and_then(is_secure_url),"similarArtists":similar,"theAudioDbAttempted":!audiodb_key.trim().is_empty(),"theAudioDbId":audio_id,"theAudioDbUrl":audio_id.map(|id|format!("https://www.theaudiodb.com/artist/{id}")),"fanartAttempted":!fanart_key.trim().is_empty(),"musicBrainzId":mbid,"musicBrainzUrl":format!("https://musicbrainz.org/artist/{mbid}"),"wikipediaUrl":wikipedia.as_ref().and_then(|v|v.pointer("/content_urls/desktop/page")).and_then(Value::as_str).or_else(||target.as_ref().map(|v|v.2.as_str())),"wikimediaCommonsUrl":commons.as_ref().and_then(|v|v.get("descriptionurl")).and_then(Value::as_str),"fanartUrl":provider.filter(|p|*p=="fanart.tv").map(|_|format!("https://fanart.tv/artist/{mbid}/")),"fetchedAt":iso_now()}),
    )
}

fn preserve_manual(mut fresh: Value, cached: Option<&Value>) -> Value {
    if cached
        .and_then(|v| v.get("imageSelection"))
        .and_then(Value::as_str)
        != Some("manual")
    {
        return fresh;
    }
    let Some(out) = fresh.as_object_mut() else {
        return fresh;
    };
    let old = cached.unwrap();
    for key in [
        "imagePath",
        "imageUrl",
        "imageProvider",
        "imageAttribution",
        "imageLicense",
        "imageLicenseUrl",
        "imageSourceUrl",
        "imageSelection",
    ] {
        if let Some(v) = old.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    fresh
}

async fn get_profile_impl(
    state: &ArtistProfileState,
    db_path: &str,
    name: &str,
    force: bool,
    artist_id: &str,
    mbid: &str,
    fanart: &str,
    lastfm: &str,
    audiodb: &str,
) -> Result<Value, String> {
    let requested = name.trim();
    let key = artist_key(requested, artist_id, mbid);
    if key.is_empty() {
        return Err("Artist name is required".into());
    }
    let cached = read_cached(db_path, &key)?;
    if !force
        && cached
            .as_ref()
            .is_some_and(|v| !cache_needs_refresh(v, fanart, lastfm, audiodb))
    {
        let mut profile = cached.unwrap().profile;
        if let Some(o) = profile.as_object_mut() {
            o.insert("cacheState".into(), json!("fresh"));
        }
        return Ok(profile);
    }
    match fetch_profile(
        state, db_path, requested, &key, artist_id, mbid, fanart, lastfm, audiodb,
    )
    .await
    {
        Ok(profile) => {
            let mut profile = preserve_manual(profile, cached.as_ref().map(|v| &v.profile));
            write_cached(db_path, &key, requested, &profile)?;
            if let Some(o) = profile.as_object_mut() {
                o.insert("cacheState".into(), json!("fresh"));
            }
            Ok(profile)
        }
        Err(error) => {
            if let Some(mut cached) = cached.map(|v| v.profile) {
                if let Some(o) = cached.as_object_mut() {
                    o.insert("cacheState".into(), json!("stale"));
                }
                Ok(cached)
            } else {
                Err(error)
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_cached_artist_profiles(db_path: String) -> Result<Vec<Value>, String> {
    let conn = db(&db_path)?;
    let mut stmt = conn
        .prepare("SELECT profile_json FROM artist_profiles ORDER BY requested_name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(|r| r.ok().and_then(|v| serde_json::from_str(&v).ok()))
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_profile(
    state: State<'_, ArtistProfileState>,
    db_path: String,
    artist_name: String,
    force: Option<bool>,
    artist_id: Option<String>,
    music_brainz_id: Option<String>,
    fanart_api_key: Option<String>,
    last_fm_api_key: Option<String>,
    the_audio_db_api_key: Option<String>,
) -> Result<Value, String> {
    get_profile_impl(
        &state,
        &db_path,
        &artist_name,
        force.unwrap_or(false),
        artist_id.as_deref().unwrap_or(""),
        music_brainz_id.as_deref().unwrap_or(""),
        fanart_api_key.as_deref().unwrap_or(""),
        last_fm_api_key.as_deref().unwrap_or(""),
        the_audio_db_api_key.as_deref().unwrap_or(""),
    )
    .await
}

async fn deezer_candidates(
    state: &ArtistProfileState,
    name: &str,
) -> Result<Vec<ArtistImageCandidate>, String> {
    let mut url = Url::parse("https://api.deezer.com/search/artist").unwrap();
    url.query_pairs_mut()
        .append_pair("q", name)
        .append_pair("limit", "8");
    let payload = state.json(url, is_deezer_api, "Deezer").await?;
    let mut out = Vec::new();
    for (i, a) in payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let id = a.get("id").and_then(Value::as_i64).unwrap_or(0);
        let artist = clean_text(a.get("name"), 200);
        let image = ["picture_xl", "picture_big", "picture_medium"]
            .iter()
            .find_map(|k| a.get(*k).and_then(Value::as_str))
            .unwrap_or("");
        let Ok(parsed) = Url::parse(image) else {
            continue;
        };
        if id <= 0
            || artist.is_none()
            || !allowed_image("deezer", &parsed)
            || parsed.path().contains("/images/artist//")
        {
            continue;
        }
        let exact = normalize_artist_key(artist.as_deref().unwrap()) == normalize_artist_key(name);
        out.push(ArtistImageCandidate {
            id: candidate_id("deezer", image),
            provider: "deezer".into(),
            image_url: image.into(),
            source_url: Some(format!("https://www.deezer.com/artist/{id}")),
            source_name: artist.clone(),
            title: artist.map(|v| format!("{v} on Deezer")),
            attribution: Some("Deezer".into()),
            license: None,
            license_url: None,
            width: a.get("picture_xl").is_some().then_some(1000),
            height: a.get("picture_xl").is_some().then_some(1000),
            score: Some((if exact { 10000 } else { 1000 }) - i as i64),
            current: None,
        });
    }
    Ok(out)
}
async fn brave_candidates(
    state: &ArtistProfileState,
    name: &str,
    key: &str,
) -> Result<Vec<ArtistImageCandidate>, String> {
    if key.trim().is_empty() {
        return Ok(vec![]);
    }
    let query = format!("\"{}\" musician DJ artist portrait", name.replace('"', " "));
    let mut url = Url::parse("https://api.search.brave.com/res/v1/images/search").unwrap();
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("country", "ALL")
        .append_pair("search_lang", "en")
        .append_pair("count", "15")
        .append_pair("safesearch", "strict");
    let payload = state
        .keyed_json(
            url,
            is_brave_api,
            "X-Subscription-Token",
            key,
            "Brave Image Search",
        )
        .await?
        .unwrap_or(Value::Null);
    let mut source = Url::parse("https://search.brave.com/images").unwrap();
    source.query_pairs_mut().append_pair("q", &query);
    let mut out = vec![];
    for (i, v) in payload
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let image = v
            .pointer("/thumbnail/src")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Ok(parsed) = Url::parse(image) else {
            continue;
        };
        if !allowed_image("brave-search", &parsed) {
            continue;
        }
        let confidence = match v
            .get("confidence")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "high" => 3,
            "medium" => 2,
            "low" => 1,
            _ => 0,
        };
        out.push(ArtistImageCandidate {
            id: candidate_id("brave-search", image),
            provider: "brave-search".into(),
            image_url: image.into(),
            source_url: Some(source.to_string()),
            source_name: clean_text(
                v.get("source").or_else(|| v.pointer("/meta_url/hostname")),
                200,
            ),
            title: clean_text(v.get("title"), 500),
            attribution: clean_text(v.get("source"), 200),
            license: None,
            license_url: None,
            width: v.pointer("/properties/width").and_then(Value::as_i64),
            height: v.pointer("/properties/height").and_then(Value::as_i64),
            score: Some(confidence * 1000 - i as i64),
            current: None,
        });
    }
    Ok(out)
}

async fn provider_image_candidates(
    state: &ArtistProfileState,
    profile: &Value,
    fanart_key: &str,
    audiodb_key: &str,
) -> Vec<ArtistImageCandidate> {
    let Some(mbid) = profile.get("musicBrainzId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();

    if !fanart_key.trim().is_empty() {
        let url = Url::parse(&format!("https://webservice.fanart.tv/v3.2/music/{mbid}")).unwrap();
        if let Ok(Some(payload)) = state
            .keyed_json(url, is_fanart, "api-key", fanart_key, "Fanart.tv")
            .await
        {
            for image in payload
                .get("artistthumb")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(image_url) = image
                    .get("url")
                    .and_then(Value::as_str)
                    .and_then(|value| Url::parse(value).ok())
                    .filter(|url| allowed_image("fanart.tv", url))
                    .map(|url| url.to_string())
                else {
                    continue;
                };
                let number = |field: &str| {
                    image
                        .get(field)
                        .and_then(Value::as_i64)
                        .or_else(|| image.get(field).and_then(Value::as_str)?.parse().ok())
                };
                candidates.push(ArtistImageCandidate {
                    id: candidate_id("fanart.tv", &image_url),
                    provider: "fanart.tv".into(),
                    image_url,
                    source_url: Some(format!("https://fanart.tv/artist/{mbid}/")),
                    source_name: None,
                    title: None,
                    attribution: Some("Fanart.tv contributor".into()),
                    license: None,
                    license_url: None,
                    width: number("width"),
                    height: number("height"),
                    score: number("likes"),
                    current: None,
                });
            }
        }
    }

    if !audiodb_key.trim().is_empty() {
        let url = Url::parse(&format!(
            "https://www.theaudiodb.com/api/v2/json/lookup/artist_mb/{mbid}"
        ))
        .unwrap();
        if let Ok(Some(payload)) = state
            .keyed_json(url, is_audiodb, "X-API-KEY", audiodb_key, "TheAudioDB")
            .await
        {
            if let Some(artist) = payload.pointer("/lookup/0") {
                let source_url = artist
                    .get("idArtist")
                    .and_then(Value::as_str)
                    .map(|id| format!("https://www.theaudiodb.com/artist/{id}"))
                    .or_else(|| Some("https://www.theaudiodb.com/".into()));
                let mut seen = HashSet::new();
                for (field, score) in [
                    ("strArtistThumb", 4),
                    ("strArtistFanart", 3),
                    ("strArtistFanart2", 2),
                    ("strArtistFanart3", 1),
                ] {
                    let Some(image_url) = artist
                        .get(field)
                        .and_then(Value::as_str)
                        .and_then(|value| Url::parse(value).ok())
                        .filter(|url| allowed_image("theaudiodb", url))
                        .map(|url| url.to_string())
                    else {
                        continue;
                    };
                    if !seen.insert(image_url.clone()) {
                        continue;
                    }
                    candidates.push(ArtistImageCandidate {
                        id: candidate_id("theaudiodb", &image_url),
                        provider: "theaudiodb".into(),
                        image_url,
                        source_url: source_url.clone(),
                        source_name: None,
                        title: None,
                        attribution: Some("TheAudioDB contributor".into()),
                        license: clean_text(artist.get("strCreativeCommons"), 200),
                        license_url: None,
                        width: None,
                        height: None,
                        score: Some(score),
                        current: None,
                    });
                }
            }
        }
    }
    candidates
}
#[tauri::command(rename_all = "camelCase")]
pub async fn search_artist_images(
    state: State<'_, ArtistProfileState>,
    db_path: String,
    artist_name: String,
    artist_id: Option<String>,
    music_brainz_id: Option<String>,
    brave_search_api_key: Option<String>,
    fanart_api_key: Option<String>,
    last_fm_api_key: Option<String>,
    the_audio_db_api_key: Option<String>,
) -> Result<Vec<ArtistImageCandidate>, String> {
    let artist_id = artist_id.unwrap_or_default();
    let mbid = music_brainz_id.unwrap_or_default();
    let fanart = fanart_api_key.unwrap_or_default();
    let lastfm = last_fm_api_key.unwrap_or_default();
    let audiodb = the_audio_db_api_key.unwrap_or_default();
    let mut profile_error = None;
    let profile = match get_profile_impl(
        &state,
        &db_path,
        &artist_name,
        false,
        &artist_id,
        &mbid,
        &fanart,
        &lastfm,
        &audiodb,
    )
    .await
    {
        Ok(v) => Some(v),
        Err(e) => {
            profile_error = Some(e);
            None
        }
    };
    let mut candidates = profile
        .as_ref()
        .and_then(profile_current_image)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(profile) = profile.as_ref() {
        candidates.append(&mut provider_image_candidates(&state, profile, &fanart, &audiodb).await);
    }
    let deezer = deezer_candidates(&state, artist_name.trim()).await;
    if let Ok(mut values) = deezer {
        candidates.append(&mut values)
    }
    let brave = brave_candidates(
        &state,
        artist_name.trim(),
        brave_search_api_key.as_deref().unwrap_or(""),
    )
    .await;
    let brave_error = brave.as_ref().err().cloned();
    if let Ok(mut values) = brave {
        candidates.append(&mut values)
    }
    if candidates.is_empty() {
        if let Some(e) = brave_error {
            return Err(e);
        }
        if let Some(e) = profile_error {
            return Err(e);
        }
    }
    let mut seen = HashSet::new();
    candidates.retain(|v| seen.insert(v.image_url.clone()));
    fn rank(p: &str) -> i32 {
        match p {
            "wikimedia-commons" => 0,
            "wikipedia" => 1,
            "fanart.tv" => 2,
            "theaudiodb" => 3,
            "deezer" => 4,
            "brave-search" => 5,
            _ => 99,
        }
    }
    candidates.sort_by(|a, b| {
        b.current
            .unwrap_or(false)
            .cmp(&a.current.unwrap_or(false))
            .then(rank(&a.provider).cmp(&rank(&b.provider)))
            .then(b.score.unwrap_or(0).cmp(&a.score.unwrap_or(0)))
    });
    Ok(candidates)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_artist_image(
    state: State<'_, ArtistProfileState>,
    db_path: String,
    artist_name: String,
    candidate: ArtistImageCandidate,
    artist_id: Option<String>,
    music_brainz_id: Option<String>,
) -> Result<Value, String> {
    let requested = artist_name.trim();
    let key = artist_key(
        requested,
        artist_id.as_deref().unwrap_or(""),
        music_brainz_id.as_deref().unwrap_or(""),
    );
    if key.is_empty() {
        return Err("Artist name is required".into());
    }
    let cached =
        read_cached(&db_path, &key)?.ok_or("Load the artist profile before selecting a picture")?;
    let parsed = Url::parse(&candidate.image_url)
        .map_err(|_| "The selected artist picture URL is not allowed")?;
    if !allowed_image(&candidate.provider, &parsed) {
        return Err("The selected artist picture URL is not allowed".into());
    }
    let path = state
        .cache_image(
            &format!("{key}:{}", candidate.image_url),
            &candidate.image_url,
            &candidate.provider,
        )
        .await?;
    let mut profile = cached.profile;
    let old = profile
        .get("imagePath")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let source = candidate.source_url.as_deref().and_then(is_secure_url);
    let map = profile
        .as_object_mut()
        .ok_or("Cached artist profile is invalid")?;
    map.insert("imagePath".into(), json!(path.to_string_lossy()));
    map.insert("imageUrl".into(), json!(candidate.image_url));
    map.insert("imageProvider".into(), json!(candidate.provider));
    map.insert(
        "imageAttribution".into(),
        json!(clean_string(candidate.attribution.as_deref(), 500)),
    );
    map.insert(
        "imageLicense".into(),
        json!(clean_string(candidate.license.as_deref(), 200)),
    );
    map.insert(
        "imageLicenseUrl".into(),
        json!(candidate.license_url.as_deref().and_then(is_secure_url)),
    );
    map.insert("imageSourceUrl".into(), json!(source));
    map.insert("imageSelection".into(), json!("manual"));
    let source_field = match candidate.provider.as_str() {
        "wikimedia-commons" => Some("wikimediaCommonsUrl"),
        "wikipedia" => Some("wikipediaUrl"),
        "fanart.tv" => Some("fanartUrl"),
        "theaudiodb" => Some("theAudioDbUrl"),
        _ => None,
    };
    if let Some(field) = source_field {
        map.insert(field.into(), json!(source));
    }
    map.insert("fetchedAt".into(), json!(iso_now()));
    write_cached(&db_path, &key, requested, &profile)?;
    if let Some(old) = old {
        if old != path && path_within(&old, &state.cache_dir) {
            let _ = fs::remove_file(old);
        }
    }
    if let Some(map) = profile.as_object_mut() {
        map.insert("cacheState".into(), json!("fresh"));
    }
    Ok(profile)
}
fn path_within(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(path), Ok(root)) => path.starts_with(root),
        _ => false,
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_artist_profiles(
    state: State<'_, ArtistProfileState>,
    db_path: String,
    fanart_api_key: Option<String>,
    last_fm_api_key: Option<String>,
    the_audio_db_api_key: Option<String>,
    limit: Option<i64>,
) -> Result<ArtistProfileScanResult, String> {
    let _guard = state.scan_lock.lock().await;
    let conn = db(&db_path)?;
    let mut artists: Vec<(String, String, i64)> = vec![];
    {
        let mut stmt=conn.prepare("SELECT e.canonical_name,e.normalized_name,MAX(COALESCE(t.added_at,0)) FROM artist_entities e JOIN track_artist_credits c ON c.artist_id=e.id AND c.scope='track' JOIN tracks t ON t.id=c.track_id GROUP BY e.id").map_err(|e|e.to_string())?;
        for row in stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
        {
            if let Ok(v) = row {
                artists.push(v)
            }
        }
    }
    {
        let mut stmt=conn.prepare("SELECT t.artist,LOWER(TRIM(t.artist)),MAX(COALESCE(t.added_at,0)) FROM tracks t WHERE t.artist IS NOT NULL AND TRIM(t.artist)<>'' AND NOT EXISTS(SELECT 1 FROM track_artist_credit_sets s WHERE s.track_id=t.id AND s.scope='track' AND s.display_text=t.artist) GROUP BY LOWER(TRIM(t.artist))").map_err(|e|e.to_string())?;
        for row in stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
        {
            if let Ok(v) = row {
                artists.push(v)
            }
        }
    }
    artists.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then(a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    let mut seen = HashSet::new();
    artists.retain(|(_, k, _)| seen.insert(normalize_artist_key(k)));
    let cached: HashSet<String> = {
        let mut s = conn
            .prepare("SELECT artist_key FROM artist_profiles")
            .map_err(|e| e.to_string())?;
        let values = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        values
    };
    drop(conn);
    let due: Vec<_> = artists
        .iter()
        .filter(|(_, k, _)| !cached.contains(&normalize_artist_key(k)))
        .cloned()
        .collect();
    let retry = state.scan_retry_after.lock().await.clone();
    let eligible: Vec<_> = due
        .iter()
        .filter(|(_, k, _)| {
            retry.get(&normalize_artist_key(k)).copied().unwrap_or(0) <= now_seconds()
        })
        .cloned()
        .collect();
    let batch = eligible
        .iter()
        .take(limit.unwrap_or(25).clamp(1, 50) as usize);
    let mut updated = 0;
    let mut failed = 0;
    for (name, key, _) in batch {
        match get_profile_impl(
            &state,
            &db_path,
            name,
            false,
            "",
            "",
            fanart_api_key.as_deref().unwrap_or(""),
            last_fm_api_key.as_deref().unwrap_or(""),
            the_audio_db_api_key.as_deref().unwrap_or(""),
        )
        .await
        {
            Ok(v) if v.get("cacheState").and_then(Value::as_str) != Some("stale") => {
                updated += 1;
                state
                    .scan_retry_after
                    .lock()
                    .await
                    .remove(&normalize_artist_key(key));
            }
            _ => {
                failed += 1;
                state
                    .scan_retry_after
                    .lock()
                    .await
                    .insert(normalize_artist_key(key), now_seconds() + SCAN_BACKOFF);
            }
        }
    }
    let checked = updated + failed;
    Ok(ArtistProfileScanResult {
        checked,
        updated,
        failed,
        queued: eligible.len().saturating_sub(checked),
        remaining: due.len().saturating_sub(updated),
        total_artists: artists.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn keys_are_unicode_and_identity_stable() {
        assert_eq!(normalize_artist_key("  TÉST   Artist "), "tést artist");
        assert_eq!(
            artist_key("wrong", "mbid:550e8400-e29b-41d4-a716-446655440000", ""),
            "mbid:550e8400-e29b-41d4-a716-446655440000"
        );
    }
    #[test]
    fn allowlists_reject_suffix_spoofing_and_http() {
        assert!(allowed_image(
            "deezer",
            &Url::parse("https://cdn-images.dzcdn.net/a.jpg").unwrap()
        ));
        assert!(!allowed_image(
            "deezer",
            &Url::parse("https://cdn-images.dzcdn.net.evil.test/a.jpg").unwrap()
        ));
        assert!(!is_wikipedia(
            &Url::parse("http://en.wikipedia.org/wiki/Test").unwrap()
        ));
        assert!(!is_wikipedia(
            &Url::parse("https://evilwikipedia.org/wiki/Test").unwrap()
        ));
    }
    #[test]
    fn candidate_parser_prefers_exact_musicbrainz_match() {
        let p = json!({"artists":[{"id":"a","name":"Other","score":100},{"id":"b","name":"Test Artist","score":75}]});
        assert_eq!(
            choose_musicbrainz_artist(&p, "test artist"),
            Some(("b".into(), 75))
        );
    }
    #[test]
    fn manual_image_survives_refresh() {
        let fresh = json!({"imagePath":"new","imageSelection":"automatic"});
        let old = json!({"imagePath":"old","imageUrl":"https://cdn-images.dzcdn.net/a.jpg","imageSelection":"manual"});
        let kept = preserve_manual(fresh, Some(&old));
        assert_eq!(kept["imagePath"], "old");
        assert_eq!(kept["imageSelection"], "manual");
    }
}
