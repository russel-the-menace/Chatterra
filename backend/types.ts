export type UUID = string

export interface User {
  id: UUID
  displayName: string
  email?: string
  nativeLanguage?: string
  learningGoals?: Record<string, any>
  preferences?: Record<string, any>
  consentFlags?: Record<string, boolean>
  createdAt: string
  updatedAt: string
}

export interface Character {
  id: UUID
  name: string
  avatar?: string
  role?: string
  personality?: string
  company?: string
  scenario?: string
  goal?: string
  language?: string
  background?: string
  systemPromptTemplate?: string
  currentVersion?: number
  createdAt: string
  updatedAt: string
}

export interface Conversation {
  id: UUID
  userId: UUID
  characterId: UUID
  title?: string
  status?: 'active' | 'archived'
  lastMessageAt?: string
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: UUID
  conversationId: UUID
  senderRole: 'user' | 'assistant' | 'system'
  senderId?: UUID
  content: string
  contentJson?: Record<string, any>
  tokenCount?: number
  createdAt: string
}

export interface VoiceTranscriptMetadata {
  originalText: string
  correctedText?: string
  detectedLanguage?: string
  confidence?: number
  audioAvailable?: boolean
}

export type MemoryType =
  | 'user_profile'
  | 'background'
  | 'preference'
  | 'past_event'
  | 'learning_weakness'
  | 'important_fact'
  | 'other'

export type MemoryRepresentation = 'episodic' | 'semantic' | 'procedural' | 'summary'
export type MemoryRetentionTier = 'working' | 'short_lived' | 'durable' | 'archived'

export interface Memory {
  id: UUID
  userId: UUID
  characterId?: UUID
  originMessageId?: UUID
  type: MemoryType
  content: string
  importanceScore: number // 0..1
  confidence?: number
  createdAt: string
  lastAccessedAt?: string
  lastUpdatedAt?: string
  metadata?: Record<string, any>
  representation?: MemoryRepresentation
  retentionTier?: MemoryRetentionTier
  retrievalStrength?: number
  halfLifeHours?: number
  sensitivity?: 'normal' | 'sensitive' | 'restricted'
  validFrom?: string
  validTo?: string
  supersedesId?: UUID
  confirmed?: boolean
}

export interface ConversationSummary {
  id: UUID
  conversationId: UUID
  summaryText: string
  lastGeneratedAt: string
  coverage?: { start?: string; end?: string; topics?: string[] }
}

export type InteractionMode = 'companion' | 'practice'

export type ResponseDecisionAction = 'reply_now' | 'no_reply'

export interface ResponseDecision {
  action: ResponseDecisionAction
  reasonCodes: string[]
  scoreDetails: Record<string, any>
}

export interface CharacterInstance {
  id: UUID
  userId: UUID
  characterId: UUID
  templateVersion: number
  mode: InteractionMode
  eventSequence: number
  lastInteractionAt?: string
  nextActionAt?: string
  createdAt: string
  updatedAt: string
}

export interface RelationshipState {
  familiarity: number
  trust: number
  affinity: number
  respect: number
  reciprocity: number
  boundaryComfort: number
  unresolvedTension: number
  bondStrength: number
  version: number
  asOf: string
}

export interface AffectState {
  valence: number
  arousal: number
  dominance: number
  warmth: number
  stress: number
  energy: number
  baseline: Record<string, number>
  lastEventId?: UUID
  version: number
  asOf: string
}

export interface SimulationState {
  localTimezone: string
  currentActivity: string
  activityStartedAt: string
  activityEndsAt?: string
  lastSimulatedAt: string
  nextWakeupAt?: string
  version: number
}

export interface BehaviorSnapshot {
  instance: CharacterInstance
  relationship: RelationshipState
  affect: AffectState
  simulation: SimulationState
  recentEvents: Array<{
    id: UUID
    eventType: string
    occurredAt: string
    payload: Record<string, any>
  }>
  emotionLabel: string
}
