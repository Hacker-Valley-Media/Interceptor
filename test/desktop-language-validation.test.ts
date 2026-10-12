import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {buildFilteredArgs} from '../cli/global-flags'
import {desktopAction} from '../shared/desktop-contract'
import {desktopLanguageActionError,desktopLanguageResultError} from '../shared/desktop-language-validation'
import {pickTimeoutForAction,setGlobalGroup,withGroup} from '../cli/transport'

test('language commands retain JSON payloads, reject invalid inputs and accept only the requested reply',()=>{
  const calls=[
    {argv:['nlp','entities','Ada Lovelace'],data:[{text:'Ada Lovelace',type:'PersonalName'}]},
    {argv:['nlp','language','Hello'],data:{dominant:'en',hypotheses:[{language:'en',confidence:1}]}},
    {argv:['nlp','sentiment','Good'],data:{score:0.8,label:'positive'}},
    {argv:['nlp','tokens','café, 世界!'],data:['café','世','界']},
    {argv:['nlp','embed','hello'],data:{vector:[0.6,0.8],dimensions:2}},
    {argv:['nlp','similar','hello','world'],data:{distance:1,word1:'hello',word2:'world'}},
    {argv:['ai'],data:{available:false,framework:'llama.cpp',reason:'not configured'}},
    {argv:['ai','prompt','Hello'],data:'Hello there'},
    {argv:['ai','session','start'],data:{sessionActive:true}},
    {argv:['ai','session','send','Hello'],data:{response:'Hello there'}},
    {argv:['ai','session','history'],data:[{role:'user',content:'Hello'},{role:'assistant',content:'Hello there'}]},
    {argv:['ai','session','end'],data:{sessionEnded:true,turns:2}},
    {argv:['translate','status'],data:{available:false,framework:'llama.cpp',reason:'not configured'}},
    {argv:['translate','languages'],data:{supported:[{languageCode:'en',region:''},{languageCode:'es',region:''}]}},
    {argv:['translate','availability','--from','en','--to','es'],data:{from:'en',to:'es',status:'installed'}},
    {argv:['translate','prepare','--from','en','--to','es'],data:{from:'en',to:'es',ready:true}},
    {argv:['translate','text','Hello','--to','es'],data:{sourceText:'Hello',sourceLanguage:null,targetLanguage:'es',targetText:'Hola',isReady:true}},
    {argv:['translate','batch','--to','es','--json','["Hello","World"]'],data:{from:'auto',to:'es',translations:[{sourceText:'Hello',targetText:'Hola',ok:true},{sourceText:'World',targetText:null,ok:false,error:'deadline exceeded'}]}},
    {argv:['translate','file','/tmp/owned-language.txt','--to','es'],data:{sourceText:'Hello',sourceLanguage:null,targetLanguage:'es',targetText:'Hola',isReady:true}},
    {argv:['translate','stop'],data:{ok:true,note:'stateless'}},
    {argv:['detect','types'],data:{types:['link','phoneNumber','calendarEvent','postalAddress','email','transit','moneyAmount','flightNumber','shipmentTrackingNumber','measurement','paymentIdentifier']}},
    {argv:['detect','run','https://example.com','--types','url'],data:{input:'https://example.com',matches:[{range:[0,19],value:'https://example.com',type:'link',components:{url:'https://example.com'}}]}},
    {argv:['detect','file','/tmp/owned-language.txt','--types','moneyAmount'],data:{input:'$42.50',matches:[{range:[0,6],value:'$42.50',type:'moneyAmount',components:{currency:'USD',amount:'42.5'}}]}},
    {argv:['detect','run','✈️ AA123','--types','flightNumber'],data:{input:'✈️ AA123',matches:[{range:[3,5],value:'AA123',type:'flightNumber',components:{airlineCode:'AA',flightNumber:123}}]}},
    {argv:['detect','run','UPS 1Z999AA10123456784','--types','shipmentTrackingNumber'],data:{input:'UPS 1Z999AA10123456784',matches:[{range:[0,22],value:'UPS 1Z999AA10123456784',type:'shipmentTrackingNumber',components:{carrier:'UPS',trackingNumber:'1Z999AA10123456784'}}]}},
    {argv:['detect','run','20 kg','--types','measurement'],data:{input:'20 kg',matches:[{range:[0,5],value:'20 kg',type:'measurement',components:{value:20,units:['kg']}}]}},
    {argv:['detect','run','person@upi','--types','paymentIdentifier'],data:{input:'person@upi',matches:[{range:[0,10],value:'person@upi',type:'paymentIdentifier',components:{identifier:'person@upi',paymentSystem:'unifiedPaymentsInterface'}}]}},
  ]
  for(const row of calls){
    const argv=buildFilteredArgs(['--json','desktop',...row.argv])
    expect(argv[0]).toBe('desktop')
    const action=desktopAction(parseMacosCommand(['macos',...argv.slice(1)],undefined,true)!)
    expect(desktopLanguageActionError(action)).toBeUndefined()
    expect(desktopLanguageResultError(action,row.data)).toBeUndefined()
    expect(desktopLanguageResultError(action,{unexpected:'reply'})).toBeDefined()
    expect(pickTimeoutForAction(action)).toBeGreaterThanOrEqual(125_000)
    setGlobalGroup('owned-language-validation','cyan',true)
    expect(desktopLanguageActionError(withGroup(action))).toBeUndefined()
    setGlobalGroup()
  }
  for(const argv of [
    ['nlp','tokens',''],['nlp','similar','one'],['nlp','language','x','extra'],
    ['ai','session','history','extra'],['ai','prompt','x','--unknown','v'],
    ['translate','text','x','--to','es','--to','en'],['translate','batch','--to','es','--json','["x",1]'],
    ['translate','availability','--to','es'],['translate','status','--to','es'],
    ['detect','run','x','--types','unknown'],['detect','run','x','--types','phone,'],['detect','types','--types','all'],
  ])expect(()=>parseMacosCommand(['macos',...argv],undefined,true)).toThrow()
  for(const action of [
    {type:'desktop_nlp',sub:'tokens',text:null},{type:'desktop_nlp',sub:'tokens',text:'x'.repeat(65537)},
    {type:'desktop_ai',sub:'status',prompt:'leak'},{type:'desktop_ai',sub:'session',op:'history',message:'x'},
    {type:'desktop_translate',sub:'file',path:'relative',to:'es'},
    {type:'desktop_translate',sub:'text',input:'x',to:'es;exec'},
  ])expect(desktopLanguageActionError(action)).toBeDefined()
  expect(desktopLanguageResultError({type:'desktop_nlp',sub:'embed',text:'x'},{vector:[NaN],dimensions:1})).toBeDefined()
  expect(desktopLanguageResultError({type:'desktop_nlp',sub:'entities',text:'Ada'},[{text:'invented',type:'PersonalName'}])).toBeDefined()
  expect(desktopLanguageResultError({type:'desktop_ai',sub:'session',op:'history'},[{role:'assistant',content:'wrong ordering'}])).toBeDefined()
  const detection={type:'desktop_detect',sub:'run',input:'$42.50',types:'moneyAmount'}
  for(const components of [{currency:'USD',amount:42.5},{currency:'$',amount:'42.5'},{currency:'USD',amount:'NaN'},{currency:'USD',amount:'42.5',extra:'x'}])expect(desktopLanguageResultError(detection,{input:'$42.50',matches:[{range:[0,6],value:'$42.50',type:'moneyAmount',components}]})).toBeDefined()
  expect(desktopLanguageResultError({type:'desktop_detect',sub:'run',input:'20 kg',types:'measurement'},{input:'20 kg',matches:[{range:[0,5],value:'20 kg',type:'measurement',components:{value:20,units:'kg'}}]})).toBeDefined()
})
