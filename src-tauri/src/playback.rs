use parking_lot::Mutex;
use rodio::{source::SeekError, OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, PlatformConfig};
use std::collections::VecDeque;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use symphonia::default::{get_codecs, get_probe};
use tauri::{AppHandle, Emitter};

/// Global media controls - stored globally since souvlaki requires it to stay alive
static MEDIA_CONTROLS: Mutex<Option<MediaControls>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
pub struct PlaybackState {
    pub is_playing: bool,
    pub current_position: f64,
    pub duration: f64,
    pub volume: f64,
    pub current_track: Option<CurrentTrack>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CurrentTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub source_path: String,
    pub cover_art_path: Option<String>,
    pub cover_art_thumb_path: Option<String>,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            is_playing: false,
            current_position: 0.0,
            duration: 0.0,
            volume: 0.8,
            current_track: None,
        }
    }
}

#[derive(Debug)]
pub enum PlaybackCommand {
    PlayFile {
        track: CurrentTrack,
        duration_hint: f64,
    },
    Toggle,
    Play,
    Pause,
    Stop,
    Seek(f64),
    SetSeekMode(SeekModePreference),
    SetVolume(f64),
    GetState(std::sync::mpsc::Sender<PlaybackState>),
    IsFinished(std::sync::mpsc::Sender<bool>),
}

const DEFAULT_SEEK_MODE: SeekModePreference = SeekModePreference::Fast;
const PREBUFFER_SECONDS: f64 = 1.5;

#[derive(Debug, Clone, Copy)]
pub enum SeekModePreference {
    Fast = 0,
    Accurate = 1,
}

impl SeekModePreference {
    pub fn from_str(mode: &str) -> Self {
        match mode {
            "accurate" => Self::Accurate,
            _ => Self::Fast,
        }
    }

    fn to_symphonia(self) -> SeekMode {
        match self {
            Self::Fast => SeekMode::Coarse,
            Self::Accurate => SeekMode::Accurate,
        }
    }
}

struct SymphoniaSource {
    format: Box<dyn FormatReader + Send>,
    decoder: Box<dyn Decoder + Send>,
    track_id: u32,
    signal_spec: SignalSpec,
    sample_rate: u32,
    channels: u16,
    duration: Option<Duration>,
    buffer: VecDeque<i16>,
    prebuffer_samples: usize,
    is_exhausted: bool,
    seek_mode: Arc<AtomicU8>,
}

impl SymphoniaSource {
    fn new(
        path: &Path,
        duration_hint: f64,
        seek_mode: Arc<AtomicU8>,
    ) -> Result<(Self, f64), String> {
        let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|ext| ext.to_str()) {
            hint.with_extension(ext);
        }

        let probed = get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|e| format!("Failed to probe file: {}", e))?;

        let mut format: Box<dyn FormatReader + Send> = probed.format;
        let (track_id, codec_params, duration_frames, duration_time_base) = {
            let track = format
                .default_track()
                .ok_or_else(|| "No default audio track found".to_string())?;
            (
                track.id,
                track.codec_params.clone(),
                track.codec_params.n_frames,
                track.codec_params.time_base,
            )
        };

        let mut decoder: Box<dyn Decoder + Send> = get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|e| format!("Failed to create decoder: {}", e))?;

        let mut buffer = VecDeque::new();
        let (signal_spec, sample_rate, channels) = loop {
            let packet = format
                .next_packet()
                .map_err(|e| format!("Failed to read packet: {}", e))?;
            if packet.track_id() != track_id {
                continue;
            }
            let decoded = match decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(err) => return Err(format!("Failed to decode packet: {}", err)),
            };
            let spec = *decoded.spec();
            let mut sample_buf = SampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
            sample_buf.copy_interleaved_ref(decoded);
            buffer.extend(sample_buf.samples());
            break (spec, spec.rate, spec.channels.count() as u16);
        };
        if sample_rate == 0 || channels == 0 {
            return Err("Invalid audio stream parameters".to_string());
        }

        let prebuffer_samples =
            ((sample_rate as f64 * channels as f64 * PREBUFFER_SECONDS) as usize).max(1);

        let duration_secs = match (duration_frames, duration_time_base) {
            (Some(frames), Some(tb)) => {
                let time = tb.calc_time(frames);
                time.seconds as f64 + time.frac
            }
            _ => duration_hint,
        };

        let duration = if duration_secs > 0.0 {
            Some(Duration::from_secs_f64(duration_secs))
        } else {
            None
        };

        let mut source = Self {
            format,
            decoder,
            track_id,
            signal_spec,
            sample_rate,
            channels,
            duration,
            buffer,
            prebuffer_samples,
            is_exhausted: false,
            seek_mode,
        };

        source.fill_prebuffer()?;

        Ok((source, duration_secs))
    }

    fn current_seek_mode(&self) -> SeekMode {
        match self.seek_mode.load(Ordering::Relaxed) {
            1 => SeekModePreference::Accurate.to_symphonia(),
            _ => SeekModePreference::Fast.to_symphonia(),
        }
    }

    fn fill_prebuffer(&mut self) -> Result<(), String> {
        while self.buffer.len() < self.prebuffer_samples {
            if !self.decode_next_packet()? {
                break;
            }
        }
        Ok(())
    }

    fn decode_next_packet(&mut self) -> Result<bool, String> {
        if self.is_exhausted {
            return Ok(false);
        }

        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.is_exhausted = true;
                    return Ok(false);
                }
                Err(err) => return Err(format!("Failed to read packet: {}", err)),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(err) => return Err(format!("Failed to decode packet: {}", err)),
            };

            if *decoded.spec() != self.signal_spec {
                self.signal_spec = *decoded.spec();
                self.sample_rate = self.signal_spec.rate;
                self.channels = self.signal_spec.channels.count() as u16;
            }

            let mut sample_buf =
                SampleBuffer::<i16>::new(decoded.capacity() as u64, self.signal_spec);
            sample_buf.copy_interleaved_ref(decoded);
            self.buffer.extend(sample_buf.samples());
            return Ok(true);
        }
    }
}

impl Iterator for SymphoniaSource {
    type Item = i16;

    fn next(&mut self) -> Option<Self::Item> {
        if self.buffer.is_empty() && !self.is_exhausted {
            match self.decode_next_packet() {
                Ok(true) => {}
                Ok(false) => {
                    self.is_exhausted = true;
                }
                Err(_) => {
                    self.is_exhausted = true;
                }
            }
        }

        self.buffer.pop_front()
    }
}

impl Source for SymphoniaSource {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let time = Time::from(pos);
        let mode = self.current_seek_mode();
        self.format
            .seek(
                mode,
                SeekTo::Time {
                    time,
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|err| {
                SeekError::Other(Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Seek failed: {}", err),
                )))
            })?;
        self.decoder.reset();
        self.buffer.clear();
        self.is_exhausted = false;
        self.decode_next_packet().map_err(|err| {
            SeekError::Other(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                err,
            )))
        })?;
        Ok(())
    }
}

/// State shared with the audio thread
struct AudioThreadState {
    sink: Option<Sink>,
    _stream: Option<OutputStream>,
    stream_handle: Option<OutputStreamHandle>,
    state: PlaybackState,
    seek_mode: Arc<AtomicU8>,
    /// Position when playback started or was last seeked/paused
    position_base: f64,
    /// Instant when playback started from position_base
    playback_started_at: Option<Instant>,
}

impl Default for AudioThreadState {
    fn default() -> Self {
        Self {
            sink: None,
            _stream: None,
            stream_handle: None,
            state: PlaybackState::default(),
            seek_mode: Arc::new(AtomicU8::new(DEFAULT_SEEK_MODE as u8)),
            position_base: 0.0,
            playback_started_at: None,
        }
    }
}

impl AudioThreadState {
    /// Get the current playback position
    fn current_position(&self) -> f64 {
        if self.state.is_playing {
            if let Some(started_at) = self.playback_started_at {
                let elapsed = started_at.elapsed().as_secs_f64();
                (self.position_base + elapsed).min(self.state.duration)
            } else {
                self.position_base
            }
        } else {
            self.position_base
        }
    }
}

/// The audio player that can be stored in Tauri state
pub struct AudioPlayer {
    command_tx: Mutex<Option<Sender<PlaybackCommand>>>,
    state: Arc<Mutex<PlaybackState>>,
}

impl AudioPlayer {
    pub fn new() -> Self {
        Self {
            command_tx: Mutex::new(None),
            state: Arc::new(Mutex::new(PlaybackState::default())),
        }
    }

    pub fn init(&self, app_handle: AppHandle) {
        let (tx, rx) = mpsc::channel::<PlaybackCommand>();
        let state = Arc::clone(&self.state);

        // Store the sender
        {
            let mut cmd_tx = self.command_tx.lock();
            *cmd_tx = Some(tx);
        }

        // Spawn audio thread - this thread owns the OutputStream
        let app_for_thread = app_handle.clone();
        thread::spawn(move || {
            run_audio_thread(rx, state, app_for_thread);
        });

        // Initialize media controls on main thread
        self.init_media_controls(app_handle);
    }

    fn init_media_controls(&self, app_handle: AppHandle) {
        let config = PlatformConfig {
            dbus_name: "muro_music",
            display_name: "Muro Music",
            hwnd: None,
        };

        let tx = {
            let guard = self.command_tx.lock();
            guard.clone()
        };

        match MediaControls::new(config) {
            Ok(mut controls) => {
                let app = app_handle.clone();
                let tx_for_controls = tx.clone();

                if let Err(e) = controls.attach(move |event: MediaControlEvent| {
                    if let Some(ref tx) = tx_for_controls {
                        handle_media_event(tx, &app, event);
                    }
                }) {
                    eprintln!("Failed to attach media controls: {:?}", e);
                    return;
                }

                // Store controls in global static so we can update metadata
                let mut global_controls = MEDIA_CONTROLS.lock();
                *global_controls = Some(controls);
            }
            Err(e) => {
                eprintln!("Failed to create media controls: {:?}", e);
            }
        }
    }

    fn send_command(&self, cmd: PlaybackCommand) {
        let guard = self.command_tx.lock();
        if let Some(ref tx) = *guard {
            let _ = tx.send(cmd);
        }
    }

    pub fn play_file(&self, track: CurrentTrack, duration_hint: f64) -> Result<(), String> {
        self.send_command(PlaybackCommand::PlayFile {
            track,
            duration_hint,
        });
        Ok(())
    }

    pub fn toggle_play(&self) -> bool {
        self.send_command(PlaybackCommand::Toggle);
        // Return current state approximation
        let state = self.state.lock();
        !state.is_playing
    }

    pub fn play(&self) {
        self.send_command(PlaybackCommand::Play);
    }

    pub fn pause(&self) {
        self.send_command(PlaybackCommand::Pause);
    }

    pub fn stop(&self) {
        self.send_command(PlaybackCommand::Stop);
    }

    pub fn seek(&self, position_secs: f64) -> Result<(), String> {
        self.send_command(PlaybackCommand::Seek(position_secs));
        Ok(())
    }

    pub fn set_volume(&self, volume: f64) {
        self.send_command(PlaybackCommand::SetVolume(volume));
    }

    pub fn set_seek_mode(&self, mode: SeekModePreference) {
        self.send_command(PlaybackCommand::SetSeekMode(mode));
    }

    pub fn get_state(&self) -> PlaybackState {
        let (tx, rx) = mpsc::channel();
        self.send_command(PlaybackCommand::GetState(tx));
        rx.recv_timeout(Duration::from_millis(100))
            .unwrap_or_else(|_| self.state.lock().clone())
    }

    pub fn is_finished(&self) -> bool {
        let (tx, rx) = mpsc::channel();
        self.send_command(PlaybackCommand::IsFinished(tx));
        rx.recv_timeout(Duration::from_millis(100)).unwrap_or(true)
    }
}

fn run_audio_thread(
    rx: Receiver<PlaybackCommand>,
    shared_state: Arc<Mutex<PlaybackState>>,
    app_handle: AppHandle,
) {
    let mut audio_state = AudioThreadState::default();
    let mut last_position_emit = Instant::now();

    // Initialize audio output
    if let Ok((stream, stream_handle)) = OutputStream::try_default() {
        audio_state._stream = Some(stream);
        audio_state.stream_handle = Some(stream_handle);
    } else {
        eprintln!("Failed to initialize audio output");
        return;
    }

    loop {
        match rx.recv_timeout(Duration::from_millis(16)) {
            // ~60fps for smooth updates
            Ok(cmd) => {
                process_command(&mut audio_state, &shared_state, &app_handle, cmd);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Check if track finished
                if let Some(ref sink) = audio_state.sink {
                    if sink.empty() && audio_state.state.is_playing {
                        audio_state.state.is_playing = false;
                        audio_state.position_base = audio_state.state.duration;
                        audio_state.playback_started_at = None;
                        audio_state.state.current_position = audio_state.state.duration;
                        update_media_controls_playback(false);
                        update_shared_state(&shared_state, &audio_state.state);
                        let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
                        let _ = app_handle.emit("muro://track-ended", ());
                    }
                }

                // Emit position updates periodically while playing (every 100ms)
                if audio_state.state.is_playing
                    && last_position_emit.elapsed() >= Duration::from_millis(100)
                {
                    let pos = audio_state.current_position();
                    audio_state.state.current_position = pos;
                    update_shared_state(&shared_state, &audio_state.state);
                    let _ = app_handle.emit("muro://playback-position", pos);
                    last_position_emit = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }
}

fn open_symphonia_source(
    path: &Path,
    duration_hint: f64,
    seek_mode: Arc<AtomicU8>,
) -> Result<(SymphoniaSource, f64), String> {
    SymphoniaSource::new(path, duration_hint, seek_mode)
}

fn process_command(
    audio_state: &mut AudioThreadState,
    shared_state: &Arc<Mutex<PlaybackState>>,
    app_handle: &AppHandle,
    cmd: PlaybackCommand,
) {
    match cmd {
        PlaybackCommand::PlayFile {
            track,
            duration_hint,
        } => {
            let path = Path::new(&track.source_path);
            if !path.exists() {
                eprintln!("File not found: {}", track.source_path);
                return;
            }

            let (source, duration_secs) = match open_symphonia_source(
                path,
                duration_hint,
                Arc::clone(&audio_state.seek_mode),
            ) {
                Ok((source, duration)) => (source, duration),
                Err(error) => {
                    eprintln!("{}", error);
                    return;
                }
            };

            let stream_handle = match audio_state.stream_handle.as_ref() {
                Some(h) => h,
                None => {
                    eprintln!("Audio output not initialized");
                    return;
                }
            };

            let sink = match Sink::try_new(stream_handle) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("Failed to create sink: {}", e);
                    return;
                }
            };

            sink.set_volume(audio_state.state.volume as f32);
            sink.append(source);

            audio_state.sink = Some(sink);
            audio_state.position_base = 0.0;
            audio_state.playback_started_at = Some(Instant::now());
            audio_state.state.is_playing = true;
            audio_state.state.duration = duration_secs;
            audio_state.state.current_position = 0.0;
            audio_state.state.current_track = Some(track.clone());

            // Update media controls
            update_media_controls_metadata(&track, duration_secs);
            update_media_controls_playback(true);

            update_shared_state(shared_state, &audio_state.state);
            let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
        }

        PlaybackCommand::Toggle => {
            // Calculate current position first
            let current_pos = audio_state.current_position();

            if let Some(ref sink) = audio_state.sink {
                if sink.is_paused() {
                    sink.play();
                    audio_state.state.is_playing = true;
                    audio_state.position_base = current_pos;
                    audio_state.playback_started_at = Some(Instant::now());
                } else {
                    sink.pause();
                    audio_state.state.is_playing = false;
                    audio_state.position_base = current_pos;
                    audio_state.playback_started_at = None;
                }
                audio_state.state.current_position = current_pos;
                update_media_controls_playback(audio_state.state.is_playing);
                update_shared_state(shared_state, &audio_state.state);
                let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
            }
        }

        PlaybackCommand::Play => {
            if let Some(ref sink) = audio_state.sink {
                sink.play();
                audio_state.state.is_playing = true;
                audio_state.playback_started_at = Some(Instant::now());
                update_media_controls_playback(true);
                update_shared_state(shared_state, &audio_state.state);
                let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
            }
        }

        PlaybackCommand::Pause => {
            // Calculate current position first
            let current_pos = audio_state.current_position();

            if let Some(ref sink) = audio_state.sink {
                sink.pause();
                audio_state.state.is_playing = false;
                audio_state.position_base = current_pos;
                audio_state.playback_started_at = None;
                audio_state.state.current_position = current_pos;
                update_media_controls_playback(false);
                update_shared_state(shared_state, &audio_state.state);
                let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
            }
        }

        PlaybackCommand::Stop => {
            if let Some(ref sink) = audio_state.sink {
                sink.stop();
            }
            audio_state.sink = None;
            audio_state.state.is_playing = false;
            audio_state.state.current_position = 0.0;
            audio_state.state.current_track = None;
            audio_state.position_base = 0.0;
            audio_state.playback_started_at = None;

            clear_media_controls();
            update_shared_state(shared_state, &audio_state.state);
            let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
        }

        PlaybackCommand::Seek(position_secs) => {
            if audio_state.state.current_track.is_none() {
                return;
            }

            if let Some(ref sink) = audio_state.sink {
                let mut target_position = position_secs.max(0.0);
                if audio_state.state.duration > 0.0 {
                    target_position = target_position.min(audio_state.state.duration);
                }
                let seek_duration = Duration::from_secs_f64(target_position);
                // try_seek is fast for formats that support seeking (mp3, flac, etc.)
                if sink.try_seek(seek_duration).is_ok() {
                    audio_state.position_base = target_position;
                    audio_state.playback_started_at = if audio_state.state.is_playing {
                        Some(Instant::now())
                    } else {
                        None
                    };
                    audio_state.state.current_position = target_position;
                    update_shared_state(shared_state, &audio_state.state);
                    let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
                } else {
                    eprintln!("Seek failed at {:.2}s", target_position);
                }
            }
        }

        PlaybackCommand::SetSeekMode(mode) => {
            audio_state.seek_mode.store(mode as u8, Ordering::Relaxed);
        }

        PlaybackCommand::SetVolume(volume) => {
            let clamped = volume.clamp(0.0, 1.0);
            audio_state.state.volume = clamped;

            if let Some(ref sink) = audio_state.sink {
                sink.set_volume(clamped as f32);
            }

            update_shared_state(shared_state, &audio_state.state);
            let _ = app_handle.emit("muro://playback-state", audio_state.state.clone());
        }

        PlaybackCommand::GetState(reply_tx) => {
            // Return state with accurate current position
            let mut state = audio_state.state.clone();
            state.current_position = audio_state.current_position();
            let _ = reply_tx.send(state);
        }

        PlaybackCommand::IsFinished(reply_tx) => {
            let finished = audio_state.sink.as_ref().map(|s| s.empty()).unwrap_or(true);
            let _ = reply_tx.send(finished);
        }
    }
}

fn update_shared_state(shared: &Arc<Mutex<PlaybackState>>, state: &PlaybackState) {
    let mut guard = shared.lock();
    *guard = state.clone();
}

fn handle_media_event(tx: &Sender<PlaybackCommand>, app: &AppHandle, event: MediaControlEvent) {
    match event {
        MediaControlEvent::Play => {
            let _ = tx.send(PlaybackCommand::Play);
            let _ = app.emit("muro://media-control", "play");
        }
        MediaControlEvent::Pause => {
            let _ = tx.send(PlaybackCommand::Pause);
            let _ = app.emit("muro://media-control", "pause");
        }
        MediaControlEvent::Toggle => {
            let _ = tx.send(PlaybackCommand::Toggle);
            let _ = app.emit("muro://media-control", "toggle");
        }
        MediaControlEvent::Next => {
            let _ = app.emit("muro://media-control", "next");
        }
        MediaControlEvent::Previous => {
            let _ = app.emit("muro://media-control", "previous");
        }
        MediaControlEvent::Stop => {
            let _ = tx.send(PlaybackCommand::Stop);
            let _ = app.emit("muro://media-control", "stop");
        }
        _ => {}
    }
}

/// Update media controls metadata when a track starts playing
fn update_media_controls_metadata(track: &CurrentTrack, duration_secs: f64) {
    let mut controls = MEDIA_CONTROLS.lock();
    if let Some(ref mut controls) = *controls {
        let duration = if duration_secs > 0.0 {
            Some(Duration::from_secs_f64(duration_secs))
        } else {
            None
        };

        let metadata = MediaMetadata {
            title: Some(&track.title),
            artist: Some(&track.artist),
            album: Some(&track.album),
            duration,
            ..Default::default()
        };

        if let Err(e) = controls.set_metadata(metadata) {
            eprintln!("Failed to set media metadata: {:?}", e);
        }
    }
}

/// Update media controls playback state
fn update_media_controls_playback(is_playing: bool) {
    let mut controls = MEDIA_CONTROLS.lock();
    if let Some(ref mut controls) = *controls {
        let playback = if is_playing {
            MediaPlayback::Playing { progress: None }
        } else {
            MediaPlayback::Paused { progress: None }
        };

        if let Err(e) = controls.set_playback(playback) {
            eprintln!("Failed to set media playback state: {:?}", e);
        }
    }
}

/// Clear media controls when playback stops
fn clear_media_controls() {
    let mut controls = MEDIA_CONTROLS.lock();
    if let Some(ref mut controls) = *controls {
        let _ = controls.set_playback(MediaPlayback::Stopped);
    }
}
