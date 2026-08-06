//! Native waveform generation with the Electron cache contract.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};
use tauri::Manager;

const CACHE_VERSION: u32 = 1;
const DEFAULT_POINTS: usize = 512;
const MIN_POINTS: usize = 32;
const MAX_POINTS: usize = 1024;
const WAVEFORM_RATE: usize = 8_000;
const FRAMES_PER_PEAK: usize = 256;

#[derive(Debug, Serialize)]
pub struct WaveformResult {
    peaks: Vec<f32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheRecord {
    version: u32,
    points: usize,
    source_size: u64,
    source_mtime_ms: u128,
    peaks: Vec<f32>,
}

fn normalize_points(points: Option<usize>) -> usize {
    points
        .unwrap_or(DEFAULT_POINTS)
        .clamp(MIN_POINTS, MAX_POINTS)
}

fn source_key(path: &Path) -> String {
    let absolute = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let normalized = if cfg!(windows) {
        absolute.to_string_lossy().to_lowercase()
    } else {
        absolute.to_string_lossy().into_owned()
    };
    hex::encode(Sha256::digest(normalized.as_bytes()))
}

fn source_metadata(path: &Path) -> Result<(u64, u128), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect waveform source: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("Waveform source is not a file: {}", path.display()));
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("Could not read waveform source timestamp: {error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Invalid waveform source timestamp: {error}"))?
        .as_millis();
    Ok((metadata.len(), modified))
}

fn read_cache(path: &Path, size: u64, mtime_ms: u128, points: usize) -> Option<Vec<f32>> {
    let record: CacheRecord = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (record.version == CACHE_VERSION
        && record.points == points
        && record.source_size == size
        && record.source_mtime_ms == mtime_ms
        && record.peaks.iter().all(|peak| peak.is_finite()))
    .then_some(record.peaks)
}

fn write_cache(path: &Path, record: &CacheRecord) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Waveform cache has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create waveform cache: {error}"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec(record)
        .map_err(|error| format!("Could not encode waveform cache: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write waveform cache: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace waveform cache: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not finalize waveform cache: {error}"));
    }
    Ok(())
}

fn resize_envelope(source: &[f32], points: usize) -> Vec<f32> {
    let mut result = vec![0.0; points];
    if source.is_empty() {
        return result;
    }
    if source.len() >= points {
        for (point, output) in result.iter_mut().enumerate() {
            let begin = point * source.len() / points;
            let end = ((point + 1) * source.len() / points).max(begin + 1);
            let energy = source[begin..end]
                .iter()
                .map(|value| f64::from(*value).powi(2))
                .sum::<f64>();
            *output = (energy / (end - begin) as f64).sqrt() as f32;
        }
    } else if source.len() == 1 {
        result.fill(source[0]);
    } else {
        for (point, output) in result.iter_mut().enumerate() {
            let position = point as f64 * (source.len() - 1) as f64 / (points - 1) as f64;
            let left = position.floor() as usize;
            let right = (left + 1).min(source.len() - 1);
            let fraction = (position - left as f64) as f32;
            *output = source[left] * (1.0 - fraction) + source[right] * fraction;
        }
    }

    let mut sorted = result.clone();
    sorted.sort_by(f32::total_cmp);
    let maximum = *sorted.last().unwrap_or(&0.0);
    if maximum <= 0.000_01 {
        return result;
    }
    let percentile = sorted[(sorted.len() - 1) * 95 / 100];
    let reference = if percentile > 0.000_01 {
        percentile
    } else {
        maximum
    };
    for peak in &mut result {
        *peak = (*peak / reference).clamp(0.0, 1.0).powf(1.35);
    }
    result
}

fn decode_envelope(path: &Path) -> Result<Vec<f32>, String> {
    let file = File::open(path).map_err(|error| format!("Could not open audio file: {error}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| format!("Could not probe audio file: {error}"))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "Could not find an audio stream".to_string())?;
    let track_id = track.id;
    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| format!("Could not create audio decoder: {error}"))?;

    let mut block_peaks = Vec::new();
    let mut block_energy = 0.0_f64;
    let mut block_frames = 0_usize;
    let mut decoded_frames = 0_u64;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(format!("Could not read audio packet: {error}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(format!("Could not decode audio packet: {error}")),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count();
        if channels == 0 || spec.rate == 0 {
            return Err("The audio stream has invalid channel or sample-rate data".to_string());
        }
        // 256 frames at 8 kHz matches the native KeyFinder envelope cadence.
        let frames_per_block = ((spec.rate as usize * FRAMES_PER_PEAK) / WAVEFORM_RATE).max(1);
        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        for frame in samples.samples().chunks_exact(channels) {
            block_energy += frame
                .iter()
                .map(|sample| f64::from(*sample).powi(2))
                .sum::<f64>()
                / channels as f64;
            block_frames += 1;
            decoded_frames += 1;
            if block_frames == frames_per_block {
                block_peaks.push((block_energy / block_frames as f64).sqrt() as f32);
                block_energy = 0.0;
                block_frames = 0;
            }
        }
    }
    if block_frames > 0 {
        block_peaks.push((block_energy / block_frames as f64).sqrt() as f32);
    }
    if decoded_frames == 0 {
        return Err("No decodable audio frames were found".to_string());
    }
    Ok(block_peaks)
}

#[tauri::command(rename_all = "camelCase")]
pub fn generate_track_waveform(
    app: tauri::AppHandle,
    source_path: String,
    points: Option<usize>,
) -> Result<WaveformResult, String> {
    let source = PathBuf::from(source_path);
    let points = normalize_points(points);
    let (source_size, source_mtime_ms) = source_metadata(&source)?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve waveform cache: {error}"))?
        .join("waveforms");
    let cache_path = cache_dir.join(format!("{}-{points}.json", source_key(&source)));
    if let Some(peaks) = read_cache(&cache_path, source_size, source_mtime_ms, points) {
        return Ok(WaveformResult { peaks });
    }

    let peaks = resize_envelope(&decode_envelope(&source)?, points);
    let record = CacheRecord {
        version: CACHE_VERSION,
        points,
        source_size,
        source_mtime_ms,
        peaks: peaks.clone(),
    };
    // A cache failure must not make an otherwise valid waveform unusable.
    let _ = write_cache(&cache_path, &record);
    Ok(WaveformResult { peaks })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_are_clamped_to_contract() {
        assert_eq!(normalize_points(None), 512);
        assert_eq!(normalize_points(Some(1)), 32);
        assert_eq!(normalize_points(Some(2_000)), 1_024);
    }

    #[test]
    fn envelope_is_normalized_and_preserves_dynamics() {
        let mut source = vec![0.05; 100];
        source.extend(vec![0.8; 100]);
        let result = resize_envelope(&source, 64);
        assert_eq!(result.len(), 64);
        assert!(result.iter().all(|value| (0.0..=1.0).contains(value)));
        let quiet = result[..32].iter().sum::<f32>() / 32.0;
        let loud = result[32..].iter().sum::<f32>() / 32.0;
        assert!(loud > quiet * 3.0);
    }

    #[test]
    fn silence_remains_flat() {
        assert!(resize_envelope(&vec![0.0; 100], 32)
            .iter()
            .all(|value| *value == 0.0));
    }
}
