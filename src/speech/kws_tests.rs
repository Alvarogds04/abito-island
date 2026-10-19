use super::kws::*;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("abito-kws-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

const PREFIX: &str = "pkg";

fn sha(data: &[u8]) -> &'static str {
    use sha2::{Digest, Sha256};
    let hex: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
    Box::leak(hex.into_boxed_str())
}

fn spec(files: &'static [KwsFile], archive: &[u8]) -> KwsSpec {
    KwsSpec { id: "t", archive_url: "https://example.invalid/a.tar.bz2", archive_size: archive.len() as u64, archive_sha256: sha(archive), prefix: PREFIX, listing: &["pkg/", "pkg/a.bin", "pkg/tokens.txt"], files }
}

/// Builds a real .tar.bz2 with the system tar.
fn build_archive(dir: &std::path::Path, extra: impl Fn(&std::path::Path)) -> Vec<u8> {
    let src = dir.join("src");
    std::fs::create_dir_all(src.join(PREFIX)).unwrap();
    std::fs::write(src.join(PREFIX).join("a.bin"), b"AAAA").unwrap();
    std::fs::write(src.join(PREFIX).join("tokens.txt"), b"tok").unwrap();
    extra(&src);
    let out = dir.join("a.tar.bz2");
    let ok = std::process::Command::new("tar").arg("-cjf").arg(&out).arg("-C").arg(&src).arg(".").status().unwrap().success();
    assert!(ok);
    std::fs::read(out).unwrap()
}

static FILES: &[KwsFile] = &[
    KwsFile { archive_name: "a.bin", name: "encoder.int8.onnx", size: 4, sha256: "63c1dd951ffedf6f7fd968ad4efa39b8ed584f162f46e715114ee184f8de9201" },
    KwsFile { archive_name: "tokens.txt", name: "tokens.txt", size: 3, sha256: "1d5e8c4a1e1d4e5f0a3f2e6b0e0a9d9d5a1c1a2d2b8f0d3c4c8f0a1b6a1e0c11" },
];

#[test]
fn the_pinned_kws_set_adds_up_and_is_https() {
    assert!(KWS.archive_url.starts_with("https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"));
    assert_eq!(KWS.archive_size, 17_626_723);
    assert_eq!(KWS.archive_sha256, "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a");
    assert_eq!(KWS.files.len(), 4);
    for f in KWS.files {
        assert_eq!(f.sha256.len(), 64, "{}", f.name);
    }
}

#[test]
fn the_keyword_file_names_ok_abito_with_a_label() {
    let k = keywords_text();
    assert!(k.lines().count() >= 2);
    assert!(k.lines().all(|l| l.ends_with("@ok_abito") && l.starts_with('▁')));
}

#[test]
fn the_listing_accepts_only_expected_regular_files() {
    let good = "drwxr-xr-x u/g 0 2024-01-01 00:00 pkg/\n-rw-r--r-- u/g 4 2024-01-01 00:00 pkg/a.bin\n-rw-r--r-- u/g 3 2024-01-01 00:00 pkg/tokens.txt\n";
    let s = spec(FILES, b"x");
    assert!(validate_listing(&s, good).is_ok());
    for bad in [
        "-rw-r--r-- u/g 4 2024-01-01 00:00 /etc/passwd\n",
        "-rw-r--r-- u/g 4 2024-01-01 00:00 pkg/../x\n",
        "lrwxrwxrwx u/g 0 2024-01-01 00:00 pkg/a.bin -> /etc/passwd\n",
        "hrw-r--r-- u/g 0 2024-01-01 00:00 pkg/a.bin link to pkg/x\n",
        "-rw-r--r-- u/g 4 2024-01-01 00:00 pkg/surprise.bin\n",
    ] {
        assert!(validate_listing(&s, bad).is_err(), "{bad}");
    }
}

#[test]
fn an_archive_with_a_wrong_hash_is_refused_before_extracting() {
    let d = scratch("hash");
    let bytes = build_archive(&d, |_| {});
    let s = spec(FILES, &bytes);
    let mut other = bytes.clone();
    other.push(0);
    std::fs::write(d.join("bad.tar.bz2"), &other).unwrap();
    let root = d.join("models");
    let err = install_from_archive(&s, &d.join("bad.tar.bz2"), &root).unwrap_err();
    assert!(matches!(err, KwsError::Archive), "{err:?}");
    assert!(!root.join("t").exists());
}

#[test]
fn a_symlink_or_a_path_escape_inside_the_archive_is_refused() {
    let d = scratch("evil");
    let bytes = build_archive(&d, |src| {
        std::os::unix::fs::symlink("/etc/passwd", src.join(PREFIX).join("evil")).unwrap();
    });
    let s = spec(FILES, &bytes);
    let root = d.join("models");
    let err = install_from_archive(&s, &d.join("a.tar.bz2"), &root).unwrap_err();
    assert!(matches!(err, KwsError::Listing(_)), "{err:?}");
    assert!(!root.join("t").exists());
}

#[test]
fn an_extracted_file_that_is_not_the_pinned_one_is_refused_and_leaves_nothing() {
    let d = scratch("filehash");
    let bytes = build_archive(&d, |_| {});
    static BAD: &[KwsFile] = &[KwsFile { archive_name: "a.bin", name: "encoder.int8.onnx", size: 4, sha256: "00" }];
    let s = spec(BAD, &bytes);
    let root = d.join("models");
    let err = install_from_archive(&s, &d.join("a.tar.bz2"), &root).unwrap_err();
    assert!(matches!(err, KwsError::File(_)), "{err:?}");
    assert!(!root.join("t").exists());
    let leftovers: Vec<_> = std::fs::read_dir(&root).map(|r| r.flatten().collect()).unwrap_or_default();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn a_good_archive_lands_atomically_with_the_keyword_file() {
    let d = scratch("good");
    let bytes = build_archive(&d, |_| {});
    // Pin the two real hashes of the synthetic files.
    let files: &'static [KwsFile] = Box::leak(Box::new([
        KwsFile { archive_name: "a.bin", name: "encoder.int8.onnx", size: 4, sha256: sha(b"AAAA") },
        KwsFile { archive_name: "tokens.txt", name: "tokens.txt", size: 3, sha256: sha(b"tok") },
    ]));
    let s = spec(files, &bytes);
    let root = d.join("models");
    install_from_archive(&s, &d.join("a.tar.bz2"), &root).unwrap();
    assert_eq!(std::fs::read(root.join("t/encoder.int8.onnx")).unwrap(), b"AAAA");
    assert!(std::fs::read_to_string(root.join("t/keywords.txt")).unwrap().contains("@ok_abito"));
    assert!(s.is_present_in(&root));
}

#[test]
fn a_missing_tar_is_a_clear_error_not_a_crash() {
    let d = scratch("notar");
    let err = run_tar(std::ffi::OsStr::new("definitely-not-a-tar-binary"), &["-tjf"]).unwrap_err();
    assert!(matches!(err, KwsError::NoTar), "{err:?}");
    assert!(!err.message().is_empty());
    drop(d);
}

// ── Voice activity and the wake loop ──────────────────────────────────────────

struct FakeSpotter {
    /// Frame indexes (counted from 0) at which the keyword fires.
    fire_at: Vec<usize>,
    seen: usize,
}
impl Spotter for FakeSpotter {
    fn feed(&mut self, _frame: &[f32]) -> bool {
        let hit = self.fire_at.contains(&self.seen);
        self.seen += 1;
        hit
    }
    fn reset(&mut self) {}
}

fn quiet() -> Vec<f32> { vec![0.0005; FRAME] }
fn loud() -> Vec<f32> { (0..FRAME).map(|i| if i % 2 == 0 { 0.3 } else { -0.3 }).collect() }

fn feed_all(l: &mut WakeLoop<FakeSpotter>, frames: &[Vec<f32>]) -> Vec<LoopEvent> {
    frames.iter().flat_map(|f| l.feed(f)).collect()
}

fn calibrated(fire_at: Vec<usize>) -> (WakeLoop<FakeSpotter>, usize) {
    let mut l = WakeLoop::new(FakeSpotter { fire_at, seen: 0 });
    let calib = vec![quiet(); 12];
    assert!(feed_all(&mut l, &calib).is_empty());
    (l, calib.len())
}

#[test]
fn silence_never_wakes() {
    let (mut l, _) = calibrated(vec![]);
    assert!(feed_all(&mut l, &vec![quiet(); 100]).is_empty());
}

#[test]
fn the_keyword_wakes_and_the_following_speech_becomes_the_command() {
    let (mut l, n) = calibrated(vec![14]);
    let mut frames = vec![quiet(); 2]; // frames n..n+2
    frames.extend(vec![loud(); 1]); // frame 14 fires, the user pauses a beat
    frames.extend(vec![quiet(); 3]);
    frames.extend(vec![loud(); 10]); // the command
    frames.extend(vec![quiet(); 12]);
    let ev = feed_all(&mut l, &frames);
    assert_eq!(n, 12);
    assert!(matches!(ev[0], LoopEvent::Wake), "{ev:?}");
    let LoopEvent::Command(samples) = &ev[1] else { panic!("{ev:?}") };
    assert!(samples.len() >= 10 * FRAME && samples.len() < 40 * FRAME, "{}", samples.len());
    assert_eq!(ev.len(), 2);
}

#[test]
fn nothing_said_after_the_wake_times_out_with_no_command() {
    let (mut l, _) = calibrated(vec![13]);
    let mut frames = vec![quiet(); 2];
    frames.extend(vec![quiet(); 60]);
    let ev = feed_all(&mut l, &frames);
    assert!(matches!(ev[0], LoopEvent::Wake), "{ev:?}");
    assert!(matches!(ev[1], LoopEvent::Timeout), "{ev:?}");
    assert_eq!(ev.len(), 2);
}

#[test]
fn after_a_command_the_loop_listens_for_the_wake_again() {
    let (mut l, _) = calibrated(vec![13, 60]);
    let mut frames = vec![loud(); 1];
    frames.extend(vec![quiet(); 3]);
    frames.extend(vec![loud(); 8]);
    frames.extend(vec![quiet(); 60]);
    let ev = feed_all(&mut l, &frames);
    assert_eq!(ev.iter().filter(|e| matches!(e, LoopEvent::Wake)).count(), 2, "{ev:?}");
}

#[test]
fn a_command_never_runs_longer_than_the_cap() {
    let (mut l, _) = calibrated(vec![13]);
    let mut frames = vec![loud(); 1];
    frames.extend(vec![loud(); 400]);
    let ev = feed_all(&mut l, &frames);
    let LoopEvent::Command(s) = ev.iter().find(|e| matches!(e, LoopEvent::Command(_))).expect("capped") else { unreachable!() };
    assert!(s.len() <= 21 * 10 * FRAME / 10 * 10, "{}", s.len());
}

#[test]
fn partial_frames_are_buffered_across_calls() {
    let (mut l, _) = calibrated(vec![12]);
    let mut ev = vec![];
    for _ in 0..4 { for chunk in quiet().chunks(FRAME / 3) { ev.extend(l.feed(chunk)); } }
    assert!(matches!(ev.first(), Some(LoopEvent::Wake)), "{ev:?}");
}

/// Manual accuracy probe: NB488_KWS_ARCHIVE=<tar.bz2> NB488_WAVS=<dir of .f32 16 kHz mono>
/// cargo test --offline --lib live_probe -- --ignored --nocapture
#[test]
#[ignore]
fn live_probe() {
    let (Ok(archive), Ok(wavs)) = (std::env::var("NB488_KWS_ARCHIVE"), std::env::var("NB488_WAVS")) else { return };
    let root = scratch("probe");
    install_from_archive(&KWS, std::path::Path::new(&archive), &root).unwrap();
    let mut names: Vec<_> = std::fs::read_dir(&wavs).unwrap().flatten().map(|e| e.path()).collect();
    names.sort();
    for p in names {
        let bytes = std::fs::read(&p).unwrap();
        let mut s: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        s.extend(vec![0.0; 16000]);
        let c = {
            let d = KWS.dir_in(&root);
            let q = |n: &str| d.join(n).to_string_lossy().to_string();
            let mut c = sherpa_onnx::KeywordSpotterConfig::default();
            c.model_config.transducer = sherpa_onnx::OnlineTransducerModelConfig { encoder: Some(q("encoder.int8.onnx")), decoder: Some(q("decoder.onnx")), joiner: Some(q("joiner.int8.onnx")) };
            c.model_config.tokens = Some(q("tokens.txt"));
            c.model_config.num_threads = 1;
            c.keywords_file = Some(std::env::var("NB488_KW").unwrap_or(q("keywords.txt")));
            c.keywords_score = 2.0;
            c.keywords_threshold = 0.2;
            c
        };
        let k = sherpa_onnx::KeywordSpotter::create(&c).expect("spotter");
        let st = k.create_stream();
        let mut hit = false;
        for f in s.chunks(1600) {
            st.accept_waveform(16000, f);
            while k.is_ready(&st) { k.decode(&st); if let Some(r) = k.get_result(&st) { if !r.keyword.is_empty() { hit = true; k.reset(&st); } } }
        }
        println!("{} -> {}", p.file_name().unwrap().to_string_lossy(), hit);
    }
}

#[test]
fn arming_the_loop_takes_the_next_phrase_as_a_command_without_a_wake() {
    let (mut l, _) = calibrated(vec![]);
    l.arm_command();
    let mut frames = vec![quiet(); 2];
    frames.extend(vec![loud(); 8]);
    frames.extend(vec![quiet(); 12]);
    let ev = feed_all(&mut l, &frames);
    assert!(matches!(ev.as_slice(), [LoopEvent::Command(s)] if s.len() >= 8 * FRAME), "{ev:?}");
}
