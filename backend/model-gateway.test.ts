import assert from 'node:assert/strict'
import { createInferenceTrace } from './inference-logger'
import { InferencePlan } from './inference-orchestrator'
import {
  generateModelResponse,
  getEmptyTruncationRetryTokens,
  shouldRetryEmptyTruncatedResponse
} from './model-gateway'
import { Character } from './types'

const plan = {
  route: 'model',
  model: {
    provider: 'deepseek',
    model: 'test-reasoning-model',
    tier: 'primary',
    profile: 'practice_primary'
  },
  messages: [{ role: 'user', content: 'I am not in a good mood. sorry' }],
  parameters: {
    temperature: 0.7,
    topP: 0.95,
    maxResponseTokens: 340
  }
} as InferencePlan

const character = {
  id: 'c2',
  name: 'English Teacher',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
} as Character

const originalFetch = globalThis.fetch
const originalApiKey = process.env.DEEPSEEK_API_KEY
const originalApiUrl = process.env.DEEPSEEK_API_URL
const requestBodies: any[] = []
const providerResponses = [
  {
    id: 'first-attempt',
    choices: [{
      finish_reason: 'length',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: 'hidden reasoning that consumed the first output budget'
      }
    }],
    usage: { prompt_tokens: 1013, completion_tokens: 340, total_tokens: 1353 }
  },
  {
    id: 'second-attempt',
    choices: [{
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: "I'm sorry you're having a rough time. You don't need to apologize."
      }
    }],
    usage: { prompt_tokens: 1013, completion_tokens: 420, total_tokens: 1433 }
  }
]

const run = async () => {
  try {
    process.env.DEEPSEEK_API_KEY = 'test-key'
    process.env.DEEPSEEK_API_URL = 'https://provider.invalid/chat/completions'
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body || '{}')))
      const body = providerResponses.shift()
      assert.ok(body, 'unexpected provider request')
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch

    const trace = createInferenceTrace('model-gateway-test')
    const result = await generateModelResponse(plan, character, trace)
    const events = trace.snapshot().events
    const parsedResponses = events.filter(event => event.stage === 'provider_response_parsed')

    assert.equal(getEmptyTruncationRetryTokens(340), 1024)
    assert.equal(requestBodies.length, 2)
    assert.equal(requestBodies[0].max_tokens, 340)
    assert.equal(requestBodies[1].max_tokens, 1024)
    assert.equal(parsedResponses.length, 2)
    assert.equal(parsedResponses[0].details?.finishReason, 'length')
    assert.ok(Number(parsedResponses[0].details?.reasoningContentLength) > 0)
    assert.equal(parsedResponses[0].details?.completionTokens, 340)
    assert.equal(events.some(event => event.stage === 'provider_retry_scheduled'), true)
    assert.equal(events.some(event => event.stage === 'provider_retry_completed'), true)
    assert.equal(result.diagnostics.attempt, 2)
    assert.equal(result.diagnostics.maxResponseTokens, 1024)
    assert.equal(result.content, "I'm sorry you're having a rough time. You don't need to apologize.")
    assert.equal(shouldRetryEmptyTruncatedResponse(result), false)

    console.log('model gateway retry checks passed')
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = originalApiKey
    if (originalApiUrl === undefined) delete process.env.DEEPSEEK_API_URL
    else process.env.DEEPSEEK_API_URL = originalApiUrl
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
