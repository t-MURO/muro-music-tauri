//! Command-compatible native playback actor for the current renderer contract.
//!
//! Audio decoding/output stays in Rust through Rodio (Symphonia + CPAL). The
//! renderer continues to own queue selection while this service owns local
//! playback, preload, gain and transition state.

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::{Deserialize, Serialize};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(windows)]
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

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
    Shutdown,
}

#[derive(Clone)]
pub struct NativePlaybackService {
    tx: Sender<ActorCommand>,
}

impl NativePlaybackService {
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        thread::Builder::new()
            .name("muro-native-playback".to_string())
            .spawn(move || {
                let (media_tx, media_rx) = mpsc::channel();
                match PlaybackActor::new(app, media_tx) {
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

struct Voice {
    input: PlaybackTrackInput,
    sink: Sink,
    duration: f64,
}

impl Voice {
    fn position(&self) -> f64 {
        self.sink
            .get_pos()
            .as_secs_f64()
            .min(self.duration.max(0.0))
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
    _stream: OutputStream,
    stream_handle: OutputStreamHandle,
    active: Option<Voice>,
    preloaded: Option<Voice>,
    fade: Option<FadeState>,
    volume: f64,
    gapless: bool,
    crossfade_seconds: f64,
    seek_mode: String,
    output_device: String,
    ended_reported: bool,
    last_position_event: Instant,
}

impl PlaybackActor {
    fn new(app: AppHandle, media_tx: Sender<NativeMediaAction>) -> Result<Self, String> {
        let (stream, stream_handle) = open_output_stream("")?;
        let media_controls = init_media_controls(&app, media_tx);
        Ok(Self {
            app,
            media_controls,
            media_track_id: None,
            _stream: stream,
            stream_handle,
            active: None,
            preloaded: None,
            fade: None,
            volume: 0.8,
            gapless: true,
            crossfade_seconds: 0.0,
            seek_mode: "accurate".to_string(),
            output_device: String::new(),
            ended_reported: false,
            last_position_event: Instant::now(),
        })
    }

    fn run(mut self, rx: Receiver<ActorCommand>, media_rx: Receiver<NativeMediaAction>) {
        loop {
            match rx.recv_timeout(ACTOR_TICK) {
                Ok(ActorCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
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
                self.seek_mode = if mode == "fast" {
                    mode
                } else {
                    "accurate".to_string()
                };
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
            ActorCommand::Shutdown => return,
        };
        if let Err(message) = &result {
            let _ = self.app.emit("muro://playback-error", message.clone());
        }
        let _ = reply.send(result);
    }

    fn play_file(&mut self, track: PlaybackTrackInput) -> Result<(), String> {
        self.stop_all();
        let voice = create_voice(&self.stream_handle, track, false, 0.0)?;
        self.active = Some(voice);
        self.ended_reported = false;
        self.apply_levels();
        self.emit_state();
        Ok(())
    }

    fn set_preload(&mut self, track: Option<PlaybackTrackInput>) -> Result<(), String> {
        self.clear_preload();
        if let Some(track) = track {
            self.preloaded = Some(create_voice(&self.stream_handle, track, true, 0.0)?);
            self.apply_levels();
        }
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
        let target = sanitize_seconds(position, 0.0, active.duration);
        active
            .sink
            .try_seek(Duration::from_secs_f64(target))
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
        _preserve_pitch: bool,
    ) -> Result<(), String> {
        let (from_id, is_playing) = self
            .active
            .as_ref()
            .map(|active| (active.input.id.clone(), active.playing()))
            .ok_or_else(|| "Nothing playing to transition from".to_string())?;
        if !is_playing {
            return Err("Nothing playing to transition from".to_string());
        }
        self.cancel_transition();
        self.clear_preload();
        let incoming = create_voice(&self.stream_handle, track, true, plan.cue_in_sec.max(0.0))?;
        incoming.sink.set_speed(sanitize_rate(plan.rate) as f32);
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
            rate: sanitize_rate(plan.rate),
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
        if requested == self.output_device {
            return Ok(());
        }
        let active_snapshot = self
            .active
            .as_ref()
            .map(|voice| (voice.input.clone(), voice.position(), voice.playing()));
        let preload_snapshot = self
            .preloaded
            .as_ref()
            .filter(|_| {
                self.fade
                    .as_ref()
                    .map(|fade| fade.kind != FadeKind::Dj)
                    .unwrap_or(true)
            })
            .map(|voice| (voice.input.clone(), voice.position()));
        self.cancel_transition();
        self.stop_voices();
        let (stream, handle) = open_output_stream(&requested)?;
        self._stream = stream;
        self.stream_handle = handle;
        self.output_device = requested;
        if let Some((track, position, playing)) = active_snapshot {
            self.active = Some(create_voice(
                &self.stream_handle,
                track,
                !playing,
                position,
            )?);
        }
        if let Some((track, position)) = preload_snapshot {
            self.preloaded = Some(create_voice(&self.stream_handle, track, true, position)?);
        }
        self.apply_levels();
        self.emit_state();
        Ok(())
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

        let ended = self
            .active
            .as_ref()
            .map(|voice| voice.sink.empty())
            .unwrap_or(false);
        if ended && self.fade.is_none() {
            if self.gapless && self.preloaded.is_some() {
                self.promote_preload("gapless");
            } else if !self.ended_reported {
                self.ended_reported = true;
                let _ = self.app.emit("muro://track-ended", ());
                self.emit_state();
            }
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
            start_position: active.position(),
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
            fade.start_position = position;
            if let Some(incoming) = &self.preloaded {
                incoming.sink.set_speed(fade.rate as f32);
                incoming.sink.play();
            }
            fade.last_event = Instant::now() - POSITION_EVENT_INTERVAL;
        }

        // Rodio's sink position advances with rendered audio and freezes while
        // paused, so a fade cannot complete behind the user's back.
        let elapsed = self
            .active
            .as_ref()
            .map(|voice| (voice.position() - fade.start_position).max(0.0))
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
                let metadata = MediaMetadata {
                    title: Some(&track.title),
                    artist: Some(&track.artist),
                    album: Some(&track.album),
                    duration,
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
    sink.append(decoder);
    if start_position > 0.0 {
        sink.try_seek(Duration::from_secs_f64(start_position.min(duration)))
            .map_err(|error| format!("Could not seek prepared track: {error}"))?;
    }
    Ok(Voice {
        input,
        sink,
        duration,
    })
}

fn open_output_stream(device_id: &str) -> Result<(OutputStream, OutputStreamHandle), String> {
    if device_id.is_empty() {
        return OutputStream::try_default().map_err(|error| error.to_string());
    }
    let host = rodio::cpal::default_host();
    let devices = host.output_devices().map_err(|error| error.to_string())?;
    for (index, device) in devices.enumerate() {
        let name = device
            .name()
            .unwrap_or_else(|_| format!("Audio device {}", index + 1));
        if device_id == name || device_id == stable_device_id(index, &name) {
            return OutputStream::try_from_device(&device).map_err(|error| error.to_string());
        }
    }
    Err("The selected audio output is unavailable; choose the system default".to_string())
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
    fn device_ids_are_deterministic_for_one_enumeration() {
        assert_eq!(stable_device_id(2, "Studio DAC"), "cpal:2:Studio DAC");
    }
}
