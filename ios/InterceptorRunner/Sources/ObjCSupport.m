//
//  ObjCSupport.m — see ObjCSupport.h.
//
#import "ObjCSupport.h"
#import <UIKit/UIKit.h>
#import <XCTest/XCTest.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <notify.h>

NSError * _Nullable ICRunCatching(void (^block)(void)) {
    @try {
        block();
        return nil;
    }
    @catch (NSException *exception) {
        NSString *message = exception.reason ?: exception.name ?: @"XCUITest exception";
        return [NSError errorWithDomain:@"InterceptorRunner"
                                   code:1
                               userInfo:@{ NSLocalizedDescriptionKey: message }];
    }
}

// ── foreground app detection (private XCTest accessibility client) ────────────
//
// Path confirmed on iOS 26 / Xcode 26:
//   [XCUIDevice sharedDevice].accessibilityInterface  → XCAXClient_iOS
//        -activeForegroundApplications                → [XCAccessibilityElement] (pid each)
//   [XCUIDevice sharedDevice].applicationMonitor      → XCUIApplicationMonitor
//        -applicationProcessWithPID:                  → XCUIApplicationProcess (.bundleID, .foreground)

static id ICCall(id obj, NSString *selName) {
    if (!obj) return nil;
    SEL sel = NSSelectorFromString(selName);
    if (![obj respondsToSelector:sel]) return nil;
    return ((id(*)(id, SEL))objc_msgSend)(obj, sel);
}

static id ICSharedDevice(void) {
    Class devCls = NSClassFromString(@"XCUIDevice");
    if (!devCls) return nil;
    return ((id(*)(id, SEL))objc_msgSend)((id)devCls, NSSelectorFromString(@"sharedDevice"));
}

/// Scan a collection of XCUIApplicationProcess for the foreground app's bundle id
/// (excluding SpringBoard and our own runner). Returns the foreground one, else the
/// only candidate.
static NSString *ICForegroundFromProcs(id collection) {
    NSArray *procs = nil;
    if ([collection isKindOfClass:NSDictionary.class]) procs = [(NSDictionary *)collection allValues];
    else if ([collection conformsToProtocol:@protocol(NSFastEnumeration)]) procs = collection;
    if (!procs) return nil;
    SEL fgSel = NSSelectorFromString(@"foreground");
    NSString *fallback = nil;
    for (id proc in procs) {
        id bid = ICCall(proc, @"bundleID");
        if (![bid isKindOfClass:NSString.class] || [(NSString *)bid length] == 0) continue;
        if ([bid isEqualToString:@"com.apple.springboard"]) continue;
        if ([bid hasPrefix:@"com.interceptor.InterceptorRunner"]) continue;
        BOOL fg = [proc respondsToSelector:fgSel] ? ((BOOL(*)(id, SEL))objc_msgSend)(proc, fgSel) : NO;
        if (fg) return (NSString *)bid;
        if (!fallback) fallback = (NSString *)bid;
    }
    return fallback;
}

NSString * _Nullable ICActiveApplicationBundleID(void) {
    id dev = ICSharedDevice();
    if (!dev) return nil;
    id axClient = ICCall(dev, @"accessibilityInterface");
    id monitor = ICCall(dev, @"applicationMonitor");
    if (!monitor) return nil;

    SEL pidSel = NSSelectorFromString(@"processIdentifier");
    SEL procSel = NSSelectorFromString(@"applicationProcessWithPID:");
    if (![monitor respondsToSelector:procSel]) return nil;

    for (int attempt = 0; attempt < 5; attempt++) {
        // Warm-up: querying activeForegroundApplications first makes the AX client
        // populate activeApplications (its elements carry usable pids). Observed on
        // iOS 26 — without this, activeApplications returns empty.
        (void)ICCall(axClient, @"activeForegroundApplications");
        id apps = ICCall(axClient, @"activeApplications");
        if ([apps conformsToProtocol:@protocol(NSFastEnumeration)]) {
            NSMutableArray *procs = [NSMutableArray array];
            for (id el in (id<NSFastEnumeration>)apps) {
                if (![el respondsToSelector:pidSel]) continue;
                pid_t pid = ((pid_t(*)(id, SEL))objc_msgSend)(el, pidSel);
                if (pid <= 0) continue;
                id proc = ((id(*)(id, SEL, pid_t))objc_msgSend)(monitor, procSel, pid);
                if (proc) [procs addObject:proc];
            }
            NSString *bid = ICForegroundFromProcs(procs);
            if (bid) return bid;
        }
        usleep(100000); // 100ms
    }
    return nil;
}

static NSString *ICMethodsMatching(Class cls, NSArray<NSString *> *needles) {
    if (!cls) return @"";
    NSMutableArray *hits = [NSMutableArray array];
    unsigned int n = 0;
    Method *methods = class_copyMethodList(cls, &n);
    for (unsigned i = 0; i < n; i++) {
        NSString *name = NSStringFromSelector(method_getName(methods[i]));
        NSString *lower = name.lowercaseString;
        for (NSString *needle in needles) {
            if ([lower containsString:needle]) { [hits addObject:name]; break; }
        }
    }
    free(methods);
    return [hits componentsJoinedByString:@","];
}

NSString * _Nullable ICActiveApplicationDebug(void) {
    id dev = ICSharedDevice();
    id monitor = ICCall(dev, @"applicationMonitor");
    if (!monitor) return @"no monitor";
    id launched = ICCall(monitor, @"launchedApplications");
    NSArray *procs = nil;
    if ([launched isKindOfClass:NSDictionary.class]) procs = [(NSDictionary *)launched allValues];
    else if ([launched conformsToProtocol:@protocol(NSFastEnumeration)]) procs = launched;
    SEL fgSel = NSSelectorFromString(@"foreground");
    NSMutableString *out = [NSMutableString stringWithFormat:@"launched(cls=%@,n=%lu): ",
                            NSStringFromClass([launched class]), (unsigned long)(procs ? procs.count : 0)];
    for (id proc in (procs ?: @[])) {
        id bid = ICCall(proc, @"bundleID");
        BOOL fg = [proc respondsToSelector:fgSel] ? ((BOOL(*)(id, SEL))objc_msgSend)(proc, fgSel) : NO;
        [out appendFormat:@"{%@ fg=%d}", bid ?: @"nil", fg];
    }
    return out;
}

// ── issue #244: lock state + hardware button events ──────────────────────────────

BOOL ICIsScreenLocked(void) {
    int token = 0;
    if (notify_register_check("com.apple.springboard.lockstate", &token) != NOTIFY_STATUS_OK) return NO;
    uint64_t state = 0;
    notify_get_state(token, &state);
    notify_cancel(token);
    return state != 0;
}

static NSError *ICEventError(NSString *message) {
    return [NSError errorWithDomain:@"InterceptorRunner" code:2 userInfo:@{ NSLocalizedDescriptionKey: message }];
}

NSError * _Nullable ICPerformDeviceEvent(unsigned int page, unsigned int usage, double duration) {
    Class eventClass = NSClassFromString(@"XCDeviceEvent");
    id device = ICSharedDevice();
    if (!eventClass || !device) return ICEventError(@"XCDeviceEvent is unavailable in this XCTest");
    SEL make = NSSelectorFromString(@"deviceEventWithPage:usage:duration:");
    if (![eventClass respondsToSelector:make]) return ICEventError(@"XCDeviceEvent lacks deviceEventWithPage:usage:duration:");
    id event = ((id(*)(id, SEL, unsigned int, unsigned int, double))objc_msgSend)((id)eventClass, make, page, usage, duration);
    if (!event) return ICEventError(@"XCDeviceEvent could not be created");
    SEL perform = NSSelectorFromString(@"performDeviceEvent:error:");
    if (![device respondsToSelector:perform]) return ICEventError(@"XCUIDevice lacks performDeviceEvent:error:");
    NSError *error = nil;
    BOOL ok = ((BOOL(*)(id, SEL, id, NSError **))objc_msgSend)(device, perform, event, &error);
    if (!ok) return error ?: ICEventError(@"performDeviceEvent failed");
    return nil;
}

// ── multi-touch synthesis (private XCSynthesizedEventRecord) ─────────────────
//
// One record, one XCPointerEventPath per finger, absolute time offsets, dispatched
// through the record's own synthesizeWithError:. Selectors are looked up by name
// and verified before use so an SDK that drops one produces a named error.

static NSError *ICGestureError(NSString *message) {
    return [NSError errorWithDomain:@"InterceptorRunner" code:3 userInfo:@{ NSLocalizedDescriptionKey: message }];
}

long long ICApplicationInterfaceOrientation(id application) {
    SEL sel = NSSelectorFromString(@"interfaceOrientation");
    if (![application respondsToSelector:sel]) return 0;
    return ((long long(*)(id, SEL))objc_msgSend)(application, sel);
}

NSError * _Nullable ICSynthesizeGesture(NSArray<NSArray<NSDictionary<NSString *, NSNumber *> *> *> *paths, id application, long long orientation) {
    Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
    Class pathClass = NSClassFromString(@"XCPointerEventPath");
    if (!recordClass || !pathClass) {
        return ICGestureError(@"multi-touch unavailable: XCSynthesizedEventRecord or XCPointerEventPath is missing from this XCTest");
    }
    SEL initRecord = NSSelectorFromString(@"initWithName:interfaceOrientation:");
    SEL initPath = NSSelectorFromString(@"initForTouchAtPoint:offset:");
    SEL move = NSSelectorFromString(@"moveToPoint:atOffset:");
    SEL lift = NSSelectorFromString(@"liftUpAtOffset:");
    SEL addPath = NSSelectorFromString(@"addPointerEventPath:");
    SEL synthesize = NSSelectorFromString(@"synthesizeWithError:");
    struct { Class cls; SEL sel; NSString *name; } required[] = {
        { recordClass, initRecord, @"initWithName:interfaceOrientation:" },
        { pathClass, initPath, @"initForTouchAtPoint:offset:" },
        { pathClass, move, @"moveToPoint:atOffset:" },
        { pathClass, lift, @"liftUpAtOffset:" },
        { recordClass, addPath, @"addPointerEventPath:" },
        { recordClass, synthesize, @"synthesizeWithError:" },
    };
    for (size_t i = 0; i < sizeof(required) / sizeof(required[0]); i++) {
        if (![required[i].cls instancesRespondToSelector:required[i].sel]) {
            return ICGestureError([NSString stringWithFormat:@"multi-touch unavailable: %@ lacks %@",
                                   NSStringFromClass(required[i].cls), required[i].name]);
        }
    }

    // The target pid comes from the foreground XCUIApplication when a private
    // accessor exists (no target otherwise). Live finding on a landscape game: the
    // record delivers touches in portrait screen space whatever orientation it is
    // built with, so the caller passes portrait points and the record is built
    // with the orientation it asks for.
    id record = ((id(*)(id, SEL, id, long long))objc_msgSend)([recordClass alloc], initRecord, @"interceptor-gesture", orientation);
    if (!record) return ICGestureError(@"multi-touch: could not create the event record");
    SEL setTarget = NSSelectorFromString(@"setTargetProcessID:");
    for (NSString *pidName in @[@"processID", @"processIdentifier"]) {
        SEL pidSel = NSSelectorFromString(pidName);
        if (![application respondsToSelector:pidSel] || ![record respondsToSelector:setTarget]) continue;
        long long pid = ((long long(*)(id, SEL))objc_msgSend)(application, pidSel);
        if (pid > 0) { ((void(*)(id, SEL, long long))objc_msgSend)(record, setTarget, pid); break; }
    }

    for (NSArray<NSDictionary<NSString *, NSNumber *> *> *samples in paths) {
        NSDictionary<NSString *, NSNumber *> *first = samples.firstObject;
        if (!first) return ICGestureError(@"multi-touch: a finger has no samples");
        CGPoint start = CGPointMake(first[@"x"].doubleValue, first[@"y"].doubleValue);
        id path = ((id(*)(id, SEL, CGPoint, double))objc_msgSend)([pathClass alloc], initPath, start, first[@"t"].doubleValue);
        if (!path) return ICGestureError(@"multi-touch: could not create a pointer path");
        for (NSUInteger i = 1; i < samples.count; i++) {
            NSDictionary<NSString *, NSNumber *> *s = samples[i];
            ((void(*)(id, SEL, CGPoint, double))objc_msgSend)(path, move, CGPointMake(s[@"x"].doubleValue, s[@"y"].doubleValue), s[@"t"].doubleValue);
        }
        ((void(*)(id, SEL, double))objc_msgSend)(path, lift, samples.lastObject[@"t"].doubleValue);
        ((void(*)(id, SEL, id))objc_msgSend)(record, addPath, path);
    }

    NSError *error = nil;
    BOOL ok = ((BOOL(*)(id, SEL, NSError **))objc_msgSend)(record, synthesize, &error);
    if (!ok) return error ?: ICGestureError(@"multi-touch: synthesizeWithError: returned false");
    return nil;
}

// ── frame capture for the stream loop ────────────────────────────────────────
//
// Lives here rather than in Swift because the Xcode 26 SDK marks XCUIScreen and
// XCUIScreenshot @MainActor; the stream loop runs on a background queue so verbs
// keep dispatching on the main thread while frames flow. That mark is Swift-side
// isolation: the screenshot is a synchronous proxy round trip that runs on any
// thread, and this loop has captured thousands of frames from its own queue while
// click, tree, and gesture verbs ran on main. Dispatching each 100 to 500 ms
// capture to main would hold the main thread most of the time and starve them.

NSData * _Nullable ICCaptureScreenJPEG(double scale, double quality, CGSize * _Nullable outPixels, double * _Nullable captureMs, double * _Nullable encodeMs) {
    CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
    UIImage *image = [[XCUIScreen mainScreen] screenshot].image;
    CFAbsoluteTime t1 = CFAbsoluteTimeGetCurrent();
    if (!image) return nil;
    CGSize px = CGSizeMake(round(image.size.width * image.scale * scale), round(image.size.height * image.scale * scale));
    if (px.width < 1 || px.height < 1) return nil;
    UIGraphicsImageRendererFormat *format = [[UIGraphicsImageRendererFormat alloc] init];
    format.scale = 1;   // pixels, not points: the bitmap is exactly `px`
    format.opaque = YES;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:px format:format];
    NSData *jpeg = [renderer JPEGDataWithCompressionQuality:quality actions:^(UIGraphicsImageRendererContext * _Nonnull ctx) {
        [image drawInRect:CGRectMake(0, 0, px.width, px.height)];
    }];
    CFAbsoluteTime t2 = CFAbsoluteTimeGetCurrent();
    if (outPixels) *outPixels = px;
    if (captureMs) *captureMs = (t1 - t0) * 1000.0;
    if (encodeMs) *encodeMs = (t2 - t1) * 1000.0;
    return jpeg;
}
