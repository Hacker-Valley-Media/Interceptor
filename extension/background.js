// extension/src/background/tab-group.ts
var interceptorGroupId = null;
async function ensureInterceptorGroup() {
  if (interceptorGroupId !== null) {
    try {
      await chrome.tabGroups.get(interceptorGroupId);
      return interceptorGroupId;
    } catch {
      interceptorGroupId = null;
    }
  }
  const groups = await chrome.tabGroups.query({ title: "interceptor" });
  if (groups.length > 0) {
    interceptorGroupId = groups[0].id;
    return interceptorGroupId;
  }
  return -1;
}
async function addTabToInterceptorGroup(tabId) {
  let groupId = await ensureInterceptorGroup();
  if (groupId === -1) {
    groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, { title: "interceptor", color: "cyan" });
    interceptorGroupId = groupId;
  } else {
    await chrome.tabs.group({ tabIds: tabId, groupId });
  }
  return groupId;
}
async function isTabInInterceptorGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (interceptorGroupId === null)
    await ensureInterceptorGroup();
  return interceptorGroupId !== null && tab.groupId === interceptorGroupId;
}
var SENSITIVE_ACTIONS = new Set([
  "evaluate",
  "cookies_get",
  "cookies_set",
  "cookies_delete",
  "storage_read",
  "storage_write",
  "storage_delete"
]);
async function verifyTabUrl(tabId, expectedUrl) {
  if (!expectedUrl)
    return null;
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && tab.url !== expectedUrl) {
    return `tab URL changed since last state read — expected ${expectedUrl}, got ${tab.url}`;
  }
  return null;
}
function registerTabGroupListeners() {
  chrome.tabs.onRemoved.addListener(async (_removedTabId) => {
    if (interceptorGroupId === null)
      return;
    try {
      const tabs = await chrome.tabs.query({ groupId: interceptorGroupId });
      if (tabs.length === 0)
        interceptorGroupId = null;
    } catch {
      interceptorGroupId = null;
    }
  });
}

// shared/content-script-retry.ts
function shouldRetryContentScript(error) {
  if (!error)
    return false;
  return error.includes("Receiving end does not exist") || error.includes("Could not establish connection") || error.includes("disconnected port") || error.includes("message channel is closed") || error.includes("no response from content script");
}

// extension/src/background/content-bridge.ts
async function injectContentScript(tabId, frameId) {
  try {
    const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
async function sendToContentScriptOnce(tabId, action, frameId) {
  return new Promise((resolve) => {
    const targetFrame = frameId !== undefined ? frameId : 0;
    chrome.tabs.sendMessage(tabId, { type: "execute_action", action }, { frameId: targetFrame }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response ?? { success: false, error: "no response from content script" });
      }
    });
  });
}
async function sendToContentScript(tabId, action, frameId) {
  const first = await sendToContentScriptOnce(tabId, action, frameId);
  if (first.success || !shouldRetryContentScript(first.error))
    return first;
  const injected = await injectContentScript(tabId, frameId);
  if (!injected.success) {
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`
    };
  }
  const retried = await sendToContentScriptOnce(tabId, action, frameId);
  if (retried.success)
    return retried;
  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but action still failed: ${retried.error || "unknown error"}`
  };
}
async function sendNetDirect(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response ?? { success: false, error: "no response from content script" });
      }
    });
  });
}
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const stage1Timeout = Math.min(timeoutMs, 1e4);
    const hardTimer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      const probeResult = await probeContentReady(tabId, Math.max(timeoutMs - (Date.now() - start), 1000));
      resolve({ ready: probeResult, elapsed: Date.now() - start });
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(hardTimer);
        chrome.tabs.onUpdated.removeListener(listener);
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000);
        probeContentReady(tabId, remaining).then((ready) => {
          resolve({ ready, elapsed: Date.now() - start });
        });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(hardTimer);
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000);
        const ready = await probeContentReady(tabId, remaining);
        resolve({ ready, elapsed: Date.now() - start });
      }
    }, stage1Timeout);
  });
}
async function probeContentReady(tabId, timeoutMs) {
  try {
    const result = await sendToContentScript(tabId, {
      type: "wait_stable",
      ms: 500,
      timeout: Math.min(timeoutMs, 5000)
    });
    return result.success && (result.data?.stable ?? true);
  } catch {
    return false;
  }
}

// extension/src/linkedin/voyager-api-client.ts
async function getLinkedInCsrfToken() {
  try {
    const cookie = await chrome.cookies.get({ url: "https://www.linkedin.com", name: "JSESSIONID" });
    if (!cookie?.value)
      return null;
    return cookie.value.replace(/^"|"$/g, "");
  } catch {
    return null;
  }
}
async function fetchLinkedInJson(url) {
  const csrfToken = await getLinkedInCsrfToken();
  const headers = {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0"
  };
  if (csrfToken)
    headers["csrf-token"] = csrfToken;
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers
    });
    if (!response.ok)
      return null;
    return await response.json();
  } catch {
    return null;
  }
}

// extension/src/linkedin/professional-event-api.ts
async function fetchLinkedInEventDetailsById(eventId) {
  const url = `https://www.linkedin.com/voyager/api/events/dash/professionalEvents?decorationId=com.linkedin.voyager.dash.deco.events.ProfessionalEventDetailPage-49&eventIdentifier=${eventId}&q=eventIdentifier`;
  return await fetchLinkedInJson(url);
}
async function fetchLinkedInEventAttendeesById(eventId, maxCount = 250) {
  const pageSize = 50;
  let start = 0;
  const attendees = [];
  while (start < maxCount) {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(count:${pageSize},start:${start},origin:EVENT_PAGE_CANNED_SEARCH,query:(flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:eventAttending,value:List(${eventId})),(key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))&&queryId=voyagerSearchDashClusters.a789a8e572711844816fa31872de1e2f`;
    const json = await fetchLinkedInJson(url);
    const included = Array.isArray(json?.included) ? json.included : [];
    const pageAttendees = included.filter((item) => item?.$type === "com.linkedin.voyager.dash.search.EntityResultViewModel").map((item) => {
      const entityUrn = item.entityUrn || "";
      const match = String(entityUrn).match(/fsd_profile:([^,)]+)/);
      return {
        user_id: match?.[1] || "",
        display_name: item?.image?.accessibilityText || "",
        headline: item?.primarySubtitle?.text || ""
      };
    }).filter((item) => item.user_id && item.display_name);
    if (!pageAttendees.length)
      break;
    attendees.push(...pageAttendees);
    if (pageAttendees.length < pageSize)
      break;
    start += pageSize;
  }
  return attendees;
}

// extension/src/linkedin/linkedin-shared-types.ts
function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}
function extractLinkedInEventId(url) {
  if (!url)
    return null;
  return url.match(/\/events\/(\d+)/)?.[1] || null;
}
function isNoiseLinkedInUrl(url) {
  return /messaging|policy\/notices|realtimeFrontendSubscriptions|presenceStatuses|deliveryAcknowledgements|seenReceipts|quickReplies|psettings|DVyeH0l6|tracking/i.test(url);
}

// extension/src/linkedin/linkedin-normalized-json-parsing.ts
function stripJsonPrefix(body) {
  return body.replace(/^for\s*\(;;\s*\);?\s*/, "").replace(/^\)\]\}',?\s*/, "").trim();
}
function tryParseJsonBody(body) {
  if (!body)
    return null;
  const cleaned = stripJsonPrefix(body);
  if (!cleaned || !["{", "["].includes(cleaned[0]))
    return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
function walkValues(value, visitor, path = [], seen = new WeakSet) {
  visitor(path.length ? path[path.length - 1] : null, value, path);
  if (!value || typeof value !== "object")
    return;
  if (seen.has(value))
    return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValues(item, visitor, [...path, String(index)], seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walkValues(child, visitor, [...path, key], seen);
  }
}
function collectStringCandidates(value, keyHints) {
  const results = [];
  walkValues(value, (key, current, path) => {
    if (typeof current !== "string" || !key)
      return;
    const lowerKey = key.toLowerCase();
    if (keyHints.some((hint) => lowerKey.includes(hint))) {
      const normalized = current.replace(/\s+/g, " ").trim();
      if (normalized)
        results.push({ key, path, value: normalized });
    }
  });
  return results;
}
function collectNumberCandidates(value, keyHints) {
  const results = [];
  walkValues(value, (key, current, path) => {
    if (!key)
      return;
    const lowerKey = key.toLowerCase();
    if (!keyHints.some((hint) => lowerKey.includes(hint)))
      return;
    if (typeof current === "number" && Number.isFinite(current)) {
      results.push({ key, path, value: current });
      return;
    }
    if (typeof current === "string" && /^\d[\d,]*$/.test(current.trim())) {
      results.push({ key, path, value: parseInt(current.replace(/,/g, ""), 10) });
    }
  });
  return results;
}
function pickBestString(candidates, preferred, fallbackContains) {
  if (!candidates.length)
    return null;
  const preferredNormalized = normalizeText(preferred);
  if (preferredNormalized) {
    const exact = candidates.find((candidate) => normalizeText(candidate.value) === preferredNormalized);
    if (exact)
      return exact.value;
    const contains = candidates.find((candidate) => normalizeText(candidate.value).includes(preferredNormalized) || preferredNormalized.includes(normalizeText(candidate.value)));
    if (contains)
      return contains.value;
  }
  const fallbackNormalized = normalizeText(fallbackContains);
  if (fallbackNormalized) {
    const matched = candidates.find((candidate) => normalizeText(candidate.value).includes(fallbackNormalized));
    if (matched)
      return matched.value;
  }
  return candidates.slice().sort((a, b) => b.value.length - a.value.length)[0].value;
}
function pickBestNumber(candidates, preferred) {
  if (!candidates.length)
    return null;
  if (preferred !== undefined && preferred !== null) {
    const exact = candidates.find((candidate) => candidate.value === preferred);
    if (exact)
      return exact.value;
  }
  return candidates.slice().sort((a, b) => b.value - a.value)[0].value;
}
function toIsoTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10000000000 ? value : value * 1000;
    const date2 = new Date(millis);
    return Number.isNaN(date2.getTime()) ? null : date2.toISOString();
  }
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  if (/^\d{13}$/.test(trimmed))
    return toIsoTimestamp(parseInt(trimmed, 10));
  if (/^\d{10}$/.test(trimmed))
    return toIsoTimestamp(parseInt(trimmed, 10));
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function collectIsoCandidates(value, keyHints) {
  const results = [];
  walkValues(value, (key, current) => {
    if (!key)
      return;
    const lowerKey = key.toLowerCase();
    if (!keyHints.some((hint) => lowerKey.includes(hint)))
      return;
    const iso = toIsoTimestamp(current);
    if (iso)
      results.push(iso);
  });
  return results;
}

// extension/src/linkedin/ugc-post-social-api.ts
function extractFollowerCountFromText(text) {
  if (!text)
    return null;
  const match = text.match(/(\d[\d,]*)\s+followers?/i);
  return match ? parseInt(match[1].replace(/,/g, ""), 10) : null;
}
function extractPostIdFromLogs(entries, postText) {
  const clue = normalizeText(postText).slice(0, 80);
  for (const entry of entries) {
    if (!entry.responseBody)
      continue;
    const body = entry.responseBody;
    if (clue && !normalizeText(body).includes(clue))
      continue;
    const match = body.match(/urn:li:ugcPost:(\d{6,})/);
    if (match)
      return match[1];
  }
  for (const entry of entries) {
    const match = (entry.responseBody || "").match(/urn:li:ugcPost:(\d{6,})/);
    if (match)
      return match[1];
  }
  return null;
}
async function fetchLinkedInReactionsByPostId(postId, maxCount = 100) {
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${maxCount},start:0,threadUrn:${encodeURIComponent(`urn:li:ugcPost:${postId}`)})&&queryId=voyagerSocialDashReactions.9c8a84d441790b2edf06110ed28b675c`;
  const json = await fetchLinkedInJson(url);
  const included = Array.isArray(json?.included) ? json.included : [];
  return included.filter((item) => item?.$type === "com.linkedin.voyager.dash.social.Reaction").map((item) => ({
    user_id: String(item.preDashActorUrn || "").split(":").pop() || "",
    display_name: item?.reactorLockup?.title?.text || "",
    headline: item?.reactorLockup?.subtitle?.text || undefined
  })).filter((item) => item.user_id);
}
async function fetchLinkedInCommentsByPostId(postId, maxCount = 100) {
  const encodedPostId = encodeURIComponent(`urn:li:ugcPost:${postId}`);
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${maxCount},numReplies:100,socialDetailUrn:urn%3Ali%3Afsd_socialDetail%3A%28${encodedPostId}%2C${encodedPostId}%2Curn%3Ali%3AhighlightedReply%3A-%29,sortOrder:RELEVANCE,start:0)&&queryId=voyagerSocialDashComments.053c2a505a15e5561b6df67b905d056a`;
  const json = await fetchLinkedInJson(url);
  const included = Array.isArray(json?.included) ? json.included : [];
  return included.filter((item) => item?.$type === "com.linkedin.voyager.dash.social.Comment").map((item) => ({
    comment_id: item.urn || "",
    user_id: String(item?.commenter?.actor?.["*profileUrn"] || item?.commenter?.actor?.["*companyUrn"] || "").split(":").pop() || "",
    comment_text: item?.commentary?.text || ""
  })).filter((item) => item.comment_id);
}

// extension/src/linkedin/event-page-captured-response-scoring.ts
function pickBestParsedResponse(entries, clues, mode) {
  const parsedEntries = entries.filter((entry) => !isNoiseLinkedInUrl(entry.url)).map((entry) => ({ entry, parsed: tryParseJsonBody(entry.responseBody) })).filter((item) => item.parsed !== null);
  let best = null;
  for (const item of parsedEntries) {
    const haystack = normalizeText(item.entry.responseBody);
    let score = 0;
    if (mode === "event") {
      if (/voyager\/api\/events\/dash\/professionalevents/i.test(item.entry.url))
        score += 120;
      if (clues.eventId && item.entry.url.includes(clues.eventId))
        score += 60;
      if (clues.title && haystack.includes(normalizeText(clues.title)))
        score += 35;
      if (clues.organizerName && haystack.includes(normalizeText(clues.organizerName)))
        score += 20;
      if (/events|event/i.test(item.entry.url))
        score += 15;
    } else {
      if (/voyagerSocialDash(Reactions|Comments)|socialDetailUrn|ugcPost|comment|reaction/i.test(item.entry.url))
        score += 100;
      if (clues.postText && haystack.includes(normalizeText(clues.postText).slice(0, 80)))
        score += 45;
      if (clues.posterName && haystack.includes(normalizeText(clues.posterName)))
        score += 20;
      if (/comment|social|feed|activity|update|ugc|share/i.test(item.entry.url))
        score += 20;
    }
    if (item.entry.status && item.entry.status >= 200 && item.entry.status < 300)
      score += 5;
    if (item.entry.mimeType?.includes("json"))
      score += 5;
    if (!best || score > best.score)
      best = { ...item, score };
  }
  return best ? { entry: best.entry, parsed: best.parsed } : null;
}
function extractEventDataFromParsed(parsed, dom) {
  const titleCandidates = collectStringCandidates(parsed, ["title", "name", "headline", "eventname"]);
  const organizerCandidates = collectStringCandidates(parsed, ["organizer", "owner", "host", "author", "actor", "name", "fullname", "displayname"]);
  const descriptionCandidates = collectStringCandidates(parsed, ["description", "details", "summary", "about", "body"]);
  const attendeeNameCandidates = collectStringCandidates(parsed, ["attendee", "member", "participant", "name", "fullname", "displayname"]);
  const attendeeCountCandidates = collectNumberCandidates(parsed, ["attendeecount", "membercount", "participantcount", "totalattendees", "totalmembers", "count"]);
  const dateCandidates = collectIsoCandidates(parsed, ["start", "end", "time", "date"]);
  return {
    title: pickBestString(titleCandidates, dom.title),
    organizerName: pickBestString(organizerCandidates, dom.organizerName),
    startTimeIso: dateCandidates[0] || null,
    endTimeIso: dateCandidates[1] || null,
    attendeeCount: pickBestNumber(attendeeCountCandidates, dom.attendeeCountFromScreen),
    attendeeNames: attendeeNameCandidates.map((candidate) => candidate.value).filter((value) => /^[A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){0,3}$/.test(value)).filter((value, index, array) => array.indexOf(value) === index).slice(0, 25),
    detailsText: pickBestString(descriptionCandidates, dom.detailsText, normalizeText(dom.detailsText).slice(0, 80))
  };
}
function extractPostDataFromParsed(parsed, dom) {
  const textCandidates = collectStringCandidates(parsed, ["commentary", "text", "message", "description", "body"]);
  const posterCandidates = collectStringCandidates(parsed, ["author", "actor", "owner", "name", "fullname", "displayname"]);
  const followerCountCandidates = collectNumberCandidates(parsed, ["followercount", "followerscount"]);
  const reactionCountCandidates = collectNumberCandidates(parsed, ["reactioncount", "likecount", "likes", "reaction"]);
  const commentCountCandidates = collectNumberCandidates(parsed, ["commentcount", "commentscount", "comments"]);
  const repostCountCandidates = collectNumberCandidates(parsed, ["repostcount", "sharecount", "shares", "reposts"]);
  return {
    postText: pickBestString(textCandidates, dom.post?.text, normalizeText(dom.post?.text).slice(0, 80)),
    posterName: pickBestString(posterCandidates, dom.post?.posterName),
    followerCount: pickBestNumber(followerCountCandidates, extractFollowerCountFromText(dom.post?.followerCountText)),
    likes: pickBestNumber(reactionCountCandidates, dom.post?.engagement?.likes),
    comments: pickBestNumber(commentCountCandidates, dom.post?.engagement?.comments),
    reposts: pickBestNumber(repostCountCandidates, dom.post?.engagement?.reposts)
  };
}
function validateValue(networkValue, domValue) {
  if (networkValue === undefined || networkValue === null || domValue === undefined || domValue === null)
    return null;
  if (typeof networkValue === "number" && typeof domValue === "number")
    return networkValue === domValue;
  const left = normalizeText(String(networkValue));
  const right = normalizeText(String(domValue));
  if (!left || !right)
    return null;
  return left === right || left.includes(right) || right.includes(left);
}

// extension/src/linkedin/event-page-extraction-payload.ts
function extractPosterFollowerCount(visibleText, posterName) {
  if (!visibleText || !posterName)
    return null;
  const escaped = posterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idx = visibleText.search(new RegExp(escaped, "i"));
  if (idx === -1)
    return null;
  const after = visibleText.slice(idx, idx + 500);
  const match = after.match(/(\d[\d,]*)\s+[Ff]ollowers?/);
  return match ? parseInt(match[1].replace(/,/g, ""), 10) : null;
}
async function buildLinkedInEventExtractionPayload(targetUrl, dom, logs) {
  const eventId = extractLinkedInEventId(targetUrl);
  const eventParsed = pickBestParsedResponse(logs, { title: dom.title, organizerName: dom.organizerName, eventId }, "event");
  const postParsed = pickBestParsedResponse(logs, { postText: dom.post?.text, posterName: dom.post?.posterName, eventId }, "post");
  const directEventJson = eventId ? await fetchLinkedInEventDetailsById(eventId) : null;
  const directAttendees = eventId ? await fetchLinkedInEventAttendeesById(eventId) : [];
  const eventData = directEventJson ? extractEventDataFromParsed(directEventJson, dom) : eventParsed ? extractEventDataFromParsed(eventParsed.parsed, dom) : null;
  const postData = postParsed && /ugcPost|social|reaction|comment/i.test(postParsed.entry.url) ? extractPostDataFromParsed(postParsed.parsed, dom) : null;
  const postId = dom.ugcPostId || extractPostIdFromLogs(logs, dom.post?.text || postData?.postText || null);
  const reactionUsers = postId ? await fetchLinkedInReactionsByPostId(postId) : [];
  const commentItems = postId ? await fetchLinkedInCommentsByPostId(postId) : [];
  const attendeeNames = directAttendees.length ? directAttendees.map((item) => item.display_name) : eventData?.attendeeNames?.length ? eventData.attendeeNames : dom.attendeeNamesFromScreen || [];
  const attendeeCount = directAttendees.length > 0 ? directAttendees.length : eventData?.attendeeCount ?? dom.attendeeCountFromScreen ?? null;
  const startTimeIso = dom.startTimeIso || (eventData?.startTimeIso && !eventData.startTimeIso.startsWith("1970-") ? eventData.startTimeIso : null);
  const endTimeIso = dom.endTimeIso || eventData?.endTimeIso || null;
  const likes = reactionUsers.length > 0 ? reactionUsers.length : postData?.likes ?? dom.post?.engagement?.likes ?? null;
  const comments = commentItems.length > 0 ? commentItems.length : postData?.comments ?? dom.post?.engagement?.comments ?? null;
  const repostsFromPreview = dom.visibleTextPreview ? dom.visibleTextPreview.match(/(\d[\d,]*)\s+reposts?/i)?.[1] ? parseInt(dom.visibleTextPreview.match(/(\d[\d,]*)\s+reposts?/i)[1].replace(/,/g, ""), 10) : null : null;
  const reposts = postData?.reposts ?? dom.post?.engagement?.reposts ?? repostsFromPreview ?? null;
  return {
    eventId,
    pageUrl: targetUrl,
    title: eventData?.title || dom.title || null,
    organizerName: eventData?.organizerName || dom.organizerName || null,
    thumbnail: dom.thumbnail || null,
    displayedDateText: dom.displayedDateText || null,
    startTimeIso,
    endTimeIso,
    timeZone: dom.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    attendeeCount,
    attendeeNames,
    attendeeSummaryText: dom.attendeeSummary?.text || null,
    linkedPostText: postData?.postText || dom.post?.text || null,
    posterName: postData?.posterName || dom.post?.posterName || null,
    posterFollowerCount: extractPosterFollowerCount(dom.visibleTextPreview, dom.post?.posterName || dom.organizerName) ?? postData?.followerCount ?? extractFollowerCountFromText(dom.post?.followerCountText) ?? null,
    likes,
    reposts,
    comments,
    threadedComments: comments,
    detailsText: eventData?.detailsText || dom.detailsText || null,
    validation: {
      titleMatchesScreen: validateValue(eventData?.title, dom.title),
      organizerMatchesScreen: validateValue(eventData?.organizerName, dom.organizerName),
      attendeeCountMatchesScreen: validateValue(eventData?.attendeeCount ?? (directAttendees.length > 0 ? directAttendees.length : null), dom.attendeeCountFromScreen),
      postMatchesScreen: validateValue(postData?.postText, dom.post?.text),
      posterMatchesScreen: validateValue(postData?.posterName, dom.post?.posterName),
      detailsMatchScreen: validateValue(eventData?.detailsText, dom.detailsText)
    },
    sources: {
      dom,
      network: {
        capturedRequestCount: logs.length,
        matchedEventUrl: eventParsed?.entry.url || null,
        matchedPostUrl: postParsed?.entry.url || null,
        derivedPostId: postId,
        recentUrls: logs.slice(-15).map((entry) => ({ url: entry.url, method: entry.method, status: entry.status, resourceType: entry.resourceType }))
      },
      directApi: {
        usedEventDetailsEndpoint: !!directEventJson,
        usedAttendeesEndpoint: directAttendees.length > 0,
        usedReactionsEndpoint: reactionUsers.length > 0,
        usedCommentsEndpoint: commentItems.length > 0
      }
    }
  };
}

// extension/src/linkedin/event-attendees-extraction-payload.ts
function buildLinkedInAttendeeCliPayload(input) {
  return {
    eventId: input.eventId,
    pageUrl: input.pageUrl,
    attendeeRequestOverride: {
      enabled: true,
      targetBatchSize: 50,
      rules: input.overrideRules
    },
    attendeeCollection: {
      modalOpened: input.modalOpened,
      totalCount: input.totalCount,
      batchesLoaded: input.batchesLoaded,
      extractedRowCount: input.rows.length
    },
    attendees: input.enrichments.map((enrichment, index) => ({
      row: input.rows[index],
      profile: enrichment
    }))
  };
}

// extension/src/linkedin/event-attendees-request-override.ts
function buildLinkedInEventAttendeeOverrideRules(eventUrlOrId) {
  const eventId = extractLinkedInEventId(eventUrlOrId) || eventUrlOrId;
  return [
    {
      urlPattern: `*voyager/api/graphql*eventAttending*${eventId}*`,
      queryAddOrReplace: { count: 50 }
    },
    {
      urlPattern: "*voyager/api/graphql*eventAttending*",
      queryAddOrReplace: { count: 50 }
    }
  ];
}

// extension/src/linkedin/attendee-profile-enrichment.ts
async function fetchLinkedInUserProfileById(userId) {
  return await fetchLinkedInJson(`https://www.linkedin.com/voyager/api/identity/profiles/${userId}/profileView`);
}
async function fetchLinkedInProfileCardsByUserId(userId) {
  return await fetchLinkedInJson(`https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(profileUrn:urn%3Ali%3Afsd_profile%3A${userId})&&queryId=voyagerIdentityDashProfileCards.839ec4cbe3e3c8c7c0b797846b3f1e8a`);
}
async function fetchLinkedInCompanyDetails(companyIds) {
  if (!companyIds.length)
    return null;
  const formatted = companyIds.map((id) => `urn%3Ali%3Afsd_company%3A${id}`);
  return await fetchLinkedInJson(`https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(companyUrns:List(${formatted.join(",")}))&queryId=voyagerOrganizationDashCompanies.40ca6d38ebc1b50aa46eb5d9ee4b55b8`);
}
function parseProfileBasics(data, userId) {
  const profile = data?.included?.find((item) => item.$type === "com.linkedin.voyager.identity.profile.Profile");
  if (!profile) {
    return {
      userId,
      fullName: null,
      firstName: null,
      lastName: null,
      headline: null,
      location: null,
      about: null,
      followerCount: null
    };
  }
  const firstName = profile.firstName || null;
  const lastName = profile.lastName || null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const locationParts = [profile.geoLocationName, profile.geoCountryName].filter(Boolean);
  return {
    userId,
    fullName,
    firstName,
    lastName,
    headline: profile.headline || null,
    location: locationParts.length ? locationParts.join(", ") : profile.locationName || null,
    about: profile.summary || profile.about || null,
    followerCount: typeof profile.followersCount === "number" ? profile.followersCount : null
  };
}
function parseExperience(cards) {
  const results = [];
  const included = Array.isArray(cards?.included) ? cards.included : [];
  for (const item of included) {
    if (!String(item?.entityUrn || "").includes(",EXPERIENCE,"))
      continue;
    const components = item?.topComponents?.[1]?.components?.fixedListComponent?.components || [];
    for (const component of components) {
      const entity = component?.components?.entityComponent;
      const companyLogoUrn = entity?.image?.attributes?.[0]?.detailData?.["*companyLogo"] || "";
      const companyId = companyLogoUrn ? String(companyLogoUrn).split(":").pop() || null : null;
      let title = entity?.titleV2?.text?.text || null;
      let company = entity?.subtitle?.text || null;
      const promotedCompany = entity?.subComponents?.components?.[0]?.components?.entityComponent?.titleV2?.text?.text;
      const promotedTitle = entity?.subComponents?.components?.[0]?.components?.entityComponent?.titleV2?.text?.accessibilityText;
      if (promotedCompany)
        company = String(promotedCompany).split(" · ")[0];
      if (promotedTitle)
        title = promotedTitle;
      if (company)
        company = String(company).split(" · ")[0];
      results.push({ title, company, companyId });
    }
  }
  return results;
}
function parseCompanyDetails(data) {
  const included = Array.isArray(data?.included) ? data.included : [];
  const companies = [];
  for (const item of included) {
    if (item?.$type !== "com.linkedin.voyager.dash.organization.Company")
      continue;
    companies.push({
      id: String(item.entityUrn || "").split(":").pop() || "",
      name: item.name || "",
      headquarter: item.headquarter ? {
        city: item.headquarter.address?.city,
        country: item.headquarter.address?.country,
        geographicArea: item.headquarter.address?.geographicArea,
        line1: item.headquarter.address?.line1,
        line2: item.headquarter.address?.line2,
        postalCode: item.headquarter.address?.postalCode,
        description: item.headquarter.description
      } : null,
      websiteUrl: item.websiteUrl || null,
      followerCount: typeof item.followerCount === "number" ? item.followerCount : null
    });
  }
  return companies;
}
function parseRecentActivity(data) {
  const included = Array.isArray(data?.included) ? data.included : [];
  const posts = [];
  for (const item of included) {
    if (item?.$type !== "com.linkedin.voyager.dash.search.EntityResultViewModel")
      continue;
    if (!String(item.trackingUrn || "").startsWith("urn:li:activity:"))
      continue;
    const postId = String(item.trackingUrn).split(":").pop() || "";
    const counts = included.find((candidate) => candidate?.$type === "com.linkedin.voyager.dash.feed.SocialActivityCounts" && String(candidate.preDashEntityUrn || "").includes(postId));
    posts.push({
      postId,
      caption: item.summary?.text || null,
      numLikes: typeof counts?.numLikes === "number" ? counts.numLikes : null,
      numComments: typeof counts?.numComments === "number" ? counts.numComments : null
    });
  }
  return posts;
}
async function enrichLinkedInAttendee(attendee) {
  if (!attendee.userId) {
    return {
      userId: attendee.userId,
      profileUrl: attendee.profileUrl,
      profileSlug: attendee.profileSlug,
      fullName: attendee.fullName,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      headline: attendee.headline,
      location: null,
      about: null,
      followerCount: null,
      currentExperience: [],
      companyDetails: [],
      recentActivity: []
    };
  }
  const [profileView, profileCards, profileSearch] = await Promise.all([
    fetchLinkedInUserProfileById(attendee.userId),
    fetchLinkedInProfileCardsByUserId(attendee.userId),
    fetchLinkedInJson(`https://www.linkedin.com/voyager/api/graphql?variables=(start:0,origin:ENTITY_SEARCH_HOME_HISTORY,query:(keywords:Security,flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:heroEntityKey,value:List(urn%3Ali%3Afsd_profile%3A${attendee.userId})),(key:resultType,value:List(ALL))),includeFiltersInResponse:false))&queryId=voyagerSearchDashClusters.f0c4f21d8a526c4a5dd0ae253c9b6e02`)
  ]);
  const basics = parseProfileBasics(profileView, attendee.userId);
  const currentExperience = parseExperience(profileCards);
  const uniqueCompanyIds = Array.from(new Set(currentExperience.map((item) => item.companyId).filter(Boolean)));
  const companyDetails = parseCompanyDetails(await fetchLinkedInCompanyDetails(uniqueCompanyIds));
  const recentActivity = parseRecentActivity(profileSearch);
  return {
    userId: attendee.userId,
    profileUrl: attendee.profileUrl,
    profileSlug: attendee.profileSlug,
    fullName: basics.fullName || attendee.fullName,
    firstName: basics.firstName || attendee.firstName,
    lastName: basics.lastName || attendee.lastName,
    headline: basics.headline || attendee.headline,
    location: basics.location,
    about: basics.about,
    followerCount: basics.followerCount,
    currentExperience,
    companyDetails,
    recentActivity
  };
}

// extension/src/background/linkedin-orchestration.ts
async function buildLinkedInEventExtraction(tabId, action) {
  const currentTab = await chrome.tabs.get(tabId);
  const targetUrl = action.url || currentTab.url || "";
  if (!targetUrl)
    return { success: false, error: "linkedin event extraction requires a URL or active tab URL" };
  if (currentTab.url !== targetUrl) {
    await chrome.tabs.update(tabId, { url: targetUrl });
    await waitForTabLoad(tabId, 20000);
  }
  const waitMs = action.waitMs || 500;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await sendToContentScript(tabId, { type: "wait_stable", ms: 800, timeout: 6000 });
  const domResult = await sendToContentScript(tabId, { type: "linkedin_event_dom" });
  if (!domResult.success || !domResult.data) {
    return { success: false, error: domResult.error || "failed to extract LinkedIn DOM data" };
  }
  const netResult = await sendNetDirect(tabId, { type: "get_net_log", filter: "linkedin.com" });
  const passiveEntries = netResult.success && netResult.data ? netResult.data : [];
  const logs = passiveEntries.map((e, i) => ({
    tabId,
    requestId: `passive-${i}`,
    url: e.url,
    method: e.method,
    timestamp: e.timestamp,
    status: e.status,
    mimeType: e.url.includes("json") || e.body?.startsWith("{") || e.body?.startsWith("[") ? "application/json" : undefined,
    responseBody: e.body
  }));
  return {
    success: true,
    data: await buildLinkedInEventExtractionPayload(targetUrl, domResult.data, logs)
  };
}
async function buildLinkedInAttendeesExtraction(tabId, action) {
  const currentTab = await chrome.tabs.get(tabId);
  const targetUrl = action.url || currentTab.url || "";
  if (!targetUrl)
    return { success: false, error: "linkedin attendee extraction requires a URL or active tab URL" };
  const eventId = extractLinkedInEventId(targetUrl);
  if (!eventId)
    return { success: false, error: "could not derive LinkedIn event ID from URL" };
  const overrideRules = buildLinkedInEventAttendeeOverrideRules(targetUrl);
  await sendNetDirect(tabId, { type: "set_net_overrides", rules: overrideRules });
  if (currentTab.url !== targetUrl) {
    await chrome.tabs.update(tabId, { url: targetUrl });
    await waitForTabLoad(tabId, 20000);
  }
  const waitMs = action.waitMs || 500;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await sendToContentScript(tabId, { type: "wait_stable", ms: 800, timeout: 6000 });
  const openResult = await sendToContentScript(tabId, { type: "linkedin_attendees_open" });
  const modalOpened = !!(openResult.success && openResult.data?.opened);
  const modalRows = new Map;
  let totalCount = null;
  let batchesLoaded = 0;
  if (modalOpened) {
    batchesLoaded = 1;
    for (let i = 0;i < 10; i++) {
      const snapshot = await sendToContentScript(tabId, { type: "linkedin_attendees_snapshot" });
      if (!snapshot.success || !snapshot.data?.isOpen)
        break;
      totalCount = snapshot.data.totalCount ?? totalCount;
      for (const row of snapshot.data.rows || []) {
        const key = row.profileUrl || row.fullName || `${row.rowText}-${modalRows.size}`;
        if (!modalRows.has(key))
          modalRows.set(key, row);
      }
      if (!snapshot.data.showMoreVisible)
        break;
      const showMore = await sendToContentScript(tabId, { type: "linkedin_attendees_show_more" });
      if (!showMore.success || !showMore.data?.clicked)
        break;
      batchesLoaded += 1;
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }
  const apiAttendees = await fetchLinkedInEventAttendeesById(eventId, Math.max(totalCount || 0, 250));
  const modalRowsList = Array.from(modalRows.values());
  const mergedRows = apiAttendees.map((attendee) => {
    const modalMatch = modalRowsList.find((row) => normalizeText(row.fullName) === normalizeText(attendee.display_name));
    const fullName = modalMatch?.fullName || attendee.display_name || null;
    const nameParts = fullName ? fullName.trim().split(/\s+/) : [];
    return {
      profileUrl: modalMatch?.profileUrl || null,
      profileSlug: modalMatch?.profileSlug || null,
      fullName,
      firstName: modalMatch?.firstName || (nameParts[0] || null),
      lastName: modalMatch?.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : null),
      connectionDegree: modalMatch?.connectionDegree || null,
      headline: modalMatch?.headline || attendee.headline || null,
      rowText: modalMatch?.rowText || "",
      userId: attendee.user_id || null
    };
  });
  const enrichLimit = action.enrichLimit || mergedRows.length;
  const enrichTargets = mergedRows.slice(0, enrichLimit);
  const enrichments = [];
  for (const row of enrichTargets) {
    enrichments.push(await enrichLinkedInAttendee(row));
  }
  await sendNetDirect(tabId, { type: "clear_net_overrides" });
  return {
    success: true,
    data: buildLinkedInAttendeeCliPayload({
      eventId,
      pageUrl: targetUrl,
      modalOpened,
      totalCount,
      batchesLoaded,
      overrideRules,
      rows: enrichTargets,
      enrichments
    })
  };
}

// extension/src/background/network-capture.ts
var NETWORK_LOG_LIMIT = 250;
var NETWORK_BODY_LIMIT = 120000;
var networkCaptureConfigs = new Map;
var networkCaptureLogs = new Map;
var pendingNetworkEntries = new Map;
var networkOverrideConfigs = new Map;
var fetchInterceptionEnabled = new Set;
function networkEntryKey(tabId, requestId) {
  return `${tabId}:${requestId}`;
}
function getNetworkLogs(tabId) {
  const logs = networkCaptureLogs.get(tabId);
  if (logs)
    return logs;
  const next = [];
  networkCaptureLogs.set(tabId, next);
  return next;
}
function clearNetworkLogs(tabId) {
  networkCaptureLogs.set(tabId, []);
  for (const key of Array.from(pendingNetworkEntries.keys())) {
    if (key.startsWith(`${tabId}:`))
      pendingNetworkEntries.delete(key);
  }
}
function appendNetworkLog(tabId, entry) {
  const logs = getNetworkLogs(tabId);
  logs.push(entry);
  if (logs.length > NETWORK_LOG_LIMIT)
    logs.splice(0, logs.length - NETWORK_LOG_LIMIT);
}
function truncateBody(body) {
  if (!body)
    return body;
  return body.length > NETWORK_BODY_LIMIT ? body.slice(0, NETWORK_BODY_LIMIT) + `
... (truncated)` : body;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchesCapturePatterns(url, patterns) {
  if (!patterns.length)
    return true;
  return patterns.some((pattern) => {
    const regex = new RegExp(escapeRegExp(pattern).replace(/\\\*/g, ".*"), "i");
    return regex.test(url);
  });
}
function matchesRequestMethod(method, allowed) {
  if (!allowed || !allowed.length)
    return true;
  if (!method)
    return false;
  return allowed.map((item) => item.toUpperCase()).includes(method.toUpperCase());
}
function matchesRequestResourceType(resourceType, allowed) {
  if (!allowed || !allowed.length)
    return true;
  if (!resourceType)
    return false;
  return allowed.map((item) => item.toLowerCase()).includes(resourceType.toLowerCase());
}
function findMatchingNetworkOverrideRule(url, method, resourceType, rules) {
  for (const rule of rules) {
    if (rule.urlPattern && !matchesCapturePatterns(url, [rule.urlPattern]))
      continue;
    if (!matchesRequestMethod(method, rule.methods))
      continue;
    if (!matchesRequestResourceType(resourceType, rule.resourceTypes))
      continue;
    return rule;
  }
  return null;
}
function applyNetworkOverrideRule(request, _resourceType, rule) {
  const nextUrl = new URL(rule.replaceUrl || request.url);
  if (rule.queryRemove?.length) {
    for (const key of rule.queryRemove)
      nextUrl.searchParams.delete(key);
  }
  if (rule.queryAddOrReplace) {
    for (const [key, value] of Object.entries(rule.queryAddOrReplace)) {
      nextUrl.searchParams.set(key, String(value));
    }
  }
  const headerMap = new Map;
  for (const [name, value] of Object.entries(request.headers || {})) {
    headerMap.set(name.toLowerCase(), String(value));
  }
  if (rule.removeHeaders?.length) {
    for (const header of rule.removeHeaders)
      headerMap.delete(header.toLowerCase());
  }
  if (rule.setHeaders) {
    for (const [name, value] of Object.entries(rule.setHeaders))
      headerMap.set(name.toLowerCase(), value);
  }
  const headers = Array.from(headerMap.entries()).map(([name, value]) => ({ name, value }));
  const postData = rule.postData !== undefined ? rule.postData : request.postData;
  return {
    url: nextUrl.toString() !== request.url ? nextUrl.toString() : undefined,
    headers,
    postData
  };
}
async function ensureDebuggerSession(tabId) {
  if (debuggerAttached.has(tabId))
    return;
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerAttached.add(tabId);
}
async function refreshFetchInterception(tabId) {
  const hasOverrides = (networkOverrideConfigs.get(tabId)?.length || 0) > 0;
  await ensureDebuggerSession(tabId);
  if (hasOverrides && !fetchInterceptionEnabled.has(tabId)) {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }]
    });
    fetchInterceptionEnabled.add(tabId);
    return;
  }
  if (!hasOverrides && fetchInterceptionEnabled.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Fetch.disable");
    } catch {}
    fetchInterceptionEnabled.delete(tabId);
  }
}
async function enableNetworkCapture(tabId, patterns) {
  await ensureDebuggerSession(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
    maxTotalBufferSize: 1e7,
    maxResourceBufferSize: 2000000
  });
  networkCaptureConfigs.set(tabId, { enabled: true, patterns, startedAt: Date.now() });
  clearNetworkLogs(tabId);
}
async function disableNetworkCapture(tabId) {
  networkCaptureConfigs.set(tabId, {
    enabled: false,
    patterns: networkCaptureConfigs.get(tabId)?.patterns || [],
    startedAt: networkCaptureConfigs.get(tabId)?.startedAt || Date.now()
  });
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.disable");
  } catch {}
}

// extension/src/background/cdp.ts
var debuggerAttached = new Set;
async function cdpCommand(tabId, method, params) {
  const target = { tabId };
  const isAttached = debuggerAttached.has(tabId);
  if (!isAttached) {
    await chrome.debugger.attach(target, "1.3");
    debuggerAttached.add(tabId);
  }
  try {
    const result = await chrome.debugger.sendCommand(target, method, params);
    return result;
  } finally {
    if (!isAttached) {
      try {
        await chrome.debugger.detach(target);
        debuggerAttached.delete(tabId);
      } catch {}
    }
  }
}
async function cdpAttachActDetach(tabId, method, params) {
  try {
    const result = await cdpCommand(tabId, method, params);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
function registerCdpListeners() {
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId)
      return;
    const config = networkCaptureConfigs.get(tabId);
    const overrideRules = networkOverrideConfigs.get(tabId) || [];
    try {
      if (method === "Fetch.requestPaused") {
        const request = params.request || {};
        const rule = findMatchingNetworkOverrideRule(request.url || "", request.method, params.resourceType, overrideRules);
        const payload = rule ? applyNetworkOverrideRule(request, params.resourceType, rule) : {};
        await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", {
          requestId: params.requestId,
          ...payload.url ? { url: payload.url } : {},
          ...payload.headers ? { headers: payload.headers } : {},
          ...payload.postData ? { postData: payload.postData } : {}
        });
        return;
      }
      if (!config?.enabled)
        return;
      if (method === "Network.requestWillBeSent") {
        const request = params.request;
        if (!request?.url || !matchesCapturePatterns(request.url, config.patterns))
          return;
        pendingNetworkEntries.set(networkEntryKey(tabId, params.requestId), {
          tabId,
          requestId: params.requestId,
          url: request.url,
          method: request.method || "GET",
          resourceType: params.type,
          timestamp: Date.now(),
          requestHeaders: request.headers,
          requestPostData: truncateBody(request.postData)
        });
        return;
      }
      if (method === "Network.responseReceived") {
        const requestId = params.requestId;
        const existing = pendingNetworkEntries.get(networkEntryKey(tabId, requestId));
        if (!existing)
          return;
        const response = params.response || {};
        existing.status = response.status;
        existing.mimeType = response.mimeType;
        existing.responseHeaders = response.headers;
        return;
      }
      if (method === "Network.loadingFinished") {
        const requestId = params.requestId;
        const key = networkEntryKey(tabId, requestId);
        const existing = pendingNetworkEntries.get(key);
        if (!existing)
          return;
        try {
          const bodyResult = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId });
          existing.responseBody = bodyResult.base64Encoded ? "[base64 body omitted]" : truncateBody(bodyResult.body);
        } catch {}
        appendNetworkLog(tabId, { ...existing });
        pendingNetworkEntries.delete(key);
        return;
      }
      if (method === "Network.loadingFailed") {
        const requestId = params.requestId;
        const key = networkEntryKey(tabId, requestId);
        const existing = pendingNetworkEntries.get(key);
        if (!existing)
          return;
        existing.errorText = params.errorText || "loading failed";
        appendNetworkLog(tabId, { ...existing });
        pendingNetworkEntries.delete(key);
      }
    } catch (err) {
      console.error("network capture error:", err.message);
    }
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) {
      debuggerAttached.delete(source.tabId);
      fetchInterceptionEnabled.delete(source.tabId);
      networkCaptureConfigs.delete(source.tabId);
      networkOverrideConfigs.delete(source.tabId);
      clearNetworkLogs(source.tabId);
    }
    if (reason === "canceled_by_user") {
      console.log("debugger detached by user (DevTools opened)");
    }
  });
}

// extension/src/background/capabilities/os-input.ts
async function handleOsInputActions(action, tabId) {
  switch (action.type) {
    case "os_click": {
      const win = await chrome.windows.getCurrent();
      const windowBounds = {
        left: win.left || 0,
        top: win.top || 0,
        width: win.width || 0,
        height: win.height || 0
      };
      let pageX = action.x;
      let pageY = action.y;
      if ((action.index !== undefined || action.ref) && (pageX === undefined || pageY === undefined)) {
        const rectResult = await sendToContentScript(tabId, {
          type: "rect",
          index: action.index,
          ref: action.ref
        });
        if (!rectResult.success || !rectResult.data) {
          return { success: false, error: "failed to get element coordinates for os_click" };
        }
        const rect = rectResult.data;
        pageX = rect.left + rect.width / 2;
        pageY = rect.top + rect.height / 2;
      }
      if (pageX === undefined || pageY === undefined) {
        return { success: false, error: "os_click requires element target or x,y coordinates" };
      }
      const chromeUiHeight = action.chromeUiHeight || 88 + (debuggerAttached.has(tabId) ? 35 : 0);
      return {
        success: true,
        data: {
          method: "os_event",
          screenTarget: { pageX, pageY },
          windowBounds,
          button: action.button || "left",
          clickCount: action.clickCount || 1,
          chromeUiHeight
        }
      };
    }
    case "os_key":
      return { success: true, data: { method: "os_event", key: action.key, modifiers: action.modifiers || [] } };
    case "os_type": {
      if (action.index !== undefined || action.ref) {
        await sendToContentScript(tabId, { type: "focus", index: action.index, ref: action.ref });
        await new Promise((r) => setTimeout(r, 50));
      }
      return { success: true, data: { method: "os_event", text: action.text } };
    }
    case "os_move": {
      const win = await chrome.windows.getCurrent();
      const windowBounds = {
        left: win.left || 0,
        top: win.top || 0,
        width: win.width || 0,
        height: win.height || 0
      };
      const chromeUiHeight = action.chromeUiHeight || 88 + (debuggerAttached.has(tabId) ? 35 : 0);
      return {
        success: true,
        data: {
          method: "os_event",
          path: action.path,
          windowBounds,
          duration: action.duration || 100,
          chromeUiHeight
        }
      };
    }
  }
  return { success: false, error: `unknown os_input action: ${action.type}` };
}

// extension/src/background/offscreen.ts
var OFFSCREEN_IDLE_MS = 30000;
var offscreenIdleTimer = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length > 0) {
    resetOffscreenTimer();
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Image crop, stitch, and diff operations"
  });
  resetOffscreenTimer();
}
function resetOffscreenTimer() {
  if (offscreenIdleTimer)
    clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
    offscreenIdleTimer = null;
  }, OFFSCREEN_IDLE_MS);
}
async function sendToOffscreen(msg) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "offscreen" }, resolve);
  });
}

// extension/src/background/capabilities/screenshot.ts
async function handleScreenshotBackground(action, tabId) {
  const format = action.format === "png" ? "image/png" : "image/jpeg";
  const quality = (action.quality || 50) / 100;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Background tab screenshot via tabCapture"
      });
    }
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId }, () => resolve());
    });
    await new Promise((r) => setTimeout(r, 300));
    const frameResult = await sendToOffscreen({
      type: "capture_frame",
      format,
      quality
    });
    await sendToOffscreen({ type: "capture_stop" });
    if (!frameResult.success)
      return { success: false, error: frameResult.error || "capture frame failed" };
    const dataUrl = frameResult.data;
    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
    return { success: true, data: { dataUrl, format: action.format || "jpeg", size: sizeBytes, method: "tabCapture" } };
  } catch (err) {
    return { success: false, error: `tabCapture failed: ${err.message}` };
  }
}
async function handleScreenshotActions(action, tabId) {
  switch (action.type) {
    case "screenshot_background":
      return handleScreenshotBackground(action, tabId);
    case "page_capture": {
      const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId });
      const text = await mhtml.text();
      return { success: true, data: { size: text.length, preview: text.slice(0, 500) } };
    }
    case "screenshot": {
      const format = action.format === "png" ? "png" : "jpeg";
      const quality = action.quality || 50;
      if (action.full) {
        const dims = await sendToContentScript(tabId, { type: "get_page_dimensions" });
        if (!dims.success || !dims.data)
          return { success: false, error: "failed to get page dimensions" };
        const { scrollHeight, viewportHeight, viewportWidth, scrollY: origScrollY, devicePixelRatio } = dims.data;
        const stripCount = Math.ceil(scrollHeight / viewportHeight);
        const strips = [];
        for (let i = 0;i < stripCount; i++) {
          const scrollTo = i * viewportHeight;
          await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo });
          await new Promise((r) => setTimeout(r, 150));
          const stripUrl = await chrome.tabs.captureVisibleTab({ format, quality });
          strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) });
          if (i < stripCount - 1)
            await new Promise((r) => setTimeout(r, 500));
        }
        await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY });
        const stitchResult = await sendToOffscreen({
          type: "stitch",
          strips,
          totalWidth: Math.round(viewportWidth * devicePixelRatio),
          totalHeight: Math.round(scrollHeight * devicePixelRatio),
          format,
          quality: quality / 100
        });
        if (!stitchResult.success)
          return { success: false, error: stitchResult.error };
        const stitchedUrl = stitchResult.data;
        const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75);
        if (action.save) {
          return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, save: true, strips: stripCount } };
        }
        return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, strips: stripCount } };
      }
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab({ format, quality });
      } catch {
        const fallback = await handleScreenshotBackground({ type: "screenshot_background", format: action.format, quality: action.quality }, tabId);
        if (fallback.success && fallback.data) {
          fallback.data.fallback = "tabCapture (captureVisibleTab failed)";
        }
        return fallback;
      }
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      if (action.save) {
        return { success: true, data: { dataUrl, format, size: sizeBytes, save: true } };
      }
      let clip = action.clip;
      if (!clip && action.element !== undefined) {
        const elemResult = await sendToContentScript(tabId, {
          type: "rect",
          index: action.element
        });
        if (elemResult.success && elemResult.data)
          clip = elemResult.data;
      }
      if (clip) {
        const cropResult = await sendToOffscreen({ type: "crop", dataUrl, clip });
        if (!cropResult.success)
          return { success: false, error: cropResult.error };
        const croppedUrl = cropResult.data;
        const croppedSize = Math.round((croppedUrl.length - croppedUrl.indexOf(",") - 1) * 0.75);
        return { success: true, data: { dataUrl: croppedUrl, format, size: croppedSize, clip } };
      }
      if (format === "png" && sizeBytes > 800 * 1024) {
        return {
          success: true,
          data: { dataUrl, format, size: sizeBytes, warning: "PNG exceeds 800KB — consider using JPEG for smaller responses" }
        };
      }
      return { success: true, data: { dataUrl, format, size: sizeBytes } };
    }
  }
  return { success: false, error: `unknown screenshot action: ${action.type}` };
}

// extension/src/background/capabilities/capture-stream.ts
async function handleCaptureStreamActions(action, tabId) {
  switch (action.type) {
    case "capture_start": {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"]
      });
      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA"],
          justification: "Tab capture stream processing"
        });
      }
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId });
      return { success: true, data: { streamId, tabId } };
    }
    case "capture_frame": {
      const fmt = action.format === "png" ? "image/png" : "image/jpeg";
      const qual = action.quality || 50;
      const frameResult = await sendToOffscreen({
        type: "capture_frame",
        format: fmt,
        quality: qual / 100
      });
      if (!frameResult.success)
        return { success: false, error: frameResult.error };
      return { success: true, data: { dataUrl: frameResult.data } };
    }
    case "capture_stop": {
      await sendToOffscreen({ type: "capture_stop" });
      try {
        await chrome.offscreen.closeDocument();
      } catch {}
      return { success: true };
    }
    case "canvas_diff": {
      const diffResult = await sendToOffscreen({
        type: "diff",
        image1: action.image1,
        image2: action.image2,
        threshold: action.threshold || 0,
        returnImage: action.returnImage || false
      });
      if (!diffResult.success)
        return { success: false, error: diffResult.error };
      return { success: true, data: diffResult.data };
    }
  }
  return { success: false, error: `unknown capture action: ${action.type}` };
}

// extension/src/background/capabilities/canvas.ts
async function handleCanvasActions(action, tabId) {
  switch (action.type) {
    case "canvas_list": {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const canvases = Array.from(document.querySelectorAll("canvas"));
          function walkShadowRoots(root) {
            const found = [];
            const children = Array.from(root.children);
            for (const child of children) {
              if (child.tagName === "CANVAS")
                found.push(child);
              const shadow = child.shadowRoot;
              if (shadow)
                found.push(...walkShadowRoots(shadow));
              found.push(...walkShadowRoots(child));
            }
            return found;
          }
          const shadowCanvases = walkShadowRoots(document.body);
          const all = [...new Set([...canvases, ...shadowCanvases])];
          return all.map((c, i) => {
            const rect = c.getBoundingClientRect();
            let contextType = "none";
            try {
              if (c.getContext("2d"))
                contextType = "2d";
              else if (c.getContext("webgl2"))
                contextType = "webgl2";
              else if (c.getContext("webgl"))
                contextType = "webgl";
              else if (c.getContext("bitmaprenderer"))
                contextType = "bitmaprenderer";
            } catch {}
            const style = getComputedStyle(c);
            const hidden = style.display === "none" || style.visibility === "hidden" || c.width === 0 && c.height === 0;
            return {
              index: i,
              width: c.width,
              height: c.height,
              cssWidth: rect.width,
              cssHeight: rect.height,
              x: rect.x,
              y: rect.y,
              contextType,
              hidden,
              id: c.id || undefined,
              className: c.className || undefined
            };
          });
        }
      });
      return { success: true, data: results[0]?.result ?? [] };
    }
    case "canvas_read": {
      const canvasIdx = action.canvasIndex;
      const fmt = action.format === "png" ? "image/png" : "image/jpeg";
      const qual = action.quality || 0.5;
      const region = action.region;
      const isWebgl = action.webgl;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [canvasIdx, fmt, qual, region ?? null, isWebgl ?? false],
        func: (idx, format, quality, reg, webgl) => {
          const canvases = Array.from(document.querySelectorAll("canvas"));
          const c = canvases[idx];
          if (!c)
            return { success: false, error: `no canvas at index ${idx}` };
          try {
            if (reg) {
              const ctx = c.getContext("2d");
              if (!ctx)
                return { success: false, error: "canvas has no 2d context for region read" };
              const data = ctx.getImageData(reg.x, reg.y, reg.width, reg.height);
              const tmpCanvas = document.createElement("canvas");
              tmpCanvas.width = reg.width;
              tmpCanvas.height = reg.height;
              const tmpCtx = tmpCanvas.getContext("2d");
              tmpCtx.putImageData(data, 0, 0);
              return { success: true, data: tmpCanvas.toDataURL(format, quality) };
            }
            if (webgl) {
              const gl = c.getContext("webgl2") || c.getContext("webgl");
              if (!gl)
                return { success: false, error: "canvas has no webgl context" };
              const pixels = new Uint8Array(c.width * c.height * 4);
              gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              const tmpCanvas = document.createElement("canvas");
              tmpCanvas.width = c.width;
              tmpCanvas.height = c.height;
              const tmpCtx = tmpCanvas.getContext("2d");
              const imageData = tmpCtx.createImageData(c.width, c.height);
              for (let row = 0;row < c.height; row++) {
                const srcOff = row * c.width * 4;
                const dstOff = (c.height - 1 - row) * c.width * 4;
                imageData.data.set(pixels.subarray(srcOff, srcOff + c.width * 4), dstOff);
              }
              tmpCtx.putImageData(imageData, 0, 0);
              return { success: true, data: tmpCanvas.toDataURL(format, quality) };
            }
            return { success: true, data: c.toDataURL(format, quality) };
          } catch (e) {
            if (e.message?.includes("tainted"))
              return { success: false, error: "canvas is tainted (cross-origin content)" };
            return { success: false, error: e.message };
          }
        }
      });
      const res = results[0]?.result;
      if (!res)
        return { success: false, error: "no result from canvas read" };
      if (!res.success)
        return { success: false, error: res.error };
      const dataUrl = res.data;
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      if (sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, size: sizeBytes, warning: "Response exceeds 800KB — consider JPEG or smaller region" } };
      }
      return { success: true, data: { dataUrl, size: sizeBytes } };
    }
  }
  return { success: false, error: `unknown canvas action: ${action.type}` };
}

// extension/src/background/capabilities/tabs.ts
async function handleTabActions(action, tabId) {
  switch (action.type) {
    case "tab_create": {
      const newTab = await chrome.tabs.create({ url: action.url || "about:blank" });
      if (newTab.id) {
        const groupId = await addTabToInterceptorGroup(newTab.id);
        return { success: true, data: { tabId: newTab.id, url: newTab.url, groupId } };
      }
      return { success: true, data: { tabId: newTab.id, url: newTab.url } };
    }
    case "tab_close":
      await chrome.tabs.remove(action.tabId || tabId);
      return { success: true };
    case "tab_switch":
      await chrome.tabs.update(action.tabId, { active: true });
      return { success: true };
    case "tab_list": {
      const tabs = await chrome.tabs.query({});
      await ensureInterceptorGroup();
      const tabData = tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        muted: t.mutedInfo?.muted,
        pinned: t.pinned,
        groupId: t.groupId,
        managed: interceptorGroupId !== null && t.groupId === interceptorGroupId
      }));
      return { success: true, data: tabData };
    }
    case "tab_duplicate": {
      const dup = await chrome.tabs.duplicate(tabId);
      return { success: true, data: { tabId: dup?.id } };
    }
    case "tab_reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache });
      await waitForTabLoad(tabId);
      return { success: true };
    case "tab_mute":
      await chrome.tabs.update(tabId, { muted: !!(action.muted ?? true) });
      return { success: true };
    case "tab_pin":
      await chrome.tabs.update(tabId, { pinned: !!(action.pinned ?? true) });
      return { success: true };
    case "tab_zoom_get": {
      const zoom = await chrome.tabs.getZoom(tabId);
      return { success: true, data: { zoom } };
    }
    case "tab_zoom_set":
      await chrome.tabs.setZoom(tabId, action.zoom);
      return { success: true };
    case "tab_group": {
      const groupId = await chrome.tabs.group({
        tabIds: tabId,
        groupId: action.groupId
      });
      if (action.title || action.color) {
        await chrome.tabGroups.update(groupId, {
          title: action.title,
          color: action.color
        });
      }
      return { success: true, data: { groupId } };
    }
    case "tab_ungroup":
      await chrome.tabs.ungroup(tabId);
      return { success: true };
    case "tab_move":
      await chrome.tabs.move(tabId, {
        windowId: action.windowId,
        index: action.index ?? -1
      });
      return { success: true };
    case "tab_discard":
      await chrome.tabs.discard(tabId);
      return { success: true };
  }
  return { success: false, error: `unknown tab action: ${action.type}` };
}

// extension/src/background/capabilities/windows.ts
async function handleWindowActions(action, _tabId) {
  switch (action.type) {
    case "window_create": {
      const win = await chrome.windows.create({
        url: action.url,
        type: action.windowType || "normal",
        width: action.width,
        height: action.height,
        left: action.left,
        top: action.top,
        incognito: !!action.incognito,
        focused: action.focused !== false
      });
      if (!win)
        return { success: false, error: "window creation returned no window" };
      const firstTab = win.tabs?.[0];
      let groupId;
      if (firstTab?.id && !action.incognito) {
        groupId = await addTabToInterceptorGroup(firstTab.id);
      }
      return {
        success: true,
        data: { windowId: win.id, groupId, tabs: win.tabs?.map((t) => ({ id: t.id, url: t.url })) }
      };
    }
    case "window_close":
      await chrome.windows.remove(action.windowId);
      return { success: true };
    case "window_focus":
      await chrome.windows.update(action.windowId, { focused: true });
      return { success: true };
    case "window_resize": {
      const targetId = action.windowId || (await chrome.windows.getCurrent()).id;
      if (targetId === undefined)
        return { success: false, error: "no target window id available" };
      await chrome.windows.update(targetId, {
        width: action.width,
        height: action.height,
        left: action.left,
        top: action.top,
        state: action.state
      });
      return { success: true };
    }
    case "window_list":
    case "window_get_all": {
      const windows = await chrome.windows.getAll({ populate: true });
      return {
        success: true,
        data: windows.map((w) => ({
          id: w.id,
          type: w.type,
          state: w.state,
          focused: w.focused,
          width: w.width,
          height: w.height,
          left: w.left,
          top: w.top,
          incognito: w.incognito,
          tabs: w.tabs?.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
        }))
      };
    }
  }
  return { success: false, error: `unknown window action: ${action.type}` };
}

// extension/src/background/capabilities/navigation.ts
async function handleNavigationActions(action, tabId) {
  switch (action.type) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForTabLoad(tabId);
      return { success: true };
    case "go_back":
      await chrome.tabs.goBack(tabId);
      await waitForTabLoad(tabId);
      return { success: true };
    case "go_forward":
      await chrome.tabs.goForward(tabId);
      await waitForTabLoad(tabId);
      return { success: true };
    case "reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache });
      await waitForTabLoad(tabId);
      return { success: true };
  }
  return { success: false, error: `unknown navigation action: ${action.type}` };
}

// extension/src/background/capabilities/cookies.ts
async function handleCookieActions(action, _tabId) {
  switch (action.type) {
    case "cookies_get": {
      const cookies = await chrome.cookies.getAll({ domain: action.domain });
      return { success: true, data: cookies };
    }
    case "cookies_set": {
      const cookie = await chrome.cookies.set(action.cookie);
      return { success: true, data: cookie };
    }
    case "cookies_delete":
      await chrome.cookies.remove({ url: action.url, name: action.name });
      return { success: true };
  }
  return { success: false, error: `unknown cookie action: ${action.type}` };
}

// extension/src/background/capabilities/history.ts
async function handleHistoryActions(action, _tabId) {
  switch (action.type) {
    case "history_search": {
      const items = await chrome.history.search({
        text: action.query || "",
        maxResults: action.maxResults || 50,
        startTime: action.startTime,
        endTime: action.endTime
      });
      return {
        success: true,
        data: items.map((i) => ({ url: i.url, title: i.title, lastVisit: i.lastVisitTime, visitCount: i.visitCount }))
      };
    }
    case "history_visits": {
      const visits = await chrome.history.getVisits({ url: action.url });
      return { success: true, data: visits };
    }
    case "history_delete":
      await chrome.history.deleteUrl({ url: action.url });
      return { success: true };
    case "history_delete_range":
      await chrome.history.deleteRange({
        startTime: action.startTime,
        endTime: action.endTime
      });
      return { success: true };
    case "history_delete_all":
      await chrome.history.deleteAll();
      return { success: true };
  }
  return { success: false, error: `unknown history action: ${action.type}` };
}

// extension/src/background/capabilities/bookmarks.ts
async function handleBookmarkActions(action, _tabId) {
  switch (action.type) {
    case "bookmark_tree": {
      const tree = await chrome.bookmarks.getTree();
      return { success: true, data: tree };
    }
    case "bookmark_search": {
      const results = await chrome.bookmarks.search(action.query);
      return {
        success: true,
        data: results.map((b) => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId }))
      };
    }
    case "bookmark_create": {
      const bm = await chrome.bookmarks.create({
        title: action.title,
        url: action.url,
        parentId: action.parentId
      });
      return { success: true, data: bm };
    }
    case "bookmark_delete":
      await chrome.bookmarks.remove(action.id);
      return { success: true };
    case "bookmark_update":
      await chrome.bookmarks.update(action.id, {
        title: action.title,
        url: action.url
      });
      return { success: true };
  }
  return { success: false, error: `unknown bookmark action: ${action.type}` };
}

// extension/src/background/capabilities/downloads.ts
async function handleDownloadActions(action, _tabId) {
  switch (action.type) {
    case "downloads_start": {
      const downloadId = await chrome.downloads.download({
        url: action.url,
        filename: action.filename,
        saveAs: !!action.saveAs
      });
      return { success: true, data: { downloadId } };
    }
    case "downloads_search": {
      const items = await chrome.downloads.search({
        query: action.query ? [action.query] : undefined,
        limit: action.limit || 20,
        orderBy: ["-startTime"]
      });
      return {
        success: true,
        data: items.map((d) => ({
          id: d.id,
          url: d.url,
          filename: d.filename,
          state: d.state,
          bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes,
          mime: d.mime,
          startTime: d.startTime
        }))
      };
    }
    case "downloads_cancel":
      await chrome.downloads.cancel(action.downloadId);
      return { success: true };
    case "downloads_pause":
      await chrome.downloads.pause(action.downloadId);
      return { success: true };
    case "downloads_resume":
      await chrome.downloads.resume(action.downloadId);
      return { success: true };
  }
  return { success: false, error: `unknown download action: ${action.type}` };
}

// extension/src/background/capabilities/sessions.ts
async function handleSessionActions(action, _tabId) {
  switch (action.type) {
    case "session_list": {
      const sessions = await chrome.sessions.getRecentlyClosed({
        maxResults: action.maxResults || 10
      });
      return {
        success: true,
        data: sessions.map((s) => ({
          tab: s.tab ? { url: s.tab.url, title: s.tab.title, sessionId: s.tab.sessionId } : undefined,
          window: s.window ? { sessionId: s.window.sessionId, tabCount: s.window.tabs?.length } : undefined,
          lastModified: s.lastModified
        }))
      };
    }
    case "session_restore": {
      const restored = await chrome.sessions.restore(action.sessionId);
      return { success: true, data: restored };
    }
  }
  return { success: false, error: `unknown session action: ${action.type}` };
}

// extension/src/background/capabilities/notifications.ts
async function handleNotificationActions(action, _tabId) {
  switch (action.type) {
    case "notification_create": {
      const notifId = await chrome.notifications.create(action.notifId || "", {
        type: "basic",
        title: action.title || "Interceptor",
        message: action.message || "",
        iconUrl: action.iconUrl || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      });
      return { success: true, data: { notifId } };
    }
    case "notification_clear":
      await chrome.notifications.clear(action.notifId);
      return { success: true };
  }
  return { success: false, error: `unknown notification action: ${action.type}` };
}

// extension/src/background/capabilities/search.ts
async function handleSearchActions(action, _tabId) {
  if (action.type === "search_query") {
    await chrome.search.query({ text: action.query, disposition: "NEW_TAB" });
    return { success: true };
  }
  return { success: false, error: `unknown search action: ${action.type}` };
}

// extension/src/background/capabilities/browsing-data.ts
async function handleBrowsingDataActions(action, _tabId) {
  if (action.type === "browsing_data_remove") {
    const since = action.since || 0;
    const types = {};
    const requested = action.types || ["cache"];
    for (const t of requested) {
      if (t === "cache")
        types.cache = true;
      if (t === "cookies")
        types.cookies = true;
      if (t === "history")
        types.history = true;
      if (t === "formData")
        types.formData = true;
      if (t === "downloads")
        types.downloads = true;
      if (t === "localStorage")
        types.localStorage = true;
      if (t === "indexedDB")
        types.indexedDB = true;
      if (t === "serviceWorkers")
        types.serviceWorkers = true;
      if (t === "passwords")
        types.passwords = true;
    }
    await chrome.browsingData.remove({ since }, types);
    return { success: true };
  }
  return { success: false, error: `unknown browsing data action: ${action.type}` };
}

// extension/src/background/capabilities/headers.ts
async function handleHeaderActions(action, _tabId) {
  if (action.type !== "headers_modify") {
    return { success: false, error: `unknown header action: ${action.type}` };
  }
  const rules = action.rules;
  if (!rules || rules.length === 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: Array.from({ length: 100 }, (_, i) => i + 1)
    });
    return { success: true, data: "all header rules cleared" };
  }
  const dnrRules = rules.map((r, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{
        header: r.header,
        operation: r.operation === "remove" ? "remove" : "set",
        value: r.value
      }]
    },
    condition: { urlFilter: "*" }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: dnrRules.map((r) => r.id),
    addRules: dnrRules
  });
  return { success: true };
}

// extension/src/background/capabilities/evaluate.ts
var CSP_BYPASS_RULE_ID_BASE = 910000;
function isCspEvalError(error) {
  if (!error)
    return false;
  return /content security policy|script-src|unsafe-eval|trustedscript/i.test(error) && /eval|evaluating a string|string as javascript|trusted types/i.test(error);
}
function buildCspBypassRule(tabId) {
  return {
    id: CSP_BYPASS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ["main_frame", "sub_frame"]
    }
  };
}
async function executeWithUserScripts(tabId, world, code) {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
      return { available: false };
    }
    const results = await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code }],
      world
    });
    const first = results[0];
    if (!first)
      return { available: true, result: { success: false, error: "no result" } };
    if (first.error)
      return { available: true, result: { success: false, error: first.error } };
    return { available: true, result: { success: true, data: first.result } };
  } catch (err) {
    const message = err.message || String(err);
    if (/userScripts|Developer mode|Allow User Scripts|permission|undefined/i.test(message)) {
      return { available: false };
    }
    return { available: true, result: { success: false, error: message } };
  }
}
async function executeEval(tabId, world, code) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [code],
    func: async (c) => {
      function clone(v) {
        if (v === null || v === undefined)
          return v;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean")
          return v;
        if (t === "bigint")
          return v.toString();
        try {
          return JSON.parse(JSON.stringify(v));
        } catch {
          try {
            return String(v);
          } catch {
            return null;
          }
        }
      }
      try {
        const w = window;
        let source = c;
        if (w.trustedTypes) {
          if (!w.__interceptor_tt_policy) {
            try {
              w.__interceptor_tt_policy = w.trustedTypes.createPolicy("interceptor-eval", {
                createScript: (s) => s
              });
            } catch {
              try {
                w.__interceptor_tt_policy = w.trustedTypes.createPolicy("interceptor-eval-" + Date.now(), {
                  createScript: (s) => s
                });
              } catch {}
            }
          }
          if (w.__interceptor_tt_policy) {
            source = w.__interceptor_tt_policy.createScript(c);
          }
        }
        let r = (0, eval)(source);
        if (r && typeof r.then === "function") {
          r = await r;
        }
        return { success: true, data: clone(r) };
      } catch (e) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  });
  return results[0]?.result ?? { success: false, error: "no result" };
}
async function installCspBypassForTab(tabId) {
  const rule = buildCspBypassRule(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [rule.id],
    addRules: [rule]
  });
}
async function reloadTabForCspRetry(tabId) {
  await chrome.tabs.reload(tabId, { bypassCache: true });
  await waitForTabLoad(tabId, 15000);
}
async function handleEvaluateActions(action, tabId) {
  if (action.type !== "evaluate") {
    return { success: false, error: `unknown evaluate action: ${action.type}` };
  }
  const code = action.code;
  const world = action.world === "ISOLATED" ? "ISOLATED" : "MAIN";
  const initialUserScriptWorld = world === "MAIN" ? "MAIN" : "USER_SCRIPT";
  const userScriptAttempt = await executeWithUserScripts(tabId, initialUserScriptWorld, code);
  if (userScriptAttempt.available) {
    if (!userScriptAttempt.result?.success && world === "MAIN" && isCspEvalError(userScriptAttempt.result?.error)) {
      const fallback = await executeWithUserScripts(tabId, "USER_SCRIPT", code);
      if (fallback.available)
        return fallback.result ?? { success: false, error: "no result" };
    }
    return userScriptAttempt.result ?? { success: false, error: "no result" };
  }
  const first = await executeEval(tabId, world, code);
  if (first.success || world !== "MAIN" || !isCspEvalError(first.error)) {
    return first;
  }
  try {
    await installCspBypassForTab(tabId);
    await reloadTabForCspRetry(tabId);
  } catch (err) {
    return {
      success: false,
      error: `MAIN-world eval hit page CSP and automatic CSP bypass setup failed: ${err.message}`,
      data: { originalError: first.error, cspBypassAttempted: false }
    };
  }
  const retried = await executeEval(tabId, "MAIN", code);
  if (retried.success) {
    return {
      ...retried,
      data: {
        value: retried.data,
        cspBypassApplied: true,
        originalError: first.error
      }
    };
  }
  return {
    success: false,
    error: retried.error || first.error || "MAIN-world eval failed after CSP bypass retry",
    data: {
      originalError: first.error,
      cspBypassApplied: true
    }
  };
}

// extension/src/background/capabilities/frames.ts
async function handleFrameActions(action, tabId) {
  if (action.type === "frames_list") {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return {
      success: true,
      data: frames?.map((f) => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId }))
    };
  }
  return { success: false, error: `unknown frame action: ${action.type}` };
}

// extension/src/background/capabilities/meta.ts
async function handleMetaActions(action, tabId) {
  switch (action.type) {
    case "status":
      return { success: true, data: { connected: true, version: chrome.runtime.getManifest().version } };
    case "reload_extension":
      setTimeout(() => chrome.runtime.reload(), 100);
      return { success: true, data: "reloading in 100ms" };
    case "capabilities": {
      const daemonConnected = activeTransport !== "none";
      const hasDebugger = chrome.runtime.getManifest().permissions?.includes("debugger") ?? false;
      const hasUserScriptsPermission = chrome.runtime.getManifest().permissions?.includes("userScripts") ?? false;
      const debuggerActive = debuggerAttached.size > 0;
      let userScriptsApi = false;
      let userScriptsEnabled = false;
      let userScriptsError;
      try {
        userScriptsApi = !!chrome.userScripts;
        if (chrome.userScripts) {
          await chrome.userScripts.getScripts();
          userScriptsEnabled = true;
        }
      } catch (err) {
        userScriptsError = err.message || String(err);
      }
      return {
        success: true,
        data: {
          layers: {
            os_input: daemonConnected,
            tabCapture: true,
            cdp_debugger: hasDebugger,
            debugger_active: debuggerActive
          },
          userScripts: {
            manifest_permission: hasUserScriptsPermission,
            api_present: userScriptsApi,
            enabled: userScriptsEnabled,
            ...userScriptsError ? { error: userScriptsError } : {}
          },
          daemon: daemonConnected,
          infoBannerHeight: debuggerActive ? 35 : 0
        }
      };
    }
    case "cdp_tree": {
      const depth = action.depth || undefined;
      const result = await cdpAttachActDetach(tabId, "Accessibility.getFullAXTree", depth ? { depth } : undefined);
      if (!result.success)
        return { success: false, error: result.error };
      const nodes = result.data?.nodes || [];
      const formatted = nodes.map((n) => {
        const role = n.role?.value || "";
        const name = n.name?.value || "";
        const nodeId = n.nodeId || "";
        return `[${nodeId}] ${role} "${name}"`;
      }).join(`
`);
      return { success: true, data: formatted || "empty tree" };
    }
  }
  return { success: false, error: `unknown meta action: ${action.type}` };
}

// extension/src/background/capabilities/passive-net.ts
async function handlePassiveNetActions(action, tabId) {
  switch (action.type) {
    case "net_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_net_log",
        filter: action.filter,
        since: action.since
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get passive net log" };
      let entries = result.data || [];
      const limit = action.limit || 100;
      entries = entries.slice(-limit);
      return { success: true, data: entries };
    }
    case "net_clear": {
      const result = await sendNetDirect(tabId, { type: "clear_net_log" });
      return result.success ? { success: true, data: "passive net log cleared" } : { success: false, error: result.error };
    }
    case "net_headers": {
      const result = await sendNetDirect(tabId, {
        type: "get_captured_headers",
        filter: action.filter
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get captured headers" };
      return { success: true, data: result.data };
    }
    case "sse_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_log",
        filter: action.filter,
        limit: action.limit
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get SSE log" };
      return { success: true, data: result.data || [] };
    }
    case "sse_streams": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_streams"
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get SSE streams" };
      return { success: true, data: result.data || [] };
    }
    case "sse_chunk": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_chunk",
        filter: action.filter,
        since: action.since
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get SSE chunk" };
      return { success: true, data: result.data };
    }
    case "set_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "set_net_overrides",
        rules: action.rules
      });
      return result.success ? { success: true, data: { overrides: "set", ruleCount: Array.isArray(action.rules) ? action.rules.length : 0 } } : { success: false, error: result.error || "failed to set net overrides" };
    }
    case "clear_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "clear_net_overrides"
      });
      return result.success ? { success: true, data: "net overrides cleared" } : { success: false, error: result.error || "failed to clear net overrides" };
    }
  }
  return { success: false, error: `unknown passive-net action: ${action.type}` };
}

// extension/src/background/capabilities/cdp-network-actions.ts
async function handleCdpNetworkActions(action, tabId) {
  switch (action.type) {
    case "network_intercept": {
      if (action.enabled === false) {
        await disableNetworkCapture(tabId);
        return { success: true, data: { enabled: false, captured: getNetworkLogs(tabId).length } };
      }
      const patterns = Array.isArray(action.patterns) ? action.patterns : [];
      await enableNetworkCapture(tabId, patterns);
      return { success: true, data: { enabled: true, patterns } };
    }
    case "network_log": {
      const since = action.since || 0;
      const limit = action.limit || 100;
      const logs = getNetworkLogs(tabId).filter((entry) => !since || entry.timestamp >= since).slice(-limit);
      return { success: true, data: logs };
    }
    case "network_override": {
      const rules = action.enabled === false ? [] : action.rules || [];
      networkOverrideConfigs.set(tabId, rules);
      await refreshFetchInterception(tabId);
      return { success: true, data: { enabled: rules.length > 0, ruleCount: rules.length, rules } };
    }
  }
  return { success: false, error: `unknown cdp-network action: ${action.type}` };
}

// extension/src/background/capabilities/monitor.ts
var FOCUS_SWITCH_GUARD_MS = 2000;
var sessions = new Map;
var activeSessionByTab = new Map;
var pendingChildTabs = new Map;
var CHILD_TAB_WINDOW_MS = 5000;
var TRUSTED_ACTION_KINDS = new Set(["click", "submit", "key"]);
var webNavRegistered = false;
var tabsRegistered = false;
var runtimeMsgRegistered = false;
function attachmentKey(tabId, documentId) {
  return `${tabId}:${documentId || "unknown"}`;
}
function nextSeq(session) {
  return session.seq++;
}
function getActiveSessionForTab(tabId) {
  const sid = activeSessionByTab.get(tabId);
  if (!sid)
    return;
  return sessions.get(sid);
}
function findFirstActiveSession() {
  for (const session of sessions.values()) {
    if (!session.paused)
      return session;
  }
  return;
}
function getCurrentAttachment(session) {
  if (!session.activeAttachmentKey)
    return;
  return session.attachments.get(session.activeAttachmentKey);
}
function createAttachment(tabId, documentId, frameId, url, lifecycle, reason, openerTabId) {
  return {
    key: attachmentKey(tabId, documentId),
    tabId,
    documentId,
    frameId,
    url,
    openerTabId,
    attachedAt: Date.now(),
    detachedAt: undefined,
    lifecycle,
    reason
  };
}
function emitMonEvent(session, kind, extra = {}, attachmentOverride) {
  const seq = nextSeq(session);
  session.counts.evt++;
  if (kind === "mut")
    session.counts.mut++;
  else if (kind === "fetch" || kind === "xhr" || kind === "sse")
    session.counts.net++;
  else if (kind === "nav")
    session.counts.nav++;
  const attachment = attachmentOverride || getCurrentAttachment(session);
  const base = {};
  if (attachment) {
    base.tid = attachment.tabId;
    if (attachment.documentId)
      base.doc = attachment.documentId;
    if (attachment.lifecycle)
      base.lif = attachment.lifecycle;
    if (attachment.url && extra.u === undefined && extra.url === undefined)
      base.u = attachment.url;
  }
  sendToHost({
    type: "event",
    event: kind,
    sid: session.sessionId,
    s: seq,
    t: Date.now(),
    ...base,
    ...extra
  });
  return seq;
}
function recordTrustedAction(session, kind, seq, tabId, documentId) {
  if (!TRUSTED_ACTION_KINDS.has(kind))
    return;
  session.lastTrustedAction = {
    seq,
    tabId,
    documentId,
    kind,
    at: Date.now()
  };
}
function detachAttachment(session, attachment, reason) {
  attachment.detachedAt = Date.now();
  emitMonEvent(session, "mon_detach", { reason }, attachment);
}
function activateAttachment(session, attachment) {
  session.attachments.set(attachment.key, attachment);
  session.activeAttachmentKey = attachment.key;
  session.url = attachment.url || session.url;
  activeSessionByTab.set(attachment.tabId, session.sessionId);
}
function switchToAttachment(session, nextAttachment, reason) {
  const current = getCurrentAttachment(session);
  if (current && current.key === nextAttachment.key) {
    current.url = nextAttachment.url || current.url;
    current.lifecycle = nextAttachment.lifecycle || current.lifecycle;
    current.openerTabId = nextAttachment.openerTabId ?? current.openerTabId;
    current.reason = nextAttachment.reason;
    session.url = current.url || session.url;
    return;
  }
  if (current) {
    const detachReason = reason === "child_tab" ? "child_tab_handoff" : reason === "focus_switch" ? "focus_switch_handoff" : "document_replaced";
    detachAttachment(session, current, detachReason);
    if (current.tabId !== nextAttachment.tabId) {
      activeSessionByTab.delete(current.tabId);
      sendDisarmToTab(current.tabId, current.documentId);
    }
  }
  activateAttachment(session, nextAttachment);
  emitMonEvent(session, "mon_attach", {
    reason,
    ...nextAttachment.openerTabId !== undefined ? { openerTid: nextAttachment.openerTabId } : {},
    ...nextAttachment.url ? { u: nextAttachment.url } : {}
  }, nextAttachment);
}
async function sendTabMessage(tabId, payload, documentId) {
  if (documentId) {
    return chrome.tabs.sendMessage(tabId, payload, { documentId });
  }
  return chrome.tabs.sendMessage(tabId, payload);
}
async function ensureContentScript(tabId, documentId) {
  try {
    await sendTabMessage(tabId, { type: "monitor_ping" }, documentId);
    return { connected: true };
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (injectErr) {
      return { connected: false, error: `content script could not be re-injected on tab ${tabId} — try 'interceptor reload': ${injectErr.message}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await sendTabMessage(tabId, { type: "monitor_ping" }, documentId);
      return { connected: true };
    } catch (retryErr) {
      return { connected: false, error: `content script re-injected but still not responding on tab ${tabId} — try 'interceptor reload': ${retryErr.message}` };
    }
  }
}
async function sendArmToTab(tabId, sessionId, startedAt, documentId) {
  const check = await ensureContentScript(tabId, documentId);
  if (!check.connected)
    return { success: false, error: check.error };
  try {
    await sendTabMessage(tabId, { type: "monitor_arm", sessionId, startedAt }, documentId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
async function sendDisarmToTab(tabId, documentId) {
  try {
    return await sendTabMessage(tabId, { type: "monitor_disarm" }, documentId);
  } catch (err) {
    console.error(`sendDisarmToTab failed for tab ${tabId}:`, err.message);
    return null;
  }
}
async function getTopFrameContext(tabId) {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return {
      documentId: frame?.documentId,
      url: frame?.url,
      lifecycle: frame?.documentLifecycle
    };
  } catch {
    return {};
  }
}
function registerWebNavListenersOnce() {
  if (webNavRegistered)
    return;
  webNavRegistered = true;
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const pendingChild = pendingChildTabs.get(details.tabId);
    if (pendingChild) {
      const session2 = sessions.get(pendingChild.sessionId);
      if (session2 && !session2.paused) {
        addTabToInterceptorGroup(details.tabId).catch(() => {});
        switchToAttachment(session2, createAttachment(details.tabId, details.documentId, details.frameId, details.url, details.documentLifecycle, "child_tab", pendingChild.openerTabId), "child_tab");
        emitMonEvent(session2, "nav", {
          u: details.url,
          typ: details.transitionType === "reload" ? "reload" : "hard",
          tt: details.transitionType,
          tq: details.transitionQualifiers
        });
      }
      pendingChildTabs.delete(details.tabId);
      return;
    }
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (!current || current.documentId !== details.documentId) {
      switchToAttachment(session, createAttachment(details.tabId, details.documentId, details.frameId, details.url, details.documentLifecycle, details.transitionType === "reload" ? "reload" : "start"), details.transitionType === "reload" ? "reload" : "start");
    } else {
      current.url = details.url;
      current.lifecycle = details.documentLifecycle;
      session.url = details.url;
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: details.transitionType === "reload" ? "reload" : "hard",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    });
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (current) {
      current.url = details.url;
      current.lifecycle = details.documentLifecycle;
      if (details.documentId)
        current.documentId = details.documentId;
      session.url = details.url;
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "history",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    });
    sendArmToTab(details.tabId, session.sessionId, session.startedAt, current?.documentId).then((res) => {
      if (!res.success)
        console.error(`re-arm after history nav failed on tab ${details.tabId}:`, res.error);
    });
  });
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (current) {
      current.url = details.url;
      current.lifecycle = details.documentLifecycle;
      if (details.documentId)
        current.documentId = details.documentId;
      session.url = details.url;
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "reference",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    });
    sendArmToTab(details.tabId, session.sessionId, session.startedAt, current?.documentId).then((res) => {
      if (!res.success)
        console.error(`re-arm after fragment nav failed on tab ${details.tabId}:`, res.error);
    });
  });
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    sendArmToTab(details.tabId, session.sessionId, session.startedAt, current?.documentId).then((res) => {
      if (!res.success)
        console.error(`re-arm after navigation completed failed on tab ${details.tabId}:`, res.error);
    });
  });
  chrome.webNavigation.onTabReplaced.addListener((details) => {
    const session = getActiveSessionForTab(details.replacedTabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (!current)
      return;
    detachAttachment(session, current, "tab_replaced");
    activeSessionByTab.delete(details.replacedTabId);
    const replacement = createAttachment(details.tabId, current.documentId, 0, current.url, current.lifecycle, "tab_replaced", current.openerTabId);
    activateAttachment(session, replacement);
    emitMonEvent(session, "mon_attach", {
      reason: "tab_replaced",
      ...replacement.url ? { u: replacement.url } : {}
    }, replacement);
  });
}
async function handleFocusActivated(tabId) {
  const session = findFirstActiveSession();
  if (!session)
    return;
  const current = getCurrentAttachment(session);
  if (current && current.tabId === tabId)
    return;
  if (pendingChildTabs.has(tabId))
    return;
  let inGroup = false;
  try {
    inGroup = await isTabInInterceptorGroup(tabId);
  } catch {
    return;
  }
  if (!inGroup)
    return;
  if (pendingChildTabs.has(tabId))
    return;
  if (current && current.tabId === tabId)
    return;
  if (current && current.attachedAt && current.tabId === tabId && Date.now() - current.attachedAt < FOCUS_SWITCH_GUARD_MS)
    return;
  let ctx = {};
  try {
    ctx = await getTopFrameContext(tabId);
  } catch {}
  let tabUrl = ctx.url;
  if (!tabUrl) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url;
    } catch {}
  }
  const next = createAttachment(tabId, ctx.documentId, 0, tabUrl, ctx.lifecycle, "focus_switch");
  switchToAttachment(session, next, "focus_switch");
  const armRes = await sendArmToTab(tabId, session.sessionId, session.startedAt, ctx.documentId);
  if (!armRes.success) {
    console.error(`focus_switch arm failed for tab ${tabId}: ${armRes.error}`);
  }
}
function registerTabListenersOnce() {
  if (tabsRegistered)
    return;
  tabsRegistered = true;
  chrome.tabs.onActivated.addListener((info) => {
    handleFocusActivated(info.tabId);
  });
  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab.id || tab.openerTabId === undefined)
      return;
    const session = getActiveSessionForTab(tab.openerTabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (!current || current.tabId !== tab.openerTabId)
      return;
    const trusted = session.lastTrustedAction;
    if (!trusted)
      return;
    if (trusted.tabId !== current.tabId)
      return;
    if (Date.now() - trusted.at > CHILD_TAB_WINDOW_MS)
      return;
    pendingChildTabs.set(tab.id, {
      sessionId: session.sessionId,
      openerTabId: tab.openerTabId,
      createdAt: Date.now()
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    pendingChildTabs.delete(tabId);
    const session = getActiveSessionForTab(tabId);
    if (!session)
      return;
    const current = getCurrentAttachment(session);
    const dur = Date.now() - session.startedAt;
    try {
      if (current) {
        try {
          detachAttachment(session, current, "tab_closed");
        } catch (err) {
          console.error(`detachAttachment during tab_closed failed:`, err.message);
        }
      }
      try {
        sendToHost({
          type: "event",
          event: "mon_stop",
          sid: session.sessionId,
          s: nextSeq(session),
          t: Date.now(),
          reason: "tab_closed",
          evt: session.counts.evt,
          mut: session.counts.mut,
          net: session.counts.net,
          nav: session.counts.nav,
          dur
        });
      } catch (err) {
        console.error(`sendToHost(mon_stop/tab_closed) failed:`, err.message);
      }
    } finally {
      sessions.delete(session.sessionId);
      activeSessionByTab.delete(tabId);
      clearPendingChildTabsForSession(session.sessionId);
    }
  });
}
function registerRuntimeMessageListenerOnce() {
  if (runtimeMsgRegistered)
    return;
  runtimeMsgRegistered = true;
  chrome.runtime.onMessage.addListener(monitorRuntimeMessageListener);
}
function registerMonitorListeners() {
  registerWebNavListenersOnce();
  registerTabListenersOnce();
  registerRuntimeMessageListenerOnce();
}
function monitorRuntimeMessageListener(msg, sender, sendResponse) {
  if (!msg || typeof msg !== "object")
    return;
  if (msg.type !== "mon_evt")
    return;
  try {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    const senderMeta = sender;
    const documentId = senderMeta.documentId;
    const lifecycle = senderMeta.documentLifecycle;
    if (tabId === undefined) {
      sendResponse({ success: false, error: "no tab id on sender" });
      return true;
    }
    const session = getActiveSessionForTab(tabId);
    if (!session) {
      sendResponse({ success: false, error: "no active session for tab" });
      return true;
    }
    if (session.paused) {
      sendResponse({ success: true, dropped: "paused" });
      return true;
    }
    const current = getCurrentAttachment(session);
    if (documentId && current?.documentId && current.documentId !== documentId) {
      sendResponse({ success: false, error: "sender document is not the active attachment" });
      return true;
    }
    if (current && documentId)
      current.documentId = documentId;
    if (current && lifecycle)
      current.lifecycle = lifecycle;
    const obj = msg.obj || {};
    const kind = obj.k || "unknown";
    const stripped = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "k")
        continue;
      stripped[k] = v;
    }
    if (frameId !== 0)
      stripped.fid = frameId;
    if (tabId !== undefined)
      stripped.tid = tabId;
    if (documentId)
      stripped.doc = documentId;
    if (lifecycle)
      stripped.lif = lifecycle;
    const emittedSeq = emitMonEvent(session, kind, stripped, current);
    if (obj.tr !== false) {
      recordTrustedAction(session, kind, emittedSeq, tabId, documentId);
    }
    sendResponse({ success: true });
  } catch (err) {
    try {
      sendResponse({ success: false, error: err.message });
    } catch {}
  }
  return true;
}
async function resolveTabForMonitor() {
  const groupId = await ensureInterceptorGroup();
  if (groupId !== -1) {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length > 0) {
      const active = tabs.find((tab) => tab.active) || tabs[0];
      if (active.id)
        return { tabId: active.id };
    }
  }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    const inGroup = await isTabInInterceptorGroup(activeTab.id);
    if (inGroup)
      return { tabId: activeTab.id };
  }
  return { error: "no interceptor-managed tab found — use 'interceptor tab new' or pass --tab" };
}
function resolveSessionWithoutTab() {
  for (const [tid, sid] of activeSessionByTab) {
    return { tabId: tid, sessionId: sid };
  }
  return;
}
function clearPendingChildTabsForSession(sessionId) {
  for (const [tabId, pending] of pendingChildTabs) {
    if (pending.sessionId === sessionId)
      pendingChildTabs.delete(tabId);
  }
}
async function handleMonitorActions(action, tabId) {
  switch (action.type) {
    case "monitor_start": {
      let resolvedTabId = tabId;
      if (!resolvedTabId) {
        const resolved = await resolveTabForMonitor();
        if (resolved.error || !resolved.tabId) {
          return { success: false, error: resolved.error || "no interceptor-managed tab found" };
        }
        resolvedTabId = resolved.tabId;
      }
      if (activeSessionByTab.has(resolvedTabId)) {
        const existingSid = activeSessionByTab.get(resolvedTabId);
        return {
          success: false,
          error: `monitor already active on tab ${resolvedTabId} (session ${existingSid.slice(0, 8)})`,
          data: { sessionId: existingSid }
        };
      }
      const sessionId = crypto.randomUUID();
      const startedAt = Date.now();
      const instruction = action.instruction || undefined;
      let url;
      try {
        const tab = await chrome.tabs.get(resolvedTabId);
        url = tab.url;
      } catch {}
      const frame = await getTopFrameContext(resolvedTabId);
      const initialAttachment = createAttachment(resolvedTabId, frame.documentId, 0, frame.url || url, frame.lifecycle, "start");
      const session = {
        sessionId,
        rootTabId: resolvedTabId,
        startedAt,
        instruction,
        paused: false,
        seq: 0,
        counts: { evt: 0, mut: 0, net: 0, nav: 0 },
        url: initialAttachment.url || url,
        attachments: new Map([[initialAttachment.key, initialAttachment]]),
        activeAttachmentKey: initialAttachment.key
      };
      const armResult = await sendArmToTab(resolvedTabId, sessionId, startedAt, initialAttachment.documentId);
      if (!armResult.success) {
        return { success: false, error: armResult.error, tabId: resolvedTabId };
      }
      sessions.set(sessionId, session);
      activeSessionByTab.set(resolvedTabId, sessionId);
      sendToHost({
        type: "event",
        event: "mon_start",
        sid: sessionId,
        s: nextSeq(session),
        t: startedAt,
        tid: resolvedTabId,
        url: session.url,
        ins: instruction
      });
      emitMonEvent(session, "mon_attach", {
        reason: "start",
        ...session.url ? { u: session.url } : {}
      }, initialAttachment);
      return { success: true, data: { sessionId, tabId: resolvedTabId, startedAt, url: session.url, instruction } };
    }
    case "monitor_stop": {
      let resolvedTabId = tabId;
      let sid = activeSessionByTab.get(resolvedTabId);
      if (!sid) {
        const found = resolveSessionWithoutTab();
        if (found) {
          resolvedTabId = found.tabId;
          sid = found.sessionId;
        }
      }
      if (!sid) {
        return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` };
      }
      const session = sessions.get(sid);
      const current = getCurrentAttachment(session);
      const disarmRes = await sendDisarmToTab(resolvedTabId, current?.documentId);
      const dur = Date.now() - session.startedAt;
      const countsSnapshot = { ...session.counts };
      try {
        if (current) {
          try {
            detachAttachment(session, current, "user_stop");
          } catch (err) {
            console.error(`detachAttachment during monitor_stop failed:`, err.message);
          }
        }
        try {
          sendToHost({
            type: "event",
            event: "mon_stop",
            sid: session.sessionId,
            s: nextSeq(session),
            t: Date.now(),
            reason: "user",
            evt: session.counts.evt,
            mut: session.counts.mut,
            net: session.counts.net,
            nav: session.counts.nav,
            dur
          });
        } catch (err) {
          console.error(`sendToHost(mon_stop) failed:`, err.message);
        }
      } finally {
        sessions.delete(sid);
        activeSessionByTab.delete(resolvedTabId);
        clearPendingChildTabsForSession(sid);
      }
      return {
        success: true,
        data: {
          sessionId: sid,
          tabId: resolvedTabId,
          dur,
          evt: countsSnapshot.evt,
          mut: countsSnapshot.mut,
          net: countsSnapshot.net,
          nav: countsSnapshot.nav,
          contentDisarm: disarmRes
        }
      };
    }
    case "monitor_status": {
      if (action.tabId && typeof action.tabId === "number") {
        const sid = activeSessionByTab.get(action.tabId);
        if (!sid)
          return { success: true, data: { active: false, tabId: action.tabId } };
        const session = sessions.get(sid);
        const current = getCurrentAttachment(session);
        return {
          success: true,
          data: {
            active: !session.paused,
            paused: session.paused,
            sessionId: session.sessionId,
            tabId: current?.tabId ?? action.tabId,
            documentId: current?.documentId,
            startedAt: session.startedAt,
            url: session.url,
            instruction: session.instruction,
            counts: session.counts,
            ageMs: Date.now() - session.startedAt
          }
        };
      }
      const list = Array.from(sessions.values()).map((session) => {
        const current = getCurrentAttachment(session);
        return {
          sessionId: session.sessionId,
          tabId: current?.tabId ?? session.rootTabId,
          documentId: current?.documentId,
          startedAt: session.startedAt,
          url: session.url,
          instruction: session.instruction,
          paused: session.paused,
          counts: session.counts,
          ageMs: Date.now() - session.startedAt
        };
      });
      return { success: true, data: { active: list.length > 0, sessions: list } };
    }
    case "monitor_pause": {
      let resolvedTabId = tabId;
      let sid = activeSessionByTab.get(resolvedTabId);
      if (!sid) {
        const found = resolveSessionWithoutTab();
        if (found) {
          resolvedTabId = found.tabId;
          sid = found.sessionId;
        }
      }
      if (!sid)
        return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` };
      const session = sessions.get(sid);
      session.paused = true;
      sendToHost({
        type: "event",
        event: "mon_pause",
        sid,
        s: nextSeq(session),
        t: Date.now(),
        ...getCurrentAttachment(session) ? { tid: getCurrentAttachment(session).tabId } : {}
      });
      return { success: true, data: { sessionId: sid, paused: true } };
    }
    case "monitor_resume": {
      let resolvedTabId = tabId;
      let sid = activeSessionByTab.get(resolvedTabId);
      if (!sid) {
        const found = resolveSessionWithoutTab();
        if (found) {
          resolvedTabId = found.tabId;
          sid = found.sessionId;
        }
      }
      if (!sid)
        return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` };
      const session = sessions.get(sid);
      const current = getCurrentAttachment(session);
      session.paused = false;
      sendToHost({
        type: "event",
        event: "mon_resume",
        sid,
        s: nextSeq(session),
        t: Date.now(),
        ...current ? { tid: current.tabId, doc: current.documentId } : {}
      });
      const armResult = await sendArmToTab(resolvedTabId, sid, session.startedAt, current?.documentId);
      if (!armResult.success) {
        console.error(`re-arm after resume failed on tab ${resolvedTabId}:`, armResult.error);
      }
      return { success: true, data: { sessionId: sid, paused: false } };
    }
  }
  return { success: false, error: `unknown monitor action: ${action.type}` };
}

// extension/src/background/router.ts
registerMonitorListeners();
var OS_INPUT_ACTIONS = new Set(["os_click", "os_key", "os_type", "os_move"]);
var SCREENSHOT_ACTIONS = new Set(["screenshot", "screenshot_background", "page_capture"]);
var CAPTURE_STREAM_ACTIONS = new Set(["capture_start", "capture_frame", "capture_stop", "canvas_diff"]);
var CANVAS_ACTIONS = new Set(["canvas_list", "canvas_read"]);
var TAB_ACTIONS = new Set([
  "tab_create",
  "tab_close",
  "tab_switch",
  "tab_list",
  "tab_duplicate",
  "tab_reload",
  "tab_mute",
  "tab_pin",
  "tab_zoom_get",
  "tab_zoom_set",
  "tab_group",
  "tab_ungroup",
  "tab_move",
  "tab_discard"
]);
var WINDOW_ACTIONS = new Set([
  "window_create",
  "window_close",
  "window_focus",
  "window_resize",
  "window_list",
  "window_get_all"
]);
var NAVIGATION_ACTIONS = new Set(["navigate", "go_back", "go_forward", "reload"]);
var COOKIE_ACTIONS = new Set(["cookies_get", "cookies_set", "cookies_delete"]);
var HISTORY_ACTIONS = new Set([
  "history_search",
  "history_visits",
  "history_delete",
  "history_delete_range",
  "history_delete_all"
]);
var BOOKMARK_ACTIONS = new Set([
  "bookmark_tree",
  "bookmark_search",
  "bookmark_create",
  "bookmark_delete",
  "bookmark_update"
]);
var DOWNLOAD_ACTIONS = new Set([
  "downloads_start",
  "downloads_search",
  "downloads_cancel",
  "downloads_pause",
  "downloads_resume"
]);
var SESSION_ACTIONS = new Set(["session_list", "session_restore"]);
var NOTIFICATION_ACTIONS = new Set(["notification_create", "notification_clear"]);
var BROWSING_DATA_ACTIONS = new Set(["browsing_data_remove"]);
var HEADER_ACTIONS = new Set(["headers_modify"]);
var EVALUATE_ACTIONS = new Set(["evaluate"]);
var FRAME_ACTIONS = new Set(["frames_list"]);
var META_ACTIONS = new Set(["status", "reload_extension", "capabilities", "cdp_tree"]);
var PASSIVE_NET_ACTIONS = new Set(["net_log", "net_clear", "net_headers", "sse_log", "sse_streams", "sse_chunk", "set_net_overrides", "clear_net_overrides"]);
var CDP_NETWORK_ACTIONS = new Set(["network_intercept", "network_log", "network_override"]);
var MONITOR_ACTIONS = new Set(["monitor_start", "monitor_stop", "monitor_status", "monitor_pause", "monitor_resume"]);
var SCENE_ACTIONS = new Set([
  "scene_list",
  "scene_click",
  "scene_dblclick",
  "scene_select",
  "scene_hit",
  "scene_selected",
  "scene_text",
  "scene_insert",
  "scene_cursor_to",
  "scene_cursor",
  "scene_slide_list",
  "scene_slide_goto",
  "scene_slide_current",
  "scene_notes",
  "scene_render",
  "scene_zoom",
  "scene_profile"
]);
async function routeAction(action, tabId) {
  if (OS_INPUT_ACTIONS.has(action.type))
    return handleOsInputActions(action, tabId);
  if (SCREENSHOT_ACTIONS.has(action.type))
    return handleScreenshotActions(action, tabId);
  if (CAPTURE_STREAM_ACTIONS.has(action.type))
    return handleCaptureStreamActions(action, tabId);
  if (CANVAS_ACTIONS.has(action.type))
    return handleCanvasActions(action, tabId);
  if (TAB_ACTIONS.has(action.type))
    return handleTabActions(action, tabId);
  if (WINDOW_ACTIONS.has(action.type))
    return handleWindowActions(action, tabId);
  if (NAVIGATION_ACTIONS.has(action.type))
    return handleNavigationActions(action, tabId);
  if (COOKIE_ACTIONS.has(action.type))
    return handleCookieActions(action, tabId);
  if (HISTORY_ACTIONS.has(action.type))
    return handleHistoryActions(action, tabId);
  if (BOOKMARK_ACTIONS.has(action.type))
    return handleBookmarkActions(action, tabId);
  if (DOWNLOAD_ACTIONS.has(action.type))
    return handleDownloadActions(action, tabId);
  if (SESSION_ACTIONS.has(action.type))
    return handleSessionActions(action, tabId);
  if (NOTIFICATION_ACTIONS.has(action.type))
    return handleNotificationActions(action, tabId);
  if (action.type === "search_query")
    return handleSearchActions(action, tabId);
  if (BROWSING_DATA_ACTIONS.has(action.type))
    return handleBrowsingDataActions(action, tabId);
  if (HEADER_ACTIONS.has(action.type))
    return handleHeaderActions(action, tabId);
  if (EVALUATE_ACTIONS.has(action.type))
    return handleEvaluateActions(action, tabId);
  if (FRAME_ACTIONS.has(action.type))
    return handleFrameActions(action, tabId);
  if (META_ACTIONS.has(action.type))
    return handleMetaActions(action, tabId);
  if (PASSIVE_NET_ACTIONS.has(action.type))
    return handlePassiveNetActions(action, tabId);
  if (CDP_NETWORK_ACTIONS.has(action.type))
    return handleCdpNetworkActions(action, tabId);
  if (MONITOR_ACTIONS.has(action.type))
    return handleMonitorActions(action, tabId);
  if (action.type === "linkedin_event_extract")
    return buildLinkedInEventExtraction(tabId, action);
  if (action.type === "linkedin_attendees_extract")
    return buildLinkedInAttendeesExtraction(tabId, action);
  const contentResult = await sendToContentScript(tabId, action, action.frameId);
  const shouldSceneEscalate = action.type === "scene_click" && contentResult.success && (action.os === true || contentResult.warning?.includes("no DOM change")) && activeTransport !== "none";
  const shouldClickEscalate = action.type === "click" && contentResult.success && contentResult.warning?.includes("no DOM change") && activeTransport !== "none";
  if (shouldClickEscalate || shouldSceneEscalate) {
    const resolvedAt = typeof contentResult.data === "object" && contentResult.data ? contentResult.data.at : undefined;
    console.log(`auto-escalating ${action.type} to OS-level input`);
    const osResult = await handleOsInputActions({
      ...action,
      type: "os_click",
      x: resolvedAt?.x ?? action.x,
      y: resolvedAt?.y ?? action.y
    }, tabId);
    if (osResult.success) {
      return {
        success: true,
        data: {
          ...typeof osResult.data === "object" && osResult.data || {},
          escalated: {
            from: action.os === true ? "explicit" : "synthetic",
            to: "os_click",
            reason: action.os === true ? "scene click requested trusted input" : "no DOM mutation after synthetic click"
          }
        },
        tabId
      };
    }
    return {
      success: false,
      error: "click failed at all layers",
      data: {
        diagnostics: {
          layers_tried: ["synthetic", "os_click"],
          reason: action.os === true ? "trusted scene click failed" : "synthetic produced no DOM change, os_click failed",
          suggestion: "verify element is interactive and Chrome window is visible"
        }
      }
    };
  }
  if (!contentResult.success && contentResult.error) {
    contentResult.data = {
      ...typeof contentResult.data === "object" && contentResult.data ? contentResult.data : {},
      diagnostics: {
        layer_tried: "content_script",
        reason: contentResult.error,
        suggestion: action.type === "click" ? "try: interceptor click --os " + (action.ref || action.index || "") : action.type === "scene_click" ? "try: interceptor scene click --os " + (action.id || "") : undefined
      }
    };
  }
  return contentResult;
}

// extension/src/background/message-dispatch.ts
var MESSAGE_QUEUE_CAP = 50;
var messageQueue = [];
var EXT_REQUEST_TIMEOUT_MS = 180000;
var pendingRequests = new Map;
function drainMessageQueue() {
  while (messageQueue.length > 0) {
    const queued = messageQueue.shift();
    handleDaemonMessage(queued);
  }
}
function needsTab(type) {
  const noTabActions = new Set([
    "status",
    "reload_extension",
    "tab_create",
    "tab_list",
    "window_create",
    "window_list",
    "window_get_all",
    "history_search",
    "history_delete_all",
    "bookmark_tree",
    "bookmark_search",
    "bookmark_create",
    "downloads_search",
    "browsing_data_remove",
    "session_list",
    "session_restore",
    "notification_create",
    "notification_clear",
    "search_query",
    "monitor_status",
    "monitor_start",
    "monitor_pause",
    "monitor_resume",
    "monitor_stop"
  ]);
  return !noTabActions.has(type);
}
async function handleDaemonMessage(msg) {
  if (!msg.action || !msg.id)
    return;
  if (activeTransport === "none") {
    if (messageQueue.length >= MESSAGE_QUEUE_CAP) {
      const evicted = messageQueue.shift();
      if (evicted.id) {
        sendToHost({ id: evicted.id, result: { success: false, error: "message queue full — daemon not connected" } });
      }
    }
    if (messageQueue.length >= MESSAGE_QUEUE_CAP / 2) {
      console.warn(`message queue at ${messageQueue.length}/${MESSAGE_QUEUE_CAP}`);
    }
    messageQueue.push(msg);
    connectToHost();
    connectWsChannel();
    return;
  }
  const respondViaWsEarly = !!msg._viaWs;
  if (pendingRequests.has(msg.id)) {
    sendToHost({ id: msg.id, result: { success: false, error: "duplicate request ID" } }, respondViaWsEarly);
    return;
  }
  const requestTimer = setTimeout(() => {
    const req = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    sendToHost({ id: msg.id, result: { success: false, error: "extension timeout" } }, req?.viaWs);
  }, EXT_REQUEST_TIMEOUT_MS);
  const startTime = Date.now();
  const shortId = msg.id.slice(0, 8);
  const respondViaWs = !!msg._viaWs;
  console.log(`[${shortId}] executing ${msg.action.type} (via ${respondViaWs ? "ws" : "native"})`);
  pendingRequests.set(msg.id, {
    action: msg.action.type,
    tabId: msg.tabId,
    timestamp: startTime,
    timer: requestTimer,
    viaWs: respondViaWs
  });
  const action = msg.action;
  let tabId = msg.tabId;
  if (!tabId && needsTab(action.type)) {
    const stored = await chrome.storage.session.get("activeTabId");
    tabId = stored.activeTabId;
  }
  if (!tabId && needsTab(action.type)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id;
    if (tabId)
      chrome.storage.session.set({ activeTabId: tabId });
  }
  if (!tabId && needsTab(action.type)) {
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    sendToHost({ id: msg.id, result: { success: false, error: "no active tab" } }, respondViaWs);
    return;
  }
  if (tabId)
    chrome.storage.session.set({ activeTabId: tabId });
  if (tabId && needsTab(action.type) && !action.anyTab) {
    const inGroup = await isTabInInterceptorGroup(tabId);
    if (!inGroup && interceptorGroupId !== null) {
      clearTimeout(requestTimer);
      pendingRequests.delete(msg.id);
      sendToHost({
        id: msg.id,
        result: {
          success: false,
          error: `tab ${tabId} is not in the interceptor group — use 'interceptor tab new' to create managed tabs`
        }
      }, respondViaWs);
      return;
    }
  }
  if (SENSITIVE_ACTIONS.has(action.type) && tabId && action.expectedUrl) {
    const urlErr = await verifyTabUrl(tabId, action.expectedUrl);
    if (urlErr) {
      clearTimeout(requestTimer);
      pendingRequests.delete(msg.id);
      sendToHost({ id: msg.id, result: { success: false, error: urlErr, tabId } }, respondViaWs);
      return;
    }
  }
  try {
    const result = await routeAction(action, tabId);
    if (tabId)
      result.tabId = tabId;
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    console.log(`[${shortId}] complete ${action.type} ${Date.now() - startTime}ms`);
    sendToHost({ id: msg.id, result }, respondViaWs);
  } catch (err) {
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    console.error(`[${shortId}] error ${action.type} ${Date.now() - startTime}ms: ${err.message}`);
    sendToHost({ id: msg.id, result: { success: false, error: err.message, tabId } }, respondViaWs);
  }
}

// extension/src/background/safe-port-post.ts
function safePortPost(port, msg) {
  if (!port)
    return { posted: false, error: "no port" };
  try {
    port.postMessage(msg);
    return { posted: true };
  } catch (err) {
    try {
      port.disconnect?.();
    } catch {}
    return { posted: false, error: err.message };
  }
}

// extension/src/background/transport.ts
var nativePort = null;
var activeTransport = "none";
var isConnecting = false;
var reconnectDelay = 1000;
var wsChannel = null;
var wsReady = false;
var wsKeepAliveTimer = null;
var keepalivePongTimer = null;
var WS_URL = "ws://localhost:19222";
function emitEvent(event, data = {}) {
  sendToHost({ type: "event", event, ...data });
}
function postNative(msg) {
  const port = nativePort;
  if (!port)
    return false;
  const res = safePortPost(port, msg);
  if (res.posted)
    return true;
  console.error("nativePort.postMessage threw (port disconnected before onDisconnect fired):", res.error);
  if (nativePort === port)
    nativePort = null;
  if (activeTransport === "native")
    activeTransport = "none";
  return false;
}
function sendToHost(msg, forceWs) {
  if (forceWs && wsReady && wsChannel) {
    try {
      wsChannel.send(JSON.stringify(msg));
    } catch {}
    return;
  }
  if (activeTransport === "native" && nativePort) {
    if (postNative(msg))
      return;
  }
  if (activeTransport === "websocket" && wsReady && wsChannel) {
    try {
      wsChannel.send(JSON.stringify(msg));
    } catch {}
    return;
  }
  if (nativePort) {
    if (postNative(msg))
      return;
  }
  if (wsReady && wsChannel) {
    try {
      wsChannel.send(JSON.stringify(msg));
    } catch {}
  }
}
function connectToHost() {
  if (nativePort || isConnecting)
    return;
  isConnecting = true;
  const port = chrome.runtime.connectNative("com.interceptor.host");
  const handshakeTimer = setTimeout(() => {
    console.error("native host handshake timeout (10s)");
    port.disconnect();
  }, 1e4);
  port.onMessage.addListener((msg) => {
    if (msg.type === "pong") {
      clearTimeout(handshakeTimer);
      activeTransport = "native";
      reconnectDelay = 1000;
      isConnecting = false;
      console.log("native host connected (pong received)");
      emitEvent("connection_established");
      drainMessageQueue();
      if (keepalivePongTimer) {
        clearTimeout(keepalivePongTimer);
        keepalivePongTimer = null;
      }
      return;
    }
    handleDaemonMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    const dyingPort = nativePort;
    isConnecting = false;
    const lastError = chrome.runtime.lastError;
    if (lastError)
      console.error("native host disconnected:", lastError.message);
    console.log("connection_lost", lastError?.message);
    nativePort = null;
    if (wsReady && wsChannel) {
      activeTransport = "websocket";
      console.log("native host down but ws channel active, switching to websocket");
      return;
    }
    if (activeTransport === "native")
      activeTransport = "none";
    for (const [id, req] of pendingRequests) {
      clearTimeout(req.timer);
      console.error(`orphaned request ${id} (${req.action}) — native port disconnected`);
      if (dyingPort) {
        try {
          dyingPort.postMessage({ id, result: { success: false, error: "native port disconnected" } });
        } catch {}
      }
    }
    pendingRequests.clear();
    const jitter = Math.random() * reconnectDelay * 0.3;
    setTimeout(connectToHost, reconnectDelay + jitter);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
  nativePort = port;
  port.postMessage({ type: "ping" });
}
function startWsKeepAlive() {
  if (wsKeepAliveTimer)
    clearInterval(wsKeepAliveTimer);
  wsKeepAliveTimer = setInterval(() => {
    if (!wsChannel || wsChannel.readyState !== WebSocket.OPEN) {
      if (wsKeepAliveTimer)
        clearInterval(wsKeepAliveTimer);
      wsKeepAliveTimer = null;
      return;
    }
    try {
      wsChannel.send(JSON.stringify({ type: "keepalive", timestamp: Date.now() }));
    } catch {}
  }, 20000);
}
function stopWsKeepAlive() {
  if (wsKeepAliveTimer)
    clearInterval(wsKeepAliveTimer);
  wsKeepAliveTimer = null;
}
function connectWsChannel() {
  if (wsChannel && (wsChannel.readyState === WebSocket.OPEN || wsChannel.readyState === WebSocket.CONNECTING))
    return;
  try {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      wsChannel = ws;
      wsReady = true;
      ws.send(JSON.stringify({ type: "extension" }));
      startWsKeepAlive();
      console.log("ws channel connected");
      if (activeTransport !== "native") {
        activeTransport = "websocket";
        reconnectDelay = 1000;
        isConnecting = false;
        console.log("connection ready via ws channel");
        drainMessageQueue();
      }
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        console.log("ws onmessage:", JSON.stringify(msg).slice(0, 200));
        if (msg.id && msg.action) {
          msg._viaWs = true;
          handleDaemonMessage(msg);
        }
      } catch (err) {
        console.error("ws onmessage error:", err);
      }
    };
    ws.onclose = () => {
      stopWsKeepAlive();
      wsReady = false;
      wsChannel = null;
      if (activeTransport === "websocket")
        activeTransport = "none";
    };
    ws.onerror = () => {
      stopWsKeepAlive();
      wsReady = false;
      wsChannel = null;
      if (activeTransport === "websocket")
        activeTransport = "none";
    };
  } catch {}
}
var lastSwKeepalive = 0;
function registerSwKeepaliveListener() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "sw_keepalive")
      return false;
    const now = Date.now();
    if (now - lastSwKeepalive < 20000) {
      sendResponse({ leader: false });
    } else {
      lastSwKeepalive = now;
      sendResponse({ leader: true });
    }
    return false;
  });
}
function registerAlarmListener() {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "keepalive")
      return;
    if (!nativePort)
      connectToHost();
    if (!wsChannel || wsChannel.readyState === WebSocket.CLOSED)
      connectWsChannel();
    if (activeTransport === "native" && nativePort) {
      nativePort.postMessage({ type: "ping" });
      keepalivePongTimer = setTimeout(() => {
        console.error("keepalive pong timeout (5s) — forcing reconnect");
        if (nativePort)
          nativePort.disconnect();
      }, 5000);
    }
  });
}

// extension/src/background.ts
registerCdpListeners();
registerTabGroupListeners();
registerAlarmListener();
registerSwKeepaliveListener();
chrome.runtime.onInstalled.addListener(() => {
  connectToHost();
  connectWsChannel();
  ensureInterceptorGroup();
});
chrome.runtime.onStartup.addListener(() => {
  connectToHost();
  connectWsChannel();
  ensureInterceptorGroup();
});
connectToHost();
connectWsChannel();
