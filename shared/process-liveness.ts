export type KillProbe = (pid: number, signal: 0) => void

export function isProcessAlive(
  pid: number,
  killProbe: KillProbe = process.kill.bind(process),
): boolean {
  try {
    killProbe(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
  }
}
