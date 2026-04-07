# Use Case: Testing a Three-Panel SPA (Cy Dashboard)

**Date:** 2026-04-05
**Agent:** Cy (Claude)
**Target:** Cy Dashboard at `http://localhost:5173` — a three-column WebSocket-driven SPA with sidebar (session list), main chat area (scrollable messages), and right panel (tabbed: Tasks/Memory/Analytics/Extensions).

---

## The Challenge

The Cy Dashboard has three independently scrollable panels. The session list items are `<div>`s with JS click handlers (no ARIA roles), the main chat area contains hundreds of entries with collapsible tool calls, and the right panel tabs load content via API fetch. Agents typically struggle with:

1. **Non-interactive elements** — session items aren't buttons/links, so `slop tree` doesn't show them
2. **Multi-panel scroll** — `slop scroll` hits the page, not the specific panel
3. **Dynamic content** — clicking a session triggers API fetch + DOM replacement
4. **Knowing what to verify** — the page has a WebSocket connection indicator, bundled assets, and API-driven panels

---

## The Successful Flow

### Step 1: Open the Tab

```bash
slop tab new "http://localhost:5173"
```

Wait for load. Verify the tab title includes "Connected" (proves WebSocket is working):

```bash
slop tabs
# Look for: "Cy Dashboard — Connected"
```

**Key insight:** The page title is the first health check. "Connected" means the WebSocket handshake succeeded. "Disconnected" or a plain "Cy Dashboard" means the server isn't running or WS failed.

### Step 2: Read the Layout with `tree` and `text`

```bash
slop tree --tab <TAB_ID> --filter all
```

**What you see:**
```
complementary
  heading "✦ Cy ●"
  [e1] button "New Session"
  [e2] textbox type="text" placeholder="Search sessions..."
main
  banner
  [e3] textbox
  [e4] button "Send"
complementary
  [e5] button "Tasks"
  [e6] button "Memory"
  [e7] button "Analytics"
  [e8] button "Extensions"
```

**Key insight:** `tree` shows the structural skeleton — sidebar controls (e1, e2), main input area (e3, e4), right panel tabs (e5-e8). The session list items are NOT in the tree because they're plain `<div>`s without ARIA roles. This is expected — don't fight it.

Then read full page text to verify data loaded:

```bash
slop text --tab <TAB_ID>
```

**What you see:** Session names, timestamps, costs — proves the API fetch worked and the session list rendered. Example:
```
●prd07-test
4/5/2026, 10:55:06 AM
●@codex hello there!
4/5/2026, 7:23:12 AM $1.02
```

### Step 3: Click Non-Interactive Session Items via `eval --main`

Session items are `<div class="session-item">` with `addEventListener('click', ...)`. Since they're not in `slop tree`, use `eval --main` to click them:

```bash
# Click the third session (index 2)
slop eval "document.querySelectorAll('.session-item')[2]?.click()" --tab <TAB_ID> --main
```

**CRITICAL:** Use `--main` flag. Without it, eval runs in an isolated world and can't access the page's event listeners. The click will fire but the handler won't execute.

To click by name:
```bash
slop eval "
const items = document.querySelectorAll('.session-item');
for (let i = 0; i < items.length; i++) {
  const name = items[i].querySelector('.session-name')?.textContent || '';
  if (name.includes('Look at')) { items[i].click(); break; }
}
'done'
" --tab <TAB_ID> --main
```

Wait 2-3 seconds after clicking for the API fetch + render to complete:
```bash
sleep 3
```

### Step 4: Verify Session Entries Loaded

After clicking a session, the main panel fills with entries. Run `tree --filter all` again:

```bash
slop tree --tab <TAB_ID> --filter all
```

**What you see now:** The main area populates with tool call collapsibles (details/summary elements), which DO show in the tree:
```
main
  banner
  [e37] group "⚡ task_create Find recent Pi session files..."
  [e38] button "⚡ task_create Find recent Pi session files"
  [e39] group "✓ bash 276 entries..."
  ...
```

**Key insight:** Tool calls render as `<details>` elements — `tree` shows these as groups with buttons (the `<summary>`). Assistant text messages are plain `<div>`s and won't appear in tree, but `text` captures them.

### Step 5: Scroll the Chat Panel (Not the Page)

This is where agents typically fail. The page has three scrollable areas:
- `#sessions-list` (sidebar, `overflow-y: auto`)
- `#messages` (main chat, `overflow-y: auto`)
- `#panel-content` (right panel, `overflow-y: auto`)

`slop scroll up/down` scrolls the **page viewport**, which may not scroll the panel you want (the panels have `overflow: hidden` on the parent with individual scroll containers).

**Solution: Use `eval --main` to scroll specific containers:**

```bash
# Scroll chat to top
slop eval "document.getElementById('messages').scrollTop = 0" --tab <TAB_ID> --main

# Scroll chat to bottom
slop eval "document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight" --tab <TAB_ID> --main

# Scroll session list to top
slop eval "document.getElementById('sessions-list').scrollTop = 0" --tab <TAB_ID> --main

# Scroll right panel content
slop eval "document.getElementById('panel-content').scrollTop = 0" --tab <TAB_ID> --main
```

**Key insight:** In multi-panel SPAs, `slop scroll` targets the page viewport. For internal scrollable containers, use `eval` to set `.scrollTop` directly. This is reliable and immediate — no animation, no guessing which panel receives focus.

### Step 6: Test Right Panel Tabs

The right panel tabs (Tasks, Memory, Analytics, Extensions) ARE interactive buttons in `slop tree`. Click them directly:

```bash
# Click Memory tab
slop click e6 --tab <TAB_ID>
sleep 1

# Read the content
slop eval "document.getElementById('panel-content')?.textContent?.slice(0, 300)" --tab <TAB_ID> --main
```

**What you see:**
```
234 entries
project
quickcut-cli-video-intelligence-project
Ron is building quickcut, a Swift CLI for video intelligence...
```

```bash
# Click Analytics tab
slop click e7 --tab <TAB_ID>
sleep 1

slop eval "document.getElementById('panel-content')?.textContent?.slice(0, 300)" --tab <TAB_ID> --main
```

**What you see:**
```
Total (30d): $1880.29
2026-04-05 claude-opus-4-6 $9.14 32,783 tok
2026-04-05 gpt-5.4 $17.54 6,742,199 tok
```

**Key insight:** For tabbed panels where the content is dynamically loaded via API, click the tab → sleep → read content. Use `eval` to read `textContent` from a specific container ID rather than `slop text` (which returns the entire page).

### Step 7: Cleanup

```bash
slop tab close --tab <TAB_ID>
```

---

## Decision Tree for Multi-Panel SPAs

```
Need to interact with an element?
├── Is it in `slop tree`? (buttons, inputs, links, details)
│   └── YES → slop click/type/select by ref (e1, e5, etc.)
├── Is it a styled div with JS handlers? (session items, cards)
│   └── YES → slop eval "document.querySelector('...').click()" --main
└── Need to scroll a specific panel?
    └── YES → slop eval "document.getElementById('container').scrollTop = X" --main
    
Need to read content?
├── Full page text → slop text
├── Specific container → slop eval "el.textContent.slice(0, N)" --main
└── Interactive element structure → slop tree --filter all
```

---

## Common Mistakes to Avoid

| Mistake | Why It Fails | Correct Approach |
|---------|-------------|-----------------|
| `slop scroll up` to scroll chat | Scrolls page viewport, not the chat container | `eval "messages.scrollTop = 0" --main` |
| `slop find "session name"` | Session items have no ARIA role, `find` won't match | `eval "querySelectorAll('.session-item')" --main` |
| `slop eval "el.click()"` without `--main` | Runs in isolated world, page handlers don't fire | Always use `--main` for page interaction |
| `slop screenshot` to verify layout | Wastes time, tree+text gives better data | `slop tree --filter all` + `slop text` |
| Not waiting after click | API fetch + DOM render takes 1-3 seconds | `sleep 2` or `sleep 3` after navigation clicks |
| Using `slop text` for one panel | Returns entire page text, hard to parse | `eval "getElementById('panel-content').textContent"` |

---

## Verified Results

This flow successfully confirmed:
- ✅ Session list renders with names, timestamps, costs (API: `/api/sessions`)
- ✅ Clicking sessions loads entries (API: `/api/sessions/:id/entries/rendered`)
- ✅ Tool call collapsibles render as `<details>` elements
- ✅ Thinking blocks render
- ✅ Right panel tabs all load data (Memory: 234 entries, Analytics: $1,880.29 30d)
- ✅ WebSocket connected (page title includes "Connected")
- ✅ Bun fullstack dev server bundles CSS/JS (bundled asset URLs in source)
