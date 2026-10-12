import { createConnection } from "node:net"
import { spawn } from "node:child_process"
import { Duplex, Readable, Writable } from "node:stream"
import { desktopProviderEndpoint, desktopProviderBinary } from "../shared/desktop-provider"
import { desktopAction, DESKTOP_MAX_FRAME_BYTES, DESKTOP_PROTOCOL_VERSION, type DesktopHello, type DesktopReply, type DesktopResult } from "../shared/desktop-contract"
import { desktopContractShapeError } from "../shared/desktop-contract-validation"
import {desktopCaptureResultError,desktopCaptureDeadline} from "../shared/desktop-capture-validation"
import {desktopDisplayResultError} from "../shared/desktop-display-validation"
import {desktopCompoundResultError} from "../shared/desktop-compound-validation"
import {desktopHttpActionError,desktopHttpResultError} from "../shared/desktop-http-validation"
import {desktopLogActionError,desktopLogResultError} from "../shared/desktop-log-validation"
import {desktopThumbnailActionError,desktopThumbnailResultError} from "../shared/desktop-thumbnail-validation"
import {desktopAuthActionError,desktopAuthResultError} from "../shared/desktop-auth-validation"
import {desktopContainerActionError,desktopContainerResultError,desktopContainerDeadline} from "../shared/desktop-container-validation"
import {desktopFilesActionError,desktopFilesResultError} from "../shared/desktop-files-validation"
import {desktopNotificationsActionError,desktopNotificationsResultError} from "../shared/desktop-notifications-validation"
import {desktopMonitorActionError,desktopMonitorResultError} from "../shared/desktop-monitor-validation"
import {desktopLanguageActionError,desktopLanguageResultError} from "../shared/desktop-language-validation"
import {desktopVisionActionError,desktopVisionResultError} from "../shared/desktop-vision-validation"
import {DESKTOP_VISION_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_LANGUAGE_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_SCRIPT_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopScriptActionError,desktopScriptResultError} from "../shared/desktop-script-validation"
import {desktopPdfActionError,desktopPdfResultError} from "../shared/desktop-pdf-validation"
import {DESKTOP_PDF_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_AUDIO_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopVadActionError,desktopVadResultError} from "../shared/desktop-vad-validation"
import {desktopSpeechActionError,desktopSpeechResultError} from "../shared/desktop-speech-validation"
import {desktopTrustActionError,desktopTrustResultError} from "../shared/desktop-trust-validation"
import {desktopStreamActionError,desktopStreamResultError} from "../shared/desktop-stream-validation"
import {desktopSoundActionError,desktopSoundResultError} from "../shared/desktop-sound-validation"
import {desktopSensitiveActionError,desktopSensitiveResultError} from "../shared/desktop-sensitive-validation"
import {desktopUpdateActionError,desktopUpdateResultError} from "../shared/desktop-update-validation"
import {desktopLocationActionError,desktopLocationResultError} from "../shared/desktop-location-validation"
import {DESKTOP_LOCATION_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopMapsActionError,desktopMapsResultError} from "../shared/desktop-maps-validation"
import {DESKTOP_MAPS_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopShareActionError,desktopShareResultError} from "../shared/desktop-share-validation"
import {DESKTOP_SHARE_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopContactsActionError,desktopContactsResultError} from "../shared/desktop-contacts-validation"
import {DESKTOP_CONTACTS_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopEventKitActionError,desktopEventKitResultError} from "../shared/desktop-eventkit-validation"
import {desktopPhotosActionError,desktopPhotosResultError} from "../shared/desktop-photos-validation"
import {desktopVmActionError,desktopVmResultError} from "../shared/desktop-vm-validation"
import {desktopOverlayActionError,desktopOverlayResultError,desktopOverlayDeadline} from "../shared/desktop-overlay-validation"
import {desktopAuthDialogActionError,desktopAuthDialogResultError} from "../shared/desktop-authdialog-validation"
import {DESKTOP_VM_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_PHOTOS_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_EVENTKIT_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopMusicActionError,desktopMusicResultError} from "../shared/desktop-music-validation"
import {DESKTOP_MUSIC_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_UPDATE_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_SPEECH_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopAudioActionError,desktopAudioResultError} from "../shared/desktop-audio-validation"
import { DESKTOP_LANGUAGE_OPERATIONS, DESKTOP_OPERATION_DATA_SCHEMAS, DESKTOP_CLIPBOARD_DATA_SCHEMAS, DESKTOP_CAPTURE_DATA_SCHEMAS, DESKTOP_DISPLAY_DATA_SCHEMAS, DESKTOP_ACCESSIBILITY_DATA_SCHEMAS, type DesktopContractSchema } from "../shared/desktop-contract.generated"
import { assertNoInstallMaintenance } from "../shared/install-maintenance"

/** The verified native client supports Windows named pipes and Unix sockets.
 * One request per connection retains unknown-outcome semantics and does not
 * reconnect/replay a mutation. The provider authenticates its SID/uid/session.
 */
export async function callDesktopProvider(action: Record<string, unknown>, timeoutMs = 15_000): Promise<DesktopResult> {
    let canonical: Record<string, unknown>
    const windowInput=/^(?:macos|desktop)_bginput_(click|type|keys|scroll|drag)$/.exec(String(action.type))
    if(windowInput){
      const bounds=action.windowBounds as Record<string,unknown>|undefined
      if(action.backgroundOnly!==undefined&&action.backgroundOnly!==true||typeof action.windowTitle!=='string'||!action.windowTitle||!bounds||typeof bounds!=='object'||Array.isArray(bounds)||!['left','top','width','height'].every(key=>typeof bounds[key]==='number'&&Number.isFinite(bounds[key])&&Math.abs(bounds[key]as number)<=2147483647)||Number(bounds.width)<=0||Number(bounds.height)<=0){
        return {success:false,code:'invalid_request',error:'background window input requires an exact title, bounded native frame and background-only delivery'}
      }
    }
    try { canonical = desktopAction(windowInput?{...action,type:'desktop_'+windowInput[1],backgroundOnly:true}:action) } catch {
      return { success: false, code: "invalid_request", error: "invalid desktop action type" }
    }
    const actionError=desktopHttpActionError(canonical)??desktopLogActionError(canonical)??desktopThumbnailActionError(canonical)??desktopAuthActionError(canonical)??desktopContainerActionError(canonical)??desktopFilesActionError(canonical)??desktopNotificationsActionError(canonical)??desktopMonitorActionError(canonical)??desktopLanguageActionError(canonical)??desktopVisionActionError(canonical)??desktopScriptActionError(canonical)??desktopPdfActionError(canonical)??desktopAudioActionError(canonical)??desktopVadActionError(canonical)
    const speechActionError=desktopSpeechActionError(canonical)??desktopTrustActionError(canonical)??desktopStreamActionError(canonical)??desktopSoundActionError(canonical)??desktopSensitiveActionError(canonical)??desktopUpdateActionError(canonical)??desktopLocationActionError(canonical)??desktopMapsActionError(canonical)??desktopMusicActionError(canonical)??desktopShareActionError(canonical)??desktopContactsActionError(canonical)
    const eventKitError=desktopEventKitActionError(canonical)??desktopPhotosActionError(canonical)??desktopVmActionError(canonical)??desktopOverlayActionError(canonical)??desktopAuthDialogActionError(canonical)
    if(actionError??speechActionError??eventKitError)return {success:false,code:"invalid_request",error:(actionError??speechActionError??eventKitError)!}
    timeoutMs=Math.max(timeoutMs,desktopCaptureDeadline(canonical),desktopOverlayDeadline(canonical))
    if(canonical.backgroundOnly===true&&['desktop_click','desktop_type','desktop_keys','desktop_scroll','desktop_drag'].includes(String(canonical.type)))timeoutMs=Math.max(timeoutMs,30_000)
    if(canonical.type==='desktop_container_run')timeoutMs=Math.max(timeoutMs,desktopContainerDeadline(canonical))
    if(DESKTOP_LANGUAGE_OPERATIONS.some(type=>type===canonical.type))timeoutMs=Math.max(timeoutMs,DESKTOP_LANGUAGE_DEADLINE_MS)
    if(canonical.type==='desktop_vision')timeoutMs=Math.max(timeoutMs,DESKTOP_VISION_DEADLINE_MS)
    if(canonical.type==='desktop_update')timeoutMs=Math.max(timeoutMs,DESKTOP_UPDATE_DEADLINE_MS)
    if(canonical.type==='desktop_location')timeoutMs=Math.max(timeoutMs,DESKTOP_LOCATION_DEADLINE_MS)
    if(canonical.type==='desktop_maps')timeoutMs=Math.max(timeoutMs,DESKTOP_MAPS_DEADLINE_MS)
    if(canonical.type==='desktop_share')timeoutMs=Math.max(timeoutMs,DESKTOP_SHARE_DEADLINE_MS)
    if(canonical.type==='desktop_contacts')timeoutMs=Math.max(timeoutMs,DESKTOP_CONTACTS_DEADLINE_MS)
    if(['desktop_calendar','desktop_reminders'].includes(String(canonical.type)))timeoutMs=Math.max(timeoutMs,DESKTOP_EVENTKIT_DEADLINE_MS)
    if(canonical.type==='desktop_photos')timeoutMs=Math.max(timeoutMs,DESKTOP_PHOTOS_DEADLINE_MS)
    if(canonical.type==='desktop_vm')timeoutMs=Math.max(timeoutMs,DESKTOP_VM_DEADLINE_MS)
    if(canonical.type==='desktop_music')timeoutMs=Math.max(timeoutMs,DESKTOP_MUSIC_DEADLINE_MS)
    if(canonical.type==='desktop_pdf')timeoutMs=Math.max(timeoutMs,DESKTOP_PDF_DEADLINE_MS)
    if(canonical.type==='desktop_audio')timeoutMs=Math.max(timeoutMs,DESKTOP_AUDIO_DEADLINE_MS)
    if(canonical.type==='desktop_listen')timeoutMs=Math.max(timeoutMs,DESKTOP_SPEECH_DEADLINE_MS)
    if(canonical.type==='desktop_sounds')timeoutMs=Math.max(timeoutMs,15_000)
    if(canonical.type==='desktop_sensitive')timeoutMs=Math.max(timeoutMs,35_000)
    if(['desktop_script_run','desktop_intent_dispatch'].includes(String(canonical.type)))timeoutMs=Math.max(timeoutMs,DESKTOP_SCRIPT_DEADLINE_MS)
    try { assertNoInstallMaintenance() } catch (error) {
      return {success:false,code:"provider_failed",error:(error as Error).message}
    }
    let endpoint: string
    try { endpoint = await desktopProviderEndpoint() } catch (error) {
      const code = error && typeof error === "object" && "code" in error &&
        ["no_interactive_session", "not_installed", "permission_denied", "provider_failed"].includes(String(error.code))
        ? error.code as "no_interactive_session" | "not_installed" | "permission_denied" | "provider_failed" : "provider_failed"
      return { success: false, code, error: error instanceof Error ? error.message : "native desktop provider identity unavailable" }
    }
  return new Promise(resolve => {
    const id = crypto.randomUUID()
    let sent = false, settled = false, buffer = Buffer.alloc(0), negotiated = false
    // The Rust client verifies the server user/session/executable on the same
    // native handle before forwarding. stdio never changes the caller's login.
    const native = process.platform === "win32" || process.platform === "linux"
    const binary = native ? desktopProviderBinary() : undefined
    if (native && !binary) { resolve({success:false,code:"not_installed",error:"selected native desktop provider is not installed"}); return }
    const nativeTimeout = Number.isFinite(timeoutMs) ? Math.min(600_000, Math.max(15_000, Math.ceil(timeoutMs) + 1_000)) : 15_000
    const child = native ? spawn(binary!, ["--client", endpoint, "--timeout-ms", String(nativeTimeout)], {stdio:["pipe","pipe","pipe"],windowsHide:true}) : undefined
    const socket = child ? Duplex.fromWeb({readable:Readable.toWeb(child.stdout!),writable:Writable.toWeb(child.stdin!)}) : createConnection(endpoint)
    if(child) {
      child.stderr?.resume()
      child.once("spawn",()=>socket.emit("connect"))
      child.once("error",e=>socket.destroy(e))
      socket.once("close",()=>child.kill())
    }
    const finish = (result: DesktopResult) => {
      if (settled) return
      settled = true; clearTimeout(timer); socket.destroy(); resolve(result)
    }
    const invalidReply = (error: string) => finish({success:false,code:sent?"timeout_unknown_outcome":"provider_failed",
      error:sent?`invalid native provider reply (${error.slice(0,300)}); the outcome is unknown, observe before retrying`:error})
    const timer = setTimeout(() => finish({ success: false, code: sent ? "timeout_unknown_outcome" : "provider_failed",
      error: sent ? "desktop provider deadline exceeded; the outcome is unknown, observe before retrying" : "desktop provider connection deadline exceeded" }), timeoutMs)
    const write = (requestId: string, value: Record<string, unknown>) => {
      const data = Buffer.from(JSON.stringify({ id: requestId, protocolVersion: DESKTOP_PROTOCOL_VERSION, action: desktopAction(value) }))
      if (data.length > DESKTOP_MAX_FRAME_BYTES) { finish({ success: false, code: "resource_limit", error: "desktop frame exceeds limit" }); return }
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length)
      socket.write(Buffer.concat([header, data])) // node:net buffers complete writes under backpressure.
    }
    socket.once("connect", () => write("hello", { type: "desktop_hello" }))
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      while (!settled && buffer.length >= 4) {
        const size = buffer.readUInt32LE()
        if (!size || size > DESKTOP_MAX_FRAME_BYTES) { invalidReply("invalid native provider frame"); return }
        if (buffer.length < size + 4) return
        let reply: DesktopReply
        try { reply = JSON.parse(new TextDecoder("utf-8", {fatal:true,ignoreBOM:true}).decode(buffer.subarray(4, size + 4))) } catch {
          invalidReply("malformed native provider reply"); return
        }
        buffer = buffer.subarray(size + 4)
        const replyError = desktopContractShapeError(reply, "DesktopReply")
        if (replyError) { invalidReply(replyError); return }
        if (!negotiated) {
          if (reply.id === "hello" && !reply.result.success) { finish(reply.result); return }
          const hello = reply.result.data as DesktopHello | undefined
          const helloError = desktopContractShapeError(hello, "DesktopHello")
          if (helloError) { invalidReply(helloError); return }
          if (reply.id !== "hello" || !reply.result.success || hello?.protocolVersion !== DESKTOP_PROTOCOL_VERSION || hello.maxFrameBytes !== DESKTOP_MAX_FRAME_BYTES || hello.host !== process.platform) {
            finish({ success: false, code: "version_mismatch", error: "native provider protocol/host mismatch" }); return
          }
          if (!Number.isSafeInteger(hello.pid) || hello.pid <= 0 || hello.pid > 0xffffffff || !hello.provider || !hello.version || !hello.session) {
            invalidReply("invalid native provider identity fields"); return
          }
          negotiated = true
          if (canonical.type === 'desktop_notifications' && !hello.capabilities.some(c => c.operation === 'notifications' && c.versions.contract === '1')) {
            finish({success:false,code:'version_mismatch',error:'native provider lacks notification contract 1; install the matching current package before retrying'}); return
          }
          if (canonical.type === 'desktop_monitor' && !hello.capabilities.some(c => c.operation === 'monitor' && c.versions.contract === '1')) {
            finish({success:false,code:'version_mismatch',error:'native provider lacks monitor contract 1; install the matching current package before retrying'}); return
          }
          if (DESKTOP_LANGUAGE_OPERATIONS.some(type=>type===canonical.type) && !hello.capabilities.some(c => c.operation === String(canonical.type).slice(8) && c.versions.contract === '1')) {
            finish({success:false,code:'version_mismatch',error:'native provider lacks language contract 1; install the matching current package before retrying'}); return
          }
          if(canonical.type==='desktop_vision'&&!hello.capabilities.some(c=>c.operation==='vision'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks vision contract 1; install the matching current package before retrying'});return
          }
          if(canonical.type==='desktop_pdf'&&!hello.capabilities.some(c=>c.operation==='pdf'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks PDF contract 1; install the matching current package before retrying'});return
          }
          if(canonical.type==='desktop_audio'&&!hello.capabilities.some(c=>c.operation==='audio'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks audio contract 1; install the matching current package before retrying'});return
          }
          if(canonical.type==='desktop_vad'&&!hello.capabilities.some(c=>c.operation==='vad'&&c.versions.contract==='1')){
            finish({success:false,code:"unsupported_operation",error:"native provider does not advertise the strict VAD contract"});return
          }
          if(canonical.type==='desktop_trust'&&!hello.capabilities.some(c=>c.operation==='trust'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks strict trust contract 1; upgrade before requesting permission work'});return
          }
          if(canonical.type==='desktop_stream'&&!hello.capabilities.some(c=>c.operation==='stream'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks strict stream contract 1; upgrade before streaming'});return
          }
          if(canonical.type==='desktop_sounds'&&!hello.capabilities.some(c=>c.operation==='sounds'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks strict sounds contract 1; install the matching package before classification'});return
          }
          if(canonical.type==='desktop_sensitive'&&!hello.capabilities.some(c=>c.operation==='sensitive'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks sensitive contract 1; install the matching package before analysis'});return
          }
          if(canonical.type==='desktop_update'&&!hello.capabilities.some(c=>c.operation==='update'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks update contract 1; install the matching current package before checking releases'});return
          }
          if(canonical.type==='desktop_maps'&&!hello.capabilities.some(c=>c.operation==='maps'&&c.versions.contract==='1')){finish({success:false,code:"version_mismatch",error:"native provider lacks Maps contract 1"});return}
          if(canonical.type==='desktop_share'&&!hello.capabilities.some(c=>c.operation==='share'&&c.versions.contract==='1')){finish({success:false,code:"version_mismatch",error:"native provider lacks Share contract 1"});return}
          if(canonical.type==='desktop_music'&&!hello.capabilities.some(c=>c.operation==='music'&&c.versions.contract==='1')){finish({success:false,code:"version_mismatch",error:"native provider lacks Music contract 1"});return}
          if(canonical.type==='desktop_location'&&!hello.capabilities.some(c=>c.operation==='location'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks Location contract 1; install the matching current package before reading location'});return
          }
          if(canonical.type==='desktop_listen'&&!hello.capabilities.some(c=>c.operation==='listen'&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks speech contract 1; install the matching current package before retrying'});return
          }
          if(['desktop_script_run','desktop_intent_dispatch'].includes(String(canonical.type))&&!hello.capabilities.some(c=>c.operation===String(canonical.type).slice(8)&&c.versions.contract==='1')){
            finish({success:false,code:'version_mismatch',error:'native provider lacks script contract 1; install the matching current package before retrying'});return
          }
          if(canonical.type==='desktop_overlay'&&process.platform!=='darwin'&&!hello.capabilities.some(c=>c.operation==='overlay'&&c.versions.contract==='1')){finish({success:false,code:'version_mismatch',error:'native provider lacks overlay contract 1; install the matching current package before retrying'});return}
          if(canonical.type==='desktop_authdialog'&&!hello.capabilities.some(c=>c.operation==='authdialog'&&c.versions.contract==='1')){finish({success:false,code:'version_mismatch',error:'native provider lacks authentication dialog contract 1; install the matching current package before credential delivery'});return}
          if(canonical.type==='desktop_contacts'&&!hello.capabilities.some(c=>c.operation==='contacts'&&c.versions.contract==='1')){finish({success:false,code:'version_mismatch',error:'native provider lacks Contacts contract 1; install the matching current package before retrying'});return}
          if(canonical.type==='desktop_photos'&&!hello.capabilities.some(c=>c.operation==='photos'&&c.versions.contract==='1')){finish({success:false,code:'version_mismatch',error:'native provider lacks Photos contract 1; install the matching current package before retrying'});return}
          if(['desktop_calendar','desktop_reminders'].includes(String(canonical.type))&&!hello.capabilities.some(c=>c.operation===String(canonical.type).slice(8)&&c.versions.contract==='1')){finish({success:false,code:'version_mismatch',error:'native provider lacks Calendar/Reminders contract 1; install the matching current package before retrying'});return}
          // A negotiation reply can replace only a fieldless discovery call.
          // Supplied fields must reach the provider's request validation.
          if ((canonical.type === "desktop_hello" || canonical.type === "desktop_capabilities") && Object.keys(canonical).length === 1) { finish(reply.result); return }
          sent = true; write(id, canonical)
        } else if (reply.id === id) {
          const schemas: Readonly<Record<string, DesktopContractSchema>> = DESKTOP_OPERATION_DATA_SCHEMAS
          let schema: DesktopContractSchema | undefined = schemas[String(canonical.type)]
          const accessibilityHosts: Readonly<Record<string, Readonly<Record<string, DesktopContractSchema>>>> = DESKTOP_ACCESSIBILITY_DATA_SCHEMAS
          const accessibilitySchemas = accessibilityHosts[process.platform]
          const accessibilitySelector = canonical.type === "desktop_value"
            ? canonical.value === undefined ? "desktop_value_read" : "desktop_value_write"
            : canonical.type === "desktop_menu"
              ? Array.isArray(canonical.items) && canonical.items.length ? "desktop_menu_invoke" : "desktop_menu_list"
              : String(canonical.type)
          if (accessibilitySchemas && Object.hasOwn(accessibilitySchemas, accessibilitySelector)) schema = accessibilitySchemas[accessibilitySelector]
          if (canonical.type === "desktop_clipboard") {
            const contentType = String(canonical.contentType ?? "text")
            const key = canonical.sub === "read" ? "read" + contentType[0]?.toUpperCase() + contentType.slice(1) : String(canonical.sub)
            const clipboardSchemas: Readonly<Record<string, DesktopContractSchema>> = DESKTOP_CLIPBOARD_DATA_SCHEMAS
            schema = Object.hasOwn(clipboardSchemas, key) ? clipboardSchemas[key] : undefined
            if (reply.result.success && !schema) { invalidReply("unknown clipboard result selector"); return }
          }
          if (canonical.type === "desktop_capture") {
            const key = String(canonical.sub ?? "frame")
            const captureSchemas: Readonly<Record<string, DesktopContractSchema>> = DESKTOP_CAPTURE_DATA_SCHEMAS
            schema = Object.hasOwn(captureSchemas, key) ? captureSchemas[key] : undefined
            if (reply.result.success && !schema) { invalidReply("unknown capture result selector"); return }
          }
          if (["desktop_display_list", "desktop_display_info"].includes(String(canonical.type))) {
            const displaySchemas: Readonly<Record<string, DesktopContractSchema>> = DESKTOP_DISPLAY_DATA_SCHEMAS
            schema = displaySchemas[String(canonical.type).slice("desktop_display_".length)]
          }
          if (reply.result.success && schema) {
            const dataError = desktopContractShapeError(reply.result.data, schema)
            if (dataError) { invalidReply(dataError); return }
          }
          if (reply.result.success) {
            const authDialogError=desktopAuthDialogResultError(canonical,reply.result.data)
            if(authDialogError){invalidReply(authDialogError);return}
            const overlayError=desktopOverlayResultError(canonical,reply.result.data)
            if(overlayError){invalidReply(overlayError);return}
            const vmError=desktopVmResultError(canonical,reply.result.data)
            if(vmError){invalidReply(vmError);return}
            const eventKitError=desktopEventKitResultError(canonical,reply.result.data)
            if(eventKitError){invalidReply(eventKitError);return}
            const photosError=desktopPhotosResultError(canonical,reply.result.data)
            if(photosError){invalidReply(photosError);return}
            const contactsError=desktopContactsResultError(canonical,reply.result.data)
            if(contactsError){invalidReply(contactsError);return}
            const shareError=desktopShareResultError(canonical,reply.result.data)
            if(shareError){invalidReply(shareError);return}
            const musicError=desktopMusicResultError(canonical,reply.result.data)
            if(musicError){invalidReply(musicError);return}
            const mapsError=desktopMapsResultError(canonical,reply.result.data)
            if(mapsError){invalidReply(mapsError);return}
            const locationError=desktopLocationResultError(canonical,reply.result.data)
            if(locationError){invalidReply(locationError);return}
            const updateError=desktopUpdateResultError(canonical,reply.result.data)
            if(updateError){invalidReply(updateError);return}
            const sensitiveError=desktopSensitiveResultError(canonical,reply.result.data)
            if(sensitiveError){invalidReply(sensitiveError);return}
            const soundError=desktopSoundResultError(canonical,reply.result.data)
            if(soundError){invalidReply(soundError);return}
            const streamError=desktopStreamResultError(canonical,reply.result.data)
            if(streamError){invalidReply(streamError);return}
            const trustError=desktopTrustResultError(canonical,reply.result.data)
            if(trustError){invalidReply(trustError);return}
            const speechError=desktopSpeechResultError(canonical,reply.result.data)
            if(speechError){invalidReply(speechError);return}
            const vadError=desktopVadResultError(canonical,reply.result.data)
            if(vadError){invalidReply(vadError);return}
            const audioError=desktopAudioResultError(canonical,reply.result.data)
            if(audioError){invalidReply(audioError);return}
            const pdfError=desktopPdfResultError(canonical,reply.result.data)
            if(pdfError){invalidReply(pdfError);return}
            const scriptError=desktopScriptResultError(canonical,reply.result.data)
            if(scriptError){invalidReply(scriptError);return}
            const visionError=desktopVisionResultError(canonical,reply.result.data)
            if(visionError){invalidReply(visionError);return}
            const languageError=desktopLanguageResultError(canonical,reply.result.data)
            if(languageError){invalidReply(languageError);return}
            const notificationError=desktopNotificationsResultError(canonical,reply.result.data)
            if(notificationError){invalidReply(notificationError);return}
            const filesError=desktopFilesResultError(canonical,reply.result.data)
            if(filesError){invalidReply(filesError);return}
            const containerError=desktopContainerResultError(canonical,reply.result.data)
            if(containerError){invalidReply(containerError);return}
            const authError=desktopAuthResultError(canonical,reply.result.data)
            if(authError){invalidReply(authError);return}
            const captureError=desktopCaptureResultError(canonical,reply.result.data)
            if(captureError){invalidReply(captureError);return}
            const displayError=desktopDisplayResultError(canonical,reply.result.data)
            if(displayError){invalidReply(displayError);return}
            const compoundError=desktopCompoundResultError(canonical,reply.result.data)
            if(compoundError){invalidReply(compoundError);return}
            const httpError=desktopHttpResultError(canonical,reply.result.data)
            if(httpError){invalidReply(httpError);return}
            const logError=desktopLogResultError(canonical,reply.result.data)
            if(logError){invalidReply(logError);return}
            const thumbnailError=desktopThumbnailResultError(canonical,reply.result.data)
            if(thumbnailError){invalidReply(thumbnailError);return}
            const monitorError=desktopMonitorResultError(canonical,reply.result.data)
            if(monitorError){invalidReply(monitorError);return}
          }
          finish(reply.result)
        }
        else invalidReply("native provider reply id mismatch")
      }
    })
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ success: false, code: sent ? "timeout_unknown_outcome" :
      ["EACCES", "EPERM"].includes(error.code || "") ? "permission_denied" : "provider_failed", error: sent ? "native provider disconnected; the outcome is unknown" : "native provider unavailable in this user session" }))
    socket.once("close", () => finish({ success: false, code: sent ? "timeout_unknown_outcome" : "provider_failed", error: sent ? "native provider disconnected; the outcome is unknown" : "native provider closed before negotiation" }))
  })
}
