import XCTest
import CoreGraphics
@testable import interceptor_bridge

// Window choice and focus planning for window-addressed input. Both are pure
// decisions over a window list, so no live window server is needed.
final class BackgroundInputTests: XCTestCase {
    // Front to back, like CGWindowListCopyWindowInfo(.optionOnScreenOnly).
    // Two maximized browser windows share one frame; the user's is in front.
    private let windows: [WindowInfo] = [
        WindowInfo(id: 10, pid: 100, bounds: CGRect(x: 0, y: 30, width: 1728, height: 1011), title: "Editor"),
        WindowInfo(id: 21, pid: 200, bounds: CGRect(x: 0, y: 30, width: 1728, height: 1011), title: "Inbox"),
        WindowInfo(id: 22, pid: 200, bounds: CGRect(x: 0, y: 30, width: 1728, height: 1011), title: "Flow project"),
        WindowInfo(id: 31, pid: 300, bounds: CGRect(x: 60, y: 118, width: 520, height: 452), title: "A"),
        WindowInfo(id: 32, pid: 300, bounds: CGRect(x: 340, y: 348, width: 300, height: 252), title: "B"),
    ]

    private func pick(pid: pid_t? = nil, _ request: WindowRequest = WindowRequest(), point: CGPoint? = nil) -> WindowPick? {
        BackgroundInput.pick(from: windows, pid: pid, request: request, point: point)
    }

    private func problem(_ pick: WindowPick?) -> String? {
        if case .problem(let message)? = pick { return message }
        return nil
    }

    func testNamedWindowWinsEvenWhenASiblingCoversThePoint() {
        // (450, 450) is inside both pid-300 windows; 31 is in front.
        XCTAssertEqual(pick(pid: 300, WindowRequest(windowID: 32), point: CGPoint(x: 450, y: 450)), .found(windows[4]))
        XCTAssertEqual(pick(pid: 300, point: CGPoint(x: 450, y: 450)), .found(windows[3]))
    }

    func testNamedWindowNeedsNoPid() {
        XCTAssertEqual(pick(WindowRequest(windowID: 22)), .found(windows[2]))
    }

    func testNamedWindowThatIsNotOnScreenIsRefused() {
        let message = problem(pick(pid: 300, WindowRequest(windowID: 99)))
        XCTAssertEqual(message?.contains("window 99 is not on screen"), true)
        XCTAssertEqual(message?.hasSuffix("(nothing was delivered)"), true)
    }

    func testNamedWindowOwnedByAnotherAppIsRefused() {
        XCTAssertEqual(problem(pick(pid: 300, WindowRequest(windowID: 21)))?.contains("belongs to pid 200"), true)
    }

    func testPointOutsideEveryWindowOfTheAppIsRefused() {
        let message = problem(pick(pid: 300, point: CGPoint(x: 1500, y: 900)))
        XCTAssertEqual(message?.contains("no on-screen window under (1500, 900)"), true)
        XCTAssertEqual(message?.hasSuffix("(nothing was delivered)"), true)
    }

    func testAppWithNoOnScreenWindowIsRefusedForAPointAndNilForKeys() {
        XCTAssertNotNil(problem(pick(pid: 999, point: CGPoint(x: 10, y: 40))))
        XCTAssertNil(pick(pid: 999))
    }

    func testKeysWithoutAPointTakeTheAppsFrontmostWindow() {
        XCTAssertEqual(pick(pid: 200), .found(windows[1]))
    }

    func testNothingToAddressWithoutPidOrWindow() {
        XCTAssertNil(pick(point: CGPoint(x: 10, y: 40)))
    }

    func testBrowserWindowIsMatchedByFrameAndTitleAcrossSharedFrames() {
        // Three windows share this frame, in two apps; the title picks one.
        let frame = CGRect(x: 0, y: 30, width: 1728, height: 1011)
        XCTAssertEqual(pick(WindowRequest(title: "Flow project", bounds: frame)), .found(windows[2]))
        // chrome.windows bounds can differ from the Quartz frame by a pixel.
        XCTAssertEqual(pick(WindowRequest(title: "Inbox", bounds: frame.offsetBy(dx: 1, dy: -1))), .found(windows[1]))
        // A title the window name starts with (browser appends its own suffix).
        XCTAssertEqual(pick(WindowRequest(title: "Flow", bounds: frame)), .found(windows[2]))
    }

    func testBrowserWindowWithNoMatchOrAnAmbiguousMatchIsRefused() {
        let frame = CGRect(x: 0, y: 30, width: 1728, height: 1011)
        XCTAssertEqual(problem(pick(WindowRequest(title: "Gone", bounds: frame)))?.contains("no on-screen window matches"), true)
        // No title to tell three same-frame windows apart.
        XCTAssertEqual(problem(pick(WindowRequest(title: "", bounds: frame)))?.contains("3 on-screen windows share"), true)
        XCTAssertEqual(problem(pick(WindowRequest(title: "A", bounds: CGRect(x: 5, y: 5, width: 9, height: 9))))?.contains("no on-screen window matches"), true)
    }

    func testPanelAboveTheNormalLayerIsUsedOnlyWhenNoNormalWindowIsThere() {
        // An overlay of the app sits in front of its window; a panel sits beside it.
        let list = [
            WindowInfo(id: 40, pid: 400, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), title: "overlay", layer: 25),
            WindowInfo(id: 41, pid: 400, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Doc"),
            WindowInfo(id: 42, pid: 400, bounds: CGRect(x: 900, y: 0, width: 200, height: 300), title: "Inspector", layer: 3),
        ]
        XCTAssertEqual(BackgroundInput.pick(from: list, pid: 400, request: WindowRequest(), point: CGPoint(x: 100, y: 100)), .found(list[1]))
        XCTAssertEqual(BackgroundInput.pick(from: list, pid: 400, request: WindowRequest(), point: CGPoint(x: 950, y: 50)), .found(list[2]))
        // Keys go to a normal window, not the overlay in front of it.
        XCTAssertEqual(BackgroundInput.pick(from: list, pid: 400, request: WindowRequest(), point: nil), .found(list[1]))
        // A browser tab is never matched to a panel that happens to share its frame.
        XCTAssertEqual(BackgroundInput.pick(from: list, pid: nil, request: WindowRequest(title: "", bounds: CGRect(x: 0, y: 0, width: 800, height: 600)), point: nil), .found(list[1]))
    }

    func testFocusPlan() {
        // Target app in the background: tell both processes, restore after.
        XCTAssertEqual(FocusPlan.decide(targetIsFrontProcess: false, target: 22, frontAppKeyWindow: nil), .crossApp)
        // Target is another window of the frontmost app: hand the key window back.
        XCTAssertEqual(FocusPlan.decide(targetIsFrontProcess: true, target: 22, frontAppKeyWindow: 21), .sameApp(keyWindow: 21))
        // Target already is the frontmost app's key window: stamps only.
        XCTAssertEqual(FocusPlan.decide(targetIsFrontProcess: true, target: 21, frontAppKeyWindow: 21), .none)
        XCTAssertEqual(FocusPlan.decide(targetIsFrontProcess: true, target: 21, frontAppKeyWindow: nil), .none)
    }
}
