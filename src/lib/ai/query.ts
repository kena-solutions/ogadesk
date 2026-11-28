import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/** How much of the previous question a follow-up carries. */
const PREVIOUS_MAX_CHARS = 300

/**
 * The text to search knowledge with. Usually the latest customer
 * message; a short follow-up ("and how much is that?", "what about
 * Lagos?") is joined with the customer's previous message so it carries
 * the topic. No extra LLM call.
 */
export function buildRetrievalQuery(messages: ChatMessage[], maxWords = 8): string {
  const userTurns = messages.filter((m) => m.role === 'user').map((m) => m.content.trim()).filter(Boolean)
  const latest = userTurns.at(-1) ?? latestUserMessage(messages).trim()
  if (!latest) return ''
  const words = latest.split(/\s+/).length
  const previous = userTurns.length > 1 ? userTurns[userTurns.length - 2] : ''
  if (words > maxWords || !previous) return latest
  return `${previous.slice(0, PREVIOUS_MAX_CHARS)}\n${latest}`
}

// Function words in the app's languages (en, es, fr, pt) that would make
// an any-term keyword search match nearly every chunk.
const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my ' +
    'no not of on or our please so that the their them there they this to us was we were what when where which who ' +
    'why will with would you your yes ok okay hi hello thanks thank about also just any some much many more ' +
    'el la los las un una unos unas y o de del al en es son que qué por para con sin se su sus mi mis tu tus le les lo ' +
    'como cómo cuando cuándo donde dónde hay ser estar está están muy más pero sí hola gracias ' +
    'le la les un une des et ou de du au aux en est sont que qui quoi pour par avec sans se sa son ses mon ma mes ' +
    'ton ta tes il elle ils elles nous vous je tu ce cet cette ces comment quand où pas plus mais oui bonjour merci ' +
    'o a os as um uma uns umas e ou de do da dos das no na nos nas em é são que por para com sem se seu sua seus ' +
    'suas meu minha eu você vocês ele ela eles elas isso isto como quando onde não mais mas sim olá obrigado obrigada ' +
    // Indonesian
    'yang dan di ke dari untuk dengan pada ini itu ada adalah saya aku kamu anda kami kita mereka apa siapa kapan dimana ' +
    'bagaimana kenapa mengapa tidak bisa akan sudah belum juga atau tetapi sama saja halo terima kasih ' +
    // Swahili
    'na ya wa kwa ni katika la za kuna hii huu hiki hizi yangu yako wetu wao mimi wewe sisi ninyi nini lini wapi vipi ' +
    'gani sio bado pia au lakini habari asante tafadhali ' +
    // Hindi
    'का की के में से को पर और या है हैं था थे हो क्या कैसे कब कहाँ क्यों मैं हम आप वह यह ये वे नहीं भी तो ही एक कृपया धन्यवाद नमस्ते ' +
    // Arabic
    'في من على إلى عن مع هل ما ماذا كيف متى أين لماذا هذا هذه ذلك التي الذي أنا نحن أنت هو هي لا نعم أو و ثم كان يكون شكرا مرحبا من فضلك ' +
    // Korean (common particles/function words)
    '이 그 저 은 는 이가 가 을 를 의 에 에서 으로 로 와 과 도 만 요 네 아니요 안녕하세요 감사합니다 어떻게 언제 어디 무엇 왜 있나요'
  ).split(/\s+/),
)

/** Significant terms of a query for keyword search (stopwords and 1-letter tokens removed). */
export function keywordQuery(text: string): string {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    terms.push(raw)
  }
  return terms.join(' ')
}
