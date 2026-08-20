import Foundation
import AppKit
import ApplicationServices
import CoreFoundation
import CoreImage
import CoreMedia
import Network
#if canImport(OSLog)
import OSLog
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
#if canImport(Vision)
import Vision
#endif
#if canImport(Speech)
import Speech
import AVFoundation
#endif

// MonitorRuntime owns the live observation infrastructure for a single
// monitor session. Pulled out of MonitorDomain so the domain can keep an
// N-element `[sid: MonitorRuntime]` map and run multiple concurrent sessions,
// each with its own scope, includes, AX observers, NSEvent global monitor,
// optional CGEventTap, source timers, and capture/speech state.
//
// Each runtime is created on session start, torn down on session stop. The
// bridges within ARE NOT shared across sessions — N concurrent monitors each
// get their own AXObserver registry, NSEvent global monitor, etc. Apple's
// NSEvent and CGEventTap APIs both support multiple registrations per
// process; AXObserver-per-PID matches the documented contract ("To handle
// multiple applications, you have to create at least one observer per
// application").

final class MonitorRuntime: @unchecked Sendable {
    let session: MonitorSession
    weak var domain: MonitorDomain?

    let axBridge = MonitorAxBridge()
    let workspaceBridge = MonitorWorkspaceBridge()
    let inputBridge = MonitorInputBridge()
    let tapBridge = MonitorTapBridge()

    // Whether the CGEventTap fallback is in use for this session.
    var tapActive = false

    // Optional source state. Nil unless the matching --include flag was set.
    var pasteboardTimer: DispatchSourceTimer?
    var lastPasteboardChangeCount: Int = -1

    var fsStream: FSEventStreamRef?
    var fsPaths: [String] = []

    var pathMonitor: NWPathMonitor?
    var lastPathStatus: NWPath.Status?

    var logTimer: DispatchSourceTimer?
    var logCursorDate: Date?
    var logPredicate: String?

    var distNotificationObservers: [NSObjectProtocol] = []

    // Retention timer.
    var autoStopTimer: DispatchSourceTimer?
    static let sessionMaxDurationSeconds: TimeInterval = 24 * 60 * 60
    static let sessionMaxBytesPerFile: Int64 = 100 * 1024 * 1024

    #if canImport(ScreenCaptureKit)
    var captureStream: SCStream?
    var captureOutput: MonitorCaptureOutput?
    // continuous video via SCRecordingOutput (macOS 15+).
    var recordingOutput: SCRecordingOutput?
    var recordingPath: String?
    var recordingDelegate: AnyObject?
    #endif

    // guards the speech ring buffer (mutated on the audio render
    // thread, read on the restart timer queue).
    let speechLock = NSLock()

    #if canImport(Speech)
    var speechEngine: AVAudioEngine?
    var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    var speechTask: SFSpeechRecognitionTask?
    // restart the SFSpeechRecognitionTask before Apple's ~60s
    // hard limit. The ring buffer replays the trailing ~2s of audio across the
    // restart so a word spanning the boundary isn't dropped.
    var speechRestartTimer: DispatchSourceTimer?
    var speechRing: [AVAudioPCMBuffer] = []
    var speechRingFrameBudget: AVAudioFrameCount = 0
    var speechRestarting = false
    // offline fallback: always tee mic audio to a .caf under the
    // session dir using the (already-granted) Microphone permission, so a
    // transcript exists even when live Speech-Recognition TCC is denied.
    var speechAudioFile: AVAudioFile?
    var speechCafPath: String?
    // utterance segmentation state (guarded by speechLock): buffer-based
    // recognition only delivers isFinal at finish()/endAudio() — and empty
    // on-device — so utterance-final speech_segment events are synthesized
    // from the latest partial at boundary signals (recognition metadata,
    // silence, restart, stop). See MonitorDomain.flushPendingUtterance.
    var pendingSpeechText: String = ""
    var pendingSpeechAt: Date = .distantPast
    var lastPartialEmitAt: Date = .distantPast
    var lastFlushedSpeechText: String = ""
    var speechSilenceTimer: DispatchSourceTimer?
    // metadata marks the utterance boundary, but late revisions can still
    // arrive right behind it — the flush is deferred by a short grace window
    // (speechGraceWorkItem) so those revisions make it into the final.
    var speechBoundaryPending = false
    var speechGraceWorkItem: DispatchWorkItem?
    #endif

    // per-session capture configuration (parsed from monitor start).
    var speechMode: String = "auto"          // auto | live | offline | off
    var framePixelScale: Int = 2
    var frameBudget: Int = 7200              // 0 = unbounded
    var frameDiskCapBytes: Int64 = 0         // 0 = uncapped
    var videoMaxBytes: Int64 = 0             // 0 = uncapped
    var scrollCoalesceMs: Int = 100
    var axCoalesceMs: Int = 100
    var includeSystemApps: Bool = false
    var excludeApps: Set<String> = []        // bundle ids or localized names
    var backpressureNotified = false         // emit capture_backpressure once

    init(session: MonitorSession, domain: MonitorDomain) {
        self.session = session
        self.domain = domain
    }
}
