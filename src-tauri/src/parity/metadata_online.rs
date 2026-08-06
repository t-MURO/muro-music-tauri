//! Rust-native MusicBrainz and remote album-art services.
//!
//! Network access is centralized in [`MetadataOnlineState`] so MusicBrainz's
//! request cadence is shared by every renderer command. All downloaded artwork
//! is validated against a provider-specific HTTPS allowlist before it is read.

use image::codecs::jpeg::JpegEncoder;
use image::imageops::{overlay, FilterType};
use image::{DynamicImage, GenericImageView, ImageEncoder, Rgba, RgbaImage};
use reqwest::{Client, StatusCode, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::{sleep_until, Instant};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const MUSICBRAINZ_RECORDING_SEARCH: &str = "https://musicbrainz.org/ws/2/recording/";
const MUSICBRAINZ_RELEASE_SEARCH: &str = "https://musicbrainz.org/ws/2/release/";
const MUSICBRAINZ_RELEASE_GROUP_SEARCH: &str = "https://musicbrainz.org/ws/2/release-group/";
const COVER_ART_ARCHIVE_ROOT: &str = "https://coverartarchive.org";
const DEEZER_ALBUM_SEARCH: &str = "https://api.deezer.com/search/album";
const BRAVE_IMAGE_SEARCH: &str = "https://api.search.brave.com/res/v1/images/search";
const USER_AGENT: &str = "MuroMusic/0.1.2 (https://github.com/t-MURO/muro-music-electron)";
const MUSICBRAINZ_USER_AGENT: &str =
    "MuroMusicElectron/0.1.2 (https://github.com/t-MURO/muro-music-electron)";
const MUSICBRAINZ_INTERVAL: Duration = Duration::from_millis(1_100);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;
const NOT_FOUND_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const COVER_CACHE_VERSION: &str = "v3";

pub struct MetadataOnlineState {
    client: Client,
    cache_dir: PathBuf,
    next_musicbrainz_request: Mutex<Instant>,
}

impl MetadataOnlineState {
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
        })
    }

    async fn wait_for_musicbrainz(&self) {
        let mut next = self.next_musicbrainz_request.lock().await;
        let now = Instant::now();
        if *next > now {
            sleep_until(*next).await;
        }
        *next = Instant::now() + MUSICBRAINZ_INTERVAL;
    }

    async fn musicbrainz_json(&self, url: Url, context: &str) -> Result<Value, String> {
        let retryable = [
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::GATEWAY_TIMEOUT,
        ];
        let mut last_network_error = None;
        for attempt in 0..=2 {
            self.wait_for_musicbrainz().await;
            match self
                .client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::USER_AGENT, MUSICBRAINZ_USER_AGENT)
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return response
                            .json::<Value>()
                            .await
                            .map_err(|error| format!("{context} returned invalid JSON: {error}"));
                    }
                    if !retryable.contains(&status) || attempt == 2 {
                        return Err(format!("{context} failed ({})", status.as_u16()));
                    }
                }
                Err(error) => {
                    last_network_error = Some(error.to_string());
                    if attempt == 2 {
                        break;
                    }
                }
            }
        }
        Err(format!(
            "MusicBrainz is temporarily unreachable. {}",
            last_network_error.unwrap_or_else(|| "Try again later".to_string())
        ))
    }

    async fn download_allowed_image(
        &self,
        image_url: &str,
        allowed: fn(&Url) -> bool,
        provider: &str,
    ) -> Result<Vec<u8>, String> {
        let url = Url::parse(image_url).map_err(|_| "Invalid album cover URL".to_string())?;
        if !allowed(&url) {
            return Err("The selected album cover URL is not allowed".to_string());
        }
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("{provider} image request failed: {error}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err("Album cover was not found".to_string());
        }
        if !response.status().is_success() {
            return Err(format!(
                "{provider} image request failed ({})",
                response.status().as_u16()
            ));
        }
        // reqwest follows a small number of redirects. Validate the final URL
        // too so a trusted provider cannot bounce a download to an arbitrary
        // host after the initial allowlist check.
        if !allowed(response.url()) {
            return Err("The selected album cover URL is not allowed".to_string());
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_DOWNLOAD_BYTES as u64)
        {
            return Err("Album cover is too large".to_string());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Could not download album cover: {error}"))?;
        if bytes.len() > MAX_DOWNLOAD_BYTES {
            return Err("Album cover is too large".to_string());
        }
        Ok(bytes.to_vec())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistCreditInput {
    pub name: String,
    pub credited_name: String,
    pub join_phrase: String,
    pub music_brainz_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSearchCandidate {
    pub id: String,
    pub score: f64,
    pub recording_id: Option<String>,
    pub release_id: Option<String>,
    pub release_group_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub artist_credits: Vec<ArtistCreditInput>,
    pub album: String,
    pub album_artist: String,
    pub album_artist_credits: Vec<ArtistCreditInput>,
    pub year: Option<i64>,
    pub country: Option<String>,
    pub status: Option<String>,
    pub genre: Option<String>,
    pub album_match: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetadataCandidate {
    pub id: String,
    pub score: f64,
    pub title: String,
    pub artist: String,
    pub artist_credits: Vec<ArtistCreditInput>,
    pub release_group_id: Option<String>,
    pub year: Option<i64>,
    pub country: Option<String>,
    pub status: Option<String>,
    pub barcode: Option<String>,
    pub track_count: i64,
    pub disambiguation: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetadataTrack {
    pub id: String,
    pub recording_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub artist_credits: Vec<ArtistCreditInput>,
    pub track_number: i64,
    pub track_total: i64,
    pub disc_number: i64,
    pub disc_total: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetadataRelease {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artist_credits: Vec<ArtistCreditInput>,
    pub release_group_id: Option<String>,
    pub year: Option<i64>,
    pub country: Option<String>,
    pub status: Option<String>,
    pub label: Option<String>,
    pub genre: Option<String>,
    pub disc_total: Option<i64>,
    pub tracks: Vec<AlbumMetadataTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCoverCandidate {
    pub id: String,
    pub provider: String,
    pub image_url: String,
    pub source_url: String,
    pub source_name: Option<String>,
    pub title: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub score: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedCoverArt {
    pub full_path: String,
    pub thumb_path: String,
    pub source_url: Option<String>,
    pub provider: Option<String>,
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn optional_text(value: Option<&Value>) -> Option<String> {
    let value = text(value);
    (!value.is_empty()).then_some(value)
}

fn valid_mb_id(value: Option<&Value>) -> Option<String> {
    optional_text(value).filter(|value| Uuid::parse_str(value).is_ok())
}

fn year_from(value: Option<&Value>) -> Option<i64> {
    text(value).get(0..4)?.parse().ok()
}

fn artist_credits(value: Option<&Value>) -> Vec<ArtistCreditInput> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let artist = entry.get("artist");
            let credited_name = optional_text(entry.get("name"))
                .or_else(|| optional_text(artist.and_then(|value| value.get("name"))))?;
            let name = optional_text(artist.and_then(|value| value.get("name")))
                .unwrap_or_else(|| credited_name.clone());
            Some(ArtistCreditInput {
                name,
                credited_name,
                join_phrase: text(entry.get("joinphrase")),
                music_brainz_id: valid_mb_id(artist.and_then(|value| value.get("id"))),
            })
        })
        .collect()
}

fn fallback_credit(display: &str) -> Vec<ArtistCreditInput> {
    let display = display.trim();
    if display.is_empty() {
        Vec::new()
    } else {
        vec![ArtistCreditInput {
            name: display.to_string(),
            credited_name: display.to_string(),
            join_phrase: String::new(),
            music_brainz_id: None,
        }]
    }
}

fn credit_display(credits: &[ArtistCreditInput]) -> String {
    credits
        .iter()
        .map(|credit| format!("{}{}", credit.credited_name, credit.join_phrase))
        .collect::<String>()
        .trim()
        .to_string()
}

fn parse_track_candidates(
    payload: &Value,
    requested_album: &str,
    requested_artist: &str,
) -> Vec<MetadataSearchCandidate> {
    let mut candidates = Vec::new();
    for recording in payload
        .get("recordings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let releases = recording.get("releases").and_then(Value::as_array);
        let empty_release = Value::Null;
        let release_values: Vec<&Value> = match releases {
            Some(values) if !values.is_empty() => values.iter().collect(),
            _ => vec![&empty_release],
        };
        for release in release_values {
            let recording_credits = artist_credits(recording.get("artist-credit"));
            let recording_artist = {
                let display = credit_display(&recording_credits);
                if display.is_empty() {
                    requested_artist.to_string()
                } else {
                    display
                }
            };
            let release_credits = artist_credits(release.get("artist-credit"));
            let release_artist = {
                let display = credit_display(&release_credits);
                if display.is_empty() {
                    recording_artist.clone()
                } else {
                    display
                }
            };
            let album = text(release.get("title"));
            let mut tags = recording
                .get("tags")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            tags.sort_by_key(|tag| {
                std::cmp::Reverse(tag.get("count").and_then(Value::as_i64).unwrap_or_default())
            });
            let recording_id = optional_text(recording.get("id"));
            let release_id = optional_text(release.get("id"));
            candidates.push(MetadataSearchCandidate {
                id: format!(
                    "{}:{}",
                    recording_id.as_deref().unwrap_or_default(),
                    release_id.as_deref().unwrap_or("recording")
                ),
                score: recording
                    .get("score")
                    .and_then(Value::as_f64)
                    .unwrap_or_default(),
                recording_id,
                release_id,
                release_group_id: optional_text(
                    release
                        .get("release-group")
                        .and_then(|value| value.get("id")),
                ),
                title: optional_text(recording.get("title")).unwrap_or_default(),
                artist: recording_artist.clone(),
                artist_credits: if recording_credits.is_empty() {
                    fallback_credit(&recording_artist)
                } else {
                    recording_credits.clone()
                },
                album: album.clone(),
                album_artist: release_artist.clone(),
                album_artist_credits: if release_credits.is_empty() {
                    if recording_credits.is_empty() {
                        fallback_credit(&release_artist)
                    } else {
                        recording_credits
                    }
                } else {
                    release_credits
                },
                year: year_from(release.get("date")),
                country: optional_text(release.get("country")),
                status: optional_text(release.get("status")),
                genre: tags.first().and_then(|tag| optional_text(tag.get("name"))),
                album_match: !requested_album.trim().is_empty()
                    && album.eq_ignore_ascii_case(requested_album.trim()),
            });
        }
    }
    candidates.sort_by(|left, right| {
        right
            .album_match
            .cmp(&left.album_match)
            .then_with(|| right.score.total_cmp(&left.score))
            .then_with(|| left.year.unwrap_or(9999).cmp(&right.year.unwrap_or(9999)))
    });
    candidates.truncate(30);
    candidates
}

fn release_track_count(release: &Value) -> i64 {
    release
        .get("media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|medium| {
            medium
                .get("track-count")
                .and_then(Value::as_i64)
                .or_else(|| {
                    medium
                        .get("tracks")
                        .and_then(Value::as_array)
                        .map(|tracks| tracks.len() as i64)
                })
                .unwrap_or_default()
        })
        .sum()
}

fn parse_album_candidates(payload: &Value, requested_artist: &str) -> Vec<AlbumMetadataCandidate> {
    let mut result = payload
        .get("releases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|release| {
            let credits = artist_credits(release.get("artist-credit"));
            let artist = {
                let display = credit_display(&credits);
                if display.is_empty() {
                    requested_artist.to_string()
                } else {
                    display
                }
            };
            AlbumMetadataCandidate {
                id: text(release.get("id")),
                score: release
                    .get("score")
                    .and_then(Value::as_f64)
                    .unwrap_or_default(),
                title: text(release.get("title")),
                artist: artist.clone(),
                artist_credits: if credits.is_empty() {
                    fallback_credit(&artist)
                } else {
                    credits
                },
                release_group_id: optional_text(
                    release
                        .get("release-group")
                        .and_then(|value| value.get("id")),
                ),
                year: year_from(release.get("date")),
                country: optional_text(release.get("country")),
                status: optional_text(release.get("status")),
                barcode: optional_text(release.get("barcode")),
                track_count: release_track_count(release),
                disambiguation: optional_text(release.get("disambiguation")),
            }
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.year.unwrap_or(9999).cmp(&right.year.unwrap_or(9999)))
    });
    result
}

fn parse_album_release(release: &Value) -> AlbumMetadataRelease {
    let release_credits = artist_credits(release.get("artist-credit"));
    let release_artist = credit_display(&release_credits);
    let media = release
        .get("media")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut genres = release
        .get("genres")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    genres.sort_by_key(|genre| {
        std::cmp::Reverse(
            genre
                .get("count")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
        )
    });
    let labels = release
        .get("label-info")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| optional_text(entry.get("label").and_then(|value| value.get("name"))))
        .collect::<Vec<_>>();
    let mut tracks = Vec::new();
    let disc_total = media.len() as i64;
    for (medium_index, medium) in media.iter().enumerate() {
        let medium_tracks = medium
            .get("tracks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let track_total = medium
            .get("track-count")
            .and_then(Value::as_i64)
            .unwrap_or(medium_tracks.len() as i64);
        for (track_index, track) in medium_tracks.iter().enumerate() {
            let credit_source = track
                .get("artist-credit")
                .or_else(|| {
                    track
                        .get("recording")
                        .and_then(|recording| recording.get("artist-credit"))
                })
                .or_else(|| release.get("artist-credit"));
            let credits = artist_credits(credit_source);
            let artist = {
                let display = credit_display(&credits);
                if display.is_empty() {
                    release_artist.clone()
                } else {
                    display
                }
            };
            tracks.push(AlbumMetadataTrack {
                id: optional_text(track.get("id"))
                    .unwrap_or_else(|| format!("{}:{}", medium_index + 1, track_index + 1)),
                recording_id: optional_text(
                    track.get("recording").and_then(|value| value.get("id")),
                ),
                title: optional_text(track.get("title"))
                    .or_else(|| {
                        optional_text(track.get("recording").and_then(|value| value.get("title")))
                    })
                    .unwrap_or_default(),
                artist: artist.clone(),
                artist_credits: if credits.is_empty() {
                    fallback_credit(&artist)
                } else {
                    credits
                },
                track_number: track
                    .get("position")
                    .and_then(Value::as_i64)
                    .unwrap_or(track_index as i64 + 1),
                track_total,
                disc_number: medium
                    .get("position")
                    .and_then(Value::as_i64)
                    .unwrap_or(medium_index as i64 + 1),
                disc_total,
            });
        }
    }
    AlbumMetadataRelease {
        id: text(release.get("id")),
        title: text(release.get("title")),
        artist: release_artist.clone(),
        artist_credits: if release_credits.is_empty() {
            fallback_credit(&release_artist)
        } else {
            release_credits
        },
        release_group_id: optional_text(
            release
                .get("release-group")
                .and_then(|value| value.get("id")),
        ),
        year: year_from(release.get("date")),
        country: optional_text(release.get("country")),
        status: optional_text(release.get("status")),
        label: (!labels.is_empty()).then(|| labels.join(", ")),
        genre: genres
            .first()
            .and_then(|value| optional_text(value.get("name"))),
        disc_total: (disc_total > 0).then_some(disc_total),
        tracks,
    }
}

fn quoted_term(value: &str) -> String {
    format!(
        "\"{}\"",
        value.trim().replace('\\', "\\\\").replace('"', "\\\"")
    )
}

#[tauri::command(rename_all = "camelCase")]
pub async fn search_track_metadata(
    state: State<'_, MetadataOnlineState>,
    title: String,
    artist: String,
    album: Option<String>,
) -> Result<Vec<MetadataSearchCandidate>, String> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return Err("Title and artist are required to search for metadata".to_string());
    }
    let mut url = Url::parse(MUSICBRAINZ_RECORDING_SEARCH).unwrap();
    url.query_pairs_mut()
        .append_pair(
            "query",
            &format!(
                "recording:{} AND artist:{}",
                quoted_term(&title),
                quoted_term(&artist)
            ),
        )
        .append_pair("fmt", "json")
        .append_pair("limit", "10");
    let payload = state
        .musicbrainz_json(url, "MusicBrainz metadata search")
        .await?;
    Ok(parse_track_candidates(
        &payload,
        album.as_deref().unwrap_or_default(),
        &artist,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn search_album_metadata(
    state: State<'_, MetadataOnlineState>,
    album: String,
    artist: String,
) -> Result<Vec<AlbumMetadataCandidate>, String> {
    if album.trim().is_empty() || artist.trim().is_empty() {
        return Err("Album and album artist are required to search for metadata".to_string());
    }
    let mut url = Url::parse(MUSICBRAINZ_RELEASE_SEARCH).unwrap();
    url.query_pairs_mut()
        .append_pair(
            "query",
            &format!(
                "release:{} AND artist:{}",
                quoted_term(&album),
                quoted_term(&artist)
            ),
        )
        .append_pair("fmt", "json")
        .append_pair("limit", "15");
    let payload = state
        .musicbrainz_json(url, "MusicBrainz album search")
        .await?;
    Ok(parse_album_candidates(&payload, &artist))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn load_album_metadata(
    state: State<'_, MetadataOnlineState>,
    release_id: String,
) -> Result<AlbumMetadataRelease, String> {
    if Uuid::parse_str(release_id.trim()).is_err() {
        return Err("Invalid MusicBrainz release ID".to_string());
    }
    let mut url = Url::parse(&format!(
        "{MUSICBRAINZ_RELEASE_SEARCH}{}",
        release_id.trim()
    ))
    .unwrap();
    url.query_pairs_mut()
        .append_pair(
            "inc",
            "recordings+artist-credits+release-groups+labels+genres",
        )
        .append_pair("fmt", "json");
    let payload = state
        .musicbrainz_json(url, "MusicBrainz album lookup")
        .await?;
    Ok(parse_album_release(&payload))
}

fn normalize_name(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn artist_parts(value: &str) -> Vec<String> {
    let mut normalized = normalize_name(value);
    if matches!(normalized.as_str(), "va" | "v.a.") {
        return vec!["various artists".into()];
    }
    for marker in [" featuring ", " feat. ", " feat ", " ft. ", " ft "] {
        normalized = normalized.replace(marker, ",");
    }
    let mut values = normalized
        .split(|ch| matches!(ch, ',' | ';' | '&'))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if matches!(value, "va" | "v.a.") {
                "various artists".into()
            } else {
                value.to_string()
            }
        })
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn secure_cover_archive_url(value: &str) -> Option<Url> {
    let mut url = Url::parse(value).ok()?;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    is_cover_archive_image(&url).then_some(url)
}

fn is_cover_archive_image(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    url.scheme() == "https"
        && (host == "coverartarchive.org"
            || host.ends_with(".coverartarchive.org")
            || host == "archive.org"
            || host.ends_with(".archive.org"))
}

fn is_deezer_image(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("cdn-images.dzcdn.net")
}
fn is_brave_image(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("imgs.search.brave.com")
}
fn is_brave_source(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("search.brave.com") && url.path() == "/images"
}

fn cover_archive_image(payload: &Value) -> Option<String> {
    let mut images = payload.get("images")?.as_array()?.clone();
    images.sort_by_key(|image| {
        std::cmp::Reverse((
            image.get("front").and_then(Value::as_bool).unwrap_or(false),
            image
                .get("approved")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ))
    });
    let image = images.first()?;
    let result = [
        image.pointer("/thumbnails/1200"),
        image.pointer("/thumbnails/large"),
        image.pointer("/thumbnails/500"),
        image.get("image"),
        image.pointer("/thumbnails/250"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find_map(|value| secure_cover_archive_url(value).map(|url| url.to_string()));
    result
}

#[derive(Clone)]
struct CoverIdentity {
    key: String,
    kind: String,
    id: String,
}

fn identity_for_ids(release_group: Option<&str>, release: Option<&str>) -> Option<CoverIdentity> {
    if let Some(id) = release_group.filter(|id| Uuid::parse_str(id).is_ok()) {
        return Some(CoverIdentity {
            key: format!("{COVER_CACHE_VERSION}:release-group:{}", id.to_lowercase()),
            kind: "release-group".into(),
            id: id.into(),
        });
    }
    release
        .filter(|id| Uuid::parse_str(id).is_ok())
        .map(|id| CoverIdentity {
            key: format!("{COVER_CACHE_VERSION}:release:{}", id.to_lowercase()),
            kind: "release".into(),
            id: id.into(),
        })
}

fn metadata_identity(album: &str, artist: &str) -> Option<CoverIdentity> {
    let album = normalize_name(album);
    let artist = normalize_name(artist);
    if album.is_empty() || artist.is_empty() {
        return None;
    }
    let hash = hex::encode(Sha256::digest(format!("{artist}\0{album}").as_bytes()));
    Some(CoverIdentity {
        key: format!("{COVER_CACHE_VERSION}:metadata:{hash}"),
        kind: "metadata".into(),
        id: format!("metadata:{hash}"),
    })
}

#[derive(Debug)]
struct CachedCover {
    status: String,
    full: Option<String>,
    thumb: Option<String>,
    source: Option<String>,
    fetched: i64,
}

fn open_db(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    super::database::ensure_schema(&conn)?;
    Ok(conn)
}
fn read_cache(path: &str, key: &str) -> Result<Option<CachedCover>, String> {
    open_db(path)?.query_row("SELECT status,full_path,thumb_path,source_url,fetched_at FROM album_cover_cache WHERE cover_key=?1", [key], |row| Ok(CachedCover { status: row.get(0)?, full: row.get(1)?, thumb: row.get(2)?, source: row.get(3)?, fetched: row.get(4)? })).optional().map_err(|e| e.to_string())
}
fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}
fn cached_result(cached: &CachedCover) -> Option<FetchedCoverArt> {
    let full = cached.full.as_ref()?;
    let thumb = cached.thumb.as_ref()?;
    if cached.status != "ready" || !Path::new(full).is_file() || !Path::new(thumb).is_file() {
        return None;
    }
    let provider = cached
        .source
        .as_deref()
        .and_then(|value| Url::parse(value).ok())
        .map(|url| {
            if url
                .host_str()
                .is_some_and(|host| host.ends_with("deezer.com"))
            {
                "deezer"
            } else {
                "cover-art-archive"
            }
            .to_string()
        });
    Some(FetchedCoverArt {
        full_path: full.clone(),
        thumb_path: thumb.clone(),
        source_url: cached.source.clone(),
        provider,
    })
}
fn negative_fresh(cached: &CachedCover) -> bool {
    cached.status == "not-found" && now_seconds() - cached.fetched < NOT_FOUND_TTL_SECONDS
}
fn write_cache(
    path: &str,
    identity: &CoverIdentity,
    result: Option<&FetchedCoverArt>,
) -> Result<(), String> {
    open_db(path)?.execute("INSERT INTO album_cover_cache(cover_key,kind,musicbrainz_id,status,full_path,thumb_path,source_url,fetched_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(cover_key) DO UPDATE SET kind=excluded.kind,musicbrainz_id=excluded.musicbrainz_id,status=excluded.status,full_path=excluded.full_path,thumb_path=excluded.thumb_path,source_url=excluded.source_url,fetched_at=excluded.fetched_at", params![identity.key,identity.kind,identity.id,if result.is_some(){"ready"}else{"not-found"},result.map(|r|&r.full_path),result.map(|r|&r.thumb_path),result.and_then(|r|r.source_url.as_ref()),now_seconds()]).map_err(|e|e.to_string())?;
    Ok(())
}

fn cache_image(bytes: &[u8], cache_dir: &Path) -> Result<(String, String), String> {
    let hash = hex::encode(&Sha256::digest(bytes)[..8]);
    let full = cache_dir.join(format!("{hash}_v2_full.jpg"));
    let thumb = cache_dir.join(format!("{hash}_v2_thumb.jpg"));
    if full.is_file() && thumb.is_file() {
        return Ok((
            full.to_string_lossy().into_owned(),
            thumb.to_string_lossy().into_owned(),
        ));
    }
    fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let image =
        image::load_from_memory(bytes).map_err(|e| format!("Invalid album cover image: {e}"))?;
    let (width, height) = image.dimensions();
    let full_image = if width > 1600 || height > 1600 {
        image.resize(1600, 1600, FilterType::Lanczos3)
    } else {
        image.clone()
    };
    write_jpeg(&full_image, &full, 92)?;
    let thumb_image = image.resize_to_fill(192, 192, FilterType::Lanczos3);
    write_jpeg(&thumb_image, &thumb, 86)?;
    Ok((
        full.to_string_lossy().into_owned(),
        thumb.to_string_lossy().into_owned(),
    ))
}
fn write_jpeg(image: &DynamicImage, path: &Path, quality: u8) -> Result<(), String> {
    let rgba = image.to_rgba8();
    let mut black = RgbaImage::from_pixel(rgba.width(), rgba.height(), Rgba([0, 0, 0, 255]));
    overlay(&mut black, &rgba, 0, 0);
    let rgb = DynamicImage::ImageRgba8(black).to_rgb8();
    let mut bytes = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .write_image(
            &rgb,
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;
    fs::write(path, bytes.into_inner()).map_err(|e| e.to_string())
}

async fn search_release_group(
    state: &MetadataOnlineState,
    album: &str,
    artist: &str,
) -> Result<Option<CoverIdentity>, String> {
    let mut url = Url::parse(MUSICBRAINZ_RELEASE_GROUP_SEARCH).unwrap();
    url.query_pairs_mut()
        .append_pair(
            "query",
            &format!(
                "releasegroup:{} AND artist:{}",
                quoted_term(album),
                quoted_term(artist)
            ),
        )
        .append_pair("fmt", "json")
        .append_pair("limit", "5");
    let payload = state
        .musicbrainz_json(url, "MusicBrainz cover lookup")
        .await?;
    let candidates = payload
        .get("release-groups")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected = candidates
        .iter()
        .find(|c| {
            normalize_name(&text(c.get("title"))) == normalize_name(album)
                && c.get("score").and_then(Value::as_i64).unwrap_or_default() >= 80
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|c| c.get("score").and_then(Value::as_i64).unwrap_or_default() >= 90)
        });
    Ok(selected
        .and_then(|c| valid_mb_id(c.get("id")))
        .and_then(|id| identity_for_ids(Some(&id), None)))
}
async fn archive_cover(
    state: &MetadataOnlineState,
    identity: &CoverIdentity,
) -> Result<Option<FetchedCoverArt>, String> {
    let url = Url::parse(&format!(
        "{COVER_ART_ARCHIVE_ROOT}/{}/{}",
        identity.kind, identity.id
    ))
    .unwrap();
    let response = state
        .client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Cover Art Archive request failed ({})",
            response.status().as_u16()
        ));
    }
    let payload = response.json::<Value>().await.map_err(|e| e.to_string())?;
    let Some(image_url) = cover_archive_image(&payload) else {
        return Ok(None);
    };
    let bytes = state
        .download_allowed_image(&image_url, is_cover_archive_image, "Cover Art Archive")
        .await?;
    let (full, thumb) = cache_image(&bytes, &state.cache_dir)?;
    Ok(Some(FetchedCoverArt {
        full_path: full,
        thumb_path: thumb,
        source_url: Some(image_url),
        provider: Some("cover-art-archive".into()),
    }))
}
async fn deezer_cover(
    state: &MetadataOnlineState,
    album: &str,
    artist: &str,
) -> Result<Option<FetchedCoverArt>, String> {
    if album.trim().is_empty() || artist.trim().is_empty() {
        return Ok(None);
    }
    let mut url = Url::parse(DEEZER_ALBUM_SEARCH).unwrap();
    url.query_pairs_mut()
        .append_pair("q", &format!("{} {}", album.trim(), artist.trim()))
        .append_pair("limit", "15");
    let response = state
        .client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Deezer cover lookup failed ({})",
            response.status().as_u16()
        ));
    }
    let payload = response.json::<Value>().await.map_err(|e| e.to_string())?;
    if payload.get("error").is_some() {
        return Err("Deezer cover lookup failed".into());
    }
    let selected = payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|c| {
            normalize_name(&text(c.get("title"))) == normalize_name(album)
                && artist_parts(&text(c.get("artist").and_then(|a| a.get("name"))))
                    == artist_parts(artist)
                && c.get("id").and_then(Value::as_i64).is_some_and(|id| id > 0)
                && [c.get("cover_xl"), c.get("cover_big"), c.get("cover_medium")]
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(|value| Url::parse(value).ok().as_ref().is_some_and(is_deezer_image))
        });
    let Some(selected) = selected else {
        return Ok(None);
    };
    let image_url = [
        selected.get("cover_xl"),
        selected.get("cover_big"),
        selected.get("cover_medium"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find(|v| Url::parse(v).ok().as_ref().is_some_and(is_deezer_image))
    .ok_or_else(|| "Deezer returned an invalid image URL".to_string())?;
    let bytes = state
        .download_allowed_image(image_url, is_deezer_image, "Deezer")
        .await?;
    let (full, thumb) = cache_image(&bytes, &state.cache_dir)?;
    let id = selected
        .get("id")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    Ok(Some(FetchedCoverArt {
        full_path: full,
        thumb_path: thumb,
        source_url: Some(format!("https://www.deezer.com/album/{id}")),
        provider: Some("deezer".into()),
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_track_cover_art(
    state: State<'_, MetadataOnlineState>,
    db_path: String,
    track_id: String,
    album: Option<String>,
    artist: Option<String>,
) -> Result<Option<FetchedCoverArt>, String> {
    let row=open_db(&db_path)?.query_row("SELECT artist,album_artist,album,musicbrainz_albumid,musicbrainz_releasegroupid FROM tracks WHERE id=?1",[track_id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?))).optional().map_err(|e|e.to_string())?.ok_or_else(||"Track was not found in the library".to_string())?;
    let album = album
        .filter(|v| !v.trim().is_empty())
        .or(row.2)
        .unwrap_or_default();
    let artist = artist
        .filter(|v| !v.trim().is_empty())
        .or(row.1)
        .or(row.0)
        .unwrap_or_default();
    let metadata = metadata_identity(&album, &artist);
    let mut archive = identity_for_ids(row.4.as_deref(), row.3.as_deref());
    let mut release_error = None;
    if archive.is_none() {
        if let Some(identity) = metadata.as_ref() {
            if let Some(cached) = read_cache(&db_path, &identity.key)? {
                if let Some(result) = cached_result(&cached) {
                    return Ok(Some(result));
                }
                if negative_fresh(&cached) {
                    return Ok(None);
                }
            }
        }
        match search_release_group(&state, &album, &artist).await {
            Ok(found) => archive = found,
            Err(error) => release_error = Some(error),
        }
    }
    let Some(identity) = archive.clone().or(metadata) else {
        return Ok(None);
    };
    if let Some(cached) = read_cache(&db_path, &identity.key)? {
        if let Some(result) = cached_result(&cached) {
            return Ok(Some(result));
        }
        if negative_fresh(&cached) {
            return Ok(None);
        }
    }
    let mut archive_error = None;
    let mut result = None;
    if let Some(archive) = archive.as_ref() {
        match archive_cover(&state, archive).await {
            Ok(value) => result = value,
            Err(error) => archive_error = Some(error),
        }
    }
    if result.is_none() {
        result = deezer_cover(&state, &album, &artist).await?
    }
    if result.is_none() {
        if let Some(error) = archive_error {
            return Err(error);
        }
        if let Some(error) = release_error {
            return Err(error);
        }
    }
    write_cache(&db_path, &identity, result.as_ref())?;
    Ok(result)
}

fn clean_candidate(value: Option<&Value>, limit: usize) -> Option<String> {
    let raw = text(value);
    let mut output = String::new();
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    let output = output
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!output.is_empty()).then(|| output.chars().take(limit).collect())
}
fn parse_brave_candidates(payload: &Value, search_url: &str) -> Vec<AlbumCoverCandidate> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for (index, item) in payload
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(image_url) = item
            .pointer("/thumbnail/src")
            .and_then(Value::as_str)
            .and_then(|v| Url::parse(v).ok())
            .filter(is_brave_image)
            .map(|v| v.to_string())
        else {
            continue;
        };
        if !seen.insert(image_url.clone()) {
            continue;
        }
        let width = item
            .pointer("/properties/width")
            .and_then(Value::as_i64)
            .filter(|v| *v > 0);
        let height = item
            .pointer("/properties/height")
            .and_then(Value::as_i64)
            .filter(|v| *v > 0);
        let confidence = match text(item.get("confidence")).to_lowercase().as_str() {
            "high" => 3,
            "medium" => 2,
            "low" => 1,
            _ => 0,
        };
        let square = match (width, height) {
            (Some(w), Some(h)) => {
                (1000.0 * (1.0 - (w as f64 / h as f64 - 1.0).abs()).max(0.0)).round() as i64
            }
            _ => 0,
        };
        result.push(AlbumCoverCandidate {
            id: hex::encode(Sha256::digest(
                format!("brave-cover:{image_url}").as_bytes(),
            )),
            provider: "brave-search".into(),
            image_url,
            source_url: search_url.into(),
            source_name: clean_candidate(
                item.get("source")
                    .or_else(|| item.pointer("/meta_url/hostname")),
                200,
            ),
            title: clean_candidate(item.get("title"), 500),
            width,
            height,
            score: Some(confidence * 10_000 + square - index as i64),
        })
    }
    result.sort_by_key(|c| std::cmp::Reverse(c.score.unwrap_or_default()));
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn search_album_cover_images(
    state: State<'_, MetadataOnlineState>,
    album: String,
    artist: String,
    brave_search_api_key: String,
) -> Result<Vec<AlbumCoverCandidate>, String> {
    let album = album.replace('"', " ").trim().to_string();
    let artist = artist.replace('"', " ").trim().to_string();
    let key = brave_search_api_key.trim();
    if album.is_empty() || artist.is_empty() || key.is_empty() {
        return Ok(Vec::new());
    }
    let query = format!("\"{artist}\" \"{album}\" album cover artwork");
    let mut url = Url::parse(BRAVE_IMAGE_SEARCH).unwrap();
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("country", "ALL")
        .append_pair("search_lang", "en")
        .append_pair("count", "15")
        .append_pair("safesearch", "strict");
    let response = state
        .client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("X-Subscription-Token", key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err("The Brave Search API key was rejected".into());
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err("The Brave Image Search rate limit was reached".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Brave Image Search failed ({})",
            response.status().as_u16()
        ));
    }
    let payload = response.json::<Value>().await.map_err(|e| e.to_string())?;
    let mut source = Url::parse("https://search.brave.com/images").unwrap();
    source.query_pairs_mut().append_pair("q", &query);
    Ok(parse_brave_candidates(&payload, source.as_str()))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cache_album_cover_candidate(
    state: State<'_, MetadataOnlineState>,
    candidate: AlbumCoverCandidate,
) -> Result<FetchedCoverArt, String> {
    if candidate.provider != "brave-search" {
        return Err("The album cover provider is not allowed".into());
    }
    let image = Url::parse(&candidate.image_url)
        .map_err(|_| "The selected album cover URL is not allowed".to_string())?;
    let source = Url::parse(&candidate.source_url)
        .map_err(|_| "The selected album cover URL is not allowed".to_string())?;
    if !is_brave_image(&image) || !is_brave_source(&source) {
        return Err("The selected album cover URL is not allowed".into());
    }
    let bytes = state
        .download_allowed_image(image.as_str(), is_brave_image, "Brave Search")
        .await?;
    let (full, thumb) = cache_image(&bytes, &state.cache_dir)?;
    Ok(FetchedCoverArt {
        full_path: full,
        thumb_path: thumb,
        source_url: Some(source.to_string()),
        provider: Some("brave-search".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn provider_allowlists_reject_spoofed_hosts() {
        assert!(is_cover_archive_image(
            &Url::parse("https://archive.org/file.jpg").unwrap()
        ));
        assert!(!is_cover_archive_image(
            &Url::parse("https://archive.org.evil.test/file.jpg").unwrap()
        ));
        assert!(is_brave_image(
            &Url::parse("https://imgs.search.brave.com/a.jpg").unwrap()
        ));
        assert!(!is_brave_source(
            &Url::parse("https://search.brave.com.evil.test/images").unwrap()
        ));
    }
    #[test]
    fn track_results_prefer_exact_album_then_score() {
        let payload = json!({"recordings":[{"id":"r1","title":"Song","score":99,"artist-credit":[{"name":"Artist","artist":{"name":"Artist"}}],"releases":[{"id":"other","title":"Other","date":"2020"},{"id":"wanted","title":"Wanted","date":"2022"}]}]});
        let parsed = parse_track_candidates(&payload, "Wanted", "Artist");
        assert_eq!(parsed[0].release_id.as_deref(), Some("wanted"));
        assert!(parsed[0].album_match);
    }
    #[test]
    fn album_release_flattens_discs_and_preserves_credits() {
        let payload = json!({"id":"release","title":"Album","artist-credit":[{"name":"A","joinphrase":" & ","artist":{"name":"Artist A","id":"123e4567-e89b-12d3-a456-426614174000"}},{"name":"B","artist":{"name":"Artist B"}}],"media":[{"position":1,"track-count":1,"tracks":[{"id":"t1","position":1,"title":"Song","recording":{"id":"r1"}}]}]});
        let parsed = parse_album_release(&payload);
        assert_eq!(parsed.artist, "A & B");
        assert_eq!(parsed.tracks.len(), 1);
        assert_eq!(parsed.tracks[0].disc_total, 1);
    }
    #[test]
    fn brave_candidates_are_deduplicated_and_square_ranked() {
        let payload = json!({"results":[{"thumbnail":{"src":"https://imgs.search.brave.com/a.jpg"},"properties":{"width":500,"height":500},"confidence":"high"},{"thumbnail":{"src":"https://imgs.search.brave.com/a.jpg"},"confidence":"low"},{"thumbnail":{"src":"https://evil.test/b.jpg"},"confidence":"high"}]});
        let parsed = parse_brave_candidates(&payload, "https://search.brave.com/images?q=x");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].score, Some(31_000));
    }
}
