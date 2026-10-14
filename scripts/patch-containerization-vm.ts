import {constants,lstatSync,readFileSync,realpathSync,renameSync,writeFileSync,openSync,closeSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,sep} from "node:path";

// Source patch for the exact pinned SDK, applied before bridge compilation.
// An unrelated dependency revision or any third-party source edit is refused.
const revision="f1ee6f8b737ab8dffbd620bfa47283f6f0bc1822";
const before="5431b17f2aaa2150963d5222d5fc5f3479a431c985523b2ecaf75603261f2d54",after="3070d60db5867e77ed1c3130f211261091e2a5edd3435ea358d7f0b0113bd657";
const edits:[string,string][]=[
  [
    "handles[1]?.readabilityHandler = nil\n                        cc.yield()",
    "handles[1]?.readabilityHandler = nil\n                        try stdout.writer.close()\n                        cc.yield()"
  ],
  [
    "handles[2]?.readabilityHandler = nil\n                        cc.yield()",
    "handles[2]?.readabilityHandler = nil\n                        try stderr.writer.close()\n                        cc.yield()"
  ],
  [
    "            await self.waitIoComplete()",
    "            try await self.waitIoComplete()"
  ],
  [
    "    private func waitIoComplete() async {",
    "    private func waitIoComplete() async throws {"
  ],
  [
    "                }\n            }\n        } catch {\n            self.logger?.error(\"timeout waiting for IO to complete for process \\(id): \\(error)\")\n        }\n        self.state.withLock {\n            $0.ioTracker = nil",
    "                }\n                guard counter == 0 else {\n                    throw ContainerizationError(.internalError, message: \"guest output streams closed before every EOF was received\")\n                }\n            }\n        } catch {\n            self.logger?.error(\"timeout waiting for IO to complete for process \\(id): \\(error)\")\n            throw error\n        }\n        self.state.withLock {\n            $0.ioTracker = nil"
  ]
];
const root=realpathSync(resolve(import.meta.dir,"../interceptor-bridge"));
const checkout=resolve(root,".build/checkouts/containerization");
const target=resolve(checkout,"Sources/Containerization/LinuxProcess.swift");
if(process.argv.slice(2).some(a=>a!=="--check"))throw Error("only --check is accepted");
const check=process.argv.includes("--check");
const resolved=JSON.parse(readFileSync(resolve(root,"Package.resolved"),"utf8"));
const pin=resolved.pins?.find((p:{identity:string})=>p.identity==="containerization");
if(pin?.state?.version!=="0.31.0"||pin.state.revision!==revision)throw Error("Containerization pin differs");
if(lstatSync(checkout).isSymbolicLink()||realpathSync(checkout)!==checkout||!checkout.startsWith(root+sep))throw Error("SDK checkout must be inside this bridge workspace");
const info=lstatSync(target);
if(!info.isFile()||info.isSymbolicLink()||info.size>131072||realpathSync(target)!==target)throw Error("invalid SDK source file");
const git=Bun.spawnSync(["git","-C",checkout,"rev-parse","HEAD"],{stdout:"pipe",stderr:"pipe"});
if(git.exitCode!==0||git.stdout.toString().trim()!==revision)throw Error("SDK checkout revision differs");
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
const descriptor=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);
let source:string;
try{source=readFileSync(descriptor,"utf8");}finally{closeSync(descriptor);}
const observed=digest(source);
if(observed===after){console.log(JSON.stringify({sdk:"containerization",revision,sourceHash:after,patchApplied:true,changed:false}));}
else {
if(observed!==before)throw Error("SDK source differs from both exact admitted hashes; existing edits preserved");
if(check)throw Error("Containerization VM output patch has not been applied");
for(const[from,to]of edits){if(source.split(from).length!==2)throw Error("SDK patch anchor differs");source=source.replace(from,to);}
if(digest(source)!==after)throw Error("SDK patch output hash differs");
const temporary=target+".interceptor-vm-"+crypto.randomUUID();
writeFileSync(temporary,source,{encoding:"utf8",flag:"wx",mode:info.mode&0o777});
renameSync(temporary,target);
if(digest(readFileSync(target,"utf8"))!==after)throw Error("SDK patch source readback differs");
console.log(JSON.stringify({sdk:"containerization",revision,sourceHash:after,patchApplied:true,changed:true}));
}
