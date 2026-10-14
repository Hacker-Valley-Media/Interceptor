import {expect,test} from 'bun:test'
import {createServer} from 'node:net'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {callDesktopProvider} from '../daemon/desktop-provider'
import {DESKTOP_OPERATION_DATA_SCHEMAS,DESKTOP_CLIPBOARD_DATA_SCHEMAS,DESKTOP_ACCESSIBILITY_DATA_SCHEMAS} from '../shared/desktop-contract.generated'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {generateDesktopContract} from '../scripts/desktop-contract'
import {fixtureReply} from './fixtures/desktop-reply-fixture-peer'

test('result schema selection follows action declarations rather than a second operation list',async()=>{
  expect(DESKTOP_OPERATION_DATA_SCHEMAS).toEqual({desktop_vm:'DesktopVmData',desktop_photos:'DesktopPhotosData',desktop_calendar:'DesktopCalendarData',desktop_reminders:'DesktopRemindersData',desktop_contacts:'DesktopContactsData',desktop_trust:'DesktopTrustData',desktop_vision:'DesktopVisionData',desktop_sensitive:'DesktopSensitiveData',desktop_update:'DesktopUpdateData',desktop_location:'DesktopLocationData',desktop_maps:'DesktopMapsData',desktop_share:'DesktopShareData',desktop_music:'DesktopMusicData',desktop_nlp:'DesktopLanguageNlpData',desktop_ai:'DesktopLanguageAiData',desktop_translate:'DesktopLanguageTranslateData',desktop_detect:'DesktopLanguageDetectData',desktop_health:"DesktopHealthData",desktop_notifications:"DesktopNotificationData",desktop_secret:"DesktopSecretData",desktop_files:'DesktopFilesData',desktop_container_run:'DesktopContainerRunData',desktop_thumbnail:'DesktopThumbnailData',desktop_log_query:'DesktopLogQueryData',desktop_url_fetch:'DesktopHttpFetchData',desktop_read:'DesktopCompoundReadData',desktop_open:'DesktopCompoundOpenData',desktop_act:'DesktopCompoundActData',desktop_inspect_app:'DesktopCompoundInspectData',desktop_display_info:'DesktopDisplayInfoData',desktop_screenshot:'DesktopCaptureScreenshotData',desktop_fs_read:'DesktopFsReadData',desktop_fs_write:'DesktopFsWriteData',desktop_fs_search:'DesktopFsSearchData',desktop_tree:'DesktopAxTreeData',desktop_text:'DesktopAxTextData',desktop_resize:'DesktopAxResizeData',desktop_move:'DesktopAxMoveData',desktop_apps:'DesktopAxAppsData',desktop_app:'DesktopAxAppData',desktop_windows:'DesktopAxWindowsData',desktop_frontmost:'DesktopAxFrontmostData',desktop_focused:'DesktopAxFocusedData',desktop_find:'DesktopAxFindData',desktop_inspect:'DesktopAxInspectData',desktop_value:'DesktopAxValueData',desktop_type:'DesktopAxTypeData',desktop_click:'DesktopAxClickData',desktop_action:'DesktopAxActionData',desktop_keys:'DesktopAxKeysData',desktop_scroll:'DesktopAxScrollData',desktop_drag:'DesktopAxDragData',desktop_menu:'DesktopAxMenuData'})
  const source=await Bun.file(join(import.meta.dir,'../shared/desktop-contract.ts')).text()
  const output=generateDesktopContract(source.replace('"desktop_fs_read"','"desktop_fs_read_fixture"'))
  expect(output.typescript).toContain('"desktop_fs_read_fixture": "DesktopFsReadData"')
  expect(output.typescript).not.toContain('"desktop_fs_read": "DesktopFsReadData"')
  const logOutput=generateDesktopContract(source.replace('"desktop_log_query"','"desktop_log_query_fixture"'))
  expect(logOutput.typescript).toContain('"desktop_log_query_fixture": "DesktopLogQueryData"')
  expect(logOutput.typescript).not.toContain('"desktop_log_query": "DesktopLogQueryData"')
  expect(DESKTOP_CLIPBOARD_DATA_SCHEMAS).toEqual({readText:'string',readRtf:'string',readImage:'string',readFiles:'string[]',write:'DesktopClipboardAck',clear:'DesktopClipboardAck',tail:'DesktopClipboardTailData',history:'DesktopClipboardHistoryEntry[]',types:'string[]'})
  expect(generateDesktopContract(source.replace('readText: string','readText: string[]')).typescript).toContain('"readText": "string[]"')
  expect(desktopContractShapeError({event:'clipboard_change',timestamp:'2026-10-03T00:00:00Z',changeCount:1,types:[],preview:''},'DesktopClipboardEvent')).toBeUndefined()
  expect(desktopContractShapeError({event:'unrelated',timestamp:'fixture',changeCount:1,types:[],preview:''},'DesktopClipboardEvent')).toBeDefined()
  for (const schema of ['DesktopAxTreeData','DesktopAxTextData'] as const) {
    for (const value of ['', 'Selected 🙂 文件', 'line one\nline two']) expect(desktopContractShapeError(value, schema)).toBeUndefined()
    for (const value of [undefined, null, 42, false, [], {text:'invented'}]) expect(desktopContractShapeError(value, schema)).toBeDefined()
  }
})

test('accessibility reply types retain host formats, nullable targets and nested field types',()=>{
  // Every host lists apps as {name, pid} rows; the Mac adds bundleId/active/hidden.
  for(const host of ['darwin','win32','linux'] as const){
    expect(desktopContractShapeError([{name:'Owned fixture',pid:42}],DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_apps)).toBeUndefined()
    expect(desktopContractShapeError('Mac app inventory',DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_apps)).toBeDefined()
  }
  expect(desktopContractShapeError([{name:'Finder',pid:42,bundleId:'com.apple.finder',active:false,hidden:true}],DESKTOP_ACCESSIBILITY_DATA_SCHEMAS.darwin.desktop_apps)).toBeUndefined()
  expect(desktopContractShapeError([{name:'Finder',pid:42,extra:1}],DESKTOP_ACCESSIBILITY_DATA_SCHEMAS.darwin.desktop_apps)).toBeDefined()
  for(const host of ['win32','linux'] as const){
    expect(desktopContractShapeError(null,DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_frontmost)).toBeUndefined()
    expect(desktopContractShapeError(null,DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_focused)).toBeUndefined()
    for(const value of [undefined,42,false,[],{pid:1}])expect(desktopContractShapeError(value,DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_frontmost)).toBeDefined()
    expect(desktopContractShapeError('read text',DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_value_read)).toBeUndefined()
    expect(desktopContractShapeError('read text',DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_value_write)).toBeDefined()
    expect(desktopContractShapeError({method:'owned native setter',background:true},DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[host].desktop_value_write)).toBeUndefined()
  }
  const node={ref:'e1',role:'textfield',nativeRole:'entry',name:'Owned fixture',title:'Owned fixture',value:'🙂 文件',pid:42,secure:false,frame:null}
  expect(desktopContractShapeError(node,'DesktopAxLinuxNode')).toBeUndefined()
  for(const malformed of [{...node,frame:undefined},{...node,pid:'42'},{...node,secure:'false'},{...node,unexpected:true},{...node,frame:{x:0,y:0,width:42,height:'1'}}])expect(desktopContractShapeError(malformed,'DesktopAxLinuxNode')).toBeDefined()
  expect(desktopContractShapeError({...node,nativeRole:50004,frame:{x:1,y:2,width:3,height:4}},'DesktopAxWin32Node')).toBeUndefined()
  expect(desktopContractShapeError(node,'DesktopAxWin32Node')).toBeDefined()
  const menu=[{title:'File',enabled:true,children:[{title:'Owned item',enabled:false,children:[]}]}]
  expect(desktopContractShapeError(menu,DESKTOP_ACCESSIBILITY_DATA_SCHEMAS.linux.desktop_menu_list)).toBeUndefined()
  expect(desktopContractShapeError(menu,DESKTOP_ACCESSIBILITY_DATA_SCHEMAS.win32.desktop_menu_list)).toBeDefined()
  expect(desktopContractShapeError({method:'owned menu invocation',background:true},DESKTOP_ACCESSIBILITY_DATA_SCHEMAS.linux.desktop_menu_invoke)).toBeUndefined()
  expect(desktopContractShapeError(menu,DESKTOP_ACCESSIBILITY_DATA_SCHEMAS.linux.desktop_menu_invoke)).toBeDefined()
})

test.skipIf(process.platform!=='darwin')('native client rejects invalid UTF-8 and filesystem reply data without replaying',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'desktop-domain-'))
  const previous=process.env.INTERCEPTOR_DESKTOP_ENDPOINT
  const modes=['invalid-hello-utf8','invalid-result-utf8','hello-bom','fs-read-valid','fs-read-invalid','fs-write-valid','fs-write-invalid','fs-search-valid','fs-search-invalid','fs-read-denied']
  for(const key of Object.keys(DESKTOP_CLIPBOARD_DATA_SCHEMAS))modes.push('clip-'+key+'-valid','clip-'+key+'-invalid')
  for(const domain of ['text','tree'])for(const variant of ['valid','empty-valid','unicode-valid','null-invalid','number-invalid','array-invalid','object-invalid','missing-invalid'])modes.push(domain+'-'+variant)
  try {
    for(const mode of modes) {
      const endpoint=join(directory,mode+'.sock')
      process.env.INTERCEPTOR_DESKTOP_ENDPOINT=endpoint
      let dispatches=0,connections=0
      const server=createServer(socket=>{
        connections++
        socket.on('error',()=>{})
        let bytes=Buffer.alloc(0)
        socket.on('data',chunk=>{
          bytes=Buffer.concat([bytes,Buffer.from(chunk)])
          while(bytes.length>=4&&bytes.length>=bytes.readUInt32LE()+4) {
            const size=bytes.readUInt32LE(),request=JSON.parse(bytes.subarray(4,size+4).toString())
            bytes=bytes.subarray(size+4)
            const reply=fixtureReply(mode,request)
            if(reply.mutation)dispatches++
            const header=Buffer.alloc(4);header.writeUInt32LE(reply.body.length)
            socket.write(header.subarray(0,1));socket.write(header.subarray(1));socket.write(reply.body)
          }
        })
      })
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve)})
      try {
        const family=mode.startsWith('fs-')?mode.split('-')[1]:'type'
        const clipKey=mode.split('-')[1]
        const action=/^(text|tree)-/.test(mode)?{type:'desktop_'+mode.split('-')[0],ref:mode.startsWith('text-')?'e1':undefined}:mode.startsWith('clip-')?{type:'desktop_clipboard',sub:clipKey.startsWith('read')?'read':clipKey,contentType:clipKey.startsWith('read')?clipKey.slice(4).toLowerCase():undefined,text:clipKey==='write'?'fixture':undefined}:family==='read'?{type:'desktop_fs_read',path:'owned://fixture'}:family==='write'?{type:'desktop_fs_write',path:'owned://fixture',content:'fixture'}:family==='search'?{type:'desktop_fs_search',query:'fixture'}:{type:'desktop_type',text:'fixture'}
        const result=await callDesktopProvider(action,2000)
        const beforeDispatch=mode==='invalid-hello-utf8'||mode==='hello-bom'
        const valid=mode.endsWith('-valid')
        expect(result.success).toBe(valid)
        if(!valid)expect(result.code).toBe(beforeDispatch?'provider_failed':mode==='fs-read-denied'?'permission_denied':'timeout_unknown_outcome')
        expect(dispatches).toBe(beforeDispatch?0:1)
        expect(connections).toBe(1)
      } finally {await new Promise<void>(resolve=>server.close(()=>resolve()))}
    }
  } finally {
    if(previous===undefined)delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT
    else process.env.INTERCEPTOR_DESKTOP_ENDPOINT=previous
    rmSync(directory,{recursive:true,force:true})
  }
})

test('plain-text apps keeps the [pid] name line on every host',async()=>{
  const {formatAppRows}=await import('../cli/commands/macos')
  expect(formatAppRows([{name:'Finder',pid:42,bundleId:'com.apple.finder',active:true,hidden:true},{name:'Notepad',pid:7}])).toBe('[42] Finder * (hidden) — com.apple.finder\n[7] Notepad')
})
