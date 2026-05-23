// VMConsole
//
// Builds a `VZVirtioConsoleDeviceSerialPortConfiguration` and exposes a
// pipe pair so the bridge can attach an interactive TTY via
// `interceptor macos vm console <name>`. Apple's serial-port surface:
// `apple-developer-docs/Virtualization/serial-ports.md` +
// `VZFileHandleSerialPortAttachment` (file handles in both directions).
//
// We keep a single host-side pair of pipes per VM (read end → host stdin
// for the console session; write end ← host stdout). The VMInstance
// stores the pair so console sessions can attach and detach.

import Foundation
#if canImport(Virtualization)
import Virtualization
#endif

public struct VMConsoleHandles: Sendable {
    public let inputForGuest: FileHandle    // host writes here; guest reads
    public let outputFromGuest: FileHandle   // host reads here; guest writes

    public let inputPipeWriteEnd: FileHandle  // host end of the guest-input pipe
    public let outputPipeReadEnd: FileHandle  // host end of the guest-output pipe
}

public struct VMConsole: Sendable {
#if canImport(Virtualization)
    @available(macOS 11.0, *)
    public static func buildSerialPort() -> (config: VZSerialPortConfiguration, handles: VMConsoleHandles) {
        // host→guest pipe: bridge writes to inputPipeWriteEnd, guest reads inputForGuest
        let guestInputPipe = Pipe()
        // guest→host pipe: guest writes outputFromGuest, bridge reads outputPipeReadEnd
        let guestOutputPipe = Pipe()
        let attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: guestInputPipe.fileHandleForReading,
            fileHandleForWriting: guestOutputPipe.fileHandleForWriting
        )
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = attachment
        let handles = VMConsoleHandles(
            inputForGuest: guestInputPipe.fileHandleForReading,
            outputFromGuest: guestOutputPipe.fileHandleForWriting,
            inputPipeWriteEnd: guestInputPipe.fileHandleForWriting,
            outputPipeReadEnd: guestOutputPipe.fileHandleForReading
        )
        return (serial, handles)
    }
#endif
}
