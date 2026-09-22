//
//  ObjCSupport.h — Obj-C helpers the Swift runner can't express natively.
//
//  XCUITest APIs (snapshot/activate/tap on a misbehaving app) raise Obj-C
//  NSExceptions, which crash a pure-Swift test. ICRunCatching wraps a block in
//  @try/@catch so the runner turns a failed verb into an error frame instead of
//  tearing down the whole XCUITest session.
//
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

/// Run `block` inside @try/@catch. Returns nil on success, or an NSError wrapping
/// the raised NSException (name + reason) on failure.
NSError * _Nullable ICRunCatching(void (^block)(void));

/// Bundle id of the current FOREGROUND app via the private XCTest accessibility
/// client (so `tree`/`find` work without an explicit `app activate`). nil if it
/// can't be determined (caller falls back to SpringBoard).
NSString * _Nullable ICActiveApplicationBundleID(void);

/// Diagnostic: describe the active-application elements (class + accessors) so the
/// right bundle-id accessor can be confirmed on-device.
NSString * _Nullable ICActiveApplicationDebug(void);

/// issue #244: is the device locked? Reads the com.apple.springboard.lockstate
/// Darwin notification state (non-zero while locked).
BOOL ICIsScreenLocked(void);

/// issue #244: press a hardware button through XCTest's private XCDeviceEvent
/// (HID usage page + usage, hold duration in seconds). Used for the lock
/// button on iOS 27, where -[XCUIDevice pressLockButton] no longer locks
/// (WebDriverAgent takes the same path: page 0x0C, usage 0x30, 0.5 s).
/// Returns nil on success or an NSError describing the failure.
NSError * _Nullable ICPerformDeviceEvent(unsigned int page, unsigned int usage, double duration);

/// Multi-touch synthesis through XCTest's private XCSynthesizedEventRecord (the
/// route WebDriverAgent and agent-device use; public XCUITest has no API for two
/// independent contacts). `paths` holds one finger per element; a finger is an
/// array of samples with keys x, y, t (t in seconds from the record start), in
/// PORTRAIT screen points (the record ignores the app's rotation; the caller maps). The
/// first sample presses, later samples move, the last sample's time lifts. Every
/// private selector is resolved by name and checked, so a missing symbol returns
/// an NSError naming it instead of crashing the session. nil once synthesized.
/// The foreground XCUIApplication's private `interfaceOrientation` (UIInterfaceOrientation
/// raw value: 1 portrait, 2 upside down, 3 landscape left, 4 landscape right), or 0
/// when the accessor is missing.
long long ICApplicationInterfaceOrientation(id application);

NSError * _Nullable ICSynthesizeGesture(NSArray<NSArray<NSDictionary<NSString *, NSNumber *> *> *> *paths, id application, long long orientation);

/// Capture the main screen as a JPEG scaled by `scale` (0.1 to 1.0 of the pixel
/// size) at `quality` (0.0 to 1.0). Safe off the main thread, so the stream loop
/// never blocks verb dispatch. Reports the frame size in pixels and the capture
/// and encode times in milliseconds. nil when capture failed.
NSData * _Nullable ICCaptureScreenJPEG(double scale, double quality, CGSize * _Nullable outPixels, double * _Nullable captureMs, double * _Nullable encodeMs);

NS_ASSUME_NONNULL_END
