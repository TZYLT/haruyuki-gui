#!/usr/bin/env bash
# verify-linux-package.sh - one command that answers whether this machine can
# produce the Linux download, and whether the produced download is alive and
# actually painted.
#
# Four things happen in order, each of which can fail on its own:
#
#   1. toolchain   install and *verify one package at a time*. A single
#                  `apt-get install` exit code hides a package that was never
#                  installed (a missing python3 once looked like success), so the
#                  line that matters is the per-package check, not apt's exit.
#   2. package     `release.mjs --linux-only`, which is the whole pipeline:
#                  install, fetch engine, dereference, stage, lock, build, and
#                  one `electron-builder` run. It has to happen on Linux; the
#                  development host is Windows and produces a zip, not this.
#   3. artifact    exists, has bytes, `--appimage-extract` exits 0, and the
#                  extracted launcher resolves every shared library. A package
#                  nobody can unpack is not a download.
#   4. start       run `AppRun` as a *non-root* user under Xvfb and require
#                  (a) it is still alive after 150 s with no FATAL in its log,
#                  (b) a Chrome DevTools target exists, has a non-empty title,
#                  and reports a non-empty `#root` - which is what "the window
#                  was painted" means when there is no screenshot tool.
#
# Why non-root plus Xvfb instead of `--no-sandbox`: the shipped shell keeps the
# Chromium sandbox on, and passing that flag would trade the property being
# verified for a green line. A container's default user (root, no display) hits
# Chromium's root check and aborts, so the launcher runs as an unprivileged user
# with a virtual display - the same shape a build machine has.
#
# Two modes, because the pipeline needs Linux but the checkout usually is not:
#
#   - on a host: check Docker, then run this same file inside the image with a
#     read-only mount, so nothing in the working tree is touched. No Docker is a
#     readable refusal with exit 3, never a crash and never a silent pass.
#   - in a container: do the work.
#
# Exit codes, chosen so the caller can tell the three situations apart without
# reading the log:
#   0  an AppImage was produced, unpacks, stays up, and painted its root
#   1  the artifact was produced but does not start (or packaging was attempted
#      and failed - the machine can do this, the build is broken)
#   3  this machine cannot do it: no Docker, no usable toolchain in the image,
#      or a prerequisite step that never got as far as an artifact
#
# 1 and 3 both fail; they differ in what the reader should do next.
#
# Usage:
#   bash apps/desktop/scripts/verify-linux-package.sh            # host or container
#   bash apps/desktop/scripts/verify-linux-package.sh --in-container
#   bash apps/desktop/scripts/verify-linux-package.sh --keep --port=9333
#
# Options:
#   --in-container   run the pipeline here (implied when /.dockerenv exists)
#   --keep           keep the scratch directory and the container after the run
#   --port=<n>       DevTools port used for the paint probe (default 9222)
#   --image=<ref>    image used by host mode (a mirror: the registry host is not
#                    reachable from the development host)
#   -h, --help       this text

set -uo pipefail

# Derived from this file, never from the caller's cwd, so the command works from
# any directory and no machine-specific path is baked in.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../../.." && pwd)"

IMAGE="${IMAGE:-docker.m.daocloud.io/library/node:24-bookworm-slim}"

# One line per phase, so a pasted log reads without the surrounding text.
say() { printf '\n===== %s =====\n' "$*"; }
mark() { printf '>> %s\n' "$*"; }
fail() { printf '!! %s\n' "$*"; }

# Survives the phases below; the verdict prints them together.
APPIMAGE=""
APPIMAGE_NAME=""
APPIMAGE_BYTES=""
EXTRACT_FILES=""
EXTRACT_MISSING=""
SURVIVED=""
CDP_LINE=""
V06=0
V07A=0
V07B=0

XVFB_PID=""
APP_PID=""
SCRATCH=""

cleanup() {
  local code=$?
  if [ -n "$APP_PID" ]; then kill -TERM -- "-$APP_PID" 2>/dev/null || kill -TERM "$APP_PID" 2>/dev/null || true; fi
  if [ -n "$XVFB_PID" ]; then kill -TERM "$XVFB_PID" 2>/dev/null || true; fi
  if [ -n "$SCRATCH" ] && [ "${KEEP:-0}" != "1" ]; then rm -rf "$SCRATCH"; fi
  exit "$code"
}

IN_CONTAINER=0
KEEP=0
PORT=9222

usage() { sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --in-container) IN_CONTAINER=1 ;;
    --keep) KEEP=1 ;;
    --port=*) PORT="${1#--port=}" ;;
    --image=*) IMAGE="${1#--image=}" ;;
    -h | --help) usage; exit 0 ;;
    *) fail "unknown argument: $1"; usage; exit 2 ;;
  esac
  shift
done

# Detected by marker file rather than by "am I on Linux": a Linux workstation
# without Docker can build nothing here, and this flag chooses a working
# directory policy, not an OS.
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then IN_CONTAINER=1; fi

# ---------------------------------------------------------------------------
# Host mode: hand the work to the container, then relay its verdict.
# ---------------------------------------------------------------------------

# Docker on Windows only accepts a drive-letter path; a POSIX shell prints
# /j/..., which Docker reads as container-relative and silently finds nothing
# there. `cygpath` is the one thing that knows the mapping, so it is preferred;
# outside Windows the path is already what Docker wants.
to_host_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

run_on_host() {
  say "host: docker"

  if ! command -v docker >/dev/null 2>&1; then
    fail "docker is not on PATH, so the Linux package cannot be built or judged here."
    say "refusal: environment lacks Docker (exit 3, not a build failure)"
    printf '  what this needs: docker, plus an image such as %s\n' "$IMAGE"
    printf '  the pipeline runs on Linux only; this host is %s\n' "$(uname -s)"
    exit 3
  fi
  mark "docker: $(docker --version 2>&1 | head -1)"

  if ! docker info >/dev/null 2>&1; then
    fail "the docker command exists but no daemon answers it."
    exit 3
  fi

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    mark "image not present locally; pulling"
    if ! docker pull "$IMAGE" >/dev/null 2>&1; then
      fail "cannot pull $IMAGE; the registry mirror is unreachable from here"
      exit 3
    fi
  fi
  mark "image: $IMAGE"

  # A POSIX shell prints /j/... for the mount, which Docker on Windows reads as a
  # container path and silently finds nothing there. The drive-letter form is
  # what it accepts, and `cygpath` is the one thing that knows the mapping;
  # `pwd -W` is the fallback for a Bash that has it.
  local mount
  mount="$(to_host_path "$REPO_ROOT")"
  mark "mount: $mount -> /src (read-only)"

  # Without this Git Bash rewrites `/src` and `:ro` into Windows paths.
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'

  # The packaging command refuses to build a tree that cannot read its tag list,
  # and a copy of the working files is exactly that tree. Rather than loosen the
  # guard, the history goes in read-only: a linked worktree's `.git` file holds
  # an absolute path from the machine that made it, so the object database and
  # this worktree's ref state are mounted separately.
  local -a git_mounts=()
  local common_dir worktree_git
  common_dir="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir 2>/dev/null)" || common_dir=""
  worktree_git="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir 2>/dev/null)" || worktree_git=""
  if [ -n "$common_dir" ] && [ -d "$common_dir" ]; then
    case "$common_dir" in
      /*) : ;;
      *) common_dir="$(cd "$REPO_ROOT" && cd "$common_dir" && pwd)" ;;
    esac
    git_mounts+=(-v "$(to_host_path "$common_dir"):/git:ro")
    if [ -n "$worktree_git" ] && [ -d "$worktree_git" ]; then
      git_mounts+=(-v "$(to_host_path "$worktree_git"):/git-worktree:ro")
    fi
    mark "git: history mounted at /git (+ $(basename "${worktree_git:-none}") at /git-worktree)"
  else
    mark "git: no reachable history; the packaging command will refuse and say so"
  fi

  local -a args=(run --rm --init)
  [ "$KEEP" = "1" ] && args=(run --init)
  args+=(-v "$mount:/src:ro" -w /root)
  [ "${#git_mounts[@]}" -gt 0 ] && args+=("${git_mounts[@]}")
  args+=(--name "haruyuki-verify-linux-$$")
  args+=(-e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0)
  args+=("$IMAGE" bash /src/apps/desktop/scripts/verify-linux-package.sh --in-container "--port=$PORT")
  [ "$KEEP" = "1" ] && args+=("--keep")

  printf '\n>> docker'
  printf ' %q' "${args[@]}"
  printf '\n'

  docker "${args[@]}"
  exit $?
}

# ---------------------------------------------------------------------------
# Container mode, step 1: toolchain, one package at a time.
# ---------------------------------------------------------------------------

has_cmd() { command -v "$1" >/dev/null 2>&1; }
has_lib() { ldconfig -p 2>/dev/null | grep -q -- "$1"; }

# Deliberately specific: a package can be listed as installed while the file it
# provides is missing, which is exactly how a missing python3 slipped through an
# `apt-get install` that returned 0.
pkg_present() {
  case "$1" in
    python3) has_cmd python3 ;;
    make) has_cmd make ;;
    g++) has_cmd g++ ;;
    git) has_cmd git ;;
    ca-certificates) [ -s /etc/ssl/certs/ca-certificates.crt ] ;;
    xvfb) has_cmd Xvfb ;;
    libglib2.0-0) has_lib libglib-2.0.so.0 ;;
    libnss3) has_lib libnss3.so ;;
    libgbm1) has_lib libgbm.so.1 ;;
    libgtk-3-0) has_lib libgtk-3.so.0 ;;
    libxss1) has_lib libXss.so.1 ;;
    libasound2) has_lib libasound.so.2 ;;
    libdrm2) has_lib libdrm.so.2 ;;
    *) return 1 ;;
  esac
}

# The launcher and the packager both need these. The GUI libraries are not
# cosmetic: without them the Electron binary fails to link, which looks like a
# packaging bug and is not one. python3/make/g++ are the native-module toolchain.
TOOLCHAIN_PACKAGES=(
  python3 make g++ git ca-certificates
  libglib2.0-0 libnss3 libgbm1 libgtk-3-0 libxss1 libasound2 libdrm2
  xvfb
)

install_toolchain() {
  say "step 1/5 toolchain"
  local is_root=0
  [ "$(id -u)" = "0" ] && is_root=1

  if [ "$is_root" = "1" ]; then
    if ! apt-get update -qq >/tmp/apt-update.log 2>&1; then
      fail "apt-get update failed; package indices are not reachable from this container"
      tail -5 /tmp/apt-update.log
      exit 3
    fi
    mark "apt indices: ok"
  else
    mark "not root: checking only, cannot install"
  fi

  local -a missing=()
  local pkg
  for pkg in "${TOOLCHAIN_PACKAGES[@]}"; do
    pkg_present "$pkg" || missing+=("$pkg")
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    for pkg in "${TOOLCHAIN_PACKAGES[@]}"; do mark "$pkg: present"; done
    return 0
  fi

  mark "absent: ${missing[*]}"
  if [ "$is_root" != "1" ]; then
    fail "toolchain is incomplete and this user cannot install: ${missing[*]}"
    say "refusal: the image has no usable toolchain (exit 3, not a build failure)"
    exit 3
  fi

  # One apt call for the whole set: thirteen of them take several minutes each on
  # a cold container, and the verifying loop below is what actually establishes
  # that each package arrived. The single call is not trusted for that.
  if ! apt-get install -y -qq "${missing[@]}" >/tmp/apt-install.log 2>&1; then
    mark "the combined install failed; retrying one package at a time to find out which"
  fi

  # Anything still absent gets its own attempt, so one unavailable package does
  # not read as "the whole toolchain is broken" and a package that merely needed
  # a separate transaction still lands.
  local -a still=()
  for pkg in "${missing[@]}"; do
    pkg_present "$pkg" && continue
    apt-get install -y -qq "$pkg" >"/tmp/apt-$pkg.log" 2>&1
    pkg_present "$pkg" || still+=("$pkg")
  done

  local -a absent=()
  for pkg in "${TOOLCHAIN_PACKAGES[@]}"; do
    if pkg_present "$pkg"; then
      case " ${missing[*]} " in
        *" $pkg "*) mark "$pkg: installed" ;;
        *) mark "$pkg: present" ;;
      esac
    else
      mark "$pkg: MISSING"
      absent+=("$pkg")
    fi
  done

  if [ "${#absent[@]}" -gt 0 ]; then
    fail "toolchain is incomplete: ${absent[*]}"
    tail -3 /tmp/apt-install.log 2>/dev/null
    say "refusal: the image has no usable toolchain (exit 3, not a build failure)"
    exit 3
  fi
}

# ---------------------------------------------------------------------------
# Container mode, step 2: a clean build tree.
# ---------------------------------------------------------------------------

# The packaging command refuses to build when it cannot read the tag list: "may
# already be published" has to fail loudly, and it cannot tell that from an
# exported tarball. A plain `tar` copy is exactly that shape - a checkout with
# no history - so the history is carried along rather than the guard being
# weakened. What gets copied is the object database plus the ref state of this
# worktree, with the links to other worktrees dropped: they point at paths on a
# machine this is not.
carry_git_metadata() {
  local git_dir="" common=""

  # Preferred source: the host mounts the two directories below, because the
  # `.git` entry in a linked worktree is a pointer to an absolute path on the
  # machine that created it, which does not exist here.
  if [ -d /git ] || [ -d /git-worktree ]; then
    common="/git"
    git_dir="/git-worktree"
  else
    git_dir="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir 2>/dev/null)" || git_dir=""
    common="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir 2>/dev/null)" || common=""
    case "$common" in
      /*) : ;;
      "") : ;;
      *) common="$(cd "$REPO_ROOT" && cd "$common" && pwd)" ;;
    esac
  fi

  if [ ! -d "$common" ]; then
    mark "git: no history reachable here, so the packaging command will refuse to build"
    return 0
  fi

  mkdir -p "$BUILD/.git"
  cp -a "$common"/. "$BUILD/.git"/ 2>/dev/null || true
  # Links to other worktrees point at paths on another machine; keeping them
  # would make this copy claim to be somebody else's checkout.
  rm -rf "$BUILD/.git/worktrees" "$BUILD/.git/commondir" "$BUILD/.git/gitdir"
  [ -f "$git_dir/HEAD" ] && cp -a "$git_dir/HEAD" "$BUILD/.git/HEAD"
  [ -f "$git_dir/index" ] && cp -a "$git_dir/index" "$BUILD/.git/index" 2>/dev/null

  # A copy that cannot answer the tag question is worth nothing to the guard, so
  # this line is what says whether the two directories above were usable.
  local head tags
  head="$(cd "$BUILD" && git rev-parse --short HEAD 2>/dev/null)" || head="unknown"
  tags="$(cd "$BUILD" && git tag --list 2>/dev/null | wc -l)" || tags="0"
  mark "git: $(du -sh "$BUILD/.git" | cut -f1), HEAD $head, $tags tags"
}

prepare_tree() {
  say "step 2/5 build tree"
  SCRATCH="$(mktemp -d /tmp/haruyuki-verify-XXXXXX)" || {
    fail "cannot create a scratch directory"
    exit 3
  }
  BUILD="$SCRATCH/build"
  mkdir -p "$BUILD"

  # The checkout carries a Windows node_modules: pnpm sees a modules directory it
  # did not write and aborts, and the native binaries inside are win32 only. A
  # Linux build starts from a clean copy, so generated and foreign-platform
  # output is left behind rather than trusted. `_research` goes too: the engine
  # artifact is meant to be fetched by the pipeline, not supplied by the caller.
  tar -C "$REPO_ROOT" -cf - \
    --exclude=node_modules --exclude=.git --exclude=_research --exclude=docs \
    --exclude=apps/desktop/dist --exclude=apps/desktop/release \
    --exclude=apps/desktop/runtime --exclude=apps/desktop/runtime-lock.json \
    --exclude=coverage . 2>/dev/null | tar -C "$BUILD" -xf -
  mark "copied: $(du -sh "$BUILD" | cut -f1)"

  if [ ! -f "$BUILD/pnpm-lock.yaml" ]; then
    fail "no pnpm-lock.yaml in the copied tree; nothing can be installed reproducibly"
    exit 1
  fi

  if has_cmd git; then carry_git_metadata; else mark "git: not installed"; fi

  if [ "$(id -u)" = "0" ]; then
    corepack enable pnpm >/dev/null 2>&1 && mark "pnpm: enabled through corepack"
  fi
  if has_cmd pnpm; then mark "pnpm: $(pnpm --version 2>&1 | head -1)"; fi
  mark "node: $(node -v 2>&1)"
}

# ---------------------------------------------------------------------------
# Container mode, step 3: the packaging pipeline.
# ---------------------------------------------------------------------------

package_artifact() {
  say "step 3/5 pipeline (release.mjs --linux-only)"
  local log="$SCRATCH/release.log"

  ( cd "$BUILD" && node apps/desktop/scripts/release.mjs --linux-only ) >"$log" 2>&1
  local code=$?
  mark "release.mjs exit=$code"
  tail -40 "$log"

  APPIMAGE="$(find "$BUILD/apps/desktop/release" -maxdepth 2 -name '*.AppImage' -type f 2>/dev/null | head -1)"
  if [ -z "$APPIMAGE" ]; then
    fail "no AppImage under apps/desktop/release after the pipeline"
    # A prerequisite that never reached packaging is not the same failure as a
    # package that was built and does not run: one is this machine, the other is
    # the build. Keeping them apart is what makes the exit code actionable.
    case "$code" in
      2 | 3) say "refusal: a prerequisite step failed before packaging (exit 3)"; exit 3 ;;
      *) say "packaging was attempted and failed (exit 1)"; exit 1 ;;
    esac
  fi

  APPIMAGE_NAME="$(basename "$APPIMAGE")"
  APPIMAGE_BYTES="$(stat -c%s "$APPIMAGE")"
  mark "artifact: $APPIMAGE_NAME $APPIMAGE_BYTES bytes"

  if [ "$code" != "0" ]; then
    mark "pipeline exited $code although an artifact exists; the artifact checks decide below"
  fi
}

# ---------------------------------------------------------------------------
# Container mode, step 4: the artifact itself.
# ---------------------------------------------------------------------------

is_elf() {
  [ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]
}

check_artifact() {
  say "step 4/5 artifact (exists, unpacks, links)"
  local dir="$SCRATCH/extract"
  rm -rf "$dir"
  mkdir -p "$dir"

  if [ ! -s "$APPIMAGE" ]; then
    fail "AppImage is missing or empty (${APPIMAGE_BYTES:-?} bytes)"
    return 1
  fi
  mark "bytes: $APPIMAGE_BYTES"

  ( cd "$dir" && timeout 900 "$APPIMAGE" --appimage-extract ) >"$SCRATCH/extract.log" 2>&1
  local code=$?
  mark "extract exit=$code"
  if [ "$code" != "0" ]; then
    fail "--appimage-extract failed; this is not a download a user can unpack"
    tail -20 "$SCRATCH/extract.log"
    return 1
  fi
  if [ ! -d "$dir/squashfs-root" ]; then
    fail "extract exited 0 but produced no squashfs-root"
    return 1
  fi

  EXTRACT_FILES="$(find "$dir/squashfs-root" | wc -l)"
  mark "extracted entries: $EXTRACT_FILES"

  # AppRun is the entry point a user's double-click reaches, so its libraries
  # are the ones that decide whether the download runs. The other ELF files are
  # reported as a cross-check: a plugin that resolves lazily can look unresolved
  # here while the app never loads it, and treating that as fatal would fail a
  # package that starts.
  local launcher="$dir/squashfs-root/AppRun"
  if [ ! -x "$launcher" ]; then
    fail "the unpacked tree has no executable AppRun"
    return 1
  fi

  LAUNCHER_MISSING="$(ldd "$launcher" 2>&1 | grep -c 'not found')"
  mark "ldd AppRun: $LAUNCHER_MISSING missing"

  local total=0 checked=0 target count
  for target in "$dir/squashfs-root"/*; do
    [ -f "$target" ] && [ "$target" != "$launcher" ] && is_elf "$target" || continue
    count="$(ldd "$target" 2>&1 | grep -c 'not found')"
    mark "ldd $(basename "$target"): $count missing"
    total=$((total + count))
    checked=$((checked + 1))
  done
  EXTRACT_MISSING=$((LAUNCHER_MISSING + total))
  mark "other ELF files checked: $checked, their missing libraries: $total"
  mark "missing libraries (total): $EXTRACT_MISSING"

  if [ "$LAUNCHER_MISSING" -gt 0 ]; then
    fail "AppRun cannot resolve every shared library, so the download cannot start here"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Container mode, step 5: does it start, and does it paint.
# ---------------------------------------------------------------------------

# Written next to the build tree and driven from the shell: poll the DevTools
# endpoint for a page target, then ask that page how many children the mount
# point has. Both halves are needed - a target exists before React renders, and
# a rendered root is what "painted" means when there is no screenshot tool.
cdp_probe_source() {
  cat <<'JSEOF'
const port = Number(process.argv[2] ?? 9222);
const deadlineMs = Number(process.argv[3] ?? 120) * 1000;
const started = Date.now();

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already closed */ }
      reject(new Error("devtools evaluate timed out"));
    }, 15000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("devtools socket error"));
    });
  });
}

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`devtools list http ${response.status}`);
  return response.json();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let lastLine = "no devtools endpoint yet";
while (Date.now() - started < deadlineMs) {
  let targets;
  try {
    targets = await listTargets();
  } catch (error) {
    lastLine = String(error.message ?? error);
    await sleep(1000);
    continue;
  }
  const page = targets.find((target) => target.type === "page");
  if (page === undefined) {
    lastLine = `targets=${targets.length}, none of type page`;
    await sleep(1000);
    continue;
  }
  const title = String(page.title ?? "");
  if (page.webSocketDebuggerUrl === undefined) {
    lastLine = `page target without webSocketDebuggerUrl (title=${JSON.stringify(title)})`;
    await sleep(1000);
    continue;
  }
  try {
    const evaluated = await evaluate(
      page.webSocketDebuggerUrl,
      "document.querySelectorAll('#root > *').length",
    );
    const children = evaluated?.result?.value;
    const waited = Date.now() - started;
    console.log(
      `cdp: title=${JSON.stringify(title)} url=${JSON.stringify(String(page.url ?? ""))} ` +
        `rootChildren=${String(children)} waitedMs=${waited}`,
    );
    if (title.length === 0) {
      console.log("cdp: page target has an empty title");
      process.exit(1);
    }
    if (typeof children !== "number" || children <= 0) {
      console.log(`cdp: #root has ${String(children)} children, expected more than 0`);
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    lastLine = String(error.message ?? error);
    await sleep(1000);
  }
}

console.log(`cdp: gave up after ${Math.round(deadlineMs / 1000)} s, last status: ${lastLine}`);
process.exit(1);
JSEOF
}

ensure_user() {
  # The launcher refuses to start as root without weakening the sandbox, and the
  # sandbox is not negotiable; an unprivileged account is the supported shape.
  id builder >/dev/null 2>&1 && return 0
  useradd -m builder >/dev/null 2>&1 && mark "created unprivileged user: builder"
}

start_and_judge() {
  say "step 5/5 start (non-root, Xvfb, DevTools paint probe)"

  local root="$SCRATCH/extract/squashfs-root"
  local home="$SCRATCH/home"
  local ud="$SCRATCH/user-data"
  local app_log="$SCRATCH/app.log"
  local cdp_log="$SCRATCH/cdp.log"
  mkdir -p "$home" "$ud"

  ensure_user
  if ! id builder >/dev/null 2>&1; then
    fail "cannot create an unprivileged user, and root cannot launch the shell without weakening the sandbox"
    exit 3
  fi
  chown -R builder "$home" "$ud" 2>/dev/null || true
  # `mktemp -d` is 0700, and the launcher runs as somebody else: without opening
  # the path down to the tree, the child cannot even reach its own executable.
  chmod a+rx "$SCRATCH" 2>/dev/null || true
  chmod -R a+rX "$root" 2>/dev/null || true

  : >"$SCRATCH/xvfb.log"
  Xvfb :99 -screen 0 1280x800x24 >"$SCRATCH/xvfb.log" 2>&1 &
  XVFB_PID=$!
  local waited=0
  while [ ! -S /tmp/.X11-unix/X99 ] && [ "$waited" -lt 20 ]; do
    sleep 1
    waited=$((waited + 1))
    kill -0 "$XVFB_PID" 2>/dev/null || break
  done
  if [ ! -S /tmp/.X11-unix/X99 ]; then
    fail "Xvfb did not come up; the start check needs a display"
    tail -10 "$SCRATCH/xvfb.log"
    exit 3
  fi
  mark "Xvfb: :99 up after ${waited}s"

  cdp_probe_source >"$SCRATCH/cdp.mjs"

  local started
  started="$(date +%s)"
  # setsid: the app and its helper processes get their own process group, so the
  # cleanup can end the whole tree without guessing at pids.
  setsid su builder -c "cd '$root' && DISPLAY=:99 HOME='$home' ./AppRun --user-data-dir='$ud' --remote-debugging-port=$PORT" \
    >"$app_log" 2>&1 &
  APP_PID=$!
  mark "launcher started: pid=$APP_PID display=:99 user=builder (no sandbox flags)"

  # The window is the slow part, so the probe gets most of the survival window.
  node "$SCRATCH/cdp.mjs" "$PORT" 120 >"$cdp_log" 2>&1
  local cdp_code=$?
  cat "$cdp_log"
  mark "cdp exit=$cdp_code"

  # Survival is measured from the launch, not from when the probe finished:
  # "up for 150 s" and "still up when I looked" are different claims.
  local elapsed
  elapsed=$(( $(date +%s) - started ))
  if [ "$elapsed" -lt 150 ]; then sleep $((150 - elapsed)); fi
  SURVIVED=$(( $(date +%s) - started ))

  local alive=0
  kill -0 "$APP_PID" 2>/dev/null && alive=1
  local fatal_count
  fatal_count="$(grep -ci 'fatal' "$app_log" 2>/dev/null)"
  fatal_count="${fatal_count:-0}"
  mark "process alive after ${SURVIVED}s: $alive"
  mark "FATAL lines in log: $fatal_count"
  tail -25 "$app_log"

  kill -TERM -- "-$APP_PID" 2>/dev/null || kill -TERM "$APP_PID" 2>/dev/null || true
  APP_PID=""

  [ "$alive" = "1" ] && [ "$fatal_count" = "0" ] && V07A=1
  [ "$cdp_code" = "0" ] && V07B=1
  CDP_LINE="$(tail -1 "$cdp_log" 2>/dev/null)"

  [ "$V07A" = "1" ] || fail "the launcher did not stay up for ${SURVIVED}s without a FATAL"
  [ "$V07B" = "1" ] || fail "the paint probe found no titled page with a non-empty #root"
}

# ---------------------------------------------------------------------------
# Container mode, verdict.
# ---------------------------------------------------------------------------

run_in_container() {
  say "inside container"
  mark "kernel: $(uname -a)"
  mark "user: $(id -u):$(id -un)"
  mark "image: $IMAGE"

  install_toolchain
  prepare_tree
  package_artifact

  if check_artifact; then V06=1; fi

  if [ "$V06" = "1" ]; then
    start_and_judge
  else
    mark "start checks skipped: there is no unpackable artifact to start"
  fi

  say "verdict"
  printf '  %-30s %s\n' "artifact produced" "$( [ "$V06" = 1 ] && echo pass || echo FAIL)"
  printf '  %-30s %s\n' "unpacks + links" "$( [ "$V06" = 1 ] && echo pass || echo FAIL)"
  printf '  %-30s %s\n' "survived 150s, no FATAL" "$( [ "$V07A" = 1 ] && echo pass || echo FAIL)"
  printf '  %-30s %s\n' "window painted (CDP #root)" "$( [ "$V07B" = 1 ] && echo pass || echo FAIL)"
  printf '  %-30s %s\n' "AppImage" "$APPIMAGE_NAME"
  printf '  %-30s %s\n' "AppImage bytes" "$APPIMAGE_BYTES"
  printf '  %-30s %s\n' "extracted entries" "$EXTRACT_FILES"
  printf '  %-30s %s\n' "missing libraries" "$EXTRACT_MISSING"
  printf '  %-30s %s\n' "survival seconds" "$SURVIVED"
  printf '  %-30s %s\n' "paint probe" "$CDP_LINE"
  printf '  %-30s %s\n' "scratch" "$SCRATCH"

  if [ "$V06" = "1" ] && [ "$V07A" = "1" ] && [ "$V07B" = "1" ]; then
    say "result: pass (exit 0)"
    exit 0
  fi
  say "result: fail (exit 1) - an artifact exists but does not start, or does not paint"
  exit 1
}

trap cleanup EXIT

if [ "$IN_CONTAINER" = "1" ]; then
  run_in_container
else
  run_on_host
fi
