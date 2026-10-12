import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IPC_PORT, resolvePlatformConfig } from "../shared/platform"
import * as osInput from "../daemon/os-input-loader"
import { captureShell } from "./helpers/shell-capture"

describe("daemon ↔ CLI integration", () => {
  test("daemon writes pid/socket and CLI can connect without reporting daemon not running", () => {
    const root = mkdtempSync(join(tmpdir(), "interceptor-daemon-cli-")), output = join(root, "result.json")
    try {
      // Reuse the file capture used by other subprocess tests. This child owns
      // its daemon, runtime files and ports, including the startup-failure path.
      const script = `
        const {createServer}=await import('node:net');
        const {existsSync,readFileSync,writeFileSync}=await import('node:fs');
        const {captureSubprocess}=await import(${JSON.stringify(new URL('../daemon/subprocess.ts',import.meta.url).pathname)});
        async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
        const root=${JSON.stringify(root)},environment={...process.env,INTERCEPTOR_TEMP:root,INTERCEPTOR_WS_PORT:String(await freePort()),INTERCEPTOR_IPC_PORT:String(await freePort())};
        const daemon=Bun.spawn([process.execPath,'run','daemon/index.ts','--standalone'],{env:environment,stdin:'ignore',stdout:'ignore',stderr:'ignore'});
        try{
          for(let i=0;i<100&&!existsSync(root+'/interceptor.lock');i++){if(daemon.exitCode!==null)throw Error('Owned daemon exited '+daemon.exitCode);await Bun.sleep(50);}
          if(!existsSync(root+'/interceptor.lock'))throw Error('Owned daemon did not start');
          const lock=JSON.parse(readFileSync(root+'/interceptor.lock','utf8'));
          const status=await captureSubprocess([process.execPath,'run','cli/index.ts','--json','status'],{env:environment,timeoutMs:15000});
          const contexts=await captureSubprocess([process.execPath,'run','cli/index.ts','--json','contexts'],{env:environment,timeoutMs:15000});
          writeFileSync(${JSON.stringify(output)},JSON.stringify({status,contexts,pid:daemon.pid,lockPID:lock.pid,pidFile:readFileSync(root+'/interceptor.pid','utf8'),socketPresent:process.platform==='win32'||existsSync(root+'/interceptor.sock'),transport:process.platform==='win32'?'tcp:127.0.0.1:'+environment.INTERCEPTOR_IPC_PORT:'unix:'+root+'/interceptor.sock'}));
        }finally{daemon.kill('SIGTERM');await daemon.exited;}
      `
      const child = captureShell(process.execPath, ['-e', script], {timeout:40000})
      expect(child.status, child.stderr).toBe(0)
      const evidence = JSON.parse(readFileSync(output, 'utf8'))
      expect(evidence.lockPID).toBe(evidence.pid)
      expect(evidence.pidFile).toContain(String(evidence.pid))
      expect(evidence.pidFile).toContain(evidence.transport)
      expect(evidence.socketPresent).toBe(true)
      expect(evidence.status.code as number, evidence.status.stderr as string).toBe(0)
      expect(evidence.status.stdout.trim().length).toBeGreaterThan(0)
      expect(evidence.status.stdout + evidence.status.stderr).not.toContain('daemon not running')
      expect(JSON.parse(evidence.status.stdout).daemon).toBe(true)
      expect(evidence.contexts.code as number, evidence.contexts.stderr as string).toBe(0)
      expect(JSON.parse(evidence.contexts.stdout)).toEqual([])
    } finally { rmSync(root, {recursive:true,force:true}) }
  }, 45000)

  test("os-input-loader exposes OS input functions", () => {
    expect(typeof osInput.osClick).toBe("function")
    expect(typeof osInput.osKey).toBe("function")
    expect(typeof osInput.osType).toBe("function")
    expect(typeof osInput.osMove).toBe("function")
    expect(typeof osInput.translateCoords).toBe("function")
    expect(typeof osInput.generateBezierPath).toBe("function")
  })

  test("platform constants resolve correctly", () => {
    const win = resolvePlatformConfig("win32", "C:\\Temp")
    expect(win.isWin).toBe(true)
    expect(win.ipcPort).toBe(IPC_PORT)
    expect(win.transportLabel).toBe(`tcp:127.0.0.1:${IPC_PORT}`)
    expect(win.pidPath).toContain("interceptor.pid")

    // Per-user runtime files: the temp dir is the account's own, never /tmp.
    const noKill = () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }) }
    const mac = resolvePlatformConfig("darwin", undefined, { env: { TMPDIR: "/var/folders/t/T" }, uid: 501, kill: noKill })
    expect(mac.isWin).toBe(false)
    expect(mac.socketPath).toBe("/var/folders/t/T/interceptor.sock")
    expect(mac.transportLabel).toBe("unix:/var/folders/t/T/interceptor.sock")
    expect(mac.pidPath).toBe("/var/folders/t/T/interceptor.pid")
    expect(mac.wsPort).toBe(19222)
  })
})
