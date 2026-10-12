import XCTest
import AVFoundation
import CoreMedia
@testable import interceptor_bridge

// CoreAudio inventories each device's actual input/output stream scope.

final class AudioDeviceEnumerationTests: XCTestCase {
    func testSoundReadsAndRefusalsWithoutMicrophoneAdmission() {
        let sounds = SoundDomain(), result = LockedBox<[String: Any]>([:])
        func call(_ action: [String: Any]) -> [String: Any] {
            sounds.handle("sounds", action: action) { result.set($0) }
            return result.get()
        }
        let status = call(["type": "desktop_sounds", "sub": "status"])["data"] as? [String: Any]
        XCTAssertEqual(status?["classifying"] as? Bool, false)
        XCTAssertTrue(status?["latest"] is NSNull)
        XCTAssertEqual((call(["type": "macos_sounds", "sub": "tail"])["data"] as? [String: Any])?["classifying"] as? Bool, false)
        XCTAssertEqual((call(["type": "desktop_sounds", "sub": "log", "filter": "fixture"])["data"] as? [Any])?.count, 0)
        XCTAssertEqual((call(["type": "desktop_sounds", "sub": "stop"])["data"] as? [String: Any])?["totalClassifications"] as? Int, 0)
        let invalid: [[String: Any]] = [
            ["type": "desktop_sounds", "sub": "status", "filter": "fixture"],
            ["type": "desktop_sounds", "sub": "start", "filter": "fixture"],
            ["type": "desktop_sounds", "sub": "start", "unknown": true],
            ["type": "desktop_sounds", "sub": "log", "filter": 1],
            ["type": "desktop_sounds", "sub": "log", "filter": "\0"]
        ]
        for action in invalid { XCTAssertEqual(call(action)["success"] as? Bool, false) }
    }

    func testSpeechStateAndVocabularyWithoutMicrophoneAdmission() {
        let speech = SpeechDomain(), result = LockedBox<[String: Any]>([:])
        func call(_ action: [String: Any]) -> [String: Any] {
            speech.handle("listen", action: action) { result.set($0) }
            return result.get()
        }
        XCTAssertEqual((call(["type": "macos_listen"])["data"] as? [String: Any])?["listening"] as? Bool, false)
        for word in ["café", "Interceptor"] {
            XCTAssertEqual(call(["type": "macos_listen", "sub": "vocab", "op": "add", "word": word])["success"] as? Bool, true)
        }
        XCTAssertEqual(call(["type": "macos_listen", "sub": "vocab"])["data"] as? [String], ["café", "Interceptor"])
        for action: [String: Any] in [
            ["type": "macos_listen", "sub": "status", "device": "unrequested"],
            ["type": "macos_listen", "sub": "vocab", "op": "add", "word": true],
            ["type": "macos_listen", "sub": "vocab", "op": "add", "word": "\0"],
            ["type": "macos_listen", "sub": "vocab", "op": "clear", "word": "extra"],
            ["type": "macos_listen", "sub": "tail", "extra": true]
        ] { XCTAssertEqual(call(action)["success"] as? Bool, false) }
        XCTAssertEqual(call(["type": "macos_listen", "sub": "vocab", "op": "clear"])["success"] as? Bool, true)
        for index in 0..<DESKTOP_SPEECH_MAX_VOCABULARY_WORDS {
            XCTAssertEqual(call(["type": "macos_listen", "sub": "vocab", "op": "add", "word": "term\(index)"])["success"] as? Bool, true)
        }
        XCTAssertEqual(call(["type": "macos_listen", "sub": "vocab", "op": "add", "word": "overflow"])["success"] as? Bool, false)
        let stopped = call(["type": "macos_listen", "sub": "stop"])
        XCTAssertEqual(stopped["success"] as? Bool, true)
        XCTAssertEqual((stopped["data"] as? [String: Any])?["listening"] as? Bool, false)
        XCTAssertEqual((stopped["data"] as? [String: Any])?["transcript"] as? String, "")
    }
    func testVADStatusRoutesWithoutStartingSpeechRecognition() {
        let speech = SpeechDomain()
        let result = LockedBox<[String: Any]>([:])
        speech.handle("vad", action: ["type": "macos_vad", "sub": "status"]) { result.set($0) }
        let reply = result.get()
        XCTAssertEqual(reply["success"] as? Bool, true)
        let data = reply["data"] as? [String: Any]
        XCTAssertEqual(data?["active"] as? Bool, false)
        XCTAssertEqual(data?["speaking"] as? Bool, false)
        XCTAssertEqual(data?["level"] as? Double, 0)
        XCTAssertNil(data?["listening"])
        for action: [String: Any] in [["type": "macos_vad", "sub": "status", "threshold": 0.02], ["type": "macos_vad", "sub": "start", "threshold": true], ["type": "macos_vad", "sub": "start", "threshold": -1.0]] {
            speech.handle("vad", action: action) { result.set($0) }
            XCTAssertEqual(result.get()["success"] as? Bool, false)
        }
        let stopped = expectation(description: "VAD stop completes outside the state lock")
        speech.handle("vad", action: ["type": "macos_vad", "sub": "stop"]) { reply in
            result.set(reply); stopped.fulfill()
        }
        wait(for: [stopped], timeout: 2)
        XCTAssertEqual(result.get()["success"] as? Bool, true)
        XCTAssertEqual((result.get()["data"] as? [String: Any])?["active"] as? Bool, false)
        speech.handle("vad", action: ["type": "macos_vad", "sub": "status"]) { result.set($0) }
        XCTAssertEqual(result.get()["success"] as? Bool, true)
    }
    func testEnumerateAudioDevicesReturnsArray() throws {
        // Pure helper, no daemon. Returns whatever CoreAudio
        // surfaces on the host. Empty arrays are valid (CI / no-mic
        // hosts); we assert shape, not population.
        let devices = try AudioDomain.enumerateAudioDevices(role: "input")
        // Either zero devices (acceptable on some hosts) or each entry
        // carries the documented shape.
        for d in devices {
            XCTAssertNotNil(d["uniqueID"] as? String, "missing uniqueID on device dict")
            XCTAssertNotNil(d["localizedName"] as? String, "missing localizedName")
            XCTAssertNotNil(d["deviceType"] as? String, "missing deviceType")
            XCTAssertEqual(d["role"] as? String, "input", "role tag must be passed through")
        }
    }

    func testRoleTagIsPassedThrough() throws {
        let outputs = try AudioDomain.enumerateAudioDevices(role: "output")
        for d in outputs {
            XCTAssertEqual(d["role"] as? String, "output")
        }
    }

    func testStereoPCMCopyLevelsAndClosedSavedFile() throws {
        let empty = try CapturedAudio(save: true, channel: "input")
        let emptyPath = try XCTUnwrap(empty.filePath)
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: emptyPath).deletingLastPathComponent()) }
        empty.stop()
        XCTAssertEqual(empty.snapshot()["active"] as? Bool, false)
        XCTAssertNotNil(empty.snapshot()["error"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: emptyPath))
        for interleaved in [false, true] {
            let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: interleaved))
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
            buffer.frameLength = 4
            let channels = try XCTUnwrap(buffer.floatChannelData)
            for frame in 0..<4 { channels[0][frame * buffer.stride] = 0.25; channels[1][frame * buffer.stride] = -0.75 }
            let measured = try XCTUnwrap(AudioDomain.measurePCM(buffer))
            XCTAssertEqual(try XCTUnwrap(measured["level"] as? Double), sqrt(0.3125), accuracy: 1e-6)
            XCTAssertEqual(measured["peak"] as? Double, 0.75)
            var description: CMAudioFormatDescription?
            XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription, layoutSize: 0, layout: nil,
                                                          magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description), noErr)
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            XCTAssertEqual(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
                                               formatDescription: try XCTUnwrap(description), sampleCount: 4, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                               sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample), noErr)
            let packet = try XCTUnwrap(sample)
            XCTAssertEqual(CMSampleBufferSetDataBufferFromAudioBufferList(packet, blockBufferAllocator: kCFAllocatorDefault,
                                                                         blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: buffer.audioBufferList), noErr)
            XCTAssertEqual(CMSampleBufferSetDataReady(packet), noErr)
            let copied = try XCTUnwrap(AudioStreamOutput.pcmBuffer(packet))
            let copiedChannels = try XCTUnwrap(copied.floatChannelData)
            for frame in 0..<4 {
                XCTAssertEqual(copiedChannels[0][frame * copied.stride], 0.25)
                XCTAssertEqual(copiedChannels[1][frame * copied.stride], -0.75)
            }
            let capture = try CapturedAudio(save: true, channel: "input")
            let path = try XCTUnwrap(capture.filePath), url = URL(fileURLWithPath: path)
            defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
            XCTAssertTrue(capture.append(buffer))
            capture.stop()
            XCTAssertFalse(capture.append(buffer))
            XCTAssertEqual(capture.snapshot()["active"] as? Bool, false)
            XCTAssertEqual(try AVAudioFile(forReading: url).length, 4)
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
            channels[0][0] = .nan
            XCTAssertNil(AudioDomain.measurePCM(buffer))
        }
    }
}
