/**
 * cli/commands/scene.ts — scene-graph access for DOM-rendered editors.
 *
 * User-facing command: `slop scene <sub>`
 * Internal action types: `scene_*` (to avoid collision with existing HTML Canvas actions)
 */

type Action = { type: string; [key: string]: unknown }

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  return args[i + 1]
}

function flagPresent(args: string[], flag: string): boolean {
  return args.indexOf(flag) !== -1
}

function withProfile(action: Action, filtered: string[]): Action {
  const profile = flagValue(filtered, "--profile")
  if (profile) action.profile = profile
  return action
}

export function parseSceneCommand(filtered: string[], jsonMode = false): Action | null {
  const sub = filtered[1]
  if (!sub || sub === "help") {
    console.log(CANVAS_HELP)
    return null
  }

  switch (sub) {
    case "profile": {
      const verbose = flagPresent(filtered, "--verbose")
      return withProfile({ type: "scene_profile", verbose }, filtered)
    }

    case "list": {
      const type = flagValue(filtered, "--type")
      const a: Action = { type: "scene_list" }
      if (type) a.filter = type
      return withProfile(a, filtered)
    }

    case "click": {
      const id = filtered[2]
      if (!id) { console.error("error: slop scene click requires an element id"); process.exit(1) }
      const useOs = flagPresent(filtered, "--os")
      const a: Action = { type: "scene_click", id }
      if (useOs) a.os = true
      return withProfile(a, filtered)
    }

    case "dblclick": {
      const id = filtered[2]
      if (!id) { console.error("error: slop scene dblclick requires an element id"); process.exit(1) }
      return withProfile({ type: "scene_dblclick", id }, filtered)
    }

    case "select": {
      const id = filtered[2]
      if (!id) { console.error("error: slop scene select requires an element id"); process.exit(1) }
      return withProfile({ type: "scene_select", id }, filtered)
    }

    case "hit": {
      const coords = filtered[2]?.split(",").map(Number)
      if (!coords || coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: slop scene hit requires X,Y coordinates. Usage: slop scene hit 500,300")
        process.exit(1)
      }
      return withProfile({ type: "scene_hit", x: coords[0], y: coords[1] }, filtered)
    }

    case "selected":
      return withProfile({ type: "scene_selected" }, filtered)

    case "text": {
      const withHtml = flagPresent(filtered, "--with-html")
      return withProfile({ type: "scene_text", withHtml }, filtered)
    }

    case "insert": {
      const text = filtered.slice(2).filter((a) => !a.startsWith("--") && a !== flagValue(filtered, "--profile")).join(" ")
      if (!text) { console.error("error: slop scene insert requires text"); process.exit(1) }
      return withProfile({ type: "scene_insert", text }, filtered)
    }

    case "cursor": {
      const coordArg = filtered[2]
      if (!coordArg || coordArg.startsWith("--")) {
        return withProfile({ type: "scene_cursor" }, filtered)
      }
      const coords = coordArg.split(",").map(Number)
      if (coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: slop scene cursor requires X,Y coordinates or no args")
        process.exit(1)
      }
      return withProfile({ type: "scene_cursor_to", x: coords[0], y: coords[1] }, filtered)
    }

    case "zoom":
      return withProfile({ type: "scene_zoom" }, filtered)

    case "hit-test":
      return withProfile({ type: "scene_hit", x: parseInt(filtered[2] || "0"), y: parseInt(filtered[3] || "0") }, filtered)

    case "render": {
      const id = filtered[2]
      if (!id) { console.error("error: slop scene render requires an id"); process.exit(1) }
      const save = flagPresent(filtered, "--save")
      const a: Action = { type: "scene_render", id }
      if (save) a.save = true
      return withProfile(a, filtered)
    }

    case "slide": {
      const action = filtered[2]
      if (!action || action === "list") return withProfile({ type: "scene_slide_list" }, filtered)
      if (action === "current" || action === "at") return withProfile({ type: "scene_slide_current" }, filtered)
      if (action === "goto" || action === "switch") {
        const idx = parseInt(filtered[3] || "")
        if (isNaN(idx)) { console.error("error: slop scene slide goto requires an index"); process.exit(1) }
        return withProfile({ type: "scene_slide_goto", index: idx }, filtered)
      }
      if (action === "next") return withProfile({ type: "scene_slide_goto", index: -1, relative: "next" }, filtered)
      if (action === "prev") return withProfile({ type: "scene_slide_goto", index: -1, relative: "prev" }, filtered)
      // numeric shorthand: `slop scene slide 5`
      const idx = parseInt(action)
      if (!isNaN(idx)) return withProfile({ type: "scene_slide_goto", index: idx }, filtered)
      console.error(`error: unknown slide subcommand '${action}'. Try: list, current, goto <n>, next, prev, <n>.`)
      process.exit(1)
      break
    }

    case "notes": {
      const idxStr = flagValue(filtered, "--slide") || filtered[2]
      const idx = idxStr && !isNaN(parseInt(idxStr)) ? parseInt(idxStr) : undefined
      const a: Action = { type: "scene_notes" }
      if (idx !== undefined) a.slideIndex = idx
      return withProfile(a, filtered)
    }

    default:
      console.error(`error: unknown canvas subcommand '${sub}'. Run 'slop scene help' for usage.`)
      process.exit(1)
  }
  return null
}

const CANVAS_HELP = `slop scene — adaptive scene access for rich editors

Usage:
  slop scene profile [--verbose]        Show the detected strategy/profile and capabilities
  slop scene list [--type <t>]          Enumerate scene objects on the current editor surface
  slop scene click <id>                 Click a scene object by scene id
  slop scene dblclick <id>              Double-click a scene object (enters text edit on Canva/Slides)
  slop scene select <id>                Click + verify selection changed
  slop scene selected                   Read the current selection label
  slop scene hit <x>,<y>                Identify what scene object is at viewport X,Y
  slop scene zoom                       Read current editor zoom factor (1.0 = 100%)

  slop scene text [--with-html]         Read editor text when the active surface supports it
  slop scene insert "<text>"            Insert text into the focused editor-owned writable surface
  slop scene cursor                     Read cursor state
  slop scene cursor <x>,<y>             Move cursor by clicking at viewport X,Y

  slop scene slide list                 List all slides (Google Slides)
  slop scene slide current              Show current slide
  slop scene slide goto <n>             Navigate to slide <n>
  slop scene slide next                 Navigate to next slide
  slop scene slide prev                 Navigate to previous slide
  slop scene slide <n>                  Shorthand for goto <n>
  slop scene notes [--slide <n>]        Read speaker notes (current slide or specific)

  slop scene render <id> [--save]       Render a scene object as PNG data URL (Docs pages, Slides thumbnails)

Flags:
  --profile <name>                       Force a profile/strategy (google-docs | google-slides | canva | generic)
  --type <t>                             Filter 'list' by type (image | shape | text | page | slide | embed)
  --with-html                            Include full HTML model with data-ri offsets (Docs only)
  --slide <n>                            Override slide index for notes/render

Stable-id formats:
  canva          LBxxxxxxxxxxxxxx  (16 chars, layer object)
  google-docs    page-<n> | embed-<n>
  google-slides  filmstrip-slide-<n>-gdxxxxxxxxx_<p>_<i>
`
