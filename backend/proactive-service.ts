import {
  claimDueProactiveAction,
  ProactiveActionClaim,
  recordAssistantResponse,
  recordInferenceFailure,
  rescheduleProactiveAction
} from './behavior'
import {
  buildProactiveInferencePlan,
  diagnoseInferenceOutput,
  InferencePlan
} from './inference-orchestrator'
import { createInferenceTrace, InferenceDiagnostics } from './inference-logger'
import { generateModelResponse, ModelGatewayError } from './model-gateway'
import { newId } from './repository'

const REJECTED_OUTPUT_LOG_LIMIT = 4000

export type ProactiveDelivery = {
  messageId: string
  conversationId: string
  characterId: string
  content: string
  replySegments: string[]
  createdAt: string
}

const recordFailure = async ({
  claim,
  inference,
  diagnostics,
  latencyMs,
  failureReason
}: {
  claim: ProactiveActionClaim
  inference: InferencePlan
  diagnostics: InferenceDiagnostics
  latencyMs: number
  failureReason: string
}) => {
  await recordInferenceFailure({
    userId: claim.userId,
    character: claim.character,
    conversationId: claim.conversationId,
    decisionId: claim.decisionId,
    triggerEventId: claim.triggerEventId,
    mode: 'companion',
    inference,
    diagnostics,
    latencyMs,
    failureReason
  })
  await rescheduleProactiveAction({ claim })
}

const processClaim = async (claim: ProactiveActionClaim): Promise<ProactiveDelivery | undefined> => {
  const trace = createInferenceTrace(`proactive:${claim.triggerEventId}`)
  trace.mark('proactive_action_claimed', 'started', {
    userId: claim.userId,
    characterId: claim.character.id,
    conversationId: claim.conversationId,
    unansweredCount: claim.unansweredCount,
    proactiveAttempt: claim.proactiveAttempt,
    topicDomains: claim.policy.topicDomains,
    activity: claim.snapshot.simulation.currentActivity
  })
  const inference = await buildProactiveInferencePlan({
    userId: claim.userId,
    character: claim.character,
    conversationId: claim.conversationId,
    triggerEventId: claim.triggerEventId,
    snapshot: claim.snapshot,
    memoryEnabled: claim.memoryEnabled,
    topicDomains: claim.policy.topicDomains,
    unansweredCount: claim.unansweredCount
  })
  trace.mark('inference_plan_built', 'completed', {
    inferenceId: inference.id,
    trigger: inference.trigger,
    route: inference.route,
    provider: inference.model?.provider || null,
    model: inference.model?.model || null,
    responseLanguage: inference.responseLanguage.code,
    estimatedContextTokens: inference.contextManifest.estimatedTokens
  })

  const startedAt = Date.now()
  let rawReply = ''
  let generation: {
    provider?: string
    model?: string
    profile?: string
    parameters?: Record<string, any>
    contextManifest?: Record<string, any>
    diagnostics?: Record<string, any>
    latencyMs?: number
  } | undefined
  try {
    const result = await generateModelResponse(inference, claim.character, trace)
    rawReply = result.content
    generation = {
      provider: result.provider,
      model: result.model,
      profile: inference.model?.profile,
      parameters: {
        ...inference.parameters,
        maxResponseTokens: result.diagnostics.maxResponseTokens
      },
      contextManifest: inference.contextManifest,
      diagnostics: result.diagnostics,
      latencyMs: result.latencyMs
    }
  } catch (error) {
    trace.mark('proactive_generation_failed', 'failed', {
      stage: 'provider_request',
      error: error instanceof ModelGatewayError
        ? error.message
        : error instanceof Error ? error.name : 'unknown_error'
    })
    await recordFailure({
      claim,
      inference,
      diagnostics: trace.snapshot(),
      latencyMs: Date.now() - startedAt,
      failureReason: 'provider_failure'
    })
    return undefined
  }

  const outputDiagnostics = diagnoseInferenceOutput(inference, rawReply)
  const { reply, deliverySegments, ...traceOutputDiagnostics } = outputDiagnostics
  if (!outputDiagnostics.languageCompliant && reply) {
    trace.mark('language_policy_observed', 'completed', outputDiagnostics.languageObservation)
  }
  trace.mark('output_processed', 'completed', traceOutputDiagnostics)
  if (!outputDiagnostics.accepted || !reply) {
    const failureReason = outputDiagnostics.rejectionReason || 'output_rejected'
    trace.mark('proactive_response_not_generated', 'failed', { reason: failureReason })
    await recordFailure({
      claim,
      inference,
      diagnostics: {
        ...trace.snapshot(),
        rejectedOutput: {
          content: rawReply.slice(0, REJECTED_OUTPUT_LOG_LIMIT),
          originalLength: rawReply.length,
          truncated: rawReply.length > REJECTED_OUTPUT_LOG_LIMIT,
          languageReason: outputDiagnostics.languageReason,
          rejectionReason: failureReason
        }
      },
      latencyMs: generation?.latencyMs ?? Date.now() - startedAt,
      failureReason
    })
    return undefined
  }

  const replySegments = deliverySegments.length > 0 ? deliverySegments : [reply]
  const createdAt = new Date()
  const messageId = newId()
  const committedEventId = await recordAssistantResponse({
    userId: claim.userId,
    character: claim.character,
    conversationId: claim.conversationId,
    messageId,
    decisionId: claim.decisionId,
    triggerEventId: claim.triggerEventId,
    mode: 'companion',
    content: reply,
    contentJson: {
      origin: 'proactive',
      deliverySegments: replySegments,
      proactive: {
        attempt: claim.proactiveAttempt,
        topicDomains: claim.policy.topicDomains,
        triggerEventId: claim.triggerEventId
      }
    },
    origin: 'proactive',
    proactiveAttempt: claim.proactiveAttempt,
    expectedLatestMessageId: claim.anchorMessageId,
    inference,
    generation,
    diagnostics: trace.snapshot(),
    now: createdAt
  })
  if (!committedEventId) {
    trace.mark('proactive_delivery_cancelled', 'skipped', {
      reason: 'conversation_advanced_during_generation'
    })
    await recordFailure({
      claim,
      inference,
      diagnostics: trace.snapshot(),
      latencyMs: generation?.latencyMs ?? Date.now() - startedAt,
      failureReason: 'conversation_advanced'
    })
    return undefined
  }

  trace.mark('proactive_delivery_completed', 'completed', {
    messageId,
    conversationId: claim.conversationId,
    eventId: committedEventId,
    replyLength: reply.length,
    deliverySegmentCount: replySegments.length
  })
  return {
    messageId,
    conversationId: claim.conversationId,
    characterId: claim.character.id,
    content: reply,
    replySegments,
    createdAt: createdAt.toISOString()
  }
}

export const processDueProactiveActions = async ({
  userId,
  limit = 3,
  now
}: {
  userId?: string
  limit?: number
  now?: Date
} = {}): Promise<ProactiveDelivery[]> => {
  const deliveries: ProactiveDelivery[] = []
  const boundedLimit = Math.max(1, Math.min(10, Math.round(limit)))
  for (let index = 0; index < boundedLimit; index += 1) {
    const claim = await claimDueProactiveAction({ userId, now })
    if (!claim) break
    try {
      const delivery = await processClaim(claim)
      if (delivery) deliveries.push(delivery)
    } catch (error) {
      console.error('Proactive action failed unexpectedly', error)
      await rescheduleProactiveAction({ claim }).catch(rescheduleError => {
        console.error('Could not reschedule proactive action', rescheduleError)
      })
    }
  }
  return deliveries
}
