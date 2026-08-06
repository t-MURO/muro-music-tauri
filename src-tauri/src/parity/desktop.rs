use arboard::{Clipboard, ImageData};
use image::{imageops::FilterType, RgbaImage};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::mpsc::channel,
};
use tauri::{AppHandle, Manager, Runtime, Window};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAX_CLIPBOARD_PIXELS: usize = 100_000_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedClipboardCover {
    pub full_path: String,
    pub thumb_path: String,
}

pub fn clipboard_has_image() -> Result<bool, String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    match clipboard.get_image() {
        Ok(image) => Ok(image.width > 0 && image.height > 0 && !image.bytes.is_empty()),
        Err(arboard::Error::ContentNotAvailable) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub fn cache_clipboard_cover_art<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<CachedClipboardCover>, String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    let data = match clipboard.get_image() {
        Ok(data) => data,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let pixels = data
        .width
        .checked_mul(data.height)
        .ok_or_else(|| "Clipboard image dimensions are invalid".to_string())?;
    if pixels == 0 || pixels > MAX_CLIPBOARD_PIXELS || data.bytes.len() != pixels * 4 {
        return Err("Clipboard image is empty, too large, or malformed".to_string());
    }
    let width = u32::try_from(data.width).map_err(|_| "Clipboard image is too wide")?;
    let height = u32::try_from(data.height).map_err(|_| "Clipboard image is too tall")?;
    let rgba = RgbaImage::from_raw(width, height, data.bytes.into_owned())
        .ok_or_else(|| "Clipboard image data is invalid".to_string())?;
    let digest = hex::encode(Sha256::digest(rgba.as_raw()));
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("covers");
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let full_path = cache_dir.join(format!("clipboard-{digest}.png"));
    let thumb_path = cache_dir.join(format!("clipboard-{digest}-thumb.png"));
    if !full_path.exists() {
        rgba.save(&full_path).map_err(|error| error.to_string())?;
    }
    if !thumb_path.exists() {
        image::DynamicImage::ImageRgba8(rgba)
            .resize(256, 256, FilterType::Lanczos3)
            .save(&thumb_path)
            .map_err(|error| error.to_string())?;
    }
    Ok(Some(CachedClipboardCover {
        full_path: full_path.to_string_lossy().into_owned(),
        thumb_path: thumb_path.to_string_lossy().into_owned(),
    }))
}

pub fn copy_image_to_clipboard(file_path: String) -> Result<bool, String> {
    let path = Path::new(&file_path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Artwork file does not exist".to_string());
    }
    let rgba = image::open(path)
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let (width, height) = rgba.dimensions();
    Clipboard::new()
        .map_err(|error| error.to_string())?
        .set_image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn is_allowed_external_host(host: &str) -> bool {
    host == "musicbrainz.org"
        || host.ends_with(".wikipedia.org")
        || host == "commons.wikimedia.org"
        || host == "www.last.fm"
        || host == "www.theaudiodb.com"
        || host == "fanart.tv"
        || host.ends_with(".fanart.tv")
        || host == "www.deezer.com"
        || host == "search.brave.com"
        || host == "api.search.brave.com"
        || host == "api-dashboard.search.brave.com"
        || host == "acoustid.org"
        || host.ends_with(".acoustid.org")
}

pub fn open_external<R: Runtime>(app: AppHandle<R>, value: String) -> Result<(), String> {
    let url = Url::parse(&value).map_err(|_| "External URL is invalid".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "External URL is not allowed".to_string())?;
    if url.scheme() != "https" || !is_allowed_external_host(host) {
        return Err("External URL is not allowed".to_string());
    }
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn show_item_in_folder<R: Runtime>(app: AppHandle<R>, file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Track source file does not exist".to_string());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

pub async fn start_file_drag<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for value in file_paths.into_iter().take(1_000) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if canonical.is_file() && seen.insert(canonical.clone()) {
            files.push(canonical);
        }
    }
    if files.is_empty() {
        return Err("No valid track files were provided for dragging".to_string());
    }

    let (sender, receiver) = channel();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "linux")]
        let raw_window = window.gtk_window();
        #[cfg(not(target_os = "linux"))]
        let raw_window: tauri::Result<Window<R>> = Ok(window.clone());

        let result = match raw_window {
            Ok(raw_window) => drag::start_drag(
                &raw_window,
                drag::DragItem::Files(files),
                drag::Image::Raw(include_bytes!("../../icons/128x128.png").to_vec()),
                |_result, _cursor_position| {},
                drag::Options::default(),
            )
            .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;

    receiver
        .recv()
        .map_err(|_| "Native file drag stopped unexpectedly".to_string())?
}
#[cfg(test)]
mod tests {
    use super::is_allowed_external_host;
    #[test]
    fn allowlist_rejects_suffix_confusion() {
        assert!(is_allowed_external_host("en.wikipedia.org"));
        assert!(!is_allowed_external_host("musicbrainz.org.example.com"));
        assert!(!is_allowed_external_host("example.com"));
    }
}
