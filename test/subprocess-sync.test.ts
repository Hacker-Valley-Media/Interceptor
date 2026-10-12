import {expect,test} from 'bun:test'
import {captureSubprocessSync} from '../shared/subprocess-sync'

test('owned synchronous capture retains binary stdin and stdout without text conversion',()=>{
  const input=Buffer.from([0,255,128,10,65])
  const child=captureSubprocessSync(process.execPath,['-e','process.stdout.write(require("node:fs").readFileSync(0))'],{input,timeout:5000})
  expect(child.status).toBe(0)
  expect(child.error).toBeUndefined()
  expect(child.stdout).toEqual(input)
  expect(child.stderr).toEqual(Buffer.alloc(0))
})

test('owned synchronous capture preserves exit status and literal arguments',()=>{
  const literal='spaces "quotes" $HOME $(printf unintended) `printf unintended` Unicode 验证'
  const child=captureSubprocessSync(process.execPath,['-e','process.stdout.write(process.argv.at(-1));process.stderr.write("observed error");process.exit(7)','--',literal],{encoding:'utf8',timeout:5000})
  expect(child.status).toBe(7)
  expect(child.stdout).toBe(literal)
  expect(child.stderr).toBe('observed error')
})

test('owned synchronous capture reports timeout and refuses oversized output',()=>{
  const timed=captureSubprocessSync(process.execPath,['-e','await Bun.sleep(10000)'],{timeout:100})
  expect(timed.status).toBeNull()
  expect(timed.error).toBeDefined()
  const oversized=captureSubprocessSync(process.execPath,['-e','process.stdout.write("x".repeat(100))'],{timeout:5000,maxBuffer:8})
  expect(oversized.status).toBeNull()
  expect((oversized.error as NodeJS.ErrnoException).code).toBe('ENOBUFS')
})
