#![cfg(target_os = "linux")]
use abito_island::daemonhost::{discover, Host};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

struct TestDir(std::path::PathBuf);
impl TestDir {
    fn new() -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("abito-host-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&dir)?;
        Ok(Self(dir))
    }
    fn path(&self) -> &Path { &self.0 }
}
impl Drop for TestDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn executable(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn discovery_orders_session_path_before_canonical_fallbacks() {
    let root = TestDir::new().unwrap();
    let home = root.path().join("home");
    let bin = root.path().join("bin");
    executable(&home.join(".local/bin/pi"), "#!/bin/sh\nexit 0\n");
    executable(&bin.join("pi"), "#!/bin/sh\nexit 0\n");
    assert_eq!(discover("pi", Some(bin.as_os_str()), Some(home.as_os_str())).unwrap(), bin.join("pi"));
    assert_eq!(discover("pi", Some(std::ffi::OsStr::new("/usr/local/bin:/usr/bin:/bin")), Some(home.as_os_str())).unwrap(), home.join(".local/bin/pi"));
    assert_eq!(discover("node", Some(std::ffi::OsStr::new("/not-present")), None).unwrap(), Path::new("/usr/bin/node"));
    assert!(discover("missing-runtime", Some(bin.as_os_str()), Some(home.as_os_str())).unwrap_err().contains("missing-runtime missing"));
    let child_path = abito_island::daemonhost::runtime_path(
        Some(std::ffi::OsStr::new(".:relative::/usr/bin")), Path::new("/usr/bin/node"), Path::new("/canonical/pi"),
    ).unwrap();
    assert_eq!(child_path, std::ffi::OsString::from("/usr/bin:/canonical"));
    // Exercise HostSlot::start itself: a helper which stands in for Node
    // records the actual environment passed across the app -> host boundary.
    executable(&bin.join("node"), &format!("#!/bin/sh\nprintf '%s\\n' \"$PATH\" > '{}'\nexec /bin/sleep 120\n", root.path().join("derived-path").display()));
    let mut app = Command::new(std::env::current_exe().unwrap()).args(["--exact", "crash_helper", "--nocapture"])
        .env("ISLAND_HOST_TEST_HELPER", root.path()).env("ISLAND_HOST_TEST_PATH", "1")
        .env("PATH", format!(".:relative::{}:/usr/bin", bin.display())).env("HOME", &home)
        .stdout(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !root.path().join("derived-path").exists() {
        if std::time::Instant::now() >= deadline { app.kill().unwrap(); app.wait().unwrap(); panic!("host did not record derived PATH") }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let actual = fs::read_to_string(root.path().join("derived-path")).unwrap();
    fs::write(root.path().join("path-stop"), "stop").unwrap();
    while app.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline { app.kill().unwrap(); app.wait().unwrap(); panic!("PATH helper did not exit") }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(actual.trim_end(), format!("{}:/usr/bin", bin.display()));
    assert!(actual.trim_end().split(':').all(|part| !part.is_empty() && Path::new(part).is_absolute()));
}

#[test]
fn named_runtime_failure_is_in_existing_no_daemon_state_channel() {
    use abito_island::{agentclient::{ClientState, Reason}, daemonhost::StartupFailure};
    for (failure, code) in [(StartupFailure::NodeMissing, "node_missing"), (StartupFailure::PiMissing, "pi_missing")] {
        let mut state = ClientState::disconnected(Reason::NoDaemon);
        state.note_startup_failure(failure);
        let view = serde_json::to_value(state).unwrap();
        assert_eq!(view["connection"], "no_daemon");
        assert_eq!(view["last_error"]["code"], code);
        assert_eq!(view["last_error"]["n"], 1);
        assert_eq!(view["providers"], serde_json::json!([]));
        assert_eq!(view["accounts"], serde_json::json!([]));
        assert!(!view.to_string().contains("/home/"));
    }
}

#[test]
fn normal_drop_terminates_and_reaps_owned_host() {
    let root = TestDir::new().unwrap();
    let script = root.path().join("host.sh");
    executable(&script, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n");
    let host = Host::spawn_command(Command::new(script)).unwrap();
    let pid = host.pid();
    drop(host);
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
}

// A separate process is essential: SIGKILL must bypass destructors exactly as an app crash does.
#[test]
fn crash_helper() {
    let Some(dir) = std::env::var_os("ISLAND_HOST_TEST_HELPER") else { return };
    let dir = std::path::PathBuf::from(dir);
    if std::env::var_os("ISLAND_HOST_TEST_PATH").is_some() {
        let slot = abito_island::daemonhost::HostSlot::default();
        slot.start(); assert_eq!(slot.failure(), None);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !dir.join("path-stop").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        slot.stop();
        return;
    }
    if std::env::var_os("ISLAND_HOST_TEST_ESCAPE").is_some() {
        unsafe {
            assert_eq!(libc::setpgid(0, libc::getpgid(libc::getppid())), 0);
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
        fs::write(dir.join("escaped"), "ready").unwrap();
        loop { std::thread::sleep(std::time::Duration::from_secs(1)); }
    }
    if std::env::var_os("ISLAND_HOST_TEST_DROP").is_some() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "crash_helper", "--nocapture"])
            .env("ISLAND_HOST_TEST_ESCAPE", "1").env_remove("ISLAND_HOST_TEST_DROP");
        let host = Host::spawn_command(command).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !dir.join("escaped").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(host);
        fs::write(dir.join("drop.finished"), "ready").unwrap();
        return;
    }
    let host = Host::spawn_command(Command::new(dir.join("host.sh"))).unwrap();
    fs::write(dir.join("host.pid"), host.pid().to_string()).unwrap();
    loop { std::thread::sleep(std::time::Duration::from_secs(1)); }
}

#[test]
fn killed_app_cannot_leave_a_live_host() {
    let root = TestDir::new().unwrap();
    executable(&root.path().join("host.sh"), "#!/bin/sh\nexec sleep 120\n");
    let mut app = Command::new(std::env::current_exe().unwrap()).args(["--exact", "crash_helper", "--nocapture"])
        .env("ISLAND_HOST_TEST_HELPER", root.path()).stdout(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !root.path().join("host.pid").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let pid = fs::read_to_string(root.path().join("host.pid")).unwrap();
    app.kill().unwrap(); assert!(!app.wait().unwrap().success());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let dead = fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| s[s.rfind(')').unwrap()+2..].starts_with('Z')).unwrap_or(true);
        if dead { break }
        assert!(std::time::Instant::now() < deadline, "host survived app SIGKILL");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn missing_process_group_cannot_hang_app_exit() {
    let root = TestDir::new().unwrap();
    let mut app = Command::new(std::env::current_exe().unwrap()).args(["--exact", "crash_helper", "--nocapture"])
        .env("ISLAND_HOST_TEST_HELPER", root.path()).env("ISLAND_HOST_TEST_DROP", "1")
        // Do not blend a nested harness's result into Cargo's per-target count.
        .stdout(std::process::Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(9);
    loop {
        if let Some(status) = app.try_wait().unwrap() { assert!(status.success()); break }
        if std::time::Instant::now() >= deadline {
            app.kill().unwrap(); app.wait().unwrap();
            panic!("Drop hung after both group signals missed");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(root.path().join("drop.finished").exists());
}

#[test]
fn host_failure_does_not_exit_its_app_or_restart_host() {
    let mut cmd = Command::new("/bin/sh"); cmd.args(["-c", "exit 17"]);
    let mut host = Host::spawn_command(cmd).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(host.try_wait().unwrap().unwrap().code(), Some(17));
    assert!(host.try_wait().unwrap().is_some());
    drop(host); // the test/app remains alive
}
