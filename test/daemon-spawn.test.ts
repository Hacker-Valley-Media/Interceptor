import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { captureShell } from "./helpers/shell-capture"
import {
  daemonBinaryCandidates,
  findDaemonBinary,
  formatMissingDaemonBinaryError,
  MACOS_PKG_DAEMON_PATH,
} from "../cli/daemon-spawn"

describe("daemon spawn binary resolution", () => {
  test.skipIf(process.platform === "win32")("cold-start daemon does not retain the caller directory", () => {
    const root = realpathSync(mkdtempSync("/tmp/i-cwd-")), binaryDir = join(root, "daemon"), caller = join(root, "caller")
    mkdirSync(binaryDir); mkdirSync(caller)
    const observed = join(root, "observed.json"), result = join(root, "result.json")
    writeFileSync(join(binaryDir, "interceptor-daemon"), `#!${process.execPath}\n
      await Bun.write(${JSON.stringify(observed)}, JSON.stringify({cwd:process.cwd(),pid:process.pid}));
      await Bun.write(${JSON.stringify(join(root,'interceptor.pid'))},String(process.pid));
      const server=Bun.listen({unix:${JSON.stringify(join(root,'interceptor.sock'))},socket:{data(){}}});
      setTimeout(()=>{server.stop(true);process.exit(0)},5000);
    `, {mode:0o700})
    try {
      const script = `
        const {readFileSync,writeFileSync,existsSync,rmdirSync}=await import('node:fs');
        const root=${JSON.stringify(root)},observed=${JSON.stringify(observed)};
        const reservation=Bun.listen({hostname:'127.0.0.1',port:0,socket:{data(){}}});
        process.env.INTERCEPTOR_WS_PORT=String(reservation.port);reservation.stop(true);
        process.env.INTERCEPTOR_TEMP=root;
        Object.defineProperty(process,'execPath',{value:root+'/bin/interceptor'});
        process.exit=(code)=>{throw Error('Isolated CLI exit '+code)};
        process.chdir(${JSON.stringify(caller)});
        try{
          const {ensureDaemon}=await import(${JSON.stringify(new URL('../cli/daemon-spawn.ts',import.meta.url).pathname)});
          await ensureDaemon();
          const state=JSON.parse(readFileSync(observed,'utf8'));
          if(state.cwd!==${JSON.stringify(root)})throw Error('Daemon inherited caller cwd: '+state.cwd);
          process.chdir(root);rmdirSync(${JSON.stringify(caller)});
          await ensureDaemon();
          writeFileSync(${JSON.stringify(result)},JSON.stringify({...state,callerAbsent:!existsSync(${JSON.stringify(caller)})}));
        }catch(error){
          console.error({error:String(error),observed:existsSync(observed)?readFileSync(observed,'utf8'):null,
            socket:(await import(${JSON.stringify(new URL('../shared/platform.ts',import.meta.url).pathname)})).SOCKET_PATH});throw error;
        }finally{
          if(existsSync(observed)){const {pid}=JSON.parse(readFileSync(observed,'utf8'));process.kill(pid,'SIGTERM');
            for(let i=0;i<100;i++){try{process.kill(pid,0)}catch{break}await Bun.sleep(20)}
            try{process.kill(pid,0);throw Error('Owned daemon remains')}catch(e){if(e.code!=='ESRCH')throw e}}
        }
      `
      const child = captureShell(process.execPath, ['-e',script], {timeout:10000})
      expect(child.status, child.stderr).toBe(0)
      const state = JSON.parse(readFileSync(result,'utf8'))
      expect(state.cwd).toBe(root)
      expect(state.callerAbsent).toBe(true)
    } finally { rmSync(root,{recursive:true,force:true}) }
  }, 15000)

  test("finds the pkg-installed daemon for installed macOS CLI cold-starts", () => {
    const found = findDaemonBinary({
      platform: "darwin",
      execPath: "/usr/local/bin/interceptor",
      cwd: "/tmp/interceptor-user-home",
      exists: (path) => path === MACOS_PKG_DAEMON_PATH,
    })

    expect(found).toBe(MACOS_PKG_DAEMON_PATH)
  })

  test("prefers repository daemon before macOS package fallback", () => {
    const repoRoot = "/workspace/interceptor"
    const repoDaemon = `${repoRoot}/daemon/interceptor-daemon`
    const found = findDaemonBinary({
      platform: "darwin",
      execPath: `${repoRoot}/dist/interceptor`,
      cwd: repoRoot,
      exists: (path) => path === repoDaemon || path === MACOS_PKG_DAEMON_PATH,
    })

    expect(found).toBe(repoDaemon)
  })

  test("keeps Windows candidates on exe daemon names without macOS fallback", () => {
    const candidates = daemonBinaryCandidates({
      platform: "win32",
      execPath: "/Program Files/Interceptor/interceptor.exe",
      cwd: "/work/interceptor",
    })

    expect(candidates.some((path) => path.endsWith("interceptor-daemon.exe"))).toBe(true)
    expect(candidates).not.toContain(MACOS_PKG_DAEMON_PATH)
  })

  test("missing-daemon message names package path without launchctl remediation", () => {
    const message = formatMissingDaemonBinaryError([
      "/usr/local/bin/interceptor-daemon",
      MACOS_PKG_DAEMON_PATH,
    ], "darwin")

    expect(message).toContain(MACOS_PKG_DAEMON_PATH)
    expect(message).toContain("browser daemon binary")
    expect(message).not.toContain("launchctl")
    expect(message).not.toContain("LaunchAgent")
  })

  test("missing-daemon message keeps macOS package guidance out of Windows output", () => {
    const message = formatMissingDaemonBinaryError([
      "C:\\Program Files\\Interceptor\\interceptor-daemon.exe",
    ], "win32")

    expect(message).not.toContain(MACOS_PKG_DAEMON_PATH)
    expect(message).not.toContain("browser daemon binary")
  })
})
