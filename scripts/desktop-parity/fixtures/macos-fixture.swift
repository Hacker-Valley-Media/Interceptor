// Owned macOS parity fixture. An accessory app (no Dock icon) whose windows
// are ordered to the back, so it never takes focus on a shared Mac. State changes are
// written to <statusDir>/state.json. Build: launch.ts compiles it into
// InterceptorParityFixture.app. Usage: InterceptorParityFixture <statusDir>
import AppKit

let statusDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory()
var state: [String: Any] = ["input": "", "result": "Not submitted", "menu": "unchanged", "checkbox": false, "combo": "", "scroll": "unchanged", "drag": "unchanged", "keys": [String](), "clicks": 0]
func save() {
    if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to: URL(fileURLWithPath: statusDir + "/state.json")) }
}

final class Input: NSTextField {}
final class DragPad: NSView {
    var start: NSPoint?
    override func mouseDown(with event: NSEvent) { start = convert(event.locationInWindow, from: nil) }
    override func mouseUp(with event: NSEvent) {
        guard let s = start else { return }
        let e = convert(event.locationInWindow, from: nil)
        state["drag"] = "\(Int(s.x)),\(Int(s.y))->\(Int(e.x)),\(Int(e.y))"; save(); start = nil
    }
}
final class Fixture: NSObject, NSTextFieldDelegate {
    let input = Input(frame: NSRect(x: 20, y: 700, width: 500, height: 26))
    let result = NSTextField(labelWithString: "Not submitted")
    let check = NSButton(checkboxWithTitle: "Fixture checkbox", target: nil, action: nil)
    let combo = NSPopUpButton(frame: NSRect(x: 20, y: 470, width: 200, height: 26))
    let menuStatus = NSTextField(labelWithString: "Menu fixture unchanged")
    @objc func submit(_ sender: Any?) { result.stringValue = "Submitted: " + input.stringValue; state["result"] = result.stringValue; state["clicks"] = (state["clicks"] as? Int ?? 0) + 1; save() }
    @objc func toggled(_ sender: Any?) { state["checkbox"] = check.state == .on; save() }
    @objc func picked(_ sender: Any?) { state["combo"] = combo.titleOfSelectedItem ?? ""; save() }
    @objc func mark(_ sender: Any?) { menuStatus.stringValue = "Menu fixture invoked"; state["menu"] = "invoked"; save() }
    @objc func scrolled(_ note: Notification) { if let clip = note.object as? NSClipView { state["scroll"] = "offset \(Int(clip.bounds.origin.y))"; save() } }
    func controlTextDidChange(_ obj: Notification) { state["input"] = input.stringValue; save() }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let fx = Fixture()
let mainMenu = NSMenu(), fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: ""), fileMenu = NSMenu(title: "File")
let markItem = NSMenuItem(title: "Mark fixture", action: #selector(Fixture.mark(_:)), keyEquivalent: ""); markItem.target = fx
fileMenu.addItem(markItem); fileItem.submenu = fileMenu; mainMenu.addItem(fileItem); app.mainMenu = mainMenu

let window = NSWindow(contentRect: NSRect(x: 60, y: 80, width: 560, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "Interceptor Parity Fixture"
let view = window.contentView!
func add(_ v: NSView, _ name: String, _ frame: NSRect) { v.frame = frame; v.setAccessibilityLabel(name); view.addSubview(v) }
fx.input.delegate = fx
add(fx.input, "Fixture input", NSRect(x: 20, y: 720, width: 500, height: 26))
let submit = NSButton(title: "Submit fixture", target: fx, action: #selector(Fixture.submit(_:)))
add(submit, "Submit fixture", NSRect(x: 20, y: 684, width: 180, height: 30))
add(fx.result, "Fixture result", NSRect(x: 20, y: 652, width: 500, height: 24))
let password = NSSecureTextField(); password.stringValue = "PARITY-SYNTHETIC-SECRET"
add(password, "Fixture password", NSRect(x: 20, y: 618, width: 500, height: 26))
let readonly = NSTextField(); readonly.stringValue = "UNCHANGED READ ONLY"; readonly.isEditable = false
add(readonly, "Read-only fixture input", NSRect(x: 20, y: 584, width: 500, height: 26))
let disabled = NSTextField(); disabled.stringValue = "UNCHANGED DISABLED"; disabled.isEnabled = false
add(disabled, "Disabled fixture input", NSRect(x: 20, y: 550, width: 500, height: 26))
let disabledButton = NSButton(title: "Disabled fixture button", target: nil, action: nil); disabledButton.isEnabled = false
add(disabledButton, "Disabled fixture button", NSRect(x: 20, y: 514, width: 240, height: 30))
fx.check.target = fx; fx.check.action = #selector(Fixture.toggled(_:))
add(fx.check, "Fixture checkbox", NSRect(x: 20, y: 486, width: 240, height: 22))
fx.combo.addItems(withTitles: ["One", "Two", "Three"]); fx.combo.target = fx; fx.combo.action = #selector(Fixture.picked(_:))
add(fx.combo, "Fixture combo", NSRect(x: 20, y: 452, width: 200, height: 26))
let selected = NSTextView(); selected.isEditable = false; selected.string = "Before Selected 🙂 文件 After"
add(selected, "Selection fixture input", NSRect(x: 20, y: 396, width: 500, height: 48))
selected.setSelectedRange(NSRange(location: 7, length: 14))
let scroll = NSScrollView(frame: NSRect(x: 20, y: 270, width: 500, height: 110)); scroll.hasVerticalScroller = true
let scrollText = NSTextView(frame: NSRect(x: 0, y: 0, width: 480, height: 3000)); scrollText.isEditable = false
scrollText.string = (0..<200).map { "Scroll fixture line \($0)" }.joined(separator: "\n")
scrollText.setAccessibilityLabel("Scroll fixture input")
scroll.documentView = scrollText; scroll.contentView.postsBoundsChangedNotifications = true
NotificationCenter.default.addObserver(fx, selector: #selector(Fixture.scrolled(_:)), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
view.addSubview(scroll)
let pad = DragPad(); pad.wantsLayer = true; pad.layer?.backgroundColor = NSColor.systemTeal.cgColor
pad.setAccessibilityElement(true); pad.setAccessibilityRole(.group)
add(pad, "Drag fixture", NSRect(x: 20, y: 140, width: 500, height: 110))
add(fx.menuStatus, "Menu fixture status", NSRect(x: 20, y: 108, width: 500, height: 24))
let list = NSTextField(labelWithString: "Alpha Beta Gamma")
add(list, "Fixture list", NSRect(x: 20, y: 70, width: 500, height: 24))
// The text field editor swallows keyDown, so record keys for the fixture window with a local monitor.
NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
    if event.window === window {
        var keys = state["keys"] as? [String] ?? []
        keys.append((event.modifierFlags.contains(.control) ? "Ctrl+" : "") + (event.modifierFlags.contains(.shift) ? "Shift+" : "") + (event.charactersIgnoringModifiers ?? ""))
        state["keys"] = keys; save()
    }
    return event
}
window.orderBack(nil)

let observer = NSWindow(contentRect: NSRect(x: 660, y: 300, width: 360, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
observer.title = "Interceptor Parity Observer"
let note = NSTextField(labelWithString: "This window stays behind; the person's app keeps focus.")
note.frame = NSRect(x: 20, y: 60, width: 320, height: 40); note.setAccessibilityLabel("Observer focus")
observer.contentView!.addSubview(note)
observer.orderBack(nil)
// controlTextDidChange fires only for field-editor edits; an AX value set while the field is not being
// edited (e.g. after Shift+Tab) changes stringValue silently. Sync it so state.json sees every write.
Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    if state["input"] as? String != fx.input.stringValue { state["input"] = fx.input.stringValue; save() }
}
save()
app.run()
