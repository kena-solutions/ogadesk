// ============================================================
// Grounding check: before the AI sends a reply on its own, make sure the
// facts that are expensive to get wrong are backed by something.
//
// Risky facts are the ones a customer would act on or quote back: prices and
// amounts, percentages, numbers of two or more digits (days, dates, order or
// phone numbers), web links and email addresses. Each one in the reply must
// also appear in the evidence: the knowledge excerpts retrieved for the
// question, the conversation so far, or the agent's own instructions. A reply
// that states a fact nobody gave the AI is not sent.
//
// It is deliberately a cheap, rule-based check (no extra AI call): it catches
// invented prices, dates and links, not subtly wrong wording. Single digits
// ("2 options") and times of day are not treated as facts, to keep false alarms
// (which cost a handoff) rare.
// ============================================================

/** Eastern Arabic-Indic and Devanagari digits to ASCII, so "٥٠٠٠" matches "5000". */
function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
}

const PATH = `(?:\\/[^\\s<>()"'\\]]*)?`
// Links with a scheme or www., and bare domains (acme.com/returns) on the common top-level domains.
const URL_RE = new RegExp(
  `(?:\\bhttps?:\\/\\/|\\bwww\\.)[^\\s<>()"'\\]]+|\\b(?:[a-z0-9-]+\\.)+(?:com|net|org|io|co|ng|ke|gh|za|app|biz|info|me)\\b${PATH}`,
  'gi',
)
const TIME_RE = /\b\d{1,2}:\d{2}\b/g
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
// A number, with thousands separators and decimals: 5,000  5 000  1.250,50  12.5
const NUMBER_RE = /\d[\d,.   ]*\d|\d/g
const CURRENCY_BEFORE = /[$€£₦¥₹₵]|\b(?:usd|ngn|eur|gbp|kes|ghs|zar|inr|rs|ksh|kes|naira|cedis?)\s*$/i
const PERCENT_AFTER = /^\s*(?:%|percent\b|per cent\b)/i
const CURRENCY_AFTER = /^\s*(?:usd|ngn|eur|gbp|kes|ghs|zar|inr|naira|dollars?|euros?|pounds?|cedis?|shillings?)\b/i

/** A link in comparable form: no scheme, no www., no trailing punctuation or slash. */
function trimUrl(u: string): string {
  return u.toLowerCase().replace(/[.,;:!?]+$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
}

/** "5,000" / "5 000" / "5.000,50" / "₦5,000.00" → a comparable canonical number string, or null. */
export function canonicalNumber(raw: string): string | null {
  let s = raw.replace(/[   ]/g, '')
  if (!s) return null
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal mark.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (lastComma > -1) {
    // 5,000 (thousands) vs 5,5 (decimal): three digits after a lone comma = thousands.
    s = /,\d{3}$/.test(s) && s.indexOf(',') === lastComma ? s.replace(',', '') : s.replace(/,/g, '.')
  } else if (lastDot > -1 && /\.\d{3}$/.test(s) && s.indexOf('.') === lastDot && s.length > 4) {
    // 5.000 is thousands in many locales; a lone 1.250 is ambiguous, so treat both readings as the same fact below.
    s = s.replace('.', '')
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return String(n)
}

export interface Facts {
  numbers: string[]
  urls: string[]
  emails: string[]
}

/** The risky facts in a text (see the module comment for what counts). */
export function extractFacts(text: string): Facts {
  const t = asciiDigits(text)
  const emails = Array.from(new Set((t.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())))
  const noEmails = t.replace(EMAIL_RE, ' ')
  const urls = Array.from(new Set((noEmails.match(URL_RE) ?? []).map(trimUrl)))
  // Remove links, emails and times of day so their digits and dots are not read as numbers.
  const bare = noEmails.replace(URL_RE, ' ').replace(TIME_RE, ' ')
  const numbers = new Set<string>()
  for (const m of bare.matchAll(NUMBER_RE)) {
    const raw = m[0]
    const idx = m.index ?? 0
    const before = bare.slice(Math.max(0, idx - 8), idx)
    const after = bare.slice(idx + raw.length, idx + raw.length + 12)
    const digits = raw.replace(/\D/g, '')
    const marked = CURRENCY_BEFORE.test(before) || PERCENT_AFTER.test(after) || CURRENCY_AFTER.test(after)
    // A lone digit is not a fact unless it carries a currency or percent sign ("5%", "$5").
    if (digits.length < 2 && !marked) continue
    const canon = canonicalNumber(raw)
    if (canon !== null) numbers.add(canon)
    // "1.250" may mean 1250 or 1.25: accept either reading in the evidence.
    if (/^\d{1,3}\.\d{3}$/.test(raw.replace(/\s/g, ''))) numbers.add(String(Number(raw.replace('.', ''))))
  }
  return { numbers: [...numbers], urls, emails }
}

export interface GroundingResult {
  ok: boolean
  /** The facts in the reply that nothing supports, as written for people ("5000", "www.x.com"). */
  unsupported: string[]
}

/**
 * Check a reply against the evidence texts. `ok` is true when every risky fact in the reply also appears in the
 * evidence (any number reading counts). A reply with no risky facts is always ok.
 */
export function checkGrounding(reply: string, evidence: string[]): GroundingResult {
  const wanted = extractFacts(reply)
  if (wanted.numbers.length + wanted.urls.length + wanted.emails.length === 0) return { ok: true, unsupported: [] }

  const have = extractFacts(evidence.join('\n'))
  const haveNumbers = new Set(have.numbers)
  const haveUrls = have.urls
  const haveText = asciiDigits(evidence.join('\n')).toLowerCase()

  const unsupported: string[] = []
  for (const n of wanted.numbers) if (!haveNumbers.has(n)) unsupported.push(n)
  for (const u of wanted.urls) {
    // A link counts as supported when the evidence has it, or a longer one that starts with it (or the other way).
    if (!haveUrls.some((h) => h === u || h.startsWith(u) || u.startsWith(h))) unsupported.push(u)
  }
  for (const e of wanted.emails) if (!haveText.includes(e)) unsupported.push(e)
  return { ok: unsupported.length === 0, unsupported }
}
