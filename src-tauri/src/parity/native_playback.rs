//! Command-compatible native playback actor for the current renderer contract.
//!
//! Audio decoding/output stays in Rust through Rodio (Symphonia + CPAL). The
//! renderer continues to own queue selection while this service owns local
//! playback, preload, gain and transition state.

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::source::SeekError;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sample, Sink, Source};
use serde::{Deserialize, Serialize};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{
    mpsc::{self, Receiver, Sender},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(windows)]
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};
use wsola::TimeStretch;

const ACTOR_TICK: Duration = Duration::from_millis(20);
const POSITION_EVENT_INTERVAL: Duration = Duration::from_millis(100);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeCurrentTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_art_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_art_thumb_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NativePlaybackState {
    pub is_playing: bool,
    pub current_position: f64,
    pub duration: f64,
    pub volume: f64,
    pub current_track: Option<NativeCurrentTrack>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioOutputDevice {
    pub device_id: String,
    pub label: String,
}

impl Default for NativePlaybackState {
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackTrackInput {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub source_path: String,
    pub duration_hint: f64,
    pub cover_art_path: Option<String>,
    pub cover_art_thumb_path: Option<String>,
    #[serde(default = "default_gain")]
    pub gain_factor: f64,
}

impl PlaybackTrackInput {
    fn current_track(&self) -> NativeCurrentTrack {
        NativeCurrentTrack {
            id: self.id.clone(),
            title: self.title.clone(),
            artist: self.artist.clone(),
            album: self.album.clone(),
            source_path: self.source_path.clone(),
            cover_art_path: self.cover_art_path.clone(),
            cover_art_thumb_path: self.cover_art_thumb_path.clone(),
        }
    }
}

fn default_gain() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionPlan {
    pub mode: String,
    pub rate: f64,
    pub start_at_sec: f64,
    pub cue_in_sec: f64,
    pub duration_sec: f64,
    pub bass_swap_at_sec: f64,
    pub bass_swap_dur_sec: f64,
    pub beat_sec_a: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct TrackAdvancedEvent {
    track_id: String,
    reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct TransitionStateEvent {
    status: &'static str,
    progress: f64,
    from_id: String,
    to_id: String,
    to_title: String,
}

#[derive(Debug, Clone, Copy)]
enum NativeMediaAction {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Stop,
    SeekBy(f64),
    SetPosition(f64),
    SetVolume(f64),
}

#[derive(Clone, Serialize)]
struct MediaControlEventPayload {
    action: &'static str,
    source: &'static str,
}

enum ActorResponse {
    Unit,
    Bool(bool),
    Text(String),
    State(NativePlaybackState),
    Devices(Vec<NativeAudioOutputDevice>),
}

type Reply = Sender<Result<ActorResponse, String>>;

enum ActorCommand {
    PlayFile(PlaybackTrackInput, Reply),
    Preload(Option<PlaybackTrackInput>, Reply),
    ClearPreload(Reply),
    SetGapless(bool, Reply),
    SetCrossfade(f64, Reply),
    SetTrackGain(f64, Reply),
    Toggle(Reply),
    Play(Reply),
    Pause(Reply),
    Stop(Reply),
    Seek(f64, Reply),
    SetVolume(f64, Reply),
    SetSeekMode(String, Reply),
    SetOutputDevice(String, Reply),
    GetOutputDevice(Reply),
    ListOutputDevices(Reply),
    GetState(Reply),
    IsFinished(Reply),
    TransitionTo(PlaybackTrackInput, TransitionPlan, bool, Reply),
    CancelTransition(Reply),
    SourceEnded(u64),
    Shutdown,
}

#[derive(Clone)]
pub struct NativePlaybackService {
    tx: Sender<ActorCommand>,
}

impl NativePlaybackService {
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel();
        let actor_tx = tx.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        thread::Builder::new()
            .name("muro-native-playback".to_string())
            .spawn(move || {
                let (media_tx, media_rx) = mpsc::channel();
                match PlaybackActor::new(app, media_tx, actor_tx) {
                    Ok(actor) => {
                        let _ = ready_tx.send(Ok(()));
                        actor.run(rx, media_rx);
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        ready_rx
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "Native audio initialization timed out".to_string())??;
        Ok(Self { tx })
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(ActorCommand::Shutdown);
    }

    fn request<F>(&self, build: F) -> Result<ActorResponse, String>
    where
        F: FnOnce(Reply) -> ActorCommand,
    {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(build(reply_tx))
            .map_err(|_| "Native playback service is unavailable".to_string())?;
        reply_rx
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "Native playback command timed out".to_string())?
    }

    fn unit<F>(&self, build: F) -> Result<(), String>
    where
        F: FnOnce(Reply) -> ActorCommand,
    {
        match self.request(build)? {
            ActorResponse::Unit => Ok(()),
            _ => Err("Native playback returned an unexpected response".to_string()),
        }
    }
}

impl Drop for NativePlaybackService {
    fn drop(&mut self) {
        // Command-time State borrows do not clone the service. A separately
        // cloned owner can call shutdown explicitly during application exit.
    }
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeekModePreference {
    Fast = 0,
    Accurate = 1,
}

impl SeekModePreference {
    fn from_name(value: &str) -> Self {
        if value.eq_ignore_ascii_case("fast") {
            Self::Fast
        } else {
            Self::Accurate
        }
    }

    fn load(value: &AtomicU8) -> Self {
        if value.load(Ordering::Relaxed) == Self::Fast as u8 {
            Self::Fast
        } else {
            Self::Accurate
        }
    }

    fn seek_target(self, seconds: f64) -> f64 {
        match self {
            // Rodio 0.19 does not expose Symphonia's coarse/accurate switch.
            // A coarse target avoids decoding an arbitrary sub-frame tail while
            // accurate mode preserves the exact renderer-requested timestamp.
            Self::Fast => (seconds * 4.0).floor() / 4.0,
            Self::Accurate => seconds,
        }
    }
}

struct EndNotifyingSource<S> {
    inner: S,
    actor_tx: Sender<ActorCommand>,
    token: u64,
    notified: bool,
}

impl<S> Iterator for EndNotifyingSource<S>
where
    S: Source,
    S::Item: Sample,
{
    type Item = S::Item;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.inner.next();
        if sample.is_none() && !self.notified {
            self.notified = true;
            let _ = self.actor_tx.send(ActorCommand::SourceEnded(self.token));
        }
        sample
    }
}

impl<S> Source for EndNotifyingSource<S>
where
    S: Source,
    S::Item: Sample,
{
    fn current_frame_len(&self) -> Option<usize> {
        self.inner.current_frame_len()
    }

    fn channels(&self) -> u16 {
        self.inner.channels()
    }

    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)?;
        self.notified = false;
        Ok(())
    }
}

const WSOLA_INPUT_FRAMES: usize = 4096;

struct WsolaSource<S> {
    inner: S,
    stretcher: TimeStretch,
    output: VecDeque<f32>,
    startup_input: Vec<f32>,
    channels: u16,
    sample_rate: u32,
    tempo: f32,
    duration: Option<Duration>,
    eof: bool,
    produced_output: bool,
}

impl<S> WsolaSource<S>
where
    S: Source<Item = i16>,
{
    fn new(inner: S, tempo: f32) -> Result<Self, String> {
        let channels = inner.channels();
        let sample_rate = inner.sample_rate();
        let mut stretcher = TimeStretch::new(sample_rate, channels)
            .map_err(|error| format!("Could not initialize preserve-pitch processing: {error}"))?;
        stretcher.set_tempo(tempo);
        let tempo = stretcher.tempo();
        let duration = inner
            .total_duration()
            .map(|duration| Duration::from_secs_f64(duration.as_secs_f64() / f64::from(tempo)));
        let mut source = Self {
            inner,
            stretcher,
            output: VecDeque::new(),
            startup_input: Vec::new(),
            channels,
            sample_rate,
            tempo,
            duration,
            eof: false,
            produced_output: false,
        };
        source.refill();
        Ok(source)
    }

    fn refill(&mut self) {
        let channels = usize::from(self.channels);
        while self.output.is_empty() && !self.eof {
            let target_samples = WSOLA_INPUT_FRAMES * channels;
            let mut input = Vec::with_capacity(target_samples);
            while input.len() < target_samples {
                match self.inner.next() {
                    Some(sample) => input.push(f32::from(sample) / 32768.0),
                    None => {
                        self.eof = true;
                        break;
                    }
                }
            }

            // A corrupt/truncated source may end inside an interleaved frame.
            // WSOLA requires complete channel groups, so discard only that tail.
            input.truncate(input.len() / channels * channels);
            if !input.is_empty() {
                if !self.produced_output {
                    self.startup_input.extend_from_slice(&input);
                }
                self.stretcher.push(&input);
            }

            let ready = if self.eof {
                self.stretcher.flush()
            } else {
                self.stretcher.pull(usize::MAX)
            };
            if !ready.is_empty() {
                self.produced_output = true;
                self.startup_input.clear();
                self.output.extend(ready);
            } else if self.eof && !self.produced_output {
                // The WSOLA window is around 30 ms. Preserve very short clips
                // rather than dropping them when they cannot fill one window.
                self.output.extend(self.startup_input.drain(..));
            }
        }
    }
}

impl<S> Iterator for WsolaSource<S>
where
    S: Source<Item = i16>,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.output.is_empty() {
            self.refill();
        }
        self.output.pop_front()
    }
}

impl<S> Source for WsolaSource<S>
where
    S: Source<Item = i16>,
{
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
        let source_position = Duration::from_secs_f64(pos.as_secs_f64() * f64::from(self.tempo));
        self.inner.try_seek(source_position)?;
        self.stretcher.reset();
        self.output.clear();
        self.startup_input.clear();
        self.eof = false;
        self.produced_output = false;
        Ok(())
    }
}

struct Voice {
    token: u64,
    input: PlaybackTrackInput,
    sink: Sink,
    duration: f64,
    playback_rate: f64,
    preserve_pitch: bool,
}

impl Voice {
    fn rendered_position(&self) -> f64 {
        self.sink.get_pos().as_secs_f64()
    }

    fn position(&self) -> f64 {
        (self.rendered_position() * self.playback_rate).min(self.duration.max(0.0))
    }

    fn rendered_seek_position(&self, source_position: f64) -> Duration {
        Duration::from_secs_f64(source_position / self.playback_rate.max(f64::EPSILON))
    }

    fn playing(&self) -> bool {
        !self.sink.is_paused() && !self.sink.empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FadeKind {
    Automatic,
    Dj,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FadePhase {
    Armed,
    Active,
}

struct FadeState {
    kind: FadeKind,
    phase: FadePhase,
    start_position: f64,
    duration: f64,
    start_at: f64,
    rate: f64,
    from_id: String,
    to_id: String,
    to_title: String,
    last_event: Instant,
}

struct PlaybackActor {
    app: AppHandle,
    media_controls: Option<MediaControls>,
    media_track_id: Option<String>,
    _stream: Option<OutputStream>,
    stream_handle: Option<OutputStreamHandle>,
    actor_tx: Sender<ActorCommand>,
    next_voice_token: u64,
    active: Option<Voice>,
    preloaded: Option<Voice>,
    fade: Option<FadeState>,
    volume: f64,
    gapless: bool,
    crossfade_seconds: f64,
    seek_mode: Arc<AtomicU8>,
    output_device: String,
    ended_reported: bool,
    last_position_event: Instant,
}

impl PlaybackActor {
    fn new(
        app: AppHandle,
        media_tx: Sender<NativeMediaAction>,
        actor_tx: Sender<ActorCommand>,
    ) -> Result<Self, String> {
        let media_controls = init_media_controls(&app, media_tx);
        Ok(Self {
            app,
            media_controls,
            media_track_id: None,
            _stream: None,
            stream_handle: None,
            actor_tx,
            next_voice_token: 1,
            active: None,
            preloaded: None,
            fade: None,
            volume: 0.8,
            gapless: true,
            crossfade_seconds: 0.0,
            seek_mode: Arc::new(AtomicU8::new(SeekModePreference::Accurate as u8)),
            output_device: String::new(),
            ended_reported: false,
            last_position_event: Instant::now(),
        })
    }

    fn ensure_output(&mut self) -> Result<(), String> {
        if self.stream_handle.is_none() {
            let (stream, handle) = open_output_stream(&self.output_device)?;
            self._stream = Some(stream);
            self.stream_handle = Some(handle);
        }
        Ok(())
    }

    fn make_voice(
        &mut self,
        track: PlaybackTrackInput,
        paused: bool,
        start_position: f64,
        playback_rate: f64,
        preserve_pitch: bool,
    ) -> Result<Voice, String> {
        self.ensure_output()?;
        let playback_rate = sanitize_rate(playback_rate);
        let token = self.next_voice_token;
        self.next_voice_token = self.next_voice_token.wrapping_add(1).max(1);
        create_voice(
            self.stream_handle
                .as_ref()
                .expect("output handle initialized above"),
            track,
            paused,
            start_position,
            playback_rate,
            preserve_pitch,
            self.seek_mode.clone(),
            self.actor_tx.clone(),
            token,
        )
    }

    fn run(mut self, rx: Receiver<ActorCommand>, media_rx: Receiver<NativeMediaAction>) {
        loop {
            match rx.recv_timeout(ACTOR_TICK) {
                Ok(ActorCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(ActorCommand::SourceEnded(token)) => self.handle_source_ended(token),
                Ok(command) => self.dispatch(command),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            self.tick();
            while let Ok(action) = media_rx.try_recv() {
                self.handle_media_action(action);
            }
        }
        self.shutdown();
    }

    fn handle_media_action(&mut self, action: NativeMediaAction) {
        match action {
            NativeMediaAction::Play => self.play(),
            NativeMediaAction::Pause => self.pause(),
            NativeMediaAction::Toggle => {
                self.toggle();
            }
            NativeMediaAction::Stop => {
                self.stop_all();
                self.emit_state();
            }
            NativeMediaAction::Next => self.emit_media_control("next"),
            NativeMediaAction::Previous => self.emit_media_control("previous"),
            NativeMediaAction::SeekBy(delta) => {
                let position = self.active.as_ref().map(Voice::position).unwrap_or(0.0) + delta;
                if let Err(error) = self.seek(position) {
                    let _ = self.app.emit("muro://playback-error", error);
                }
            }
            NativeMediaAction::SetPosition(position) => {
                if let Err(error) = self.seek(position) {
                    let _ = self.app.emit("muro://playback-error", error);
                }
            }
            NativeMediaAction::SetVolume(volume) => {
                self.volume = volume.clamp(0.0, 1.0);
                self.apply_levels();
                self.emit_state();
            }
        }
    }

    fn emit_media_control(&self, action: &'static str) {
        let _ = self.app.emit(
            "muro://media-control",
            MediaControlEventPayload {
                action,
                source: "native-media-control",
            },
        );
    }

    fn dispatch(&mut self, command: ActorCommand) {
        let (result, reply) = match command {
            ActorCommand::PlayFile(track, reply) => {
                (self.play_file(track).map(|_| ActorResponse::Unit), reply)
            }
            ActorCommand::Preload(track, reply) => {
                (self.set_preload(track).map(|_| ActorResponse::Unit), reply)
            }
            ActorCommand::ClearPreload(reply) => {
                self.clear_preload();
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::SetGapless(enabled, reply) => {
                self.gapless = enabled;
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::SetCrossfade(seconds, reply) => {
                self.crossfade_seconds = sanitize_seconds(seconds, 0.0, 30.0);
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::SetTrackGain(gain, reply) => {
                if let Some(active) = &mut self.active {
                    active.input.gain_factor = sanitize_gain(gain);
                }
                self.apply_levels();
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::Toggle(reply) => {
                let playing = self.toggle();
                (Ok(ActorResponse::Bool(playing)), reply)
            }
            ActorCommand::Play(reply) => {
                self.play();
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::Pause(reply) => {
                self.pause();
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::Stop(reply) => {
                self.stop_all();
                self.emit_state();
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::Seek(position, reply) => {
                (self.seek(position).map(|_| ActorResponse::Unit), reply)
            }
            ActorCommand::SetVolume(volume, reply) => {
                self.volume = volume.clamp(0.0, 1.0);
                self.apply_levels();
                self.emit_state();
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::SetSeekMode(mode, reply) => {
                let preference = SeekModePreference::from_name(&mode);
                self.seek_mode.store(preference as u8, Ordering::Relaxed);
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::SetOutputDevice(device, reply) => (
                self.switch_output(device).map(|_| ActorResponse::Unit),
                reply,
            ),
            ActorCommand::GetOutputDevice(reply) => {
                (Ok(ActorResponse::Text(self.output_device.clone())), reply)
            }
            ActorCommand::ListOutputDevices(reply) => {
                (list_output_devices().map(ActorResponse::Devices), reply)
            }
            ActorCommand::GetState(reply) => (Ok(ActorResponse::State(self.state())), reply),
            ActorCommand::IsFinished(reply) => {
                let finished = self.active.as_ref().map(|v| v.sink.empty()).unwrap_or(true);
                (Ok(ActorResponse::Bool(finished)), reply)
            }
            ActorCommand::TransitionTo(track, plan, preserve_pitch, reply) => (
                self.transition_to(track, plan, preserve_pitch)
                    .map(|_| ActorResponse::Unit),
                reply,
            ),
            ActorCommand::CancelTransition(reply) => {
                self.cancel_transition();
                (Ok(ActorResponse::Unit), reply)
            }
            ActorCommand::SourceEnded(_) => return,
            ActorCommand::Shutdown => return,
        };
        if let Err(message) = &result {
            let _ = self.app.emit("muro://playback-error", message.clone());
        }
        let _ = reply.send(result);
    }

    fn play_file(&mut self, track: PlaybackTrackInput) -> Result<(), String> {
        let voice = self.make_voice(track, true, 0.0, 1.0, false)?;
        self.stop_all();
        voice.sink.play();
        self.active = Some(voice);
        self.ended_reported = false;
        self.apply_levels();
        self.emit_state();
        Ok(())
    }

    fn set_preload(&mut self, track: Option<PlaybackTrackInput>) -> Result<(), String> {
        let prepared = match track {
            Some(track) => Some(self.make_voice(track, true, 0.0, 1.0, false)?),
            None => None,
        };
        self.clear_preload();
        self.preloaded = prepared;
        self.apply_levels();
        Ok(())
    }

    fn clear_preload(&mut self) {
        if self.fade.is_some() {
            self.cancel_transition();
        }
        if let Some(preloaded) = self.preloaded.take() {
            preloaded.sink.stop();
        }
    }

    fn toggle(&mut self) -> bool {
        let should_play = !self.active.as_ref().map(Voice::playing).unwrap_or(false);
        if should_play {
            self.play();
        } else {
            self.pause();
        }
        should_play
    }

    fn play(&mut self) {
        if let Some(active) = &self.active {
            active.sink.play();
        }
        if self.fade.as_ref().map(|f| f.phase) == Some(FadePhase::Active) {
            if let Some(preloaded) = &self.preloaded {
                preloaded.sink.play();
            }
        }
        self.emit_state();
    }

    fn pause(&mut self) {
        if let Some(active) = &self.active {
            active.sink.pause();
        }
        if let Some(preloaded) = &self.preloaded {
            preloaded.sink.pause();
        }
        self.emit_state();
    }

    fn seek(&mut self, position: f64) -> Result<(), String> {
        if self.fade.is_some() {
            self.cancel_transition();
        }
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| "Nothing is loaded".to_string())?;
        let requested = sanitize_seconds(position, 0.0, active.duration);
        let mode = SeekModePreference::load(&self.seek_mode);
        let target = mode.seek_target(requested);
        let rendered_target = active.rendered_seek_position(target);
        active
            .sink
            .try_seek(rendered_target)
            .map_err(|error| format!("Failed to seek: {error}"))?;
        self.ended_reported = false;
        let _ = self.app.emit("muro://playback-position", target);
        self.emit_state();
        Ok(())
    }

    fn transition_to(
        &mut self,
        track: PlaybackTrackInput,
        plan: TransitionPlan,
        preserve_pitch: bool,
    ) -> Result<(), String> {
        let rate = sanitize_rate(plan.rate);
        let (from_id, is_playing) = self
            .active
            .as_ref()
            .map(|active| (active.input.id.clone(), active.playing()))
            .ok_or_else(|| "Nothing playing to transition from".to_string())?;
        if !is_playing {
            return Err("Nothing playing to transition from".to_string());
        }
        let incoming =
            self.make_voice(track, true, plan.cue_in_sec.max(0.0), rate, preserve_pitch)?;
        if !preserve_pitch {
            incoming.sink.set_speed(rate as f32);
        }
        self.cancel_transition();
        self.clear_preload();
        let event = TransitionStateEvent {
            status: "armed",
            progress: 0.0,
            from_id,
            to_id: incoming.input.id.clone(),
            to_title: incoming.input.title.clone(),
        };
        self.fade = Some(FadeState {
            kind: FadeKind::Dj,
            phase: FadePhase::Armed,
            start_position: 0.0,
            duration: plan.duration_sec.max(0.05),
            start_at: plan.start_at_sec.max(0.0),
            rate,
            from_id: event.from_id.clone(),
            to_id: event.to_id.clone(),
            to_title: event.to_title.clone(),
            last_event: Instant::now(),
        });
        self.preloaded = Some(incoming);
        self.apply_levels();
        let _ = self.app.emit("muro://transition-state", event);
        Ok(())
    }

    fn cancel_transition(&mut self) {
        let Some(fade) = self.fade.take() else {
            return;
        };
        if fade.kind == FadeKind::Dj {
            if let Some(incoming) = self.preloaded.take() {
                incoming.sink.stop();
            }
            let _ = self.app.emit(
                "muro://transition-state",
                TransitionStateEvent {
                    status: "cancelled",
                    progress: 0.0,
                    from_id: fade.from_id,
                    to_id: fade.to_id,
                    to_title: fade.to_title,
                },
            );
        }
        self.apply_levels();
    }

    fn switch_output(&mut self, requested: String) -> Result<(), String> {
        if requested == self.output_device && self.stream_handle.is_some() {
            return Ok(());
        }

        // Open the replacement before disturbing a working stream. If the
        // selected device disappeared, playback continues and a later command
        // can retry initialization.
        let (stream, handle) = open_output_stream(&requested)?;
        let active_snapshot = self.active.as_ref().map(|voice| {
            (
                voice.input.clone(),
                voice.position(),
                voice.playing(),
                voice.playback_rate,
                voice.preserve_pitch,
            )
        });
        let preload_snapshot = self
            .preloaded
            .as_ref()
            .filter(|_| {
                self.fade
                    .as_ref()
                    .map(|fade| fade.kind != FadeKind::Dj)
                    .unwrap_or(true)
            })
            .map(|voice| {
                (
                    voice.input.clone(),
                    voice.position(),
                    voice.playback_rate,
                    voice.preserve_pitch,
                )
            });
        self.cancel_transition();
        self.stop_voices();
        self._stream = Some(stream);
        self.stream_handle = Some(handle);
        self.output_device = requested;
        if let Some((track, position, playing, rate, preserve_pitch)) = active_snapshot {
            self.active = Some(self.make_voice(track, !playing, position, rate, preserve_pitch)?);
        }
        if let Some((track, position, rate, preserve_pitch)) = preload_snapshot {
            self.preloaded = Some(self.make_voice(track, true, position, rate, preserve_pitch)?);
        }
        self.apply_levels();
        self.emit_state();
        Ok(())
    }

    fn handle_source_ended(&mut self, token: u64) {
        if self.active.as_ref().map(|voice| voice.token) != Some(token) {
            return;
        }
        if self.fade.is_some() {
            self.complete_fade();
            return;
        }
        if self.gapless && self.preloaded.is_some() {
            // Completion is delivered from Rodio's render path, so promotion is
            // no longer delayed by the actor's 20 ms polling interval. The two
            // independently cancellable sinks can still incur backend buffer
            // scheduling latency; sample-contiguous playback would require a
            // shared queue that Rodio cannot selectively unqueue.
            self.promote_preload("gapless");
        } else if !self.ended_reported {
            self.ended_reported = true;
            let _ = self.app.emit("muro://track-ended", ());
            self.emit_state();
        }
    }

    fn tick(&mut self) {
        if self.last_position_event.elapsed() >= POSITION_EVENT_INTERVAL {
            if let Some(active) = &self.active {
                if active.playing() {
                    let _ = self.app.emit("muro://playback-position", active.position());
                }
            }
            self.last_position_event = Instant::now();
            let state = self.state();
            self.update_media_controls(&state);
        }

        if self.fade.is_none() {
            self.maybe_start_automatic_fade();
        }
        self.tick_fade();

        // Keep an empty-sink fallback for decoder/backend implementations that
        // stop without pulling the source once more to observe `None`.
        let ended_token = self
            .active
            .as_ref()
            .filter(|voice| voice.sink.empty())
            .map(|voice| voice.token);
        if let Some(token) = ended_token {
            self.handle_source_ended(token);
        }
    }

    fn maybe_start_automatic_fade(&mut self) {
        if self.crossfade_seconds <= 0.0 || self.preloaded.is_none() {
            return;
        }
        let Some(active) = &self.active else {
            return;
        };
        if !active.playing()
            || active.duration <= 0.0
            || active.duration - active.position() > self.crossfade_seconds
        {
            return;
        }
        let preloaded = self.preloaded.as_ref().expect("checked above");
        preloaded.sink.play();
        self.fade = Some(FadeState {
            kind: FadeKind::Automatic,
            phase: FadePhase::Active,
            start_position: active.rendered_position(),
            duration: self.crossfade_seconds.max(0.05),
            start_at: active.position(),
            rate: 1.0,
            from_id: active.input.id.clone(),
            to_id: preloaded.input.id.clone(),
            to_title: preloaded.input.title.clone(),
            last_event: Instant::now(),
        });
        self.apply_levels();
    }

    fn tick_fade(&mut self) {
        let Some(fade) = &mut self.fade else {
            return;
        };
        if fade.phase == FadePhase::Armed {
            let position = self.active.as_ref().map(Voice::position).unwrap_or(0.0);
            if position < fade.start_at {
                return;
            }
            fade.phase = FadePhase::Active;
            fade.start_position = self
                .active
                .as_ref()
                .map(Voice::rendered_position)
                .unwrap_or(0.0);
            if let Some(incoming) = &self.preloaded {
                if !incoming.preserve_pitch {
                    incoming.sink.set_speed(fade.rate as f32);
                }
                incoming.sink.play();
            }
            fade.last_event = Instant::now() - POSITION_EVENT_INTERVAL;
        }

        // Rodio's sink position advances with rendered audio and freezes while
        // paused, so a fade cannot complete behind the user's back.
        let elapsed = self
            .active
            .as_ref()
            .map(|voice| (voice.rendered_position() - fade.start_position).max(0.0))
            .unwrap_or(0.0);
        let progress = transition_progress(elapsed, fade.duration);
        let (outgoing, incoming) = fade_gains(progress);
        if let Some(active) = &self.active {
            active
                .sink
                .set_volume((self.volume * active.input.gain_factor * outgoing).max(0.0) as f32);
        }
        if let Some(preloaded) = &self.preloaded {
            preloaded
                .sink
                .set_volume((self.volume * preloaded.input.gain_factor * incoming).max(0.0) as f32);
        }

        if fade.kind == FadeKind::Dj && fade.last_event.elapsed() >= POSITION_EVENT_INTERVAL {
            let _ = self.app.emit(
                "muro://transition-state",
                TransitionStateEvent {
                    status: "active",
                    progress,
                    from_id: fade.from_id.clone(),
                    to_id: fade.to_id.clone(),
                    to_title: fade.to_title.clone(),
                },
            );
            fade.last_event = Instant::now();
        }
        if progress >= 1.0 {
            self.complete_fade();
        }
    }

    fn complete_fade(&mut self) {
        let Some(fade) = self.fade.take() else {
            return;
        };
        if let Some(active) = self.active.take() {
            active.sink.stop();
        }
        self.active = self.preloaded.take();
        self.ended_reported = false;
        self.apply_levels();
        match fade.kind {
            FadeKind::Automatic => {
                if let Some(active) = &self.active {
                    let _ = self.app.emit(
                        "muro://track-advanced",
                        TrackAdvancedEvent {
                            track_id: active.input.id.clone(),
                            reason: "crossfade",
                        },
                    );
                }
            }
            FadeKind::Dj => {
                let _ = self.app.emit(
                    "muro://transition-state",
                    TransitionStateEvent {
                        status: "completed",
                        progress: 1.0,
                        from_id: fade.from_id,
                        to_id: fade.to_id,
                        to_title: fade.to_title,
                    },
                );
            }
        }
        self.emit_state();
    }

    fn promote_preload(&mut self, reason: &'static str) {
        if let Some(previous) = self.active.take() {
            previous.sink.stop();
        }
        let Some(next) = self.preloaded.take() else {
            return;
        };
        next.sink.play();
        let track_id = next.input.id.clone();
        self.active = Some(next);
        self.ended_reported = false;
        self.apply_levels();
        let _ = self.app.emit(
            "muro://track-advanced",
            TrackAdvancedEvent { track_id, reason },
        );
        self.emit_state();
    }

    fn apply_levels(&self) {
        if self.fade.is_some() {
            return;
        }
        if let Some(active) = &self.active {
            active
                .sink
                .set_volume((self.volume * sanitize_gain(active.input.gain_factor)) as f32);
        }
        if let Some(preloaded) = &self.preloaded {
            preloaded.sink.set_volume(0.0);
        }
    }

    fn state(&self) -> NativePlaybackState {
        let mut state = NativePlaybackState {
            volume: self.volume,
            ..NativePlaybackState::default()
        };
        if let Some(active) = &self.active {
            state.is_playing = active.playing();
            state.current_position = active.position();
            state.duration = active.duration;
            state.current_track = Some(active.input.current_track());
        }
        state
    }

    fn emit_state(&mut self) {
        let state = self.state();
        let _ = self.app.emit("muro://playback-state", state.clone());
        self.update_media_controls(&state);
    }

    fn update_media_controls(&mut self, state: &NativePlaybackState) {
        let track_id = state.current_track.as_ref().map(|track| track.id.clone());
        if track_id != self.media_track_id {
            if let (Some(controls), Some(track)) =
                (&mut self.media_controls, state.current_track.as_ref())
            {
                let duration = media_duration(state.duration);
                let cover_url = validated_cover_art_url(track);
                let metadata = MediaMetadata {
                    title: Some(&track.title),
                    artist: Some(&track.artist),
                    album: Some(&track.album),
                    duration,
                    cover_url: cover_url.as_deref(),
                    ..Default::default()
                };
                if let Err(error) = controls.set_metadata(metadata) {
                    eprintln!("Failed to update native media metadata: {error:?}");
                }
            }
            self.media_track_id = track_id;
        }

        let playback = if state.current_track.is_none() {
            MediaPlayback::Stopped
        } else if state.is_playing {
            MediaPlayback::Playing {
                progress: media_position(state.current_position),
            }
        } else {
            MediaPlayback::Paused {
                progress: media_position(state.current_position),
            }
        };
        if let Some(controls) = &mut self.media_controls {
            if let Err(error) = controls.set_playback(playback) {
                eprintln!("Failed to update native media playback: {error:?}");
            }
        }
    }

    fn shutdown(&mut self) {
        self.stop_all();
        let state = self.state();
        self.update_media_controls(&state);
        self.media_controls.take();
    }

    fn stop_voices(&mut self) {
        if let Some(active) = self.active.take() {
            active.sink.stop();
        }
        if let Some(preloaded) = self.preloaded.take() {
            preloaded.sink.stop();
        }
    }

    fn stop_all(&mut self) {
        self.stop_voices();
        self.fade = None;
        self.ended_reported = false;
    }
}

fn validated_cover_art_url(track: &NativeCurrentTrack) -> Option<String> {
    [
        track.cover_art_thumb_path.as_deref(),
        track.cover_art_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(validated_local_cover_url)
}

fn validated_local_cover_url(value: &str) -> Option<String> {
    let path = if value.to_ascii_lowercase().starts_with("file:") {
        url::Url::parse(value).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    if !canonical.is_file() || !is_supported_cover_path(&canonical) {
        return None;
    }

    #[cfg(windows)]
    {
        // Souvlaki's Windows backend strips the literal file URL prefix and
        // passes the remainder to StorageFile::GetFileFromPathAsync.
        Some(format!("file://{}", canonical.to_string_lossy()))
    }
    #[cfg(not(windows))]
    {
        url::Url::from_file_path(canonical)
            .ok()
            .map(|url| url.to_string())
    }
}

fn is_supported_cover_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
    )
}

fn init_media_controls(
    app: &AppHandle,
    media_tx: Sender<NativeMediaAction>,
) -> Option<MediaControls> {
    let config = PlatformConfig {
        dbus_name: "muro_music",
        display_name: "Muro Music",
        hwnd: media_controls_hwnd(app),
    };
    let mut controls = match MediaControls::new(config) {
        Ok(controls) => controls,
        Err(error) => {
            eprintln!("Failed to create native media controls: {error:?}");
            return None;
        }
    };
    if let Err(error) = controls.attach(move |event| {
        if let Some(action) = native_media_action(event) {
            let _ = media_tx.send(action);
        }
    }) {
        eprintln!("Failed to attach native media controls: {error:?}");
        return None;
    }
    Some(controls)
}

fn native_media_action(event: MediaControlEvent) -> Option<NativeMediaAction> {
    match event {
        MediaControlEvent::Play => Some(NativeMediaAction::Play),
        MediaControlEvent::Pause => Some(NativeMediaAction::Pause),
        MediaControlEvent::Toggle => Some(NativeMediaAction::Toggle),
        MediaControlEvent::Next => Some(NativeMediaAction::Next),
        MediaControlEvent::Previous => Some(NativeMediaAction::Previous),
        MediaControlEvent::Stop => Some(NativeMediaAction::Stop),
        MediaControlEvent::Seek(direction) => {
            Some(NativeMediaAction::SeekBy(signed_seek(direction, 10.0)))
        }
        MediaControlEvent::SeekBy(direction, duration) => Some(NativeMediaAction::SeekBy(
            signed_seek(direction, duration.as_secs_f64()),
        )),
        MediaControlEvent::SetPosition(MediaPosition(position)) => {
            Some(NativeMediaAction::SetPosition(position.as_secs_f64()))
        }
        MediaControlEvent::SetVolume(volume) => Some(NativeMediaAction::SetVolume(volume)),
        _ => None,
    }
}

fn signed_seek(direction: SeekDirection, seconds: f64) -> f64 {
    match direction {
        SeekDirection::Forward => seconds,
        SeekDirection::Backward => -seconds,
    }
}

fn media_duration(seconds: f64) -> Option<Duration> {
    if seconds.is_finite() && seconds > 0.0 {
        Some(Duration::from_secs_f64(seconds))
    } else {
        None
    }
}

fn media_position(seconds: f64) -> Option<MediaPosition> {
    if seconds.is_finite() && seconds >= 0.0 {
        Some(MediaPosition(Duration::from_secs_f64(seconds)))
    } else {
        None
    }
}

#[cfg(windows)]
fn media_controls_hwnd(app: &AppHandle) -> Option<*mut std::ffi::c_void> {
    app.get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0)
}

#[cfg(not(windows))]
fn media_controls_hwnd(_app: &AppHandle) -> Option<*mut std::ffi::c_void> {
    None
}

fn create_voice(
    handle: &OutputStreamHandle,
    mut input: PlaybackTrackInput,
    paused: bool,
    start_position: f64,
    playback_rate: f64,
    preserve_pitch: bool,
    seek_mode: Arc<AtomicU8>,
    actor_tx: Sender<ActorCommand>,
    token: u64,
) -> Result<Voice, String> {
    let path = Path::new(&input.source_path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Track source file does not exist".to_string());
    }
    input.gain_factor = sanitize_gain(input.gain_factor);
    let file = File::open(path).map_err(|error| error.to_string())?;
    let decoder = Decoder::new(BufReader::new(file))
        .map_err(|error| format!("Could not decode audio: {error}"))?;
    let measured_duration = decoder.total_duration().map(|value| value.as_secs_f64());
    let duration = measured_duration
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| input.duration_hint.max(0.0));
    let sink = Sink::try_new(handle).map_err(|error| error.to_string())?;
    if paused {
        sink.pause();
    }
    let use_wsola = preserve_pitch && (playback_rate - 1.0).abs() > f64::EPSILON;
    if use_wsola {
        let stretched = WsolaSource::new(decoder, playback_rate as f32)?;
        sink.append(EndNotifyingSource {
            inner: stretched,
            actor_tx,
            token,
            notified: false,
        });
    } else {
        sink.append(EndNotifyingSource {
            inner: decoder,
            actor_tx,
            token,
            notified: false,
        });
    }
    if !preserve_pitch {
        sink.set_speed(playback_rate as f32);
    }
    if start_position > 0.0 {
        let requested = start_position.min(duration);
        let target = SeekModePreference::load(&seek_mode).seek_target(requested);
        let rendered_target = target / playback_rate.max(f64::EPSILON);
        sink.try_seek(Duration::from_secs_f64(rendered_target))
            .map_err(|error| format!("Could not seek prepared track: {error}"))?;
    }
    Ok(Voice {
        token,
        input,
        sink,
        duration,
        playback_rate,
        preserve_pitch,
    })
}

fn open_output_stream(device_id: &str) -> Result<(OutputStream, OutputStreamHandle), String> {
    if device_id.is_empty() {
        return OutputStream::try_default().map_err(|error| error.to_string());
    }
    let host = rodio::cpal::default_host();
    let devices = host.output_devices().map_err(|error| error.to_string())?;
    let devices: Vec<_> = devices
        .enumerate()
        .map(|(index, device)| {
            let label = device
                .name()
                .unwrap_or_else(|_| format!("Audio device {}", index + 1));
            (device, label)
        })
        .collect();
    let labels: Vec<_> = devices.iter().map(|(_, label)| label.clone()).collect();
    let selected = select_output_device_index(device_id, &labels).ok_or_else(|| {
        "The selected audio output is unavailable; choose the system default".to_string()
    })?;
    OutputStream::try_from_device(&devices[selected].0).map_err(|error| error.to_string())
}

fn list_output_devices() -> Result<Vec<NativeAudioOutputDevice>, String> {
    let host = rodio::cpal::default_host();
    let devices = host.output_devices().map_err(|error| error.to_string())?;
    let mut result = vec![NativeAudioOutputDevice {
        device_id: String::new(),
        label: "System Default".to_string(),
    }];
    for (index, device) in devices.enumerate() {
        let label = device
            .name()
            .unwrap_or_else(|_| format!("Audio device {}", index + 1));
        result.push(NativeAudioOutputDevice {
            device_id: stable_device_id(index, &label),
            label,
        });
    }
    Ok(result)
}

fn stable_device_id(index: usize, name: &str) -> String {
    format!("cpal:{index}:{name}")
}

fn parse_stable_device_id(value: &str) -> Option<(usize, &str)> {
    let mut parts = value.splitn(3, ':');
    if parts.next()? != "cpal" {
        return None;
    }
    let index = parts.next()?.parse().ok()?;
    let label = parts.next()?;
    (!label.is_empty()).then_some((index, label))
}

fn select_output_device_index(requested: &str, labels: &[String]) -> Option<usize> {
    if let Some(exact) = labels
        .iter()
        .enumerate()
        .find_map(|(index, label)| (stable_device_id(index, label) == requested).then_some(index))
    {
        return Some(exact);
    }

    let fallback_label = parse_stable_device_id(requested)
        .map(|(_, label)| label)
        .unwrap_or(requested);
    let mut matches = labels
        .iter()
        .enumerate()
        .filter_map(|(index, label)| (label == fallback_label).then_some(index));
    let selected = matches.next()?;
    matches.next().is_none().then_some(selected)
}

fn sanitize_gain(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value.min(8.0)
    } else {
        1.0
    }
}

fn sanitize_rate(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value.clamp(0.5, 2.0)
    } else {
        1.0
    }
}

fn sanitize_seconds(value: f64, minimum: f64, maximum: f64) -> f64 {
    if !value.is_finite() {
        return minimum;
    }
    value.clamp(minimum, maximum.max(minimum))
}

fn transition_progress(elapsed: f64, duration: f64) -> f64 {
    if !elapsed.is_finite() || elapsed <= 0.0 {
        0.0
    } else if !duration.is_finite() || duration <= 0.0 {
        1.0
    } else {
        (elapsed / duration).clamp(0.0, 1.0)
    }
}

fn fade_gains(progress: f64) -> (f64, f64) {
    let progress = progress.clamp(0.0, 1.0);
    (1.0 - progress, progress)
}

fn track_input(
    id: String,
    title: String,
    artist: String,
    album: String,
    source_path: String,
    duration_hint: f64,
    cover_art_path: Option<String>,
    cover_art_thumb_path: Option<String>,
    gain_factor: f64,
) -> PlaybackTrackInput {
    PlaybackTrackInput {
        id,
        title,
        artist,
        album,
        source_path,
        duration_hint,
        cover_art_path,
        cover_art_thumb_path,
        gain_factor,
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn playback_play_file(
    service: State<'_, NativePlaybackService>,
    id: String,
    title: String,
    artist: String,
    album: String,
    source_path: String,
    duration_hint: f64,
    cover_art_path: Option<String>,
    cover_art_thumb_path: Option<String>,
    gain_factor: Option<f64>,
) -> Result<(), String> {
    let track = track_input(
        id,
        title,
        artist,
        album,
        source_path,
        duration_hint,
        cover_art_path,
        cover_art_thumb_path,
        gain_factor.unwrap_or(1.0),
    );
    service.unit(|reply| ActorCommand::PlayFile(track, reply))
}

#[tauri::command]
pub fn playback_preload_next(
    service: State<'_, NativePlaybackService>,
    track: Option<PlaybackTrackInput>,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::Preload(track, reply))
}

#[tauri::command]
pub fn playback_clear_preload(service: State<'_, NativePlaybackService>) -> Result<(), String> {
    service.unit(ActorCommand::ClearPreload)
}

#[tauri::command]
pub fn playback_set_gapless(
    service: State<'_, NativePlaybackService>,
    enabled: bool,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::SetGapless(enabled, reply))
}

#[tauri::command]
pub fn playback_set_crossfade(
    service: State<'_, NativePlaybackService>,
    seconds: f64,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::SetCrossfade(seconds, reply))
}

#[tauri::command(rename_all = "camelCase")]
pub fn playback_set_track_gain(
    service: State<'_, NativePlaybackService>,
    gain_factor: f64,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::SetTrackGain(gain_factor, reply))
}

#[tauri::command]
pub fn playback_toggle(service: State<'_, NativePlaybackService>) -> Result<bool, String> {
    match service.request(ActorCommand::Toggle)? {
        ActorResponse::Bool(value) => Ok(value),
        _ => Err("Native playback returned an unexpected response".to_string()),
    }
}

#[tauri::command]
pub fn playback_play(service: State<'_, NativePlaybackService>) -> Result<(), String> {
    service.unit(ActorCommand::Play)
}

#[tauri::command]
pub fn playback_pause(service: State<'_, NativePlaybackService>) -> Result<(), String> {
    service.unit(ActorCommand::Pause)
}

#[tauri::command]
pub fn playback_stop(service: State<'_, NativePlaybackService>) -> Result<(), String> {
    service.unit(ActorCommand::Stop)
}

#[tauri::command(rename_all = "camelCase")]
pub fn playback_seek(
    service: State<'_, NativePlaybackService>,
    position_secs: f64,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::Seek(position_secs, reply))
}

#[tauri::command]
pub fn playback_set_volume(
    service: State<'_, NativePlaybackService>,
    volume: f64,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::SetVolume(volume, reply))
}

#[tauri::command]
pub fn playback_set_seek_mode(
    service: State<'_, NativePlaybackService>,
    mode: String,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::SetSeekMode(mode, reply))
}

#[tauri::command(rename_all = "camelCase")]
pub fn playback_set_output_device(
    service: State<'_, NativePlaybackService>,
    device_id: String,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::SetOutputDevice(device_id, reply))
}

#[tauri::command]
pub fn playback_get_output_device(
    service: State<'_, NativePlaybackService>,
) -> Result<String, String> {
    match service.request(ActorCommand::GetOutputDevice)? {
        ActorResponse::Text(value) => Ok(value),
        _ => Err("Native playback returned an unexpected response".to_string()),
    }
}

/// Native replacement for `navigator.mediaDevices.enumerateDevices()`.
#[tauri::command]
pub fn playback_list_output_devices(
    service: State<'_, NativePlaybackService>,
) -> Result<Vec<NativeAudioOutputDevice>, String> {
    match service.request(ActorCommand::ListOutputDevices)? {
        ActorResponse::Devices(value) => Ok(value),
        _ => Err("Native playback returned an unexpected response".to_string()),
    }
}

#[tauri::command]
pub fn playback_get_state(
    service: State<'_, NativePlaybackService>,
) -> Result<NativePlaybackState, String> {
    match service.request(ActorCommand::GetState)? {
        ActorResponse::State(value) => Ok(value),
        _ => Err("Native playback returned an unexpected response".to_string()),
    }
}

#[tauri::command]
pub fn playback_is_finished(service: State<'_, NativePlaybackService>) -> Result<bool, String> {
    match service.request(ActorCommand::IsFinished)? {
        ActorResponse::Bool(value) => Ok(value),
        _ => Err("Native playback returned an unexpected response".to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn playback_transition_to(
    service: State<'_, NativePlaybackService>,
    track: PlaybackTrackInput,
    plan: TransitionPlan,
    preserve_pitch: bool,
) -> Result<(), String> {
    service.unit(|reply| ActorCommand::TransitionTo(track, plan, preserve_pitch, reply))
}

#[tauri::command]
pub fn playback_cancel_transition(service: State<'_, NativePlaybackService>) -> Result<(), String> {
    service.unit(ActorCommand::CancelTransition)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_pcm(frames: usize, channels: u16, sample_rate: u32) -> Vec<i16> {
        let mut samples = Vec::with_capacity(frames * usize::from(channels));
        for frame in 0..frames {
            let phase = frame as f32 * 440.0 * std::f32::consts::TAU / sample_rate as f32;
            let sample = (phase.sin() * 12_000.0) as i16;
            samples.extend(std::iter::repeat_n(sample, usize::from(channels)));
        }
        samples
    }

    #[test]
    fn wsola_source_is_aligned_shorter_and_seekable() {
        let channels = 2;
        let sample_rate = 8_000;
        let input = sine_pcm(sample_rate as usize, channels, sample_rate);
        let input_len = input.len();
        let source = rodio::buffer::SamplesBuffer::new(channels, sample_rate, input);
        let mut stretched = WsolaSource::new(source, 2.0).expect("valid WSOLA source");

        let duration = stretched.total_duration().expect("known duration");
        assert!((duration.as_secs_f64() - 0.5).abs() < 0.001);
        let output: Vec<_> = stretched.by_ref().collect();
        assert!(!output.is_empty());
        assert_eq!(output.len() % usize::from(channels), 0);
        assert!(output.len() < input_len);

        stretched
            .try_seek(Duration::from_millis(200))
            .expect("seek resets upstream and WSOLA state");
        assert_eq!(stretched.take(128).count(), 128);
    }

    #[test]
    fn wsola_source_preserves_clips_shorter_than_one_window() {
        let input = sine_pcm(100, 1, 8_000);
        let source = rodio::buffer::SamplesBuffer::new(1, 8_000, input.clone());
        let output: Vec<_> = WsolaSource::new(source, 1.5)
            .expect("valid WSOLA source")
            .collect();
        assert_eq!(output.len(), input.len());
    }

    #[test]
    fn transition_progress_is_bounded() {
        assert_eq!(transition_progress(-1.0, 8.0), 0.0);
        assert_eq!(transition_progress(4.0, 8.0), 0.5);
        assert_eq!(transition_progress(9.0, 8.0), 1.0);
        assert_eq!(transition_progress(1.0, 0.0), 1.0);
    }

    #[test]
    fn linear_fade_has_exact_endpoints_and_constant_sum() {
        assert_eq!(fade_gains(0.0), (1.0, 0.0));
        assert_eq!(fade_gains(1.0), (0.0, 1.0));
        let middle = fade_gains(0.35);
        assert!((middle.0 + middle.1 - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn invalid_gain_rate_and_seconds_are_sanitized() {
        assert_eq!(sanitize_gain(f64::NAN), 1.0);
        assert_eq!(sanitize_gain(-2.0), 1.0);
        assert_eq!(sanitize_rate(f64::INFINITY), 1.0);
        assert_eq!(sanitize_rate(4.0), 2.0);
        assert_eq!(sanitize_seconds(f64::NAN, 0.0, 30.0), 0.0);
        assert_eq!(sanitize_seconds(40.0, 0.0, 30.0), 30.0);
    }

    #[test]
    fn fast_and_accurate_seek_modes_resolve_different_targets() {
        assert_eq!(SeekModePreference::Fast.seek_target(1.234), 1.0);
        assert_eq!(SeekModePreference::Accurate.seek_target(1.234), 1.234);
    }

    #[test]
    fn cover_art_validation_accepts_images_only() {
        assert!(is_supported_cover_path(Path::new("cover.JPG")));
        assert!(is_supported_cover_path(Path::new("cover.webp")));
        assert!(!is_supported_cover_path(Path::new("cover.svg")));
        assert!(!is_supported_cover_path(Path::new("cover.exe")));
        assert!(validated_local_cover_url("relative/cover.jpg").is_none());
        assert!(validated_local_cover_url("https://example.com/cover.jpg").is_none());
    }

    #[test]
    fn saved_device_falls_back_by_unambiguous_exact_label() {
        let labels = vec!["Built-in Output".to_string(), "USB: Studio DAC".to_string()];
        assert_eq!(
            parse_stable_device_id("cpal:9:USB: Studio DAC"),
            Some((9, "USB: Studio DAC"))
        );
        assert_eq!(
            select_output_device_index("cpal:9:USB: Studio DAC", &labels),
            Some(1)
        );
        assert_eq!(
            select_output_device_index("USB: Studio DAC", &labels),
            Some(1)
        );
    }

    #[test]
    fn saved_device_label_fallback_rejects_ambiguity_but_exact_id_wins() {
        let labels = vec!["Studio DAC".to_string(), "Studio DAC".to_string()];
        assert_eq!(
            select_output_device_index("cpal:7:Studio DAC", &labels),
            None
        );
        assert_eq!(
            select_output_device_index("cpal:1:Studio DAC", &labels),
            Some(1)
        );
    }

    #[test]
    fn device_ids_are_deterministic_for_one_enumeration() {
        assert_eq!(stable_device_id(2, "Studio DAC"), "cpal:2:Studio DAC");
    }
}
