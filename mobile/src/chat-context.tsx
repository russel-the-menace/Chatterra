import {
  AppState,
  AppStateStatus,
} from 'react-native'
import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { API_BASE_URL, api, setApiAccessToken } from './api'
import {
  clearStoredAuthSession,
  getStoredAuthSession,
  getStoredContactPreviewCache,
  getStoredComposerQuoteDrafts,
  getStoredConversationCache,
  removeStoredConversationCache,
  saveStoredAuthSession,
  saveStoredContactPreviewCache,
  saveStoredComposerQuoteDrafts,
  saveStoredConversationCache,
  StoredAuthSession,
} from './storage'
import {
  Character,
  ComposerQuoteDraft,
  ContactPreviewCache,
  ConversationHistoryCache,
} from './types'
import { buildContactPreviewState } from './contact-preview'
import { mergeMessagePage } from './message-page-merge'

type ConversationCacheEntry = ConversationHistoryCache

export type ConversationListViewState = {
  contentHeight: number
  offsetY: number
  messageCount: number
  latestMessageKey: string
  followLatest: boolean
  withinImmersiveRange: boolean
}

type ChatContextValue = {
  apiBaseUrl: string
  ready: boolean
  userId: string | null
  username?: string
  userName?: string
  userAvatar?: string
  characters: Character[]
  connectionError: string | null
  voiceInputMode: 'cloud' | 'local'
  proactivePreviews: Record<string, string>
  unreadCharacterIds: Set<string>
  conversationVersions: Record<string, number>
  conversationIdsByCharacter: Record<string, string | null>
  pinnedCharacterIds: Set<string>
  pinnedCharacterOrder: string[]
  lastMessageAtByCharacter: Record<string, string>
  getDraft: (characterId: string) => string
  setDraft: (
    characterId: string,
    update: string | ((current: string) => string)
  ) => void
  getQuoteDraft: (characterId: string) => ComposerQuoteDraft | null
  setQuoteDraft: (
    characterId: string,
    update: ComposerQuoteDraft | null | (
      (current: ComposerQuoteDraft | null) => ComposerQuoteDraft | null
    )
  ) => void
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refreshCharacters: (requestedUserId?: string) => Promise<void>
  saveCharacter: (character: Character | Omit<Character, 'id'>) => Promise<Character>
  saveBuiltInCharacterAvatar: (characterId: string, avatar: string) => Promise<Character>
  saveUserAvatar: (avatar: string) => Promise<void>
  saveUserProfile: (input: { displayName: string; avatar?: string }) => Promise<void>
  markCharacterRead: (characterId: string) => void
  setActiveCharacter: (characterId: string | null) => void
  setCharacterPinned: (characterId: string, pinned: boolean) => Promise<void>
  markConversationActive: (characterId: string, timestamp?: string) => void
  getConversationCache: (characterId: string) => ConversationCacheEntry | undefined
  hydrateConversationCache: (characterId: string) => Promise<ConversationCacheEntry | undefined>
  setConversationCache: (characterId: string, entry: ConversationCacheEntry) => void
  getConversationListViewState: (characterId: string) => ConversationListViewState | undefined
  setConversationListViewState: (characterId: string, state: ConversationListViewState) => void
  clearConversationCache: (characterId: string) => void
  markCloudVoiceUnavailable: () => void
}

const ChatContext = createContext<ChatContextValue | null>(null)

const messageForError = (error: unknown) => (
  error instanceof Error ? error.message : 'Could not load Chatterra.'
)

const persistQuoteDrafts = async (
  userId: string,
  drafts: Record<string, ComposerQuoteDraft>
) => {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await saveStoredComposerQuoteDrafts(userId, drafts)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const persistentConversationEntry = (entry: ConversationCacheEntry): ConversationCacheEntry => {
  const messages = entry.messages
    .map(({ voiceTranscriptVisible: _voiceTranscriptVisible, ...message }) => message)

  return {
    ...entry,
    messages,
  }
}

const sameStringRecord = (
  left: Record<string, string | null>,
  right: Record<string, string | null>
) => {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => left[key] === right[key])
}

const sameContactPreviewCache = (left: ContactPreviewCache, right: ContactPreviewCache) => (
  sameStringRecord(left.previews, right.previews)
  && sameStringRecord(left.conversationIdsByCharacter, right.conversationIdsByCharacter)
  && sameStringRecord(left.lastMessageAtByCharacter, right.lastMessageAtByCharacter)
)

export function ChatProvider({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [username, setUsername] = useState<string | undefined>()
  const [userName, setUserName] = useState<string | undefined>()
  const [userAvatar, setUserAvatar] = useState<string | undefined>()
  const [characters, setCharacters] = useState<Character[]>([])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [voiceInputMode, setVoiceInputMode] = useState<'cloud' | 'local'>('local')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [quoteDrafts, setQuoteDrafts] = useState<Record<string, ComposerQuoteDraft>>({})
  const [proactivePreviews, setProactivePreviews] = useState<Record<string, string>>({})
  const [unreadCharacterIds, setUnreadCharacterIds] = useState<Set<string>>(() => new Set())
  const [conversationVersions, setConversationVersions] = useState<Record<string, number>>({})
  const [conversationIdsByCharacter, setConversationIdsByCharacter] = useState<Record<string, string | null>>({})
  const [pinnedCharacterIds, setPinnedCharacterIds] = useState<Set<string>>(() => new Set())
  const [pinnedCharacterOrder, setPinnedCharacterOrder] = useState<string[]>([])
  const [lastMessageAtByCharacter, setLastMessageAtByCharacter] = useState<Record<string, string>>({})
  const activeCharacterRef = useRef<string | null>(null)
  const conversationCacheRef = useRef<Map<string, ConversationCacheEntry>>(new Map())
  const conversationListViewStateRef = useRef<Map<string, ConversationListViewState>>(new Map())
  const conversationCacheDirtyRef = useRef<Map<string, ConversationCacheEntry>>(new Map())
  const conversationCacheTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const conversationCacheWriteRef = useRef<Map<string, Promise<void>>>(new Map())
  const contactPreviewCacheWriteRef = useRef<Promise<void>>(Promise.resolve())
  const contactPreviewCacheRef = useRef<ContactPreviewCache | null>(null)
  const pollingRef = useRef(false)
  const workspaceSyncingRef = useRef(false)
  const hasWorkspaceSnapshotRef = useRef(false)
  const conversationMetadataRef = useRef<Map<string, string>>(new Map())
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)
  const quoteDraftsRef = useRef<Record<string, ComposerQuoteDraft>>({})
  const quoteDraftWriteRef = useRef<Promise<void>>(Promise.resolve())
  const quoteDraftDirtyRef = useRef<Record<string, ComposerQuoteDraft> | null>(null)
  const sessionRef = useRef<StoredAuthSession | null>(null)

  const resetWorkspaceState = useCallback(() => {
    conversationCacheTimerRef.current.forEach(timer => clearTimeout(timer))
    conversationCacheRef.current.clear()
    conversationListViewStateRef.current.clear()
    conversationCacheDirtyRef.current.clear()
    conversationCacheTimerRef.current.clear()
    conversationCacheWriteRef.current.clear()
    contactPreviewCacheWriteRef.current = Promise.resolve()
    contactPreviewCacheRef.current = null
    conversationMetadataRef.current.clear()
    quoteDraftsRef.current = {}
    quoteDraftDirtyRef.current = null
    activeCharacterRef.current = null
    hasWorkspaceSnapshotRef.current = false
    setCharacters([])
    setDrafts({})
    setQuoteDrafts({})
    setProactivePreviews({})
    setUnreadCharacterIds(new Set())
    setConversationVersions({})
    setConversationIdsByCharacter({})
    setPinnedCharacterIds(new Set())
    setPinnedCharacterOrder([])
    setLastMessageAtByCharacter({})
  }, [])

  const prewarmConversationCaches = useCallback(async (
    accountId: string,
    currentCharacters: Character[]
  ) => {
    const cachedEntries = await Promise.all(currentCharacters.map(async character => {
      try {
        const cache = await getStoredConversationCache(API_BASE_URL, accountId, character.id)
        return cache
          ? [character.id, persistentConversationEntry(cache)] as const
          : undefined
      } catch (error) {
        console.warn('Could not prewarm conversation cache.', { characterId: character.id, error })
        return undefined
      }
    }))

    const warmedCaches = new Map<string, ConversationCacheEntry>()
    cachedEntries.forEach(entry => {
      if (!entry) return
      const current = conversationCacheRef.current.get(entry[0]) || entry[1]
      if (!conversationCacheRef.current.has(entry[0])) {
        conversationCacheRef.current.set(entry[0], current)
      }
      warmedCaches.set(entry[0], current)
    })
    return warmedCaches
  }, [])

  const persistContactPreviewCache = useCallback((accountId: string, cache: ContactPreviewCache) => {
    if (
      contactPreviewCacheRef.current
      && sameContactPreviewCache(contactPreviewCacheRef.current, cache)
    ) return
    contactPreviewCacheRef.current = cache
    const write = contactPreviewCacheWriteRef.current
      .catch(() => undefined)
      .then(() => saveStoredContactPreviewCache(API_BASE_URL, accountId, cache))
      .catch(error => {
        console.warn('Could not persist contact previews.', error)
      })
    contactPreviewCacheWriteRef.current = write
  }, [])

  const refreshVoiceInputCapability = useCallback(async () => {
    try {
      const capability = await api.getVoiceCapability()
      setVoiceInputMode(capability.mode)
    } catch {
      setVoiceInputMode('local')
    }
  }, [])

  const markCloudVoiceUnavailable = useCallback(() => {
    setVoiceInputMode('local')
  }, [])

  useEffect(() => {
    if (!userId) {
      setVoiceInputMode('local')
      return
    }
    void refreshVoiceInputCapability()
  }, [refreshVoiceInputCapability, userId])

  const flushQuoteDraftPersistence = useCallback(async () => {
    const pending = quoteDraftDirtyRef.current
    if (!pending || !userId) return
    try {
      await persistQuoteDrafts(userId, pending)
      if (quoteDraftDirtyRef.current === pending) quoteDraftDirtyRef.current = null
    } catch (error) {
      console.warn('Could not persist Quote draft; it will be retried.', error)
    }
  }, [userId])

  const scheduleQuoteDraftPersistence = useCallback((
    drafts?: Record<string, ComposerQuoteDraft>
  ) => {
    if (drafts) quoteDraftDirtyRef.current = drafts
    quoteDraftWriteRef.current = quoteDraftWriteRef.current
      .catch(() => undefined)
      .then(flushQuoteDraftPersistence)
  }, [flushQuoteDraftPersistence])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' && quoteDraftDirtyRef.current) {
        scheduleQuoteDraftPersistence()
      }
    })
    return () => subscription.remove()
  }, [scheduleQuoteDraftPersistence])

  const refreshCharacters = useCallback(async (requestedUserId?: string) => {
    const id = requestedUserId || userId
    if (!id) throw new Error('User is not ready.')
    try {
      const nextCharacters = await api.listCharacters(id)
      setCharacters(nextCharacters)
      setConnectionError(null)
    } catch (error) {
      const message = messageForError(error)
      setConnectionError(message)
      throw error
    }
  }, [userId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let storedSession: StoredAuthSession | undefined
      let sessionInvalid = false
      try {
        storedSession = await getStoredAuthSession()
        if (!storedSession) return
        if (cancelled) return
        setApiAccessToken(storedSession.accessToken)
        sessionRef.current = storedSession
        const [storedQuoteDrafts, pinnedIds, nextCharacters, storedContactPreviews] = await Promise.all([
          getStoredComposerQuoteDrafts(storedSession.user.id).catch(() => ({})),
          api.listPinnedCharacterIds(storedSession.user.id),
          api.listCharacters(storedSession.user.id),
          getStoredContactPreviewCache(API_BASE_URL, storedSession.user.id).catch(() => undefined),
        ])
        const warmedConversationCaches = await prewarmConversationCaches(
          storedSession.user.id,
          nextCharacters
        )
        if (cancelled) return
        const contactPreviewState = buildContactPreviewState(
          nextCharacters,
          storedContactPreviews,
          warmedConversationCaches
        )
        quoteDraftsRef.current = storedQuoteDrafts
        setQuoteDrafts(storedQuoteDrafts)
        setCharacters(nextCharacters)
        setPinnedCharacterIds(new Set(pinnedIds))
        setPinnedCharacterOrder(pinnedIds)
        setProactivePreviews(contactPreviewState.previews)
        setConversationIdsByCharacter(contactPreviewState.conversationIdsByCharacter)
        setLastMessageAtByCharacter(contactPreviewState.lastMessageAtByCharacter)
        persistContactPreviewCache(storedSession.user.id, {
          ...contactPreviewState,
          cachedAt: Date.now(),
        })
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 401) {
          sessionInvalid = true
          setApiAccessToken()
          sessionRef.current = null
          await clearStoredAuthSession()
          setUserId(null)
          setUsername(undefined)
          setUserName(undefined)
        } else {
          setConnectionError(messageForError(error))
        }
      } finally {
        if (!cancelled && storedSession && !sessionInvalid) {
          setUserId(storedSession.user.id)
          setUsername(storedSession.user.username)
          setUserName(storedSession.user.displayName)
        }
        if (!cancelled) setReady(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [persistContactPreviewCache, prewarmConversationCaches])

  const login = useCallback(async (nextUsername: string, password: string) => {
    const session = await api.login(nextUsername, password)
    const storedSession: StoredAuthSession = {
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      user: session.user,
    }
    setApiAccessToken(storedSession.accessToken)
    sessionRef.current = storedSession
    resetWorkspaceState()
    setUserAvatar(undefined)
    setConnectionError(null)
    await saveStoredAuthSession(storedSession)

    try {
      const [storedQuoteDrafts, pinnedIds, nextCharacters, storedContactPreviews] = await Promise.all([
        getStoredComposerQuoteDrafts(storedSession.user.id).catch(() => ({})),
        api.listPinnedCharacterIds(storedSession.user.id),
        api.listCharacters(storedSession.user.id),
        getStoredContactPreviewCache(API_BASE_URL, storedSession.user.id).catch(() => undefined),
      ])
      const warmedConversationCaches = await prewarmConversationCaches(
        storedSession.user.id,
        nextCharacters
      )
      const contactPreviewState = buildContactPreviewState(
        nextCharacters,
        storedContactPreviews,
        warmedConversationCaches
      )
      quoteDraftsRef.current = storedQuoteDrafts
      setQuoteDrafts(storedQuoteDrafts)
      setPinnedCharacterIds(new Set(pinnedIds))
      setPinnedCharacterOrder(pinnedIds)
      setCharacters(nextCharacters)
      setProactivePreviews(contactPreviewState.previews)
      setConversationIdsByCharacter(contactPreviewState.conversationIdsByCharacter)
      setLastMessageAtByCharacter(contactPreviewState.lastMessageAtByCharacter)
      persistContactPreviewCache(storedSession.user.id, {
        ...contactPreviewState,
        cachedAt: Date.now(),
      })
    } catch (error) {
      setConnectionError(messageForError(error))
    } finally {
      setUserId(storedSession.user.id)
      setUsername(storedSession.user.username)
      setUserName(storedSession.user.displayName)
    }
  }, [persistContactPreviewCache, prewarmConversationCaches, resetWorkspaceState])

  const logout = useCallback(async () => {
    try {
      if (sessionRef.current?.accessToken) await api.logout()
    } catch {
      // The local session must still be cleared if a remote logout cannot complete.
    } finally {
      setApiAccessToken()
      sessionRef.current = null
      await clearStoredAuthSession()
      resetWorkspaceState()
      setUserId(null)
      setUsername(undefined)
      setUserName(undefined)
      setUserAvatar(undefined)
      setConnectionError(null)
    }
  }, [resetWorkspaceState])

  const syncWorkspace = useCallback(async () => {
    if (!userId || workspaceSyncingRef.current || appStateRef.current !== 'active') return
    workspaceSyncingRef.current = true
    try {
      const snapshot = await api.getSyncSnapshot(userId)
      setCharacters(snapshot.characters)
      setUserName(snapshot.userName)
      setUserAvatar(snapshot.userAvatar)
      setPinnedCharacterIds(new Set(snapshot.pinnedCharacterIds))
      setPinnedCharacterOrder(snapshot.pinnedCharacterIds)
      setConnectionError(null)

      const newestConversationByCharacter = new Map<string, typeof snapshot.conversations[number]>()
      snapshot.conversations.forEach(conversation => {
        if (!newestConversationByCharacter.has(conversation.characterId)) {
          newestConversationByCharacter.set(conversation.characterId, conversation)
        }
      })

      const defaultContactPreviewState = buildContactPreviewState(snapshot.characters)
      const nextConversationIds: Record<string, string | null> = {
        ...defaultContactPreviewState.conversationIdsByCharacter,
      }
      const nextMetadata = new Map<string, string>()
      const changedCharacterIds = new Set<string>()
      const nextPreviews: Record<string, string> = { ...defaultContactPreviewState.previews }
      const nextLastMessageAtByCharacter: Record<string, string> = {
        ...defaultContactPreviewState.lastMessageAtByCharacter,
      }

      snapshot.characters.forEach(character => {
        const conversation = newestConversationByCharacter.get(character.id)
        nextConversationIds[character.id] = conversation?.id || null
        if (conversation?.latestMessage?.content) {
          nextPreviews[character.id] = conversation.latestMessage.content
        }
        const lastMessageAt = conversation?.lastMessageAt || conversation?.latestMessage?.createdAt
        if (lastMessageAt) nextLastMessageAtByCharacter[character.id] = lastMessageAt
        if (!conversation) return
        const version = [
          conversation.id,
          conversation.updatedAt,
          conversation.latestMessage?.id || '',
        ].join(':')
        nextMetadata.set(character.id, version)
        if (conversationMetadataRef.current.get(character.id) !== version) {
          changedCharacterIds.add(character.id)
        }
      })

      conversationMetadataRef.current.forEach((_version, characterId) => {
        if (!nextMetadata.has(characterId)) changedCharacterIds.add(characterId)
      })
      conversationMetadataRef.current = nextMetadata
      setConversationIdsByCharacter(nextConversationIds)
      setProactivePreviews(nextPreviews)
      setLastMessageAtByCharacter(nextLastMessageAtByCharacter)
      persistContactPreviewCache(userId, {
        previews: nextPreviews,
        conversationIdsByCharacter: nextConversationIds,
        lastMessageAtByCharacter: nextLastMessageAtByCharacter,
        cachedAt: Date.now(),
      })

      if (hasWorkspaceSnapshotRef.current && changedCharacterIds.size > 0) {
        changedCharacterIds.forEach(characterId => {
          // The chat screen reconciles the newer server page into this cache.
          // A server omission never authorizes discarding local history.
          conversationListViewStateRef.current.delete(characterId)
        })
        setConversationVersions(current => {
          const next = { ...current }
          changedCharacterIds.forEach(characterId => {
            next[characterId] = (next[characterId] || 0) + 1
          })
          return next
        })
        setUnreadCharacterIds(current => {
          const next = new Set(current)
          changedCharacterIds.forEach(characterId => {
            if (characterId !== activeCharacterRef.current) next.add(characterId)
          })
          return next
        })
      }
      hasWorkspaceSnapshotRef.current = true
    } catch (error) {
      if (characters.length === 0) setConnectionError(messageForError(error))
    } finally {
      workspaceSyncingRef.current = false
    }
  }, [characters.length, persistContactPreviewCache, userId])

  useEffect(() => {
    if (!userId) return
    void syncWorkspace()
    const interval = setInterval(() => void syncWorkspace(), 3_000)
    const subscription = AppState.addEventListener('change', nextState => {
      appStateRef.current = nextState
      if (nextState === 'active') void syncWorkspace()
    })
    return () => {
      clearInterval(interval)
      subscription.remove()
    }
  }, [syncWorkspace, userId])

  const pollProactive = useCallback(async () => {
    if (!userId || pollingRef.current || appStateRef.current !== 'active') return
    pollingRef.current = true
    try {
      const deliveries = await api.pollProactive(userId)
      if (!deliveries.length) return

      setProactivePreviews(current => {
        const next = { ...current }
        deliveries.forEach(delivery => {
          if (delivery.characterId && delivery.content) {
            next[delivery.characterId] = delivery.content
          }
        })
        return next
      })
      setLastMessageAtByCharacter(current => {
        const next = { ...current }
        deliveries.forEach(delivery => {
          if (!delivery.characterId) return
          const timestamp = delivery.createdAt || new Date().toISOString()
          if ((next[delivery.characterId] || '') < timestamp) {
            next[delivery.characterId] = timestamp
          }
        })
        return next
      })
      setConversationVersions(current => {
        const next = { ...current }
        deliveries.forEach(delivery => {
          next[delivery.characterId] = (next[delivery.characterId] || 0) + 1
        })
        return next
      })
      setUnreadCharacterIds(current => {
        const next = new Set(current)
        deliveries.forEach(delivery => {
          if (delivery.characterId !== activeCharacterRef.current) {
            next.add(delivery.characterId)
          }
        })
        return next
      })
    } catch {
      // Normal foreground requests surface connection failures to the relevant screen.
    } finally {
      pollingRef.current = false
    }
  }, [userId])

  useEffect(() => {
    if (!userId) return
    void pollProactive()
    const interval = setInterval(() => void pollProactive(), 15_000)
    const subscription = AppState.addEventListener('change', nextState => {
      appStateRef.current = nextState
      if (nextState === 'active') {
        void pollProactive()
        void refreshCharacters().catch(() => undefined)
      }
    })

    return () => {
      clearInterval(interval)
      subscription.remove()
    }
  }, [pollProactive, refreshCharacters, userId])

  const getDraft = useCallback((characterId: string) => drafts[characterId] || '', [drafts])

  const setDraft = useCallback((
    characterId: string,
    update: string | ((current: string) => string)
  ) => {
    setDrafts(current => {
      const draft = typeof update === 'function'
        ? update(current[characterId] || '')
        : update
      if (draft) return { ...current, [characterId]: draft }
      if (!(characterId in current)) return current
      const next = { ...current }
      delete next[characterId]
      return next
    })
  }, [])

  const getQuoteDraft = useCallback((characterId: string) => (
    quoteDrafts[characterId] || null
  ), [quoteDrafts])

  const setQuoteDraft = useCallback((
    characterId: string,
    update: ComposerQuoteDraft | null | (
      (current: ComposerQuoteDraft | null) => ComposerQuoteDraft | null
    )
  ) => {
    const current = quoteDraftsRef.current[characterId] || null
    const value = typeof update === 'function' ? update(current) : update
    const next = { ...quoteDraftsRef.current }
    if (value) next[characterId] = value
    else delete next[characterId]
    quoteDraftsRef.current = next
    setQuoteDrafts(next)
    scheduleQuoteDraftPersistence(next)
  }, [scheduleQuoteDraftPersistence])

  const saveCharacter = useCallback(async (character: Character | Omit<Character, 'id'>) => {
    if (!userId) throw new Error('User is not ready.')
    const saved = 'id' in character && character.id
      ? await api.updateCharacter(userId, character as Character)
      : await api.createCharacter(userId, character as Omit<Character, 'id'>)
    setCharacters(current => {
      const exists = current.some(item => item.id === saved.id)
      return exists
        ? current.map(item => item.id === saved.id ? saved : item)
        : [...current, saved]
    })
    return saved
  }, [userId])

  const saveBuiltInCharacterAvatar = useCallback(async (characterId: string, avatar: string) => {
    if (!userId) throw new Error('User is not ready.')
    const saved = await api.updateBuiltInCharacterAvatar(userId, characterId, avatar)
    setCharacters(current => current.map(character => (
      character.id === saved.id ? saved : character
    )))
    return saved
  }, [userId])

  const saveUserAvatar = useCallback(async (avatar: string) => {
    if (!userId) throw new Error('User is not ready.')
    const result = await api.updateUserAvatar(userId, avatar)
    setUserAvatar(result.userAvatar || avatar)
  }, [userId])

  const saveUserProfile = useCallback(async (input: { displayName: string; avatar?: string }) => {
    if (!userId) throw new Error('User is not ready.')
    const result = await api.updateUserProfile(userId, input)
    setUserName(result.userName || input.displayName)
    if (result.userAvatar || input.avatar) setUserAvatar(result.userAvatar || input.avatar)
    if (sessionRef.current) {
      const nextSession: StoredAuthSession = {
        ...sessionRef.current,
        user: {
          ...sessionRef.current.user,
          displayName: result.userName || input.displayName,
        }
      }
      sessionRef.current = nextSession
      await saveStoredAuthSession(nextSession)
    }
  }, [userId])

  const markCharacterRead = useCallback((characterId: string) => {
    setUnreadCharacterIds(current => {
      if (!current.has(characterId)) return current
      const next = new Set(current)
      next.delete(characterId)
      return next
    })
  }, [])

  const setActiveCharacter = useCallback((characterId: string | null) => {
    activeCharacterRef.current = characterId
    if (characterId) markCharacterRead(characterId)
  }, [markCharacterRead])

  const markConversationActive = useCallback((characterId: string, timestamp = new Date().toISOString()) => {
    setLastMessageAtByCharacter(current => {
      if ((current[characterId] || '') >= timestamp) return current
      return { ...current, [characterId]: timestamp }
    })
  }, [])

  const setCharacterPinned = useCallback(async (characterId: string, pinned: boolean) => {
    if (!userId) throw new Error('User is not ready.')
    const previous = pinnedCharacterIds.has(characterId)
    const previousPinnedOrder = pinnedCharacterOrder
    setPinnedCharacterIds(current => {
      const next = new Set(current)
      if (pinned) next.add(characterId)
      else next.delete(characterId)
      return next
    })
    setPinnedCharacterOrder(current => (
      pinned
        ? [characterId, ...current.filter(id => id !== characterId)]
        : current.filter(id => id !== characterId)
    ))
    try {
      await api.setCharacterPinned(userId, characterId, pinned)
    } catch (error) {
      setPinnedCharacterIds(current => {
        const next = new Set(current)
        if (previous) next.add(characterId)
        else next.delete(characterId)
        return next
      })
      setPinnedCharacterOrder(previousPinnedOrder)
      throw error
    }
  }, [pinnedCharacterIds, pinnedCharacterOrder, userId])

  const flushConversationCache = useCallback(async (characterId: string) => {
    const timer = conversationCacheTimerRef.current.get(characterId)
    if (timer) {
      clearTimeout(timer)
      conversationCacheTimerRef.current.delete(characterId)
    }
    const cache = conversationCacheDirtyRef.current.get(characterId)
    if (!cache || !userId) return
    conversationCacheDirtyRef.current.delete(characterId)

    const previousWrite = conversationCacheWriteRef.current.get(characterId)
    const write = (previousWrite || Promise.resolve())
      .catch(() => undefined)
      .then(() => saveStoredConversationCache(
        API_BASE_URL,
        userId,
        characterId,
        persistentConversationEntry(cache)
      ))
      .catch(error => {
        console.warn('Could not persist conversation cache.', error)
      })
    conversationCacheWriteRef.current.set(characterId, write)
    await write
    if (conversationCacheWriteRef.current.get(characterId) === write) {
      conversationCacheWriteRef.current.delete(characterId)
    }
  }, [userId])

  const scheduleConversationCachePersistence = useCallback((
    characterId: string,
    cache: ConversationCacheEntry
  ) => {
    if (!userId) return
    conversationCacheDirtyRef.current.set(characterId, cache)
    if (conversationCacheTimerRef.current.has(characterId)) return
    const timer = setTimeout(() => {
      void flushConversationCache(characterId)
    }, 250)
    conversationCacheTimerRef.current.set(characterId, timer)
  }, [flushConversationCache, userId])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') return
      conversationCacheDirtyRef.current.forEach((_cache, characterId) => {
        void flushConversationCache(characterId)
      })
    })
    return () => subscription.remove()
  }, [flushConversationCache])

  const getConversationCache = useCallback((characterId: string) => (
    conversationCacheRef.current.get(characterId)
  ), [])

  const hydrateConversationCache = useCallback(async (characterId: string) => {
    const inMemory = conversationCacheRef.current.get(characterId)
    if (inMemory || !userId) return inMemory
    try {
      const stored = await getStoredConversationCache(API_BASE_URL, userId, characterId)
      const normalized = stored ? persistentConversationEntry(stored) : undefined
      if (normalized) conversationCacheRef.current.set(characterId, normalized)
      return normalized
    } catch (error) {
      console.warn('Could not read conversation cache.', error)
      return undefined
    }
  }, [userId])

  const setConversationCache = useCallback((characterId: string, entry: ConversationCacheEntry) => {
    const stableMessages = entry.messages
      .filter(message => !message.loading)
      .map(({
        animateEntry: _animateEntry,
        animationDelayMs: _animationDelayMs,
        translationLoading: _translationLoading,
        translationError: _translationError,
        ...message
      }) => message)
    const existing = conversationCacheRef.current.get(characterId)
    const mergedMessages = existing
      ? mergeMessagePage(existing.messages, stableMessages, 'append')
      : stableMessages
    const stableEntry = {
      ...entry,
      conversationId: entry.conversationId || existing?.conversationId || null,
      messages: mergedMessages,
      hasMoreHistory: Boolean(existing?.hasMoreHistory || entry.hasMoreHistory),
      oldestMessageCursor: entry.oldestMessageCursor || existing?.oldestMessageCursor,
    }
    const cachedViewState = conversationListViewStateRef.current.get(characterId)
    const latestMessage = mergedMessages.at(-1)
    const latestMessageKey = latestMessage?.renderKey || latestMessage?.id
    if (
      cachedViewState
      && (
        cachedViewState.messageCount > mergedMessages.length
        || cachedViewState.latestMessageKey !== latestMessageKey
      )
    ) {
      conversationListViewStateRef.current.delete(characterId)
    }
    conversationCacheRef.current.set(characterId, stableEntry)
    scheduleConversationCachePersistence(characterId, persistentConversationEntry(stableEntry))
  }, [scheduleConversationCachePersistence])

  const getConversationListViewState = useCallback((characterId: string) => (
    conversationListViewStateRef.current.get(characterId)
  ), [])

  const setConversationListViewState = useCallback((
    characterId: string,
    state: ConversationListViewState
  ) => {
    conversationListViewStateRef.current.set(characterId, state)
  }, [])

  const clearConversationCache = useCallback((characterId: string) => {
    conversationCacheRef.current.delete(characterId)
    conversationListViewStateRef.current.delete(characterId)
    conversationCacheDirtyRef.current.delete(characterId)
    const timer = conversationCacheTimerRef.current.get(characterId)
    if (timer) {
      clearTimeout(timer)
      conversationCacheTimerRef.current.delete(characterId)
    }
    if (!userId) return
    const previousWrite = conversationCacheWriteRef.current.get(characterId)
    const remove = (previousWrite || Promise.resolve())
      .catch(() => undefined)
      .then(() => removeStoredConversationCache(API_BASE_URL, userId, characterId))
      .catch(error => {
        console.warn('Could not remove conversation cache.', error)
      })
    conversationCacheWriteRef.current.set(characterId, remove)
  }, [userId])

  const value = useMemo<ChatContextValue>(() => ({
    apiBaseUrl: API_BASE_URL,
    ready,
    userId,
    username,
    userName,
    userAvatar,
    characters,
    connectionError,
    voiceInputMode,
    proactivePreviews,
    unreadCharacterIds,
    conversationVersions,
    conversationIdsByCharacter,
    pinnedCharacterIds,
    pinnedCharacterOrder,
    lastMessageAtByCharacter,
    getDraft,
    setDraft,
    getQuoteDraft,
    setQuoteDraft,
    login,
    logout,
    refreshCharacters,
    saveCharacter,
    saveBuiltInCharacterAvatar,
    saveUserAvatar,
    saveUserProfile,
    markCharacterRead,
    setActiveCharacter,
    setCharacterPinned,
    markConversationActive,
    getConversationCache,
    hydrateConversationCache,
    setConversationCache,
    getConversationListViewState,
    setConversationListViewState,
    clearConversationCache,
    markCloudVoiceUnavailable,
  }), [
    characters,
    connectionError,
    voiceInputMode,
    conversationVersions,
    conversationIdsByCharacter,
    clearConversationCache,
    markCloudVoiceUnavailable,
    getDraft,
    getQuoteDraft,
    login,
    logout,
    getConversationCache,
    getConversationListViewState,
    hydrateConversationCache,
    markCharacterRead,
    proactivePreviews,
    pinnedCharacterIds,
    pinnedCharacterOrder,
    lastMessageAtByCharacter,
    ready,
    refreshCharacters,
    saveCharacter,
    saveBuiltInCharacterAvatar,
    saveUserAvatar,
    saveUserProfile,
    setActiveCharacter,
    setCharacterPinned,
    markConversationActive,
    setConversationCache,
    setConversationListViewState,
    setDraft,
    setQuoteDraft,
    unreadCharacterIds,
    userName,
    userAvatar,
    userId,
    username,
  ])

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export const useChat = () => {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat must be used inside ChatProvider')
  return value
}
