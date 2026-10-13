/** Shared desktop wire contract. Existing macos_* actions remain valid on macOS. */
export const DESKTOP_PROTOCOL_VERSION = 1
export const DESKTOP_AUTH_DIALOG_DEADLINE_MS = 10_000
export type DesktopAuthDialogOperation = "desktop_authdialog"
export type DesktopAuthDialogVerb = "status" | "fill"
export type DesktopAuthDialogPromptShape = "none" | "password" | "touchid" | "unknown"
export type DesktopAuthDialogNullableText = string | null
export type DesktopAuthDialogUnknownAcceptance = null
export interface DesktopAuthDialogAction {
  type: DesktopAuthDialogOperation; sub: DesktopAuthDialogVerb; app?: string; pid?: number; window?: number; ref?: string; dialogRef?: string
  text?: string; secret?: string; submit?: boolean; sensitive?: boolean; backgroundOnly?: boolean
  secretBindingName?: string; secretLease?: string; expectedIdentity?: DesktopAxProcessIdentity
  group?: string; groupColor?: string; groupSoft?: boolean
}
export interface DesktopAuthDialogStatus {
  present: boolean; shape: DesktopAuthDialogPromptShape; provider: string
  pid?: number; title?: string; message?: string; buttons?: string[]; username?: string; hasSecureField?: boolean
  dialogRef?: string; secureRef?: string; usernameRef?: string; targetIdentity?: DesktopAxProcessIdentity
}
export interface DesktopAuthDialogFilled {
  filled: boolean; chars: number; shape: DesktopAuthDialogPromptShape; provider: string
  delivery: string; valueAccepted: DesktopAuthDialogUnknownAcceptance
  pressedUsePassword: boolean; usernameFixed: boolean; routing: string; submitted: DesktopAuthDialogNullableText
  dialogClosed: boolean; closureObservationError?: string; generation: string; targetIdentity: DesktopAxProcessIdentity
}
export interface DesktopAuthDialogResultSchemas { status: DesktopAuthDialogStatus; fill: DesktopAuthDialogFilled }
export type DesktopOverlayOperation = "desktop_overlay"
export type DesktopOverlayVerb = "start" | "stop" | "list" | "status" | "eval" | "ctl" | "verbs"
export type DesktopOverlayJSON = string | number | boolean | null | { [key: string]: DesktopOverlayJSON } | DesktopOverlayJSON[]
export type DesktopOverlayEmojiValue = string | string[]
export type DesktopOverlayArgsValue = string | Record<string, DesktopOverlayJSON>
export type DesktopOverlayNullableText = string | null
export interface DesktopOverlayRect { x?: number; y?: number; width: number; height: number }
export interface DesktopOverlayAction {
  type: DesktopOverlayOperation; sub: DesktopOverlayVerb; id?: string
  level?: string; interactive?: boolean; single_space?: boolean; no_fullscreen_aux?: boolean; timeout_seconds?: number
  scene?: string; scene_script?: string; scene_script_file?: string; particles?: string; emojis?: DesktopOverlayEmojiValue
  density?: number; direction?: string; lifetime?: number; velocity?: number; size_scale?: number
  html_b64?: string; url?: string; source?: string; display_id?: number; visible?: boolean
  rect?: DesktopOverlayRect; anchor?: string; width?: number; height?: number
  js?: string; javascript?: string; verb?: string; args?: DesktopOverlayArgsValue; groupColor?: string; groupSoft?: boolean
}
export interface DesktopOverlayView {
  id: string; generation: string; mode: string; lifecycle: string
  frame: DesktopOverlayRect; requestedFrame?: DesktopOverlayRect; display_id?: number; displayID?: number
  level?: string; nativeLevel?: string; interactive?: boolean; visible?: boolean; isVisible?: boolean
  renderer?: DesktopOverlayJSON; native?: DesktopOverlayJSON; nativePending?: boolean; nativeCleanupPending?: boolean
  provider?: string; displayIdentity?: string; url?: DesktopOverlayNullableText; source?: string; createdAt?: string; lastError?: DesktopOverlayJSON
}
export interface DesktopOverlayList { overlays: DesktopOverlayView[] }
export interface DesktopOverlayStopped { stopped: string[]; nativeCleanupPending: DesktopOverlayJSON[] }
export interface DesktopOverlayVerbs { id: string; mode: string; verbs: string[] }
export const DESKTOP_VM_DEADLINE_MS = 58_000
export type DesktopVmOperation = "desktop_vm"
export type DesktopVmVerb = "create" | "adopt" | "clone" | "install" | "pull" | "list" | "get" | "inspect" | "start" | "stop" | "pause" | "resume" | "reset" | "delete" | "exec" | "snapshot" | "restore" | "cp" | "share" | "mount" | "port_forward" | "screenshot" | "type" | "click" | "keys" | "read_ax" | "console" | "logs" | "trust" | "tcc_profile_generate"
export interface DesktopVmShare { hostPath: string; tag: string; readOnly: boolean }
export interface DesktopVmAction {
  type: DesktopVmOperation; sub: DesktopVmVerb; name?: string; stateDir?: string
  kind?: string; cpu?: number; memorySize?: number; diskSize?: number; image?: string; imageFormat?: string
  network?: string; rosetta?: boolean; shares?: DesktopVmShare[]; sourcePath?: string; provider?: string; mode?: string
  installAgent?: boolean; waitForAgent?: boolean; waitForVsock?: boolean; headless?: boolean; detach?: boolean
  src?: string; dst?: string; ipsw?: string; fromLatest?: boolean; force?: boolean; keepDisk?: boolean; timeout?: number
  noPrompt?: boolean; prompt?: boolean; walkthrough?: boolean; accessibilityPrompt?: boolean; screenPrompt?: boolean; resetDenied?: boolean
  command?: string[]; env?: Record<string, string>; user?: string; workdir?: string; tty?: boolean
  tag?: string; snapshotOp?: string; diskOnly?: boolean; pausedStateOnly?: boolean
  path?: string; out?: string; text?: string; x?: number; y?: number; button?: string; keys?: string; max_depth?: number; app?: string
  limit?: number; hostPath?: string; readOnly?: boolean; hostAddress?: string; hostPort?: number; guestPort?: number
  write?: string; maxBytes?: number; services?: string[]; bundleId?: string; appPath?: string; identifierType?: string
  codeRequirement?: string; fullDisk?: boolean; includeUserOnly?: boolean
}
export interface DesktopVmView { name: string; id: string; kind: string; status: string; cpu: number; memorySize: number; diskSize: number; network: string; createdAt: string; startedAt?: string; ipAddress?: string; snapshotSupported?: boolean; bundlePath?: string; lastError?: string }
export interface DesktopVmList { vms: DesktopVmView[] }
export interface DesktopVmCreated { name: string; id: string; kind: string; status: string; bundlePath: string }
export interface DesktopVmCloned { name: string; bundlePath: string; status: string }
export interface DesktopVmTransition { state: string; transitionMs?: number; ipAddress?: string; name?: string }
export interface DesktopVmSnapshot { tag: string; kind: string; hasPausedState?: boolean; hasDiskClone?: boolean; state?: string; restored?: string }
export interface DesktopVmSnapshots { snapshots: string[] }
export interface DesktopVmSnapshotDeleted { tag: string; deleted: boolean }
export interface DesktopVmConsole { bytes?: number; text?: string; dataBase64?: string; bytesWritten?: number }
export interface DesktopVmExecution { exitCode: number; stdout: string; stderr: string; durationMs: number }
export const DESKTOP_VM_COPY_MAX_BYTES = 1_048_576
export type DesktopVmCopyDirection = "host-to-guest" | "guest-to-host"
export interface DesktopVmCopied { name: string; direction: DesktopVmCopyDirection; source: string; path: string; bytes: number; sha256: string; verified: boolean; overwrite: boolean }
export interface DesktopVmForward { hostAddress: string; hostPort: number; guestAddress: string; guestPort: number }
export interface DesktopVmScreenshot { width: number; height: number; bytes: number; format: string; filePath?: string; dataUrl?: string }
export type DesktopVmAxValueState = "read" | "redacted" | "withheld" | "unavailable"
export interface DesktopVmAxNode { ref: string; role: string; subrole?: string; secure: boolean; valueState: DesktopVmAxValueState; value?: string; title?: string; description?: string; frame?: DesktopAxFrame; children?: DesktopVmAxNode[] }
export interface DesktopVmAxSnapshot { name: string; app: string; bundleIdentifier: string; selector?: string; pid: number; tree: DesktopVmAxNode; visited: number; maxDepth: number; partial: boolean; reasons: string[]; refsActionable: boolean }
export type DesktopVmLogState = "read" | "unavailable"
export interface DesktopVmLogEntry { path: string; lines: string[]; state: DesktopVmLogState; truncated: boolean; error?: string }
export interface DesktopVmLogs { name: string; logs: DesktopVmLogEntry[]; partial: boolean }
export interface DesktopVmMounted { name: string; tag: string; path: string; nativeMountPath: string; fileSystem: string; mounted: boolean }
export interface DesktopVmTccReset { service: string; ok: boolean; exitCode?: number; stdout?: string; stderr?: string; durationMs?: number; truncated?: boolean; error?: string; outcomeUnknown?: boolean }
export interface DesktopVmTrust { name: string; platform: string; accessibility: DesktopPermission; screenRecording: DesktopPermission; postEvent: DesktopPermission; inputMonitoring: DesktopPermission; notes: string[]; prompted?: string[]; opened?: string[]; reset?: DesktopVmTccReset[]; action_required?: string[] }
export type DesktopVmInputTransport = "coregraphics" | "qmp"
// QEMU9.2.4 QKeyCode values used for physical guest chords. Text typing
// requires a separate guest Unicode transport and is not inferred here.
export type DesktopVmQmpKeyCode = "shift" | "alt" | "ctrl" | "meta_l" | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z" | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "minus" | "equal" | "bracket_left" | "bracket_right" | "semicolon" | "apostrophe" | "grave_accent" | "backslash" | "comma" | "dot" | "slash" | "ret" | "tab" | "spc" | "backspace" | "esc" | "delete" | "home" | "end" | "pgup" | "pgdn" | "left" | "right" | "up" | "down" | "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12"
export interface DesktopVmInput { name: string; operation: string; transport: DesktopVmInputTransport; submittedEvents: number; guestEffectVerified: boolean; textUTF8Bytes?: number; keys?: string; x?: number; y?: number; button?: string }
export type DesktopVmData = DesktopVmView | DesktopVmList | DesktopVmCreated | DesktopVmCloned | DesktopVmTransition | DesktopVmSnapshot | DesktopVmSnapshots | DesktopVmSnapshotDeleted | DesktopVmConsole | DesktopVmExecution | DesktopVmCopied | DesktopVmForward | DesktopVmScreenshot | DesktopVmInput | DesktopVmAxSnapshot | DesktopVmLogs | DesktopVmMounted | DesktopVmTrust
export const DESKTOP_PHOTOS_DEADLINE_MS = 58_000
export type DesktopPhotosOperation = "desktop_photos"
export type DesktopPhotosVerb = "status" | "request" | "albums" | "album" | "album-create" | "album-delete" | "album-rename" | "assets" | "asset" | "export" | "export-video" | "export-live" | "thumbnail" | "favorite" | "hide" | "delete" | "add-to-album" | "remove-from-album" | "import" | "import-video" | "current-token" | "changes"
export interface DesktopPhotosAction {
  type: DesktopPhotosOperation
  sub: DesktopPhotosVerb
  id?: string
  level?: string
  name?: string
  album_type?: string
  album?: string
  asset?: string
  media?: string
  subtype?: string
  since?: string
  until?: string
  where?: string
  out?: string
  file?: string
  token?: string
  format?: string
  limit?: number
  offset?: number
  size?: number
  favorite?: boolean
  hidden?: boolean
  burst?: boolean
  save?: boolean
  on?: boolean
}
export type DesktopPhotosNullableText = string | null
export type DesktopPhotosNullableNumber = number | null
export interface DesktopPhotosStatus { status: string; macOS?: string; provider?: string; scope?: string }
export interface DesktopPhotosAlbum { id: string; title: DesktopPhotosNullableText; type: string; subtype: string; estimatedAssetCount: DesktopPhotosNullableNumber }
export interface DesktopPhotosAlbums { albums: DesktopPhotosAlbum[] }
export interface DesktopPhotosLocation { latitude: number; longitude: number; altitude?: number; horizontalAccuracy?: number }
export interface DesktopPhotosAsset {
  id: string
  mediaType: string
  mediaSubtypes?: string[]
  pixelWidth: number
  pixelHeight: number
  duration: number
  isFavorite: boolean
  isHidden: boolean
  hasAdjustments?: boolean
  burstIdentifier?: DesktopPhotosNullableText
  playbackStyle?: string
  sourceType: string
  creationDate?: string
  modificationDate?: string
  addedDate?: string
  location?: DesktopPhotosLocation
}
export interface DesktopPhotosAssets { count: number; limit: number; offset: number; hasMore: boolean; assets: DesktopPhotosAsset[] }
export interface DesktopPhotosNamed { id: string; name: string }
export interface DesktopPhotosOK { ok: boolean; id: string; isFavorite?: boolean; isHidden?: boolean }
export interface DesktopPhotosDeleted { ok: boolean; deleted: string[] }
export interface DesktopPhotosMembership { ok: boolean; album: string; assets: string[] }
export interface DesktopPhotosResource { filePath: string; uti: string; bytes: number; type: string }
export interface DesktopPhotosExport { ok: boolean; assetId: string; filePath: string; uti: DesktopPhotosNullableText; bytes: number; originalWidth?: number; originalHeight?: number; exportWidth?: number; exportHeight?: number }
export interface DesktopPhotosLiveExport { ok: boolean; assetId: string; filePathBase: string; resources: DesktopPhotosResource[] }
export interface DesktopPhotosThumbnail { ok: boolean; format: string; bytes: number; width: number; height: number; filePath?: string; dataUrl?: string }
export interface DesktopPhotosChange { objectType: string; inserted: string[]; updated: string[]; deleted: string[] }
export interface DesktopPhotosToken { token: string }
export interface DesktopPhotosChanges { events: DesktopPhotosChange[]; currentToken: string }
export type DesktopPhotosData = DesktopPhotosStatus | DesktopPhotosAlbums | DesktopPhotosAlbum | DesktopPhotosAsset | DesktopPhotosAssets | DesktopPhotosNamed | DesktopPhotosOK | DesktopPhotosDeleted | DesktopPhotosMembership | DesktopPhotosExport | DesktopPhotosLiveExport | DesktopPhotosThumbnail | DesktopPhotosToken | DesktopPhotosChanges
export const DESKTOP_EVENTKIT_DEADLINE_MS = 58_000
export type DesktopCalendarOperation = "desktop_calendar"
export type DesktopCalendarVerb = "status" | "request" | "list" | "default" | "sources" | "create-calendar" | "delete-calendar" | "events" | "event" | "event-by-external" | "create" | "update" | "delete" | "move" | "refresh-sources" | "reset" | "tail"
export interface DesktopCalendarAction {
  type: DesktopCalendarOperation
  sub: DesktopCalendarVerb
  id?: string
  level?: string
  title?: string
  color?: string
  cal_type?: string
  source?: string
  start?: string
  end?: string
  calendar?: string
  calendars?: string
  all_day?: boolean
  location?: string
  notes?: string
  url?: string
  span?: string
  to?: string
  recurrence_frequency?: string
  recurrence_interval?: number
  recurrence_end?: string
  alarms?: string[]
  attendees?: string[]
  limit?: number
  offset?: number
}
export type DesktopRemindersOperation = "desktop_reminders"
export type DesktopRemindersVerb = "status" | "request" | "lists" | "default" | "all" | "incomplete" | "completed" | "create" | "update" | "complete" | "uncomplete" | "delete"
export interface DesktopRemindersAction {
  type: DesktopRemindersOperation
  sub: DesktopRemindersVerb
  id?: string
  list?: string
  due_start?: string
  due_end?: string
  since?: string
  until?: string
  title?: string
  due?: string
  start?: string
  priority?: string
  notes?: string
  url?: string
  limit?: number
  offset?: number
}
export type DesktopCalendarNullableText = string | null
export type DesktopCalendarAbsent = null
export interface DesktopCalendarSource { id: string; title: string; type: string }
// Native providers omit metadata their SDK cannot report. macOS supplies all
// three fields. Absence is never converted into a made-up false or zero.
export interface DesktopCalendarRow { id: string; title: string; type: string; allowsContentModifications: boolean; isImmutable?: boolean; isSubscribed?: boolean; supportedEventAvailabilities?: number; source?: DesktopCalendarSource }
export interface DesktopCalendarList { calendars: DesktopCalendarRow[] }
export interface DesktopCalendarNoDefault { calendar: DesktopCalendarAbsent }
export interface DesktopCalendarSources { sources: DesktopCalendarSource[] }
export interface DesktopCalendarStatus { events: string; reminders: string; macOS?: string; provider?: string; scope?: string }
export interface DesktopCalendarRequested { level: string; granted: boolean; error: DesktopCalendarNullableText }
export interface DesktopCalendarParticipant { name: DesktopCalendarNullableText; role: string; status: string; type: string }
export interface DesktopCalendarOrganizer { name: DesktopCalendarNullableText; isCurrentUser: boolean }
export interface DesktopCalendarAlarm { type?: string; relativeOffset: number; absoluteDate?: string }
export interface DesktopCalendarRecurrenceEnd { date?: string; occurrenceCount?: number }
export interface DesktopCalendarRecurrence { frequency: string; interval: number; end?: DesktopCalendarRecurrenceEnd }
export interface DesktopCalendarCoordinate { latitude: number; longitude: number }
export interface DesktopCalendarStructuredLocation { title: DesktopCalendarNullableText; radius: number; geoLocation?: DesktopCalendarCoordinate }
export interface DesktopCalendarEvent {
  id: string
  calendarId: string
  title: string
  startDate: string
  endDate: string
  isAllDay: boolean
  isDetached?: boolean
  status: string
  availability: string
  location?: string
  notes?: string
  url?: string
  occurrenceDate?: string
  organizer?: DesktopCalendarOrganizer
  attendees?: DesktopCalendarParticipant[]
  alarms?: DesktopCalendarAlarm[]
  recurrenceRules?: DesktopCalendarRecurrence[]
  structuredLocation?: DesktopCalendarStructuredLocation
}
export interface DesktopCalendarEvents { events: DesktopCalendarEvent[]; limit: number; offset: number; hasMore: boolean }
export interface DesktopCalendarDeleted { ok: boolean; id: string }
export interface DesktopCalendarOK { ok: boolean }
export interface DesktopCalendarTail { tailing: boolean; changeCount: number; lastChange: DesktopCalendarNullableText }
export type DesktopCalendarData = DesktopCalendarStatus | DesktopCalendarRequested | DesktopCalendarList | DesktopCalendarRow | DesktopCalendarNoDefault | DesktopCalendarSources | DesktopCalendarEvents | DesktopCalendarEvent | DesktopCalendarDeleted | DesktopCalendarOK | DesktopCalendarTail
export interface DesktopRemindersStatus { status: string; macOS?: string; provider?: string; scope?: string }
export interface DesktopRemindersRequested { granted: boolean; error: DesktopCalendarNullableText }
export interface DesktopRemindersList { id: string; title: string; allowsContentModifications: boolean }
export interface DesktopRemindersLists { lists: DesktopRemindersList[] }
export interface DesktopRemindersNoDefault { list: DesktopCalendarAbsent }
export interface DesktopRemindersComponents { year?: number; month?: number; day?: number; hour?: number; minute?: number; second?: number; timeZone?: string }
export interface DesktopRemindersRow {
  id: string
  listId: string
  title: string
  isCompleted: boolean
  priority: string
  completionDate?: string
  notes?: string
  url?: string
  startDateComponents?: DesktopRemindersComponents
  dueDateComponents?: DesktopRemindersComponents
  alarms?: DesktopCalendarAlarm[]
  recurrenceRules?: DesktopCalendarRecurrence[]
}
export interface DesktopRemindersRows { reminders: DesktopRemindersRow[]; limit: number; offset: number; hasMore: boolean }
export type DesktopRemindersData = DesktopRemindersStatus | DesktopRemindersRequested | DesktopRemindersLists | DesktopRemindersList | DesktopRemindersNoDefault | DesktopRemindersRows | DesktopRemindersRow | DesktopCalendarDeleted
export const DESKTOP_CONTACTS_DEADLINE_MS = 58_000
export type DesktopContactsOperation = "desktop_contacts"
export type DesktopContactsVerb = "status" | "request" | "containers" | "default-container" | "groups" | "group" | "group-create" | "group-update" | "group-delete" | "group-add-member" | "group-remove-member" | "list" | "contact" | "me" | "find" | "create" | "update" | "delete" | "vcard" | "import-vcard" | "current-token" | "changes"
export interface DesktopContactsAction {
  type: DesktopContactsOperation
  sub: DesktopContactsVerb
  id?: string
  path?: string
  query?: string
  keys?: string
  container?: string
  group?: string
  name?: string
  email?: string
  phone?: string
  given?: string
  family?: string
  organization?: string
  postal?: string
  birthday?: string
  note?: string
  since?: string
  contact?: string
  limit?: number
  offset?: number
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopContactsNullableText = string | null
export interface DesktopContactsLabelValue { label: string; value: string }
export interface DesktopContactsPhonetic { given?: string; middle?: string; family?: string }
export interface DesktopContactsOrganization { name?: string; department?: string; jobTitle?: string; phonetic?: string }
export interface DesktopContactsPostal { label: string; street: string; city: string; state: string; postalCode: string; country: string; isoCountryCode?: string }
export interface DesktopContactsSocial { label: string; service: string; username: string; url?: string }
export interface DesktopContactsRelation { label: string; name: string }
export interface DesktopContactsDate { label: string; date: DesktopContactsNullableText }
export interface DesktopContactsRow {
  id: string
  contactType?: string
  namePrefix?: string
  givenName?: string
  middleName?: string
  familyName?: string
  nameSuffix?: string
  nickname?: string
  phonetic?: DesktopContactsPhonetic
  organization?: DesktopContactsOrganization
  emailAddresses?: DesktopContactsLabelValue[]
  phoneNumbers?: DesktopContactsLabelValue[]
  urlAddresses?: DesktopContactsLabelValue[]
  socialProfiles?: DesktopContactsSocial[]
  instantMessageAddresses?: DesktopContactsSocial[]
  contactRelations?: DesktopContactsRelation[]
  imageDataAvailable?: boolean
  postalAddresses?: DesktopContactsPostal[]
  dates?: DesktopContactsDate[]
  birthday?: string
  thumbnailDataUrl?: string
  imageDataUrl?: string
  note?: DesktopContactsNullableText
  requires_entitlement?: string
}
export interface DesktopContactsStatus { status: string; macOS?: string; provider?: string; scope?: string; supportsLimited: boolean; notesEntitlement: boolean }
export interface DesktopContactsRequested { granted: boolean; error: DesktopContactsNullableText }
export interface DesktopContactsContainer { id: string; name: string; type: string }
export interface DesktopContactsContainers { containers: DesktopContactsContainer[] }
export interface DesktopContactsIdentity { id: string }
export interface DesktopContactsGroup { id: string; name: string }
export interface DesktopContactsGroups { groups: DesktopContactsGroup[] }
export interface DesktopContactsList { limit: number; offset: number; contacts: DesktopContactsRow[] }
export interface DesktopContactsFound { matches: DesktopContactsRow[] }
export interface DesktopContactsDeleted { ok: boolean; id: string }
export interface DesktopContactsMember { ok: boolean; group: string; contact: string; added: boolean }
export interface DesktopContactsVCard { id: string; vcard: string; bytes: number }
export interface DesktopContactsImported { imported: number; ids: string[] }
export interface DesktopContactsToken { token: DesktopContactsNullableText }
export interface DesktopContactsEvent { type: string; contactId?: string; groupId?: string; parent?: string; child?: string }
export interface DesktopContactsChanges { currentToken: DesktopContactsNullableText; events: DesktopContactsEvent[] }
export type DesktopContactsData = DesktopContactsStatus | DesktopContactsRequested | DesktopContactsContainers | DesktopContactsIdentity | DesktopContactsGroup | DesktopContactsGroups | DesktopContactsList | DesktopContactsRow | DesktopContactsFound | DesktopContactsDeleted | DesktopContactsMember | DesktopContactsVCard | DesktopContactsImported | DesktopContactsToken | DesktopContactsChanges
// Below both historical Swift limits. Upload frames have their own larger limit.
export const DESKTOP_MAX_FRAME_BYTES = 9_999_999
// A 128-byte id can expand to 768 JSON bytes. Leave room for the envelope too.
export const DESKTOP_MAX_RESULT_BYTES = 9_998_975

export const DESKTOP_STREAM_MAX_SESSIONS = 4
export const DESKTOP_SOUND_MAX_HISTORY = 500
export type DesktopSoundOperation = "desktop_sounds"
export type DesktopSoundVerb = "start" | "stop" | "status" | "tail" | "log"
export interface DesktopSoundAction {
  type: DesktopSoundOperation
  sub: DesktopSoundVerb
  filter?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopSoundClassification { label: string; confidence: number; timestamp: number }
export type DesktopSoundLatest = DesktopSoundClassification | null
export interface DesktopSoundStarted { classifying: boolean }
export interface DesktopSoundStopped { classifying: boolean; totalClassifications: number }
export interface DesktopSoundStatus { classifying: boolean; latest: DesktopSoundLatest }
export interface DesktopSoundTail { classifying: boolean; classifications: DesktopSoundClassification[] }
export type DesktopStreamOperation = "desktop_stream"
export type DesktopStreamVerb = "start" | "stop" | "status" | "list" | "frame" | "fps" | "resolution" | "inject" | "record"
export type DesktopStreamInput = "click" | "type" | "keys" | "scroll"
export type DesktopStreamRecordVerb = "start" | "stop" | "status"
export const DESKTOP_STREAM_MEDIA_MAX_BYTES = 104_857_600
export const DESKTOP_STREAM_MEDIA_MAX_SECONDS = 3600
export const DESKTOP_STREAM_MEDIA_MAX_FRAMES = 100_000
export type DesktopStreamRecordingAudio = "none" | "system"
export type DesktopStreamMediaContainer = "matroska" | "mp4"
export type DesktopStreamVideoCodec = "mjpeg" | "h264"
export type DesktopStreamTimingBasis = "monotonic-arrival" | "native-media"
export type DesktopStreamSourceKind = "window" | "display" | "portal-monitor"
export interface DesktopStreamMediaSource { kind: DesktopStreamSourceKind; pid?: number; window?: number; display?: number }
export interface DesktopStreamMediaArtifact {
  filePath: string; container: DesktopStreamMediaContainer; videoCodec: DesktopStreamVideoCodec
  audio: DesktopStreamRecordingAudio; timing: DesktopStreamTimingBasis; finalized: boolean
  bytes: number; sha256?: string; source: DesktopStreamMediaSource
}
export interface DesktopStreamAction {
  type: DesktopStreamOperation
  op: DesktopStreamVerb
  sid?: string
  app?: string
  window?: number
  display?: number
  virtual?: string
  format?: string
  inputType?: DesktopStreamInput
  ref?: string
  x?: number
  y?: number
  text?: string
  combo?: string
  direction?: DesktopAxScrollDirection
  amount?: number
  recordOp?: DesktopStreamRecordVerb
  media?: boolean
  recordAudio?: DesktopStreamRecordingAudio
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopStreamStarted { sid: string; status: string }
export interface DesktopStreamFrame { dataUrl: string; frameCount: number }
export interface DesktopStreamFPS { fps: number }
export interface DesktopStreamResolution { width: number; height: number }
export interface DesktopStreamStatusRow { sid: string; frameCount: number; fps: number; duration: number }
export interface DesktopStreamListRow { sid: string; frameCount: number; currentFPS: number; width: number; height: number; recording: boolean; startedAt?: string }
export interface DesktopStreamRecorded { recording: boolean; sid?: string; frames?: number; duration?: number; artifact?: DesktopStreamMediaArtifact }

export type DesktopTrustOperation = "desktop_trust"
export type DesktopTrustStatus = "granted" | "denied" | "not_determined" | "restricted" | "unknown"
export type DesktopTrustNullableText = string | null
export interface DesktopTrustAction {
  type: DesktopTrustOperation
  noPrompt?: boolean
  prompt?: boolean
  walkthrough?: boolean
  accessibilityPrompt?: boolean
  screenPrompt?: boolean
  microphonePrompt?: boolean
  speechPrompt?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopTrustPermission {
  name: string
  status: DesktopTrustStatus
  required: boolean
  granted: boolean
  path: string
  reason: string
  limitation?: string
  nativeStatus?: string
}
export interface DesktopTrustSigning {
  adhoc: boolean
  teamId: DesktopTrustNullableText
  identifier: DesktopTrustNullableText
  cdhash: DesktopTrustNullableText
}
export interface DesktopTrustData {
  accessibility: DesktopTrustStatus
  screenRecording: DesktopTrustStatus
  microphone: DesktopTrustStatus
  speechRecognition: DesktopTrustStatus
  permissions: DesktopTrustPermission[]
  bundlePath: string
  displayName: string
  signing?: DesktopTrustSigning
  warnings?: string[]
  action_required?: string[]
  prompted?: string[]
  opened?: string[]
  pending_user_action?: string[]
}

export const DESKTOP_SPEECH_DEADLINE_MS = 15_000
export const DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES = 65_536
export const DESKTOP_SPEECH_MAX_VOCABULARY_WORDS = 100
export type DesktopSpeechOperation = "desktop_listen"
export type DesktopSpeechVerb = "start" | "stop" | "status" | "transcript" | "tail" | "vocab"
export type DesktopSpeechVocabularyVerb = "add" | "clear" | "list"
export interface DesktopSpeechAction {
  type: DesktopSpeechOperation
  sub: DesktopSpeechVerb
  device?: string
  op?: DesktopSpeechVocabularyVerb
  word?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopSpeechStatus { listening: boolean }
export interface DesktopSpeechSnapshot { listening: boolean; transcript: string }
export interface DesktopSpeechVocabularyAdded { added: string; total: number }

export const DESKTOP_VAD_DEADLINE_MS = 15_000
export type DesktopVadOperation = "desktop_vad"
export type DesktopVadVerb = "start" | "stop" | "status"
export interface DesktopVadAction {
  type: DesktopVadOperation
  sub: DesktopVadVerb
  threshold?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopVadLifecycle { active: boolean }
export interface DesktopVadStatus { active: boolean; speaking: boolean; level: number }

export const DESKTOP_AUDIO_DEADLINE_MS = 35_000
export type DesktopAudioOperation = "desktop_audio"
export type DesktopAudioChannel = "input" | "output" | "both"
export type DesktopAudioVerb = "start" | "stop" | "level" | "devices"
export type DesktopAudioNullableNumber = number | null
export type DesktopAudioNullableString = string | null
export type DesktopAudioNullableBoolean = boolean | null
export type DesktopAudioDeviceID = string | number
export interface DesktopAudioAction {
  type: DesktopAudioOperation
  sub: DesktopAudioChannel
  op: DesktopAudioVerb
  app?: string
  device?: string
  save?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopAudioDevice {
  uniqueID: string
  deviceID: DesktopAudioDeviceID
  localizedName: string
  manufacturer: DesktopAudioNullableString
  modelID: DesktopAudioNullableString
  deviceType: string
  isConnected: DesktopAudioNullableBoolean
  role: DesktopAudioChannel
  channels: number
  sampleRate: DesktopAudioNullableNumber
  isDefault: boolean
}
export interface DesktopAudioStarted {
  message: string
  sampleRate?: number
  channels?: number
  filePath?: string
}
export interface DesktopAudioBothStarted {
  input: string
  output: string
  inputFilePath?: string
  outputFilePath?: string
}
export interface DesktopAudioLevel {
  active: boolean
  level: DesktopAudioNullableNumber
  peak: DesktopAudioNullableNumber
  frames: number
  channels?: number
  sampleRate?: number
  timestamp?: number
  filePath?: string
  error?: string
}
export interface DesktopAudioInputFormat { sampleRate: DesktopAudioNullableNumber; channels: number }
export type DesktopAudioNullableInputFormat = DesktopAudioInputFormat | null
export interface DesktopAudioInputDevices { defaultInput: DesktopAudioNullableInputFormat; devices: DesktopAudioDevice[]; count: number }
export interface DesktopAudioBothLevel { input: DesktopAudioLevel; output: DesktopAudioLevel }
export interface DesktopAudioBothDevices { input: DesktopAudioDevice[]; output: DesktopAudioDevice[] }

export const DESKTOP_PDF_DEADLINE_MS = 35_000
export type DesktopPdfOperation = "desktop_pdf"
export type DesktopPdfVerb = "info" | "text" | "outline" | "annotations" | "forms" | "forms_set" | "images" | "find" | "attributes" | "permissions" | "annotate" | "strip" | "merge" | "split"
export interface DesktopPdfAction {
  type: DesktopPdfOperation
  sub: DesktopPdfVerb
  path?: string
  paths?: string[]
  page?: number
  range?: string
  attributed?: boolean
  annotation_type?: string
  field?: string
  value?: string
  query?: string
  case_sensitive?: boolean
  rect?: string
  contents?: string
  pages?: string
  out?: string
  group?: string
  groupColor?: string
}
export type PdfNullableString = string | null
export type PdfAttributeValue = string | string[]
export interface PdfRectData { x: number; y: number; w: number; h: number }
export interface PdfDestinationData { pageIndex: number; x?: number; y?: number }
export interface PdfAnnotationData {
  page: number
  type: string
  bounds: PdfRectData
  contents: PdfNullableString
  userName: PdfNullableString
  modificationDate: PdfNullableString
  color?: string
  backgroundColor?: string
  markupType?: string
  widgetFieldType?: string
  widgetStringValue?: string
  fieldName?: string
  isReadOnly: boolean
  isMultiline: boolean
  isPasswordField: boolean
  maximumLength: number
  hasComb: boolean
  choices?: string[]
  values?: string[]
  isListChoice: boolean
  url?: string
  destination?: PdfDestinationData
}
export interface PdfOutlineData { label: string; isOpen: boolean; destination?: PdfDestinationData; children?: PdfOutlineData[] }
export interface PdfFontData { name: string; size: number }
export interface PdfAttributedRunData { range: number[]; font?: PdfFontData; color?: string }
export interface PdfPageTextData { page: number; characterCount: number; text: string; attributedString?: PdfAttributedRunData[] }
export interface PdfImagePageData { page: number; mediaBox: PdfRectData; rotation: number; stamps: PdfAnnotationData[] }
export interface PdfFindMatchData { page: number; text: string; bounds: PdfRectData }
export interface DesktopPdfInfoData { path: string; pageCount: number; isLocked: boolean; isEncrypted: boolean; allowsCopying: boolean; allowsPrinting: boolean; accessPermissions: string[]; attributes: Record<string, PdfAttributeValue> }
export interface DesktopPdfPermissionsData { path: string; isLocked: boolean; isEncrypted: boolean; allowsCopying: boolean; allowsPrinting: boolean; permissions: string[] }
export interface DesktopPdfSingleTextData { path: string; page: number; characterCount: number; text: string; attributedString?: PdfAttributedRunData[] }
export interface DesktopPdfTextData { path: string; pageCount: number; characterCount: number; text: string; pages: PdfPageTextData[] }
export interface DesktopPdfOutlineData { path: string; outline: PdfOutlineData[] }
export interface DesktopPdfAnnotationsData { path: string; annotations: PdfAnnotationData[] }
export interface DesktopPdfFormsData { path: string; forms: PdfAnnotationData[] }
export interface DesktopPdfFormsSetData { savedTo: string; fieldName: string; newValue: string; ok: boolean }
export interface DesktopPdfImagesData { path: string; pages: PdfImagePageData[] }
export interface DesktopPdfFindData { path: string; query: string; matchCount: number; matches: PdfFindMatchData[] }
export interface DesktopPdfAttributesData { path: string; attributes: Record<string, PdfAttributeValue> }
export interface DesktopPdfAnnotateData { savedTo: string; page: number; annotation: PdfAnnotationData }
export interface DesktopPdfStripData { savedTo: string; pageCount: number }
export interface DesktopPdfMergeData { savedTo: string; pageCount: number; sources: string[] }
export interface DesktopPdfSplitData { savedTo: string; pageCount: number; source: string; range: number[] }

export type DesktopHost = "darwin" | "win32" | "linux"
export type DesktopPermission = "granted" | "denied" | "prompt_required" | "restricted" | "not_applicable" | "unknown"
export type DesktopBackground = "semantic" | "window" | "foreground_required" | "unavailable"
export type DesktopErrorCode =
  "invalid_request" | "version_mismatch" | "not_installed" | "no_interactive_session" |
  "permission_required" | "permission_denied" | "restricted_by_os" | "unsupported_operation" |
  "unsupported_target" | "target_ambiguous" | "target_gone" | "stale_reference" |
  "background_unavailable" | "capture_protected" | "resource_limit" | "partial_result" |
  "cancelled" | "timeout_unknown_outcome" | "provider_failed" | "human_required"

export interface DesktopCapability {
  operation: string
  compiled: boolean
  present: boolean
  permission: DesktopPermission
  session: string
  effective: boolean
  background: DesktopBackground
  provider: string
  versions: Record<string, string>
  limits: string[]
  reason?: string
  remediation?: string
}

export interface DesktopHello {
  protocolVersion: number
  maxFrameBytes: number
  host: DesktopHost
  provider: string
  version: string
  pid: number
  session: string
  capabilities: DesktopCapability[]
  accessibilityGranted?: boolean
}

// The action stays flat, exactly as in the existing four-byte LE JSON protocol.
export interface DesktopRequest {
  id: string
  action: Record<string, unknown>
  protocolVersion?: number
  token?: string
}

export interface DesktopResult {
  success: boolean
  error?: string
  code?: DesktopErrorCode
  data?: unknown
  remediation?: string
  retryable?: boolean
  details?: Record<string, unknown>
}

export interface DesktopReply {
  id: string
  result: DesktopResult
}

export const DESKTOP_SCRIPT_DEADLINE_MS = 35_000
export type DesktopScriptRunOperation = "desktop_script_run"
export type DesktopScriptIntentOperation = "desktop_intent_dispatch"
export interface DesktopScriptRunAction {
  type: DesktopScriptRunOperation
  jsc: string
  jscHost?: string
  args?: string[]
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopScriptIntentAction {
  type: DesktopScriptIntentOperation
  jsc: string
  jscHost?: string
  args?: string[]
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface ScriptEvaluationData {
  result: unknown
  raw: string
  script: string
  language: string
  engine?: string
  arguments?: string[]
  host?: Record<string, string[]>
}

export const DESKTOP_VISION_DEADLINE_MS = 35_000
export type DesktopVisionOperation = "desktop_vision"
export type DesktopVisionVerb = "text" | "faces" | "hands" | "bodies" | "classify" | "saliency"
export interface DesktopVisionAction {
  type: DesktopVisionOperation
  sub: DesktopVisionVerb
  app?: string
  imagePath?: string
  debugDumpPath?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
/** Windows OCR and OpenCV detectors report no score; null means the system gave none. */
export type DesktopVisionConfidence = number | null
export interface DesktopVisionTextRegion { text: string; confidence: DesktopVisionConfidence; x: number; y: number; width: number; height: number }
export interface DesktopVisionTextData { text: string; regions: DesktopVisionTextRegion[]; count: number }
export interface DesktopVisionRegion { confidence: DesktopVisionConfidence; x: number; y: number; width: number; height: number }
export interface DesktopVisionFaces { faces: DesktopVisionRegion[]; count: number }
export type DesktopVisionJointConfidence = number | null
export interface DesktopVisionJoint { x: number; y: number; confidence: DesktopVisionJointConfidence }
export interface DesktopVisionHand { joints: Record<string, DesktopVisionJoint>; chirality: number }
export interface DesktopVisionBody { joints: Record<string, DesktopVisionJoint> }
export interface DesktopVisionHands { hands: DesktopVisionHand[]; count: number }
export interface DesktopVisionBodies { bodies: DesktopVisionBody[]; count: number }
export interface DesktopVisionClassification { label: string; confidence: number }
export interface DesktopVisionClassifications { classifications: DesktopVisionClassification[] }
export interface DesktopVisionSaliency { regions: DesktopVisionRegion[] }
export type DesktopVisionData = DesktopVisionTextData | DesktopVisionFaces | DesktopVisionHands | DesktopVisionBodies | DesktopVisionClassifications | DesktopVisionSaliency

export const DESKTOP_SENSITIVE_DEADLINE_MS = 35_000
export type DesktopSensitiveOperation = "desktop_sensitive"
export type DesktopSensitiveVerb = "check" | "monitor"
export type DesktopSensitiveMonitorVerb = "start" | "stop" | "status"
export interface DesktopSensitiveAction {
  type: DesktopSensitiveOperation
  sub: DesktopSensitiveVerb
  op?: DesktopSensitiveMonitorVerb
  app?: string
  imagePath?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopSensitiveCheck {
  policyEnabled: boolean
  policy: string
  isSensitive: boolean
  timestamp: number
}
export type DesktopSensitiveLatest = DesktopSensitiveCheck | null
export type DesktopSensitiveError = string | null
export interface DesktopSensitiveMonitor {
  monitoring: boolean
  latest: DesktopSensitiveLatest
  checks: number
  lastError: DesktopSensitiveError
  cleanupPending: boolean
}
export type DesktopSensitiveData = DesktopSensitiveCheck | DesktopSensitiveMonitor

export const DESKTOP_UPDATE_DEADLINE_MS = 15_000
export type DesktopUpdateOperation = "desktop_update"
export type DesktopUpdateVerb = "check" | "status" | "install"
export type DesktopUpdatePhase = "idle" | "checking" | "update_available" | "downloading" | "downloaded" | "extracting" | "ready_to_install" | "installing" | "deferred" | "error"
export type DesktopUpdateOutcome = "none" | "checking" | "update_available" | "up_to_date" | "no_eligible_update" | "install_chosen" | "deferred" | "skipped" | "installing" | "error"
export interface DesktopUpdateAction {
  type: DesktopUpdateOperation
  sub: DesktopUpdateVerb
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopUpdateData {
  phase: DesktopUpdatePhase
  outcome: DesktopUpdateOutcome
  concluded: boolean
  feed: string
  automaticChecks: boolean
  checkInterval: number
  canCheckForUpdates: boolean
  sessionInProgress: boolean
  currentVersion?: string
  selectedVersion?: string
  selectedDisplayVersion?: string
  latestFeedVersion?: string
  noUpdateReason?: string
  userChoice?: string
  updateStage?: string
  lastError?: string
  checkStartedAt?: string
  updatedAt?: string
  cycleFinishedAt?: string
  lastCheck?: string
  sessionAgeSeconds?: number
  recoveryHint?: string
  started?: boolean
  message?: string
  artifactName?: string
  artifactURL?: string
  signatureVerified?: boolean
  nextCheckAt?: string
  lastInstallVersion?: string
  lastInstallOutcome?: string
  lastInstallAt?: string
}

export const DESKTOP_LOCATION_DEADLINE_MS = 35_000
export type DesktopLocationOperation = "desktop_location"
export type DesktopLocationVerb = "status" | "request" | "request-temporary-accuracy" | "current" | "monitor_start" | "monitor_stop" | "monitor_tail" | "significant_start" | "significant_stop" | "visits_start" | "visits_stop" | "heading_start" | "heading_stop" | "geocode" | "reverse" | "distance" | "postal-geocode"
export type DesktopLocationLevel = "whenInUse" | "always"
export type DesktopLocationAccuracy = "best" | "nearest" | "tenmeters" | "hundredmeters" | "kilometer" | "threekilometers"
export interface DesktopLocationAction {
  type: DesktopLocationOperation
  sub: DesktopLocationVerb
  level?: DesktopLocationLevel
  purpose?: string
  accuracy?: DesktopLocationAccuracy
  address?: string
  coords?: string
  postal?: string
  region?: string
  locale?: string
  from?: string
  to?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopLocationNumber = number | null
export type DesktopLocationBoolean = boolean | null
export type DesktopLocationText = string | null
export type DesktopLocationCoordinate = number[]
export interface DesktopLocationPoint {
  coordinate: DesktopLocationCoordinate
  altitude: DesktopLocationNumber
  ellipsoidalAltitude: DesktopLocationNumber
  horizontalAccuracy: number
  verticalAccuracy: DesktopLocationNumber
  course: DesktopLocationNumber
  courseAccuracy: DesktopLocationNumber
  speed: DesktopLocationNumber
  speedAccuracy: DesktopLocationNumber
  timestamp: string
  floor: DesktopLocationNumber
}
export interface DesktopLocationStatus {
  locationServicesEnabled: DesktopLocationBoolean
  macOS?: string
  status: string
  accuracyAuthorization: string
  providerPresent?: boolean
}
export interface DesktopLocationRequest {
  requested: DesktopLocationLevel
  status: string
  pendingUserAction?: boolean
}
export interface DesktopLocationTemporary {
  accuracyAuthorization: string
}
export interface DesktopLocationMonitorStart {
  monitoring: boolean
  accuracy: DesktopLocationAccuracy
}
export interface DesktopLocationMonitorStop {
  monitoring: boolean
}
export interface DesktopLocationTail {
  locations: DesktopLocationPoint[]
  monitoring: boolean
  lastError?: string
}
export interface DesktopLocationAck {
  ok: boolean
  note?: string
}
export interface DesktopLocationDistance {
  meters: number
}
export interface DesktopLocationPlacemark {
  name: DesktopLocationText
  attribution?: string
  coordinate?: DesktopLocationCoordinate
  thoroughfare?: string
  subThoroughfare?: string
  locality?: string
  subLocality?: string
  administrativeArea?: string
  subAdministrativeArea?: string
  postalCode?: string
  isoCountryCode?: string
  country?: string
  inlandWater?: string
  ocean?: string
  areasOfInterest?: string[]
}
export interface DesktopLocationGeocoded {
  placemarks: DesktopLocationPlacemark[]
  coordinate?: DesktopLocationCoordinate
}
export type DesktopLocationData = DesktopLocationPoint | DesktopLocationStatus | DesktopLocationRequest | DesktopLocationTemporary | DesktopLocationMonitorStart | DesktopLocationMonitorStop | DesktopLocationTail | DesktopLocationAck | DesktopLocationDistance | DesktopLocationGeocoded

export const DESKTOP_MAPS_DEADLINE_MS = 60_000
export type DesktopMapsOperation = "desktop_maps"
export type DesktopMapsVerb = "search" | "complete" | "directions" | "eta" | "mapitem-open" | "reverse"
export type DesktopMapsTransport = "auto" | "walking" | "transit" | "any"
export type DesktopMapsText = string | null
export type DesktopMapsBoolean = boolean | null
export interface DesktopMapsAction {
  type: DesktopMapsOperation
  sub: DesktopMapsVerb
  query?: string
  coords?: string
  id?: string
  region?: string
  types?: string
  poi_categories?: string
  address_include?: string
  address_exclude?: string
  limit?: number
  from?: string
  to?: string
  transport?: DesktopMapsTransport
  requests_alternates?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopMapsRegion { center: number[]; span: number[] }
export interface DesktopMapsItem {
  id: string
  name: DesktopMapsText
  isCurrentLocation: boolean
  placemark: DesktopLocationPlacemark
  timeZone?: string
  url?: string
  phoneNumber?: string
  pointOfInterestCategory?: string
}
export interface DesktopMapsSearch { query: string; boundingRegion?: DesktopMapsRegion; results: DesktopMapsItem[] }
export interface DesktopMapsCompletion { title: string; subtitle: string }
export interface DesktopMapsCompleted { query: string; completions: DesktopMapsCompletion[] }
export interface DesktopMapsStep { instructions: string; distance: number }
export interface DesktopMapsRoute {
  name: string
  distance: number
  expectedTravelTime: number
  transportType: string
  advisoryNotices: string[]
  hasTolls: DesktopMapsBoolean
  steps: DesktopMapsStep[]
  attribution?: string
}
export interface DesktopMapsDirections { transport: string; routes: DesktopMapsRoute[]; source: DesktopMapsItem; destination: DesktopMapsItem; partial?: boolean }
export interface DesktopMapsETA { transport: string; expectedTravelTime: number; distance: number; expectedDepartureDate: string; expectedArrivalDate: string; attribution?: string; dateSource?: string; partial?: boolean }
export interface DesktopMapsOpened { ok: boolean; id: string }
export interface DesktopMapsReverse { coordinate: number[]; placemarks: DesktopLocationPlacemark[] }
export type DesktopMapsData = DesktopMapsSearch | DesktopMapsCompleted | DesktopMapsDirections | DesktopMapsETA | DesktopMapsOpened | DesktopMapsReverse

export const DESKTOP_SHARE_DEADLINE_MS = 58_000
export type DesktopShareOperation = "desktop_share"
export type DesktopShareVerb = "services" | "airdrop" | "email" | "message" | "reading-list" | "desktop-picture" | "named" | "text" | "url"
export interface DesktopShareAction {
  type: DesktopShareOperation
  sub: DesktopShareVerb
  items?: string[]
  text?: string
  url?: string
  body?: string
  value?: string
  service?: string
  recipient?: string
  recipients?: string[]
  subject?: string
  for_item?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopShareService { title: string; menuItemTitle: string; canPerform: boolean; id?: string }
export interface DesktopShareServices { services: DesktopShareService[] }
export type DesktopShareNullableText = string | null
export interface DesktopShareCompleted { ok: boolean; service: string; items?: string[]; recipients?: string[]; subject?: DesktopShareNullableText; note?: string; outcome?: string }
export type DesktopShareData = DesktopShareServices | DesktopShareCompleted

export const DESKTOP_MUSIC_DEADLINE_MS = 35_000
export type DesktopMusicOperation = "desktop_music"
export type DesktopMusicVerb = "status" | "request" | "subscription" | "library" | "library-search" | "play" | "pause" | "resume" | "stop" | "next" | "previous" | "seek" | "queue" | "repeat" | "shuffle" | "now-playing" | "search" | "search-suggest" | "charts" | "recommendations" | "song" | "album" | "artist" | "playlist"
export type DesktopMusicKind = "song" | "album" | "artist" | "playlist" | "track"
export interface DesktopMusicAction {
  type: DesktopMusicOperation
  sub: DesktopMusicVerb
  kind?: DesktopMusicKind
  types?: string
  term?: string
  limit?: number
  offset?: number
  filter?: string
  sort?: string
  ascending?: boolean
  top?: boolean
  include_tracks?: boolean
  include_system?: boolean
  song?: string
  album?: string
  playlist?: string
  // Apple Music catalog id for the song/album/artist/playlist fetchers (Mac only)
  id?: string
  time?: number
  mode?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopMusicUnavailable { available: boolean; note?: string; framework?: string }
export interface DesktopMusicStatus { authorization: string; macOS?: string; frameworkAvailable: boolean; applicationPlayerAvailable: boolean; libraryAvailable: boolean; provider?: string }
export interface DesktopMusicAuthorization { authorization: string }
export interface DesktopMusicSubscription { canBecomeSubscriber: boolean; canPlayCatalogContent: boolean; hasCloudLibraryEnabled: boolean }
export interface DesktopMusicItem { id: string; title?: string; name?: string; artistName?: string; albumTitle?: string; duration?: number; isrc?: string; genreNames?: string[]; tracks?: DesktopMusicItem[] }
export interface DesktopMusicLibrary { items: DesktopMusicItem[] }
export interface DesktopMusicSearch { term: string; songs: DesktopMusicItem[]; albums: DesktopMusicItem[]; artists: DesktopMusicItem[]; playlists: DesktopMusicItem[]; topResults?: DesktopMusicItem[] }
export interface DesktopMusicSuggestions { term: string; suggestions: string[] }
export interface DesktopMusicChart { title: string; items: DesktopMusicItem[] }
export interface DesktopMusicCharts { songCharts: DesktopMusicChart[]; albumCharts: DesktopMusicChart[] }
export interface DesktopMusicRecommendations { recommendations: DesktopMusicItem[] }
export interface DesktopMusicAck { ok: boolean; playbackStatus?: string; playbackTime?: number }
export interface DesktopMusicQueue { entries: DesktopMusicItem[]; count: number }
export interface DesktopMusicRepeat { repeatMode: string }
export interface DesktopMusicShuffle { shuffleMode: string }
export interface DesktopMusicSystem { running: boolean; source?: string; title?: string; artistName?: string; status?: string; playbackTime?: number; repeatMode?: string; shuffleMode?: string; currentEntry?: DesktopMusicItem }
export type DesktopMusicMeasurement = number | null
export interface DesktopMusicPlaying { status: string; playbackRate: DesktopMusicMeasurement; playbackTime: DesktopMusicMeasurement; repeatMode: string; shuffleMode: string; queueLength: number; currentEntry?: DesktopMusicItem; system?: DesktopMusicSystem; note?: string }
export type DesktopMusicData = DesktopMusicUnavailable | DesktopMusicStatus | DesktopMusicAuthorization | DesktopMusicSubscription | DesktopMusicLibrary | DesktopMusicSearch | DesktopMusicSuggestions | DesktopMusicCharts | DesktopMusicRecommendations | DesktopMusicAck | DesktopMusicQueue | DesktopMusicRepeat | DesktopMusicShuffle | DesktopMusicPlaying

export const DESKTOP_LANGUAGE_MAX_TEXT_BYTES = 65_536
export const DESKTOP_LANGUAGE_DEADLINE_MS = 125_000
export type DesktopLanguageNlpOperation = "desktop_nlp"
export type DesktopLanguageNlpVerb = "entities" | "language" | "sentiment" | "tokens" | "similar" | "embed"
export interface DesktopLanguageNlpAction {
  type: DesktopLanguageNlpOperation
  sub: DesktopLanguageNlpVerb
  text?: string
  word1?: string
  word2?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopLanguageEntity { text: string; type: string }
/** Windows ELS and libexttextcat rank languages without a score; null means the system gave none. */
export type DesktopLanguageConfidence = number | null
export interface DesktopLanguageHypothesis { language: string; confidence: DesktopLanguageConfidence }
export interface DesktopLanguageDetection { dominant: string; hypotheses: DesktopLanguageHypothesis[] }
export interface DesktopLanguageSentiment { score: number; label: string }
export interface DesktopLanguageEmbedding { vector: number[]; dimensions: number }
export interface DesktopLanguageSimilarity { distance: number; word1: string; word2: string }
export type DesktopLanguageNlpData = DesktopLanguageEntity[] | string[] | DesktopLanguageDetection | DesktopLanguageSentiment | DesktopLanguageEmbedding | DesktopLanguageSimilarity
export type DesktopLanguageAiOperation = "desktop_ai"
export type DesktopLanguageAiVerb = "status" | "prompt" | "session"
export type DesktopLanguageSessionVerb = "start" | "send" | "history" | "end"
export interface DesktopLanguageAiAction {
  type: DesktopLanguageAiOperation
  sub: DesktopLanguageAiVerb
  op?: DesktopLanguageSessionVerb
  prompt?: string
  message?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopLanguageStatus { available: boolean; framework: string; model?: string; reason?: string }
export interface DesktopLanguageMessage { role: string; content: string }
export interface DesktopLanguageSessionStart { sessionActive: boolean }
export interface DesktopLanguageSessionResponse { response: string }
export interface DesktopLanguageSessionEnd { sessionEnded: boolean; turns: number }
export type DesktopLanguageAiData = string | DesktopLanguageStatus | DesktopLanguageMessage[] | DesktopLanguageSessionStart | DesktopLanguageSessionResponse | DesktopLanguageSessionEnd
export type DesktopLanguageTranslateOperation = "desktop_translate"
export type DesktopLanguageTranslateVerb = "status" | "languages" | "availability" | "prepare" | "text" | "batch" | "file" | "stop"
export type DesktopLanguageNullableString = string | null
export interface DesktopLanguageTranslateAction {
  type: DesktopLanguageTranslateOperation
  sub: DesktopLanguageTranslateVerb
  from?: string
  to?: string
  sample?: string
  json?: string
  input?: string
  path?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopLanguageSupportedLanguage { languageCode: string; region: string }
export interface DesktopLanguageSupported { supported: DesktopLanguageSupportedLanguage[] }
export interface DesktopLanguageAvailability { from?: string; sample?: string; to: string; status: string }
export interface DesktopLanguagePrepared { from: string; to: string; ready: boolean }
export interface DesktopLanguageTranslation {
  sourceText: string
  sourceLanguage: DesktopLanguageNullableString
  targetLanguage: string
  targetText: string
  isReady: boolean
}
export interface DesktopLanguageTranslatedRow { sourceText: string; targetText: DesktopLanguageNullableString; ok: boolean; error?: string }
export interface DesktopLanguageTranslatedBatch { from: string; to: string; translations: DesktopLanguageTranslatedRow[] }
export interface DesktopLanguageStopped { ok: boolean; note: string }
export type DesktopLanguageTranslateData = DesktopLanguageStatus | DesktopLanguageSupported | DesktopLanguageAvailability | DesktopLanguagePrepared | DesktopLanguageTranslation | DesktopLanguageTranslatedBatch | DesktopLanguageStopped
export type DesktopLanguageDetectOperation = "desktop_detect"
export type DesktopLanguageDetectVerb = "types" | "run" | "file" | "stdin"
export interface DesktopLanguageDetectAction {
  type: DesktopLanguageDetectOperation
  sub: DesktopLanguageDetectVerb
  input?: string
  path?: string
  types?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopLanguageDetectorComponent = string | number | string[]
export interface DesktopLanguageDetectedMatch {
  range: number[]
  value: string
  type: string
  components?: Record<string, DesktopLanguageDetectorComponent>
}
export interface DesktopLanguageDetected { input: string; matches: DesktopLanguageDetectedMatch[] }
export interface DesktopLanguageDetectorTypes { types: string[] }
export type DesktopLanguageDetectData = DesktopLanguageDetected | DesktopLanguageDetectorTypes

export const DESKTOP_MONITOR_MAX_SESSIONS = 16
export const DESKTOP_MONITOR_MAX_ENTRIES = 1000
export const DESKTOP_MONITOR_MAX_ARCHIVE_BYTES = 104_857_600
export const DESKTOP_MONITOR_MAX_RESULT_BYTES = 1_048_576
export type DesktopMonitorOperation = "desktop_monitor"
export type DesktopMonitorVerb = "start" | "stop" | "pause" | "resume" | "status" | "tail" | "list" | "export"
export type DesktopMonitorFormat = "json" | "timeline" | "plan"
export type DesktopMonitorSpeechMode = "auto" | "off" | "live" | "offline"
export type DesktopMonitorFrameFormat = "jpeg" | "png" | "webp"
export type DesktopMonitorTaskMode = "human-observe" | "human-teach" | "agent-record" | "mixed"
export interface DesktopMonitorAction {
  type: DesktopMonitorOperation
  sub: DesktopMonitorVerb
  sid?: string
  instruction?: string
  format?: DesktopMonitorFormat
  raw?: boolean
  limit?: number
  app?: string
  apps?: string[]
  allApps?: boolean
  include?: string[]
  exclude?: string[]
  frames?: number
  visionText?: boolean
  frameFormat?: DesktopMonitorFrameFormat
  frameQuality?: number
  frameMaxLongEdge?: number
  tap?: boolean
  watchPath?: string
  watchPaths?: string[]
  logPredicate?: string
  speechMode?: DesktopMonitorSpeechMode
  video?: number
  videoMaxBytes?: number
  frameBudget?: number
  frameDiskCap?: number
  framePixelScale?: number
  scrollCoalesceMs?: number
  axCoalesceMs?: number
  includeSystemApps?: boolean
  excludeApps?: string[]
  taskId?: string
  taskRef?: string
  taskMode?: DesktopMonitorTaskMode
  retentionPolicyId?: string
  guardPolicyId?: string
  verifierPolicyId?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopMonitorSurface = "macos" | "desktop"
export type DesktopMonitorScopeMode = "frontmost" | "apps" | "all"
export type DesktopMonitorState = "recording" | "paused"
export type DesktopMonitorArchiveState = "active" | "stopped"
export interface DesktopMonitorScope { mode: DesktopMonitorScopeMode; apps?: string[] }
export interface DesktopMonitorCounts { evt: number; mut: number; net: number; nav: number; ax: number }
export interface DesktopMonitorCoverage { source: string; available: boolean; provider?: string; reason?: string; limits?: string[] }
export interface DesktopMonitorTcc { accessibility: boolean; screenRecording?: boolean; microphone?: boolean }
export interface DesktopMonitorAttachment { key: string; pid: number; attachedAt: number; axNotifications: string[]; bundleIdentifier?: string; appName?: string; detachedAt?: number; reason?: string }
export interface DesktopMonitorStartData {
  sid: string; status: DesktopMonitorState; surface: DesktopMonitorSurface; scope: DesktopMonitorScope; includes: string[]; sessionDir: string; activeCount: number
  host?: DesktopHost; instruction?: string; taskId?: string; tcc?: DesktopMonitorTcc; speechMode?: DesktopMonitorSpeechMode; tap?: boolean; coverage?: DesktopMonitorCoverage[]; partial?: boolean
  duration?: number; counts?: DesktopMonitorCounts
}
export interface DesktopMonitorStatusData {
  sid: string; status: DesktopMonitorState; surface: DesktopMonitorSurface; duration: number; counts: DesktopMonitorCounts; scope: DesktopMonitorScope; includes: string[]
  host?: DesktopHost; attachments?: DesktopMonitorAttachment[]; tcc?: DesktopMonitorTcc; tap?: boolean; coverage?: DesktopMonitorCoverage[]; partial?: boolean
}
export type DesktopMonitorIdleState = "idle"
export interface DesktopMonitorIdleData { status: DesktopMonitorIdleState }
export interface DesktopMonitorSessionsData { sessions: DesktopMonitorStatusData[]; activeCount: number }
export interface DesktopMonitorPauseData { sid: string; status: DesktopMonitorState }
export interface DesktopMonitorStopData { sid: string; duration: number; evt: number; mut: number; net: number; nav: number; ax: number; reason: string }
// Events retain the existing flat source fields. This header is validated
// separately from each source payload, preserving browser/Mac artifact readers.
export interface DesktopMonitorEventHeader { sid: string; s: number; t: number; event: string; timestamp?: string; taskId?: string }
// Flat payloads emitted by the Rust Windows/Linux recorder. Mac sources use
// their own registry below. Unknown extension event
// names retain their bounded opaque payloads for archive compatibility.
export interface DesktopMonitorNativeStartPayload { scope: DesktopMonitorScope; coverage: DesktopMonitorCoverage[]; partial: boolean }
export interface DesktopMonitorNativeStopPayload { reason: string }
export interface DesktopMonitorNativeEmptyPayload {}
export interface DesktopMonitorNativeFilePayload { path: string }
export interface DesktopMonitorNativeClipboardPayload { changeCount: number; types: string[]; preview: string }
export type DesktopMonitorNativeSource = "ax" | "workspace"
export interface DesktopMonitorNativeObservationPayload {
  source: DesktopMonitorNativeSource; app: string; pid: number; r: string; n: string; secure: boolean; notification: string
  v?: string; frame?: DesktopAxFrame; windowId?: DesktopAxWindowIdentity
}
export type DesktopMonitorNativeFailedSource = "files" | "clipboard"
export type DesktopMonitorNativeOverflowSource = "native_observation"
export interface DesktopMonitorNativeFailure { success: boolean; code: DesktopErrorCode; error: string }
export interface DesktopMonitorNativeFailedPayload { source: DesktopMonitorNativeFailedSource; error: DesktopMonitorNativeFailure }
export interface DesktopMonitorNativeOverflowPayload { source: DesktopMonitorNativeOverflowSource; dropped: number }
// Windows --tap (low-level hooks). kc is the key name; secure is true and kc is redacted while the
// focused control is a password field. x/y are screen pixels; sx/sy are wheel notches.
export interface DesktopMonitorNativeTapPayload { tap: boolean; app: string; pid: number; kc?: string; mods?: string; secure?: boolean; x?: number; y?: number; sx?: number; sy?: number }
export type DesktopMonitorNativeErrorPayload = DesktopMonitorNativeFailedPayload | DesktopMonitorNativeOverflowPayload
// Schema selectors, not a wire object. The existing generator supplies the
// same strict shapes to TypeScript, Rust and Swift without another parser.
export interface DesktopMonitorNativePayloadSchemas {
  frame: DesktopMonitorMacFramePayload
  frame_error: DesktopMonitorMacErrorPayload
  frame_budget_reached: DesktopMonitorMacBudgetPayload
  mon_start: DesktopMonitorNativeStartPayload
  mon_stop: DesktopMonitorNativeStopPayload
  mon_pause: DesktopMonitorNativeEmptyPayload
  mon_resume: DesktopMonitorNativeEmptyPayload
  file_change: DesktopMonitorNativeFilePayload
  clipboard_change: DesktopMonitorNativeClipboardPayload
  source_error: DesktopMonitorNativeErrorPayload
  input: DesktopMonitorNativeObservationPayload
  focus: DesktopMonitorNativeObservationPayload
  selection: DesktopMonitorNativeObservationPayload
  menu_open: DesktopMonitorNativeObservationPayload
  menu_close: DesktopMonitorNativeObservationPayload
  title_change: DesktopMonitorNativeObservationPayload
  layout_change: DesktopMonitorNativeObservationPayload
  ax_other: DesktopMonitorNativeObservationPayload
  frontmost: DesktopMonitorNativeObservationPayload
  app_deactivate: DesktopMonitorNativeObservationPayload
  window_min: DesktopMonitorNativeObservationPayload
  window_demin: DesktopMonitorNativeObservationPayload
  window_create: DesktopMonitorNativeObservationPayload
  window_destroy: DesktopMonitorNativeObservationPayload
  ocr_text: DesktopMonitorMacOcrPayload
  video_start: DesktopMonitorMacVideoStartPayload
  video_recording: DesktopMonitorMacVideoRecordingPayload
  video_error: DesktopMonitorMacVideoErrorPayload
  video_finished: DesktopMonitorMacVideoFinishedPayload
  key: DesktopMonitorNativeTapPayload
  click: DesktopMonitorNativeTapPayload
  rclick: DesktopMonitorNativeTapPayload
  mouseup: DesktopMonitorNativeTapPayload
  scroll: DesktopMonitorNativeTapPayload
}
// Actual flat Mac recorder fields. Optional AX values/attributes and workspace
// userInfo fields remain optional. No payload is converted to the Rust format.
export type DesktopMonitorMacSurface = "macos"
export type DesktopMonitorMacNetworkStatus = "satisfied" | "unsatisfied" | "requiresConnection" | "unknown"
export type DesktopMonitorMacNotificationSource = "distributed"
export type DesktopMonitorMacSpeechSource = "live"
export type DesktopMonitorMacAudioKind = "offline_caf"
export type DesktopMonitorMacSpeechFallback = "offline_caf" | "none"
export type DesktopMonitorMacVideoState = "started"
export interface DesktopMonitorMacStartPayload { surface: DesktopMonitorMacSurface; scope: DesktopMonitorScope; includes: string[]; speechMode: DesktopMonitorSpeechMode; tap: boolean; ins?: string }
export interface DesktopMonitorMacStopPayload { duration: number; evt: number; mut: number; net: number; nav: number; ax: number; reason: string }
export interface DesktopMonitorMacAttachPayload { pid: number; app: string; bundleId: string; ax: string[] }
export interface DesktopMonitorMacReasonPayload { reason: string; remediation?: string; fallback?: DesktopMonitorMacSpeechFallback }
export interface DesktopMonitorMacNotePayload { note: string }
export interface DesktopMonitorMacNetworkPayload { status: DesktopMonitorMacNetworkStatus; isExpensive: boolean; isConstrained: boolean; supportsIPv4: boolean; supportsIPv6: boolean; supportsDNS: boolean; interfaces: string[] }
export interface DesktopMonitorMacLogPayload { level: string; subsystem: string; category: string; message: string; process: string }
export interface DesktopMonitorMacErrorPayload { error: string }
export interface DesktopMonitorMacNotificationPayload { name: string; source: DesktopMonitorMacNotificationSource }
export interface DesktopMonitorMacVideoStartPayload { path: string; fps: number }
export interface DesktopMonitorMacAudioPayload { path: string; kind: DesktopMonitorMacAudioKind }
export interface DesktopMonitorMacSpeechPayload { text: string; isFinal: boolean; source: DesktopMonitorMacSpeechSource }
export interface DesktopMonitorMacRestartPayload { replayBuffers: number }
export interface DesktopMonitorMacRotationPayload { archived: string; index: number }
export interface DesktopMonitorMacFrameErrorPayload { format: DesktopMonitorFrameFormat; quality: number; w: number; h: number }
export interface DesktopMonitorMacFramePayload { path: string; w: number; h: number; bytes: number; format: DesktopMonitorFrameFormat; quality: number }
export interface DesktopMonitorMacBudgetPayload { frames: number; bytes: number; frameBudget: number; diskCapBytes: number }
export interface DesktopMonitorMacVideoRecordingPayload { path: string; state: DesktopMonitorMacVideoState }
export interface DesktopMonitorMacVideoErrorPayload { path: string; error: string }
export interface DesktopMonitorMacVideoFinishedPayload { path: string; bytes: number; durationSec: number }
export interface DesktopMonitorMacRect { x: number; y: number; w: number; h: number }
export interface DesktopMonitorMacOcrBlock { text: string; confidence: DesktopVisionConfidence; rect: DesktopMonitorMacRect }
export interface DesktopMonitorMacOcrPayload { frame: string; blocks: DesktopMonitorMacOcrBlock[] }
export interface DesktopMonitorMacAxPayload { pid: number; r?: string; sr?: string; n?: string; v?: string; sl?: number; frame?: DesktopMonitorMacRect; coalesced?: number; notification?: string }
export interface DesktopMonitorMacWorkspacePayload { app?: string; bundleId?: string; pid?: number; path?: string; name?: string }
export interface DesktopMonitorMacPointerPayload { tr: boolean; app: string; bundleId: string; x: number; y: number; tap?: boolean; r?: string; n?: string }
export interface DesktopMonitorMacKeyPayload { tr: boolean; app: string; bundleId: string; kc: string; tap?: boolean; x?: number; y?: number }
export interface DesktopMonitorMacModsPayload { tr: boolean; app: string; bundleId: string; mods: string; tap?: boolean; x?: number; y?: number }
export interface DesktopMonitorMacScrollPayload { tr: boolean; app: string; bundleId: string; sx: number; sy: number; samples?: number; tap?: boolean; x?: number; y?: number }
export interface DesktopMonitorMacPayloadSchemas {
  mon_start: DesktopMonitorMacStartPayload
  mon_stop: DesktopMonitorMacStopPayload
  mon_pause: DesktopMonitorNativeEmptyPayload
  mon_resume: DesktopMonitorNativeEmptyPayload
  mon_attach: DesktopMonitorMacAttachPayload
  scope_warning: DesktopMonitorMacReasonPayload
  tap_unavailable: DesktopMonitorMacReasonPayload
  log_unavailable: DesktopMonitorMacReasonPayload
  speech_unavailable: DesktopMonitorMacReasonPayload
  capture_backpressure: DesktopMonitorMacNotePayload
  clipboard: DesktopMonitorNativeClipboardPayload
  file_change: DesktopMonitorNativeFilePayload
  network_path: DesktopMonitorMacNetworkPayload
  log: DesktopMonitorMacLogPayload
  log_error: DesktopMonitorMacErrorPayload
  frame_error: DesktopMonitorMacErrorPayload
  notification: DesktopMonitorMacNotificationPayload
  video_start: DesktopMonitorMacVideoStartPayload
  video_stop: DesktopMonitorNativeFilePayload
  speech_audio: DesktopMonitorMacAudioPayload
  speech_audio_done: DesktopMonitorNativeFilePayload
  speech_segment: DesktopMonitorMacSpeechPayload
  speech_restart: DesktopMonitorMacRestartPayload
  rotation: DesktopMonitorMacRotationPayload
  frame_encode_error: DesktopMonitorMacFrameErrorPayload
  frame: DesktopMonitorMacFramePayload
  frame_budget_reached: DesktopMonitorMacBudgetPayload
  video_recording: DesktopMonitorMacVideoRecordingPayload
  video_error: DesktopMonitorMacVideoErrorPayload
  video_finished: DesktopMonitorMacVideoFinishedPayload
  ocr_text: DesktopMonitorMacOcrPayload
  input: DesktopMonitorMacAxPayload
  focus: DesktopMonitorMacAxPayload
  window_focus: DesktopMonitorMacAxPayload
  selection: DesktopMonitorMacAxPayload
  title_change: DesktopMonitorMacAxPayload
  menu_open: DesktopMonitorMacAxPayload
  menu_close: DesktopMonitorMacAxPayload
  menu_select: DesktopMonitorMacAxPayload
  sheet: DesktopMonitorMacAxPayload
  layout_change: DesktopMonitorMacAxPayload
  selection_rows: DesktopMonitorMacAxPayload
  ax_app_activated: DesktopMonitorMacAxPayload
  ax_app_deactivated: DesktopMonitorMacAxPayload
  window_create: DesktopMonitorMacAxPayload
  window_move: DesktopMonitorMacAxPayload
  window_resize: DesktopMonitorMacAxPayload
  window_min: DesktopMonitorMacAxPayload
  window_demin: DesktopMonitorMacAxPayload
  ax_create: DesktopMonitorMacAxPayload
  ax_destroy: DesktopMonitorMacAxPayload
  ax_other: DesktopMonitorMacAxPayload
  frontmost: DesktopMonitorMacWorkspacePayload
  app_deactivate: DesktopMonitorMacWorkspacePayload
  app_launch: DesktopMonitorMacWorkspacePayload
  app_terminate: DesktopMonitorMacWorkspacePayload
  app_hide: DesktopMonitorMacWorkspacePayload
  app_unhide: DesktopMonitorMacWorkspacePayload
  space: DesktopMonitorMacWorkspacePayload
  mount: DesktopMonitorMacWorkspacePayload
  unmount: DesktopMonitorMacWorkspacePayload
  volume_rename: DesktopMonitorMacWorkspacePayload
  wake: DesktopMonitorMacWorkspacePayload
  sleep: DesktopMonitorMacWorkspacePayload
  session_active: DesktopMonitorMacWorkspacePayload
  session_inactive: DesktopMonitorMacWorkspacePayload
  click: DesktopMonitorMacPointerPayload
  dblclick: DesktopMonitorMacPointerPayload
  rclick: DesktopMonitorMacPointerPayload
  mouseup: DesktopMonitorMacPointerPayload
  move: DesktopMonitorMacPointerPayload
  key: DesktopMonitorMacKeyPayload
  mods: DesktopMonitorMacModsPayload
  scroll: DesktopMonitorMacScrollPayload
}
export interface DesktopMonitorArchiveData {
  sid: string; sessionId: string; artifactVersion: number; surface: DesktopMonitorSurface; startedAt: number; status: DesktopMonitorArchiveState; paused: boolean; counts: DesktopMonitorCounts; attachments: DesktopMonitorAttachment[]; scope: DesktopMonitorScope; includes: string[]; excludes: string[]
  host?: DesktopHost; provider?: string; providerPid?: number; login?: string; endedAt?: number; stopReason?: string; instruction?: string; taskId?: string; tcc?: DesktopMonitorTcc; coverage?: DesktopMonitorCoverage[]; partial?: boolean; rootPid?: number; rootBundleId?: string; rootApp?: string
  taskModeAtAttach?: DesktopMonitorTaskMode; taskActorAtAttach?: string; taskAttachedAt?: number; taskDetachedAt?: number; taskSourceSnapshotRoot?: string
}

// Notification namespaces select application-owned state, not an authenticated
// agent identity. The native user/login boundary remains the provider's owner.
export const DESKTOP_NOTIFICATION_MAX_ENTRIES = 1000
export const DESKTOP_NOTIFICATION_MAX_RESULT_BYTES = 1_048_576
export const DESKTOP_NOTIFICATION_MAX_CONTENT_BYTES = 65536
export const DESKTOP_NOTIFICATION_MAX_NAMES = 32
export const DESKTOP_NOTIFICATION_MAX_CATEGORIES = 64
export const DESKTOP_NOTIFICATION_MAX_SECONDS = 31_536_000
export type DesktopNotificationOperation = "desktop_notifications"
export type DesktopNotificationVerb = "tail" | "untail" | "log" | "status" | "request" | "settings" | "post" | "schedule-after" | "schedule-at" | "schedule-cron" | "cancel" | "cancel-all" | "pending" | "delivered" | "dismiss" | "dismiss-all" | "categories" | "badge"
export type DesktopNotificationCategoryVerb = "list" | "register" | "clear"
export type DesktopNotificationAuthorization = "notDetermined" | "denied" | "authorized" | "provisional" | "ephemeral" | "unknown" | "notSupported"
export type DesktopNotificationSetting = "enabled" | "disabled" | "notSupported" | "unknown"
export type DesktopNotificationScope = "application" | "owned-namespace"
export type DesktopNotificationCoverage = "native-pending" | "owned-scheduled" | "native-delivered" | "owned-accepted" | "distributed-names" | "owned-events"
export type DesktopNotificationInterruption = "active" | "passive" | "timeSensitive"
export type DesktopNotificationActionOption = "foreground" | "destructive" | "authenticationRequired"
export interface DesktopNotificationActionDefinition { identifier: string; title: string; options?: DesktopNotificationActionOption[] }
export interface DesktopNotificationAction {
  type: DesktopNotificationOperation
  sub: DesktopNotificationVerb
  namespace?: string
  name?: string
  app?: string
  limit?: number
  title?: string
  subtitle?: string
  body?: string
  sound?: string
  badge?: number
  category?: string
  thread?: string
  user_info?: string
  interruption?: DesktopNotificationInterruption
  attachment?: string
  seconds?: number
  repeats?: boolean
  date?: string
  components?: string
  id?: string
  options?: string
  verb?: DesktopNotificationCategoryVerb
  identifier?: string
  actions?: string
  intent_identifiers?: string
  summary_format?: string
  hidden_placeholder?: string
  count?: number
  clear?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopNotificationStatusData {
  status: DesktopNotificationAuthorization
  settings: Record<string, DesktopNotificationSetting>
  provider: string
  scope: DesktopNotificationScope
  namespace: string
  nativeSetting?: string
}
export type DesktopNotificationNullableString = string | null
export interface DesktopNotificationRequestData {
  granted: boolean
  authorizationStatus: DesktopNotificationAuthorization
  perFeatureSettingsEnabled: boolean
  options: string[]
  error: DesktopNotificationNullableString
}
export type DesktopNotificationTriggerKind = "immediate" | "timeInterval" | "calendar"
export interface DesktopNotificationTrigger {
  type: DesktopNotificationTriggerKind
  repeats: boolean
  seconds?: number
  components?: Record<string, number>
  nextTriggerDate?: DesktopNotificationNullableString
}
export interface DesktopNotificationAttachment { identifier: string; url: string; type: DesktopNotificationNullableString }
export interface DesktopNotificationEntry {
  identifier: string
  nativeIdentifier: string
  title: string
  subtitle: string
  body: string
  categoryIdentifier: string
  threadIdentifier: string
  userInfoJSON: string
  sound: DesktopNotificationNullableString
  badge?: number
  interruptionLevel?: string
  trigger?: DesktopNotificationTrigger
  attachments: DesktopNotificationAttachment[]
  deliveryDate?: string
}
export interface DesktopNotificationReceiptData {
  ok: boolean
  identifier: string
  nativeIdentifier: string
  trigger: DesktopNotificationTrigger
  categoryIdentifier: string
}
export interface DesktopNotificationInventoryData {
  entries: DesktopNotificationEntry[]
  namespace: string
  coverage: DesktopNotificationCoverage
  partial: boolean
}
export interface DesktopNotificationRemovalData { ok: boolean; id?: string; removed: string[]; remaining: number }
export interface DesktopNotificationCategory {
  identifier: string
  actions: DesktopNotificationActionDefinition[]
  intentIdentifiers: string[]
  options: number
  summaryFormat?: string
  hiddenPlaceholder?: string
}
export interface DesktopNotificationCategoriesData { categories: DesktopNotificationCategory[]; namespace: string }
export interface DesktopNotificationCategoryMutationData { ok: boolean; identifier?: string; remaining: number }
export interface DesktopNotificationBadgeData { ok: boolean; count: number; scope: DesktopNotificationScope; presentation: string }
export interface DesktopNotificationTailData { tailing: boolean; name: string; removed?: boolean }
export type DesktopNotificationEventKind = "distributed" | "accepted" | "scheduled" | "closed" | "activated" | "failed" | "cancelled" | "dismissed"
export interface DesktopNotificationEvent {
  kind: DesktopNotificationEventKind
  timestamp: string
  identifier?: string
  name?: string
  object?: string
  reason?: number
  actionIdentifier?: string
  truncated: boolean
}
export interface DesktopNotificationLogData { entries: DesktopNotificationEvent[]; namespace: string; coverage: DesktopNotificationCoverage }
export type DesktopNotificationData = DesktopNotificationStatusData | DesktopNotificationRequestData | DesktopNotificationReceiptData | DesktopNotificationInventoryData | DesktopNotificationRemovalData | DesktopNotificationCategoriesData | DesktopNotificationCategoryMutationData | DesktopNotificationBadgeData | DesktopNotificationTailData | DesktopNotificationLogData

export const DESKTOP_FILES_MAX_WATCHES = 64
export const DESKTOP_FILES_MAX_RECENT = 1000
export const DESKTOP_FILES_MAX_HISTORY_BYTES = 1_048_576
export const DESKTOP_FILES_MAX_EVENT_BYTES = 4_194_304
export const DESKTOP_FILES_MAX_OPEN = 100
export const DESKTOP_FILES_MAX_PROCESSES = 512
export const DESKTOP_FILES_MAX_HANDLES = 16384
export const DESKTOP_FILES_DEADLINE_MS = 5000
export type DesktopFilesOperation = "desktop_files"
export type DesktopFilesVerb = "watch" | "recent" | "open" | "unwatch"
export type DesktopFilesEventKind = "change"
export type DesktopFilesScope = "current-user-login" | "current-user"
export interface DesktopFilesAction {
  type: DesktopFilesOperation
  sub: DesktopFilesVerb
  path?: string
  limit?: number
  pid?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopFilesWatchData { watching: string; eventPath: string }
export interface DesktopFilesUnwatchData { path: string; removed: boolean }
export interface DesktopFilesEvent { path: string; timestamp: string; event: DesktopFilesEventKind }
export type DesktopFilesRecentData = DesktopFilesEvent[]
export interface DesktopFilesOpenData {
  files: string[]
  count: number
  partial: boolean
  scope: DesktopFilesScope
  processesInspected: number
  handlesInspected: number
  skippedProcesses: number
  reason?: string
}
export type DesktopFilesData = DesktopFilesWatchData | DesktopFilesRecentData | DesktopFilesOpenData | DesktopFilesUnwatchData

// The credential store is owned by the daemon, using the host's native vault.
// Values are resolved there rather than routed through an AX provider.
export type DesktopSecretOperation = "desktop_secret"
// Availability diagnostics only. No health-data store or CRUD is declared.
export type DesktopHealthOperation = "desktop_health"
export type DesktopHealthVerb = "status"
export interface DesktopHealthAction {
  type: DesktopHealthOperation
  sub?: DesktopHealthVerb
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopHealthData {
  available: boolean
  note: string
}
export const DESKTOP_AUTH_MAX_REASON_BYTES = 2048
export const DESKTOP_AUTH_MAX_TITLE_BYTES = 128
export const DESKTOP_AUTH_DEADLINE_MS = 170_000
export type DesktopAuthOperation = "desktop_auth"
export type DesktopAuthVerb = "status" | "confirm" | "invalidate" | "domain-state"
export type DesktopAuthPolicy = "any" | "biometry" | "biometry-or-watch" | "watch"
export interface DesktopAuthAction {
  type: DesktopAuthOperation
  sub: DesktopAuthVerb
  reason?: string
  policy?: DesktopAuthPolicy
  reuse_seconds?: number
  fallback_title?: string
  cancel_title?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopAuthStatusData {
  canEvaluate: boolean
  policy: DesktopAuthPolicy
  provider: string
  user: string
  biometryType: string
  availablePolicies: DesktopAuthPolicy[]
  error?: string
  errorCode?: number
}
export interface DesktopAuthConfirmData {
  ok: boolean
  policy: DesktopAuthPolicy
  provider: string
  user: string
  reason: string
  elapsedMs: number
  biometryType: string
  domainState?: string
  error?: string
  errorCode?: number
}
export interface DesktopAuthInvalidateData {
  invalidated: boolean
  provider: string
}
export interface DesktopAuthDomainStateData {
  available: boolean
  provider: string
  state?: string
  reason?: string
}
export interface DesktopAuthResultSchemas {
  status: DesktopAuthStatusData
  confirm: DesktopAuthConfirmData
  invalidate: DesktopAuthInvalidateData
  domain_state: DesktopAuthDomainStateData
}
export type DesktopSecretVerb = "status" | "list" | "register" | "set" | "rm" | "unlock" | "lock" | "reveal"
export type DesktopSecretGate = "none" | "touchid" | "biometry"
export interface DesktopSecretAction {
  type: DesktopSecretOperation
  sub: DesktopSecretVerb
  name?: string
  value?: string
  gate?: DesktopSecretGate
  targets?: string[]
  reuseSeconds?: number
  forSeconds?: number
  stdin?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}

// Vault replies are daemon-owned. The Mac status retains its legacy native
// authentication fields and explicit null error; foreign hosts use DesktopAuth.
export interface DesktopSecretEntry {
  name: string
  createdAt: number
  updatedAt?: number
  gate: DesktopSecretGate
  reuseSeconds: number
  targets: string[]
  lastReleasedAt?: number
  releases: number
  unlocked: boolean
}
export interface DesktopSecretUnlockEntry { name: string; until: string }
export interface DesktopSecretProviderFailure { available?: boolean; error?: string; code?: DesktopErrorCode }
export interface DesktopSecretDarwinBridge {
  dataProtection: boolean
  service: string
  accessGroups: string[]
  count: number
}
export type DesktopSecretNullableError = string | null
export interface DesktopSecretDarwinAuth {
  canEvaluate: boolean
  policy: string
  macOS: string
  biometryType: string
  error: DesktopSecretNullableError
  errorCode?: number
}
export type DesktopSecretBridgeData = DesktopSecretDarwinBridge | DesktopSecretProviderFailure
export type DesktopSecretAuthData = DesktopAuthStatusData | DesktopSecretDarwinAuth | DesktopSecretProviderFailure
export interface DesktopSecretStatusData {
  backend: string
  dataProtection: boolean
  bridge: DesktopSecretBridgeData
  auth: DesktopSecretAuthData
  secrets: number
  unlocked: DesktopSecretUnlockEntry[]
  metadata: string
  runtime?: string
  qualification?: string
}
export interface DesktopSecretListData { backend: string; secrets: DesktopSecretEntry[] }
export interface DesktopSecretStoredData {
  stored: boolean
  name: string
  gate: DesktopSecretGate
  targets: string[]
  backend: string
}
export interface DesktopSecretRemovedData { removed: boolean; name: string }
export interface DesktopSecretUnlockedData { unlocked: boolean; name: string; until: string; seconds: number }
export interface DesktopSecretLockedData { locked: string[] }
export interface DesktopSecretRevealedData { name: string; value: string }
export type DesktopSecretData = DesktopSecretStatusData | DesktopSecretListData | DesktopSecretStoredData | DesktopSecretRemovedData | DesktopSecretUnlockedData | DesktopSecretLockedData | DesktopSecretRevealedData
export interface DesktopSecretResultSchemas {
  status: DesktopSecretStatusData
  list: DesktopSecretListData
  register: DesktopSecretStoredData
  set: DesktopSecretStoredData
  rm: DesktopSecretRemovedData
  unlock: DesktopSecretUnlockedData
  lock: DesktopSecretLockedData
  reveal: DesktopSecretRevealedData
}

export const DESKTOP_LOG_MAX_ENTRIES = 1000
export const DESKTOP_LOG_MAX_RESULT_BYTES = 1_048_576
export const DESKTOP_LOG_MAX_SCAN_ENTRIES = 100_000
export const DESKTOP_LOG_DEADLINE_MS = 5000
export type DesktopLogQueryOperation = "desktop_log_query"
export type DesktopLogScope = "local"
export interface DesktopLogQueryAction {
  type: DesktopLogQueryOperation
  predicate?: string
  since?: string
  limit?: number
  includeInfo?: boolean
  includeDebug?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopLogEntry {
  timestamp: string
  message: string
  subsystem?: string
  category?: string
  level?: string
  process?: string
}
export interface DesktopLogQueryData {
  entries: DesktopLogEntry[]
  count: number
  scope: DesktopLogScope
}

export const DESKTOP_THUMBNAIL_MAX_PATHS = 32
export const DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES = 67_108_864
export const DESKTOP_THUMBNAIL_MAX_PIXELS = 32_000_000
export type DesktopThumbnailOperation = "desktop_thumbnail"
export type DesktopThumbnailVerb = "generate" | "batch"
export type DesktopThumbnailFormat = "png" | "jpeg" | "heic"
export type DesktopThumbnailKind = "thumbnail"
export interface DesktopThumbnailAction {
  type: DesktopThumbnailOperation
  sub: DesktopThumbnailVerb
  path?: string
  paths?: string[]
  size?: string
  scale?: number
  types?: string
  format?: string
  save?: boolean
  out?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopThumbnailImageData {
  path: string
  type: DesktopThumbnailKind
  width: number
  height: number
  scale: number
  format: DesktopThumbnailFormat
  bytes: number
  dataUrl?: string
  filePath?: string
}
export interface DesktopThumbnailBatchEntry {
  path: string
  ok: boolean
  result: DesktopThumbnailEntryResult
}
export interface DesktopThumbnailEntryResult {
  success: boolean
  data?: DesktopThumbnailImageData
  code?: DesktopErrorCode
  error?: string
}
export interface DesktopThumbnailBatchData {
  results: DesktopThumbnailBatchEntry[]
}
export type DesktopThumbnailData = DesktopThumbnailImageData | DesktopThumbnailBatchData

export const DESKTOP_HTTP_MAX_RESPONSE_BYTES = 16_777_216
export const DESKTOP_CONTAINER_MAX_OUTPUT_BYTES = 1_048_576
export const DESKTOP_CONTAINER_MAX_TIMEOUT_MS = 300_000
export const DESKTOP_CONTAINER_CLEANUP_MS = 5000
export type DesktopContainerOperation = "desktop_container_run"
export type DesktopContainerNetwork = "off" | "isolated" | "host"
export type DesktopContainerMountMode = "ro" | "rw"
export interface DesktopContainerMount {
  hostPath: string
  mountPath: string
  mode: DesktopContainerMountMode
}
export interface DesktopContainerRunAction {
  type: DesktopContainerOperation
  image: string
  command: string[]
  env?: Record<string, string>
  mounts?: DesktopContainerMount[]
  network?: DesktopContainerNetwork
  timeoutMs?: number
  maxOutputBytes?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopContainerRunData {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  image: string
  command: string[]
  network: DesktopContainerNetwork
  provider: string
  engineVersion: string
  engineHost: string
}

export const DESKTOP_HTTP_INLINE_BYTES = 65_536
export type DesktopHttpFetchOperation = "desktop_url_fetch"
export type DesktopHttpBodyKind = "text" | "bytes" | "bodyRef"
export type DesktopHttpArtifactKind = "artifact"
export interface DesktopHttpFetchAction {
  type: DesktopHttpFetchOperation
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopHttpArtifact {
  kind: DesktopHttpArtifactKind
  artifactId: string
  preview: string
  bytes: number
  contentType: string
  url: string
}
export interface DesktopHttpBody {
  kind: DesktopHttpBodyKind
  bytes: number
  text?: string
  base64?: string
  preview?: string
  sidecarPath?: string
  artifactRef?: DesktopHttpArtifact
}
export interface DesktopHttpFetchData {
  status: number
  headers: Record<string, string>
  contentType: string
  body: DesktopHttpBody
  url: string
}

export type DesktopCompoundReadOperation = "desktop_read"
export type DesktopCompoundActOperation = "desktop_act"
export type DesktopCompoundInspectOperation = "desktop_inspect_app"
export type DesktopCompoundOpenOperation = "desktop_open"
export type DesktopCompoundActKind = "typed" | "clicked"
export interface DesktopCompoundReadAction {
  type: DesktopCompoundReadOperation
  app?: string
  pid?: number
  filter?: string
  depth?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopCompoundOpenAction {
  type: DesktopCompoundOpenOperation
  app?: string
  pid?: number
  activate?: boolean
  filter?: string
  depth?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopCompoundWindow {
  title: string
  ref?: string
  windowId?: string
  frame?: DesktopCompoundFrame
  referenceError?: string
  referenceErrorCode?: DesktopErrorCode
}
export interface DesktopCompoundFrame {
  x: number
  y: number
  width: number
  height: number
}
export interface DesktopCompoundOpenData {
  tree: string
  windows: DesktopCompoundWindow[]
  app: string
  pid: number
}
export interface DesktopCompoundActAction {
  type: DesktopCompoundActOperation
  ref: string
  text?: string
  app?: string
  pid?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopCompoundInspectAction {
  type: DesktopCompoundInspectOperation
  app?: string
  pid?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopCompoundReadData {
  tree: string
  app: string
  pid: number
}
export interface DesktopCompoundActData {
  action: DesktopCompoundActKind
  ref: string
  tree: string
}
export interface DesktopCompoundApp {
  name: string
  pid: number
  bundleId?: string
  isActive?: boolean
  isHidden?: boolean
  unknownFields?: string[]
}
export type DesktopCompoundFrontmost = DesktopCompoundApp | null
export interface DesktopCompoundInspectData {
  tree: string
  apps: DesktopCompoundApp[]
  target: DesktopCompoundApp
  frontmost: DesktopCompoundFrontmost
}

export type DesktopDisplayListOperation = "desktop_display_list"
export type DesktopDisplayInfoOperation = "desktop_display_info"
export interface DesktopDisplayListAction {
  type: DesktopDisplayListOperation
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopDisplayInfoAction {
  type: DesktopDisplayInfoOperation
  id: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopDisplayEntry {
  id: number
  width: number
  height: number
  x: number
  y: number
  isMain?: boolean
  isBuiltin?: boolean
  isVirtual?: boolean
  unknownFields?: string[]
}
export interface DesktopDisplayInfoData {
  id: number
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
  refreshRate?: number
  isMain?: boolean
  isBuiltin?: boolean
  rotation?: number
  unknownFields?: string[]
}
export interface DesktopDisplayResultSchemas {
  list: DesktopDisplayEntry[]
  info: DesktopDisplayInfoData
}
export const DESKTOP_DISPLAY_MAX_COUNT = 64

export type DesktopCaptureScreenshotOperation = "desktop_screenshot"
export type DesktopCaptureOperation = "desktop_capture"
export type DesktopCaptureFormat = "png" | "jpeg" | "webp"
export type DesktopCaptureMode = "display"
export type DesktopCaptureSub = "start" | "frame" | "status" | "stop"
export type DesktopCaptureJpegFormat = "jpeg"
export type DesktopCaptureStartAck = "continuous capture started"
export type DesktopCaptureStopAck = "capture stopped"
export interface DesktopCaptureScreenshotAction {
  type: DesktopCaptureScreenshotOperation
  app?: string
  window?: number
  display?: number
  save?: boolean
  format?: DesktopCaptureFormat
  quality?: number
  mode?: DesktopCaptureMode
  element?: string
  cwd?: string
  target_max_long_edge?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopCaptureAction {
  type: DesktopCaptureOperation
  sub?: DesktopCaptureSub
  app?: string
  timeoutMs?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopCaptureScreenshotData {
  dataUrl?: string
  filePath?: string
  format: DesktopCaptureFormat
  bytes: number
  width: number
  height: number
  originalWidth: number
  originalHeight: number
}
export interface DesktopCaptureFrameData {
  dataUrl: string
  format: DesktopCaptureJpegFormat
  bytes: number
  width: number
  height: number
}
export interface DesktopCaptureStatusData {
  active: boolean
  hasFrame: boolean
  frameAgeMs?: number
}
export interface DesktopCaptureResultSchemas {
  start: DesktopCaptureStartAck
  stop: DesktopCaptureStopAck
  frame: DesktopCaptureFrameData
  status: DesktopCaptureStatusData
}
export const DESKTOP_CAPTURE_DEFAULT_LONG_EDGE = 1568
export const DESKTOP_CAPTURE_DEFAULT_QUALITY = 80
export const DESKTOP_CAPTURE_DEFAULT_TIMEOUT_MS = 3000
export const DESKTOP_CAPTURE_MAX_TIMEOUT_MS = 10000
export const DESKTOP_CAPTURE_MAX_PIXELS = 33554432

export type DesktopClipboardOperation = "desktop_clipboard"
export type DesktopClipboardSub = "read" | "write" | "tail" | "history" | "clear" | "types"
export type DesktopClipboardContentType = "text" | "rtf" | "image" | "files"
export interface DesktopClipboardAction {
  type: DesktopClipboardOperation
  sub: DesktopClipboardSub
  text?: string
  contentType?: DesktopClipboardContentType
  image?: string
  limit?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopClipboardHistoryEntry {
  timestamp: string
  changeCount: number
  types: string[]
  preview: string
}
export type DesktopClipboardAck = "ok"
export interface DesktopClipboardTailData {
  tailing: boolean
  note?: string
  eventPath?: string
}
// Result selectors, not a wire object. This registry declares each flat
// clipboard response while preserving the existing primitive/array payloads.
export interface DesktopClipboardResultSchemas {
  readText: string
  readRtf: string
  readImage: string
  readFiles: string[]
  write: DesktopClipboardAck
  clear: DesktopClipboardAck
  tail: DesktopClipboardTailData
  history: DesktopClipboardHistoryEntry[]
  types: string[]
}
export type DesktopClipboardEventKind = "clipboard_change"
export interface DesktopClipboardEvent {
  event: DesktopClipboardEventKind
  timestamp: string
  changeCount: number
  types: string[]
  preview: string
}
export const DESKTOP_CLIPBOARD_PREVIEW_CHARACTERS = 200
export const DESKTOP_CLIPBOARD_HISTORY_LIMIT = 500

export type DesktopFsReadOperation = "desktop_fs_read"
export type DesktopFsWriteOperation = "desktop_fs_write"
export type DesktopFsSearchOperation = "desktop_fs_search"
export type DesktopFsPathKind = "path"
export type DesktopFsEncoding = "utf8" | "base64" | "raw"
export interface DesktopFsPathReference { kind: DesktopFsPathKind; path: string }
export interface DesktopFsByteRange { start?: number; length?: number }
export interface DesktopFsIfMatch { modified: string }
export interface DesktopFsReadAction {
  type: DesktopFsReadOperation
  path?: string
  ref?: DesktopFsPathReference
  encoding?: DesktopFsEncoding
  byteRange?: DesktopFsByteRange
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopFsWriteAction {
  type: DesktopFsWriteOperation
  path?: string
  ref?: DesktopFsPathReference
  content: string
  encoding?: DesktopFsEncoding
  ifMatch?: DesktopFsIfMatch
  append?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopFsSearchAction {
  type: DesktopFsSearchOperation
  query: string
  scope?: string
  paths?: string[]
  cwd?: string
  kinds?: string[]
  limit?: number
  timeoutMs?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopFsAttributes { size: number; modified: string; absolutePath: string }
export interface DesktopFsReadData { content: string; encoding: DesktopFsEncoding; contentType: string; attributes: DesktopFsAttributes }
export interface DesktopFsWriteData { written: number; absolutePath: string; modified: string }
export interface DesktopFsMatch { path: string; name: string; kind: string; size?: number; modified?: string }
export interface DesktopFsSearchData {
  matches: DesktopFsMatch[]
  indexed: boolean
  source: string
  scope: string
  query: string
  count: number
  partial?: boolean
  deadlineMs?: number
  hint?: string
}

// Flat request declarations retain the existing CLI and native action fields.
export type DesktopAxTextMode = "full" | "selection" | "visible"
export interface DesktopAxWindowBounds { left: number; top: number; width: number; height: number }
export type DesktopAxResizeOperation = "desktop_resize"
export interface DesktopAxResizeAction {
  type: DesktopAxResizeOperation
  ref: string
  width: number
  height: number
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxMoveOperation = "desktop_move"
export interface DesktopAxMoveAction {
  type: DesktopAxMoveOperation
  ref: string
  x: number
  y: number
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxHelloOperation = "desktop_hello"
export interface DesktopAxHelloAction {
  type: DesktopAxHelloOperation
  sub?: string
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxCapabilitiesOperation = "desktop_capabilities"
export interface DesktopAxCapabilitiesAction {
  type: DesktopAxCapabilitiesOperation
  sub?: string
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxAppsOperation = "desktop_apps"
export interface DesktopAxAppsAction {
  type: DesktopAxAppsOperation
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxWindowsOperation = "desktop_windows"
export type DesktopAxAppOperation = "desktop_app"
export type DesktopAxAppSubcommand = "activate" | "hide" | "unhide" | "quit" | "launch"
export interface DesktopAxAppAction {
  type: DesktopAxAppOperation
  subcommand?: DesktopAxAppSubcommand
  app?: string
  pid?: number
  bundleId?: string
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export interface DesktopAxWindowsAction {
  type: DesktopAxWindowsOperation
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxFrontmostOperation = "desktop_frontmost"
export interface DesktopAxFrontmostAction {
  type: DesktopAxFrontmostOperation
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxFocusedOperation = "desktop_focused"
export interface DesktopAxFocusedAction {
  type: DesktopAxFocusedOperation
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxTreeOperation = "desktop_tree"
export type DesktopAxTreeData = string
export interface DesktopAxTreeAction {
  type: DesktopAxTreeOperation
  filter?: string
  depth?: number
  maxChars?: number
  maxNodes?: number
  maxMs?: number
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxFindOperation = "desktop_find"
export interface DesktopAxFindAction {
  type: DesktopAxFindOperation
  query: string
  role?: string
  depth?: number
  maxChars?: number
  maxNodes?: number
  maxMs?: number
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxInspectOperation = "desktop_inspect"
export interface DesktopAxInspectAction {
  type: DesktopAxInspectOperation
  ref: string
  secretBindingName?: string
  secretLease?: string
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxTextOperation = "desktop_text"
export type DesktopAxTextData = string
export interface DesktopAxTextAction {
  type: DesktopAxTextOperation
  ref: string
  mode?: DesktopAxTextMode
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxValueOperation = "desktop_value"
export interface DesktopAxValueAction {
  type: DesktopAxValueOperation
  ref: string
  value?: string
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxTypeOperation = "desktop_type"
export interface DesktopAxTypeAction {
  type: DesktopAxTypeOperation
  text: string
  ref?: string
  sensitive?: boolean
  expectedIdentity?: DesktopAxProcessIdentity
  secretBindingName?: string
  secretLease?: string
  backgroundOnly?: boolean
  windowTitle?: string
  windowBounds?: DesktopAxWindowBounds
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxClickOperation = "desktop_click"
export interface DesktopAxClickAction {
  type: DesktopAxClickOperation
  ref?: string
  coords?: string
  double?: boolean
  right?: boolean
  backgroundOnly?: boolean
  windowTitle?: string
  windowBounds?: DesktopAxWindowBounds
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxActionOperation = "desktop_action"
export interface DesktopAxActionAction {
  type: DesktopAxActionOperation
  ref: string
  action?: string
  backgroundOnly?: boolean
  app?: string
  pid?: number
  window?: number
  group?: string
  groupColor?: string
  groupSoft?: boolean
}

export type DesktopAxKeysOperation = "desktop_keys"
export interface DesktopAxKeysAction {
  type: DesktopAxKeysOperation
  keys: string
  app?: string
  pid?: number
  window?: number
  backgroundOnly?: boolean
  windowTitle?: string
  windowBounds?: DesktopAxWindowBounds
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxScrollOperation = "desktop_scroll"
export type DesktopAxScrollDirection = "up" | "down" | "left" | "right"
export interface DesktopAxScrollAction {
  type: DesktopAxScrollOperation
  direction: DesktopAxScrollDirection
  amount: number
  ref?: string
  times?: number
  intervalMs?: number
  app?: string
  pid?: number
  window?: number
  backgroundOnly?: boolean
  windowTitle?: string
  windowBounds?: DesktopAxWindowBounds
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxDragOperation = "desktop_drag"
export interface DesktopAxDragAction {
  type: DesktopAxDragOperation
  from?: string
  to?: string
  fromCoords?: string
  toCoords?: string
  app?: string
  pid?: number
  window?: number
  backgroundOnly?: boolean
  windowTitle?: string
  windowBounds?: DesktopAxWindowBounds
  group?: string
  groupColor?: string
  groupSoft?: boolean
}
export type DesktopAxMenuOperation = "desktop_menu"
export interface DesktopAxMenuAction {
  type: DesktopAxMenuOperation
  items?: string[]
  app?: string
  pid?: number
  window?: number
  backgroundOnly?: boolean
  group?: string
  groupColor?: string
  groupSoft?: boolean
}

// Reply declarations preserve the existing native payloads. Host result tables
// distinguish the Mac's text acknowledgements from Windows/Linux metadata.
export interface DesktopAxFrame { x: number; y: number; width: number; height: number }
export interface DesktopAxSize { width: number; height: number }
export interface DesktopAxOrigin { x: number; y: number }
export interface DesktopAxResizeData {
  frame: DesktopAxFrame
  requested: DesktopAxSize
  clamped: boolean
  clampedTo?: DesktopAxFrame
}
export interface DesktopAxMoveData {
  frame: DesktopAxFrame
  requested: DesktopAxOrigin
  clamped: boolean
  clampedTo?: DesktopAxFrame
}
// The Mac also reports the bundle id and whether the app is active or hidden.
export interface DesktopAxAppEntry { name: string; pid: number; bundleId?: string; active?: boolean; hidden?: boolean }
export type DesktopAxAppsData = DesktopAxAppEntry[]
export type DesktopAxLifecycleSubcommand = "activate" | "hide" | "unhide" | "quit" | "launch"
export type DesktopAxWindowIdentity = string | number
export interface DesktopAxNativeAppData {
  subcommand: DesktopAxLifecycleSubcommand
  pid: number
  method: string
  window?: DesktopAxWindowIdentity
  windows?: number
  accepted?: boolean
  minimized?: number
  restored?: number
  exited?: boolean
  note?: string
  protocolVersion?: number
  background?: boolean
  foregroundUsed?: boolean
  // unhide put the previous foreground back after the app took it
  foregroundRestored?: boolean
  focusUnchanged?: boolean
  cursorUnchanged?: boolean
  delivered?: number
  effectRequiresObservation?: boolean
  launched?: boolean
  activated?: boolean
  appId?: string
  path?: string
}
export type DesktopAxAppData = string | DesktopAxNativeAppData
export interface DesktopAxFailureDetails {
  dispatched?: boolean
  verified?: boolean
  delivered?: number
  effectRequiresObservation?: boolean
  focusUnchanged?: boolean
  cursorUnchanged?: boolean
}
export interface DesktopAxFailure {
  success: boolean
  code: DesktopErrorCode
  error: string
  retryable?: boolean
  details?: DesktopAxFailureDetails
}
export interface DesktopAxDarwinWindow {
  ref: string
  title: string
  windowId?: number
  frame?: DesktopAxFrame
}
export interface DesktopAxWin32Window {
  windowId: string
  title: string
  pid: number
  name: string
  frame: DesktopAxFrame
  ref?: string
  refUnavailable?: DesktopAxFailure
}
// The compositor's active window when it exposes no accessibility tree (Hyprland).
export interface DesktopAxLinuxCompositorWindow {
  windowId: string
  title: string
  pid: number
  name: string
  frame: DesktopAxNullableFrame
  refUnavailable: DesktopAxFailure
}
export type DesktopAxNullableFrame = DesktopAxFrame | null
export type DesktopAxNativeHost = "windows" | "linux"
export interface DesktopAxProcessIdentity {
  host: DesktopAxNativeHost
  pid: number
  executable: string
  user: string
  session: string
  creation: string
  image: string
}
export interface DesktopAxLinuxNode {
  ref: string
  role: string
  nativeRole: string
  name: string
  title: string
  value: string
  pid: number
  secure: boolean
  frame: DesktopAxNullableFrame
  windowId?: string
  windowIdUnavailable?: DesktopAxFailure
  targetIdentity?: DesktopAxProcessIdentity
  secretLease?: string
}
export interface DesktopAxWin32Node {
  ref: string
  role: string
  nativeRole: number
  name: string
  title: string
  value: string
  pid: number
  secure: boolean
  frame: DesktopAxFrame
  targetIdentity?: DesktopAxProcessIdentity
  secretLease?: string
}
export type DesktopAxWindowsData = DesktopAxDarwinWindow[] | DesktopAxWin32Window[] | DesktopAxLinuxNode[]
export interface DesktopAxDarwinFrontmost {
  name: string
  pid: number
  bundleId: string
  isActive: boolean
  source: string
}
export type DesktopAxWin32Frontmost = DesktopAxWin32Window | null
export type DesktopAxLinuxFrontmost = DesktopAxLinuxNode | DesktopAxLinuxCompositorWindow | null
// A visible compositor window without an accessibility tree is still listed, without a ref.
export type DesktopAxLinuxWindow = DesktopAxLinuxNode | DesktopAxLinuxCompositorWindow
export type DesktopAxFrontmostData = DesktopAxDarwinFrontmost | DesktopAxWin32Frontmost | DesktopAxLinuxFrontmost
export interface DesktopAxDarwinFocused {
  ref: string
  role: string
  name?: string
  value?: string
  frame?: DesktopAxFrame
}
export type DesktopAxWin32Focused = DesktopAxWin32Node | null
export type DesktopAxLinuxFocused = DesktopAxLinuxNode | null
export type DesktopAxFocusedData = DesktopAxDarwinFocused | DesktopAxWin32Focused | DesktopAxLinuxFocused
export interface DesktopAxDarwinFindEntry {
  ref: string
  role: string
  name: string
  value?: string
  identifier?: string
  frame?: DesktopAxFrame
}
export type DesktopAxFindData = DesktopAxDarwinFindEntry[] | DesktopAxWin32Node[] | DesktopAxLinuxNode[]
export type DesktopAxDarwinInspectAttribute = string | DesktopAxFrame | string[]
export type DesktopAxDarwinInspect = Record<string, DesktopAxDarwinInspectAttribute>
export type DesktopAxInspectData = DesktopAxDarwinInspect | DesktopAxWin32Node | DesktopAxLinuxNode
export interface DesktopAxNativeInputData {
  method: string
  background: boolean
  foregroundUsed?: boolean
  foregroundRestored?: boolean
  focusUnchanged?: boolean
  cursorUnchanged?: boolean
  delivered?: number
  targetPid?: number
  windowId?: string
  elapsedMs?: number
  compositorVersion?: string
  effectRequiresObservation?: boolean
  invoked?: number
}
export type DesktopAxValueData = string | DesktopAxNativeInputData
export type DesktopAxTypeData = string | DesktopAxNativeInputData
export type DesktopAxClickData = string | DesktopAxNativeInputData
export type DesktopAxActionData = string | DesktopAxNativeInputData
export type DesktopAxKeysData = string | DesktopAxNativeInputData
export type DesktopAxScrollData = string | DesktopAxNativeInputData
export type DesktopAxDragData = string | DesktopAxNativeInputData
export interface DesktopAxWin32MenuEntry {
  title: string
  id: number
  enabled: boolean
  children: DesktopAxWin32MenuEntry[]
}
export interface DesktopAxLinuxMenuEntry {
  title: string
  enabled: boolean
  children: DesktopAxLinuxMenuEntry[]
}
export type DesktopAxMenuData = string | DesktopAxWin32MenuEntry[] | DesktopAxLinuxMenuEntry[] | DesktopAxNativeInputData

// Value and menu selectors are request-dependent, rather than additional verbs.
export interface DesktopAxDarwinResultSchemas {
  desktop_resize: DesktopAxResizeData
  desktop_move: DesktopAxMoveData
  desktop_apps: DesktopAxAppEntry[]
  desktop_app: string
  desktop_windows: DesktopAxDarwinWindow[]
  desktop_frontmost: DesktopAxDarwinFrontmost
  desktop_focused: DesktopAxDarwinFocused
  desktop_find: DesktopAxDarwinFindEntry[]
  desktop_inspect: DesktopAxDarwinInspect
  desktop_value_read: string
  desktop_value_write: string
  desktop_type: string
  desktop_click: string
  desktop_action: string
  desktop_keys: string
  desktop_scroll: string
  desktop_drag: string
  desktop_menu_list: string
  desktop_menu_invoke: string
}
export interface DesktopAxWin32ResultSchemas {
  desktop_resize: DesktopAxResizeData
  desktop_move: DesktopAxMoveData
  desktop_apps: DesktopAxAppEntry[]
  desktop_app: DesktopAxNativeAppData
  desktop_windows: DesktopAxWin32Window[]
  desktop_frontmost: DesktopAxWin32Frontmost
  desktop_focused: DesktopAxWin32Focused
  desktop_find: DesktopAxWin32Node[]
  desktop_inspect: DesktopAxWin32Node
  desktop_value_read: string
  desktop_value_write: DesktopAxNativeInputData
  desktop_type: DesktopAxNativeInputData
  desktop_click: DesktopAxNativeInputData
  desktop_action: DesktopAxNativeInputData
  desktop_keys: DesktopAxNativeInputData
  desktop_scroll: DesktopAxNativeInputData
  desktop_drag: DesktopAxNativeInputData
  desktop_menu_list: DesktopAxWin32MenuEntry[]
  desktop_menu_invoke: DesktopAxNativeInputData
}
export interface DesktopAxLinuxResultSchemas {
  desktop_resize: DesktopAxResizeData
  desktop_move: DesktopAxMoveData
  desktop_apps: DesktopAxAppEntry[]
  desktop_app: DesktopAxNativeAppData
  desktop_windows: DesktopAxLinuxWindow[]
  desktop_frontmost: DesktopAxLinuxFrontmost
  desktop_focused: DesktopAxLinuxFocused
  desktop_find: DesktopAxLinuxNode[]
  desktop_inspect: DesktopAxLinuxNode
  desktop_value_read: string
  desktop_value_write: DesktopAxNativeInputData
  desktop_type: DesktopAxNativeInputData
  desktop_click: DesktopAxNativeInputData
  desktop_action: DesktopAxNativeInputData
  desktop_keys: DesktopAxNativeInputData
  desktop_scroll: DesktopAxNativeInputData
  desktop_drag: DesktopAxNativeInputData
  desktop_menu_list: DesktopAxLinuxMenuEntry[]
  desktop_menu_invoke: DesktopAxNativeInputData
}

export function desktopAction(action: Record<string, unknown>): { type: string; [key: string]: unknown } {
  if (typeof action.type !== "string" || /^(?:macos|desktop)_[a-z][a-z0-9_]*$/.exec(action.type)?.[0] !== action.type) {
    throw new Error("invalid desktop action type")
  }
  // Optional parser fields disappear during JSON encoding. Validate the same
  // top-level fields the native provider receives without mutating the caller.
  const fields = Object.fromEntries(Object.entries(action).filter(([, value]) => value !== undefined))
  // Legacy notifications expose application-wide UN state and their original
  // replies. Do not silently turn a legacy call into a namespace-scoped one.
  const vm = /^(?:macos|desktop)_vm_(.+)$/.exec(action.type)
  if (vm) {
    if (action.sub !== undefined && String(action.sub).replaceAll('-', '_') !== vm[1]) throw new Error('VM action type and selector differ')
    return {...fields, type:'desktop_vm', sub:vm[1]}
  }
  const overlay = /^(?:macos|desktop)_overlay_(start|stop|list|status|eval|ctl|verbs)$/.exec(action.type)
  if (overlay) {
    if (action.sub !== undefined && action.sub !== overlay[1]) throw new Error('overlay action type and selector differ')
    return {...fields,type:'desktop_overlay',sub:overlay[1]}
  }
  return { ...fields, type: action.type === "macos_notifications" ? action.type : action.type.replace(/^macos_/, "desktop_") }
}

export function macosAction(action: Record<string, unknown>): { type: string; [key: string]: unknown } {
  const canonical = desktopAction(action)
  // The bridge routes desktop_stream itself: its handler reads a display id, while macos_stream reads an ordinal.
  if (canonical.type === "desktop_stream") return canonical
  return { ...canonical, type: ["desktop_hello", "desktop_capabilities"].includes(canonical.type)
    ? "macos_desktop" : canonical.type.replace(/^desktop_/, "macos_") }
}

export function validateDesktopRequest(value: unknown): value is DesktopRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (typeof r.id !== "string" || !r.id || new TextEncoder().encode(r.id).length > 128) return false
  if (!r.action || typeof r.action !== "object" || Array.isArray(r.action)) return false
  if (r.protocolVersion !== undefined && r.protocolVersion !== DESKTOP_PROTOCOL_VERSION) return false
  if (r.token !== undefined && typeof r.token !== "string") return false
  try { desktopAction(r.action as Record<string, unknown>); return true } catch { return false }
}

/**
 * Native desktop authority is separate from browser-extension authority. Browser
 * trusted input (os_click/os_type/os_key/os_move) is not: the daemon resolves its
 * coordinates through the extension and delivers it on every host.
 */
export function isDesktopActionType(type: unknown): boolean {
  return typeof type === "string" && /^(?:desktop|macos|native|cdp)_/.test(type)
}
