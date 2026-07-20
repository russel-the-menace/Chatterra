import {
  BehaviorSnapshot,
  Character,
  InteractionMode,
  ResponseDecision
} from './types'

type AppraisalLike = {
  selfDisclosure: boolean
  question: boolean
  urgency: boolean
  distress: boolean
  bereavement: boolean
  directedConflict: boolean
}

type RecentMessage = {
  senderRole: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export type ResponseDecisionInput = {
  message: string
  mode: InteractionMode
  character: Character
  snapshot: BehaviorSnapshot
  appraisal: AppraisalLike
  recentMessages?: RecentMessage[]
  now?: Date
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const compact = (value: string) => value
  .toLowerCase()
  .replace(/[\s,，。.!！?？~～…、;；:：'"“”‘’（）()\[\]{}<>]/g, '')

const hasLettersOrNumbers = (value: string) => /[\p{L}\p{N}]/u.test(value)
const hasEmoji = (value: string) => /\p{Extended_Pictographic}/u.test(value)

const meaningfulCharacterCount = (value: string) => {
  const matches = value.match(/[\p{L}\p{N}]/gu)
  return matches?.length || 0
}

const isReactionOnly = (value: string) => {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 24 &&
    hasEmoji(normalized) && !hasLettersOrNumbers(normalized)
}

const isPunctuationOnly = (value: string) => {
  const normalized = value.trim()
  return normalized.length > 0 && !hasLettersOrNumbers(normalized) && !hasEmoji(normalized)
}

const isMinimalAcknowledgement = (value: string) => new Set([
  '嗯', '嗯嗯', '哦', '噢', '喔', '唔', '好', '好啦', '好吧', '得', '係', '系',
  'ok', 'okay', 'k', 'sure', 'right', 'yeah', 'yep', '哈哈', 'lol'
]).has(compact(value))

const isClosure = (value: string) => {
  const normalized = compact(value)
  return [
    '晚安', '拜拜', '再見', '再见', '先咁', '就咁', '算啦', '走先', '瞓啦',
    '睡了', 'goodnight', 'bye', 'talklater', 'later'
  ].some(signal => normalized === signal || normalized.startsWith(signal))
}

const isLowDemandStatement = (value: string) => {
  const normalized = compact(value)
  return /^(?:冇嘢(?:做)?|無嘢(?:做)?|没什么(?:事)?|沒什麼(?:事)?|nothingmuch|notmuch|nothingtodo)(?:啊|呀|喎|嘛|呢)*$/.test(normalized)
}

const isExplicitRequest = (value: string) => {
  const normalized = value.toLowerCase()
  return /\b(?:please|help|tell me|can you|could you|would you|let me know|i want to know)\b/.test(normalized)
    || /(?:可唔可以|可以唔可以|可不可以|能不能|幫我|帮我|話畀我知|告诉我|講下|讲下|想問|想问)/.test(value)
}

const isSelfDisclosure = (value: string, appraisal: AppraisalLike) => {
  if (appraisal.selfDisclosure) return true
  return /\b(?:i|i'm|i am|my|we|we're)\b/i.test(value)
    || /(?:我|我哋|我地|我想|我的|我嘅|私|僕|ぼく|わたし)/i.test(value)
}

const isBoredomDisclosure = (value: string) => /(?:好悶|好闷|無聊|无聊|bored|boring)/i.test(value)

const personalityTalkativeness = (character: Character) => {
  const text = `${character.personality || ''} ${character.background || ''}`.toLowerCase()
  const expressive = ['extroverted', 'talkative', 'expressive', 'enthusiastic', 'chatty', 'outgoing', 'energetic']
    .some(signal => text.includes(signal))
  const reserved = ['introverted', 'reserved', 'quiet', 'concise', 'brief', 'shy', 'reticent', 'minimalist']
    .some(signal => text.includes(signal))
  return clamp(0.5 + (expressive ? 0.12 : 0) - (reserved ? 0.12 : 0), 0.2, 0.8)
}

const recentAssistantQuestion = (messages: RecentMessage[] = []) => {
  const latest = messages[0]
  return Boolean(latest && latest.senderRole === 'assistant' && /[?？]/.test(latest.content))
}

const recentAssistantWithin = (messages: RecentMessage[] = [], now: Date) => {
  const nowMs = now.getTime()
  return messages.some(message => {
    if (message.senderRole !== 'assistant') return false
    const createdMs = new Date(message.createdAt).getTime()
    return Number.isFinite(createdMs) && nowMs - createdMs >= 0 && nowMs - createdMs <= 10 * 60 * 1000
  })
}

/**
 * Decide whether this turn needs a visible response. This is deliberately
 * deterministic: silence is a policy decision with reasons, not a random
 * sampling trick or a failed model response disguised as one.
 */
export const decideResponse = (input: ResponseDecisionInput): ResponseDecision => {
  const now = input.now || new Date()
  const message = input.message.trim()
  const question = input.appraisal.question || /[?？]/.test(message)
  const reactionOnly = isReactionOnly(message)
  const punctuationOnly = isPunctuationOnly(message)
  const minimalAcknowledgement = isMinimalAcknowledgement(message)
  const closure = isClosure(message)
  const lowDemand = isLowDemandStatement(message)
  const explicitRequest = isExplicitRequest(message)
  const selfDisclosure = isSelfDisclosure(message, input.appraisal)
  const boredomDisclosure = isBoredomDisclosure(message)
  const substantiveQuestion = question && !punctuationOnly && !reactionOnly
  const contentRich = meaningfulCharacterCount(message) >= 6
  const previousAssistantQuestion = recentAssistantQuestion(input.recentMessages)
  const conversationalMomentum = recentAssistantWithin(input.recentMessages, now)
  const highStakes = input.appraisal.urgency || input.appraisal.distress ||
    input.appraisal.bereavement || input.appraisal.directedConflict
  const activity = input.snapshot.simulation.currentActivity
  const unavailable = activity === 'sleeping' || activity === 'working' || activity === 'studying'
  const talkativeness = personalityTalkativeness(input.character)
  const relationshipWarmth = clamp(
    (input.snapshot.relationship.affinity + input.snapshot.relationship.trust +
      (input.snapshot.affect.warmth + 1) / 2) / 3,
    0,
    1
  )

  let demandScore = 0.24
  if (substantiveQuestion) demandScore += 0.56
  if (explicitRequest) demandScore += 0.42
  if (highStakes) demandScore += 0.9
  if (selfDisclosure) demandScore += 0.27
  if (boredomDisclosure) demandScore += 0.3
  if (contentRich) demandScore += 0.14
  if (previousAssistantQuestion && !minimalAcknowledgement) demandScore += 0.32
  if (conversationalMomentum) demandScore += 0.12
  if (reactionOnly) demandScore += 0.04
  if (activity === 'available' || activity === 'personal_time') demandScore += 0.08
  demandScore += (talkativeness - 0.5) * 0.18
  demandScore += (relationshipWarmth - 0.5) * 0.1
  if (punctuationOnly) demandScore -= 0.8
  if (minimalAcknowledgement) demandScore -= 0.42
  if (closure) demandScore -= 0.62
  if (lowDemand) demandScore -= 0.38
  if (activity === 'sleeping') demandScore -= 0.2
  else if (activity === 'working' || activity === 'studying') demandScore -= 0.1
  if (input.snapshot.affect.energy < 0.3) demandScore -= 0.15
  if (input.snapshot.affect.stress > 0.8) demandScore -= 0.08
  demandScore = clamp(Number(demandScore.toFixed(3)), -1, 1)

  const threshold = Number(clamp(0.45 + (0.5 - talkativeness) * 0.08, 0.4, 0.5).toFixed(3))
  const passiveSignal = punctuationOnly || minimalAcknowledgement || closure || lowDemand || reactionOnly
  const reasons: string[] = []
  let action: ResponseDecision['action'] = 'reply_now'

  if (input.mode === 'practice') {
    reasons.push('practice_mode_requires_response')
  } else if (highStakes) {
    reasons.push('high_stakes_message_requires_response')
  } else if (substantiveQuestion) {
    reasons.push('direct_question')
  } else if (explicitRequest) {
    reasons.push('explicit_request')
  } else if (passiveSignal && demandScore < threshold) {
    action = 'no_reply'
    reasons.push('low_response_demand')
    if (punctuationOnly) reasons.push('punctuation_only')
    if (minimalAcknowledgement) reasons.push('minimal_acknowledgement')
    if (closure) reasons.push('conversation_closure')
    if (lowDemand) reasons.push('low_information_statement')
    if (reactionOnly) reasons.push('reaction_does_not_require_follow_up')
    if (unavailable) reasons.push('character_not_available_for_low_demand_turn')
    if (input.snapshot.affect.energy < 0.3) reasons.push('low_energy')
  } else {
    reasons.push('conversational_content')
  }

  if (action === 'reply_now') {
    if (selfDisclosure) reasons.push('self_disclosure')
    if (previousAssistantQuestion) reasons.push('answers_open_question')
    if (conversationalMomentum) reasons.push('active_conversation')
    if (unavailable) reasons.push('character_state_allows_brief_response')
  }

  return {
    action,
    reasonCodes: Array.from(new Set(reasons)),
    scoreDetails: {
      demandScore,
      threshold,
      activity,
      energy: Number(input.snapshot.affect.energy.toFixed(3)),
      stress: Number(input.snapshot.affect.stress.toFixed(3)),
      talkativeness,
      relationshipWarmth: Number(relationshipWarmth.toFixed(3)),
      question,
      substantiveQuestion,
      explicitRequest,
      selfDisclosure,
      highStakes,
      reactionOnly,
      punctuationOnly,
      minimalAcknowledgement,
      closure,
      lowDemand,
      previousAssistantQuestion,
      conversationalMomentum,
      practiceGuarantee: input.mode === 'practice'
    }
  }
}
