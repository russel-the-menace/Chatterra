import { PoolClient } from 'pg'
import { v4 as uuidv4 } from 'uuid'
import { query, withTransaction } from './database'
import type { InferencePlan } from './inference-orchestrator'
import type { InferenceDiagnostics } from './inference-logger'
import {
  AffectState,
  BehaviorSnapshot,
  Character,
  CharacterInstance,
  InteractionMode,
  Memory,
  RelationshipState,
  SimulationState
} from './types'

type EventActor = 'user' | 'character' | 'system' | 'scheduler'

type EventInput = {
  instanceId: string
  userId: string
  characterId: string
  conversationId?: string
  messageId?: string
  eventType: string
  actorRole: EventActor
  actorId?: string
  payload?: Record<string, any>
  occurredAt?: Date
  source?: string
  confidence?: number
  causationId?: string
  correlationId?: string
}

type Appraisal = {
  positive: number
  negative: number
  apology: number
  selfDisclosure: boolean
  question: boolean
  urgency: boolean
  distress: boolean
  bereavement: boolean
  directedConflict: boolean
  relationshipReasons: string[]
  affectReasons: string[]
}

export type InteractionPreparation = {
  snapshot: BehaviorSnapshot
  triggerEventId: string
  decisionId: string
  appraisal: Appraisal
  mode: InteractionMode
  memoryEnabled: boolean
}

const iso = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const boundedUnit = (value: any, fallback: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? clamp(number, 0, 1) : fallback
}

const boundedSigned = (value: any, fallback: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? clamp(number, -1, 1) : fallback
}

const mapInstance = (row: any): CharacterInstance => ({
  id: row.id,
  userId: row.user_id,
  characterId: row.character_id,
  templateVersion: Number(row.template_version || 1),
  mode: row.mode === 'companion' ? 'companion' : 'practice',
  eventSequence: Number(row.event_sequence || 0),
  lastInteractionAt: iso(row.last_interaction_at),
  nextActionAt: iso(row.next_action_at),
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!
})

const mapRelationship = (row: any): RelationshipState => ({
  familiarity: boundedUnit(row.familiarity, 0),
  trust: boundedUnit(row.trust, 0.5),
  affinity: boundedUnit(row.affinity, 0.5),
  respect: boundedUnit(row.respect, 0.5),
  reciprocity: boundedUnit(row.reciprocity, 0.5),
  boundaryComfort: boundedUnit(row.boundary_comfort, 0.5),
  unresolvedTension: boundedUnit(row.unresolved_tension, 0),
  bondStrength: boundedUnit(row.bond_strength, 0),
  version: Number(row.version || 0),
  asOf: iso(row.as_of)!
})

const mapAffect = (row: any): AffectState => ({
  valence: boundedSigned(row.valence, 0),
  arousal: boundedUnit(row.arousal, 0.35),
  dominance: boundedSigned(row.dominance, 0),
  warmth: boundedSigned(row.warmth, 0.1),
  stress: boundedUnit(row.stress, 0.2),
  energy: boundedUnit(row.energy, 0.7),
  baseline: row.baseline || {
    valence: 0,
    arousal: 0.35,
    dominance: 0,
    warmth: 0.1,
    stress: 0.2,
    energy: 0.7
  },
  lastEventId: row.last_event_id || undefined,
  version: Number(row.version || 0),
  asOf: iso(row.as_of)!
})

const mapSimulation = (row: any): SimulationState => ({
  localTimezone: row.local_timezone || 'Asia/Shanghai',
  currentActivity: row.current_activity || 'available',
  activityStartedAt: iso(row.activity_started_at)!,
  activityEndsAt: iso(row.activity_ends_at),
  lastSimulatedAt: iso(row.last_simulated_at)!,
  nextWakeupAt: iso(row.next_wakeup_at),
  version: Number(row.version || 0)
})

const localHour = (date: Date, timeZone: string) => {
  try {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hour12: false
    }).format(date)
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : date.getUTCHours()
  } catch {
    return date.getUTCHours()
  }
}

const activityForHour = (hour: number, character: Character) => {
  const role = `${character.role || ''} ${character.scenario || ''}`.toLowerCase()
  if (hour < 7 || hour >= 23) return 'sleeping'
  if (role.includes('student') && hour >= 8 && hour < 15) return 'studying'
  if (hour >= 9 && hour < 17) return 'working'
  if (hour >= 18 && hour < 21) return 'personal_time'
  return 'available'
}

export const resolveCharacterMode = (character: Character): InteractionMode => {
  const authoredPolicy = [
    character.role,
    character.personality,
    character.scenario,
    character.goal,
    character.systemPromptTemplate
  ].filter(Boolean).join(' ').toLowerCase()
  const teachingSignals = [
    'teacher', 'tutor', 'interview', 'language practice', 'correct mistakes',
    'correction', 'learning', 'lesson', 'evaluate communication'
  ]
  return teachingSignals.some(signal => authoredPolicy.includes(signal))
    ? 'practice'
    : 'companion'
}

const emotionLabel = (affect: AffectState, relationship: RelationshipState) => {
  if (affect.stress > 0.68 && affect.valence < -0.2) return 'tense and overloaded'
  if (affect.valence < -0.35 && relationship.unresolvedTension > 0.45) return 'guarded and disappointed'
  if (affect.valence > 0.35 && affect.warmth > 0.3) return 'warm and engaged'
  if (affect.arousal > 0.7 && affect.valence >= 0) return 'energetic and curious'
  if (affect.energy < 0.3) return 'tired but present'
  if (affect.valence < -0.2) return 'quietly uneasy'
  return 'calm and attentive'
}

const decay = (value: number, baseline: number, elapsedHours: number, halfLifeHours: number) => {
  if (elapsedHours <= 0) return value
  const factor = Math.pow(0.5, elapsedHours / halfLifeHours)
  return baseline + (value - baseline) * factor
}

const characterize = (character: Character) => JSON.stringify({
  name: character.name,
  avatar: character.avatar || '',
  role: character.role || '',
  company: character.company || '',
  personality: character.personality || '',
  scenario: character.scenario || '',
  goal: character.goal || '',
  language: character.language || '',
  background: character.background || '',
  systemPromptTemplate: character.systemPromptTemplate || ''
})

const ensureCharacterVersion = async (client: PoolClient, character: Character) => {
  const version = character.currentVersion || 1
  await client.query(
    `INSERT INTO character_versions (id, character_id, version, definition, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (character_id, version) DO NOTHING`,
    [
      `${character.id}:v${version}`,
      character.id,
      version,
      characterize(character),
      character.updatedAt || new Date().toISOString()
    ]
  )
  return version
}

const ensureInstance = async (
  client: PoolClient,
  userId: string,
  character: Character,
  mode?: InteractionMode
) => {
  await client.query(
    `INSERT INTO users (id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [userId, 'Local User']
  )

  const version = await ensureCharacterVersion(client, character)
  const result = await client.query(
    `INSERT INTO character_instances (
       id, user_id, character_id, template_version, mode
     ) VALUES ($1, $2, $3, $4, COALESCE($5, 'practice'))
     ON CONFLICT (user_id, character_id) DO UPDATE SET
       mode = $5,
       updated_at = NOW()
     WHERE $5 IS NOT NULL AND character_instances.mode IS DISTINCT FROM $5
     RETURNING *`,
    [uuidv4(), userId, character.id, version, mode || null]
  )
  const instanceRow = result.rows[0] || (
    await client.query(
      'SELECT * FROM character_instances WHERE user_id = $1 AND character_id = $2',
      [userId, character.id]
    )
  ).rows[0]
  const instance = mapInstance(instanceRow)

  await client.query(
    `INSERT INTO relationship_states (instance_id)
     VALUES ($1)
     ON CONFLICT (instance_id) DO NOTHING`,
    [instance.id]
  )
  await client.query(
    `INSERT INTO affect_states (instance_id)
     VALUES ($1)
     ON CONFLICT (instance_id) DO NOTHING`,
    [instance.id]
  )
  await client.query(
    `INSERT INTO simulation_cursors (instance_id)
     VALUES ($1)
     ON CONFLICT (instance_id) DO NOTHING`,
    [instance.id]
  )
  await client.query(
    `INSERT INTO user_learning_profiles (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  )

  return instance
}

const advanceState = async (
  client: PoolClient,
  instance: CharacterInstance,
  character: Character,
  now: Date
) => {
  const cursorResult = await client.query(
    `SELECT * FROM simulation_cursors WHERE instance_id = $1 FOR UPDATE`,
    [instance.id]
  )
  const affectResult = await client.query(
    `SELECT * FROM affect_states WHERE instance_id = $1 FOR UPDATE`,
    [instance.id]
  )
  const relationshipResult = await client.query(
    `SELECT * FROM relationship_states WHERE instance_id = $1 FOR UPDATE`,
    [instance.id]
  )

  const cursor = cursorResult.rows[0]
  const affect = mapAffect(affectResult.rows[0])
  const relationship = mapRelationship(relationshipResult.rows[0])
  const lastSimulated = new Date(cursor?.last_simulated_at || affect.asOf || now)
  const elapsedHours = Math.max(0, (now.getTime() - lastSimulated.getTime()) / 3600000)
  const timeZone = cursor?.local_timezone || 'Asia/Shanghai'
  const hour = localHour(now, timeZone)
  const activity = activityForHour(hour, character)

  const baseline = affect.baseline || {}
  const nextAffect = {
    valence: decay(affect.valence, Number(baseline.valence ?? 0), elapsedHours, 36),
    arousal: decay(affect.arousal, Number(baseline.arousal ?? 0.35), elapsedHours, 8),
    dominance: decay(affect.dominance, Number(baseline.dominance ?? 0), elapsedHours, 48),
    warmth: decay(affect.warmth, Number(baseline.warmth ?? 0.1), elapsedHours, 72),
    stress: decay(affect.stress, Number(baseline.stress ?? 0.2), elapsedHours, 24),
    energy: activity === 'sleeping'
      ? clamp(affect.energy + elapsedHours * 0.08, 0, 1)
      : clamp(decay(affect.energy, Number(baseline.energy ?? 0.7), elapsedHours, 18), 0, 1)
  }
  const nextTension = clamp(decay(relationship.unresolvedTension, 0, elapsedHours, 168), 0, 1)

  const activityChanged = !cursor || cursor.current_activity !== activity
  if (elapsedHours < 1 / 60 && !activityChanged) return

  await client.query(
    `UPDATE affect_states SET
       valence = $2,
       arousal = $3,
       dominance = $4,
       warmth = $5,
       stress = $6,
       energy = $7,
       as_of = $8,
       version = version + 1,
       updated_at = NOW()
     WHERE instance_id = $1`,
    [
      instance.id,
      nextAffect.valence,
      nextAffect.arousal,
      nextAffect.dominance,
      nextAffect.warmth,
      nextAffect.stress,
      nextAffect.energy,
      now.toISOString()
    ]
  )
  await client.query(
    `UPDATE relationship_states SET
       unresolved_tension = $2,
       as_of = $3,
       version = version + 1,
       updated_at = NOW()
     WHERE instance_id = $1`,
    [instance.id, nextTension, now.toISOString()]
  )
  await client.query(
    `UPDATE simulation_cursors SET
       current_activity = $2,
       activity_started_at = CASE WHEN $3 THEN $4 ELSE activity_started_at END,
       last_simulated_at = $4,
       next_wakeup_at = $5,
       version = version + 1,
       updated_at = NOW()
     WHERE instance_id = $1`,
    [
      instance.id,
      activity,
      activityChanged,
      now.toISOString(),
      new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    ]
  )
}

const appendEvent = async (client: PoolClient, input: EventInput) => {
  const sequenceResult = await client.query(
    `UPDATE character_instances
     SET event_sequence = event_sequence + 1,
         last_interaction_at = CASE WHEN $2 = 'user' THEN $3 ELSE last_interaction_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING event_sequence`,
    [input.instanceId, input.actorRole, input.occurredAt || new Date()]
  )
  const sequence = Number(sequenceResult.rows[0]?.event_sequence || 1)
  const eventId = uuidv4()
  const occurredAt = input.occurredAt || new Date()
  const payload = input.payload || {}
  await client.query(
    `INSERT INTO domain_events (
       id, instance_id, user_id, character_id, conversation_id, message_id,
       sequence_no, event_type, schema_version, actor_role, actor_id,
       occurred_at, source, confidence, payload, causation_id, correlation_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10,
       $11, $12, $13, $14::jsonb, $15, $16
     )`,
    [
      eventId,
      input.instanceId,
      input.userId,
      input.characterId,
      input.conversationId || null,
      input.messageId || null,
      sequence,
      input.eventType,
      input.actorRole,
      input.actorId || null,
      occurredAt,
      input.source || 'application',
      input.confidence ?? null,
      JSON.stringify(payload),
      input.causationId || null,
      input.correlationId || eventId
    ]
  )
  await client.query(
    `INSERT INTO outbox_records (id, event_id, topic, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [uuidv4(), eventId, `character.${input.eventType}`, JSON.stringify({ eventId, ...payload })]
  )
  return { id: eventId, sequence }
}

const appraiseText = (text: string): Appraisal => {
  const lowered = text.toLowerCase()
  const positiveSocialPhrases = ['thanks', 'thank you', 'appreciate you', 'love you', 'you are great', "you're great", 'good job', 'congratulations']
  const directedNegativeWords = ['stupid', 'useless', 'idiot', 'terrible', 'hate you']
  const positive = positiveSocialPhrases.filter(phrase => lowered.includes(phrase)).length
  const bereavement = /\b(?:passed|pass)\s+away\b|\b(?:died|death|funeral|bereaved|grieving)\b/i.test(text)
  const distress = bereavement || /\b(?:devastated|heartbroken|crying|lonely|scared|afraid|anxious|overwhelmed|hurt|upset|sad)\b/i.test(text)
  const directedConflict = /\b(?:you|your)\b[^.!?\n]{0,60}\b(?:pissed me off|hurt me|angered me|upset me|not listening|ignored me)\b/i.test(text)
    || /\b(?:angry|mad|pissed|disappointed)\s+(?:at|with)\s+you\b/i.test(text)
  const negative = directedNegativeWords.filter(word => lowered.includes(word)).length + (directedConflict ? 1 : 0)
  const apology = lowered.includes('sorry') || lowered.includes('apologize') || lowered.includes('my fault')
  const selfDisclosure = distress || /\b(i am|i'm|my name is|i live|i work|i like|i love|i want|i was|my family|my mother|my father|my grandfather|my grandmother)\b/i.test(text)
  const question = text.includes('?')
  const urgency = /\b(urgent|emergency|asap|immediately|help)\b/i.test(text)
  const relationshipReasons: string[] = ['interaction_recorded']
  const affectReasons: string[] = []

  if (selfDisclosure) relationshipReasons.push('self_disclosure')
  if (positive > 0) {
    relationshipReasons.push('positive_social_signal')
    affectReasons.push('positive_language')
  }
  if (negative > 0) {
    relationshipReasons.push('directed_conflict')
    affectReasons.push('relational_tension')
  }
  if (distress) {
    relationshipReasons.push('personal_distress_disclosed')
    affectReasons.push('empathic_attention_needed')
  }
  if (bereavement) {
    relationshipReasons.push('bereavement_disclosed')
    affectReasons.push('grief_context')
  }
  if (apology) {
    relationshipReasons.push('repair_attempt')
    affectReasons.push('repair_attempt')
  }
  if (question) affectReasons.push('conversation_activation')
  if (urgency) affectReasons.push('urgency_signal')

  return {
    positive,
    negative,
    apology: apology ? 1 : 0,
    selfDisclosure,
    question,
    urgency,
    distress,
    bereavement,
    directedConflict,
    relationshipReasons,
    affectReasons
  }
}

const applyAppraisal = async (
  client: PoolClient,
  instanceId: string,
  eventId: string,
  appraisal: Appraisal,
  now: Date
) => {
  const relationshipResult = await client.query(
    `SELECT * FROM relationship_states WHERE instance_id = $1 FOR UPDATE`,
    [instanceId]
  )
  const affectResult = await client.query(
    `SELECT * FROM affect_states WHERE instance_id = $1 FOR UPDATE`,
    [instanceId]
  )
  const relationship = mapRelationship(relationshipResult.rows[0])
  const affect = mapAffect(affectResult.rows[0])
  const positive = clamp(appraisal.positive, 0, 3)
  const negative = clamp(appraisal.negative, 0, 3)
  const nextRelationship = {
    familiarity: clamp(relationship.familiarity + 0.012 + (appraisal.selfDisclosure ? 0.012 : 0), 0, 1),
    trust: clamp(relationship.trust + (appraisal.apology ? 0.018 : 0) - negative * 0.012, 0, 1),
    affinity: clamp(relationship.affinity + positive * 0.012 - negative * 0.018, 0, 1),
    respect: clamp(relationship.respect + (appraisal.selfDisclosure ? 0.004 : 0) - negative * 0.008, 0, 1),
    reciprocity: clamp(relationship.reciprocity + 0.008 + (positive > 0 ? 0.006 : 0), 0, 1),
    boundaryComfort: clamp(relationship.boundaryComfort + (negative === 0 ? 0.002 : -0.012), 0, 1),
    unresolvedTension: clamp(relationship.unresolvedTension + negative * 0.04 - appraisal.apology * 0.055, 0, 1)
  }
  const nextRelationshipWithBond = {
    ...nextRelationship,
    bondStrength: clamp(
      relationship.bondStrength
        + 0.003
        + (appraisal.selfDisclosure ? 0.003 : 0)
        + positive * 0.004
        - negative * 0.01,
      0,
      1
    )
  }
  const nextAffect = {
    valence: clamp(affect.valence + positive * 0.055 - negative * 0.075 - (appraisal.distress ? 0.025 : 0) + appraisal.apology * 0.02, -1, 1),
    arousal: clamp(affect.arousal + (appraisal.question ? 0.025 : 0) + (appraisal.urgency ? 0.08 : 0) + negative * 0.025 + (appraisal.distress ? 0.015 : 0), 0, 1),
    dominance: clamp(affect.dominance - negative * 0.02, -1, 1),
    warmth: clamp(affect.warmth + positive * 0.045 - negative * 0.04 + (appraisal.distress ? 0.03 : 0) + appraisal.apology * 0.018, -1, 1),
    stress: clamp(affect.stress + negative * 0.035 + (appraisal.urgency ? 0.06 : 0) + (appraisal.distress ? 0.015 : 0) - appraisal.apology * 0.018, 0, 1),
    energy: clamp(affect.energy - (appraisal.urgency ? 0.015 : 0), 0, 1)
  }

  await client.query(
    `UPDATE relationship_states SET
       familiarity = $2,
       trust = $3,
       affinity = $4,
       respect = $5,
       reciprocity = $6,
       boundary_comfort = $7,
       unresolved_tension = $8,
       bond_strength = $9,
       version = version + 1,
       as_of = $10,
       updated_at = NOW()
     WHERE instance_id = $1`,
    [
      instanceId,
      nextRelationshipWithBond.familiarity,
      nextRelationshipWithBond.trust,
      nextRelationshipWithBond.affinity,
      nextRelationshipWithBond.respect,
      nextRelationshipWithBond.reciprocity,
      nextRelationshipWithBond.boundaryComfort,
      nextRelationshipWithBond.unresolvedTension,
      nextRelationshipWithBond.bondStrength,
      now.toISOString()
    ]
  )
  await client.query(
    `UPDATE affect_states SET
       valence = $2,
       arousal = $3,
       dominance = $4,
       warmth = $5,
       stress = $6,
       energy = $7,
       last_event_id = $8,
       version = version + 1,
       as_of = $9,
       updated_at = NOW()
     WHERE instance_id = $1`,
    [
      instanceId,
      nextAffect.valence,
      nextAffect.arousal,
      nextAffect.dominance,
      nextAffect.warmth,
      nextAffect.stress,
      nextAffect.energy,
      eventId,
      now.toISOString()
    ]
  )
}

const extractMemoryCandidates = (text: string) => {
  const patterns: Array<{
    pattern: RegExp
    type: Memory['type']
    label: string
    importance?: number
    confidence?: number
    representation?: Memory['representation']
    halfLifeHours?: number
    sensitivity?: Memory['sensitivity']
    confirmed?: boolean
    metadata?: Record<string, any>
  }> = [
    { pattern: /\b(?:my name is|call me)\s+([^.!?\n]{2,80})/i, type: 'user_profile', label: 'User identity' },
    { pattern: /\b(?:i live in|i work in|i work at|i work as)\s+([^.!?\n]{2,100})/i, type: 'background', label: 'User background' },
    { pattern: /\b(?:i like|i love|i prefer)\s+([^.!?\n]{2,100})/i, type: 'preference', label: 'User preference' },
    { pattern: /\b(?:i want to|i plan to|my goal is to)\s+([^.!?\n]{2,100})/i, type: 'important_fact', label: 'User goal' },
    {
      pattern: /\bmy\s+([a-z][a-z '-]{1,40}?)\s+(?:(?:has|had)\s+)?(?:(?:passed|pass)\s+away|died)\b/i,
      type: 'past_event',
      label: 'Family bereavement',
      importance: 0.9,
      confidence: 0.94,
      representation: 'episodic',
      halfLifeHours: 8760,
      sensitivity: 'sensitive',
      confirmed: true,
      metadata: { emotionalImportance: 0.95, relationshipImportance: 0.75 }
    }
  ]
  const candidates: Array<{
    type: Memory['type']
    content: string
    label: string
    importance: number
    confidence: number
    representation: Memory['representation']
    halfLifeHours: number
    sensitivity: Memory['sensitivity']
    confirmed: boolean
    metadata: Record<string, any>
  }> = []
  patterns.forEach(({ pattern, type, label, ...policy }) => {
    const match = text.match(pattern)
    if (!match?.[1]) return
    const value = match[1].trim().replace(/\s+/g, ' ')
    if (value.length < 2 || /\bnot\b/i.test(value)) return
    candidates.push({
      type,
      content: `${label}: ${value}`,
      label,
      importance: policy.importance ?? 0.62,
      confidence: policy.confidence ?? 0.78,
      representation: policy.representation ?? 'semantic',
      halfLifeHours: policy.halfLifeHours ?? 720,
      sensitivity: policy.sensitivity ?? 'normal',
      confirmed: policy.confirmed ?? false,
      metadata: policy.metadata || {}
    })
  })
  return candidates
}

const storeMemoryCandidates = async (
  client: PoolClient,
  userId: string,
  characterId: string,
  messageId: string,
  eventId: string,
  text: string,
  now: Date
) => {
  for (const candidate of extractMemoryCandidates(text)) {
    const duplicate = await client.query(
      `SELECT id FROM memories
       WHERE user_id = $1 AND character_id = $2 AND LOWER(content) = LOWER($3)
       LIMIT 1`,
      [userId, characterId, candidate.content]
    )
    if (duplicate.rows[0]) {
      await client.query(
        `UPDATE memories SET
           retrieval_strength = LEAST(1, retrieval_strength + 0.08),
           last_accessed_at = $2,
           last_updated_at = $2
         WHERE id = $1`,
        [duplicate.rows[0].id, now.toISOString()]
      )
      await client.query(
        `INSERT INTO memory_evidence (id, memory_id, event_id, message_id, evidence_type, excerpt)
         VALUES ($1, $2, $3, $4, 'repetition', $5)`,
        [uuidv4(), duplicate.rows[0].id, eventId, messageId, text.slice(0, 500)]
      )
      continue
    }

    const memoryId = uuidv4()
    await client.query(
      `INSERT INTO memories (
         id, user_id, character_id, origin_message_id, type, content,
         importance_score, confidence, created_at, last_updated_at, metadata,
         representation, retention_tier, retrieval_strength, half_life_hours,
         sensitivity, valid_from, confirmed
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10::jsonb,
         $11, 'durable', $7, $12, $13, $9, $14
       )`,
      [
        memoryId,
        userId,
        characterId,
        messageId,
        candidate.type,
        candidate.content,
        candidate.importance,
        candidate.confidence,
        now.toISOString(),
        JSON.stringify({
          source: 'behavioral_extractor_v2',
          label: candidate.label,
          ...candidate.metadata
        }),
        candidate.representation,
        candidate.halfLifeHours,
        candidate.sensitivity,
        candidate.confirmed
      ]
    )
    await client.query(
      `INSERT INTO memory_evidence (id, memory_id, event_id, message_id, evidence_type, excerpt)
       VALUES ($1, $2, $3, $4, 'assertion', $5)`,
      [uuidv4(), memoryId, eventId, messageId, text.slice(0, 500)]
    )
  }
}

const loadSnapshot = async (
  client: PoolClient,
  instance: CharacterInstance
): Promise<BehaviorSnapshot> => {
  const relationshipResult = await client.query(
    'SELECT * FROM relationship_states WHERE instance_id = $1',
    [instance.id]
  )
  const affectResult = await client.query(
    'SELECT * FROM affect_states WHERE instance_id = $1',
    [instance.id]
  )
  const simulationResult = await client.query(
    'SELECT * FROM simulation_cursors WHERE instance_id = $1',
    [instance.id]
  )
  const eventsResult = await client.query(
    `SELECT id, event_type, occurred_at, payload
     FROM domain_events
     WHERE instance_id = $1
     ORDER BY occurred_at DESC, sequence_no DESC
     LIMIT 40`,
    [instance.id]
  )
  const relationship = mapRelationship(relationshipResult.rows[0])
  const affect = mapAffect(affectResult.rows[0])
  const simulation = mapSimulation(simulationResult.rows[0])
  return {
    instance,
    relationship,
    affect,
    simulation,
    recentEvents: eventsResult.rows.map(row => ({
      id: row.id,
      eventType: row.event_type,
      occurredAt: iso(row.occurred_at)!,
      payload: row.payload || {}
    })),
    emotionLabel: emotionLabel(affect, relationship)
  }
}

export const prepareInteraction = async ({
  userId,
  character,
  conversationId,
  messageId,
  message,
  contentJson,
  mode = 'practice',
  now = new Date()
}: {
  userId: string
  character: Character
  conversationId: string
  messageId: string
  message: string
  contentJson?: Record<string, any>
  mode?: InteractionMode
  now?: Date
}): Promise<InteractionPreparation> => {
  return withTransaction(async client => {
    const instance = await ensureInstance(client, userId, character, mode)
    await client.query(
      `INSERT INTO messages (
         id, conversation_id, sender_role, sender_id, content, content_json, created_at
       ) VALUES ($1, $2, 'user', $3, $4, $5::jsonb, $6)`,
      [
        messageId,
        conversationId,
        userId,
        message,
        contentJson ? JSON.stringify(contentJson) : null,
        now.toISOString()
      ]
    )
    await client.query(
      `UPDATE conversations SET
         character_instance_id = $2,
         last_message_at = $3,
         updated_at = $3
       WHERE id = $1 AND user_id = $4 AND character_id = $5`,
      [conversationId, instance.id, now.toISOString(), userId, character.id]
    )
    await advanceState(client, instance, character, now)
    const appraisal = appraiseText(message)
    const event = await appendEvent(client, {
      instanceId: instance.id,
      userId,
      characterId: character.id,
      conversationId,
      messageId,
      eventType: 'user_message_received',
      actorRole: 'user',
      actorId: userId,
      payload: {
        length: message.length,
        question: appraisal.question,
        urgency: appraisal.urgency,
        distress: appraisal.distress,
        bereavement: appraisal.bereavement,
        directedConflict: appraisal.directedConflict,
        selfDisclosure: appraisal.selfDisclosure,
        relationshipReasons: appraisal.relationshipReasons,
        affectReasons: appraisal.affectReasons
      },
      occurredAt: now,
      source: 'chat'
    })
    await applyAppraisal(client, instance.id, event.id, appraisal, now)
    const consentResult = await client.query(
      `SELECT CASE
         WHEN consent_flags ->> 'memoryPersonalization' = 'false' THEN FALSE
         ELSE TRUE
       END AS enabled
       FROM users
       WHERE id = $1`,
      [userId]
    )
    const memoryEnabled = Boolean(consentResult.rows[0]?.enabled)
    if (memoryEnabled) {
      await storeMemoryCandidates(client, userId, character.id, messageId, event.id, message, now)
    }

    const action = 'reply_now'
    const reasons = mode === 'practice'
      ? ['practice_mode_guarantees_response', 'incoming_message']
      : ['incoming_message', 'interactive_request', 'availability_policy']
    const decisionId = uuidv4()
    await client.query(
      `INSERT INTO decision_records (
         id, instance_id, conversation_id, trigger_event_id, mode, action,
         reason_codes, score_details, due_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
      [
        decisionId,
        instance.id,
        conversationId,
        event.id,
        mode,
        action,
        JSON.stringify(reasons),
        JSON.stringify({
          practiceGuarantee: mode === 'practice',
          currentActivity: 'evaluated',
          memoryPersonalization: memoryEnabled
        }),
        now.toISOString()
      ]
    )
    const refreshedInstanceResult = await client.query(
      'SELECT * FROM character_instances WHERE id = $1',
      [instance.id]
    )
    const snapshot = await loadSnapshot(client, mapInstance(refreshedInstanceResult.rows[0]))
    return { snapshot, triggerEventId: event.id, decisionId, appraisal, mode, memoryEnabled }
  })
}

export const recordAssistantResponse = async ({
  userId,
  character,
  conversationId,
  messageId,
  decisionId,
  triggerEventId,
  mode = 'practice',
  content,
  inference,
  generation,
  diagnostics,
  now = new Date()
}: {
  userId: string
  character: Character
  conversationId: string
  messageId: string
  decisionId?: string
  triggerEventId?: string
  mode?: InteractionMode
  content: string
  inference: InferencePlan
  generation?: {
    provider?: string
    model?: string
    profile?: string
    parameters?: Record<string, any>
    contextManifest?: Record<string, any>
    diagnostics?: Record<string, any>
    latencyMs?: number
  }
  diagnostics?: InferenceDiagnostics
  now?: Date
}) => {
  return withTransaction(async client => {
    const instance = await ensureInstance(client, userId, character, mode)
    await client.query(
      `INSERT INTO messages (
         id, conversation_id, sender_role, sender_id, content, created_at
       ) VALUES ($1, $2, 'assistant', $3, $4, $5)`,
      [messageId, conversationId, character.id, content, now.toISOString()]
    )
    await client.query(
      `UPDATE conversations SET
         character_instance_id = $2,
         last_message_at = $3,
         updated_at = $3
       WHERE id = $1 AND user_id = $4 AND character_id = $5`,
      [conversationId, instance.id, now.toISOString(), userId, character.id]
    )
    const event = await appendEvent(client, {
      instanceId: instance.id,
      userId,
      characterId: character.id,
      conversationId,
      messageId,
      eventType: 'assistant_message_committed',
      actorRole: 'character',
      actorId: character.id,
      payload: { length: content.length, mode, inferenceRoute: inference.route },
      occurredAt: now,
      source: 'chat'
    })
    await client.query(
      `UPDATE relationship_states SET
         familiarity = LEAST(1, familiarity + 0.004),
         reciprocity = LEAST(1, reciprocity + 0.003),
         version = version + 1,
         as_of = $2,
         updated_at = NOW()
       WHERE instance_id = $1`,
      [instance.id, now.toISOString()]
    )
    const latencyMs = generation?.latencyMs == null
      ? 0
      : Math.max(0, Math.round(generation.latencyMs))
    await client.query(
      `INSERT INTO inference_records (
         id, instance_id, conversation_id, decision_id, trigger_event_id,
         output_message_id, mode, route, reason_codes, policy_version,
         provider, model, profile, parameters, response_style, context_manifest,
         diagnostics, status, latency_ms, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
         $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, 'completed', $18, $19
       )`,
      [
        inference.id,
        instance.id,
        conversationId,
        decisionId || null,
        triggerEventId || null,
        messageId,
        mode,
        inference.route,
        JSON.stringify(inference.reasonCodes),
        inference.policyVersion,
        generation?.provider || inference.model?.provider || null,
        generation?.model || inference.model?.model || null,
        inference.model?.profile || inference.responseStyle.profile,
        JSON.stringify(inference.parameters),
        JSON.stringify(inference.responseStyle),
        JSON.stringify({ assistantEventId: event.id, ...inference.contextManifest }),
        JSON.stringify(diagnostics || {}),
        latencyMs,
        now.toISOString()
      ]
    )
    if (generation && inference.route === 'model') {
      await client.query(
        `INSERT INTO generation_records (
           id, instance_id, message_id, decision_id, inference_id, mode, provider, model,
           profile, parameters, context_manifest, diagnostics, latency_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)`,
        [
          uuidv4(),
          instance.id,
          messageId,
          decisionId || null,
          inference.id,
          mode,
          generation.provider || inference.model?.provider || null,
          generation.model || inference.model?.model || null,
          generation.profile || inference.model?.profile || 'default',
          JSON.stringify(generation.parameters || inference.parameters),
          JSON.stringify(generation.contextManifest || inference.contextManifest),
          JSON.stringify(generation.diagnostics || {}),
          latencyMs
        ]
      )
    }
    return event.id
  })
}

export const recordInferenceFailure = async ({
  userId,
  character,
  conversationId,
  decisionId,
  triggerEventId,
  mode = 'practice',
  inference,
  diagnostics,
  latencyMs = 0
}: {
  userId: string
  character: Character
  conversationId: string
  decisionId?: string
  triggerEventId?: string
  mode?: InteractionMode
  inference: InferencePlan
  diagnostics?: InferenceDiagnostics
  latencyMs?: number
}) => {
  return withTransaction(async client => {
    const instance = await ensureInstance(client, userId, character, mode)
    await client.query(
      `INSERT INTO inference_records (
         id, instance_id, conversation_id, decision_id, trigger_event_id,
         output_message_id, mode, route, reason_codes, policy_version,
         provider, model, profile, parameters, response_style, context_manifest,
         diagnostics, status, latency_ms, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, NULL, $6, $7, $8::jsonb, $9, $10, $11, $12,
         $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, 'failed', $17, $18
       )`,
      [
        inference.id,
        instance.id,
        conversationId,
        decisionId || null,
        triggerEventId || null,
        mode,
        inference.route,
        JSON.stringify([...inference.reasonCodes, 'provider_failure']),
        inference.policyVersion,
        inference.model?.provider || null,
        inference.model?.model || null,
        inference.model?.profile || inference.responseStyle.profile,
        JSON.stringify(inference.parameters),
        JSON.stringify(inference.responseStyle),
        JSON.stringify(inference.contextManifest),
        JSON.stringify(diagnostics || {}),
        Math.max(0, Math.round(latencyMs)),
        new Date().toISOString()
      ]
    )
  })
}

export const getBehaviorSnapshot = async (
  userId: string,
  character: Character,
  mode?: InteractionMode
) => {
  return withTransaction(async client => {
    const instance = await ensureInstance(client, userId, character, mode)
    await advanceState(client, instance, character, new Date())
    const refreshed = await client.query('SELECT * FROM character_instances WHERE id = $1', [instance.id])
    return loadSnapshot(client, mapInstance(refreshed.rows[0]))
  })
}

export const resetBehaviorState = async (userId: string, characterId: string) => {
  const result = await query(
    `DELETE FROM character_instances
     WHERE user_id = $1 AND character_id = $2`,
    [userId, characterId]
  )
  return result.rowCount || 0
}
