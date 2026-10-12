import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { desktopProviderBinary } from '../shared/desktop-provider'

test('an explicit missing provider never falls back to another installed binary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-path-'))
  const previousLocal = process.env.LOCALAPPDATA
  const previousProvider = process.env.INTERCEPTOR_DESKTOP_PROVIDER
  try {
    const fallback = join(directory, 'Programs', 'Interceptor')
    mkdirSync(fallback, { recursive: true })
    const binary = join(fallback, process.platform === 'win32' ? 'interceptor-desktop.exe' : 'interceptor-desktop')
    writeFileSync(binary, '')
    process.env.LOCALAPPDATA = directory
    process.env.INTERCEPTOR_DESKTOP_PROVIDER = join(directory, 'missing')
    expect(desktopProviderBinary()).toBeUndefined()
    process.env.INTERCEPTOR_DESKTOP_PROVIDER = binary
    expect(desktopProviderBinary()).toBe(binary)
  } finally {
    for (const [key, value] of [['LOCALAPPDATA', previousLocal], ['INTERCEPTOR_DESKTOP_PROVIDER', previousProvider]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unset LOCALAPPDATA or HOME never resolves the provider against the current folder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-provider-cwd-'))
  const name = process.platform === 'win32' ? 'interceptor-desktop.exe' : 'interceptor-desktop'
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME, INTERCEPTOR_DESKTOP_PROVIDER: process.env.INTERCEPTOR_DESKTOP_PROVIDER }
  const cwd = process.cwd()
  try {
    for (const folder of [join('Programs', 'Interceptor'), join('.local', 'share', 'interceptor')]) {
      mkdirSync(join(directory, folder), { recursive: true })
      writeFileSync(join(directory, folder, name), '')
    }
    process.env.LOCALAPPDATA = ''
    process.env.HOME = ''
    delete process.env.INTERCEPTOR_DESKTOP_PROVIDER
    process.chdir(directory)
    const found = desktopProviderBinary()
    if (found !== undefined) {
      expect(isAbsolute(found)).toBe(true)
      expect(found.startsWith(directory)).toBe(false)
    }
  } finally {
    process.chdir(cwd)
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
