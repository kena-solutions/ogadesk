// Business-hours check shared by the website-chat "Online" badge and AI agent routing rules.

export interface ChatHours {
  enabled?: boolean
  days?: number[]
  from?: string
  to?: string
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** Whether `now` falls inside the widget's business hours, in `timezone`. No hours configured = always. Pure. */
export function isWithinHours(hours: ChatHours | undefined | null, timezone: string, now: Date): boolean {
  if (!hours || !hours.enabled) return true
  let weekday: number
  let minutes: number
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
    minutes = Number(get('hour')) * 60 + Number(get('minute'))
  } catch {
    return true // unknown timezone: do not lock the widget closed
  }
  if (weekday < 0) return true
  const days = hours.days ?? [1, 2, 3, 4, 5]
  if (!days.includes(weekday)) return false
  const from = toMinutes(hours.from ?? '09:00')
  const to = toMinutes(hours.to ?? '17:00')
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to // overnight window
}
