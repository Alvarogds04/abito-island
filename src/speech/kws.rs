//! «OK Abito»: a local keyword spotter (sherpa-onnx KWS) that listens for the wake
//! phrase; Parakeet only transcribes what comes after it.
//!
//! Adapted from Coucou NotchBuddy Voice/{EnergyVAD,WakeSpotter,VoiceEngine}.swift
//! (the NotchBuddy Swift @71b773f), Copyright (c) 2026 Louis Raillé, MIT. Rewritten
//! for Linux: the continuous SFSpeechRecognizer windows are replaced by sherpa-onnx.
//!
//! The model (about 15 MB) is downloaded only on the user's click. The archive's
//! SHA-256 is checked before anything is extracted; the system `tar` lists it first
//! (every entry must be expected, no absolute path, no `..`, no link) and then
//! extracts only the files we use, into a fresh directory; each extracted file is
//! checked against its pinned SHA-256 and the folder is moved into place at once.

use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{models_dir, ModelFile, Verifier, SAMPLE_RATE};

// ── The pinned model ──────────────────────────────────────────────────────────

pub struct KwsFile {
    /// Name inside the archive (below `prefix`).
    pub archive_name: &'static str,
    /// Name on disk.
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub struct KwsSpec {
    pub id: &'static str,
    pub archive_url: &'static str,
    pub archive_size: u64,
    pub archive_sha256: &'static str,
    pub prefix: &'static str,
    /// Every entry the archive may hold; anything else refuses the archive.
    pub listing: &'static [&'static str],
    pub files: &'static [KwsFile],
}

const P: &str = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";

/// k2-fsa's official small English zipformer keyword spotter (Apache-2.0). The "-mobile" archive crashes sherpa-onnx 1.13.8 at decode (Reshape error), so the full archive is pinned.
pub static KWS: KwsSpec = KwsSpec {
    id: "kws-zipformer-gigaspeech-3.3m",
    archive_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2",
    archive_size: 17_626_723,
    archive_sha256: "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a",
    prefix: P,
    listing: &[
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/bpe.model",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/keywords.txt",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/keywords_raw.txt",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/README.md",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/0.wav",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/1.wav",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/test_keywords.txt",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/trans.txt",
        "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/tokens.txt",
    ],
    files: &[
        KwsFile { archive_name: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx", name: "encoder.int8.onnx", size: 4_807_159, sha256: "1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678" },
        KwsFile { archive_name: "decoder-epoch-12-avg-2-chunk-16-left-64.onnx", name: "decoder.onnx", size: 1_063_189, sha256: "f61ebd3eed3773a44d088d53dfae92dbb6aec4839f4dcaee2d402414741663a3" },
        KwsFile { archive_name: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx", name: "joiner.int8.onnx", size: 163_380, sha256: "eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c" },
        KwsFile { archive_name: "tokens.txt", name: "tokens.txt", size: 5_006, sha256: "fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53" },
    ],
};

/// The phrase as BPE tokens of the English model, with a few ways a Spanish speaker
/// says it. Hand-encoded from the model's own tokens.txt (no sentencepiece needed).
pub fn keywords_text() -> String {
    ["▁O K ▁A B I T O", "▁OKAY ▁A B I T O", "▁O K ▁A B E T O", "▁OKAY ▁A B E T O", "▁O K ▁A ▁BE T O"]
        .iter()
        .map(|k| format!("{k} @ok_abito\n"))
        .collect()
}

impl KwsSpec {
    pub fn dir_in(&self, root: &Path) -> PathBuf {
        root.join(self.id)
    }
    pub fn dir(&self) -> PathBuf {
        self.dir_in(&models_dir())
    }
    pub fn is_present_in(&self, root: &Path) -> bool {
        let d = self.dir_in(root);
        std::fs::metadata(d.join("keywords.txt")).is_ok()
            && self.files.iter().all(|f| std::fs::metadata(d.join(f.name)).map(|m| m.len() == f.size).unwrap_or(false))
    }
    pub fn is_present(&self) -> bool {
        self.is_present_in(&models_dir())
    }
}

// ── Safe install ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum KwsError {
    /// `tar` or `bzip2` is not installed.
    NoTar,
    /// The archive is not the pinned one.
    Archive,
    /// The listing holds something unexpected (named).
    Listing(String),
    /// An extracted file is not the pinned one (named).
    File(String),
    Io(String),
}

impl KwsError {
    /// What Settings shows.
    pub fn message(&self) -> String {
        match self {
            KwsError::NoTar => "Install tar and bzip2 to unpack the wake-word model, then try again.".into(),
            KwsError::Archive => "The download is not the expected file; it was discarded.".into(),
            KwsError::Listing(n) => format!("The download holds an unexpected entry ({n}); it was discarded."),
            KwsError::File(n) => format!("{n} is not the expected file; the download was discarded."),
            KwsError::Io(e) => e.clone(),
        }
    }
}

impl From<std::io::Error> for KwsError {
    fn from(e: std::io::Error) -> Self {
        KwsError::Io(e.to_string())
    }
}

fn hex_sha256_file(path: &Path) -> std::io::Result<(String, u64)> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut n = 0u64;
    loop {
        let r = f.read(&mut buf)?;
        if r == 0 {
            break;
        }
        h.update(&buf[..r]);
        n += r as u64;
    }
    Ok((h.finalize().iter().map(|b| format!("{b:02x}")).collect(), n))
}

/// Checks `tar -tvjf` output: regular files and directories only, and only expected names.
pub fn validate_listing(spec: &KwsSpec, verbose: &str) -> Result<(), KwsError> {
    for line in verbose.lines().filter(|l| !l.trim().is_empty()) {
        let bad = |why: &str| KwsError::Listing(format!("{why}: {}", line.chars().take(120).collect::<String>()));
        match line.chars().next() {
            Some('-') | Some('d') => {}
            _ => return Err(bad("link or special file")),
        }
        if line.contains(" -> ") || line.contains(" link to ") {
            return Err(bad("link"));
        }
        let name = line.split_whitespace().last().unwrap_or("");
        let name = name.strip_prefix("./").unwrap_or(name);
        if name.is_empty() || name == "." || name == "./" {
            continue;
        }
        if name.starts_with('/') || name.split('/').any(|p| p == "..") {
            return Err(bad("unsafe path"));
        }
        if !spec.listing.contains(&name) {
            return Err(bad("unexpected entry"));
        }
    }
    Ok(())
}

/// Runs the system `tar`; a missing binary (or bzip2) is `NoTar`.
pub fn run_tar(bin: &OsStr, args: &[&str]) -> Result<String, KwsError> {
    let out = Command::new(bin).args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { KwsError::NoTar } else { KwsError::Io(e.to_string()) }
    })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("bzip2") && (err.contains("not found") || err.contains("No such file")) {
            return Err(KwsError::NoTar);
        }
        return Err(KwsError::Io(format!("tar: {}", err.trim())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Verifies `archive`, extracts the files we use into a fresh sibling directory,
/// verifies each, writes the keywords and moves the folder into place.
pub fn install_from_archive(spec: &KwsSpec, archive: &Path, root: &Path) -> Result<(), KwsError> {
    let (hash, size) = hex_sha256_file(archive)?;
    if size != spec.archive_size || hash != spec.archive_sha256 {
        return Err(KwsError::Archive);
    }
    let arch = archive.to_string_lossy().to_string();
    // Cheap probe first: a missing tar/bzip2 must be reported as such.
    let verbose = run_tar(OsStr::new("tar"), &["-tvjf", &arch])?;
    validate_listing(spec, &verbose)?;
    std::fs::create_dir_all(root)?;
    let tmp = root.join(format!(".{}.tmp-{}", spec.id, std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let result = (|| {
        let extract = tmp.join("x");
        std::fs::create_dir_all(&extract)?;
        let members: Vec<String> = spec.files.iter().map(|f| format!("{}/{}", spec.prefix, f.archive_name)).collect();
        // The members may be stored with a "./" prefix; try the plain name first.
        let mut args: Vec<&str> = vec!["-xjf", &arch, "-C"];
        let extract_s = extract.to_string_lossy().to_string();
        args.push(&extract_s);
        args.push("--no-same-owner");
        args.push("--no-same-permissions");
        let plain: Vec<&str> = members.iter().map(String::as_str).collect();
        let dotted: Vec<String> = members.iter().map(|m| format!("./{m}")).collect();
        let mut with_plain = args.clone();
        with_plain.extend(plain);
        if run_tar(OsStr::new("tar"), &with_plain).is_err() {
            let mut with_dotted = args.clone();
            with_dotted.extend(dotted.iter().map(String::as_str));
            run_tar(OsStr::new("tar"), &with_dotted)?;
        }
        let out = tmp.join("out");
        std::fs::create_dir_all(&out)?;
        for f in spec.files {
            let src = extract.join(spec.prefix).join(f.archive_name);
            let meta = std::fs::symlink_metadata(&src).map_err(|_| KwsError::File(f.name.into()))?;
            if !meta.is_file() {
                return Err(KwsError::File(f.name.into()));
            }
            let (h, n) = hex_sha256_file(&src)?;
            if n != f.size || h != f.sha256 {
                return Err(KwsError::File(f.name.into()));
            }
            std::fs::rename(&src, out.join(f.name))?;
        }
        std::fs::write(out.join("keywords.txt"), keywords_text())?;
        let dest = spec.dir_in(root);
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&out, &dest)?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

// ── Download state (separate from the dictation model's) ──────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum KwsState {
    Missing,
    Downloading { fraction: f64 },
    Ready,
    Failed { error: String },
}

struct Dl {
    running: bool,
    fraction: f64,
    error: Option<String>,
}

fn dl() -> &'static Mutex<Dl> {
    static D: OnceLock<Mutex<Dl>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(Dl { running: false, fraction: 0.0, error: None }))
}

pub fn status() -> KwsState {
    let d = dl().lock().unwrap();
    if d.running {
        KwsState::Downloading { fraction: d.fraction }
    } else if KWS.is_present() {
        KwsState::Ready
    } else if let Some(error) = &d.error {
        KwsState::Failed { error: error.clone() }
    } else {
        KwsState::Missing
    }
}

pub fn download_mb() -> u64 {
    KWS.archive_size / 1_000_000
}

/// Downloads and installs on a background thread. ONLY from an explicit user action.
pub fn download(on_change: impl Fn(KwsState) + Send + 'static) {
    {
        let mut d = dl().lock().unwrap();
        if d.running {
            return;
        }
        d.running = true;
        d.fraction = 0.0;
        d.error = None;
    }
    on_change(status());
    let spawned = std::thread::Builder::new().name("abito-kws-download".into()).spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())
            .and_then(|rt| rt.block_on(fetch_and_install(&on_change)));
        {
            let mut d = dl().lock().unwrap();
            d.running = false;
            if let Err(e) = result {
                d.error = Some(e);
            }
        }
        on_change(status());
    });
    if let Err(e) = spawned {
        let mut d = dl().lock().unwrap();
        d.running = false;
        d.error = Some(e.to_string());
    }
}

async fn fetch_and_install(on_change: &impl Fn(KwsState)) -> Result<(), String> {
    use futures_util::StreamExt;
    let root = models_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let part = root.join(format!(".{}.part", KWS.id));
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(KWS.archive_url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let file = ModelFile { name: "kws", url: KWS.archive_url, size: KWS.archive_size, sha256: KWS.archive_sha256 };
    let mut verifier = Verifier::new(&file);
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut last = Instant::now();
    let mut ok = true;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if !verifier.update(&chunk) {
            ok = false;
            break;
        }
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            dl().lock().unwrap().fraction = verifier.bytes() as f64 / KWS.archive_size as f64 * 0.95;
            on_change(status());
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if !ok || !verifier.finish() {
        let _ = std::fs::remove_file(&part);
        return Err(KwsError::Archive.message());
    }
    let r = install_from_archive(&KWS, &part, &root);
    let _ = std::fs::remove_file(&part);
    r.map_err(|e| e.message())
}

pub fn remove() {
    let _ = std::fs::remove_dir_all(KWS.dir());
    dl().lock().unwrap().error = None;
}

// ── Energy VAD (port of NotchBuddy's EnergyVAD) ───────────────────────────────

/// One frame is 100 ms of 16 kHz audio.
pub const FRAME: usize = 1_600;
const FPS: f64 = 10.0;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum VadEvent {
    None,
    Start,
    End,
}

pub struct EnergyVad {
    calib_limit: usize,
    silence_limit: usize,
    active_limit: usize,
    k_calib: f64,
    k_idle: f64,
    k_silent: f64,
    pub active: bool,
    pub noise: f64,
    calib: usize,
    silent: usize,
    count: usize,
}

impl EnergyVad {
    const RISE: f64 = 8.0;
    const FALL: f64 = 2.0;

    pub fn new() -> Self {
        let r = FPS / 43.0;
        let k = |per_ref: f64| 1.0 - (1.0 - per_ref).powf(1.0 / r);
        Self {
            calib_limit: ((22.0 * r).round() as usize).max(1),
            silence_limit: ((35.0 * r).round() as usize).max(1),
            active_limit: ((1300.0 * r).round() as usize).max(1),
            k_calib: k(0.15),
            k_idle: k(0.005),
            k_silent: k(0.001),
            active: false,
            noise: 1e-7,
            calib: 0,
            silent: 0,
            count: 0,
        }
    }

    pub fn feed(&mut self, power: f64) -> VadEvent {
        if self.calib < self.calib_limit {
            self.calib += 1;
            self.noise = self.noise * (1.0 - self.k_calib) + power * self.k_calib;
            return VadEvent::None;
        }
        if !self.active {
            self.noise = self.noise * (1.0 - self.k_idle) + power * self.k_idle;
            if power > self.noise * Self::RISE {
                self.active = true;
                self.silent = 0;
                self.count = 0;
                return VadEvent::Start;
            }
            return VadEvent::None;
        }
        self.count += 1;
        if self.count >= self.active_limit {
            self.active = false;
            self.silent = 0;
            self.count = 0;
            return VadEvent::End;
        }
        if power < self.noise * Self::FALL {
            self.silent += 1;
            self.noise = self.noise * (1.0 - self.k_silent) + power * self.k_silent;
            if self.silent >= self.silence_limit {
                self.active = false;
                self.silent = 0;
                self.count = 0;
                return VadEvent::End;
            }
        } else {
            self.silent = 0;
        }
        VadEvent::None
    }
}

impl Default for EnergyVad {
    fn default() -> Self {
        Self::new()
    }
}

fn power(frame: &[f32]) -> f64 {
    frame.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / frame.len().max(1) as f64
}

// ── The wake loop ─────────────────────────────────────────────────────────────

/// A keyword spotter fed 16 kHz mono frames.
pub trait Spotter {
    fn feed(&mut self, frame: &[f32]) -> bool;
    fn reset(&mut self);
}

#[derive(Debug, PartialEq)]
pub enum LoopEvent {
    /// The phrase was heard.
    Wake,
    /// What was said after it (16 kHz mono).
    Command(Vec<f32>),
    /// Nothing was said after it.
    Timeout,
}

/// No speech after the wake within this many frames: give up (3 s).
const INITIAL_TIMEOUT: usize = 30;
/// A command never lasts longer than this many frames (20 s).
const COMMAND_MAX: usize = 200;

enum Mode {
    Idle,
    Command { samples: Vec<f32>, frames: usize, speech: bool, tail: bool, waited: usize },
}

pub struct WakeLoop<S: Spotter> {
    spotter: S,
    vad: EnergyVad,
    pending: Vec<f32>,
    mode: Mode,
}

impl<S: Spotter> WakeLoop<S> {
    pub fn new(spotter: S) -> Self {
        Self { spotter, vad: EnergyVad::new(), pending: Vec::new(), mode: Mode::Idle }
    }

    pub fn feed(&mut self, samples: &[f32]) -> Vec<LoopEvent> {
        self.pending.extend_from_slice(samples);
        let mut events = Vec::new();
        while self.pending.len() >= FRAME {
            let frame: Vec<f32> = self.pending.drain(..FRAME).collect();
            self.frame(&frame, &mut events);
        }
        events
    }

    fn frame(&mut self, frame: &[f32], events: &mut Vec<LoopEvent>) {
        let p = power(frame);
        let vad_event = self.vad.feed(p);
        let loud = self.vad.active || p > self.vad.noise * EnergyVad::RISE;
        match &mut self.mode {
            Mode::Idle => {
                if self.spotter.feed(frame) {
                    self.spotter.reset();
                    events.push(LoopEvent::Wake);
                    self.mode = Mode::Command {
                        samples: Vec::new(),
                        frames: 0,
                        speech: false,
                        tail: self.vad.active,
                        waited: 0,
                    };
                }
            }
            Mode::Command { samples, frames, speech, tail, waited } => {
                samples.extend_from_slice(frame);
                *frames += 1;
                if loud && *frames > 1 {
                    *speech = true;
                }
                if !*speech {
                    *waited += 1;
                }
                let finished = match vad_event {
                    VadEvent::End if *speech => true,
                    VadEvent::End if *tail => {
                        // The wake phrase's own speech ended: wait for the command.
                        *tail = false;
                        samples.clear();
                        *waited = 0;
                        false
                    }
                    _ => false,
                };
                if finished || *frames >= COMMAND_MAX {
                    let out = std::mem::take(samples);
                    events.push(LoopEvent::Command(out));
                    self.mode = Mode::Idle;
                    self.vad.reset_activity();
                } else if !*speech && *waited >= INITIAL_TIMEOUT {
                    events.push(LoopEvent::Timeout);
                    self.mode = Mode::Idle;
                }
            }
        }
    }
}

impl EnergyVad {
    /// After a command: keep the learned noise floor, drop the activity counters.
    pub fn reset_activity(&mut self) {
        self.active = false;
        self.silent = 0;
        self.count = 0;
    }
}

// ── sherpa-onnx spotter ───────────────────────────────────────────────────────

pub struct SherpaSpotter {
    kws: sherpa_onnx::KeywordSpotter,
    stream: sherpa_onnx::OnlineStream,
}

impl SherpaSpotter {
    pub fn load() -> Option<Self> {
        if !KWS.is_present() {
            return None;
        }
        let d = KWS.dir();
        let p = |n: &str| d.join(n).to_string_lossy().to_string();
        let mut c = sherpa_onnx::KeywordSpotterConfig::default();
        c.model_config.transducer = sherpa_onnx::OnlineTransducerModelConfig {
            encoder: Some(p("encoder.int8.onnx")),
            decoder: Some(p("decoder.onnx")),
            joiner: Some(p("joiner.int8.onnx")),
        };
        c.model_config.tokens = Some(p("tokens.txt"));
        c.model_config.num_threads = 1;
        c.keywords_file = Some(p("keywords.txt"));
        c.keywords_score = 2.0;
        c.keywords_threshold = 0.2;
        let kws = sherpa_onnx::KeywordSpotter::create(&c)?;
        let stream = kws.create_stream();
        Some(Self { kws, stream })
    }
}

impl Spotter for SherpaSpotter {
    fn feed(&mut self, frame: &[f32]) -> bool {
        self.stream.accept_waveform(SAMPLE_RATE as i32, frame);
        let mut hit = false;
        while self.kws.is_ready(&self.stream) {
            self.kws.decode(&self.stream);
            if let Some(r) = self.kws.get_result(&self.stream) {
                if !r.keyword.is_empty() {
                    hit = true;
                    self.kws.reset(&self.stream);
                }
            }
        }
        hit
    }
    fn reset(&mut self) {
        self.kws.reset(&self.stream);
    }
}

pub type SharedSpotter = Arc<Mutex<SherpaSpotter>>;
