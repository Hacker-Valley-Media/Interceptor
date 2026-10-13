import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { buildPayload, envelope, fileName, publicKey, verifyEnvelope } from "../scripts/publish-desktop-updates"

const exe = (n: number) => Buffer.concat([Buffer.from("MZ"), Buffer.alloc(n)])
const gz = (n: number) => Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(n)])
const keys = () => {
  const { publicKey: pub, privateKey } = generateKeyPairSync("ed25519")
  return { raw: pub.export({ format: "der", type: "spki" }).subarray(12).toString("base64"), privateKey }
}

test("each feed names one Full installer per architecture with its digest and length", () => {
  const payload = buildPayload("windows", "2.1.0", { arm64: exe(10), x64: exe(20) }, "2026-10-12T00:00:00Z", "https://updates.hackervalley.media/release-notes-2.1.0.html")
  expect(payload.artifacts.arm64).toEqual({ file: "Interceptor-Full-2.1.0-windows-arm64.exe", url: "https://updates.hackervalley.media/windows/Interceptor-Full-2.1.0-windows-arm64.exe", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), length: 12 })
  expect(buildPayload("linux", "2.1.0", { arm64: gz(1), x64: gz(2) }, "2026-10-12T00:00:00Z").artifacts.x64.url).toBe("https://updates.hackervalley.media/linux/Interceptor-Full-2.1.0-linux-x64.tar.gz")
  expect(fileName("2.1.0", "linux", "arm64")).toBe("Interceptor-Full-2.1.0-linux-arm64.tar.gz")
  expect(() => buildPayload("windows", "2.1.0", { arm64: exe(1) }, "t")).toThrow(/every architecture/)
  expect(() => buildPayload("windows", "2.1.0", { arm64: gz(1), x64: exe(1) }, "t")).toThrow(/not a Windows executable/)
  expect(() => buildPayload("linux", "2.1.0", { arm64: exe(1), x64: gz(1) }, "t")).toThrow(/not a gzip/)
  expect(() => buildPayload("linux", "v2.1.0", { arm64: gz(1), x64: gz(1) }, "t")).toThrow(/X.Y.Z/)
})

test("the envelope verifies only with the signing key and only over the exact payload", () => {
  const { raw, privateKey } = keys()
  const payload = Buffer.from(JSON.stringify(buildPayload("linux", "2.1.0", { arm64: gz(1), x64: gz(2) }, "t")))
  const text = envelope(payload, sign(null, payload, privateKey))
  expect(verifyEnvelope(text, raw).version).toBe("2.1.0")
  expect(() => verifyEnvelope(text, keys().raw)).toThrow(/does not verify/)
  const outer = JSON.parse(text)
  outer.payload = Buffer.from(payload.toString().replace("2.1.0", "9.9.9")).toString("base64")
  expect(() => verifyEnvelope(JSON.stringify(outer), raw)).toThrow(/does not verify/)
  expect(() => verifyEnvelope(JSON.stringify({ ...JSON.parse(text), extra: 1 }), raw)).toThrow(/envelope/)
})

test("the feeds are signed with the Sparkle key the Mac bridge pins", () => {
  expect(publicKey()).toBe("dnUnuHGCO4obHb44Khlf2TZQFUMmFGGpm2c6j+EqmdU=")
})
