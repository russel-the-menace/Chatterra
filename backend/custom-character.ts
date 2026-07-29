import { parseDocument } from 'yaml'

import {
  Character,
  CharacterCorrectionPolicy,
  CharacterDelivery,
  CharacterInitiative,
  CharacterMode,
  CharacterReplyStyle,
  CharacterRuntimeConfig,
} from './types'

type RuntimeDocument = {
  mode?: unknown
  language?: unknown
  explanation_language?: unknown
  correction?: unknown
  reply_style?: unknown
  delivery?: unknown
  initiative?: unknown
  timezone?: unknown
  starter_message?: unknown
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u
const SUPPORTED_KEYS = new Set([
  'mode',
  'language',
  'explanation_language',
  'correction',
  'reply_style',
  'delivery',
  'initiative',
  'timezone',
  'starter_message',
])

const enumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  issues: string[],
) => {
  if (value == null || value === '') return fallback
  const normalized = String(value).trim().toLowerCase().replace(/[ -]/gu, '_')
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T
  issues.push(`${field} must be one of: ${allowed.join(', ')}`)
  return fallback
}

const stringValue = (value: unknown, field: string, issues: string[], limit = 240) => {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') {
    issues.push(`${field} must be a string`)
    return undefined
  }
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > limit) {
    issues.push(`${field} must be ${limit} characters or fewer`)
    return undefined
  }
  return normalized
}

const languageSetting = (language: string, explanationLanguage?: string) => {
  const normalized = language.trim().toLowerCase().replace(/_/gu, '-').replace(/\s+/gu, '-')
  const base = normalized === 'en' || normalized === 'en-us' || normalized === 'english'
    ? 'English'
    : normalized === 'ja' || normalized === 'ja-jp' || normalized === 'japanese'
      ? 'Japanese'
      : normalized === 'ko' || normalized === 'ko-kr' || normalized === 'korean'
        ? 'Korean'
        : normalized === 'es' || normalized === 'es-ar' || normalized === 'spanish' || normalized === 'argentine-spanish'
          ? 'Argentine Spanish'
          : normalized === 'zh-cn' || normalized === 'mandarin'
            ? 'Mandarin Chinese'
            : normalized === 'cantonese' || normalized === 'yue'
              ? 'Cantonese'
              : undefined
  if (!base) return undefined
  if (explanationLanguage) return `${base} with ${explanationLanguage} explanations`
  if (base === 'English') return 'English only'
  return `${base} only; understands English input`
}

const isValidTimeZone = (value: string) => {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export type ParsedCustomCharacterDocument = {
  prompt: string
  runtimeConfig: CharacterRuntimeConfig
  languageSetting: string
}

export const customCharacterDocumentTemplate = `---
mode: companion
language: English
correction: selective
reply_style: balanced
delivery: flexible
initiative: off
timezone: Asia/Shanghai
---

# Identity
You are a thoughtful conversation partner with a distinct point of view.

# Conversation style
Keep replies natural, direct, and suited to a chat app.
`

export const parseCustomCharacterDocument = (value: string): ParsedCustomCharacterDocument => {
  const match = value.match(FRONTMATTER)
  if (!match) {
    throw new Error('Start the character document with a YAML frontmatter block between two --- lines.')
  }

  const document = parseDocument(match[1])
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML frontmatter: ${document.errors[0].message}`)
  }
  const raw = document.toJSON()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The YAML frontmatter must be a mapping of settings.')
  }
  const settings = raw as RuntimeDocument
  const issues: string[] = []
  Object.keys(settings).forEach(key => {
    if (!SUPPORTED_KEYS.has(key)) issues.push(`Unsupported setting: ${key}`)
  })

  const mode = enumValue<CharacterMode>(settings.mode, ['companion', 'practice'], 'companion', 'mode', issues)
  const correction = enumValue<CharacterCorrectionPolicy>(settings.correction, ['never', 'on_request', 'selective', 'always'], 'selective', 'correction', issues)
  const replyStyle = enumValue<CharacterReplyStyle>(settings.reply_style, ['concise', 'balanced', 'expressive'], 'balanced', 'reply_style', issues)
  const delivery = enumValue<CharacterDelivery>(settings.delivery, ['single', 'flexible', 'bursty'], 'flexible', 'delivery', issues)
  const initiative = enumValue<CharacterInitiative>(settings.initiative, ['off', 'low', 'normal', 'high'], 'off', 'initiative', issues)
  const language = stringValue(settings.language, 'language', issues, 80) || 'English'
  const explanationLanguage = stringValue(settings.explanation_language, 'explanation_language', issues, 80)
  const timezone = stringValue(settings.timezone, 'timezone', issues, 80)
  const starterMessage = stringValue(settings.starter_message, 'starter_message', issues, 500)
  const resolvedLanguage = languageSetting(language, explanationLanguage)
  if (!resolvedLanguage) issues.push('language must be English, Japanese, Korean, Argentine Spanish, Mandarin Chinese, or Cantonese')
  if (timezone && !isValidTimeZone(timezone)) issues.push('timezone must be a valid IANA timezone, such as Asia/Tokyo')

  const prompt = match[2].trim()
  if (!prompt) issues.push('Write the character prompt below the closing --- line')
  if (prompt.length > 20_000) issues.push('The character prompt must be 20,000 characters or fewer')
  if (issues.length > 0) throw new Error(issues.join('. '))

  return {
    prompt,
    runtimeConfig: {
      mode,
      language,
      explanationLanguage,
      correction,
      replyStyle,
      delivery,
      initiative,
      timezone,
      starterMessage,
    },
    languageSetting: resolvedLanguage!,
  }
}

export const promptBodyForCharacter = (character: Character) => {
  if (!character.ownerUserId || !character.systemPromptTemplate) return character.systemPromptTemplate || ''
  try {
    return parseCustomCharacterDocument(character.systemPromptTemplate).prompt
  } catch {
    return character.systemPromptTemplate
  }
}
