import { Character } from './types'
import { InferencePlan } from './inference-orchestrator'

export type ModelGatewayResult = {
  content: string
  provider: string
  model: string
  latencyMs: number
}

export class ModelGatewayError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'ModelGatewayError'
    this.statusCode = statusCode
  }
}

const extractText = (data: any) => {
  if (typeof data === 'string') return data
  if (typeof data?.reply === 'string') return data.reply
  if (typeof data?.result === 'string') return data.result
  if (typeof data?.output_text === 'string') return data.output_text
  if (Array.isArray(data?.choices) && data.choices[0]) {
    const first = data.choices[0]
    return first.message?.content || first.text || first.output || ''
  }
  return ''
}

const latestUserMessage = (plan: InferencePlan) => {
  return [...plan.messages].reverse().find(message => message.role === 'user')?.content || ''
}

export const generateModelResponse = async (
  plan: InferencePlan,
  character: Character
): Promise<ModelGatewayResult> => {
  if (plan.route !== 'model' || !plan.model) {
    throw new ModelGatewayError('A model route is required', 500)
  }

  const startedAt = Date.now()
  if (plan.model.provider === 'mock') {
    const incoming = latestUserMessage(plan)
    const grief = /\b(?:passed|pass)\s+away\b|\b(?:died|death|funeral|grieving)\b/i.test(incoming)
    const lossMatch = incoming.match(/\bmy\s+([a-z][a-z '-]{1,40}?)\s+(?:(?:has|had)\s+)?(?:(?:passed|pass)\s+away|died)\b/i)
    const lossAcknowledgement = lossMatch?.[1]
      ? `I'm sorry about your ${lossMatch[1].trim()}.`
      : "I'm sorry for your loss."
    const content = plan.responseStyle.turnPriority === 'emotional_support'
      ? grief
        ? `I'm sorry. I focused on correction when you were telling me something painful. That was insensitive. ${lossAcknowledgement} Do you want to tell me about them?`
        : "I'm sorry. I was focused on the wrong thing and did not really listen to what you were saying. Let me slow down. What happened?"
      : plan.mode === 'practice'
      ? `First, a small correction: a more natural way to say that is: "${incoming}" Now tell me a little more.`
      : `(mock) ${character.name}: I heard you. Can you expand on that?`
    return {
      content,
      provider: 'mock',
      model: plan.model.model,
      latencyMs: Date.now() - startedAt
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
        max_tokens: plan.parameters.maxResponseTokens,
        temperature: plan.parameters.temperature,
        top_p: plan.parameters.topP,
        stream: false
      })
    })
  } catch (error) {
    console.error('Model provider request failed', error)
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
    throw new ModelGatewayError('Upstream AI returned an error')
  }

  return {
    content: extractText(data),
    provider: plan.model.provider,
    model: plan.model.model,
    latencyMs: Date.now() - startedAt
  }
}
