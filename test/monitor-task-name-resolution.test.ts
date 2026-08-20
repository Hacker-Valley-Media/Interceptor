/**
 * test/monitor-task-name-resolution.test.ts
 *
 * Issue #218 (smaller findings): `--task "<name>"` creates a task keyed by a
 * generated task-<id> with the name stored as `instruction`, and nothing
 * resolved the name back — `monitor task quality <name>` said "task not
 * found". Also: `task quality` only READ the transcript files, so a task
 * stopped via `--sid` (skipping the epilogue) graded as "0 segments" no
 * matter what its sources held.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  attachMonitorTaskSource,
  createMonitorTask,
  readMonitorTaskTranscriptSegments,
  resolveMonitorTaskId,
  stopMonitorTask,
  updateMonitorTaskMeta,
} from "../shared/monitor-tasks"
import { appendSessionEvent, getSessionDir, writeSessionMeta } from "../shared/monitor-artifacts"
import { parseMonitorCommand } from "../cli/commands/monitor"

const SID = "task-name-res-speech"

describe("monitor task name resolution and quality auto-synthesis (#218)", () => {
  let taskRoot: string

  beforeEach(() => {
    taskRoot = mkdtempSync(join(tmpdir(), "interceptor-task-name-test-"))
    process.env.INTERCEPTOR_TASKS_DIR = taskRoot
    rmSync(getSessionDir(SID), { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(taskRoot, { recursive: true, force: true })
    rmSync(getSessionDir(SID), { recursive: true, force: true })
    delete process.env.INTERCEPTOR_TASKS_DIR
  })

  function writeSpeechSession(sid: string, base: number): void {
    writeSessionMeta({
      artifactVersion: 1,
      surface: "macos",
      sessionId: sid,
      startedAt: base,
      status: "stopped",
      paused: false,
      rootPid: 123,
      rootBundleId: "com.apple.finder",
      rootApp: "Finder",
      instruction: "narrated capture",
      counts: { evt: 3, mut: 0, net: 0, nav: 0 },
      attachments: [],
    })
    appendSessionEvent(sid, { timestamp: new Date(base).toISOString(), event: "mon_start", sid, surface: "macos", s: 0, t: base })
    appendSessionEvent(sid, { timestamp: new Date(base + 100).toISOString(), event: "speech_segment", sid, surface: "macos", s: 1, t: base + 100, text: "open the billing dashboard", isFinal: true, source: "live" })
    appendSessionEvent(sid, { timestamp: new Date(base + 5000).toISOString(), event: "speech_segment", sid, surface: "macos", s: 2, t: base + 5000, text: "now export the invoices", isFinal: true, source: "live" })
  }

  test("resolves a task by the name it was created under", () => {
    const task = createMonitorTask({ instruction: "morning teach batch" })
    expect(resolveMonitorTaskId("morning teach batch")).toBe(task.taskId)
    expect(resolveMonitorTaskId(task.taskId)).toBe(task.taskId)
  })

  test("ambiguous names error with the candidate ids", () => {
    const a = createMonitorTask({ instruction: "dup name" })
    const b = createMonitorTask({ instruction: "dup name" })
    expect(() => resolveMonitorTaskId("dup name")).toThrow(a.taskId)
    expect(() => resolveMonitorTaskId("dup name")).toThrow(b.taskId)
  })

  test("unknown refs keep the task-not-found error", () => {
    expect(() => resolveMonitorTaskId("never-created")).toThrow("task not found: never-created")
  })

  test("task quality synthesizes missing segments instead of grading an empty transcript", async () => {
    // Events must fall inside the task's [startedAt, endedAt] window to count
    // as boundary-"active"; pin the window explicitly around the fixture
    // timestamps (stopMonitorTask would otherwise stamp endedAt before them).
    const base = Date.now() - 120_000
    writeSpeechSession(SID, base + 50)
    const task = createMonitorTask({ instruction: "narrated capture run" })
    attachMonitorTaskSource(task.taskId, SID)
    stopMonitorTask(task.taskId)
    updateMonitorTaskMeta(task.taskId, (current) => ({ ...current, startedAt: base, endedAt: base + 60_000 }))

    expect(readMonitorTaskTranscriptSegments(task.taskId)).toHaveLength(0)

    const logs: string[] = []
    const realLog = console.log
    const realErr = console.error
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")) }
    console.error = () => {}
    try {
      // addressed by NAME, graded after auto-synthesis
      await parseMonitorCommand(["monitor", "task", "quality", "narrated capture run"], true)
    } finally {
      console.log = realLog
      console.error = realErr
    }

    const segments = readMonitorTaskTranscriptSegments(task.taskId)
    expect(segments.length).toBeGreaterThan(0)
    const report = JSON.parse(logs.join("\n")) as { counts: { segmentRows: number } }
    expect(report.counts.segmentRows).toBe(segments.length)
  })
})
