function buildIsoWithOffset(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function parseDisplayedDateRangeToIso(displayedDateText: string | null): { startTimeIso: string | null; endTimeIso: string | null; timeZone: string | null } {
  if (!displayedDateText) return { startTimeIso: null, endTimeIso: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null }
  const match = displayedDateText.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i)
  if (!match) return { startTimeIso: null, endTimeIso: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null }
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
  const monthIndex = months.indexOf(match[1].toLowerCase())
  if (monthIndex === -1) return { startTimeIso: null, endTimeIso: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null }
  const year = parseInt(match[3], 10)
  const day = parseInt(match[2], 10)
  const toDate = (timeText: string) => {
    const [, hoursText, minutesText, period] = timeText.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i) || []
    if (!hoursText || !minutesText || !period) return null
    let hours = parseInt(hoursText, 10)
    const minutes = parseInt(minutesText, 10)
    const upperPeriod = period.toUpperCase()
    if (upperPeriod === "PM" && hours !== 12) hours += 12
    if (upperPeriod === "AM" && hours === 12) hours = 0
    return new Date(year, monthIndex, day, hours, minutes, 0)
  }
  const startDate = toDate(match[4])
  const endDate = toDate(match[5])
  return {
    startTimeIso: startDate ? buildIsoWithOffset(startDate) : null,
    endTimeIso: endDate ? buildIsoWithOffset(endDate) : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null
  }
}
