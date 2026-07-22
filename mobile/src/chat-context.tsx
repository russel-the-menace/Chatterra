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
import { getOrCreateUserId } from './storage'
import { Character } from './types'

type ChatContextValue = {
  apiBaseUrl: string
  ready: boolean
  userId: string | null
  characters: Character[]
  connectionError: string | null
  proactivePreviews: Record<string, string>
  unreadCharacterIds: Set<string>
  conversationVersions: Record<string, number>
  getDraft: (characterId: string) => string
  setDraft: (characterId: string, draft: string) => void
  refreshCharacters: () => Promise<void>
  saveCharacter: (character: Character | Omit<Character, 'id'>) => Promise<Character>
  markCharacterRead: (characterId: string) => void
  setActiveCharacter: (characterId: string | null) => void
}

const ChatContext = createContext<ChatContextValue | null>(null)

const messageForError = (error: unknown) => (
  error instanceof Error ? error.message : 'Could not load Chatterra.'
)

export function ChatProvider({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [proactivePreviews, setProactivePreviews] = useState<Record<string, string>>({})
  const [unreadCharacterIds, setUnreadCharacterIds] = useState<Set<string>>(() => new Set())
  const [conversationVersions, setConversationVersions] = useState<Record<string, number>>({})
  const activeCharacterRef = useRef<string | null>(null)
  const pollingRef = useRef(false)
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)

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
        const storedUserId = await getOrCreateUserId()
        if (cancelled) return
        setUserId(storedUserId)
        await refreshCharacters()
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

  const setDraft = useCallback((characterId: string, draft: string) => {
    setDrafts(current => {
      if (draft) return { ...current, [characterId]: draft }
      if (!(characterId in current)) return current
      const next = { ...current }
      delete next[characterId]
      return next
    })
  }, [])

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

  const value = useMemo<ChatContextValue>(() => ({
    apiBaseUrl: API_BASE_URL,
    ready,
    userId,
    characters,
    connectionError,
    proactivePreviews,
    unreadCharacterIds,
    conversationVersions,
    getDraft,
    setDraft,
    refreshCharacters,
    saveCharacter,
    markCharacterRead,
    setActiveCharacter,
  }), [
    characters,
    connectionError,
    conversationVersions,
    getDraft,
    markCharacterRead,
    proactivePreviews,
    ready,
    refreshCharacters,
    saveCharacter,
    setActiveCharacter,
    setDraft,
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
