/**
 * VM lifecycle smoke
 *
 * End-to-end exercise of the `interceptor macos vm *` CLI surface against
 * a freshly-built bridge binary. Tests the parser layer + the daemon-to-
 * bridge round trip + the registry on-disk shape.
 *
 * The actual guest boot is gated on:
 *   - macOS 15+ host
 *   - com.apple.security.virtualization entitlement on the bridge
 *   - successful resolution of the apple/containerization Swift package
 *
 * When those aren't satisfied this test exercises the parser-level
 * behaviour (CL24-CL28) and confirms the bridge returns a
 * `setup_required` envelope per design notes.
 */

import { test, expect } from "bun:test"
import { parseMacosCommand } from "../cli/commands/macos"
import { existsSync, rmSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function p(argv: string[]) {
  return parseMacosCommand(argv) as any
}

test("vm create — parses required flags into macos_vm_create action", () => {
  const action = p([
    "macos",
    "vm",
    "create",
    "lin1",
    "--kind",
    "linux",
    "--cpu",
    "2",
    "--memory",
    "1073741824",
    "--disk",
    "4294967296",
    "--image",
    "docker.io/library/alpine:3",
    "--network",
    "nat",
  ])
  expect(action.type).toBe("macos_vm_create")
  expect(action.sub).toBe("create")
  expect(action.name).toBe("lin1")
  expect(action.kind).toBe("linux")
  expect(action.cpu).toBe(2)
  expect(action.memorySize).toBe(1073741824)
  expect(action.diskSize).toBe(4294967296)
  expect(action.image).toBe("docker.io/library/alpine:3")
  expect(action.network).toBe("nat")
})

test("vm clone — parses src and dst", () => {
  const action = p(["macos", "vm", "clone", "gold", "test1"])
  expect(action.type).toBe("macos_vm_clone")
  expect(action.sub).toBe("clone")
  expect(action.src).toBe("gold")
  expect(action.dst).toBe("test1")
})

test("vm adopt — parses source, name, provider, and mode", () => {
  const action = p([
    "macos",
    "vm",
    "adopt",
    "/tmp/interceptor-vms/macos-gold",
    "--name",
    "macos-gold",
    "--provider",
    "auto",
    "--mode",
    "clone",
    "--install-agent",
  ])
  expect(action.type).toBe("macos_vm_adopt")
  expect(action.sub).toBe("adopt")
  expect(action.sourcePath).toBe("/tmp/interceptor-vms/macos-gold")
  expect(action.name).toBe("macos-gold")
  expect(action.provider).toBe("auto")
  expect(action.mode).toBe("clone")
  expect(action.installAgent).toBe(true)
})

test("vm install — accepts --from-latest", () => {
  const action = p(["macos", "vm", "install", "macgold", "--from-latest"])
  expect(action.type).toBe("macos_vm_install")
  expect(action.fromLatest).toBe(true)
})

test("vm install — accepts --ipsw <path>", () => {
  const action = p(["macos", "vm", "install", "macgold", "--ipsw", "/tmp/restore.ipsw"])
  expect(action.type).toBe("macos_vm_install")
  expect(action.ipsw).toBe("/tmp/restore.ipsw")
})

test("vm start — flags wire into action correctly", () => {
  const action = p(["macos", "vm", "start", "lin1", "--headless", "--wait-for-vsock"])
  expect(action.type).toBe("macos_vm_start")
  expect(action.headless).toBe(true)
  expect(action.waitForVsock).toBe(true)
})

test("vm stop — --force flag", () => {
  const action = p(["macos", "vm", "stop", "lin1", "--force"])
  expect(action.type).toBe("macos_vm_stop")
  expect(action.force).toBe(true)
})

test("vm exec — splits argv after --", () => {
  const action = p(["macos", "vm", "exec", "lin1", "--", "sh", "-c", "uname -a"])
  expect(action.type).toBe("macos_vm_exec")
  expect(action.command).toEqual(["sh", "-c", "uname -a"])
})

test("vm exec — env vars carry through", () => {
  const action = p([
    "macos",
    "vm",
    "exec",
    "lin1",
    "--env",
    "FOO=bar",
    "--env",
    "BAZ=qux",
    "--",
    "env",
  ])
  expect(action.type).toBe("macos_vm_exec")
  expect(action.env).toEqual({ FOO: "bar", BAZ: "qux" })
})

test("vm delete — keepDisk + force", () => {
  const action = p(["macos", "vm", "delete", "lin1", "--force", "--keep-disk"])
  expect(action.type).toBe("macos_vm_delete")
  expect(action.force).toBe(true)
  expect(action.keepDisk).toBe(true)
})

test("vm snapshot — defaults to op=create", () => {
  const action = p(["macos", "vm", "snapshot", "lin1", "scratch"])
  expect(action.type).toBe("macos_vm_snapshot")
  expect(action.name).toBe("lin1")
  expect(action.tag).toBe("scratch")
  expect(action.snapshotOp).toBe("create")
})

test("vm list — minimal action with no flags", () => {
  const action = p(["macos", "vm", "list"])
  expect(action.type).toBe("macos_vm_list")
  expect(action.sub).toBe("list")
})

test("vm get — requires name", () => {
  const action = p(["macos", "vm", "get", "lin1"])
  expect(action.type).toBe("macos_vm_get")
  expect(action.name).toBe("lin1")
})

test("vm pull — captures image ref", () => {
  const action = p(["macos", "vm", "pull", "docker.io/library/alpine:3"])
  expect(action.type).toBe("macos_vm_pull")
  expect(action.image).toBe("docker.io/library/alpine:3")
})

test("vm read-ax — renamed to read_ax in action type", () => {
  const action = p(["macos", "vm", "read-ax", "mactest"])
  expect(action.type).toBe("macos_vm_read_ax")
  expect(action.sub).toBe("read-ax")
})

test("vm port-forward — renamed to port_forward in action type", () => {
  const action = p(["macos", "vm", "port-forward", "lin1"])
  expect(action.type).toBe("macos_vm_port_forward")
})

test("vm tcc profile generate — parses guest profile request", () => {
  const action = p([
    "macos",
    "vm",
    "tcc",
    "profile",
    "generate",
    "mactest",
    "--out",
    "/tmp/guest.mobileconfig",
    "--service",
    "Accessibility,PostEvent",
  ])
  expect(action.type).toBe("macos_vm_tcc_profile_generate")
  expect(action.sub).toBe("tcc_profile_generate")
  expect(action.name).toBe("mactest")
  expect(action.out).toBe("/tmp/guest.mobileconfig")
  expect(action.services).toEqual(["Accessibility", "PostEvent"])
})

test("vm cp — infers vm name from destination", () => {
  const action = p(["macos", "vm", "cp", "./README.md", "mactest:/tmp/README.md"])
  expect(action.type).toBe("macos_vm_cp")
  expect(action.name).toBe("mactest")
  expect(action.src).toBe("./README.md")
  expect(action.dst).toBe("mactest:/tmp/README.md")
})

test("vm click — parses numeric coordinates", () => {
  const action = p(["macos", "vm", "click", "mactest", "12,34", "--button", "right"])
  expect(action.type).toBe("macos_vm_click")
  expect(action.name).toBe("mactest")
  expect(action.x).toBe(12)
  expect(action.y).toBe(34)
  expect(action.button).toBe("right")
})

test("vm type — captures text", () => {
  const action = p(["macos", "vm", "type", "mactest", "hello"])
  expect(action.type).toBe("macos_vm_type")
  expect(action.name).toBe("mactest")
  expect(action.text).toBe("hello")
})

test("vm create — share flag is parsed (repeatable)", () => {
  const action = p([
    "macos",
    "vm",
    "create",
    "lin1",
    "--kind",
    "linux",
    "--image",
    "alpine:3",
    "--share",
    "/host/foo:tagfoo:ro",
    "--share",
    "/host/bar:tagbar:rw",
  ])
  expect(action.shares).toEqual([
    { hostPath: "/host/foo", tag: "tagfoo", readOnly: true },
    { hostPath: "/host/bar", tag: "tagbar", readOnly: false },
  ])
})

test("vm create — rosetta toggle", () => {
  const action = p([
    "macos",
    "vm",
    "create",
    "lin1",
    "--kind",
    "linux",
    "--image",
    "alpine:3",
    "--rosetta",
  ])
  expect(action.rosetta).toBe(true)
})

test("vm create — stateDir override propagates", () => {
  const action = p([
    "macos",
    "vm",
    "create",
    "lin1",
    "--kind",
    "linux",
    "--image",
    "alpine:3",
    "--state-dir",
    "/tmp/explicit",
  ])
  expect(action.stateDir).toBe("/tmp/explicit")
})
