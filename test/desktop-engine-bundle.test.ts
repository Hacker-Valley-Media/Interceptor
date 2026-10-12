import{expect,test}from'bun:test'
import{desktopEngineManifest,desktopEngineRelativePath,desktopEngineBinaryIdentity,type DesktopEngineFile}from'../shared/desktop-engine-bundle'
import{version}from'../package.json'
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,symlinkSync,rmSync}from'node:fs'
import{join,resolve}from'node:path'
import{createHash}from'node:crypto'
import{captureShell}from'./helpers/shell-capture'
const identity={host:'linux',architecture:'arm64',providerVersion:version}
const fixture=()=>({schemaVersion:1,...identity,files:[
  {variable:'INTERCEPTOR_TESSERACT_MODEL',path:'models/eng.traineddata',kind:'model',bytes:128,sha256:'a'.repeat(64),component:'owned-fixture',version:'fixture-1',source:'https://github.com/Hacker-Valley-Media/Interceptor',license:'LicenseRef-OwnedFixture',licensePaths:['licenses/fixture.txt'],dependencies:[]},
  {path:'licenses/fixture.txt',kind:'license',bytes:64,sha256:'b'.repeat(64),component:'owned-fixture',version:'fixture-1',source:'https://github.com/Hacker-Valley-Media/Interceptor',license:'LicenseRef-OwnedFixture',licensePaths:[],dependencies:[]}
]})
test('bundled file identity is independent of native runtime qualification',()=>{
  const result=desktopEngineManifest(fixture(),identity)
  expect(result.files[0].variable).toBe('INTERCEPTOR_TESSERACT_MODEL')
  expect('effective'in result).toBe(false)
  for(const fields of [{qualified:true},{nativeRuntimeChecked:true},{effective:true},{host:'win32'},{architecture:'x64'},{providerVersion:'0.0.0'},{files:[]}])expect(()=>desktopEngineManifest({...fixture(),...fields},identity)).toThrow()
})
test('engine bindings reject missing licenses, traversal, aliases, byte budgets and metadata ambiguity',()=>{
  for(const path of ['../other','/models/a','C:/model','models/../model','models//model','models\\model','models/CON','models/com1.dll','models/a.','a/b/c/d/e','a\0b'])expect(desktopEngineRelativePath(path)).toBe(false)
  for(const fields of [{path:'../model'},{variable:null},{variable:'INTERCEPTOR_UNDECLARED'},{bytes:0},{bytes:67108865},{bytes:Infinity},{bytes:1.5},{sha256:'A'.repeat(64)},{source:'http://example.com/a'},{source:'https://user:password@example.com/a'},{source:'https://'},{license:''},{licensePaths:[]},{licensePaths:['models/eng.traineddata']},{licensePaths:['licenses/missing.txt']},{dependencies:['models/eng.traineddata']},{dependencies:['licenses/fixture.txt']},{dependencies:['missing.dll']},{extra:true}]){
    const f=fixture();Object.assign(f.files[0],fields);expect(()=>desktopEngineManifest(f,identity)).toThrow()
  }
  for(const path of ['models/eng.traineddata','MODELS/ENG.TRAINEDDATA']){const f=fixture();f.files.push({...f.files[0],path});expect(()=>desktopEngineManifest(f,identity)).toThrow()}
  // A versioned asset must carry the exact version the spec selects (the llama.cpp build).
  const wrong=fixture();wrong.files[0]={...wrong.files[0],variable:'INTERCEPTOR_LLAMA_SERVER',kind:'executable',version:'b11556'};expect(()=>desktopEngineManifest(wrong,identity)).toThrow()
  const right=fixture();right.files[0]={...right.files[0],variable:'INTERCEPTOR_LLAMA_SERVER',kind:'executable',version:'b11557'};expect(()=>desktopEngineManifest(right,identity)).not.toThrow()
  // The vendor-library entries are gone: the provider runs the models itself.
  for(const variable of ['INTERCEPTOR_VISION_LIBRARY','INTERCEPTOR_TFLITE_LIBRARY','INTERCEPTOR_SAMPLERATE_LIBRARY','INTERCEPTOR_YAMNET_MODEL']){const gone=fixture();gone.files[0]={...gone.files[0],variable};expect(()=>desktopEngineManifest(gone,identity)).toThrow(/undeclared/)}
  for(const variable of ['INTERCEPTOR_VISION_PALM_MODEL','INTERCEPTOR_SOUND_MODEL','INTERCEPTOR_EMBED_MODEL']){const model=fixture();model.files[0]={...model.files[0],variable};expect(()=>desktopEngineManifest(model,identity)).not.toThrow()}
})
test('engine binary headers bind the selected host and architecture',()=>{
  const file={...fixture().files[0],variable:'INTERCEPTOR_WHISPER_CLI',kind:'executable',version:'1.9.5'}as DesktopEngineFile
  const elf=Buffer.alloc(64);Buffer.from('7f454c460201','hex').copy(elf);elf.writeUInt16LE(183,18)
  expect(()=>desktopEngineBinaryIdentity(elf,file,'linux','arm64')).not.toThrow()
  expect(()=>desktopEngineBinaryIdentity(elf,file,'linux','x64')).toThrow()
  expect(()=>desktopEngineBinaryIdentity(elf,file,'win32','arm64')).toThrow()
  const pe=Buffer.alloc(256);pe.writeUInt16LE(0x5a4d,0);pe.writeUInt32LE(128,60);pe.writeUInt32LE(0x4550,128);pe.writeUInt16LE(0x8664,132);pe.writeUInt16LE(0x20b,152)
  expect(()=>desktopEngineBinaryIdentity(pe,file,'win32','x64')).not.toThrow()
  expect(()=>desktopEngineBinaryIdentity(pe,file,'win32','arm64')).toThrow()
  const script=Buffer.from('#!/usr/bin/env perl\n# Owned format fixture\n')
  expect(()=>desktopEngineBinaryIdentity(script,{...file,variable:'INTERCEPTOR_PHOTOS_EXIFTOOL'},'linux','arm64')).not.toThrow()
  expect(()=>desktopEngineBinaryIdentity(script,file,'linux','arm64')).toThrow()
  expect(()=>desktopEngineBinaryIdentity(script,{...file,variable:'INTERCEPTOR_PHOTOS_EXIFTOOL'},'win32','x64')).toThrow()
})

test('engine staging preserves exact local bytes and refuses changed or linked inputs without overwriting prior output',()=>{
  const repo=resolve(import.meta.dir,'..');mkdirSync(join(repo,'.interceptor'),{recursive:true})
  const owned=mkdtempSync(join(repo,'.interceptor','engine-bundle-test-')),source=join(owned,'source'),output=join(owned,'output')
  try{
    mkdirSync(join(source,'models'),{recursive:true,mode:0o700});mkdirSync(join(source,'licenses'),{mode:0o700})
    const model=Buffer.from('Owned fake model bytes. No native model acceptance is claimed.'),license=Buffer.from('Owned engine-bundle test fixture license.\n')
    const f=fixture();for(const [entry,bytes]of [[f.files[0],model],[f.files[1],license]]as const){entry.bytes=bytes.length;entry.sha256=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(source,entry.path),bytes,{mode:0o600})}
    const manifest=Buffer.from(JSON.stringify(f));writeFileSync(join(source,'manifest.json'),manifest,{mode:0o600})
    const run=(...args:string[])=>captureShell(process.execPath,[join(repo,'scripts/stage-desktop-engines.ts'),...args],{cwd:repo,timeout:15000})
    let result=run('--check',source,'linux','arm64');expect(result.status).toBe(0);expect(JSON.parse(result.stdout).nativeRuntimeChecked).toBe(false)
    result=run(source,'linux','arm64',output);expect(result.status).toBe(0)
    expect(readFileSync(join(output,'models/eng.traineddata'))).toEqual(model);expect(readFileSync(join(output,'manifest.json'))).toEqual(manifest)
    expect(readdirSync(output).sort()).toEqual(['licenses','manifest.json','models'])
    result=run(source,'linux','arm64',output);expect(result.status).not.toBe(0);expect(readFileSync(join(output,'models/eng.traineddata'))).toEqual(model)
    writeFileSync(join(source,'models/eng.traineddata'),Buffer.alloc(model.length,42))
    result=run('--check',source,'linux','arm64');expect(result.status).not.toBe(0);expect(result.stderr).toContain('mandatory SHA256')
    expect(readFileSync(join(output,'manifest.json'))).toEqual(manifest)
    if(process.platform!=='win32'){
      rmSync(join(source,'models/eng.traineddata'));symlinkSync(join(source,'licenses/fixture.txt'),join(source,'models/eng.traineddata'))
      result=run('--check',source,'linux','arm64');expect(result.status).not.toBe(0);expect(result.stderr).toContain('linked')
      expect(readFileSync(join(output,'models/eng.traineddata'))).toEqual(model)
    }
  }finally{rmSync(owned,{recursive:true,force:true})}
})
