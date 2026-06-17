// hookengine.m — the Runtime Hook Fabric.
//
// Tier-1 ObjC interception: a GENERIC method hook that captures any method's
// arguments + return value with no per-signature trampoline, using the Aspects
// pattern (Peter Steinberger):
//   1. alias the original IMP under "__itc_orig__<selector>"
//   2. point the real selector's IMP at _objc_msgForward
//   3. swizzle the class's forwardInvocation: to our handler, which reads the
//      NSInvocation's args via the method signature, records a hit, redirects the
//      invocation to the alias (the original behavior), then reads the return value.
// The runtime APIs sign IMPs, so arm64e PAC is handled for free.
//
// Tier-3 C interception (cintercept) rebinds a curated allowlist of C symbols via
// fishhook (shared with netcap), capturing into the same ring buffer.
//
// Captured hits land in a thread-safe ring buffer drained by itc_hook_drain()
// (the proven native_net_log pattern — crash-durable, no daemon plumbing).

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <os/lock.h>
#import <string.h>
#import <fcntl.h>
#import <stdarg.h>
#import <netdb.h>
#import <dlfcn.h>

void itc_hook_record(const char *domain, const char *event, NSDictionary *fields);  // fwd

// fishhook (defined in AgentLoader/fishhook.c, same dylib).
struct rebinding { const char *name; void *replacement; void **replaced; };
extern int rebind_symbols(struct rebinding rebindings[], size_t rebindings_nel);

// Selectors that MUST NEVER be forward-hooked — doing so recurses or bricks the
// process (our forwarder itself sends respondsToSelector:; release/retain are hot
// and dealloc/destruct run during teardown).
static int isDangerousSel(const char *s) {
    static const char *deny[] = {
        "forwardInvocation:", "methodSignatureForSelector:", "respondsToSelector:",
        "retain", "release", "autorelease", "dealloc", ".cxx_destruct",
        "class", "superclass", "self", "isKindOfClass:", "isMemberOfClass:",
        "retainCount", "isProxy", "zone", "hash", "isEqual:",
    };
    for (size_t i = 0; i < sizeof deny / sizeof deny[0]; i++)
        if (strcmp(s, deny[i]) == 0) return 1;
    return 0;
}

// ── shared capture buffer ─────────────────────────────────────────────────────
static os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
static NSMutableArray *gHits = nil;                 // ring of hit dicts
static NSMutableDictionary *gHooks = nil;           // "Class -sel" -> {class,sel,count}
static NSMutableDictionary *gOrigForward = nil;     // className -> NSValue(IMP) of original forwardInvocation:
static NSUInteger gSeq = 0;
static const NSUInteger kHitCap = 4000;

static void ensureState(void) {
    if (!gHits) {
        gHits = [NSMutableArray array];
        gHooks = [NSMutableDictionary dictionary];
        gOrigForward = [NSMutableDictionary dictionary];
    }
}

// Append a hit (caller already holds gLock OR passes preformatted dict to record()).
static void recordHit(NSDictionary *hit) {
    os_unfair_lock_lock(&gLock);
    ensureState();
    NSMutableDictionary *m = [hit mutableCopy];
    m[@"seq"] = @(gSeq++);
    [gHits addObject:m];
    if (gHits.count > kHitCap) [gHits removeObjectsInRange:NSMakeRange(0, gHits.count - kHitCap)];
    os_unfair_lock_unlock(&gLock);
}

// ── value formatter (by ObjC type encoding) — C10 ─────────────────────────────
// Formats a raw value buffer (from NSInvocation getArgument/getReturnValue) into a
// JSON-safe id. Objects are rendered as class+ptr (or value for known leaf types) to
// avoid calling -description mid-method-call (re-entrancy / side effects).
static int countD(const char *enc) {
    int c = 0, inName = 0, inQ = 0;
    for (const char *p = enc; *p; p++) {
        char ch = *p;
        if (inQ) { if (ch == '"') inQ = 0; continue; }
        if (ch == '"') { inQ = 1; continue; }
        if (ch == '{' || ch == '(') { inName = 1; continue; }
        if (ch == '=' || ch == '}' || ch == ')') { inName = 0; continue; }
        if (!inName && ch == 'd') c++;
    }
    return c;
}

static id describeObject(id o) {
    if (!o) return [NSNull null];
    if ([o isKindOfClass:[NSString class]]) {
        NSString *s = (NSString *)o;
        return s.length > 240 ? [[s substringToIndex:240] stringByAppendingString:@"…"] : s;
    }
    if ([o isKindOfClass:[NSNumber class]]) return [(NSNumber *)o stringValue];
    if ([o isKindOfClass:[NSURL class]]) return [(NSURL *)o absoluteString];
    if ([o isKindOfClass:[NSData class]]) return [NSString stringWithFormat:@"<NSData %lu bytes>", (unsigned long)[(NSData *)o length]];
    return [NSString stringWithFormat:@"<%@ %p>", NSStringFromClass(object_getClass(o)), o];
}

static id formatBuf(const char *enc, void *buf) {
    if (!enc || !buf) return [NSNull null];
    switch (enc[0]) {
        case '@': case '#': return describeObject(*(__unsafe_unretained id *)buf);
        case ':': { SEL s = *(SEL *)buf; return s ? NSStringFromSelector(s) : (id)[NSNull null]; }
        case 'B': case 'c': return @(*(signed char *)buf ? YES : NO);
        case 'i': return @(*(int *)buf);
        case 's': return @(*(short *)buf);
        case 'l': return @(*(long *)buf);
        case 'q': return @(*(long long *)buf);
        case 'I': return @(*(unsigned int *)buf);
        case 'S': return @(*(unsigned short *)buf);
        case 'L': return @(*(unsigned long *)buf);
        case 'Q': return @(*(unsigned long long *)buf);
        case 'f': return @(*(float *)buf);
        case 'd': return @(*(double *)buf);
        case '*': { char *c = *(char **)buf; return c ? ([NSString stringWithUTF8String:c] ?: @"<non-utf8>") : (id)[NSNull null]; }
        case '^': return [NSString stringWithFormat:@"<ptr %p>", *(void **)buf];
        case '{': {
            if (strstr(enc, "CGRect") || strstr(enc, "NSRect")) { CGRect r = *(CGRect *)buf; return @{@"x": @(r.origin.x), @"y": @(r.origin.y), @"w": @(r.size.width), @"h": @(r.size.height)}; }
            if (strstr(enc, "CGPoint") || strstr(enc, "NSPoint")) { CGPoint p = *(CGPoint *)buf; return @{@"x": @(p.x), @"y": @(p.y)}; }
            if (strstr(enc, "CGSize") || strstr(enc, "NSSize")) { CGSize s = *(CGSize *)buf; return @{@"w": @(s.width), @"h": @(s.height)}; }
            int nd = countD(enc);
            if (nd == 4) { double *d = (double *)buf; return @{@"lat": @(d[0]), @"lon": @(d[1]), @"latDelta": @(d[2]), @"lonDelta": @(d[3])}; }
            if (nd == 2) { double *d = (double *)buf; return @{@"a": @(d[0]), @"b": @(d[1])}; }
            return [NSString stringWithFormat:@"<struct %s>", enc];
        }
        case 'v': return @"void";
        default: return [NSString stringWithFormat:@"<%s>", enc];
    }
}

// ── forwardInvocation: handler ────────────────────────────────────────────────
static SEL aliasFor(NSString *selName) {
    return sel_registerName([[@"__itc_orig__" stringByAppendingString:selName] UTF8String]);
}

static IMP origForwardFor(id obj) {
    // walk the class chain for the nearest hooked class's saved original forwardInvocation:
    os_unfair_lock_lock(&gLock);
    IMP imp = NULL;
    for (Class c = object_getClass(obj); c; c = class_getSuperclass(c)) {
        NSValue *v = gOrigForward[NSStringFromClass(c)];
        if (v) { imp = (IMP)[v pointerValue]; break; }
    }
    os_unfair_lock_unlock(&gLock);
    return imp;
}

static void itc_forwardInvocation(id self, SEL _cmd, NSInvocation *inv) {
  @autoreleasepool {  // hot path (per-call) — never let our allocations bloat the host's pool
    SEL target = inv.selector;
    NSString *selName = NSStringFromSelector(target);
    SEL alias = aliasFor(selName);
    if (![self respondsToSelector:alias]) {
        // not one of ours — defer to the original forwardInvocation: (or doesNotRecognize)
        IMP orig = origForwardFor(self);
        if (orig) { ((void(*)(id, SEL, NSInvocation *))orig)(self, _cmd, inv); }
        else { [self doesNotRecognizeSelector:target]; }
        return;
    }
    NSMethodSignature *sig = inv.methodSignature;
    NSMutableArray *args = [NSMutableArray array];
    @try {
        for (NSUInteger i = 2; i < sig.numberOfArguments; i++) {
            const char *enc = [sig getArgumentTypeAtIndex:i];
            NSUInteger size = 0; NSGetSizeAndAlignment(enc, &size, NULL);
            if (size == 0 || size > 256) { [args addObject:[NSString stringWithFormat:@"<%s>", enc]]; continue; }
            void *b = calloc(1, size);
            [inv getArgument:b atIndex:i];
            [args addObject:formatBuf(enc, b)];
            free(b);
        }
    } @catch (NSException *e) { [args addObject:[NSString stringWithFormat:@"<argerr %@>", e.reason]]; }

    // redirect to the original implementation
    inv.selector = alias;
    id retVal = [NSNull null];
    @try { [inv invoke]; }
    @catch (NSException *e) { retVal = [NSString stringWithFormat:@"<throw %@>", e.reason]; }

    const char *rt = sig.methodReturnType;
    if (rt && rt[0] != 'v') {
        NSUInteger rl = sig.methodReturnLength;
        if (rl > 0 && rl <= 256) {
            void *rb = calloc(1, rl);
            @try { [inv getReturnValue:rb]; retVal = formatBuf(rt, rb); } @catch (__unused NSException *e) {}
            free(rb);
        }
    } else if (rt && rt[0] == 'v') {
        retVal = @"void";
    }

    NSString *cls = NSStringFromClass(object_getClass(self));
    os_unfair_lock_lock(&gLock);
    NSMutableDictionary *h = nil;
    for (Class c = object_getClass(self); c; c = class_getSuperclass(c)) {
        NSMutableDictionary *hh = gHooks[[NSString stringWithFormat:@"%@ %@", NSStringFromClass(c), selName]];
        if (hh) { h = hh; break; }
    }
    NSString *domain = h[@"domain"] ?: @"Debugger";
    if (h) h[@"count"] = @([h[@"count"] unsignedLongLongValue] + 1);
    os_unfair_lock_unlock(&gLock);
    recordHit(@{ @"domain": domain, @"event": @"hookHit", @"class": cls,
                 @"selector": selName, @"args": args, @"ret": retVal,
                 @"tid": @((unsigned long long)(uintptr_t)[NSThread currentThread]) });
  }  // @autoreleasepool
}

// ── public API ────────────────────────────────────────────────────────────────
static char *jsonDup(id obj) {
    NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    if (!d) d = [@"{\"error\":\"unserializable\"}" dataUsingEncoding:NSUTF8StringEncoding];
    char *buf = malloc(d.length + 1); memcpy(buf, d.bytes, d.length); buf[d.length] = 0; return buf;
}

char *itc_hook_install_d(const char *classNameC, const char *selNameC, const char *domainC) {
    @autoreleasepool {
        NSString *domain = domainC ? @(domainC) : @"Debugger";
        if (!classNameC || !selNameC) return jsonDup(@{@"ok": @NO, @"error": @"class+selector required"});
        if (isDangerousSel(selNameC)) return jsonDup(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"refusing to hook unsafe selector %s", selNameC]});
        if (strcmp(classNameC, "NSObject") == 0 || strcmp(classNameC, "NSProxy") == 0)
            return jsonDup(@{@"ok": @NO, @"error": @"refusing to forward-hook a root class (would brick the process)"});
        Class cls = objc_getClass(classNameC);
        if (!cls) return jsonDup(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown class %s", classNameC]});
        NSString *selName = @(selNameC);
        SEL sel = sel_registerName(selNameC);
        Method m = class_getInstanceMethod(cls, sel);
        if (!m) return jsonDup(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"%s has no instance method %s", classNameC, selNameC]});
        const char *types = method_getTypeEncoding(m);
        IMP origIMP = method_getImplementation(m);
        if (origIMP == (IMP)_objc_msgForward) return jsonDup(@{@"ok": @YES, @"already": @YES, @"class": @(classNameC), @"selector": selName});

        os_unfair_lock_lock(&gLock);
        ensureState();
        // swizzle forwardInvocation: on this class once
        NSString *clsName = NSStringFromClass(cls);
        if (!gOrigForward[clsName]) {
            IMP of = class_getMethodImplementation(cls, @selector(forwardInvocation:));
            gOrigForward[clsName] = [NSValue valueWithPointer:of];
            class_replaceMethod(cls, @selector(forwardInvocation:), (IMP)itc_forwardInvocation, "v@:@");
        }
        os_unfair_lock_unlock(&gLock);

        // alias the original IMP, then point the real selector at the forwarder
        SEL alias = aliasFor(selName);
        if (!class_getInstanceMethod(cls, alias)) class_addMethod(cls, alias, origIMP, types);
        class_replaceMethod(cls, sel, (IMP)_objc_msgForward, types);

        os_unfair_lock_lock(&gLock);
        gHooks[[NSString stringWithFormat:@"%@ %@", clsName, selName]] =
            [@{ @"class": clsName, @"selector": selName, @"tier": @"objc", @"domain": domain, @"count": @0 } mutableCopy];
        os_unfair_lock_unlock(&gLock);
        return jsonDup(@{@"ok": @YES, @"class": clsName, @"selector": selName, @"tier": @"objc", @"domain": domain});
    }
}

char *itc_hook_install(const char *classNameC, const char *selNameC) {
    return itc_hook_install_d(classNameC, selNameC, "Debugger");
}

char *itc_hook_remove(const char *classNameC, const char *selNameC) {
    @autoreleasepool {
        Class cls = classNameC ? objc_getClass(classNameC) : Nil;
        if (!cls) return jsonDup(@{@"ok": @NO, @"error": @"unknown class"});
        NSString *selName = @(selNameC ?: "");
        SEL sel = sel_registerName(selNameC ?: "");
        SEL alias = aliasFor(selName);
        Method am = class_getInstanceMethod(cls, alias);
        if (am) {
            // restore original IMP onto the real selector
            class_replaceMethod(cls, sel, method_getImplementation(am), method_getTypeEncoding(am));
        }
        os_unfair_lock_lock(&gLock);
        [gHooks removeObjectForKey:[NSString stringWithFormat:@"%@ %@", NSStringFromClass(cls), selName]];
        os_unfair_lock_unlock(&gLock);
        return jsonDup(@{@"ok": @YES, @"removed": [NSString stringWithFormat:@"%@ %@", NSStringFromClass(cls), selName]});
    }
}

char *itc_hook_list(void) {
    @autoreleasepool {
        os_unfair_lock_lock(&gLock); ensureState();
        NSArray *vals = [gHooks allValues];
        os_unfair_lock_unlock(&gLock);
        return jsonDup(@{@"count": @(vals.count), @"hooks": vals});
    }
}

char *itc_hook_drain(int clear, int limit) {
    @autoreleasepool {
        os_unfair_lock_lock(&gLock); ensureState();
        NSArray *snap = [gHits copy];
        if (clear) [gHits removeAllObjects];
        os_unfair_lock_unlock(&gLock);
        if (limit > 0 && (int)snap.count > limit) snap = [snap subarrayWithRange:NSMakeRange(snap.count - limit, limit)];
        return jsonDup(@{@"count": @(snap.count), @"events": snap});
    }
}

// Record a hit from outside (used by the C-tier interceptors). Public so the
// fishhook replacements can push into the same stream.
void itc_hook_record(const char *domain, const char *event, NSDictionary *fields) {
    @autoreleasepool {
        NSMutableDictionary *d = fields ? [fields mutableCopy] : [NSMutableDictionary dictionary];
        d[@"domain"] = @(domain ?: "Debugger");
        d[@"event"] = @(event ?: "event");
        recordHit(d);
    }
}

// ── Tier-2: class-wide trace (C4) — hook every (safe) instance method of a class ──
char *itc_trace_class(const char *classNameC, int maxMethods) {
    @autoreleasepool {
        Class cls = classNameC ? objc_getClass(classNameC) : Nil;
        if (!cls) return jsonDup(@{@"ok": @NO, @"error": @"unknown class"});
        if (maxMethods <= 0) maxMethods = 120;
        unsigned n = 0; Method *ms = class_copyMethodList(cls, &n);
        int installed = 0;
        NSMutableArray *sels = [NSMutableArray array];
        for (unsigned i = 0; i < n && installed < maxMethods; i++) {
            const char *sn = sel_getName(method_getName(ms[i]));
            if (strncmp(sn, "__itc_orig__", 12) == 0) continue;
            if (isDangerousSel(sn)) continue;
            // skip property getters/ivar accessors that are extremely hot is hard to
            // know generically; the maxMethods cap bounds the blast radius.
            char *r = itc_hook_install_d(classNameC, sn, "Trace"); free(r);
            [sels addObject:@(sn)]; installed++;
        }
        if (ms) free(ms);
        return jsonDup(@{@"ok": @YES, @"class": @(classNameC), @"traced": @(installed),
                         @"totalMethods": @(n), @"selectors": sels});
    }
}

char *itc_untrace_class(const char *classNameC) {
    @autoreleasepool {
        Class cls = classNameC ? objc_getClass(classNameC) : Nil;
        if (!cls) return jsonDup(@{@"ok": @NO, @"error": @"unknown class"});
        os_unfair_lock_lock(&gLock); ensureState();
        NSArray *keys = [gHooks allKeys];
        os_unfair_lock_unlock(&gLock);
        NSString *prefix = [NSString stringWithFormat:@"%@ ", NSStringFromClass(cls)];
        int removed = 0;
        for (NSString *k in keys) {
            if (![k hasPrefix:prefix]) continue;
            NSString *sel = [k substringFromIndex:prefix.length];
            char *r = itc_hook_remove(classNameC, [sel UTF8String]); free(r); removed++;
        }
        return jsonDup(@{@"ok": @YES, @"class": @(classNameC), @"untraced": @(removed)});
    }
}

// ── DOM domain watch (C6) — wholesale view lifecycle ──
// NSView is a hot base class with thousands of subclass instances; the generic
// forwardInvocation engine is UNSAFE there (a subclass's own forwarding can miss
// ours, and per-frame methods flood). So DOM watch uses a TYPED BLOCK swizzle of
// the exact -[NSView addSubview:] signature (v@:@) — no forwarding, rock-solid,
// captures every view added app-wide. (viewWillDraw is intentionally NOT hooked:
// it fires every frame for every view — too hot, low signal.)
static IMP gOrigAddSubview = NULL;
static SEL gAddSubviewSel;
char *itc_dom_watch(void) {
    @autoreleasepool {
        Class cls = objc_getClass("NSView");
        if (!cls) return jsonDup(@{@"ok": @NO, @"error": @"NSView unavailable"});
        if (gOrigAddSubview) return jsonDup(@{@"ok": @YES, @"already": @YES, @"domain": @"DOM"});
        gAddSubviewSel = sel_registerName("addSubview:");
        Method m = class_getInstanceMethod(cls, gAddSubviewSel);
        if (!m) return jsonDup(@{@"ok": @NO, @"error": @"NSView has no addSubview:"});
        gOrigAddSubview = method_getImplementation(m);
        IMP newImp = imp_implementationWithBlock(^(__unsafe_unretained id self, __unsafe_unretained id sub) {
            @autoreleasepool {
                @try {
                    itc_hook_record("DOM", "viewAdded", @{ @"class": NSStringFromClass(object_getClass(self)),
                                                           @"selector": @"addSubview:", @"arg": describeObject(sub) });
                } @catch (__unused NSException *e) {}
            }
            ((void (*)(id, SEL, id))gOrigAddSubview)(self, gAddSubviewSel, sub);
        });
        method_setImplementation(m, newImp);
        return jsonDup(@{ @"ok": @YES, @"watching": @[@"-[NSView addSubview:]"], @"domain": @"DOM",
                          @"mechanism": @"typed block swizzle" });
    }
}

// ── Tier-3: C-symbol interception via dyld __interpose (C5) ──
// Runtime fishhook of libsystem symbols is UNSAFE on modern macOS — it writes to
// __DATA_CONST pages locked after bind (chained fixups), corrupting the GOT
// (our research flagged this; CONFIRMED on-box: it crashed the host). The robust
// path is dyld __interpose, applied at BIND (before lockdown) — declared statically
// in the agent (AgentLoader/cinterpose.c) and GATED by a recording mask, so the
// interposer is a cheap pass-through until an operator enables it. No runtime page
// writes => cannot corrupt the host.
unsigned itc_cintercept_mask = 0;           // bit 1 = open, bit 2 = getaddrinfo (read by cinterpose.c)
#define ITC_CIN_OPEN 1u
#define ITC_CIN_GAI  2u

// C-friendly record entry the pure-C interposers call (builds the dict safely here).
void itc_hook_record_c(const char *domain, const char *event, const char *fn, const char *s1, long n1) {
    @autoreleasepool {
        @try {
            NSString *sv = s1 ? ([NSString stringWithUTF8String:s1] ?: @"<non-utf8>") : @"";
            itc_hook_record(domain, event, @{ @"fn": @(fn ?: "?"), @"arg": sv, @"rc": @(n1) });
        } @catch (__unused NSException *e) {}
    }
}

char *itc_cintercept_install(const char *symbolC) {
    @autoreleasepool {
        if (!symbolC) return jsonDup(@{@"ok": @NO, @"error": @"symbol required"});
        NSString *sym = @(symbolC);
        if ([sym isEqualToString:@"open"]) itc_cintercept_mask |= ITC_CIN_OPEN;
        else if ([sym isEqualToString:@"getaddrinfo"]) itc_cintercept_mask |= ITC_CIN_GAI;
        else return jsonDup(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"%@ not in allowlist (open/getaddrinfo)", sym]});
        return jsonDup(@{@"ok": @YES, @"symbol": sym, @"tier": @"cintercept (dyld __interpose)", @"recording": @YES});
    }
}

char *itc_cintercept_list(void) {
    return jsonDup(@{@"allowlist": @[@"open", @"getaddrinfo"], @"tier": @"dyld __interpose (bind-time, safe)",
                     @"activeMask": @(itc_cintercept_mask)});
}

// Note: the identity launch-exception (dispatch_once) guard was relocated out of
// the capability-blind tracked tree. It now ships only inside an
// operator-supplied extension's own agent dylib.
