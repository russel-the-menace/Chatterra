import assert from 'node:assert/strict'
import { translateText } from './translation-service'

const originalFetch = globalThis.fetch
const originalApiKey = process.env.DEEPSEEK_API_KEY
const originalApiMode = process.env.DEEPSEEK_API_MODE
const originalApiUrl = process.env.DEEPSEEK_API_URL

const run = async () => {
  let requestBody: any
  try {
    process.env.DEEPSEEK_API_KEY = 'test-key'
    process.env.DEEPSEEK_API_MODE = 'live'
    process.env.DEEPSEEK_API_URL = 'https://provider.invalid/chat/completions'
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || '{}'))
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: 'What are you doing at home?' }
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const result = await translateText('你而家喺屋企做緊咩？', 'English')
    assert.equal(result.text, 'What are you doing at home?')
    assert.equal(result.provider, 'deepseek')
    assert.equal(requestBody.temperature, 0)
    assert.equal(requestBody.top_p, 1)
    assert.equal(requestBody.stream, false)
    assert.match(requestBody.messages[1].content, /你而家喺屋企做緊咩/)
    assert.match(requestBody.messages[1].content, /English/)

    const retryRequestBodies: any[] = []
    globalThis.fetch = (async (_input, init) => {
      retryRequestBodies.push(JSON.parse(String(init?.body || '{}')))
      const response = retryRequestBodies.length === 1
        ? {
            choices: [{
              finish_reason: 'length',
              message: { content: '' }
            }]
          }
        : {
            choices: [{
              finish_reason: 'stop',
              message: { content: [{ type: 'text', text: 'Hello, how are you?' }] }
            }]
          }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch

    const retried = await translateText('Hola, ¿cómo estás?', 'Chinese')
    assert.equal(retried.text, 'Hello, how are you?')
    assert.equal(retryRequestBodies.length, 2)
    assert.equal(retryRequestBodies[0].max_tokens, 256)
    assert.equal(retryRequestBodies[1].max_tokens, 1024)
    console.log('translation service checks passed')
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = originalApiKey
    if (originalApiMode === undefined) delete process.env.DEEPSEEK_API_MODE
    else process.env.DEEPSEEK_API_MODE = originalApiMode
    if (originalApiUrl === undefined) delete process.env.DEEPSEEK_API_URL
    else process.env.DEEPSEEK_API_URL = originalApiUrl
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
