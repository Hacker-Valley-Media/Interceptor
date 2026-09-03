//
//  ObjCSupport.h — Obj-C helpers the Swift runner can't express natively.
//
//  XCUITest APIs (snapshot/activate/tap on a misbehaving app) raise Obj-C
//  NSExceptions, which crash a pure-Swift test. ICRunCatching wraps a block in
//  @try/@catch so the runner turns a failed verb into an error frame instead of
//  tearing down the whole XCUITest session.
//
#import <Foundation/Foundation.h>

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

NS_ASSUME_NONNULL_END
