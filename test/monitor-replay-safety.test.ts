import {test,expect} from 'bun:test'
import {mkdirSync,rmSync,writeFileSync} from 'node:fs'
import {captureShell} from './helpers/shell-capture'
import {appendSessionEvent,appendSessionNetArtifact,getSessionDir} from '../shared/monitor-artifacts'
import type {MonitorEvent} from '../shared/monitor-artifacts'
const {buildPlan}=await import(process.env.REPLAY_SAFETY_SOURCE || '../cli/commands/monitor')

test('replay exports preserve literal arguments and keep captured text inside comments',()=>{
  const sid='replay-shell-fixture',dir=getSessionDir(sid)
  mkdirSync(dir,{recursive:true})
  const payload='$(printf EXPANDED)`printf EXPANDED`$REPLAY_SAFETY_VAR "quote" \\ apostrophe\' 文件\nsecond line'
  const reference='e1; printf REF_EXECUTED; #'
  const comment='caption\nprintf COMMENT_EXECUTED\r\ntrailer'
  try{
    for(const event of [
      {event:'mon_start',url:payload,ins:comment},
      {event:'click',r:'button',n:payload},
      {event:'input',r:'textbox',n:payload,v:payload},
      {event:'key',kc:payload},
      {event:'click',ref:reference},
      {event:'input',ref:reference,v:payload},
      {event:'input',r:'textbox',n:comment,v:'***SECURE***'},
      {event:'submit',ref:comment},
      {event:'fetch',cause:4,u:comment},
      {event:'fetch',u:comment},
      {event:'mon_attach',reason:'focus_switch',tid:'1; printf TAB_EXECUTED; #'},
      {event:'key',kc:'Enter'},
      {event:'nav',typ:'soft',u:comment},
      {event:'nav',typ:'hard',u:payload},
      {event:'mon_attach',reason:'child_tab',u:payload},
    ])appendSessionEvent(sid,{sid,...event} as unknown as MonitorEvent)
    appendSessionNetArtifact(sid,{sid,kind:'fetch',cause:4,url:comment,contentType:comment,bodyPreview:comment})
    const expected=[['tab','new',payload],['wait-stable'],['click','button:'+payload],['type','textbox:'+payload,payload],['keys',payload],['click',reference],['type',reference,payload],['keys','Enter'],['navigate',payload],['wait-stable'],['tab','new',payload],['wait-stable']]
    const results=[]
    for(const bodies of [false,true]){
      const plan=buildPlan(sid,false,bodies)
      for(const shell of ['/bin/sh','/bin/bash','/bin/zsh']){
        const child=captureShell(shell,['-f','-c','interceptor() { printf "%s\\0" "$@"; printf "\\1"; }\n'+plan],{env:{...process.env,REPLAY_SAFETY_VAR:'EXPANDED'},timeout:5000})
        const rows=child.stdout.split('\x01').filter(Boolean).map(row=>row.split('\0').slice(0,-1))
        results.push({bodies,shell,exitCode:child.status,rows,stderr:child.stderr,plan,expected})
      }
    }
    if(process.env.REPLAY_SAFETY_EVIDENCE_DIR)writeFileSync(process.env.REPLAY_SAFETY_EVIDENCE_DIR+'/browser-shell-checks.json',JSON.stringify(results,null,2)+'\n')
    for(const result of results){expect(result.exitCode).toBe(0);expect(result.rows).toEqual(expected)}
  }finally{rmSync(dir,{recursive:true,force:true})}
})
