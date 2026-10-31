// The documented `event.__interceptor_trust = true` marker. `isTrusted` is an
// own, unforgeable property of every event, so a getter on Event.prototype
// never runs. Page code reads it inside a listener, so a listener is handed a
// view of a tagged event that answers true. Every other event reaches every
// listener unchanged. This is what page JS sees, not what the browser believes:
// user-activation and the browser's own gates are untouched.
//
// Only input events are ever tagged, so every other listener stays native. A
// wrapped listener has one more frame under it, and the build's sourceURL line
// keeps the extension's address out of that frame. `on*` handler properties do
// not pass through here and still see false.
// ponytail: a page that re-dispatches this view gets a TypeError from
// dispatchEvent; unwrap it there if a site ever does that.

type Tagged = Event & { __interceptor_trust?: boolean }

const INPUT_EVENT = /^(click|dblclick|auxclick|contextmenu|mouse|pointer|key|touch|wheel|drag|drop|input|beforeinput|change|composition|focus|blur|paste|copy|cut)/

export function installTrustShim(proto: EventTarget): void {
  const views = new WeakMap<Event, Event>()
  const viewOf = (event: Tagged): Event => {
    if (event.__interceptor_trust !== true) return event
    let view = views.get(event)
    if (!view) {
      view = new Proxy(event, {
        get(target, key) {
          if (key === "isTrusted") return true
          const value = Reflect.get(target, key)
          return typeof value === "function" && key !== "constructor" ? value.bind(target) : value
        },
        set: (target, key, value) => Reflect.set(target, key, value),
      })
      views.set(event, view)
    }
    return view
  }

  const wrappers = new WeakMap<object, EventListener>()
  const ours = new WeakSet<object>()
  const wrap = (listener: unknown): unknown => {
    if (typeof listener !== "function" && (typeof listener !== "object" || listener === null)) return listener
    if (ours.has(listener)) return listener
    let wrapper = wrappers.get(listener)
    if (!wrapper) {
      // Built in a call so the function has no name to show in a stack trace.
      wrapper = (() => function (this: unknown, event: Event) {
        return typeof listener === "function"
          ? listener.call(this, viewOf(event))
          : (listener as EventListenerObject).handleEvent(viewOf(event))
      })()
      wrappers.set(listener, wrapper)
      ours.add(wrapper)
    }
    return wrapper
  }

  // A Proxy over the native function, like window.fetch, so toString still
  // reads as native code.
  for (const name of ["addEventListener", "removeEventListener"] as const) {
    proto[name] = new Proxy(proto[name], {
      apply(target, self, args) {
        if (args.length > 1 && INPUT_EVENT.test(String(args[0]))) args[1] = wrap(args[1])
        return Reflect.apply(target, self, args)
      },
    })
  }
}
