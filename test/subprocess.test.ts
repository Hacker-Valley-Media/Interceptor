import { expect, test } from "bun:test"
import { captureSubprocess } from "../daemon/subprocess"
import { captureShell } from "./helpers/shell-capture"
import { resolve } from "node:path"

// Run these assertions in an owned child so Bun's macOS test descriptor bug
// cannot turn real stdout/stderr into empty buffers. Every assertion stays.
const cases = [
  { name: "async host capture preserves input, both streams and a nonzero exit", script: `
    const result=await captureSubprocess([process.execPath,"-e",'process.stdout.write(await Bun.stdin.text()); process.stderr.write("stderr 文件"); process.exit(7)'],{input:"stdin 文件 😀",timeoutMs:2000});
    assert.deepEqual(result,{code:7,stdout:"stdin 文件 😀",stderr:"stderr 文件"});
    assert.equal((await runAsync("/interceptor-fixture/missing-tool",[])).code,127);
  ` },
  { name: "an awaited slow host tool allows unrelated event-loop work", script: `
    let ticks=0;const timer=setInterval(()=>ticks++,5);
    try{const result=await runAsync(process.execPath,["-e",'await Bun.sleep(250); console.log("owned host tool completed")']); assert.equal(result.ok,true); assert.equal(result.stdout.trim(),"owned host tool completed"); assert.ok(ticks>10);}finally{clearInterval(timer);}
  ` },
  { name: "the deadline kills a TERM-ignoring host tool", script: `
    const started=performance.now();const result=await runAsync(process.execPath,["-e",'process.on("SIGTERM",()=>{}); console.log(process.pid); await Bun.sleep(1500)'],{timeoutMs:150});
    assert.equal(result.code,124);assert.equal(result.ok,false);assert.ok(result.stderr.includes("killed after 150ms"));assert.ok(performance.now()-started<1000);
  ` },
  { name: "the deadline closes pipes inherited by an owned grandchild after its parent exits", skip: process.platform === "win32", script: `
    const script='const child=Bun.spawn([process.execPath,"-e",\\'process.on("SIGTERM",()=>{}); await Bun.sleep(1500)\\'],{stdout:"inherit",stderr:"inherit"}); console.log(JSON.stringify({parent:process.pid,child:child.pid})); process.exit(0)';
    const started=performance.now();const result=await captureSubprocess([process.execPath,"-e",script],{timeoutMs:150});assert.equal(result.code,124);assert.ok(performance.now()-started<1000);const ids=JSON.parse(result.stdout);assert.ok(ids.parent>0);assert.ok(ids.child>0);
  ` },
  { name: "device discovery keeps unrelated requests responsive while CoreDevice is waiting", script: `
    const realSpawn=Bun.spawn;let slowStarted;const slow=new Promise(resolve=>slowStarted=resolve);
    const devices=[{hardwareProperties:{platform:"iOS",udid:"00008120-0000000000000185"},deviceProperties:{name:"Owned CoreDevice fixture",osVersionNumber:"27.0",developerModeStatus:"enabled"},connectionProperties:{transportType:"wired",pairingState:"paired"}}];
    Bun.spawn=(argv,opts)=>{
      if(argv[0]!=="/usr/bin/xcrun")return realSpawn(argv,opts);
      let code='';
      if(argv.includes("--find"))code='console.log("/owned/xcrun-tool")';
      else if(argv.includes("simctl"))code='console.log(JSON.stringify({devices:{}}))';
      else if(argv.includes("devicectl")){const file=argv[argv.indexOf("--json-output")+1];code='await Bun.sleep(400); await Bun.write('+JSON.stringify(file)+','+JSON.stringify(JSON.stringify({result:{devices}}))+');';slowStarted();}
      else throw Error("Unexpected tool fixture request");
      return realSpawn([process.execPath,"-e",code],opts);
    };
    const {IosManager}=await import(${JSON.stringify(resolve("daemon/ios/manager.ts"))});const manager=new IosManager({emit(){},wsPort:0});
    const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response("unrelated request completed")}});
    try{let finished=false;const pending=manager.handle({type:"ios_discover"}).then(value=>{finished=true;return value});await slow;
      const began=performance.now();assert.equal(await (await fetch(server.url)).text(),"unrelated request completed");assert.ok(performance.now()-began<250);assert.equal(finished,false);
      const result=await pending;assert.equal(result.success,true);assert.equal(result.data.devices.length,1);assert.equal(result.data.devices[0].name,"Owned CoreDevice fixture");assert.equal(result.data.devices[0].transport,"usb");
    }finally{server.stop(true);manager.shutdown();}
  ` },
]
for (const item of cases) test.skipIf(item.skip ?? false)(item.name, async () => {
  const script=`import assert from "node:assert/strict";import {captureSubprocess} from ${JSON.stringify(resolve("daemon/subprocess.ts"))};import {runAsync} from ${JSON.stringify(resolve("daemon/ios/tools.ts"))};${item.script};console.log(JSON.stringify({pass:true}));`
  const result=process.platform === "darwin"
    ? (() => { const captured=captureShell(process.execPath,["-e",script],{timeout:5000});return{code:captured.status,stdout:captured.stdout,stderr:captured.stderr} })()
    : await captureSubprocess([process.execPath,"-e",script],{timeoutMs:5000})
  expect(result.code,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).pass).toBe(true)
})
