# Use Case: Canva Custom Size Creation Monitor Handoff

**Date:** 2026-04-13
**Session ID:** `a23ca61c-0eb2-4855-906b-c7c9593bfba7`
**Source tab:** Canva home (`1729157848`)
**Opened design tab:** `640 x 320px` (`1729157849`)

---

## Outcome

This session captured the reliable path for creating a new custom-size Canva design from the Canva home screen:

1. Open the `Create a design` launcher.
2. Switch to `Custom size`.
3. Set width to `640`.
4. Set height to `320`.
5. Submit `Create new design`.

The monitor did **not** capture the later edits inside the newly opened design tab. It remained attached to the original Canva home tab after the new design opened.

---

## Exact Observed User Flow

These are the meaningful trusted input events recorded in the session:

| Seq | Action | Target | Value / Note |
|---|---|---|---|
| 107 | click | unnamed `span` nested under the `Create a design` launcher | Raw trace target was unnamed; semantically this maps to the `Create a design` button |
| 206 | click | `button:Custom size` | Opened the custom-size form |
| 262 | click | `spinbutton:Width` | Focused width |
| 267 | input | `spinbutton:Width` | `6` |
| 287 | input | `spinbutton:Width` | `64` |
| 293 | input | `spinbutton:Width` | `640` |
| 301 | change | `spinbutton:Width` | committed `640` via `Tab` |
| 314 | input | `spinbutton:Height` | `3` |
| 317 | input | `spinbutton:Height` | `32` |
| 322 | input | `spinbutton:Height` | `320` |
| 329 | change | `spinbutton:Height` | committed `320` via `Tab` |
| 379 | click | `span:Create new design` | Submitted custom-size creation |
| 380 | submit | form | New design opened in a new tab |

All trusted user activity finished within about `24s` of monitor start. The rest of the `534.236s` session was Canva background churn on the original tab.

---

## Normalized Replay

Use the semantic version below instead of the raw `e11` click from the trace:

```bash
interceptor tab new "https://www.canva.com/"
interceptor wait-stable
interceptor click "button:Create a design"
interceptor wait-stable
interceptor click "button:Custom size"
interceptor wait-stable
interceptor type "spinbutton:Width" "640"
interceptor keys "Tab"
interceptor type "spinbutton:Height" "320"
interceptor keys "Tab"
interceptor click "button:Create a design in a new tab or window"
```

---

## Verification Signals

During capture, the flow produced these useful checks:

- Canva exposed the custom-size form with `Width`, `Height`, and `Units: px`.
- Width change triggered `/_ajax/designspec/spec?width=640&units=PIXELS...`.
- Height commit triggered `/_ajax/designspec/spec?width=640&height=320&units=PIXELS...`.
- A new Canva editor tab opened with title `640×320 - 640 × 320px`.

After the session, `interceptor tabs` showed the new editor at:

- `https://www.canva.com/design/DAHGwNxCuPQ/qbfkfWzBqYyC6HuffGYgmg/edit?...`

I am intentionally not using that design URL as a stable replay target. Future runs should create a fresh document and then capture or discover the new editor tab dynamically.

---

## Critical Limitation

This session is a **launch-and-handoff** capture, not a full edit capture.

What actually happened:

- The monitor started on Canva home.
- The custom-size flow opened a new editor tab.
- The monitor stayed bound to the original home tab.
- Any image edits made afterward were not recorded in this session.

That means Interceptor now knows the repeatable setup path to open a `640 x 320` design, but it does **not** yet know your in-editor modification sequence from this run.

---

## Correct Future Capture Pattern

To permanently learn actual Canva editing moves, use a two-stage monitor flow:

1. Start a monitor on Canva home to capture launch/setup.
2. Create the design.
3. Identify the new editor tab with `interceptor tabs`.
4. Start a second monitor on that new tab before making edits.
5. Perform the actual canvas modifications.
6. Export both sessions and save them together.

If Canva scene support is needed, verify it live first. Post-session verification on the open editor tab returned `scene profile -> generic`, so the editor should not currently be assumed to expose a usable `canva` scene profile in this state.

---
