import assert from 'node:assert/strict'
import { probeVoiceCapability } from './voice-capability'

const environment = {
  GROQ_API_KEY: 'test-key',
  MIHOMO_CONTROLLER_URL: 'http://mihomo.internal:9090',
  MIHOMO_PROXY_GROUP: 'proxy-group',
  MIHOMO_PROXY_URL: 'http://mihomo.internal:7890',
  MIHOMO_NODE_SEARCH_LIMIT: '3',
}

const run = async () => {
  const selected: string[] = []
  let groqChecks = 0
  const recovered = await probeVoiceCapability(environment, {
    now: () => new Date('2026-07-30T00:00:00.000Z'),
    checkMihomo: async () => undefined,
    getGroup: async () => ({
      now: 'current route',
      all: ['current route', 'Hong Kong', 'United Kingdom route', 'United States route'],
    }),
    selectNode: async ({ nodeName }) => {
      selected.push(nodeName)
    },
    checkGroq: async () => {
      groqChecks += 1
      return groqChecks === 2
    },
  })
  assert.equal(recovered.mode, 'cloud')
  assert.deepEqual(recovered.checks, { mihomo: 'ready', node: 'ready', groq: 'ready' })
  assert.deepEqual(selected, ['current route'])

  const noMihomo = await probeVoiceCapability(environment, {
    now: () => new Date('2026-07-30T00:00:00.000Z'),
    checkMihomo: async () => {
      throw new Error('not listening')
    },
  })
  assert.equal(noMihomo.mode, 'local')
  assert.deepEqual(noMihomo.checks, { mihomo: 'failed', node: 'not_configured', groq: 'not_configured' })

  const missingConfiguration = await probeVoiceCapability({}, {
    now: () => new Date('2026-07-30T00:00:00.000Z'),
  })
  assert.equal(missingConfiguration.mode, 'local')
  assert.deepEqual(missingConfiguration.checks, {
    mihomo: 'not_configured',
    node: 'not_configured',
    groq: 'not_configured',
  })
  console.log('voice capability checks passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
