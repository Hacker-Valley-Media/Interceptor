import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
const installer=resolve(import.meta.dir,'../scripts/install-desktop-linux.sh')
test.skipIf(process.platform!=='linux')('Linux installer preserves foreign GeoClue identity and dangling linked receipts',()=>{
  const home=mkdtempSync(join(tmpdir(),'interceptor-location-install-'))
  try{
    const dest=join(home,'.local/share/interceptor'),apps=join(home,'.local/share/applications')
    mkdirSync(dest,{recursive:true});mkdirSync(apps,{recursive:true})
    const identity=join(apps,'com.interceptor.desktop.desktop'),content='[Desktop Entry]\nName=Unrelated application\n'
    writeFileSync(identity,content)
    const run=()=>spawnSync('bash',[installer,'--check'],{encoding:'utf8',env:{...process.env,HOME:home,XDG_DATA_HOME:join(home,'.local/share'),XDG_CONFIG_HOME:join(home,'.config')}})
    const refusal=process.getuid?.()===0?'Install the native provider as the interactive user':'Refusing foreign GeoClue'
    let result=run();expect(result.status).not.toBe(0);expect(result.stderr).toContain(refusal);expect(readFileSync(identity,'utf8')).toBe(content)
    symlinkSync(join(home,'missing-receipt'),join(dest,'location-identity.sha256'))
    result=run();expect(result.status).not.toBe(0);expect(result.stderr).toContain(refusal);expect(readFileSync(identity,'utf8')).toBe(content)
  }finally{rmSync(home,{recursive:true,force:true})}
})
