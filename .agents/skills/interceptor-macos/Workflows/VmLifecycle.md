---
name: VmLifecycle
description: Manage Linux and macOS virtual machines via `interceptor macos vm *`. Covers create, clone, install, start, exec, snapshot, restore, stop, and delete. Linux uses Apple's Containerization Swift package in-process; macOS uses raw VZ. State lives under $CWD/.interceptor/vms/ by default. Replaces Lume / Tart / UTM. Use for QA gold-VM pipelines, ephemeral test VMs, and any workflow that needs to drive a guest with the same AX/click/type/screenshot verbs Interceptor exposes on the host.
---

# VM Lifecycle Workflow

You are managing a virtual machine through `interceptor macos vm`. The host runs the bridge with `com.apple.security.virtualization`. Linux guests are backed by Apple's Containerization package; macOS guests by raw `Virtualization.framework`.

## State location

Default: `$CWD/.interceptor/vms/`. Override per-invocation with `--state-dir <path>` or globally with `INTERCEPTOR_VM_STATE_DIR`. Layout per VM:

```
<state>/vms/<name>.bundle/
    spec.json
    Disk.img
    AuxiliaryStorage          (macOS only)
    MachineIdentifier         (macOS only)
    HardwareModel             (macOS only)
    snapshots/<tag>/SaveFile.vzvmsave + manifest.json
```

This matches Apple's `VM.bundle` spec — external tools can read it.

## Linux guest — minimal end-to-end

```bash
interceptor macos vm create lin1 \
    --kind linux \
    --cpu 2 --memory 1073741824 --disk 4294967296 \
    --image docker.io/library/alpine:3 \
    --network nat
interceptor macos vm start lin1 --wait-for-vsock
interceptor macos vm exec lin1 -- uname -a
interceptor macos vm stop lin1
interceptor macos vm delete lin1 --force
```

## macOS guest — install once, clone many

```bash
# One-time gold image install (~10-20 min the first time, ~free thereafter)
interceptor macos vm install macos-gold --from-latest \
    --cpu 4 --memory 8589934592 --disk 64424509440

# Operator does the one-time TCC grant (Accessibility / Screen Recording /
# Input Monitoring / Microphone / Speech Recognition) inside the booted
# gold VM, then snapshots. Subsequent clones inherit the grant.
interceptor macos vm snapshot macos-gold baseline --paused-state

# Per-run clone is CoW (instant)
interceptor macos vm clone macos-gold macos-test
interceptor macos vm start macos-test --wait-for-vsock --headless

# Drive
interceptor macos vm exec macos-test sw_vers
interceptor macos vm screenshot macos-test --out /tmp/before.png
interceptor macos vm read-ax macos-test --filter 'AXButton'
interceptor macos vm click macos-test 800 600

# Tear down
interceptor macos vm stop macos-test
interceptor macos vm delete macos-test --force
```

## Verb cheat sheet

| Verb | Purpose | Notes |
|---|---|---|
| `create` | Allocate bundle + persist spec. Does not boot. | `--kind linux\|macos` required |
| `clone <src> <dst>` | APFS clonefile + identifier rotation | Inherits TCC grants on macOS |
| `install <name> --from-latest` | macOS only: VZMacOSInstaller | Operator does TCC dance once, then snapshot |
| `pull <oci-ref>` | Linux only: pre-cache an OCI image | Cached at `<state>/images/oci/` |
| `start <name>` | Boot. Default blocks until running. | `--headless`, `--wait-for-vsock`, `--detach` |
| `stop <name>` | Graceful: `requestStop`. `--force` for `VZVirtualMachine.stop`. | `--timeout 60` |
| `pause` / `resume` | VZ pause / resume | macOS guests only in v1 |
| `delete <name>` | Tear down. `--keep-disk` parks the bundle. | `--force` is required when running |
| `reset <name>` | Recover from `.error` state. | Rebuilds VZVirtualMachine from spec |
| `exec <name> -- <argv>` | Run a command inside the guest. | vsock guest agent; `--via ssh` (Linux only) |
| `snapshot <name> <tag>` | Pause-state + disk clone. | `--paused-state`, `--disk-only` |
| `restore <name> <tag>` | Roll Disk.img back, optional VZ state restore. | VM must be stopped |
| `screenshot`, `type`, `click`, `keys`, `read-ax`, `console`, `logs`, `cp`, `share`, `mount`, `port-forward` | Guest-driving verbs via the in-guest agent. | v2 — pre-granted PPPC on macOS gold image |

## Native delivery

Projects that previously used Lume can replace:

- `qa/lib/lume.sh` — replaced by `interceptor macos vm get/clone/start/stop/delete`.
- `qa/lib/ssh.sh` — replaced by `interceptor macos vm exec/cp`.
- `qa/lib/screenshot.sh` — replaced by `interceptor macos vm screenshot`.

For each `lume` verb, the equivalent native call:

| Old Lume verb | Native replacement |
|---|---|
| `lume get <n> --format json` → `.[0].status` / `.ipAddress` | `interceptor macos vm get <n> --json` |
| `lume clone <src> <dst>` | `interceptor macos vm clone <src> <dst>` |
| `lume run <n> --no-display` | `interceptor macos vm start <n> --headless --wait-for-vsock` |
| `lume stop <n>` | `interceptor macos vm stop <n>` |
| `lume delete <n> --force` | `interceptor macos vm delete <n> --force` |
| `sshpass -p lume ssh <n> <cmd>` | `interceptor macos vm exec <n> -- <cmd>` |
| `sshpass -p lume scp <src> <n>:<dst>` | `interceptor macos vm cp <src> <n>:<dst>` |
| `screencapture -x` over SSH | `interceptor macos vm screenshot <n> --out <path>` |
| `osascript -e 'keystroke return'` over SSH | `interceptor macos vm keys <n> return` |

The vsock guest agent (in-guest `interceptord`) keeps in-guest AX, click, and screenshot independent from SSH-session TCC grants.

## Setup_required envelopes

The bridge returns `setup_required` envelopes when the host can't run VMs:

- `host macOS < 15.0` — upgrade via `softwareupdate --install`.
- Bridge missing `com.apple.security.virtualization` — rebuild with `scripts/build-bridge.sh`.
- Bridge installed under `~/Documents` or `~/Desktop` — move it (see `research/container/BUILDING.md:9-10`).

Callers parse the envelope and surface a clean error rather than re-trying the failing verb.

## Snapshots — what survives

- **Disk-state** (`--disk-only`): clonefile of Disk.img. Always works.
- **Paused-state** (`--paused-state`): `VZVirtualMachine.saveMachineStateTo(url:)`. Requires `validateSaveRestoreSupport()` to return true on the config. macOS guests support it; some Linux configurations do not.
- **TCC grants on macOS gold**: pre-granted PPPC profile in the installed `.pkg`, snapshotted into the gold's AuxiliaryStorage. Clones inherit.

## Background-first

`vm start --headless` is the default. `vm screenshot` defaults to vsock-driven `CGDisplayCreateImage` inside the guest agent — no host TCC. `--pixel` falls back to host-side `VZVirtualMachineView` capture, which requires Screen Recording on the host.
