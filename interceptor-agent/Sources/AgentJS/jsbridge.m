// AgentJS — JavaScriptCore ⇄ Objective-C runtime bridge. See AgentJS.h.
//
// Exposes to JS a tiny native surface that, composed in the prelude, becomes a
// general `ObjC` object:
//   ObjC.cls(name)                       -> a Class
//   ObjC.msg(receiver, "sel:with:", ...) -> invoke ANY selector, ANY arg/return
//                                           types (objects, numbers, BOOL, and the
//                                           common CG structs)
//   ObjC.className(obj) / ObjC.responds(obj, "sel")

#import <Foundation/Foundation.h>
#import <JavaScriptCore/JavaScriptCore.h>   // compile-time types only — see lazy load below
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>

// JavaScriptCore is loaded lazily (dlopen on first eval), not linked. Loading it at
// process startup can perturb early framework initialization. Deferring the load
// until after launch keeps the audit runtime lean. Class refs are resolved via
// objc_getClass so the linker records no JSC dependency.
static id gCtx = nil;          // JSContext *
static Class gJSValueCls = nil;
static NSMutableArray<NSString *> *gLogs = nil;

typedef struct {
    double latitude;
    double longitude;
} ITCCLLocationCoordinate2D;

static double dnum(id v, NSString *k1, NSString *k2) {
    if (![v isKindOfClass:[NSDictionary class]]) return 0;
    id a = v[k1]; if (a == nil && k2) a = v[k2];
    return [a respondsToSelector:@selector(doubleValue)] ? [a doubleValue] : 0;
}
// Marshal one JS-bridged argument into the invocation at `idx` per its encoding.
static void setArg(NSInvocation *inv, NSUInteger idx, const char *enc, id a) {
    switch (enc[0]) {
        case '@': case '#': { id o = (a == [NSNull null]) ? nil : a; [inv setArgument:&o atIndex:idx]; break; }
        case 'B': case 'c': { BOOL v = [a boolValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'i': { int v = [a intValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 's': { short v = (short)[a intValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'l': { long v = (long)[a longValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'q': { long long v = [a longLongValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'I': { unsigned v = [a unsignedIntValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'S': { unsigned short v = (unsigned short)[a unsignedIntValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'L': { unsigned long v = [a unsignedLongValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'Q': { unsigned long long v = [a unsignedLongLongValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'f': { float v = [a doubleValue]; [inv setArgument:&v atIndex:idx]; break; }
        case 'd': { double v = [a doubleValue]; [inv setArgument:&v atIndex:idx]; break; }
        case ':': { SEL v = NSSelectorFromString([a description]); [inv setArgument:&v atIndex:idx]; break; }
        case '{': {
            if (strstr(enc, "CGRect"))  { CGRect v = CGRectMake(dnum(a,@"x",nil), dnum(a,@"y",nil), dnum(a,@"w",@"width"), dnum(a,@"h",@"height")); [inv setArgument:&v atIndex:idx]; }
            else if (strstr(enc, "CGPoint")) { CGPoint v = CGPointMake(dnum(a,@"x",nil), dnum(a,@"y",nil)); [inv setArgument:&v atIndex:idx]; }
            else if (strstr(enc, "CGSize"))  { CGSize v = CGSizeMake(dnum(a,@"w",@"width"), dnum(a,@"h",@"height")); [inv setArgument:&v atIndex:idx]; }
            else if (strstr(enc, "CLLocationCoordinate2D")) {
                ITCCLLocationCoordinate2D v = {
                    dnum(a,@"lat",@"latitude"),
                    dnum(a,@"lon",@"longitude")
                };
                [inv setArgument:&v atIndex:idx];
            }
            else { [gLogs addObject:[NSString stringWithFormat:@"[msg] unsupported struct arg %s", enc]]; }
            break;
        }
        default: { [gLogs addObject:[NSString stringWithFormat:@"[msg] unsupported arg type %s", enc]]; break; }
    }
}

static BOOL ownsReturn(NSString *sel) {
    return [sel hasPrefix:@"new"] || [sel hasPrefix:@"alloc"] || [sel hasPrefix:@"copy"]
        || [sel hasPrefix:@"mutableCopy"] || [sel hasPrefix:@"init"];
}

static id getReturn(NSInvocation *inv, NSMethodSignature *sig, NSString *selName) {
    const char *rt = sig.methodReturnType;
    switch (rt[0]) {
        case 'v': return nil;
        case '@': case '#': {
            void *p = NULL; [inv getReturnValue:&p];
            if (!p) return nil;
            // new/alloc/copy/init return +1 — transfer that ownership into ARC so we
            // don't leak; otherwise borrow.
            return ownsReturn(selName) ? (__bridge_transfer id)p : (__bridge id)p;
        }
        case 'B': case 'c': { BOOL v; [inv getReturnValue:&v]; return @(v); }
        case 'i': { int v; [inv getReturnValue:&v]; return @(v); }
        case 's': { short v; [inv getReturnValue:&v]; return @(v); }
        case 'l': { long v; [inv getReturnValue:&v]; return @(v); }
        case 'q': { long long v; [inv getReturnValue:&v]; return @(v); }
        case 'I': { unsigned v; [inv getReturnValue:&v]; return @(v); }
        case 'S': { unsigned short v; [inv getReturnValue:&v]; return @(v); }
        case 'L': { unsigned long v; [inv getReturnValue:&v]; return @(v); }
        case 'Q': { unsigned long long v; [inv getReturnValue:&v]; return @(v); }
        case 'f': { float v; [inv getReturnValue:&v]; return @(v); }
        case 'd': { double v; [inv getReturnValue:&v]; return @(v); }
        case '*': { char *v; [inv getReturnValue:&v]; return v ? @(v) : nil; }
        case '{': {
            // CG structs keep their names; unknown structs are intentionally not
            // guessed because shape-only decoding is not stable across frameworks.
            if (strstr(rt, "CGRect"))  { CGRect r; [inv getReturnValue:&r]; return @{@"x": @(r.origin.x), @"y": @(r.origin.y), @"w": @(r.size.width), @"h": @(r.size.height)}; }
            if (strstr(rt, "CGPoint")) { CGPoint p; [inv getReturnValue:&p]; return @{@"x": @(p.x), @"y": @(p.y)}; }
            if (strstr(rt, "CGSize"))  { CGSize s; [inv getReturnValue:&s]; return @{@"w": @(s.width), @"h": @(s.height)}; }
            if (strstr(rt, "CLLocationCoordinate2D")) {
                ITCCLLocationCoordinate2D c;
                [inv getReturnValue:&c];
                return @{@"lat": @(c.latitude), @"lon": @(c.longitude), @"latitude": @(c.latitude), @"longitude": @(c.longitude)};
            }
            [gLogs addObject:[NSString stringWithFormat:@"[msg] unsupported struct return %s", rt]];
            return nil;
        }
        default: return nil;
    }
}

// ObjC.msg(receiver, "selector", [args]) — the universal dynamic dispatch.
static id objcMsg(JSValue *recvV, NSString *selName, JSValue *argsV) {
    id target = [recvV toObject];
    if (target == nil || target == [NSNull null]) { [gLogs addObject:@"[msg] nil receiver"]; return nil; }
    SEL sel = NSSelectorFromString(selName);
    BOOL isClass = object_isClass(target);
    Class cls = isClass ? (Class)target : object_getClass(target);
    Method m = isClass ? class_getClassMethod(cls, sel) : class_getInstanceMethod(cls, sel);
    if (!m) { [gLogs addObject:[NSString stringWithFormat:@"[msg] %@ does not respond to %@", NSStringFromClass(cls), selName]]; return nil; }
    NSMethodSignature *sig = [NSMethodSignature signatureWithObjCTypes:method_getTypeEncoding(m)];
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    inv.target = target;
    inv.selector = sel;
    NSArray *args = [argsV isArray] ? [argsV toArray] : @[];
    for (NSUInteger i = 2; i < sig.numberOfArguments; i++) {
        id a = (i - 2 < args.count) ? args[i - 2] : [NSNull null];
        setArg(inv, i, [sig getArgumentTypeAtIndex:i], a);
    }
    @try { [inv invoke]; }
    @catch (NSException *e) { [gLogs addObject:[NSString stringWithFormat:@"[msg] exception invoking %@: %@", selName, e.reason]]; return nil; }
    return getReturn(inv, sig, selName);
}

static NSString *kPrelude =
@"var console={log:function(){_log(Array.prototype.map.call(arguments,String).join(' '))}};"
 "var ObjC={"
 "  cls:function(n){return _cls(n)},"
 "  msg:function(r,s){return _msg(r,s,Array.prototype.slice.call(arguments,2))},"
 "  className:function(o){return _className(o)},"
 "  responds:function(o,s){return _responds(o,s)},"
 "  methods:function(o){return _methods(o)},"
 "  ivars:function(o){return _ivars(o)}"
 "};";

// Lazily dlopen JavaScriptCore and resolve its classes. Returns NO if unavailable.
static BOOL ensureJSCLoaded(void) {
    static int tried = 0;
    if (gJSValueCls) return YES;
    if (tried) return gJSValueCls != nil;
    tried = 1;
    if (!objc_getClass("JSContext")) {
        dlopen("/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore", RTLD_NOW | RTLD_GLOBAL);
    }
    gJSValueCls = objc_getClass("JSValue");
    return objc_getClass("JSContext") != nil && gJSValueCls != nil;
}

static void setup(void) {
    if (gCtx) return;
    Class JSContextCls = objc_getClass("JSContext");
    gCtx = [[JSContextCls alloc] init];
    gLogs = [NSMutableArray array];
    ((JSContext *)gCtx).exceptionHandler = ^(JSContext *c, JSValue *e) {
        [gLogs addObject:[NSString stringWithFormat:@"[exception] %@", [e toString]]];
    };
    gCtx[@"_log"] = ^(JSValue *v) { [gLogs addObject:([v toString] ?: @"undefined")]; };
    gCtx[@"_cls"] = ^id(NSString *n) { return NSClassFromString(n); };
    gCtx[@"_className"] = ^NSString *(JSValue *o) {
        id obj = [o toObject]; if (!obj) return @"nil";
        return object_isClass(obj) ? NSStringFromClass((Class)obj) : NSStringFromClass(object_getClass(obj));
    };
    gCtx[@"_responds"] = ^(JSValue *o, NSString *s) {
        id obj = [o toObject]; if (!obj) return @NO;
        return @([obj respondsToSelector:NSSelectorFromString(s)]);
    };
    // runtime introspection — enumerate a class's (or object's class's) methods/ivars.
    gCtx[@"_methods"] = ^NSArray *(JSValue *o) {
        id obj = [o toObject]; if (!obj) return @[];
        Class c = object_isClass(obj) ? (Class)obj : object_getClass(obj);
        unsigned n = 0; Method *ms = class_copyMethodList(c, &n);
        NSMutableArray *a = [NSMutableArray array];
        for (unsigned i = 0; i < n; i++) [a addObject:NSStringFromSelector(method_getName(ms[i]))];
        if (ms) free(ms);
        return a;
    };
    gCtx[@"_ivars"] = ^NSArray *(JSValue *o) {
        id obj = [o toObject]; if (!obj) return @[];
        Class c = object_isClass(obj) ? (Class)obj : object_getClass(obj);
        unsigned n = 0; Ivar *iv = class_copyIvarList(c, &n);
        NSMutableArray *a = [NSMutableArray array];
        for (unsigned i = 0; i < n; i++)
            [a addObject:[NSString stringWithFormat:@"%s : %s",
                          ivar_getName(iv[i]), ivar_getTypeEncoding(iv[i]) ?: "?"]];
        if (iv) free(iv);
        return a;
    };
    JSValue *(^msgBlock)(JSValue *, NSString *, JSValue *) = ^JSValue *(JSValue *r, NSString *s, JSValue *a) {
        id result = objcMsg(r, s, a);
        return result ? [(id)gJSValueCls valueWithObject:result inContext:gCtx]
                      : [(id)gJSValueCls valueWithUndefinedInContext:gCtx];
    };
    gCtx[@"_msg"] = msgBlock;
    [gCtx evaluateScript:kPrelude];
}

static char *jsonDup(NSString *s) {
    const char *u = [s UTF8String]; size_t n = strlen(u);
    char *buf = malloc(n + 1); memcpy(buf, u, n); buf[n] = 0; return buf;
}

// Note: the UIKit app-delegate launch-exception guard was relocated out of the
// capability-blind tracked tree; it ships only inside an operator-
// supplied extension's own agent dylib.

char *itc_eval_js(const char *codeUTF8) {
    @autoreleasepool {
        if (!ensureJSCLoaded()) {
            return jsonDup(@"{\"result\":\"undefined\",\"logs\":[\"[js] JavaScriptCore unavailable\"]}");
        }
        setup();
        [gLogs removeAllObjects];
        NSString *code = codeUTF8 ? [NSString stringWithUTF8String:codeUTF8] : @"";
        JSValue *res = [gCtx evaluateScript:code];
        NSString *resultStr = (res && ![res isUndefined] && ![res isNull]) ? [res toString] : @"undefined";
        NSDictionary *out = @{ @"result": (resultStr ?: @"undefined"), @"logs": [gLogs copy] };
        NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
        if (!json) json = [@"{\"result\":\"<unserializable>\",\"logs\":[]}" dataUsingEncoding:NSUTF8StringEncoding];
        char *buf = malloc(json.length + 1);
        memcpy(buf, json.bytes, json.length);
        buf[json.length] = 0;
        return buf;
    }
}
