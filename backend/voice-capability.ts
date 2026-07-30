import net from 'node:net'
import { Dispatcher, ProxyAgent } from 'undici'

export type VoiceInputMode = 'cloud' | 'local'

type CheckStatus = 'ready' | 'failed' | 'not_configured'

export type VoiceCapability = {
  mode: VoiceInputMode
  checkedAt: string
  checks: {
    mihomo: CheckStatus
    node: CheckStatus
    groq: CheckStatus
  }
}

type MihomoGroup = {
  now?: unknown
  all?: unknown
}

type VoiceCapabilityConfiguration = {
  apiKey?: string
  controllerSecret?: string
  controllerUrl?: string
  groupName?: string
  nodeSearchLimit: number
  proxyUrl?: string
  groqUrl: string
}

type VoiceCapabilityDependencies = {
  checkMihomo?: (proxyUrl: string) => Promise<void>
  checkGroq?: (input: { apiKey: string; proxyUrl: string; url: string }) => Promise<boolean>
  getGroup?: (input: { controllerSecret?: string; controllerUrl: string; groupName: string }) => Promise<MihomoGroup>
  now?: () => Date
  selectNode?: (input: {
    controllerSecret?: string
    controllerUrl: string
    groupName: string
    nodeName: string
  }) => Promise<void>
}

const controllerTimeoutMs = 3_000
const groqTimeoutMs = 6_000
const mihomoTimeoutMs = 2_500
const proxyAgents = new Map<string, Dispatcher>()

const getConfiguration = (environment: NodeJS.ProcessEnv): VoiceCapabilityConfiguration => {
  const parsedLimit = Number.parseInt(environment.MIHOMO_NODE_SEARCH_LIMIT || '6', 10)
  return {
    apiKey: environment.GROQ_API_KEY?.trim() || undefined,
    controllerSecret: environment.MIHOMO_CONTROLLER_SECRET?.trim() || undefined,
    controllerUrl: environment.MIHOMO_CONTROLLER_URL?.trim().replace(/\/+$/, '') || undefined,
    groupName: environment.MIHOMO_PROXY_GROUP?.trim() || undefined,
    nodeSearchLimit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 12) : 6,
    proxyUrl: (environment.MIHOMO_PROXY_URL || environment.GROQ_PROXY_URL)?.trim() || undefined,
    groqUrl: environment.GROQ_TRANSCRIPTION_URL?.trim()
      ? environment.GROQ_TRANSCRIPTION_URL.replace(/\/audio\/transcriptions$/, '/models')
      : 'https://api.groq.com/openai/v1/models',
  }
}

const getProxyDispatcher = (proxyUrl: string) => {
  const existing = proxyAgents.get(proxyUrl)
  if (existing) return existing
  const dispatcher = new ProxyAgent(proxyUrl)
  proxyAgents.set(proxyUrl, dispatcher)
  return dispatcher
}

const withTimeout = async <T>(timeoutMs: number, work: (signal: AbortSignal) => Promise<T>) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timeout)
  }
}

const defaultCheckMihomo = async (proxyUrl: string) => {
  const target = new URL(proxyUrl)
  if (target.protocol !== 'http:' || !target.hostname) {
    throw new Error('Mihomo proxy URL must use HTTP')
  }
  const port = Number(target.port || 80)
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: target.hostname, port })
    const timeout = setTimeout(() => socket.destroy(new Error('Mihomo connection timed out')), mihomoTimeoutMs)
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.once('connect', () => finish())
    socket.once('error', error => finish(error))
  })
}

const controllerHeaders = (secret?: string) => ({
  Accept: 'application/json',
  ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
})

const defaultGetGroup = async (input: {
  controllerSecret?: string
  controllerUrl: string
  groupName: string
}) => withTimeout(controllerTimeoutMs, async signal => {
  const response = await fetch(
    `${input.controllerUrl}/proxies/${encodeURIComponent(input.groupName)}`,
    { headers: controllerHeaders(input.controllerSecret), signal }
  )
  if (!response.ok) throw new Error(`Mihomo controller returned ${response.status}`)
  return response.json() as Promise<MihomoGroup>
})

const defaultSelectNode = async (input: {
  controllerSecret?: string
  controllerUrl: string
  groupName: string
  nodeName: string
}) => {
  await withTimeout(controllerTimeoutMs, async signal => {
    const response = await fetch(
      `${input.controllerUrl}/proxies/${encodeURIComponent(input.groupName)}`,
      {
        method: 'PUT',
        headers: {
          ...controllerHeaders(input.controllerSecret),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: input.nodeName }),
        signal,
      }
    )
    if (!response.ok) throw new Error(`Mihomo node selection returned ${response.status}`)
  })
}

const defaultCheckGroq = async (input: { apiKey: string; proxyUrl: string; url: string }) => {
  const response = await withTimeout(groqTimeoutMs, signal => fetch(input.url, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    dispatcher: getProxyDispatcher(input.proxyUrl),
    signal,
  } as RequestInit))
  await response.body?.cancel().catch(() => undefined)
  return response.ok
}

const candidateNodeNames = (group: MihomoGroup, currentNode: string | undefined, limit: number) => {
  const all = Array.isArray(group.all)
    ? group.all.filter((value): value is string => typeof value === 'string')
    : []
  const isInternationalNode = (value: string) => (
    /(?:美国|英国|新加坡|日本|United States|United Kingdom|Singapore|Japan|🇺🇸|🇬🇧|🇸🇬|🇯🇵)/iu.test(value)
    && !/(?:自动选择|故障转移|剩余流量|套餐到期|auto|fallback|traffic|expiry)/iu.test(value)
  )
  return [...new Set([currentNode, ...all.filter(isInternationalNode)].filter(Boolean) as string[])]
    .slice(0, limit)
}

const unavailable = (checkedAt: string, checks: VoiceCapability['checks']): VoiceCapability => ({
  mode: 'local',
  checkedAt,
  checks,
})

export const probeVoiceCapability = async (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: VoiceCapabilityDependencies = {}
): Promise<VoiceCapability> => {
  const config = getConfiguration(environment)
  const checkedAt = (dependencies.now || (() => new Date()))().toISOString()
  const checks: VoiceCapability['checks'] = {
    mihomo: 'not_configured',
    node: 'not_configured',
    groq: 'not_configured',
  }
  if (!config.proxyUrl || !config.controllerUrl || !config.groupName || !config.apiKey) {
    return unavailable(checkedAt, checks)
  }

  try {
    await (dependencies.checkMihomo || defaultCheckMihomo)(config.proxyUrl)
    checks.mihomo = 'ready'
  } catch (error) {
    checks.mihomo = 'failed'
    console.warn('Voice capability Mihomo probe failed', {
      error: error instanceof Error ? error.name : 'unknown_error',
    })
    return unavailable(checkedAt, checks)
  }

  let group: MihomoGroup
  try {
    group = await (dependencies.getGroup || defaultGetGroup)({
      controllerSecret: config.controllerSecret,
      controllerUrl: config.controllerUrl,
      groupName: config.groupName,
    })
    checks.node = 'ready'
  } catch (error) {
    checks.node = 'failed'
    console.warn('Voice capability Mihomo controller probe failed', {
      error: error instanceof Error ? error.name : 'unknown_error',
    })
    return unavailable(checkedAt, checks)
  }

  const checkGroq = dependencies.checkGroq || defaultCheckGroq
  const checkInput = { apiKey: config.apiKey, proxyUrl: config.proxyUrl, url: config.groqUrl }
  try {
    if (await checkGroq(checkInput)) {
      checks.groq = 'ready'
      return { mode: 'cloud', checkedAt, checks }
    }
  } catch {
    // A failed current route is followed by a bounded candidate search below.
  }

  const selectNode = dependencies.selectNode || defaultSelectNode
  const currentNode = typeof group.now === 'string' ? group.now : undefined
  for (const nodeName of candidateNodeNames(group, currentNode, config.nodeSearchLimit)) {
    try {
      await selectNode({
        controllerSecret: config.controllerSecret,
        controllerUrl: config.controllerUrl,
        groupName: config.groupName,
        nodeName,
      })
      if (await checkGroq(checkInput)) {
        checks.groq = 'ready'
        return { mode: 'cloud', checkedAt, checks }
      }
    } catch {
      // Try the next bounded candidate. Failure details remain server-side.
    }
  }

  checks.groq = 'failed'
  console.warn('Voice capability Groq probe failed after Mihomo node search')
  return unavailable(checkedAt, checks)
}

let inFlightProbe: Promise<VoiceCapability> | undefined

export const getVoiceCapability = () => {
  if (!inFlightProbe) {
    inFlightProbe = probeVoiceCapability().finally(() => {
      inFlightProbe = undefined
    })
  }
  return inFlightProbe
}
