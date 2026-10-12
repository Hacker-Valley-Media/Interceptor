import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopThumbnailActionError,desktopThumbnailResultError} from '../shared/desktop-thumbnail-validation'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {classify,gate,parseAllow} from '../cli/mcp/tiers'
import {toResult} from '../cli/mcp/output'

const path=process.platform==='win32'?'C:\\owned\\文件.png':'/owned/文件.png'
const action={type:'desktop_thumbnail',sub:'generate',path,size:'100x80',scale:2}
const bytes=Buffer.from([137,80,78,71,13,10,26,10])
const data={path,type:'thumbnail',width:64,height:64,scale:2,format:'png',bytes:bytes.length,dataUrl:`data:image/png;base64,${bytes.toString('base64')}`}

test('thumbnail requests reject malformed sizes, excessive work and ambiguous saves',()=>{
  expect(desktopThumbnailActionError(action)).toBeUndefined()
  for(const fields of [{path:'relative.png'},{size:'0'},{size:'1.5'},{size:'10x'},{size:'9999',scale:8},{scale:1.5},{scale:9},{scale:null},{format:'gif'},{types:'unknown'},{save:true,out:path,paths:[path]},{out:path},{extra:true}])expect(desktopThumbnailActionError({...action,...fields})).toBeString()
  const batch={type:'desktop_thumbnail',sub:'batch',paths:[path]}
  expect(desktopThumbnailActionError(batch)).toBeUndefined()
  for(const fields of [{paths:[]},{paths:Array(33).fill(path)},{paths:[null]},{path},{save:true,out:path}])expect(desktopThumbnailActionError({...batch,...fields})).toBeString()
})
test('neutral thumbnail CLI enforces one path, strict flags and integer scale',()=>{
  expect(parseMacosCommand(['macos','thumbnail',path,'--size','100x80','--scale','2'],undefined,true)).toEqual({...action,type:'macos_thumbnail'})
  expect(parseMacosCommand(['macos','thumbnail','batch',path,path],undefined,true)?.paths).toEqual([path,path])
  for(const args of [[],['generate',path],[path,path],[path,'--unknown'],[path,'--size'],[path,'--size','64','--size','32'],[path,'--scale','1.5'],[path,'--save','--save'],[path,'--out',path],['batch',path,'--save','--out',path]])expect(()=>parseMacosCommand(['macos','thumbnail',...args],undefined,true)).toThrow()
  expect(parseMacosCommand(['macos','thumbnail','relative.png','--scale','1.5'])?.path).toBe('relative.png')
})
test('thumbnail result validation rejects byte mismatches, oversized metadata and wrong output modes',()=>{
  expect(desktopContractShapeError(data,'DesktopThumbnailData')).toBeUndefined()
  expect(desktopThumbnailResultError(action,data)).toBeUndefined()
  for(const r of [null,{...data,path:path+'wrong'},{...data,width:201},{...data,width:0},{...data,scale:1},{...data,bytes:9},{...data,dataUrl:data.dataUrl+'!'},{...data,filePath:path},{...data,extra:true}])expect(desktopThumbnailResultError(action,r)).toBeString()
  const {dataUrl,...metadata}=data
  expect(desktopThumbnailResultError({...action,save:true},{...metadata,filePath:path})).toBeUndefined()
  expect(desktopThumbnailResultError({...action,save:true},{...metadata,filePath:'relative.png'})).toBeString()
})
test('thumbnail batch results retain ordered typed failures and verify every successful image',()=>{
  const batch={type:'desktop_thumbnail',sub:'batch',paths:[path,path+'missing'],size:'100x80',scale:2}
  const rows=[{path,ok:true,result:{success:true,data}},{path:path+'missing',ok:false,result:{success:false,code:'target_gone',error:'missing'}}]
  expect(desktopThumbnailResultError(batch,{results:rows})).toBeUndefined()
  for(const results of [rows.slice(0,1),rows.toReversed(),[{...rows[0],ok:false},rows[1]],[rows[0],{...rows[1],result:{success:false,error:'missing'}}]])expect(desktopThumbnailResultError(batch,{results})).toBeString()
})
test('MCP thumbnail saves require operator allowance and confirmation on both desktop surfaces',async()=>{
  for(const surface of ['macos','desktop'] as const){
    expect(classify(surface,'thumbnail',[path]).tier).toBe('read')
    for(const args of [[path,'--save'],['batch',path,'--save'],[path,'--out='+path]]){
      const call=classify(surface,'thumbnail',args)
      expect(call.tier).toBe('destructive')
      expect(gate(call,parseAllow(undefined),true).allowed).toBe(false)
      expect(gate(call,parseAllow(surface+':thumbnail'),false).allowed).toBe(false)
      expect(gate(call,parseAllow(surface+':thumbnail'),true).allowed).toBe(true)
    }
  }
  const mcp=await toResult({surface:'desktop',verb:'thumbnail',run:{stdout:JSON.stringify(data),stderr:'',code:0},fenceEnabled:true})
  expect(mcp.structuredContent).toEqual(data)
  expect(mcp.content[0]).toEqual({type:'image',data:bytes.toString('base64'),mimeType:'image/png'})
  const failed=await toResult({surface:'desktop',verb:'thumbnail',run:{stdout:JSON.stringify({success:false,code:'target_gone',error:'captured file name'}),stderr:'',code:1},fenceEnabled:true})
  expect((failed.content[0] as {text:string}).text).toContain('UNTRUSTED')
})
