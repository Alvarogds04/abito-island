#!/bin/sh
# Windows cross-build driver for the Abito island (everything happens inside a
# container; nothing is installed on the host).
#
#   sh packaging/windows/xbuild.sh image   # build the cross toolchain image
#   sh packaging/windows/xbuild.sh check   # cargo check --target x86_64-pc-windows-msvc
#   sh packaging/windows/xbuild.sh build   # cargo build --release (bare .exe)
#   sh packaging/windows/xbuild.sh shell   # interactive shell in the image
#
# Container runtime: $ABITO_XBUILD_RUNTIME (docker|podman) wins; otherwise
# `docker` if present, else `podman`. Only flags both accept are used.
#
# Caches live in named volumes (cargo registry, target dir, Windows SDK), so
# re-runs are cheap and no root-owned files land in the worktree.
set -eu

crate=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
IMAGE=${ABITO_XBUILD_IMAGE:-abito-xwin-build:latest}
VOL_CARGO=${ABITO_XBUILD_VOL_CARGO:-abito-xbuild-cargo}
VOL_TARGET=${ABITO_XBUILD_VOL_TARGET:-abito-xbuild-target}
VOL_XWIN=${ABITO_XBUILD_VOL_XWIN:-abito-xbuild-xwin}

if [ -n "${ABITO_XBUILD_RUNTIME:-}" ]; then
  rt=$ABITO_XBUILD_RUNTIME
elif command -v docker >/dev/null 2>&1; then
  rt=docker
else
  rt=podman
fi

# run <cmd...> — execute one command against the crate mounted at /abito/src.
#
# The container runs as root (NOT --userns=keep-id): the toolchain lives in
# root-owned volumes (/usr/local/cargo) and xwin must write its SDK cache, so a
# mapped-down uid only breaks those volumes. `:U` hands each volume to the
# container user. Nothing is written back into the worktree because every cargo
# call here uses --locked: if the Windows graph needed a lock change, the run
# fails loudly instead of rewriting Cargo.lock as root.
run() {
  "$rt" run --rm \
    -v "$crate":/abito/src \
    -v "$VOL_CARGO":/usr/local/cargo/registry:U \
    -v "$VOL_TARGET":/abito/target:U \
    -v "$VOL_XWIN":/xwin-cache:U \
    -e CARGO_TARGET_DIR=/abito/target \
    -w /abito/src \
    "$IMAGE" "$@"
}

cmd=${1:-check}
if [ "$#" -gt 0 ]; then shift; fi

case "$cmd" in
  image)
    echo "# building $IMAGE with $rt"
    "$rt" build -t "$IMAGE" -f "$crate/packaging/windows/Dockerfile" "$crate/packaging/windows"
    ;;
  check)
    # Type-check the Windows tree (including tests): this is what proves the
    # platform seams are complete, since none of it can run here.
    run cargo xwin check --locked --target x86_64-pc-windows-msvc --all-targets "$@"
    ;;
  build)
    run cargo xwin build --release --locked --target x86_64-pc-windows-msvc \
      --features tauri/custom-protocol "$@"
    echo "artifact: /abito/target/x86_64-pc-windows-msvc/release/abito-island.exe (volume $VOL_TARGET)"
    ;;
  shell)
    run sh "$@"
    ;;
  *)
    echo "usage: xbuild.sh {image|check|build|shell}" >&2
    exit 2
    ;;
esac
