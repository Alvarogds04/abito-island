//! Slice A: identity/token/link (pairing), admission bookkeeping and the TLS hello. The client side
//! of the tests pins the certificate by SHA-256 exactly as the phone does, over real TLS on loopback.
use super::ids;
use super::pairing::{self, SecretStore};
use super::server::{self, Features, Shared, PROTOCOL};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

// ---- the identifiers live in ONE module -----------------------------------------------------------

#[test]
fn the_wire_identifiers_are_in_one_module_and_user_text_says_abito() {
    assert_eq!(ids::SCHEME, "abito");
    assert_eq!(ids::MDNS_SERVICE, "_abito._tcp");
    assert_eq!(ids::CERT_CN, "Abito phone link");
    assert_eq!(ids::DEFAULT_NAME, "Abito");
    // No other file spells an identifier: each takes it from ids.rs (the switch stays one line).
    for f in ["pairing.rs", "server.rs", "admission.rs"] {
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/phone_link").join(f)).unwrap();
        let code: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        assert!(!code.contains("abito://") && !code.contains("_abito") && !code.contains("phone link\""), "{f} must take the identifiers from ids.rs");
    }
}

// ---- pairing --------------------------------------------------------------------------------------

#[derive(Default)]
struct Mem(std::sync::Mutex<std::collections::HashMap<String, String>>);
impl SecretStore for Mem {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
}

#[test]
fn the_certificate_is_made_once_kept_and_its_fingerprint_is_the_sha256_of_the_der() {
    let store = Mem::default();
    let a = pairing::load_or_create_identity(&store).unwrap();
    let b = pairing::load_or_create_identity(&store).unwrap();
    assert_eq!((a.cert_der.clone(), a.fingerprint.clone()), (b.cert_der, b.fingerprint.clone()));
    assert_eq!(a.fingerprint.len(), 64);
    assert_eq!(a.fingerprint, super::hex(ring::digest::digest(&ring::digest::SHA256, &a.cert_der).as_ref()));
    store.set(pairing::PRIVATE_KEY, "zz-not-hex").unwrap();
    let c = pairing::load_or_create_identity(&store).unwrap();
    assert_ne!(a.fingerprint, c.fingerprint, "a damaged key means a new identity, not a crash");
    assert_eq!(pairing::load_or_create_identity(&store).unwrap().fingerprint, c.fingerprint);
}

#[test]
fn tokens_are_valid_random_kept_and_replaced_on_demand() {
    let store = Mem::default();
    let a = pairing::token(&store).unwrap();
    assert!(pairing::is_token(&a));
    assert_eq!(pairing::token(&store).unwrap(), a);
    let b = pairing::new_token(&store).unwrap();
    assert_ne!(a, b);
    assert_eq!(pairing::token(&store).unwrap(), b);
    store.set(pairing::TOKEN_KEY, "short").unwrap();
    assert!(pairing::is_token(&pairing::token(&store).unwrap()), "a damaged token is replaced");
    assert!(pairing::is_token(&"a".repeat(16)) && pairing::is_token(&"A-_9".repeat(32)));
    for bad in ["a".repeat(15), "a".repeat(129), "aaaaaaaaaaaaaaa!".into(), "aaaaaaaaaaaaaaa ".into(), String::new()] {
        assert!(!pairing::is_token(&bad), "{bad:?}");
    }
}

#[test]
fn the_pairing_link_has_every_field_and_encodes_the_name() {
    let link = pairing::pairing_link("192.168.1.20", 47821, &"ab".repeat(32), "tok_en-1234567890abcd", "Léa's PC & co");
    assert_eq!(
        link,
        format!(
            "{}://pair?v=1&host=192.168.1.20&port=47821&fp={}&token=tok_en-1234567890abcd&name=L%C3%A9a%27s%20PC%20%26%20co",
            ids::SCHEME,
            "ab".repeat(32)
        )
    );
    let long = pairing::pairing_link("2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", 47821, &"ab".repeat(32), &"t".repeat(128), &"é".repeat(48));
    assert!(long.len() < 2048, "the phone refuses 2,048 characters or more: {}", long.len());
    assert!(pairing::qr_svg(&long).is_some());
    let svg = pairing::qr_svg(&link).unwrap();
    assert!(svg.contains("<svg") && !svg.contains("script"));
}

// ---- admission ------------------------------------------------------------------------------------

mod admission {
    use super::super::admission::*;
    use std::net::IpAddr;
    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn one_address_holds_at_most_two_unauthenticated_connections() {
        let a = Admission::new();
        let t1 = a.admit(ip("192.168.1.50")).unwrap();
        let _t2 = a.admit(ip("192.168.1.50")).unwrap();
        assert!(a.admit(ip("192.168.1.50")).is_none());
        assert!(a.admit(ip("192.168.1.51")).is_some());
        drop(t1);
        assert!(a.admit(ip("192.168.1.50")).is_some());
        let b = Admission::new();
        let _x = b.admit(ip("192.168.1.50")).unwrap();
        let _y = b.admit(ip("::ffff:192.168.1.50")).unwrap();
        assert!(b.admit(ip("192.168.1.50")).is_none(), "the same address written two ways is one address");
    }

    #[test]
    fn strangers_share_a_pool_and_a_flood_cannot_lock_out_the_paired_phone() {
        let a = Admission::new();
        a.admit(ip("192.168.1.20")).unwrap().authenticated();
        assert!(a.knows(ip("192.168.1.20")));
        let flood: Vec<_> = (0..50).filter_map(|n| a.admit(ip(&format!("192.168.1.{}", 100 + n)))).collect();
        assert_eq!(flood.len(), MAX_UNAUTH_STRANGERS);
        let phone = a.admit(ip("192.168.1.20")).expect("the paired phone is not locked out");
        phone.authenticated();
        a.admit(ip("192.168.1.20")).expect("and reconnects during the flood").authenticated();
        assert!(a.counts().0 <= MAX_CONNECTIONS);
    }

    #[test]
    fn the_places_come_back_the_wait_shortens_and_eight_addresses_are_remembered() {
        let a = Admission::new();
        {
            let t1 = a.admit(ip("192.168.1.20")).unwrap();
            let _t2 = a.admit(ip("192.168.1.21")).unwrap();
            t1.authenticated();
            t1.authenticated();
        }
        assert_eq!(a.counts(), (0, 0));
        let b = Admission::new();
        assert_eq!(b.admit(ip("192.168.1.1")).unwrap().wait(), PATIENT);
        let _held: Vec<_> = (0..2).map(|n| b.admit(ip(&format!("192.168.2.{n}"))).unwrap()).collect();
        assert_eq!(b.admit(ip("192.168.3.1")).unwrap().wait(), HURRIED);
        let c = Admission::new();
        for n in 0..(KNOWN_ADDRESSES + 3) {
            c.admit(ip(&format!("192.168.5.{n}"))).unwrap().authenticated();
        }
        assert!(!c.knows(ip("192.168.5.0")) && c.knows(ip(&format!("192.168.5.{}", KNOWN_ADDRESSES + 2))));
        let d = Admission::new();
        let mut held = Vec::new();
        for n in 0..MAX_CONNECTIONS {
            let t = d.admit(ip(&format!("192.168.1.{}", 10 + n))).unwrap();
            t.authenticated();
            held.push(t);
        }
        assert!(d.admit(ip("192.168.1.10")).is_none(), "never over eight, even for known phones");
    }
}

// ---- the TLS server ---------------------------------------------------------------------------------

struct Off;
impl Features for Off {}

/// A client verifier that accepts exactly one certificate, by SHA-256: what the phone does.
#[derive(Debug)]
struct Pin(String);
impl rustls::client::danger::ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let got = super::hex(ring::digest::digest(&ring::digest::SHA256, end_entity.as_ref()).as_ref());
        if got == self.0 { Ok(rustls::client::danger::ServerCertVerified::assertion()) } else { Err(rustls::Error::General("pin mismatch".into())) }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

struct Rig {
    port: u16,
    fingerprint: String,
    token: String,
    handle: Option<server::Handle>,
}

async fn start() -> Rig {
    let store = Mem::default();
    let id = pairing::load_or_create_identity(&store).unwrap();
    let token = pairing::token(&store).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared = Shared::new(token.clone(), "Test PC".into(), Arc::new(Off));
    let handle = server::serve(listener, server::tls_acceptor(&id).unwrap(), shared);
    Rig { port, fingerprint: id.fingerprint, token, handle: Some(handle) }
}

type Client = (BufReader<tokio::io::ReadHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>>, tokio::io::WriteHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>);

async fn connect(port: u16, pin: &str) -> Result<Client, std::io::Error> {
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin(pin.to_string())))
        .with_no_client_auth();
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect("abito".try_into().unwrap(), tcp).await?;
    let (r, w) = tokio::io::split(tls);
    Ok((BufReader::new(r), w))
}

async fn send(w: &mut tokio::io::WriteHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>, v: Value) {
    w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
}

async fn recv(r: &mut BufReader<tokio::io::ReadHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>>) -> Option<Value> {
    let mut line = String::new();
    match tokio::time::timeout(std::time::Duration::from_secs(5), r.read_line(&mut line)).await {
        Ok(Ok(n)) if n > 0 => serde_json::from_str(&line).ok(),
        _ => None,
    }
}

#[test]
fn a_paired_phone_gets_welcome_and_pong_and_bye_closes() {
    run(async {
        let rig = start().await;
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":rig.token,"device":"Pixel"})).await;
        let welcome = recv(&mut r).await.unwrap();
        assert_eq!(welcome["type"], "welcome");
        assert_eq!((welcome["v"].as_u64(), welcome["desktop"].as_str(), welcome["os"].as_str()), (Some(1), Some("Test PC"), Some(std::env::consts::OS)));
        assert!(welcome.get("caps").is_none(), "no capability is offered to a phone that asked for none");
        send(&mut w, json!({"type":"ping"})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "pong");
        send(&mut w, json!({"type":"future-thing"})).await;
        send(&mut w, json!({"type":"ping"})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "pong", "unknown types are ignored");
        send(&mut w, json!({"type":"bye"})).await;
        assert!(recv(&mut r).await.is_none(), "bye closes the link");
    });
}

#[test]
fn a_wrong_token_or_version_gets_an_auth_error_and_nothing_else() {
    run(async {
        let rig = start().await;
        for hello in [
            json!({"type":"hello","v":PROTOCOL,"token":"x".repeat(rig.token.len())}),
            json!({"type":"hello","v":PROTOCOL,"token":"short"}),
            json!({"type":"hello","v":PROTOCOL}),
            json!({"type":"hello","v":2,"token":rig.token}),
        ] {
            let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
            send(&mut w, hello).await;
            let e = recv(&mut r).await.unwrap();
            assert_eq!((e["type"].as_str(), e["code"].as_str()), (Some("error"), Some("auth")));
            assert!(recv(&mut r).await.is_none());
        }
    });
}

#[test]
fn a_phone_that_does_not_say_hello_first_gets_nothing() {
    run(async {
        let rig = start().await;
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"ping"})).await;
        assert!(recv(&mut r).await.is_none());
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        w.write_all(b"this is not json\n").await.unwrap();
        assert!(recv(&mut r).await.is_none());
    });
}

#[test]
fn a_line_over_64_kib_closes_and_exactly_64_kib_is_accepted() {
    run(async {
        let rig = start().await;
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":rig.token})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
        let mut line = br#"{"type":"ping","pad":""#.to_vec();
        let tail = br#""}"#;
        line.resize(server::MAX_LINE - tail.len(), b'a');
        line.extend_from_slice(tail);
        assert_eq!(line.len(), server::MAX_LINE);
        line.push(b'\n');
        w.write_all(&line).await.unwrap();
        assert_eq!(recv(&mut r).await.unwrap()["type"], "pong");
        let mut big = br#"{"type":"ping","pad":""#.to_vec();
        big.resize(server::MAX_LINE + 10, b'a');
        big.push(b'\n');
        w.write_all(&big).await.unwrap();
        let e = recv(&mut r).await.unwrap();
        assert_eq!((e["type"].as_str(), e["code"].as_str()), (Some("error"), Some("protocol")));
        assert!(recv(&mut r).await.is_none());
    });
}

#[test]
fn a_phone_pinning_another_certificate_never_connects_and_stop_closes_the_link() {
    run(async {
        let mut rig = start().await;
        assert!(connect(rig.port, &"00".repeat(32)).await.is_err());
        let (mut r, mut w) = connect(rig.port, &rig.fingerprint).await.unwrap();
        send(&mut w, json!({"type":"hello","v":PROTOCOL,"token":rig.token})).await;
        assert_eq!(recv(&mut r).await.unwrap()["type"], "welcome");
        rig.handle.take().unwrap().stop();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", rig.port)).await.is_err(), "nothing listens once it is off");
    });
}

#[test]
fn only_the_local_network_may_connect() {
    for ok in ["192.168.1.20", "10.0.0.5", "172.16.3.4", "172.31.255.255", "127.0.0.1", "169.254.7.7", "::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.0.9"] {
        assert!(server::is_local(ok.parse().unwrap()), "{ok}");
    }
    for no in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8", "0.0.0.0"] {
        assert!(!server::is_local(no.parse().unwrap()), "{no}");
    }
}

#[test]
fn the_idle_limit_is_well_above_what_a_sleeping_phone_needs_but_bounded() {
    assert!(server::IDLE_TIMEOUT >= std::time::Duration::from_secs(16 * 60));
    assert!(server::IDLE_TIMEOUT <= std::time::Duration::from_secs(30 * 60));
}

#[test]
fn the_phone_link_keys_are_internal_only_never_reachable_from_the_page() {
    for k in [pairing::CERT_KEY, pairing::PRIVATE_KEY, pairing::TOKEN_KEY] {
        assert!(!crate::secrets::KNOWN_KEYS.contains(&k), "{k}");
        assert!(crate::secrets::INTERNAL_KEYS.contains(&k), "{k}");
        assert!(crate::secrets::parse_command(&json!({"action":"present","key":k})).is_none());
        assert!(crate::secrets::parse_command(&json!({"action":"set","key":k,"value":"v"})).is_none());
    }
}
