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

import { API_BASE_URL, api } from './api'
import {
  getOrCreateUserId,
  getStoredComposerQuoteDrafts,
  getStoredConversationCache,
  removeStoredConversationCache,
  saveStoredComposerQuoteDrafts,
  saveStoredConversationCache,
} from './storage'
import {
  Character,
  ChatMessage,
  ComposerQuoteDraft,
  ConversationHistoryCache,
} from './types'

type ConversationCacheEntry = ConversationHistoryCache

const MAX_PERSISTED_CONVERSATION_MESSAGES = 1_000

type ChatContextValue = {
  apiBaseUrl: string
  ready: boolean
  userId: string | null
  characters: Character[]
  connectionError: string | null
  proactivePreviews: Record<string, string>
  unreadCharacterIds: Set<string>
  conversationVersions: Record<string, number>
  conversationIdsByCharacter: Record<string, string | null>
  pinnedCharacterIds: Set<string>
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
  refreshCharacters: () => Promise<void>
  saveCharacter: (character: Character | Omit<Character, 'id'>) => Promise<Character>
  markCharacterRead: (characterId: string) => void
  setActiveCharacter: (characterId: string | null) => void
  setCharacterPinned: (characterId: string, pinned: boolean) => Promise<void>
  getConversationCache: (characterId: string) => ConversationCacheEntry | undefined
  hydrateConversationCache: (characterId: string) => Promise<ConversationCacheEntry | undefined>
  setConversationCache: (characterId: string, entry: ConversationCacheEntry) => void
  clearConversationCache: (characterId: string) => void
}

const ChatContext = createContext<ChatContextValue | null>(null)

const messageForError = (error: unknown) => (
  error instanceof Error ? error.message : 'Could not load Chatterra.'
)

const persistQuoteDrafts = async (drafts: Record<string, ComposerQuoteDraft>) => {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await saveStoredComposerQuoteDrafts(drafts)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const cursorForMessage = (message: ChatMessage) => (
  message.createdAt
    ? {
        createdAt: message.createdAt,
        id: message.sourceMessageId || message.id,
      }
    : undefined
)

const persistentConversationEntry = (entry: ConversationCacheEntry): ConversationCacheEntry => {
  const messages = entry.messages.slice(-MAX_PERSISTED_CONVERSATION_MESSAGES)
  const trimmed = messages.length < entry.messages.length
  const oldestMessageCursor = trimmed
    ? cursorForMessage(messages[0]) || entry.oldestMessageCursor
    : entry.oldestMessageCursor

  return {
    ...entry,
    messages,
    hasMoreHistory: entry.hasMoreHistory || trimmed,
    oldestMessageCursor,
  }
}

export function ChatProvider({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [quoteDrafts, setQuoteDrafts] = useState<Record<string, ComposerQuoteDraft>>({})
  const [proactivePreviews, setProactivePreviews] = useState<Record<string, string>>({})
  const [unreadCharacterIds, setUnreadCharacterIds] = useState<Set<string>>(() => new Set())
  const [conversationVersions, setConversationVersions] = useState<Record<string, number>>({})
  const [conversationIdsByCharacter, setConversationIdsByCharacter] = useState<Record<string, string | null>>({})
  const [pinnedCharacterIds, setPinnedCharacterIds] = useState<Set<string>>(() => new Set())
  const activeCharacterRef = useRef<string | null>(null)
  const conversationCacheRef = useRef<Map<string, ConversationCacheEntry>>(new Map())
  const conversationCacheDirtyRef = useRef<Map<string, ConversationCacheEntry>>(new Map())
  const conversationCacheTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const conversationCacheWriteRef = useRef<Map<string, Promise<void>>>(new Map())
  const pollingRef = useRef(false)
  const workspaceSyncingRef = useRef(false)
  const hasWorkspaceSnapshotRef = useRef(false)
  const conversationMetadataRef = useRef<Map<string, string>>(new Map())
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)
  const quoteDraftsRef = useRef<Record<string, ComposerQuoteDraft>>({})
  const quoteDraftWriteRef = useRef<Promise<void>>(Promise.resolve())
  const quoteDraftDirtyRef = useRef<Record<string, ComposerQuoteDraft> | null>(null)

  const flushQuoteDraftPersistence = useCallback(async () => {
    const pending = quoteDraftDirtyRef.current
    if (!pending) return
    try {
      await persistQuoteDrafts(pending)
      if (quoteDraftDirtyRef.current === pending) quoteDraftDirtyRef.current = null
    } catch (error) {
      console.warn('Could not persist Quote draft; it will be retried.', error)
    }
  }, [])

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

  const refreshCharacters = useCallback(async () => {
    try {
      const nextCharacters = await api.listCharacters()
      setCharacters(nextCharacters)
      setConnectionError(null)
    } catch (error) {
      const message = messageForError(error)
      setConnectionError(message)
      throw error
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [storedUserId, storedQuoteDrafts] = await Promise.all([
          getOrCreateUserId(),
          getStoredComposerQuoteDrafts().catch(() => ({})),
        ])
        if (cancelled) return
        setUserId(storedUserId)
        quoteDraftsRef.current = storedQuoteDrafts
        setQuoteDrafts(storedQuoteDrafts)
        const [pinnedIds] = await Promise.all([
          api.listPinnedCharacterIds(storedUserId),
          refreshCharacters(),
        ])
        if (!cancelled) setPinnedCharacterIds(new Set(pinnedIds))
      } catch {
        // The contacts screen exposes the connection error and retry action.
      } finally {
        if (!cancelled) setReady(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [refreshCharacters])

  const syncWorkspace = useCallback(async () => {
    if (!userId || workspaceSyncingRef.current || appStateRef.current !== 'active') return
    workspaceSyncingRef.current = true
    try {
      const snapshot = await api.getSyncSnapshot(userId)
      setCharacters(snapshot.characters)
      setPinnedCharacterIds(new Set(snapshot.pinnedCharacterIds))
      setConnectionError(null)

      const newestConversationByCharacter = new Map<string, typeof snapshot.conversations[number]>()
      snapshot.conversations.forEach(conversation => {
        if (!newestConversationByCharacter.has(conversation.characterId)) {
          newestConversationByCharacter.set(conversation.characterId, conversation)
        }
      })

      const nextConversationIds: Record<string, string | null> = {}
      const nextMetadata = new Map<string, string>()
      const changedCharacterIds = new Set<string>()
      const nextPreviews: Record<string, string> = {}

      snapshot.characters.forEach(character => {
        const conversation = newestConversationByCharacter.get(character.id)
        nextConversationIds[character.id] = conversation?.id || null
        if (conversation?.latestMessage?.content) {
          nextPreviews[character.id] = conversation.latestMessage.content
        }
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

      if (hasWorkspaceSnapshotRef.current && changedCharacterIds.size > 0) {
        changedCharacterIds.forEach(characterId => {
          const cached = conversationCacheRef.current.get(characterId)
          const nextConversationId = nextConversationIds[characterId] || null
          if (cached && cached.conversationId !== nextConversationId) {
            conversationCacheRef.current.delete(characterId)
          }
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
  }, [characters.length, userId])

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
    const saved = 'id' in character && character.id
      ? await api.updateCharacter(character as Character)
      : await api.createCharacter(character as Omit<Character, 'id'>)
    setCharacters(current => {
      const exists = current.some(item => item.id === saved.id)
      return exists
        ? current.map(item => item.id === saved.id ? saved : item)
        : [...current, saved]
    })
    return saved
  }, [])

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

  const setCharacterPinned = useCallback(async (characterId: string, pinned: boolean) => {
    if (!userId) throw new Error('User is not ready.')
    const previous = pinnedCharacterIds.has(characterId)
    setPinnedCharacterIds(current => {
      const next = new Set(current)
      if (pinned) next.add(characterId)
      else next.delete(characterId)
      return next
    })
    try {
      await api.setCharacterPinned(userId, characterId, pinned)
    } catch (error) {
      setPinnedCharacterIds(current => {
        const next = new Set(current)
        if (previous) next.add(characterId)
        else next.delete(characterId)
        return next
      })
      throw error
    }
  }, [pinnedCharacterIds, userId])

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
      if (stored) conversationCacheRef.current.set(characterId, stored)
      return stored
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
    const stableEntry = { ...entry, messages: stableMessages }
    conversationCacheRef.current.set(characterId, stableEntry)
    scheduleConversationCachePersistence(characterId, stableEntry)
  }, [scheduleConversationCachePersistence])

  const clearConversationCache = useCallback((characterId: string) => {
    conversationCacheRef.current.delete(characterId)
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
    characters,
    connectionError,
    proactivePreviews,
    unreadCharacterIds,
    conversationVersions,
    conversationIdsByCharacter,
    pinnedCharacterIds,
    getDraft,
    setDraft,
    getQuoteDraft,
    setQuoteDraft,
    refreshCharacters,
    saveCharacter,
    markCharacterRead,
    setActiveCharacter,
    setCharacterPinned,
    getConversationCache,
    hydrateConversationCache,
    setConversationCache,
    clearConversationCache,
  }), [
    characters,
    connectionError,
    conversationVersions,
    conversationIdsByCharacter,
    clearConversationCache,
    getDraft,
    getQuoteDraft,
    getConversationCache,
    hydrateConversationCache,
    markCharacterRead,
    proactivePreviews,
    pinnedCharacterIds,
    ready,
    refreshCharacters,
    saveCharacter,
    setActiveCharacter,
    setCharacterPinned,
    setConversationCache,
    setDraft,
    setQuoteDraft,
    unreadCharacterIds,
    userId,
  ])

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export const useChat = () => {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat must be used inside ChatProvider')
  return value
}
