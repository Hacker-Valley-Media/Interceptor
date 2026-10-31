/**
 * shared/user-config.ts — the person's own Interceptor settings file
 * (`~/.interceptor/config.json`, or $INTERCEPTOR_CONFIG). Today it holds one
 * value: the default browser context they named with
 * `interceptor contexts default <name>`. Interceptor
 * never picks a default itself.
 */
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"

export type UserConfig = { defaultContext?: string; [key: string]: unknown }

export function userConfigPath(env: Record<string, string | undefined> = process.env): string {
  return env.INTERCEPTOR_CONFIG || join(homedir(), ".interceptor", "config.json")
}

export function readUserConfig(path = userConfigPath()): UserConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UserConfig : {}
  } catch {
    return {}
  }
}

/** Atomic write; other keys in the file are kept. */
export function writeUserConfig(config: UserConfig, path = userConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readDefaultContext(path = userConfigPath()): string | undefined {
  const value = readUserConfig(path).defaultContext
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function setDefaultContext(name: string | undefined, path = userConfigPath()): void {
  const config = readUserConfig(path)
  if (name) config.defaultContext = name
  else delete config.defaultContext
  writeUserConfig(config, path)
}
