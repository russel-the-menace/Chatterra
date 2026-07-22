import { Character } from './types'

export type ProactivePolicy = {
  enabled: boolean
  intensity: number
  minDelayMinutes: number
  maxDelayMinutes: number
  maxUnansweredMessages: number
  topicDomains: string[]
}

const authoredText = (character: Character) => [
  character.role,
  character.personality,
  character.scenario,
  character.goal,
  character.background,
  character.systemPromptTemplate
].filter(Boolean).join(' ').toLowerCase()

const boundedEnvironmentNumber = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

const stableFraction = (seed: string) => {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967295
}

export const deriveProactivePolicy = (character: Character): ProactivePolicy => {
  const text = authoredText(character)
  const explicitInitiative = /\b(?:proactiv(?:e|ely)|initiates? conversations?|starts? conversations?|messages? (?:the user|them) first|reach(?:es)? out)\b/i.test(text)
  const clingy = /\b(?:clingy|attached|affectionate girlfriend|misses? (?:the user|them) quickly)\b/i.test(text)
  const enabled = explicitInitiative || clingy
  const defaultMin = clingy ? 20 : 90
  const defaultMax = clingy ? 90 : 360
  const minDelayMinutes = boundedEnvironmentNumber('PROACTIVE_MIN_DELAY_MINUTES', defaultMin, 1, 1440)
  const maxDelayMinutes = Math.max(
    minDelayMinutes,
    boundedEnvironmentNumber('PROACTIVE_MAX_DELAY_MINUTES', defaultMax, 1, 2880)
  )
  const topicCandidates: Array<[RegExp, string]> = [
    [/\b(?:school|campus|class|study|student|university)\b/i, 'school life'],
    [/\b(?:medicine|medical|anatomy|clinic|pre-med|bs\/md)\b/i, 'medicine'],
    [/\b(?:relationship|dating|intimacy|girlfriend|boyfriend|partner)\b/i, 'intimate relationships'],
    [/\b(?:family|parents?|mother|father|childhood|family of origin)\b/i, 'family of origin'],
    [/\b(?:philosophy|meaning|ethics|identity|consciousness)\b/i, 'philosophy'],
    [/\b(?:daily life|everyday|day-to-day)\b/i, 'daily life']
  ]
  const topicDomains = topicCandidates
    .filter(([pattern]) => pattern.test(text))
    .map(([, topic]) => topic)

  return {
    enabled,
    intensity: clingy ? 0.9 : explicitInitiative ? 0.55 : 0,
    minDelayMinutes,
    maxDelayMinutes,
    maxUnansweredMessages: clingy ? 3 : 1,
    topicDomains: topicDomains.length > 0 ? topicDomains : ['daily life']
  }
}

export const nextProactiveActionAt = ({
  character,
  now,
  seed,
  unansweredCount = 0
}: {
  character: Character
  now: Date
  seed: string
  unansweredCount?: number
}): Date | undefined => {
  const policy = deriveProactivePolicy(character)
  if (!policy.enabled || unansweredCount >= policy.maxUnansweredMessages) return undefined

  const jitter = stableFraction(`${character.id}:${seed}:${unansweredCount}`)
  const baseDelay = policy.minDelayMinutes + jitter * (policy.maxDelayMinutes - policy.minDelayMinutes)
  const backoff = 1 + unansweredCount * 0.75
  return new Date(now.getTime() + Math.round(baseDelay * backoff * 60_000))
}
