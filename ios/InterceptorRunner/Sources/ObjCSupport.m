//
//  ObjCSupport.m — see ObjCSupport.h.
//
#import "ObjCSupport.h"
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
