import {desktopContractShapeError} from './desktop-contract-validation'
import {nativeSecretIdentity,sameNativeSecretIdentity} from './native-secret-target'

export function desktopAuthDialogActionError(a:Record<string,unknown>):string|undefined {
 if(a.type!=='desktop_authdialog')return
 const shape=desktopContractShapeError(a,'DesktopAuthDialogAction');if(shape)return shape
 const text=(v:unknown,max:number)=>typeof v==='string'&&!!v&&!v.includes('\0')&&Buffer.byteLength(v)<=max
 for(const key of ['app','group','groupColor'])if(a[key]!==undefined&&!text(a[key],key==='app'?4096:256))return 'authentication dialog scope text is invalid'
 for(const [key,max]of [['pid',0x7fffffff],['window',Number.MAX_SAFE_INTEGER]] as const)if(a[key]!==undefined&&(!Number.isSafeInteger(a[key])||(a[key] as number)<1||(a[key] as number)>max))return 'authentication dialog native scope requires a positive bounded integer'
 for(const key of ['ref','dialogRef'])if(a[key]!==undefined&&(typeof a[key]!=='string'||!/^e\d{1,63}$/.test(a[key] as string)))return 'authentication dialog requires an exact native reference'
 if(a.sub==='status'&&['text','secret','submit','sensitive','backgroundOnly','secretBindingName','secretLease','expectedIdentity'].some(key=>a[key]!==undefined))return 'authentication dialog status accepts only native target scope'
 if(a.sub==='fill'){
  if(typeof a.ref!=='string')return 'portable authentication fill requires an exact secure-field reference'
  if(a.secret!==undefined&&(typeof a.secret!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a.secret)))return 'authentication dialog requires an exact vault name'
  if(a.secret!==undefined&&a.text!==undefined)return 'authentication dialog accepts a named secret or resolved value, never both'
  if(a.text!==undefined&&(!text(a.text,8192)||[...a.text as string].length>512||(a.text as string).length>1024||/[\r\n]/.test(a.text as string)))return 'authentication value exceeds its bounds or contains a line break'
  if(a.secret===undefined&&a.text===undefined)return 'authentication dialog fill requires a named secret or resolved value'
  if(typeof a.secretLease!=='string'||!/^[a-f0-9]{64}$/.test(a.secretLease))return 'portable authentication fill requires its direct graphical-session grant'
  if(a.text!==undefined&&(typeof a.dialogRef!=='string'||a.sensitive!==true||a.backgroundOnly!==true||typeof a.secretBindingName!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a.secretBindingName)||a.expectedIdentity===undefined))return 'resolved authentication delivery requires its retained native window, identity and grant'
  if(a.expectedIdentity!==undefined)try{const i=a.expectedIdentity as {host?:unknown};if(i.host!=='windows'&&i.host!=='linux')return 'authentication identity host is invalid';nativeSecretIdentity(i,i.host)}catch{return 'authentication identity is invalid'}
 }
}

export function desktopAuthDialogResultError(a:Record<string,unknown>,value:unknown):string|undefined {
 if(a.type!=='desktop_authdialog')return
 const shape=desktopContractShapeError(value,a.sub==='status'?'DesktopAuthDialogStatus':'DesktopAuthDialogFilled');if(shape)return shape
 const r=value as Record<string,unknown>
 if(!['windows-credential-dialog','linux-polkit-dialog'].includes(String(r.provider)))return 'authentication dialog native provider is invalid'
 for(const key of ['title','message','username'])if(r[key]!==undefined&&(typeof r[key]!=='string'||Buffer.byteLength(r[key] as string)>32768))return 'authentication dialog observation exceeds its text bound'
 if(a.sub==='status'){
  if(r.present===false){if(a.ref!==undefined||a.dialogRef!==undefined)return 'retained authentication target cannot be reported as unscoped absence';if(r.shape!=='none'||Object.keys(r).some(key=>!['present','shape','provider'].includes(key)))return 'absent authentication dialog carries target metadata';return}
  if(r.shape!=='password'||r.hasSecureField!==true||!Number.isSafeInteger(r.pid)||typeof r.secureRef!=='string'||!/^e\d{1,63}$/.test(r.secureRef)||typeof r.dialogRef!=='string'||!/^e\d{1,63}$/.test(r.dialogRef)||!Array.isArray(r.buttons)||r.buttons.length>64||r.buttons.some(v=>typeof v!=='string'||Buffer.byteLength(v)>8192))return 'authentication dialog target metadata is invalid'
  if(a.ref!==undefined&&a.ref!==r.secureRef||a.dialogRef!==undefined&&a.dialogRef!==r.dialogRef||a.pid!==undefined&&a.pid!==r.pid)return 'authentication dialog target differs from its exact selector'
  if(r.usernameRef!==undefined&&(typeof r.usernameRef!=='string'||!/^e\d{1,63}$/.test(r.usernameRef)||r.usernameRef===r.secureRef||r.usernameRef===r.dialogRef))return 'authentication account reference is invalid'
 }else{
  if(r.filled!==true||r.shape!=='password'||!Number.isSafeInteger(r.chars)||(r.chars as number)<1||(r.chars as number)>512||r.valueAccepted!==null||r.delivery!=='native-value-set'||r.pressedUsePassword!==false||r.usernameFixed!==false||typeof r.generation!=='string'||!/^[a-f0-9]{64}$/.test(r.generation)||a.submit!==true&&r.submitted!==null)return 'authentication delivery receipt is invalid'
  if(typeof a.text==='string'&&r.chars!==[...a.text].length)return 'authentication delivery count differs from its exact resolved value'
  const confirmations=['OK','Install','Install Software','Install Helper','Unlock','Allow','Modify Settings','Continue','Update Settings','Authorize','Authenticate','Yes']
  if(r.submitted!==null&&(typeof r.submitted!=='string'||!confirmations.includes(r.submitted)))return 'authentication confirmation is not a supported one-time button'
  if(a.submit===true&&r.submitted===null||r.dialogClosed===true&&r.submitted===null)return 'authentication receipt reports impossible confirmation or closure'
  if(r.closureObservationError!==undefined&&(r.submitted===null||r.dialogClosed===true||typeof r.closureObservationError!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(r.closureObservationError)))return 'authentication closure observation error is invalid'
 }
 try{const host=r.provider==='windows-credential-dialog'?'windows':'linux',identity=nativeSecretIdentity(r.targetIdentity,host);if(r.pid!==undefined&&r.pid!==identity.pid||a.pid!==undefined&&a.pid!==identity.pid||a.expectedIdentity!==undefined&&!sameNativeSecretIdentity(identity,nativeSecretIdentity(a.expectedIdentity,host)))return 'authentication native process identity differs from its retained target';if(a.sub==='fill'&&r.routing!==`pid=${identity.pid}`)return 'authentication delivery routing differs from its retained process'}catch{return 'authentication native target identity is unavailable'}
}
