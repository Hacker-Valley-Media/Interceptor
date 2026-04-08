# Use Case: ChatGPT as an Agentic System via SSE Interception

**Date:** 2026-04-08
**Agent:** Cy (Claude)
**Target:** ChatGPT Pro at `https://chatgpt.com` — driven entirely through the browser UI, responses read via intercepted SSE wire protocol. Zero API keys. Zero CDP.

---

## The Vision

Cy (Ron's AI assistant at `~/.cy/`) uses ChatGPT, Claude, Codex, and Gemini as interchangeable execution targets. Conversation state lives in Cy's SQLite — the models are just backends. slop browser is the transport layer:

```
Cy decides what to ask
  → slop type + keys (sends prompt via UI)
  → ChatGPT processes (sentinel tokens, browsing, code execution — all automatic)
  → slop sse log (reads structured SSE response: message IDs, model, tokens, tool calls)
  → Cy parses, decides next step
  → routes to Claude / Codex / back to ChatGPT
```

The key insight: **UI interaction for compliance, API sniffing for rich data.** The page handles all anti-bot (Turnstile, proof-of-work, sentinel tokens). We get the full wire protocol for free.

---

## ChatGPT Wire Protocol Summary

Every `POST /backend-api/f/conversation` returns an SSE stream with delta-encoded JSON patches:

| Event Type | What It Contains |
|-----------|-----------------|
| `resume_conversation_token` | Conduit JWT for stream routing |
| `input_message` | Full user message with metadata, model slug, parent ID |
| `delta` (add) | New message objects (system, user, assistant, tool) |
| `delta` (patch) | Token-by-token appends to `/message/content/parts/0` |
| `message_marker` | `user_visible_token` first/last, `search_start` |
| `title_generation` | Auto-generated conversation title |
| `url_moderation` | Safety checks on cited URLs |
| `server_ste_metadata` | Tool name, model slug, plan type, cluster, timing |
| `message_stream_complete` | Stream done signal |
| `conversation_detail_metadata` | Limits, model defaults, blocked features |
| `[DONE]` | SSE termination marker |

---

## Use Case 1: Structured Data Generation for Cross-Model Pipeline

### Scenario
Cy needs structured cybersecurity incident data for analysis. ChatGPT generates it as JSON. Cy parses and could route to Claude for risk assessment or to Codex for code generation.

### Flow

```bash
# Fresh conversation
slop navigate "https://chatgpt.com/" --tab $TAB
sleep 5

# Find input and send prompt
slop tree --tab $TAB | grep "textbox.*Chat"
# → [e98] textbox "Chat with ChatGPT"

slop type e98 'Use code interpreter. Generate a JSON array of 5 fictional cybersecurity incidents. Each object must have: id (uuid), severity (critical/high/medium/low), type (ransomware/phishing/zero-day/insider/ddos), target_industry, date (ISO 8601), estimated_damage_usd (number), mitre_attack_ids (array of strings). Print the JSON only, no explanation.' --tab $TAB

slop keys "Enter" --tab $TAB

# Wait for completion (code gen takes ~12s)
sleep 15

# Read the SSE response
slop sse log --tab $TAB --filter "f/conversation" --limit 1
```

### What We Captured

```
Duration: 12740ms | Chunks: 65 | Bytes: 21863
Model: gpt-5-3 (resolved to gpt-5-3-instant)
```

**Extracted structured data:**

```json
{
  "id": "3f9c2b6e-5d2e-4b8a-9a1e-7a4f2d9c1e01",
  "severity": "critical",
  "type": "ransomware",
  "target_industry": "healthcare",
  "date": "2026-02-14T09:23:00Z",
  "estimated_damage_usd": 85000000,
  "mitre_attack_ids": ["T1486", "T1027", "T1059"]
}
```

5 records generated with valid UUIDs, ISO dates, and real MITRE ATT&CK technique IDs. Cy can parse this JSON directly and feed it into any downstream model or database.

### Why This Matters for Multi-Model Routing

The response includes metadata an API key user would get:
- `resolved_model_slug`: which model actually answered
- `conversation_id`: for conversation continuity
- `message_id`: for threading
- `token_count`: for cost tracking

Cy stores all of this in its SQLite alongside which model it came from — building a unified conversation history across ChatGPT, Claude, and Codex.

---

## Use Case 2: Multi-Turn Conversation with Code Execution

### Scenario
Turn 1: Generate data. Turn 2: Analyze it. ChatGPT remembers context across turns. The agent reads structured results from both.

### Flow

```bash
# Turn 1: Generate incidents (same as Use Case 1)
# ...

# Turn 2: Analyze the data (same conversation)
slop type e99 "Now use code interpreter to analyze that data: calculate the total estimated damage, count incidents by severity, and find the most common MITRE ATT&CK technique. Return results as JSON." --tab $TAB
slop keys "Enter" --tab $TAB
sleep 25

slop sse log --tab $TAB --filter "f/conversation" --limit 1
```

### What We Captured

```
Duration: 2159ms | Chunks: 9 | Bytes: 8479
```

**ChatGPT's analysis output:**

```json
{
  "total_estimated_damage_usd": 191500000,
  "incidents_by_severity": {
    "critical": 2,
    "high": 2,
    "medium": 1,
    "low": 0
  },
  "most_common_mitre_attack_technique": "T1078"
}
```

### Key Insight

ChatGPT maintained full context from Turn 1 → Turn 2 without any context re-injection from the agent. The SSE stream for Turn 2 didn't repeat the incident data — it just referenced it. The `conversation_id` stayed the same across both turns, and `parent_id` on each message correctly chains to the previous turn.

This means Cy can:
1. Send prompt A to ChatGPT → get structured response
2. Send prompt B to the **same conversation** → ChatGPT has full context
3. Read response B → pipe it to Claude for a different analysis

---

## Use Case 3: Web Search with Source Attribution

### Scenario
Cy needs current information that requires web search. ChatGPT's `SonicBrowserTool` searches the web, and the SSE stream includes full source URLs, snippets, and attribution — not just the text response.

### Flow

```bash
slop navigate "https://chatgpt.com/" --tab $TAB
sleep 5
slop tree --tab $TAB | grep "textbox.*Chat"

slop type e98 'Search the web for the latest RSAC 2026 conference news. Return a JSON array of the top 5 announcements, each with: title, source_url, source_name, date, one_sentence_summary. JSON only.' --tab $TAB
slop keys "Enter" --tab $TAB
sleep 20

slop sse log --tab $TAB --filter "f/conversation" --limit 1
```

### What We Captured

```
Duration: 8733ms | Chunks: 48 | Bytes: 40338
Tool: SonicBrowserTool
```

**From the SSE stream, we got:**

The assistant's text response with 5 RSAC announcements:

```
1. Wave of AI-driven cybersecurity tools unveiled by major vendors (CRN, 2026-03-23)
2. Cisco introduces security innovations for the agentic AI workforce (Cisco Newsroom, 2026-03-23)
3. Innovation Sandbox finalists spotlight next-generation cybersecurity startups (PR Newswire, 2026-02-10)
```

But the SSE stream also gave us **much richer data** that the DOM doesn't show:

- **`url_moderation` events** — every cited URL was safety-checked in real-time
- **`search_result_groups`** — full search results with titles, URLs, snippets, attribution, publication dates, organized by domain (weforum.org, ibm.com, crowdstrike.com, gartner.com, isaca.org, nu.edu)
- **`content_references`** — inline citation markers with exact character offsets, ref indices, and `grouped_webpages` objects containing supporting websites
- **`search_model_queries`** — the actual search query ChatGPT generated: `"cybersecurity trends 2026"`

### Why This Matters

An agent reading `slop text` would get: "Here are the top 5..." with some inline text.

An agent reading `slop sse log` gets: every source URL, every search result ChatGPT considered (not just the ones it cited), publication dates, domain attributions, and the exact search queries used. This is research-grade sourcing that Cy can store, verify, and cross-reference.

---

## Use Case 4: Remote Code Execution as Compute

### Scenario
Cy needs to run Python code but doesn't have a sandboxed environment. ChatGPT's code interpreter becomes a remote compute target — send code, get stdout.

### Flow

```bash
slop type e98 "Run this Python code in your sandbox and show me the output: import sys; print(sys.version); import math; print([math.factorial(i) for i in range(1,16)])" --tab $TAB
slop keys "Enter" --tab $TAB
sleep 20

slop sse log --tab $TAB --filter "f/conversation" --limit 1
```

### What We Captured

```
Duration: 2003ms
Tool: PythonCaasCotTool
```

**Execution output from ChatGPT's sandbox:**

```
3.13.5 (main, Jun 25 2025, 18:55:22) [GCC 14.2.0]
[1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800, 479001600, 6227020800, 87178291200, 1307674368000]
```

We also tested structured JSON output from the sandbox:

```bash
slop type e98 "Use code interpreter: generate a JSON object with keys 'timestamp', 'platform', 'python_version', 'cpu_count', 'hostname', 'random_uuid', and 'pi_to_50_digits'. Print it as formatted JSON." --tab $TAB
slop keys "Enter" --tab $TAB
```

**Result:**

```
Tool: PythonCaasUserVisibleTool
```

```json
{
  "timestamp": "2026-04-08T02:48:01.920290Z",
  "platform": "Linux-4.4.0-x86_64-with-glibc2.41",
  "python_version": "3.13.5",
  "cpu_count": 56,
  "hostname": "b1194392bbbe",
  "random_uuid": "ced15fb7-e3dd-45d7-b93c-61c67cd04ed6",
  "pi_to_50_digits": "3.14159265358979311599796346854418516159057617187500"
}
```

### Key Insight

The SSE stream distinguishes between two code execution tools:
- **`PythonCaasCotTool`** — chain-of-thought code execution (model reasons then runs)
- **`PythonCaasUserVisibleTool`** — direct code execution visible to user

Both produce structured output that Cy can parse. The sandbox runs Python 3.13.5 on a 56-CPU Linux machine — real compute power accessible through the browser UI.

---

## How to Parse ChatGPT SSE Responses

### Extract the assistant's text response

The assistant's text is streamed as delta patches on `/message/content/parts/0`:

```python
text_parts = []
for line in body.split('\n'):
    if not line.strip().startswith('data: '): continue
    payload = line.strip()[6:]
    if payload == '[DONE]': break
    try:
        obj = json.loads(payload)
        if isinstance(obj.get('v'), list):
            for patch in obj['v']:
                if patch.get('p') == '/message/content/parts/0' and patch.get('o') == 'append':
                    text_parts.append(patch['v'])
    except: pass
full_response = ''.join(text_parts)
```

### Extract metadata

```python
for line in body.split('\n'):
    if not line.strip().startswith('data: '): continue
    payload = line.strip()[6:]
    try:
        obj = json.loads(payload)
        if obj.get('type') == 'server_ste_metadata':
            meta = obj['metadata']
            model = meta['model_slug']
            tool = meta['tool_name']
            plan = meta['plan_type']
        if obj.get('type') == 'input_message':
            prompt = obj['input_message']['content']['parts'][0]
            conversation_id = obj['conversation_id']
    except: pass
```

### Check if stream is still active

```bash
slop sse streams --tab $TAB
# Returns [] when done, or [{url, chunks, bytes, duration}] when streaming
```

---

## Common Mistakes to Avoid

| Mistake | Why It Fails | Correct Approach |
|---------|-------------|-----------------|
| `slop text` to read response | Gets rendered markdown, loses message IDs, model info, tool calls, sources | `slop sse log --filter f/conversation` for structured data |
| Not waiting long enough | Code execution takes 5-20s, search takes 5-10s | Poll `slop sse streams` until empty, or sleep conservatively |
| Parsing `slop net log` for responses | SSE bodies were invisible before PRD-15 | Use `slop sse log` — purpose-built for SSE |
| Assuming one stream per prompt | Search prompts may generate multiple tool call messages | Parse all `delta` events, filter by `author.role == "assistant"` |
| Reading `clone().text()` | Blocks until stream ends — defeats real-time use | SSE interception reads chunks as they arrive |

---

## Verified Results

- ✅ Prompt sent via UI → ChatGPT processes with all anti-bot tokens automatically
- ✅ SSE stream captured with full wire protocol (delta patches, metadata, tool calls)
- ✅ Structured JSON output parseable by agent
- ✅ Multi-turn conversation maintains context across turns
- ✅ Web search results include full source URLs, snippets, and attribution
- ✅ Code execution output captured (tool: PythonCaasUserVisibleTool / PythonCaasCotTool)
- ✅ Image generation tool invoked (ImageGenToolTemporal) — tool call visible in SSE
- ✅ Model info extracted: gpt-5-3, gpt-5-3-instant
- ✅ Conversation IDs and message IDs available for threading
- ✅ Zero API keys used — all auth through browser session
- ✅ Zero CDP — no debugger, no yellow bar, no detection surface
- ✅ Page behavior preserved — ChatGPT renders normally while we capture everything
