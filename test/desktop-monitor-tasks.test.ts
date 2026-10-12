import {expect,test} from 'bun:test'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {createMonitorTask,attachMonitorTaskSource,stopMonitorTask,synthesizeMonitorTaskTranscript,
  generateMonitorTaskCaptureQuality,readMonitorTaskTranscript,getMonitorTaskSourceSnapshotDir} from '../shared/monitor-tasks'
import {writeSessionMeta,appendSessionEvent,getSessionDir} from '../shared/monitor-artifacts'

test('desktop sources keep their host through durable task snapshots and cannot grade missing sources as complete',()=>{
  const taskRoot=mkdtempSync(join(tmpdir(),'desktop-task-')),previous=process.env.INTERCEPTOR_TASKS_DIR
  const sids:string[]=[]
  process.env.INTERCEPTOR_TASKS_DIR=taskRoot
  try{
    for(const host of ['win32','linux'] as const){
      const sid='owned-desktop-'+randomUUID();sids.push(sid)
      writeSessionMeta({artifactVersion:1,surface:'desktop',host,sessionId:sid,startedAt:1000,endedAt:1200,
        status:'stopped',paused:true,attachments:[],counts:{evt:3,mut:0,net:0,nav:0,ax:0},partial:true,
        coverage:[{source:'lifecycle',available:true},{source:'input',available:false,reason:'unqualified native source'}]})
      for(const [s,event,t]of [[0,'mon_start',1000],[1,'file_change',1100],[2,'mon_stop',1200]] as const){
        appendSessionEvent(sid,{sid,s,event,t,surface:'desktop',path:'/owned/recording-fixture'})
      }
      const task=createMonitorTask({instruction:'Owned desktop task fixture',createdBy:'desktop-monitor'})
      const binding=attachMonitorTaskSource(task.taskId,sid)
      expect(binding.source.surface).toBe('desktop');expect(binding.source.host).toBe(host)
      stopMonitorTask(task.taskId);synthesizeMonitorTaskTranscript(task.taskId)
      const snapshot=JSON.parse(readFileSync(join(getMonitorTaskSourceSnapshotDir(task.taskId,sid),'session.json'),'utf8'))
      expect(snapshot.surface).toBe('desktop');expect(snapshot.host).toBe(host)
      expect(readMonitorTaskTranscript(task.taskId).flatMap(row=>row.sourceRefs).every(ref=>ref.surface==='desktop')).toBe(true)
      const report=generateMonitorTaskCaptureQuality(task.taskId)
      expect(report.status).not.toBe('excellent')
      expect(report.findings.some(row=>row.code==='desktop_recording_coverage_incomplete')).toBe(true)
    }
  }finally{
    for(const sid of sids)rmSync(getSessionDir(sid),{recursive:true,force:true})
    rmSync(taskRoot,{recursive:true,force:true})
    if(previous===undefined)delete process.env.INTERCEPTOR_TASKS_DIR;else process.env.INTERCEPTOR_TASKS_DIR=previous
  }
})
