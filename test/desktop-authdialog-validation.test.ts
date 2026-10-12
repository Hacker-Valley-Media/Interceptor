import {expect,test} from 'bun:test'
import {desktopAuthDialogActionError,desktopAuthDialogResultError} from '../shared/desktop-authdialog-validation'
import {DESKTOP_AUTH_OPERATIONS,DESKTOP_AUTHDIALOG_OPERATIONS,DESKTOP_AUTH_DATA_SCHEMAS,DESKTOP_AUTHDIALOG_DATA_SCHEMAS} from '../shared/desktop-contract.generated'
import {classify} from '../cli/mcp/tiers'

const identity={host:'linux' as const,pid:42,executable:'/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1',user:'1000',session:'1:123',creation:'987',image:'device:inode:ctime'}
const action={type:'desktop_authdialog',sub:'fill',secret:'owned',ref:'e42',secretLease:'a'.repeat(64),pid:42,submit:true}
const status={present:true,shape:'password',provider:'linux-polkit-dialog',pid:42,title:'Owned fixture',message:'Owned fixture',buttons:['Cancel','Authenticate'],username:'',hasSecureField:true,dialogRef:'e41',secureRef:'e42',targetIdentity:identity}

test('authentication dialog generation does not change LocalAuthentication family discovery or replies',()=>{
 expect(DESKTOP_AUTH_OPERATIONS).toEqual(['desktop_auth'])
 expect(DESKTOP_AUTHDIALOG_OPERATIONS).toEqual(['desktop_authdialog'])
 expect(Object.keys(DESKTOP_AUTH_DATA_SCHEMAS).sort()).toEqual(['confirm','domain_state','invalidate','status'])
 expect(DESKTOP_AUTHDIALOG_DATA_SCHEMAS).toEqual({status:'DesktopAuthDialogStatus',fill:'DesktopAuthDialogFilled'})
})

test('portable authentication requires exact scope and grants and refuses unsafe resolved input',()=>{
 expect(desktopAuthDialogActionError(action)).toBeUndefined()
 for(const bad of [{...action,secretLease:undefined},{...action,ref:undefined},{...action,extra:true},{...action,pid:42.5},{...action,window:0},{...action,secret:'owned\0'},{...action,text:'literal'},{type:'desktop_authdialog',sub:'status',text:'literal'}])expect(desktopAuthDialogActionError(bad)).toBeDefined()
 const resolved={...action,secret:undefined,text:'owned synthetic value',sensitive:true,backgroundOnly:true,secretBindingName:'owned',expectedIdentity:identity,dialogRef:'e41'}
 delete resolved.secret
 expect(desktopAuthDialogActionError(resolved)).toBeUndefined()
 for(const bad of [{...resolved,dialogRef:undefined},{...resolved,sensitive:false},{...resolved,backgroundOnly:false},{...resolved,text:'a'.repeat(513)},{...resolved,text:'line\nbreak'},{...resolved,expectedIdentity:{...identity,host:'darwin'}}])expect(desktopAuthDialogActionError(bad)).toBeDefined()
})

test('authentication observations preserve native secure-field and retained window identities',()=>{
 const probe={type:'desktop_authdialog',sub:'status',ref:'e42',pid:42,dialogRef:'e41'}
 expect(desktopAuthDialogResultError(probe,status)).toBeUndefined()
 for(const bad of [{...status,dialogRef:'e43'},{...status,secureRef:'e43'},{...status,pid:43},{...status,shape:'touchid'},{...status,hasSecureField:false},{...status,value:'unmasked'},{...status,targetIdentity:{...identity,host:'windows'}},{...status,buttons:Array(65).fill('Allow')}])expect(desktopAuthDialogResultError(probe,bad)).toBeDefined()
 expect(desktopAuthDialogResultError({type:'desktop_authdialog',sub:'status'},{present:false,shape:'none',provider:'linux-polkit-dialog'})).toBeUndefined()
 expect(desktopAuthDialogResultError(probe,{present:false,shape:'none',provider:'linux-polkit-dialog',pid:42})).toBeDefined()
})

test('authentication fill remains destructive on MCP while status remains read-only',()=>{
 for(const surface of ['macos','desktop'] as const){
  expect(classify(surface,'authdialog',['fill','--secret','owned']).tier).toBe('destructive')
  expect(classify(surface,'authdialog',['status']).tier).toBe('read')
 }
})

test('authentication receipts reject impossible confirmation and mismatched delivery state',()=>{
 const resolved={...action,text:'owned value',expectedIdentity:identity}
 const receipt={filled:true,chars:11,shape:'password',provider:'linux-polkit-dialog',delivery:'native-value-set',valueAccepted:null,pressedUsePassword:false,usernameFixed:false,routing:'pid=42',submitted:'Authenticate',dialogClosed:false,generation:'b'.repeat(64),targetIdentity:identity}
 expect(desktopAuthDialogResultError(resolved,receipt)).toBeUndefined()
 for(const bad of [{...receipt,chars:10},{...receipt,routing:'pid=43'},{...receipt,submitted:'Always Allow'},{...receipt,submitted:null},{...receipt,dialogClosed:true,closureObservationError:'provider_failed'},{...receipt,closureObservationError:'x'.repeat(65)}])expect(desktopAuthDialogResultError(resolved,bad)).toBeDefined()
 expect(desktopAuthDialogResultError({...resolved,submit:false},{...receipt,submitted:null})).toBeUndefined()
 expect(desktopAuthDialogResultError({...resolved,submit:false},{...receipt,submitted:null,dialogClosed:true})).toBeDefined()
 expect(desktopAuthDialogResultError({type:'desktop_authdialog',sub:'status',ref:'e42'},{present:false,shape:'none',provider:'linux-polkit-dialog'})).toBeDefined()
 for(const usernameRef of ['e42','e41','changed'])expect(desktopAuthDialogResultError({type:'desktop_authdialog',sub:'status'},{...status,usernameRef})).toBeDefined()
})
