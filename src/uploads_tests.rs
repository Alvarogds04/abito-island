//! #343 — uploads unit tests. Every rejection is asserted to be
//! side-effect free: the directory listing is unchanged (no files, no
//! temp leftovers) and the module keeps no counters or state.

use super::*;
use std::fs;
use std::path::PathBuf;

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "abito-uploads-test-{tag}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 1, 2, 3];
const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
const GIF: &[u8] = b"GIF89a.....";
const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 ";

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

#[test]
fn detects_allowed_types_by_content() {
    assert_eq!(detect_mime(PNG), Some("image/png"));
    assert_eq!(detect_mime(JPEG), Some("image/jpeg"));
    assert_eq!(detect_mime(GIF), Some("image/gif"));
    assert_eq!(detect_mime(WEBP), Some("image/webp"));
    assert_eq!(detect_mime("hola ñandú\n".as_bytes()), Some("text/plain"));
    assert_eq!(detect_mime(b""), None);
    assert_eq!(detect_mime(&[0x1F, 0x8B, 0x08, 0x00]), None); // gzip
    assert_eq!(detect_mime(b"MZ\x90\x00"), None); // executable
    assert_eq!(detect_mime(&[0xFF, 0xD8, 0x00]), None); // truncated JPEG magic
    assert_eq!(detect_mime(b"RIFF\x24\x00\x00\x00WEBPVP8 "), Some("image/webp"));
    assert_eq!(detect_mime(b"RIFF\x24\x00\x00\x00WAVE"), None); // RIFF but not WebP
    assert_eq!(detect_mime(b"RIFF\x24\x00\x00\x00WEB"), None); // too short
}

#[test]
fn plain_text_bounded_and_control_free() {
    assert!(is_plain_text(b"linea 1\nlinea 2\tcon tab\r\n"));
    assert!(!is_plain_text(&[0x68, 0x69, 0x00])); // NUL
    assert!(!is_plain_text(&[0x68, 0x69, 0x07])); // BEL
    assert!(!is_plain_text(&[0xFF, 0xFE])); // invalid UTF-8
    let big = "ñ".repeat(MAX_TEXT_SCALARS + 1);
    assert!(!is_plain_text(big.as_bytes()));
    assert!(is_plain_text("ñ".repeat(MAX_TEXT_SCALARS).as_bytes()));
}

#[test]
fn sanitize_name_keeps_a_safe_display_name() {
    assert_eq!(sanitize_name("../etc/passwd"), "passwd");
    assert_eq!(sanitize_name("C:\\Users\\alguien\\foto.png"), "foto.png");
    assert_eq!(sanitize_name("documento final?.pdf"), "documento final_.pdf");
    assert_eq!(sanitize_name(".."), "archivo");
    assert_eq!(sanitize_name(""), "archivo");
    assert_eq!(sanitize_name("\u{7}campana\u{8}.txt"), "campana.txt");
    assert_eq!(sanitize_name(".oculto."), "oculto");
    let long = "a".repeat(90);
    assert_eq!(sanitize_name(&long).chars().count(), 80);
    assert_eq!(sanitize_name("café.png"), "café.png");
}

#[test]
fn id_and_stored_name_grammar() {
    assert!(valid_attachment_id("a-0123456789abcdef"));
    assert!(!valid_attachment_id("a-0123456789ABCDEF")); // uppercase refused
    assert!(!valid_attachment_id("a-0123"));
    assert!(!valid_attachment_id("b-0123456789abcdef"));
    assert!(!valid_attachment_id("a-0123456789abcdefg"));
    assert!(valid_stored_name("0123456789abcdef-informe q1.txt"));
    assert!(!valid_stored_name("0123456789abcdef-../escape.txt"));
    assert!(!valid_stored_name("zz-informe.txt"));
    assert!(!valid_stored_name("0123456789abcdef-informe.txt.exe/extra"));
}

#[test]
fn attach_stores_the_file_and_returns_metadata() {
    let dir = temp_root("ok");
    let stored = attach(&dir, "captura de pantalla.png", PNG).unwrap();
    assert!(valid_attachment_id(&stored.id));
    assert_eq!(stored.name, "captura de pantalla.png");
    assert_eq!(stored.mime, "image/png");
    assert_eq!(stored.size, PNG.len() as u64);
    let file = dir.join(format!("{}-{}", stored.id.strip_prefix("a-").unwrap(), stored.name));
    assert!(valid_stored_name(file.file_name().unwrap().to_str().unwrap()));
    assert_eq!(fs::read(&file).unwrap(), PNG);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn attach_rejections_leave_the_directory_untouched() {
    let dir = temp_root("reject");
    // Empty
    assert!(attach(&dir, "vacio.txt", b"").is_err());
    // Oversize (one byte past the cap)
    let big = vec![0x61u8; MAX_FILE_BYTES + 1];
    assert!(attach(&dir, "grande.txt", &big).is_err());
    // Disallowed content (valid UTF-8 is text, so use binary junk)
    assert!(attach(&dir, "programa.bin", &[0x00, 0x01, 0x02, 0xFF, 0xFE]).is_err());
    // Text file past the scalar cap
    let long_text = "ñ".repeat(MAX_TEXT_SCALARS + 1);
    assert!(attach(&dir, "largo.txt", long_text.as_bytes()).is_err());
    // NOTHING was created: no stored file, no temp file, no directory side effects.
    assert_eq!(listing(&dir), Vec::<String>::new());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unwritable_target_leaves_nothing_behind() {
    let root = temp_root("failwrite");
    // A FILE where the uploads directory would live makes create_dir_all
    // fail: the error is honest and NOTHING is written anywhere.
    let blocker = root.join("bloqueo");
    fs::write(&blocker, b"no es un directorio").unwrap();
    let dir = blocker.join("uploads");
    let error = attach(&dir, "choque.png", PNG).unwrap_err();
    assert!(error.safe_message.contains("No se pudo preparar"));
    assert_eq!(listing(&root), vec!["bloqueo".to_string()]);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn attachments_dir_uses_the_configured_workspace_and_falls_back() {
    let root = temp_root("dir");
    let island = root.join(".abito-island");
    fs::create_dir_all(island.join("workspace")).unwrap();

    // No config: the island's owned default workspace.
    let dir = attachments_dir(&island).unwrap();
    assert_eq!(dir, island.join("workspace").join("uploads"));
    assert!(dir.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }

    // A valid configured workspace wins.
    let other = root.join("mi trabajo");
    fs::create_dir_all(&other).unwrap();
    fs::write(
        island.join("config.json"),
        format!("{{\"workspace\": \"{}\"}}", other.display()),
    )
    .unwrap();
    assert_eq!(attachments_dir(&island).unwrap(), other.join("uploads"));

    // Invalid workspaces fall back: relative, `..`, missing, wrong type.
    for bad in ["../escape", "relativo", "/definitivamente/inesistente"] {
        fs::write(island.join("config.json"), format!("{{\"workspace\": \"{bad}\"}}")).unwrap();
        assert_eq!(attachments_dir(&island).unwrap(), island.join("workspace").join("uploads"), "{bad}");
    }
    fs::write(island.join("config.json"), b"{ not json").unwrap();
    assert_eq!(attachments_dir(&island).unwrap(), island.join("workspace").join("uploads"));

    // A missing island root is an honest error, never a creation outside it.
    let _ = fs::remove_dir_all(&island);
    assert!(attachments_dir(&island).is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn valid_workspace_shape() {
    let root = temp_root("shape");
    let inner = root.join("ws");
    fs::create_dir_all(&inner).unwrap();
    assert!(valid_workspace(&inner));
    assert!(!valid_workspace(&root.join("inesistente"))); // must exist
    assert!(!valid_workspace(Path::new("relativo/ws"))); // absolute only
    assert!(!valid_workspace(&root.join("ws").join("..").join("otro"))); // no `..`
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn read_dropped_caps_before_reading_and_rejects_non_files() {
    let root = temp_root("dropped");
    let file = root.join("nota.txt");
    fs::write(&file, b"hola").unwrap();
    let (name, bytes) = read_dropped(&file).unwrap();
    assert_eq!(name, "nota.txt");
    assert_eq!(bytes, b"hola");

    let big = root.join("grande.bin");
    fs::write(&big, vec![0x61u8; MAX_FILE_BYTES + 1]).unwrap();
    assert!(read_dropped(&big).is_err()); // refused before buffering

    assert!(read_dropped(&root.join("inesistente.txt")).is_err());
    let sub = root.join("carpeta");
    fs::create_dir(&sub).unwrap();
    assert!(read_dropped(&sub).is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn split_raw_body_takes_a_bounded_header_line() {
    let body = format!("{{\"name\":\"informe.txt\"}}\ncontenido",);
    let (name, rest) = split_raw_body(body.as_bytes()).unwrap();
    assert_eq!(name, "informe.txt");
    assert_eq!(rest, b"contenido");
    // Binary content after the header line passes through untouched.
    let mut binary = b"{\"name\":\"f.png\"}\n".to_vec();
    binary.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0x00, 0x0A]);
    let (name, rest) = split_raw_body(&binary).unwrap();
    assert_eq!(name, "f.png");
    assert_eq!(rest, &[0xFF, 0xD8, 0xFF, 0x00, 0x0A]);
    // No header line, oversize header, bad JSON, missing name.
    assert!(split_raw_body(b"sin header").is_err());
    assert!(split_raw_body(&[b'x'; 2048]).is_err());
    assert!(split_raw_body(b"{oops}\nbytes").is_err());
    assert!(split_raw_body(b"{}\nbytes").is_err());
    assert!(split_raw_body(b"").is_err());
}
