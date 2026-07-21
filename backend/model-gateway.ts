import { Character } from './types'
import { InferencePlan } from './inference-orchestrator'
import { InferenceTrace } from './inference-logger'

export type ModelGatewayDiagnostics = {
  transport: 'mock' | 'http'
  attempt: number
  maxResponseTokens: number
  httpStatus?: number
  responseKeys?: string[]
  messageKeys?: string[]
  choiceCount?: number
  finishReason?: string | null
  contentType?: string
  providerRequestId?: string
  reasoningContentLength?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  extractedTextLength: number
}

export type ModelGatewayResult = {
  content: string
  provider: string
  model: string
  latencyMs: number
  diagnostics: ModelGatewayDiagnostics
}

export class ModelGatewayError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'ModelGatewayError'
    this.statusCode = statusCode
  }
}

const EMPTY_TRUNCATION_RETRY_MIN_TOKENS = 1024
const EMPTY_TRUNCATION_RETRY_MAX_TOKENS = 2048

const contentText = (value: any): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(part => {
      if (typeof part === 'string') return part
      return typeof part?.text === 'string'
        ? part.text
        : typeof part?.content === 'string'
          ? part.content
          : ''
    }).join('')
  }
  return typeof value?.text === 'string' ? value.text : ''
}

const extractText = (data: any) => {
  if (typeof data === 'string') return data
  if (typeof data?.reply === 'string') return data.reply
  if (typeof data?.result === 'string') return data.result
  if (typeof data?.output_text === 'string') return data.output_text
  if (Array.isArray(data?.choices) && data.choices[0]) {
    const first = data.choices[0]
    return contentText(first.message?.content) || contentText(first.text) || contentText(first.output)
  }
  return ''
}

const extractReasoningText = (data: any) => {
  const firstChoice = data?.choices?.[0]
  return contentText(firstChoice?.message?.reasoning_content)
    || contentText(firstChoice?.message?.reasoning)
    || contentText(firstChoice?.reasoning_content)
}

const finiteNumber = (value: any): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const latestUserMessage = (plan: InferencePlan) => {
  return [...plan.messages].reverse().find(message => message.role === 'user')?.content || ''
}

export const shouldRetryEmptyTruncatedResponse = (result: ModelGatewayResult) => {
  const finishReason = String(result.diagnostics.finishReason || '').toLowerCase()
  return result.diagnostics.transport === 'http'
    && !result.content.trim()
    && (finishReason === 'length' || finishReason === 'max_tokens')
}

export const getEmptyTruncationRetryTokens = (initialTokens: number) => {
  return Math.min(
    EMPTY_TRUNCATION_RETRY_MAX_TOKENS,
    Math.max(EMPTY_TRUNCATION_RETRY_MIN_TOKENS, Math.ceil(initialTokens * 2))
  )
}

type ModelGatewayAttemptOptions = {
  attempt: number
  maxResponseTokens: number
}

const generateModelResponseAttempt = async (
  plan: InferencePlan,
  character: Character,
  trace: InferenceTrace | undefined,
  options: ModelGatewayAttemptOptions
): Promise<ModelGatewayResult> => {
  const startedAt = Date.now()
  trace?.mark('provider_request_started', 'started', {
    provider: plan.model.provider,
    model: plan.model.model,
    messageCount: plan.messages.length,
    attempt: options.attempt,
    maxResponseTokens: options.maxResponseTokens
  })
  if (plan.model.provider === 'mock') {
    const incoming = latestUserMessage(plan)
    const grief = /\b(?:passed|pass)\s+away\b|\b(?:died|death|funeral|grieving)\b/i.test(incoming)
    const lossMatch = incoming.match(/\bmy\s+([a-z][a-z '-]{1,40}?)\s+(?:(?:has|had)\s+)?(?:(?:passed|pass)\s+away|died)\b/i)
    const lossAcknowledgement = lossMatch?.[1]
      ? `I'm sorry about your ${lossMatch[1].trim()}.`
      : "I'm sorry for your loss."
    const content = plan.responseLanguage.code === 'cantonese'
      ? plan.responseStyle.turnPriority === 'emotional_support'
        ? '唔好意思，我頭先冇好好聽你講。你想唔想同我講多啲？'
        : plan.mode === 'practice'
          ? '我可以幫你講得自然啲，你想先講邊一部分？'
          : `我聽到喇，${character.name}喺度。你想唔想再講多啲？`
      : plan.responseStyle.turnPriority === 'emotional_support'
        ? grief
          ? `I'm sorry. I focused on correction when you were telling me something painful. That was insensitive. ${lossAcknowledgement} Do you want to tell me about them?`
          : "I'm sorry. I was focused on the wrong thing and did not really listen to what you were saying. Let me slow down. What happened?"
        : plan.mode === 'practice'
          ? `First, a small correction: a more natural way to say that is: "${incoming}" Now tell me a little more.`
          : `(mock) ${character.name}: I heard you. Can you expand on that?`
    const diagnostics: ModelGatewayDiagnostics = {
      transport: 'mock',
      attempt: options.attempt,
      maxResponseTokens: options.maxResponseTokens,
      extractedTextLength: content.length
    }
    trace?.mark('provider_response_parsed', 'completed', diagnostics)
    return {
      content,
      provider: 'mock',
      model: plan.model.model,
      latencyMs: Date.now() - startedAt,
      diagnostics
    }
  }

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new ModelGatewayError('missing API key', 500)

  const url = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions'
  let response: globalThis.Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: plan.model.model,
        messages: plan.messages,
        max_tokens: options.maxResponseTokens,
        temperature: plan.parameters.temperature,
        top_p: plan.parameters.topP,
        stream: false
      })
    })
  } catch (error) {
    console.error('Model provider request failed', error)
    trace?.mark('provider_request', 'failed', {
      attempt: options.attempt,
      error: error instanceof Error ? error.name : 'unknown_error'
    })
    throw new ModelGatewayError('AI provider is unreachable')
  }

  let data: any
  try {
    data = await response.json()
  } catch {
    data = await response.text().catch(() => null)
  }

  if (!response.ok) {
    console.error('Model provider returned error', response.status, data)
    trace?.mark('provider_response', 'failed', {
      attempt: options.attempt,
      httpStatus: response.status,
      responseKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : []
    })
    throw new ModelGatewayError('Upstream AI returned an error')
  }

  const content = extractText(data)
  const firstChoice = data?.choices?.[0]
  const reasoningText = extractReasoningText(data)
  const diagnostics: ModelGatewayDiagnostics = {
    transport: 'http',
    attempt: options.attempt,
    maxResponseTokens: options.maxResponseTokens,
    httpStatus: response.status,
    responseKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    messageKeys: firstChoice?.message && typeof firstChoice.message === 'object'
      ? Object.keys(firstChoice.message).slice(0, 12)
      : [],
    choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
    finishReason: firstChoice?.finish_reason ?? null,
    contentType: firstChoice?.message?.content == null
      ? firstChoice?.text == null ? 'missing' : typeof firstChoice.text
      : Array.isArray(firstChoice.message.content) ? 'array' : typeof firstChoice.message.content,
    providerRequestId: typeof data?.id === 'string' ? data.id.slice(0, 120) : undefined,
    reasoningContentLength: reasoningText.length,
    promptTokens: finiteNumber(data?.usage?.prompt_tokens),
    completionTokens: finiteNumber(data?.usage?.completion_tokens),
    totalTokens: finiteNumber(data?.usage?.total_tokens),
    extractedTextLength: content.length
  }
  if (!content.trim()) {
    console.warn('Model provider returned no assistant text', diagnostics)
  }
  trace?.mark('provider_response_parsed', 'completed', diagnostics)

  return {
    content,
    provider: plan.model.provider,
    model: plan.model.model,
    latencyMs: Date.now() - startedAt,
    diagnostics
  }
}

export const generateModelResponse = async (
  plan: InferencePlan,
  character: Character,
  trace?: InferenceTrace
): Promise<ModelGatewayResult> => {
  if (plan.route !== 'model' || !plan.model) {
    throw new ModelGatewayError('A model route is required', 500)
  }

  const startedAt = Date.now()
  const initialResult = await generateModelResponseAttempt(plan, character, trace, {
    attempt: 1,
    maxResponseTokens: plan.parameters.maxResponseTokens
  })
  if (!shouldRetryEmptyTruncatedResponse(initialResult)) return initialResult

  const retryMaxResponseTokens = getEmptyTruncationRetryTokens(plan.parameters.maxResponseTokens)
  if (retryMaxResponseTokens <= plan.parameters.maxResponseTokens) return initialResult

  trace?.mark('provider_retry_scheduled', 'started', {
    reason: 'empty_content_after_length',
    attempt: 2,
    previousMaxResponseTokens: plan.parameters.maxResponseTokens,
    retryMaxResponseTokens,
    previousCompletionTokens: initialResult.diagnostics.completionTokens,
    previousReasoningContentLength: initialResult.diagnostics.reasoningContentLength
  })
  const retryResult = await generateModelResponseAttempt(plan, character, trace, {
    attempt: 2,
    maxResponseTokens: retryMaxResponseTokens
  })
  trace?.mark('provider_retry_completed', retryResult.content.trim() ? 'completed' : 'failed', {
    attempt: 2,
    maxResponseTokens: retryMaxResponseTokens,
    finishReason: retryResult.diagnostics.finishReason,
    extractedTextLength: retryResult.diagnostics.extractedTextLength,
    reasoningContentLength: retryResult.diagnostics.reasoningContentLength
  })

  return {
    ...retryResult,
    latencyMs: Date.now() - startedAt
  }
}
