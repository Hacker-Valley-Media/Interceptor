import {test,expect} from 'bun:test'
import {desktopVmActionError,desktopVmCopySelection,desktopVmResultError,desktopVmQmpChord} from '../shared/desktop-vm-validation'
import {parseMacosCommand} from '../cli/commands/macos'

test('VM file copy distinguishes Windows drives from exact guest paths',()=>{
  expect(desktopVmCopySelection('C:\\owned\\in.bin','guest1:/tmp/out.bin')).toEqual({name:'guest1',direction:'host-to-guest'})
  expect(desktopVmCopySelection('guest1:/tmp/in.bin','D:/owned/out.bin')).toEqual({name:'guest1',direction:'guest-to-host'})
  expect(desktopVmCopySelection('guest1:/a','guest2:/b')).toBeUndefined()
  expect(desktopVmCopySelection('/a','/b')).toBeUndefined()
  expect(desktopVmCopySelection('/a','bad/name:/b')).toBeUndefined()
  expect(parseMacosCommand(['macos','vm','cp','guest1:/tmp/in.bin','D:\\owned\\out.bin'])).toMatchObject({name:'guest1',src:'guest1:/tmp/in.bin',dst:'D:\\owned\\out.bin'})
})
test('VM names may contain dots and guest paths may be relative, as VMSpec allows',()=>{
  expect(parseMacosCommand(['macos','vm','cp','/tmp/a','ubuntu-24.04:/tmp/a'])).toMatchObject({name:'ubuntu-24.04',src:'/tmp/a',dst:'ubuntu-24.04:/tmp/a'})
  expect(parseMacosCommand(['macos','vm','cp','guest1:file','/tmp/file'])).toMatchObject({name:'guest1',src:'guest1:file',dst:'/tmp/file'})
  expect(desktopVmActionError({type:'desktop_vm',sub:'cp',name:'ubuntu-24.04',src:'/owned/in.bin',dst:'ubuntu-24.04:out.bin'})).toBeUndefined()
  expect(desktopVmActionError({type:'desktop_vm',sub:'start',name:'ubuntu-24.04'})).toBeUndefined()
  expect(desktopVmActionError({type:'desktop_vm',sub:'cp',name:'guest1',src:'/owned/in.bin',dst:'guest1:../foreign'})).toBeDefined()
  for(const name of ['.hidden','..','a/b'])expect(desktopVmActionError({type:'desktop_vm',sub:'start',name})).toBeDefined()
})
test('VM copy admission requires the selected VM and one host side',()=>{
  const action={type:'desktop_vm',sub:'cp',name:'guest1',src:'/owned/in.bin',dst:'guest1:/tmp/out.bin'}
  expect(desktopVmActionError(action)).toBeUndefined()
  expect(desktopVmActionError({...action,name:'guest2'})).toBeDefined()
  expect(desktopVmActionError({...action,src:'guest2:/tmp/in.bin'})).toBeDefined()
  expect(desktopVmActionError({...action,dst:'/owned/out.bin'})).toBeDefined()
  expect(desktopVmActionError({...action,src:'relative/in.bin'})).toBeDefined()
  expect(desktopVmActionError({...action,dst:'guest1:/tmp/../foreign'})).toBeDefined()
})
test('VM copy replies require actual bounded bytes, digest, direction and exclusive destination',()=>{
  const action={type:'desktop_vm',sub:'cp',name:'guest1',src:'/owned/in.bin',dst:'guest1:/tmp/out.bin'}
  const receipt={name:'guest1',direction:'host-to-guest',source:action.src,path:action.dst,bytes:3,sha256:'a'.repeat(64),verified:true,overwrite:false}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  for(const change of [{name:'guest2'},{direction:'guest-to-host'},{source:'/foreign/in.bin'},{path:'guest1:/foreign'},{bytes:1_048_577},{bytes:-1},{bytes:0.5},{sha256:'A'.repeat(64)},{verified:false},{overwrite:true}])expect(desktopVmResultError(action,{...receipt,...change})).toBeDefined()
  expect(desktopVmResultError(action,{path:action.dst,bytes:3})).toBeDefined()
})
test('VM execution receiver refuses invented, oversized or impossible counters',()=>{
  const action={type:'desktop_vm',sub:'exec',name:'guest1',command:['/bin/true']}
  const output={exitCode:0,stdout:'',stderr:'',durationMs:2}
  expect(desktopVmResultError(action,output)).toBeUndefined()
  for(const change of [{exitCode:0.1},{exitCode:2147483648},{durationMs:-1},{durationMs:58001},{stdout:'a'.repeat(131073)}])expect(desktopVmResultError(action,{...output,...change})).toBeDefined()
  expect(desktopVmResultError(action,{stdout:'',stderr:'',durationMs:0})).toBeDefined()
})
test('VM listener replies require actual loopback and requested ports including native port zero selection',()=>{
  const action={type:'desktop_vm',sub:'port_forward',name:'guest1',hostPort:0,guestPort:8080}
  const receipt={hostAddress:'127.0.0.1',hostPort:49152,guestAddress:'10.0.2.15',guestPort:8080}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  expect(desktopVmResultError({...action,hostPort:49152},receipt)).toBeUndefined()
  expect(desktopVmResultError({...action,hostPort:49153},receipt)).toBeDefined()
  for(const change of [{hostAddress:'0.0.0.0'},{hostPort:0},{hostPort:65536},{hostPort:0.5},{guestPort:8081},{guestAddress:'*'},{guestAddress:'0.0.0.0'},{guestAddress:'224.0.0.1'},{guestAddress:'999.1.1.1'},{guestAddress:'::1'}])expect(desktopVmResultError(action,{...receipt,...change})).toBeDefined()
})
test('VM input receipts require exact native submission and do not invent application effects',()=>{
  const action={type:'desktop_vm',sub:'type',name:'guest1',text:'A😀'}
  const receipt={name:'guest1',operation:'type',transport:'coregraphics',submittedEvents:4,guestEffectVerified:false,textUTF8Bytes:5}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  for(const change of [{operation:'keys'},{name:'other'},{submittedEvents:6},{submittedEvents:1.5},{textUTF8Bytes:3},{guestEffectVerified:true},{keys:'cmd+x'}])expect(desktopVmResultError(action,{...receipt,...change})).toBeDefined()
  const keys={type:'desktop_vm',sub:'keys',name:'guest1',keys:'cmd+shift+x'}
  const chord={name:'guest1',operation:'keys',transport:'coregraphics',submittedEvents:2,guestEffectVerified:false,keys:keys.keys}
  expect(desktopVmResultError(keys,chord)).toBeUndefined()
  expect(desktopVmResultError(keys,{...chord,keys:'cmd+c'})).toBeDefined()
  const click={type:'desktop_vm',sub:'click',name:'guest1',x:320,y:180,button:'right'}
  const point={name:'guest1',operation:'click',transport:'coregraphics',submittedEvents:2,guestEffectVerified:false,x:320,y:180,button:'right'}
  expect(desktopVmResultError(click,point)).toBeUndefined()
  for(const change of [{x:321},{y:181},{button:'left'},{submittedEvents:4},{guestEffectVerified:true}])expect(desktopVmResultError(click,{...point,...change})).toBeDefined()
})

test('QMP guest chords count actual modifier presses and reverse releases',()=>{
  expect(desktopVmQmpChord('cmd+shift+x')).toEqual(['meta_l','shift','x'])
  expect(desktopVmQmpChord('CONTROL+OPTION+DELETE')).toEqual(['ctrl','alt','delete'])
  expect(desktopVmQmpChord('enter')).toEqual(['ret'])
  for(const bad of ['', '+x', 'ctrl++x', 'ctrl+control+x', 'x+y', 'ctrl', 'é', 'ctrl+K', 'f99'])expect(desktopVmQmpChord(bad)).toBeUndefined()
  const action={type:'desktop_vm',sub:'keys',name:'guest1',keys:'cmd+shift+x'}
  const receipt={name:'guest1',operation:'keys',transport:'qmp',submittedEvents:6,guestEffectVerified:false,keys:action.keys}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  expect(desktopVmResultError(action,{...receipt,submittedEvents:2})).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,submittedEvents:8})).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,guestEffectVerified:true})).toBeDefined()
  expect(desktopVmResultError({...action,keys:'ctrl+control+x'},receipt)).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,transport:'coregraphics',submittedEvents:2})).toBeUndefined()
})
test('QMP click receipts require all four actual absolute/button submissions',()=>{
  const action={type:'desktop_vm',sub:'click',name:'guest1',x:1919,y:1079,button:'right'}
  const receipt={name:'guest1',operation:'click',transport:'qmp',submittedEvents:4,guestEffectVerified:false,x:1919,y:1079,button:'right'}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  expect(desktopVmResultError(action,{...receipt,submittedEvents:2})).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,name:'other'})).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,button:'left'})).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,guestEffectVerified:true})).toBeDefined()
})

test('guest AX replies reject leaked secure values, changed targets and invented completion',()=>{
  const action={type:'desktop_vm',sub:'read_ax',name:'guest1',app:'Fixture'},tree={ref:'ax1',role:'AXSecureTextField',secure:true,valueState:'redacted',value:'•••'}
  const receipt={name:'guest1',app:'Fixture',bundleIdentifier:'test.fixture',selector:'Fixture',pid:123,tree,visited:1,maxDepth:4,partial:false,reasons:[],refsActionable:false}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  for(const change of [{value:'secret canary'},{secure:false},{valueState:'read'},{role:'AXTextField',secure:false,valueState:'read',value:'unclassified canary'}])expect(desktopVmResultError(action,{...receipt,tree:{...tree,...change}})).toBeDefined()
  for(const change of [{name:'foreign'},{selector:'Other'},{pid:0},{pid:1.5},{visited:501},{maxDepth:5},{refsActionable:true},{partial:true},{unknown:true}])expect(desktopVmResultError(action,{...receipt,...change})).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,partial:true,reasons:['children_limit']})).toBeUndefined()
  expect(desktopVmResultError(action,{...receipt,tree:{...tree,children:[tree]},visited:2})).toBeDefined()
  const withheld={ref:'ax1',role:'AXTextField',secure:false,valueState:'withheld'}
  expect(desktopVmResultError(action,{...receipt,tree:withheld})).toBeUndefined()
})
test('guest log replies preserve unavailable files and the requested line scope',()=>{
  const action={type:'desktop_vm',sub:'logs',name:'guest1',limit:1}
  const receipt={name:'guest1',logs:[{path:'/tmp/InterceptorD.err.log',lines:[],state:'unavailable',truncated:false,error:'missing'},{path:'/tmp/InterceptorD.out.log',lines:['native line'],state:'read',truncated:false}],partial:true}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  expect(desktopVmResultError(action,{...receipt,partial:false})).toBeDefined()
  for(const change of [{path:'/foreign/log'},{lines:['a','b']},{lines:['😀'.repeat(513)]},{error:'conflicting error'}])expect(desktopVmResultError(action,{...receipt,logs:[receipt.logs[0],{...receipt.logs[1],...change}]})).toBeDefined()
  expect(desktopVmResultError(action,{...receipt,logs:[{...receipt.logs[0],lines:['invented']},receipt.logs[1]]})).toBeDefined()
})
test('guest mounts and trust replies require actual scoped receipts',()=>{
  const mount={type:'desktop_vm',sub:'mount',name:'guest1',tag:'data',path:'/tmp/data'}
  const mounted={name:'guest1',tag:'data',path:'/tmp/data',nativeMountPath:'/private/tmp/data',fileSystem:'virtiofs',mounted:true}
  expect(desktopVmResultError(mount,mounted)).toBeUndefined()
  for(const change of [{tag:'other'},{path:'/foreign'},{fileSystem:'apfs'},{mounted:false},{nativeMountPath:'relative'}])expect(desktopVmResultError(mount,{...mounted,...change})).toBeDefined()
  const action={type:'desktop_vm',sub:'trust',name:'guest1',noPrompt:true},trust={name:'guest1',platform:'macos',accessibility:'denied',screenRecording:'granted',postEvent:'denied',inputMonitoring:'granted',notes:[]}
  expect(desktopVmResultError(action,trust)).toBeUndefined()
  for(const change of [{platform:'linux'},{postEvent:'unknown'},{prompted:['Accessibility']},{opened:['Accessibility']}])expect(desktopVmResultError(action,{...trust,...change})).toBeDefined()
  const resetAction={...action,noPrompt:false,accessibilityPrompt:true,resetDenied:true}
  const reset={...trust,prompted:['Accessibility'],reset:[{service:'Accessibility',ok:false,error:'timeout',outcomeUnknown:true}]}
  expect(desktopVmResultError(resetAction,reset)).toBeUndefined()
  expect(desktopVmResultError(resetAction,{...reset,reset:[{...reset.reset[0],exitCode:0}]})).toBeDefined()
  const exited={service:'Accessibility',ok:false,exitCode:1,stdout:'',stderr:'denied',durationMs:5,truncated:false}
  expect(desktopVmResultError(resetAction,{...reset,reset:[exited]})).toBeUndefined()
  expect(desktopVmResultError(resetAction,{...reset,reset:[{...exited,ok:true}]})).toBeDefined()
})
test('guest PNG replies distinguish host outputs from inline image bytes',()=>{
  // Contract fixture. Native image decoding and guest capture are separate checks.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=','base64')
  const action={type:'desktop_vm',sub:'screenshot',name:'guest1'},receipt={width:1,height:1,bytes:png.length,format:'png',dataUrl:'data:image/png;base64,'+png.toString('base64')}
  expect(desktopVmResultError(action,receipt)).toBeUndefined()
  for(const change of [{width:2},{bytes:png.length+1},{dataUrl:'data:image/png;base64,AA=='},{filePath:'/guest/output'}])expect(desktopVmResultError(action,{...receipt,...change})).toBeDefined()
  const out={...action,out:'/tmp/owned.png'},saved={width:1,height:1,bytes:png.length,format:'png',filePath:'/tmp/owned.png'}
  expect(desktopVmResultError(out,saved)).toBeUndefined()
  expect(desktopVmResultError(out,{...saved,filePath:'/tmp/foreign.png'})).toBeDefined()
  expect(desktopVmResultError(out,receipt)).toBeDefined()
  expect(desktopVmResultError(action,saved)).toBeDefined()
})
