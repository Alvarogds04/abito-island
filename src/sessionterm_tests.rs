//! The terminal that RUNS a session, found from /proc (never from the page) and, inside herdr, its pane.
use super::*;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

fn root(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("abito-sessterm-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}
fn stat_line(pid: u32, comm: &str, ppid: u32, start: u64) -> String {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal starttime ...
    format!("{pid} ({comm}) S {ppid} {pid} {pid} 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 {start} 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0")
}
fn proc_entry(root: &Path, pid: u32, comm: &str, ppid: u32, start: u64, cmdline: &str, cwd: Option<&Path>) {
    let d = root.join(pid.to_string());
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("stat"), stat_line(pid, comm, ppid, start)).unwrap();
    fs::write(d.join("cmdline"), cmdline).unwrap();
    if let Some(c) = cwd { std::os::unix::fs::symlink(c, d.join("cwd")).unwrap(); }
}
const PI: &str = "/home/u/.local/bin/pi\0";

#[test]
fn the_session_key_is_the_daemons_derivation_pid_space_starttime_sha256_first_8_hex() {
    // sha256("100 300") by the daemon's `s-${sha256(`${pid} ${starttime}`).slice(0,8)}`
    use sha2::{Digest, Sha256};
    let expect: String = Sha256::digest(b"100 300").iter().take(4).map(|b| format!("{b:02x}")).collect();
    assert_eq!(session_key(100, 300), format!("s-{expect}"));
    assert!(valid_session_key(&session_key(1, 1)));
    for bad in ["", "s-", "s-1234567", "s-123456789", "S-12345678", "s-1234567g", "s-ABCDEF12", "x-12345678", "s-1234567\n"] {
        assert!(!valid_session_key(bad), "{bad:?}");
    }
}

#[test]
fn find_session_matches_only_agent_processes_by_their_derived_key() {
    let r = root("find");
    let cwd = root("find-cwd");
    proc_entry(&r, 100, "pi", 50, 300, PI, Some(&cwd));
    proc_entry(&r, 101, "vim", 50, 301, "vim\0notes\0", None);
    let found = find_session(&r, &session_key(100, 300)).expect("agent found");
    assert_eq!(found.pid, 100);
    assert_eq!(found.cwd.as_deref(), Some(cwd.as_path()));
    assert!(find_session(&r, &session_key(101, 301)).is_none(), "an unrelated process is never a session, even with a matching key");
    assert!(find_session(&r, &session_key(100, 999)).is_none(), "a recycled pid (another starttime) does not match");
    assert!(find_session(&r, "s-00000000").is_none());
    assert!(find_session(&r, "../etc").is_none(), "a malformed key is refused before touching /proc");
    // each known agent binary, by basename of an early argv entry only
    for (i, cmd) in ["claude\0", "codex\0", "/x/opencode\0--a\0", "node\0/usr/bin/gemini\0"].iter().enumerate() {
        let pid = 200 + i as u32; proc_entry(&r, pid, "x", 50, 400 + i as u64, cmd, None);
        assert!(find_session(&r, &session_key(pid, 400 + i as u64)).is_some(), "{cmd:?}");
    }
    proc_entry(&r, 300, "x", 50, 500, "a\0b\0c\0pi\0", None); // 4th argv entry: not an agent
    assert!(find_session(&r, &session_key(300, 500)).is_none());
}

#[test]
fn the_cwd_is_what_the_process_has_if_it_is_a_real_absolute_directory_else_none() {
    let r = root("cwd");
    let dir = root("cwd-dir"); let file = dir.join("f"); fs::write(&file, b"x").unwrap();
    proc_entry(&r, 100, "pi", 1, 1, PI, Some(&dir));
    proc_entry(&r, 101, "pi", 1, 2, PI, Some(&file));
    proc_entry(&r, 102, "pi", 1, 3, PI, Some(&dir.join("gone")));
    proc_entry(&r, 103, "pi", 1, 4, PI, None);
    assert_eq!(find_session(&r, &session_key(100, 1)).unwrap().cwd, Some(dir));
    for (pid, start) in [(101, 2), (102, 3), (103, 4)] { assert_eq!(find_session(&r, &session_key(pid, start)).unwrap().cwd, None); }
}

#[test]
fn ancestors_walk_up_and_stop_at_init_a_cycle_or_a_vanished_parent() {
    let r = root("anc");
    proc_entry(&r, 1, "systemd", 0, 1, "init\0", None);
    proc_entry(&r, 10, "ghostty", 1, 2, "ghostty\0", None);
    proc_entry(&r, 20, "zsh", 10, 3, "zsh\0", None);
    proc_entry(&r, 30, "pi", 20, 4, PI, None);
    let chain: Vec<u32> = ancestors(&r, 30).iter().map(|p| p.pid).collect();
    assert_eq!(chain, vec![30, 20, 10]);
    proc_entry(&r, 40, "a", 41, 5, "a\0", None); proc_entry(&r, 41, "b", 40, 6, "b\0", None);
    assert_eq!(ancestors(&r, 40).len(), 2, "a cycle terminates");
    proc_entry(&r, 50, "orphan", 777, 7, "o\0", None);
    assert_eq!(ancestors(&r, 50).iter().map(|p| p.pid).collect::<Vec<_>>(), vec![50]);
    assert!(ancestors(&r, 9999).is_empty());
}

#[test]
fn terminal_of_knows_the_modern_terminals_and_never_a_lookalike() {
    let mk = |comm: &str| ProcInfo { pid: 7, ppid: 1, comm: comm.into(), starttime: 1 };
    for ok in ["ghostty", "ptyxis", "gnome-terminal-", "kgx", "konsole", "alacritty", "kitty", "foot", "wezterm-gui", "tilix", "terminator", "xterm", "blackbox", "warp-terminal", "xfce4-terminal"] {
        assert!(terminal_of(&[mk("zsh"), mk(ok)]).is_some(), "{ok}");
    }
    for no in ["zsh", "herdr", "tmux", "ghostty2", "xtermination", "codesign", "sshd", ""] {
        assert!(terminal_of(&[mk(no)]).is_none(), "{no}");
    }
    let chain = [ProcInfo { pid: 1, ppid: 2, comm: "zsh".into(), starttime: 1 }, ProcInfo { pid: 2, ppid: 3, comm: "ghostty".into(), starttime: 1 }, ProcInfo { pid: 3, ppid: 4, comm: "kitty".into(), starttime: 1 }];
    assert_eq!(terminal_of(&chain).unwrap().pid, 2, "the nearest terminal ancestor wins");
}

#[test]
fn a_plain_session_resolves_to_its_terminal_without_herdr() {
    let r = root("plain"); let cwd = root("plain-cwd");
    proc_entry(&r, 1, "systemd", 0, 1, "init\0", None);
    proc_entry(&r, 10, "ghostty", 1, 2, "ghostty\0", None);
    proc_entry(&r, 20, "zsh", 10, 3, "zsh\0", None);
    proc_entry(&r, 30, "pi", 20, 4, PI, Some(&cwd));
    let plan = resolve(&r, &session_key(30, 4), &mut |_| panic!("herdr is never asked for a session outside herdr")).unwrap();
    assert_eq!(plan.terminal_pid, Some(10)); assert_eq!(plan.cwd, Some(cwd)); assert!(plan.herdr.is_none());
}

fn pane_list() -> String {
    json!({"id":"x","result":{"type":"pane_list","panes":[
        {"pane_id":"wC:p4","tab_id":"wC:t4","workspace_id":"wC"},
        {"pane_id":"w6T:p1","tab_id":"w6T:t1","workspace_id":"w6T"}]}}).to_string()
}
fn info(shell: u32, fg: &[u32]) -> String {
    json!({"id":"x","result":{"type":"pane_process_info","process_info":{"shell_pid":shell,"foreground_processes":fg.iter().map(|p| json!({"pid":p,"name":"pi"})).collect::<Vec<_>>()}}}).to_string()
}

#[test]
fn a_session_inside_herdr_resolves_its_pane_and_the_terminal_of_the_herdr_client() {
    let r = root("herdr"); let cwd = root("herdr-cwd");
    proc_entry(&r, 1, "systemd", 0, 1, "init\0", None);
    proc_entry(&r, 4249, "herdr", 1, 2, "herdr\0server\0", None);            // the server owns the ptys
    proc_entry(&r, 299702, "zsh", 4249, 3, "zsh\0", None);                    // the pane's shell
    proc_entry(&r, 299731, "pi", 299702, 4, PI, Some(&cwd));                   // the session
    proc_entry(&r, 10, "ghostty", 1, 5, "ghostty\0", None);                    // the human's window
    proc_entry(&r, 11, "zsh", 10, 6, "zsh\0", None);
    proc_entry(&r, 209195, "herdr", 11, 7, "herdr\0", None);                   // a herdr CLIENT inside ghostty
    proc_entry(&r, 31045, "mosh-server", 1, 8, "mosh-server\0", None);
    proc_entry(&r, 31046, "herdr", 31045, 9, "herdr\0--session\0default\0", None); // a remote client: no local terminal
    let mut calls: Vec<Vec<String>> = vec![];
    let plan = resolve(&r, &session_key(299731, 4), &mut |args: &[&str]| {
        calls.push(args.iter().map(|s| s.to_string()).collect());
        match args {
            ["pane", "list"] => Some(pane_list()),
            ["pane", "process-info", "--pane", "wC:p4"] => Some(info(111, &[112])),
            ["pane", "process-info", "--pane", "w6T:p1"] => Some(info(299702, &[299731])),
            _ => None,
        }
    }).unwrap();
    let pane = plan.herdr.expect("pane found");
    assert_eq!((pane.pane_id.as_str(), pane.tab_id.as_str(), pane.workspace_id.as_str()), ("w6T:p1", "w6T:t1", "w6T"));
    assert_eq!(plan.terminal_pid, Some(10), "the window that shows herdr, not the server's parent");
    assert_eq!(plan.cwd, Some(cwd));
    assert!(calls.iter().all(|c| c[0] == "pane"), "only read-only pane queries at resolve time: {calls:?}");
}

#[test]
fn herdr_trouble_never_breaks_the_plan_and_foreign_ids_are_never_passed_to_the_cli() {
    let r = root("herdr-bad");
    proc_entry(&r, 1, "systemd", 0, 1, "init\0", None);
    proc_entry(&r, 4249, "herdr", 1, 2, "herdr\0server\0", None);
    proc_entry(&r, 299702, "zsh", 4249, 3, "zsh\0", None);
    proc_entry(&r, 299731, "pi", 299702, 4, PI, None);
    // the CLI is missing / answers garbage: still a plan (no pane, no terminal), never a panic
    for answer in [None, Some("not json".to_string()), Some("{}".to_string())] {
        let plan = resolve(&r, &session_key(299731, 4), &mut |_| answer.clone()).unwrap();
        assert!(plan.herdr.is_none());
    }
    // hostile ids from the CLI output are skipped, never forwarded as argv
    let hostile = json!({"result":{"panes":[{"pane_id":"--help","tab_id":"t","workspace_id":"w"},{"pane_id":"a b","tab_id":"t","workspace_id":"w"},{"pane_id":"w6T:p1","tab_id":"-x","workspace_id":"w"}]}}).to_string();
    let mut seen = vec![];
    let plan = resolve(&r, &session_key(299731, 4), &mut |args: &[&str]| {
        seen.push(args.join(" "));
        if args == ["pane", "list"] { Some(hostile.clone()) } else { Some(info(299702, &[])) }
    }).unwrap();
    assert!(plan.herdr.is_none());
    assert_eq!(seen, vec!["pane list".to_string()], "no process-info for any malformed id");
    assert!(valid_herdr_id("w6T:p1") && valid_herdr_id("wC") && !valid_herdr_id("") && !valid_herdr_id("-x") && !valid_herdr_id("a b") && !valid_herdr_id(&"a".repeat(33)));
}

#[test]
fn herdr_panes_scanned_are_bounded() {
    let r = root("herdr-cap");
    proc_entry(&r, 1, "systemd", 0, 1, "init\0", None);
    proc_entry(&r, 4249, "herdr", 1, 2, "herdr\0server\0", None);
    proc_entry(&r, 299702, "zsh", 4249, 3, "zsh\0", None);
    proc_entry(&r, 299731, "pi", 299702, 4, PI, None);
    let many = json!({"result":{"panes":(0..500).map(|i| json!({"pane_id":format!("w{i}:p1"),"tab_id":format!("w{i}:t1"),"workspace_id":format!("w{i}")})).collect::<Vec<_>>()}}).to_string();
    let mut n = 0;
    resolve(&r, &session_key(299731, 4), &mut |args: &[&str]| { if args[1] == "process-info" { n += 1; Some(info(1, &[])) } else { Some(many.clone()) } }).unwrap();
    assert_eq!(n, MAX_PANES);
}

// ---- the effect order: herdr pane, then the window, and a launch ONLY when there is no terminal ----------

fn plan(terminal: Option<u32>, herdr: bool) -> Plan {
    Plan { cwd: Some(PathBuf::from("/work")), terminal_pid: terminal,
        herdr: herdr.then(|| HerdrPane { pane_id: "w1:p1".into(), tab_id: "w1:t1".into(), workspace_id: "w1".into() }) }
}

#[test]
fn herdr_workspace_then_tab_are_focused_before_the_window_and_the_window_is_raised() {
    let mut log: Vec<String> = vec![];
    let r = {
        let log = std::cell::RefCell::new(&mut log);
        apply(&plan(Some(10), true),
            &mut |args: &[&str]| { log.borrow_mut().push(format!("herdr {}", args.join(" "))); true },
            &mut |pid| { log.borrow_mut().push(format!("raise {pid}")); Raise::Raised },
            &mut |_| { log.borrow_mut().push("launch".into()); Ok(()) })
    };
    assert_eq!(r, Ok(()));
    assert_eq!(log, vec!["herdr workspace focus w1", "herdr tab focus w1:t1", "raise 10"]);
}

#[test]
fn a_known_terminal_that_cannot_be_raised_never_launches_another_one() {
    for raise in [Raise::Unreachable, Raise::Raised] {
        let mut launched = 0;
        let r = apply(&plan(Some(10), false), &mut |_| true, &mut |_| raise, &mut |_| { launched += 1; Ok(()) });
        assert_eq!(launched, 0);
        match raise { Raise::Raised => assert_eq!(r, Ok(())), _ => assert_eq!(r, Err(CANNOT_RAISE_REASON.to_string())) }
    }
    assert!(!CANNOT_RAISE_REASON.contains("clase"));
}

#[test]
fn a_terminal_process_without_any_window_falls_back_to_launching_in_the_session_cwd() {
    let mut got: Vec<Option<PathBuf>> = vec![];
    let r = apply(&plan(Some(10), false), &mut |_| true, &mut |_| Raise::NoWindow, &mut |cwd| { got.push(cwd.map(Path::to_path_buf)); Ok(()) });
    assert_eq!(r, Ok(())); assert_eq!(got, vec![Some(PathBuf::from("/work"))]);
}

#[test]
fn no_terminal_ancestor_launches_the_default_terminal_in_the_session_cwd_and_a_failed_launch_is_the_short_reason() {
    let mut got = vec![];
    assert_eq!(apply(&plan(None, false), &mut |_| true, &mut |_| panic!("no window to raise"), &mut |c| { got.push(c.map(Path::to_path_buf)); Ok(()) }), Ok(()));
    assert_eq!(got, vec![Some(PathBuf::from("/work"))]);
    assert_eq!(apply(&plan(None, false), &mut |_| true, &mut |_| panic!(), &mut |_| Err("No se pudo abrir una terminal.".to_string())), Err("No se pudo abrir una terminal.".to_string()));
}

#[test]
fn herdr_focus_failing_does_not_stop_the_window_from_being_raised() {
    let mut raised = 0;
    let r = apply(&plan(Some(10), true), &mut |_| false, &mut |_| { raised += 1; Raise::Raised }, &mut |_| panic!());
    assert_eq!(r, Ok(())); assert_eq!(raised, 1);
}

// ---- the effect layer's pure parts -----------------------------------------------------------------------

#[test]
fn a_terminal_process_maps_to_its_closed_d_bus_application_name_or_none() {
    for (comm, name) in [("ghostty", "com.mitchellh.ghostty"), ("ptyxis", "org.gnome.Ptyxis"), ("kgx", "org.gnome.Console"),
                         ("gnome-terminal-", "org.gnome.Terminal"), ("blackbox", "com.raggesilver.BlackBox"), ("foot", "org.codeberg.dnkl.foot"),
                         ("konsole", "org.kde.konsole"), ("wezterm-gui", "org.wezfurlong.wezterm")] {
        assert_eq!(dbus_app_name(comm), Some(name), "{comm}");
    }
    for none in ["zsh", "xterm", "kitty", "alacritty", "ghostty2", "", "../x"] { assert_eq!(dbus_app_name(none), None, "{none}"); }
}

#[test]
fn the_herdr_cli_runner_has_a_deadline_and_a_closed_argv() {
    // a command that outlives the deadline is killed and answers nothing (the plan still works without herdr)
    let began = std::time::Instant::now();
    assert_eq!(run_with_deadline("sleep", &["5"], std::time::Duration::from_millis(200)), None);
    assert!(began.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(run_with_deadline("echo", &["hola"], std::time::Duration::from_secs(2)).as_deref(), Some("hola\n"));
    assert_eq!(run_with_deadline("definitely-not-a-binary-xyz", &[], std::time::Duration::from_secs(1)), None);
    assert_eq!(run_with_deadline("false", &[], std::time::Duration::from_secs(1)), None, "a failing command is no answer");
}

#[test]
fn only_read_and_focus_herdr_verbs_are_ever_run() {
    for ok in [vec!["pane", "list"], vec!["pane", "process-info", "--pane", "w6T:p1"], vec!["workspace", "focus", "w6T"], vec!["tab", "focus", "w6T:t1"]] {
        assert!(herdr_argv_allowed(&ok), "{ok:?}");
    }
    for bad in [vec!["pane", "close", "w6T:p1"], vec!["pane", "send-text", "x"], vec!["pane", "run", "rm"], vec!["workspace", "close", "w"],
                vec!["tab", "focus", "-x"], vec!["tab", "focus", "a b"], vec!["server", "stop"], vec!["pane", "process-info", "--pane"], vec![]] {
        assert!(!herdr_argv_allowed(&bad), "{bad:?}");
    }
}

#[test]
fn the_gnome_extension_can_raise_a_window_by_pid_and_documents_what_it_now_does() {
    let ext = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/gnome-extension/abito-context@abito/extension.js")).unwrap();
    assert!(ext.contains("ActivateByPid"), "the D-Bus method exists");
    // bounded and exact: only a window whose own pid matches, never an arbitrary id, title or command
    assert!(ext.contains("win.get_pid() === pid") && ext.contains("Main.activateWindow") || ext.contains("win.activate("));
    assert!(ext.contains("type=\"u\" direction=\"in\" name=\"pid\"") && ext.contains("type=\"b\" direction=\"out\""));
    assert!(!ext.contains("eval(") && !ext.contains("spawn"), "no code or process execution in the extension");
    let doc = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/desktop/context-extension.md")).unwrap();
    assert!(doc.contains("ActivateByPid"), "the privacy contract in the docs states the new focus method");
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/gnome-extension/abito-context@abito/metadata.json")).unwrap()).unwrap();
    assert_eq!(meta["version"], 2, "a changed contract is a new extension version");
}
