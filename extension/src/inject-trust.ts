// The documented `event.__interceptor_trust = true` marker. `isTrusted` is an
// own, unforgeable property of every event, so a getter on Event.prototype
// never runs. Page code reads it inside a listener, so a listener that reads it
// is handed a view of a tagged event that answers true. This is what page JS
// sees, not what the browser believes: user-activation and the browser's own
// gates are untouched.
//
// The bar is that a person's normal browsing cannot change. Only input events
// on nodes and windows are wrapped, every untagged event reaches the listener
// unchanged, and the build's sourceURL line keeps the extension's address out
// of the wrapper's stack frame. `on*` handler properties do not pass through
// here and still see false.
// ponytail: a page that re-dispatches this view gets a TypeError from
// dispatchEvent; unwrap it there if a site ever does that.

type Tagged = Event & { __interceptor_trust?: boolean }

const INPUT_EVENT = /^(click|dblclick|auxclick|contextmenu|mouse|pointer|key|touch|wheel|drag|drop|input|beforeinput|change|composition|focus|blur|paste|copy|cut)/
// Taken while this runs at document_start, before page scripts: a page may
// later define its own global Node, Window, Object or Reflect.
const sourceOf = Function.prototype.toString
const { apply, get, set } = Reflect
const NodeCtor = typeof Node === "function" ? Node : undefined
const WindowCtor = typeof Window === "function" ? Window : undefined
const ObjectCtor = Object

const isPageTarget = (target: unknown): boolean =>
  target == null || (!!NodeCtor && target instanceof NodeCtor) || (!!WindowCtor && target instanceof WindowCtor)

export function installTrustShim(proto: EventTarget, isTarget: (target: unknown) => boolean = isPageTarget): void {
  const views = new WeakMap<Event, Event>()
  const viewOf = (event: Event): Event => {
    let view = views.get(event)
    if (!view) {
      view = new Proxy(event, {
        get(target, key) {
          if (key === "isTrusted") return true
          const value = get(target, key)
          return typeof value === "function" && key !== "constructor" ? value.bind(target) : value
        },
        set: (target, key, value) => set(target, key, value),
      })
      views.set(event, view)
    }
    return view
  }

  // The view fails brand checks such as Event.prototype.preventDefault.call(e),
  // and frameworks make those calls, so only code that names isTrusted gets it.
  const readsTrust = (listener: unknown): boolean => {
    const fn = typeof listener === "function" ? listener : (listener as EventListenerObject).handleEvent
    try { return typeof fn === "function" && sourceOf.call(fn).includes("isTrusted") } catch { return false }
  }
  const eventFor = (listener: unknown, event: Tagged): Event =>
    event.__interceptor_trust === true && readsTrust(listener) ? viewOf(event) : event

  const wrappers = new WeakMap<object, EventListener>()
  const wrap = (listener: unknown): unknown => {
    // Skips non-objects and listeners from another realm: the browser stops
    // calling those when their frame goes away, and a wrapper here would not.
    if (!(listener instanceof ObjectCtor)) return listener
    let wrapper = wrappers.get(listener)
    if (!wrapper) {
      // Built in a call so the function has no name to show in a stack trace.
      wrapper = (() => function (this: unknown, event: Event) {
        const seen = eventFor(listener, event)
        return typeof listener === "function"
          ? apply(listener, this, [seen])
          : (listener as EventListenerObject).handleEvent(seen)
      })()
      wrappers.set(listener, wrapper)
    }
    return wrapper
  }

  // Any failure here means the page gets the native behavior, never an error.
  const isInput = (self: unknown, args: unknown[]): boolean => {
    try { return args.length > 1 && typeof args[0] === "string" && INPUT_EVENT.test(args[0]) && isTarget(self) } catch { return false }
  }
  const wrapperOf = (listener: unknown): EventListener | undefined => {
    try { return listener instanceof ObjectCtor ? wrappers.get(listener) : undefined } catch { return undefined }
  }

  // Proxies over the native functions, like window.fetch, so toString still
  // reads as native code.
  proto.addEventListener = new Proxy(proto.addEventListener, {
    apply(target, self, args) {
      if (isInput(self, args)) { try { args[1] = wrap(args[1]) } catch {} }
      return apply(target, self, args)
    },
  })
  proto.removeEventListener = new Proxy(proto.removeEventListener, {
    apply(target, self, args) {
      // Both forms: the page's own function may have been added before this
      // ran, or through a path that does not come here.
      const wrapper = isInput(self, args) ? wrapperOf(args[1]) : undefined
      if (wrapper) apply(target, self, [args[0], wrapper, ...args.slice(2)])
      return apply(target, self, args)
    },
  })
}
