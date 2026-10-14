import {expect,test} from 'bun:test'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {captureShell} from './helpers/shell-capture'

test('private native registration validates real child frames, denial, cancellation, limits and timeout cleanup',()=>{
 const root=mkdtempSync(join(tmpdir(),'desktop-register-'))
 try{
  const fixture=join(root,'helper.ts'),runner=join(root,'runner.ts')
  writeFileSync(fixture,`
   const request=Buffer.from(await new Response(Bun.stdin.stream()).arrayBuffer());
   if(process.argv.slice(2).join()!=='--secret-ui'||request.readUInt32LE()+4!==request.length)process.exit(2);
   const mode=process.env.OWNED_REGISTRATION_MODE;
   if(mode==='pending'){await Bun.sleep(5000);}
   const result=mode==='cancel'?{success:true,data:{cancelled:true}}:
    mode==='cancel-value'?{success:true,data:{cancelled:true,value:'owned-synthetic'}}:
    mode==='error'?{success:false,code:'permission_denied',error:'private untrusted secret diagnostic owned-synthetic'}:
    mode==='extra'?{success:true,data:{cancelled:false,value:'owned-synthetic',extra:true}}:
    mode==='oversize'?{success:true,data:{cancelled:false,value:'x'.repeat(8193)}}:
    {success:true,data:{cancelled:false,value:'owned-synthetic 🙂'}};
   const body=Buffer.from(JSON.stringify(result)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);
   if(mode==='frame-limit'){header.writeUInt32LE(65537);await Bun.write(Bun.stdout,header);process.exit(0);}
   const frame=Buffer.concat([header,body]);await Bun.write(Bun.stdout,mode==='duplicate'?Buffer.concat([frame,frame]):frame);
   process.exit(mode==='failed-exit'?1:0);
  `)
  // The child exits 1 without output inside the Mac Bun test runner, retained in
  // auth-native-registration-reply-framing-observation.log. Reuse the existing
  // shell capture harness and the unchanged production reader in a real child.
  writeFileSync(runner,`
   import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
   import {readNativeRegistration} from ${JSON.stringify(new URL('../daemon/native-registration.ts',import.meta.url).pathname)};
   const request={name:'owned',gate:'none',targets:['any'],session:'owned-test'};
   const modes=['success','cancel','cancel-value','error','extra','oversize','frame-limit','duplicate','failed-exit','pending'];
   for(const mode of modes){
    const child=spawn(process.execPath,[${JSON.stringify(fixture)},'--secret-ui'],{env:{...process.env,OWNED_REGISTRATION_MODE:mode},stdio:['pipe','pipe','pipe']});
    const result=await readNativeRegistration(child,request,mode==='pending'?200:2000);
    if(mode==='success')assert.deepEqual(result,{success:true,data:{cancelled:false,value:'owned-synthetic 🙂'}});
    else if(mode==='cancel')assert.deepEqual(result,{success:true,data:{cancelled:true}});
    else{assert.equal(result.success,false,mode);assert.ok(!JSON.stringify(result).includes('owned-synthetic'),mode);if(mode==='pending')assert.equal(result.code,'cancelled');}
    assert.ok(child.exitCode!==null||child.signalCode!==null,mode+' helper must exit before resolution');
   }
   console.log(JSON.stringify({pass:true,cases:modes.length}));
  `)
  const child=captureShell(process.execPath,[runner],{timeout:12000})
  expect(child.status,child.stderr).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual({pass:true,cases:10})
 }finally{rmSync(root,{recursive:true,force:true})}
},15000)
