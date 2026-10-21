//
//  ICRunnerUI.m — keep a tapped xctrunner alive and show the Connect UI.
//
//  On a cold tap the runner always opens Safari to the loopback UI, so the person
//  is always told what to do next.
//
//  Pre-main +load. Discriminant ICShouldRunAsTest() = test session OR DDI mounted
//  this boot:
//    - run-as-test (Mac launch, or warm tap): leave XCTest untouched → dial home.
//    - cold tap (no DDI): XCTest's _XCTestMain → …​sharedSession throws "Failed to
//      initiate daemon session" (no testmanagerd on-device) and the app would die.
//      We rebind exit/_exit (fishhook) and replace +[XCTRunnerDaemonSession
//      sharedSession] so the first lethal call parks the main runloop instead; the
//      process + loopback web server stay alive, and we open Safari to the UI.
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <execinfo.h>
#import <stdatomic.h>
#import <sys/sysctl.h>
#import <dlfcn.h>
#import <unistd.h>
#import "fishhook.h"

static void ICLogUI(NSString *m) {
    NSLog(@"IC-UI: %@", m);
    NSArray *dirs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    if (dirs.count == 0) return;
    NSString *path = [dirs[0] stringByAppendingPathComponent:@"ic-ui.log"];
    NSString *line = [NSString stringWithFormat:@"[%@] %@\n", [NSDate date], m];
    NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:path];
    if (h) { [h seekToEndOfFile]; [h writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [h closeFile]; }
    else { [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
}

static BOOL ICHasTestSession(void) {
    NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
    return [env[@"INTERCEPTOR_WS_URL"] length] > 0
        || [env[@"XCTestSessionIdentifier"] length] > 0
        || [env[@"XCTestConfigurationFilePath"] length] > 0
        || [env[@"XCTestBundlePath"] length] > 0;
}

static NSString *ICBootID(void) {
    struct timeval tv; size_t sz = sizeof(tv); int mib[2] = { CTL_KERN, KERN_BOOTTIME };
    if (sysctl(mib, 2, &tv, &sz, NULL, 0) != 0) return @"0";
    return [NSString stringWithFormat:@"%ld.%d", (long)tv.tv_sec, (int)tv.tv_usec];
}
static BOOL ICMountedThisBoot(void) {
    NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    if (!docs) return NO;
    NSString *saved = [NSString stringWithContentsOfFile:[docs stringByAppendingPathComponent:@"ic-boot-marker"]
                                                encoding:NSUTF8StringEncoding error:nil];
    return saved && [[saved stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] isEqualToString:ICBootID()];
}
static BOOL ICShouldRunAsTest(void) { return ICHasTestSession() || ICMountedThisBoot(); }

// Open Safari to the loopback UI, always, on a tap. Scheduled on the main queue so
// SpringBoard has brought our scene up; retried a few times in case the app isn't
// active yet. The URL carries ICWebServer.token, which POST /action requires.
static void ICOpenSafariToUI(void) {
    static atomic_bool opened = false;
    if (atomic_exchange(&opened, true)) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        Class ws = NSClassFromString(@"ICWebServer");
        NSString *token = ws ? ((NSString *(*)(id, SEL))objc_msgSend)((id)ws, NSSelectorFromString(@"token")) : nil;
        if (token.length == 0) { ICLogUI(@"no ICWebServer token; not opening Safari"); return; }
        NSURLComponents *c = [NSURLComponents componentsWithString:@"http://127.0.0.1:8723/"];
        c.queryItems = @[[NSURLQueryItem queryItemWithName:@"t" value:token]];
        NSURL *url = c.URL;
        __block void (^tryOpen)(int) = ^(int left){
            UIApplication *app = UIApplication.sharedApplication;
            if (app) {
                [app openURL:url options:@{} completionHandler:^(BOOL ok){
                    ICLogUI([NSString stringWithFormat:@"opened Safari to the UI: %d", ok]);
                }];
            } else if (left > 0) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5*NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ tryOpen(left-1); });
            }
        };
        tryOpen(20);
    });
}

// ── keep the process alive past XCTest's lethal startup (cold tap) ──────────────

// _XCTestMain teardown calls exit() from a CFRunLoop block. Returning lets XCTest
// reach a second lethal path, so on the main thread we take over the runloop in
// common modes forever: XCTest's teardown can't continue, and UIKit keeps
// compositing + servicing the web server's dispatch work.
static void ICTakeOverMainRunLoop(void) {
    while (1) { @autoreleasepool { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, true); } }
}

typedef void (*ic_exit_fn)(int);
static ic_exit_fn gRealExit = NULL;
static ic_exit_fn gRealUnderExit = NULL;
typedef int (*ic_xctestmain_fn)(void);
static ic_xctestmain_fn gRealXCTestMain = NULL;
static _Atomic(int) gTrapped = 0;

// exit/_exit must never return. The main thread takes over its runloop; any other
// thread parks for good.
static void ICParkForever(void) {
    if ([NSThread isMainThread]) ICTakeOverMainRunLoop();
    for (;;) pause();
}

static void ic_exit(int code) {
    if (atomic_exchange(&gTrapped, 1) == 0) {
        ICLogUI([NSString stringWithFormat:@"TRAPPED exit(%d) → parking the caller", code]);
        ICParkForever();
    }
    if (gRealExit) gRealExit(code);
    __builtin_trap();
}
static void ic_under_exit(int code) {
    if (atomic_exchange(&gTrapped, 1) == 0) {
        ICLogUI([NSString stringWithFormat:@"TRAPPED _exit(%d) → parking the caller", code]);
        ICParkForever();
    }
    if (gRealUnderExit) gRealUnderExit(code);
    __builtin_trap();
}
static int ic_xctestmain(void) {
    ICLogUI(@"_XCTestMain intercepted (cold tap) → not starting the test driver");
    ICTakeOverMainRunLoop();
    return 0;
}

@interface ICRunnerUI : NSObject
@end

@implementation ICRunnerUI

static IMP gOrigWillConnect = NULL;

+ (void)installTapModeGuards:(Class)cls {
    // XCTest's own launch work: skip on a cold tap (it opens testmanagerd / backgrounds us).
    SEL launch = @selector(application:didFinishLaunchingWithOptions:);
    Method lm = class_getInstanceMethod(cls, launch);
    if (lm) {
        IMP r = imp_implementationWithBlock(^BOOL(id s, UIApplication *app, NSDictionary *opts) {
            ICLogUI(@"didFinishLaunching: cold tap → XCTest driver NOT started");
            return YES;
        });
        method_setImplementation(lm, r);
        ICLogUI(@"guarded application:didFinishLaunchingWithOptions:");
    }
    SEL bg = NSSelectorFromString(@"runTestsInBackground:");
    Method bm = class_getInstanceMethod(cls, bg);
    if (bm) {
        method_setImplementation(bm, imp_implementationWithBlock(^(id s, id arg){ ICLogUI(@"runTestsInBackground: cold tap → skipped"); }));
        ICLogUI(@"guarded runTestsInBackground:");
    }
}

+ (void)load {
    // Warm/Mac → the real runner. Leave XCTest alone; it dials home.
    if (ICShouldRunAsTest()) { ICLogUI(@"run-as-test → XCTest untouched, dial home"); return; }

    // Rebind exit/_exit/_XCTestMain so the test-driver startup can't kill us.
    gRealExit = (ic_exit_fn)dlsym(RTLD_DEFAULT, "exit");
    gRealUnderExit = (ic_exit_fn)dlsym(RTLD_DEFAULT, "_exit");
    struct rebinding rb[] = {
        {"exit", (void *)ic_exit, (void **)&gRealExit},
        {"_exit", (void *)ic_under_exit, (void **)&gRealUnderExit},
        {"_XCTestMain", (void *)ic_xctestmain, (void **)&gRealXCTestMain},
    };
    rebind_symbols(rb, 3);
    ICLogUI(@"rebound exit/_exit/_XCTestMain for cold tap");

    if (![NSBundle.mainBundle.infoDictionary[@"ICFullApp"] boolValue]
        && ![[NSBundle bundleForClass:self].infoDictionary[@"ICFullApp"] boolValue]) return;

    Class cls = NSClassFromString(@"_XCTRunnerAppDelegate");
    if (!cls) { ICLogUI(@"_XCTRunnerAppDelegate not found"); ICOpenSafariToUI(); return; }
    [self installTapModeGuards:cls];

    // The device throw is in +[XCTRunnerDaemonSession sharedSession] (no testmanagerd).
    // Replace it: on a tap, park the main thread so nothing throws.
    Class sessCls = NSClassFromString(@"XCTRunnerDaemonSession");
    Method sm = sessCls ? class_getClassMethod(sessCls, NSSelectorFromString(@"sharedSession")) : NULL;
    if (sm) {
        method_setImplementation(sm, imp_implementationWithBlock(^id(id c){
            ICLogUI(@"+[XCTRunnerDaemonSession sharedSession] intercepted (cold tap) → serving UI");
            ICOpenSafariToUI();
            if ([NSThread isMainThread]) ICTakeOverMainRunLoop();
            return nil;
        }));
        ICLogUI(@"guarded +[XCTRunnerDaemonSession sharedSession]");
    }

    // Also open Safari when the scene connects (belt-and-braces for the open).
    SEL sel = @selector(scene:willConnectToSession:options:);
    Method m = class_getInstanceMethod(cls, sel);
    if (m) {
        IMP repl = imp_implementationWithBlock(^(id s, UIScene *scene, id session, id options){
            ICLogUI(@"scene willConnect (cold tap) → opening Safari to the UI");
            ICOpenSafariToUI();
        });
        gOrigWillConnect = method_setImplementation(m, repl);
        ICLogUI(@"swizzled scene:willConnectToSession:options:");
    }
    (void)gOrigWillConnect;
    // Open now too, in case neither hook fires promptly.
    ICOpenSafariToUI();
}

@end

// fishhook (BSD, Facebook) is compiled into this TU (xcodegen does not add a bare .c to the
// ui-testing target). Do NOT also add fishhook.c to the target → duplicate symbols.
#include "fishhook.c"
