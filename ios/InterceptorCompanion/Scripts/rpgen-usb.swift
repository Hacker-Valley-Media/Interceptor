import Foundation
import IDevice
let udid = CommandLine.arguments[1]
let deviceId = UInt32(CommandLine.arguments[2])!
let out = CommandLine.arguments[3]
func msg(_ e: UnsafeMutablePointer<IdeviceFfiError>) -> String { let m = e.pointee.message.map { String(cString: $0) } ?? "code \(e.pointee.code)"; idevice_error_free(e); return m }

var addr: OpaquePointer?
if let e = idevice_usbmuxd_default_addr_new(&addr) { print("usbmux addr FAILED:", msg(e)); exit(1) }
defer { if let addr { idevice_usbmuxd_addr_free(addr) } }

var provider: OpaquePointer?
let r = udid.withCString { u in "rpgen".withCString { l in usbmuxd_provider_new(addr, 1, u, deviceId, l, &provider) } }
if let r { print("provider FAILED:", msg(r)); exit(1) }
defer { if let provider { idevice_provider_free(provider) } }
guard let provider else { print("no provider"); exit(1) }
print("usbmux provider OK (device \(deviceId)) — pairing RemoteXPC…")

var rpFile: OpaquePointer?
let pr = "InterceptorCompanion".withCString { h in tunnel_pair_usb(provider, h, nil, nil, &rpFile) }
if let pr { print("tunnel_pair_usb FAILED:", msg(pr)); exit(1) }
defer { if let rpFile { rp_pairing_file_free(rpFile) } }
guard let rpFile else { print("no RP file"); exit(1) }

if let we = out.withCString({ rp_pairing_file_write(rpFile, $0) }) { print("write FAILED:", msg(we)); exit(1) }
print("✅ RP pairing file written:", out)
