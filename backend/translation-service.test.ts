import assert from 'node:assert/strict'
import { translateToEnglish } from './translation-service'

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

    const result = await translateToEnglish('你而家喺屋企做緊咩？')
    assert.equal(result.text, 'What are you doing at home?')
    assert.equal(result.provider, 'deepseek')
    assert.equal(requestBody.temperature, 0)
    assert.equal(requestBody.top_p, 1)
    assert.equal(requestBody.stream, false)
    assert.match(requestBody.messages[1].content, /你而家喺屋企做緊咩/)
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
