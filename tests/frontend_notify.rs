//! UI.1: N6: run the notification view-model checks
//! (`test-node/notify-view-check.cjs`) under plain `node` (no npm, no
//! network). Fails when node is absent: a missing runner must never read as green.

use std::path::Path;
use std::process::Command;

#[test]
fn notify_view_pure_checks_pass() {
    let node = Command::new("node").arg("--version").output();
    assert!(
        node.as_ref().is_ok_and(|out| out.status.success()),
        "node is required to run test-node/notify-view-check.cjs and was not found on PATH: {node:?}"
    );
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/notify-view-check.cjs");
    let out = Command::new("node").arg(&harness).output().expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "notify-view-check failed:\n{stdout}\n{stderr}");
    assert!(stdout.contains("passed"), "{stdout}");
}
