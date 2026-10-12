import {type SpawnSyncOptions} from 'node:child_process'
import {captureSubprocessSync} from '../../shared/subprocess-sync'

// Bun's macOS test runner can fail when posix_spawn remaps output descriptors.
// Let the child shell open its own files, preserving real output and status.
export function captureShell(command:string,args:string[],options:Pick<SpawnSyncOptions,'cwd'|'env'|'timeout'|'input'>={}){
  return captureSubprocessSync(command,args,{...options,encoding:'utf8'})
}
