import { expect, test } from "bun:test"

test.skipIf(process.platform !== "darwin")("trusted text clears inherited modifiers on lowercase, digits, Unicode, and Shift release", async () => {
  // Isolate the FFI mock so this test never posts OS input or changes other tests.
  const child = Bun.spawn([process.execPath, "-e", `
    import assert from "node:assert/strict";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const events = new Map(), posted = []; let next = 1;
    globalThis.__fakeFFI = { FFIType: {}, dlopen: () => ({ symbols: {
      CGEventSourceCreate: () => 1,
      CGEventCreateKeyboardEvent: (_source, key, down) => {
        const id = next++; events.set(id, { key, down, flags: 0x120000 }); return id;
      },
      CGEventSetFlags: (id, flags) => { events.get(id).flags = flags; },
      CGEventPost: (_tap, id) => { posted.push({ ...events.get(id) }); },
      CGEventKeyboardSetUnicodeString: () => {},
      CFRelease: () => {}
    } }) };
    const source = (await Bun.file("./daemon/os-input.ts").text()).replace(
      'import { dlopen, FFIType } from "bun:ffi"', 'const { dlopen, FFIType } = globalThis.__fakeFFI'
    );
    assert(!source.includes('"bun:ffi"'));
    const dir = mkdtempSync(join(tmpdir(), "os-type-test-"));
    try {
    await Bun.write(join(dir, "input.ts"), source);
    const { osType } = await import(join(dir, "input.ts"));
    assert.equal((await osType("Ab1Ω")).success, true);
    assert.deepEqual(posted.map(e => [e.key, e.down, e.flags]), [
      [56, true, 0x20000], [0, true, 0x20000], [0, false, 0x20000], [56, false, 0],
      [11, true, 0], [11, false, 0], [18, true, 0], [18, false, 0],
      [0, true, 0], [0, false, 0]
    ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
})
