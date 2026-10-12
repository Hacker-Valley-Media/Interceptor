import{expect,test}from'bun:test'
import{parseMacosCommand}from'../cli/commands/macos'
import{desktopAction}from'../shared/desktop-contract'
import{desktopMusicActionError,desktopMusicResultError}from'../shared/desktop-music-validation'
import{classify}from'../cli/mcp/tiers'
import{pickTimeoutForAction}from'../cli/transport'
test('Music parser preserves numeric values and rejects misplaced fields',()=>{
  for(const desktop of [false,true]){
    const parse=(...args:string[])=>desktopAction(parseMacosCommand(['macos','music',...args],undefined,desktop)!)
    expect(parse('library','--kind','album','--limit','3','--offset','2','--include-tracks')).toMatchObject({kind:'album',limit:3,offset:2,include_tracks:true})
    expect(parse('library','--type','song')).toMatchObject({kind:'song'})
    expect(()=>parse('library','--kind','song','--type','album')).toThrow()
    expect(parse('seek','--time','1.5').time).toBe(1.5)
    expect(parse('play','--album','actual-id').album).toBe('actual-id')
    for(const args of [[],['library','--limit','0'],['library','--limit','101'],['library','--limit','NaN'],['library','--sort','name'],['library','--include-tracks'],['library','--limit','1','--limit','2'],['seek','--time','Infinity'],['play','--song','x','--playlist','y'],['pause','--song','x'],['library-search'],['library-search','x','--types','unknown'],['repeat','unknown']])expect(()=>parse(...args)).toThrow()
  }
  expect(desktopMusicActionError({type:'desktop_music',sub:'seek',time:true})).toBeDefined()
  for(const type of ['macos_music','desktop_music'])expect(pickTimeoutForAction({type,sub:'library'})).toBeGreaterThanOrEqual(40000)
  for(const surface of ['macos','local','desktop']as const){for(const verb of ['status','subscription','library','library-search','queue','now-playing'])expect(classify(surface,'music',[verb]).tier).toBe('read');for(const verb of ['request','play','pause','resume','stop','next','previous','seek','repeat','shuffle'])expect(classify(surface,'music',[verb]).tier).toBe('mutate')}
})
test('Music replies retain native identity and do not turn rejection into success',()=>{
  const item={id:'actual-id',title:'actual title'},a={type:'desktop_music',sub:'library',limit:1}
  expect(desktopMusicResultError(a,{items:[item]})).toBeUndefined()
  for(const data of [{items:[item,item]},{items:[{id:'',title:'x'}]},{items:[{...item,tracks:[{id:'',title:'x'}]}]},{items:[{...item,title:'x\0'}]},{items:[{...item,extra:true}]}])expect(desktopMusicResultError(a,data)).toBeDefined()
  expect(desktopMusicResultError({type:'desktop_music',sub:'pause'},{ok:false})).toBeDefined()
  expect(desktopMusicResultError(a,{available:false,note:'actual backend absent'})).toBeUndefined()
  expect(desktopMusicResultError(a,{available:true})).toBeDefined()
  const search={type:'desktop_music',sub:'library-search',term:'x',limit:1},data={term:'x',songs:[item],albums:[],artists:[],playlists:[],topResults:[item]}
  expect(desktopMusicResultError(search,data)).toBeUndefined()
  expect(desktopMusicResultError(search,{...data,term:'other'})).toBeDefined()
  expect(desktopMusicResultError(search,{...data,topResults:[item,item]})).toBeDefined()
  expect(desktopMusicResultError({type:'desktop_music',sub:'queue'},{entries:[item],count:0})).toBeDefined()
})
test('Music system observations and unavailable measurements stay explicit',()=>{
  const action={type:'desktop_music',sub:'now-playing'},data={status:'stopped',playbackRate:null,playbackTime:null,repeatMode:'off',shuffleMode:'off',queueLength:0,system:{running:false}}
  expect(desktopMusicResultError(action,data)).toBeUndefined()
  for(const system of [{running:false,status:'playing'},{running:true},{running:true,status:'playing',playbackTime:-1},{running:true,status:'playing',currentEntry:{id:'',title:'x'}}])expect(desktopMusicResultError(action,{...data,system})).toBeDefined()
  let nested:any={id:'actual',title:'actual'};for(let i=0;i<20;i++)nested={id:'actual',title:'actual',tracks:[nested]}
  expect(desktopMusicResultError({type:'desktop_music',sub:'library'},{items:[nested]})).toBeDefined()
})
