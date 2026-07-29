import React, {useState, useEffect, useMemo, useRef} from 'react'
import ChatWindow from '../components/ChatWindow'
import InputBox from '../components/InputBox'
import { AssistantVoiceMessage, ChatMessage } from '../components/MessageBubble'
import seedCharacter, {characters as seedCharacters, Character} from '../data/character'
import { VoiceTranscriptMetadata } from '../voice/types'
import { starterMessageForCharacter } from '../languagePolicy'
import { CONFIGURED_USER_ID, apiUrl, getSyncSnapshot } from '../api'

type CharacterTextKey = 'name' | 'role' | 'company' | 'scenario' | 'goal' | 'language' | 'personality' | 'background' | 'systemPromptTemplate'
type Point = { x: number; y: number }
type ConversationCacheEntry = {
  conversationId: string | null
  messages: ChatMessage[]
  behaviorStatus: string
}

const makeMessageId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
const hasSameOrder = (left: string[], right: string[]) => (
  left.length === right.length && left.every((value, index) => value === right[index])
)
const hasSameTimestamps = (
  left: Record<string, string>,
  right: Record<string, string>
) => (
  Object.keys(left).length === Object.keys(right).length
  && Object.entries(left).every(([characterId, timestamp]) => right[characterId] === timestamp)
)
const isImageAvatar = (avatar?: string) => Boolean(avatar && /^(data:image\/|blob:|https?:\/\/|\/)/.test(avatar))
const mediaUrl = (value: string) => /^https?:\/\//i.test(value) ? value : apiUrl(value)
const parseAssistantVoiceMessage = (value: unknown): AssistantVoiceMessage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const voice = value as Record<string, unknown>
  if (voice.provider !== 'qwen3-tts' || voice.voiceId !== 'maya') return undefined
  if (voice.status !== 'pending' && voice.status !== 'ready' && voice.status !== 'failed') return undefined
  if (!Number.isInteger(voice.segmentIndex) || Number(voice.segmentIndex) < 0) return undefined
  if (typeof voice.style !== 'string' || !voice.style.trim()) return undefined
  if (voice.audioUrl != null && typeof voice.audioUrl !== 'string') return undefined
  if (voice.durationSeconds != null && (
    typeof voice.durationSeconds !== 'number' || !Number.isFinite(voice.durationSeconds)
  )) return undefined
  return {
    provider: 'qwen3-tts',
    status: voice.status,
    segmentIndex: Number(voice.segmentIndex),
    voiceId: 'maya',
    style: voice.style,
    audioUrl: typeof voice.audioUrl === 'string' ? mediaUrl(voice.audioUrl) : undefined,
    durationSeconds: typeof voice.durationSeconds === 'number' ? voice.durationSeconds : undefined,
    mimeType: voice.mimeType === 'audio/wav' ? 'audio/wav' : undefined,
    generatedAt: typeof voice.generatedAt === 'string' ? voice.generatedAt : undefined,
  }
}
const deliverySegments = (message: any): string[] => {
  const stored = message?.contentJson?.deliverySegments
  if (message?.senderRole === 'assistant' && Array.isArray(stored)) {
    const segments = stored.filter((segment: unknown): segment is string => (
      typeof segment === 'string' && Boolean(segment.trim())
    ))
    if (segments.length > 0) return segments
  }
  return [String(message?.content || '')]
}
const mapServerMessages = (items: any[]): ChatMessage[] => items.flatMap((message: any) => {
  const segments = deliverySegments(message)
  const englishTranslations = message?.contentJson?.translations?.en
  const voice = parseAssistantVoiceMessage(message?.contentJson?.voice)
  return segments.map((text, index) => ({
    id: segments.length === 1 ? String(message.id) : `${String(message.id)}:segment:${index}`,
    sender: message.senderRole === 'user' ? 'user' as const : 'ai' as const,
    text,
    sourceMessageId: String(message.id),
    segmentIndex: index,
    translation: typeof englishTranslations?.[String(index)] === 'string'
      ? englishTranslations[String(index)]
      : undefined,
    translationVisible: typeof englishTranslations?.[String(index)] === 'string',
    voice: voice?.segmentIndex === index ? voice : undefined
  }))
})

const responseMessages = (data: any): ChatMessage[] => {
  const segments = Array.isArray(data.replySegments)
    ? data.replySegments.filter((segment: unknown): segment is string => (
        typeof segment === 'string' && Boolean(segment.trim())
      ))
    : []
  const usable = segments.length > 0 && typeof data.reply === 'string'
    ? segments
    : typeof data.reply === 'string' ? [data.reply] : []
  const baseId = typeof data.messageId === 'string' ? data.messageId : makeMessageId()
  const voice = parseAssistantVoiceMessage(data.voice)
  return usable.map((text, index) => ({
    id: usable.length === 1 ? baseId : `${baseId}:segment:${index}`,
    sender: 'ai',
    text,
    sourceMessageId: typeof data.messageId === 'string' ? data.messageId : undefined,
    segmentIndex: index,
    voice: voice?.segmentIndex === index ? voice : undefined
  }))
}

const mergeMessageUiState = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const currentById = new Map(current.map(message => [message.id, message]))
  return incoming.map(message => {
    const existing = currentById.get(message.id)
    if (!existing) return message
    return {
      ...message,
      translation: existing.translation || message.translation,
      translationVisible: existing.translation !== undefined
        || existing.translationLoading
        || existing.translationError
        ? existing.translationVisible
        : message.translationVisible,
      translationLoading: existing.translationLoading,
      translationError: existing.translationError,
      voiceTranscriptVisible: existing.voiceTranscriptVisible && Boolean(message.voice)
    }
  })
}

const stableMessagesForCache = (messages: ChatMessage[]) => messages
  .filter(message => !message.loading)
  .map(({ translationLoading: _translationLoading, translationError: _translationError, ...message }) => message)

const avatarContent = (character: Pick<Character, 'avatar' | 'name'>) => {
  if (isImageAvatar(character.avatar)) {
    return <img src={character.avatar} alt="" />
  }
  return <span>{character.avatar || character.name.slice(0, 1) || '?'}</span>
}

const editableFields: Array<{
  key: CharacterTextKey
  label: string
  multiline?: boolean
}> = [
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'company', label: 'Company' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'goal', label: 'Goal' },
  { key: 'language', label: 'Language' },
  { key: 'personality', label: 'Personality', multiline: true },
  { key: 'background', label: 'Background', multiline: true },
  { key: 'systemPromptTemplate', label: 'System Prompt Template', multiline: true }
]

const createCharacterDraft = (): Character => ({
  id: '',
  name: '',
  avatar: '',
  role: '',
  company: '',
  scenario: '',
  goal: '',
  language: 'English only',
  personality: '',
  background: '',
  systemPromptTemplate: ''
})

export default function ChatPage(): JSX.Element{
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [userId, setUserIdentifier] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>(seedCharacters)
  const [selectedCharacter, setSelectedCharacter] = useState<Character>(seedCharacter)
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({})
  const [scrollToEndRequest, setScrollToEndRequest] = useState(0)
  const [behaviorStatus, setBehaviorStatus] = useState('Online')
  const [searchText, setSearchText] = useState('')
  const [proactivePreviews, setProactivePreviews] = useState<Record<string, string>>({})
  const [unreadCharacterIds, setUnreadCharacterIds] = useState<Set<string>>(() => new Set())
  const [pinnedCharacterIds, setPinnedCharacterIds] = useState<Set<string>>(() => new Set())
  const [pinnedCharacterOrder, setPinnedCharacterOrder] = useState<string[]>([])
  const [lastMessageAtByCharacter, setLastMessageAtByCharacter] = useState<Record<string, string>>({})
  const [showAddDrawer, setShowAddDrawer] = useState(false)
  const [showConversationMenu, setShowConversationMenu] = useState(false)
  const [showCharacterEditor, setShowCharacterEditor] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null)
  const [isSavingCharacter, setIsSavingCharacter] = useState(false)
  const [characterEditorError, setCharacterEditorError] = useState('')
  const [avatarCropSource, setAvatarCropSource] = useState<string | null>(null)
  const [avatarCropScale, setAvatarCropScale] = useState(1)
  const [avatarCropPosition, setAvatarCropPosition] = useState<Point>({ x: 0, y: 0 })
  const [avatarCropFit, setAvatarCropFit] = useState<'wide' | 'tall'>('tall')
  const [isDraggingAvatar, setIsDraggingAvatar] = useState(false)
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null)
  const avatarCropViewportRef = useRef<HTMLDivElement | null>(null)
  const avatarCropImageRef = useRef<HTMLImageElement | null>(null)
  const avatarDragRef = useRef<{ pointerId: number; pointerX: number; pointerY: number; x: number; y: number } | null>(null)
  const conversationCacheRef = useRef<Record<string, ConversationCacheEntry>>({})
  const conversationMetadataRef = useRef<Record<string, string>>({})
  const hasWorkspaceSnapshotRef = useRef(false)
  const historyRequestRef = useRef(0)
  const selectedCharacterIdRef = useRef(selectedCharacter.id)

  const visibleCharacters = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    return characters
      .map((character, index) => ({ character, index }))
      .filter(({ character }) => !query || (
        [character.name, character.role, character.company, character.personality]
          .join(' ')
          .toLowerCase()
          .includes(query)
      ))
      .sort((left, right) => {
        const leftPinned = pinnedCharacterIds.has(left.character.id)
        const rightPinned = pinnedCharacterIds.has(right.character.id)
        if (leftPinned !== rightPinned) return rightPinned ? 1 : -1
        if (leftPinned && rightPinned) {
          return pinnedCharacterOrder.indexOf(left.character.id) - pinnedCharacterOrder.indexOf(right.character.id)
        }
        const lastMessageComparison = (lastMessageAtByCharacter[right.character.id] || '')
          .localeCompare(lastMessageAtByCharacter[left.character.id] || '')
        if (lastMessageComparison !== 0) return lastMessageComparison
        return left.index - right.index
      })
      .map(({ character }) => character)
  }, [characters, lastMessageAtByCharacter, pinnedCharacterIds, pinnedCharacterOrder, searchText])

  const markCharacterActive = (characterId: string, timestamp = new Date().toISOString()) => {
    setLastMessageAtByCharacter(current => {
      if ((current[characterId] || '') >= timestamp) return current
      return { ...current, [characterId]: timestamp }
    })
  }

  const loadHistoryForCharacter = async (uid: string, nextCharacter: Character) => {
    const requestId = historyRequestRef.current + 1
    historyRequestRef.current = requestId
    const cached = conversationCacheRef.current[nextCharacter.id]
    if (cached) {
      setConversationId(cached.conversationId)
      setMessages(cached.messages)
      setBehaviorStatus(cached.behaviorStatus)
    } else {
      setConversationId(null)
      setMessages([])
    }

    try {
      const cRes = await fetch(apiUrl(`/api/conversations?userId=${uid}`))
      if (!cRes.ok) throw new Error('no convs')

      const cData = await cRes.json()
      const matchingConversation = (cData.conversations || [])
        .filter((conv: any) => conv.characterId === nextCharacter.id)
        .sort((a: any, b: any) => (b.lastMessageAt || b.updatedAt || b.createdAt || '').localeCompare(a.lastMessageAt || a.updatedAt || a.createdAt || ''))[0]

      if (requestId !== historyRequestRef.current || selectedCharacterIdRef.current !== nextCharacter.id) return

      if (matchingConversation) {
        const mRes = await fetch(apiUrl(`/api/conversations/${matchingConversation.id}/messages`))
        const mData = await mRes.json()
        if (requestId !== historyRequestRef.current || selectedCharacterIdRef.current !== nextCharacter.id) return
        const mapped = mergeMessageUiState(cached?.messages || [], mapServerMessages(mData.messages || []))
        setConversationId(matchingConversation.id)
        setMessages(mapped)
        localStorage.setItem('chatterra_conversationId', matchingConversation.id)
        conversationCacheRef.current[nextCharacter.id] = {
          conversationId: matchingConversation.id,
          messages: mapped,
          behaviorStatus: cached?.behaviorStatus || 'Online'
        }
        return
      }
    } catch (e) {
      // fall through to default greeting
    }

    if (requestId !== historyRequestRef.current || selectedCharacterIdRef.current !== nextCharacter.id) return
    if (!cached) {
      const starterMessages: ChatMessage[] = [{
        id: `starter-${nextCharacter.id}`,
        sender: 'ai',
        text: starterMessageForCharacter(nextCharacter)
      }]
      setMessages(starterMessages)
      conversationCacheRef.current[nextCharacter.id] = {
        conversationId: null,
        messages: starterMessages,
        behaviorStatus: 'Online'
      }
    }
  }

  const openCharacterEditor = (character: Character) => {
    setEditingCharacter({ ...character })
    setShowCharacterEditor(true)
    setShowAddDrawer(false)
    setCharacterEditorError('')
  }

  const openNewCharacterEditor = () => {
    setEditingCharacter(createCharacterDraft())
    setShowCharacterEditor(true)
    setShowAddDrawer(false)
    setCharacterEditorError('')
  }

  const closeCharacterEditor = () => {
    if (isSavingCharacter) return
    setShowCharacterEditor(false)
    setEditingCharacter(null)
    setCharacterEditorError('')
  }

  const clampAvatarCropPosition = (position: Point, scale = avatarCropScale): Point => {
    const image = avatarCropImageRef.current
    const viewport = avatarCropViewportRef.current
    if (!image || !viewport || !image.naturalWidth || !image.naturalHeight) return position

    const viewportSize = viewport.clientWidth || 320
    const aspect = image.naturalWidth / image.naturalHeight
    const baseWidth = aspect >= 1 ? viewportSize * aspect : viewportSize
    const baseHeight = aspect >= 1 ? viewportSize : viewportSize / aspect
    const maxX = Math.max(0, (baseWidth * scale - viewportSize) / 2)
    const maxY = Math.max(0, (baseHeight * scale - viewportSize) / 2)

    return {
      x: Math.min(maxX, Math.max(-maxX, position.x)),
      y: Math.min(maxY, Math.max(-maxY, position.y))
    }
  }

  const closeAvatarCropper = () => {
    setAvatarCropSource(null)
    setAvatarCropScale(1)
    setAvatarCropPosition({ x: 0, y: 0 })
    setAvatarCropFit('tall')
    setIsDraggingAvatar(false)
    avatarDragRef.current = null
    if (avatarFileInputRef.current) avatarFileInputRef.current.value = ''
  }

  const handleAvatarFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setCharacterEditorError('Please choose an image file.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setAvatarCropSource(String(reader.result || ''))
      setAvatarCropScale(1)
      setAvatarCropPosition({ x: 0, y: 0 })
      setAvatarCropFit('tall')
      setCharacterEditorError('')
    }
    reader.onerror = () => setCharacterEditorError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  const handleAvatarCropScaleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextScale = Number(event.target.value)
    setAvatarCropScale(nextScale)
    setAvatarCropPosition(prev => clampAvatarCropPosition(prev, nextScale))
  }

  const handleAvatarCropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    avatarDragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: avatarCropPosition.x,
      y: avatarCropPosition.y
    }
    setIsDraggingAvatar(true)
  }

  const handleAvatarCropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = avatarDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    setAvatarCropPosition(clampAvatarCropPosition({
      x: drag.x + event.clientX - drag.pointerX,
      y: drag.y + event.clientY - drag.pointerY
    }))
  }

  const handleAvatarCropPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = avatarDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    avatarDragRef.current = null
    setIsDraggingAvatar(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const applyAvatarCrop = () => {
    const image = avatarCropImageRef.current
    const viewport = avatarCropViewportRef.current
    if (!image || !viewport || !editingCharacter) return

    const imageRect = image.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const sourceX = (viewportRect.left - imageRect.left) * image.naturalWidth / imageRect.width
    const sourceY = (viewportRect.top - imageRect.top) * image.naturalHeight / imageRect.height
    const sourceSize = viewportRect.width * image.naturalWidth / imageRect.width
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) return

    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height)
    const croppedAvatar = canvas.toDataURL('image/jpeg', 0.88)
    setEditingCharacter(prev => prev ? { ...prev, avatar: croppedAvatar } : prev)
    closeAvatarCropper()
  }

  useEffect(() => {
    if (!showCharacterEditor) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (avatarCropSource) {
          closeAvatarCropper()
        } else {
          closeCharacterEditor()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.classList.add('modal-open')

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.classList.remove('modal-open')
    }
  }, [showCharacterEditor, isSavingCharacter, avatarCropSource])

  useEffect(() => {
    let uid = CONFIGURED_USER_ID || localStorage.getItem('chatterra_userId')
    if (!uid) {
      uid = String(Date.now())
    }
    localStorage.setItem('chatterra_userId', uid)
    setUserIdentifier(uid)
    const loadContactPreferences = async () => {
      try {
        const response = await fetch(apiUrl(`/api/users/${encodeURIComponent(uid)}/contact-preferences`))
        if (!response.ok) return
        const data = await response.json()
        if (Array.isArray(data.pinnedCharacterIds)) {
          const pinnedIds = data.pinnedCharacterIds.map(String)
          setPinnedCharacterIds(new Set(pinnedIds))
          setPinnedCharacterOrder(pinnedIds)
        }
      } catch {
        // Contact ordering remains usable while the preference endpoint is unavailable.
      }
    }
    const loadCharacters = async () => {
      try {
        const res = await fetch(apiUrl('/api/characters'))
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.characters) && data.characters.length > 0) {
            setCharacters(data.characters)
            const savedCharacterId = localStorage.getItem('chatterra_characterId')
            const initialCharacter = data.characters.find((c: Character) => c.id === savedCharacterId) || data.characters[0]
            selectedCharacterIdRef.current = initialCharacter.id
            setSelectedCharacter(initialCharacter)
            await loadHistoryForCharacter(uid, initialCharacter)
            return
          }
        }
      } catch (e) {
        // fall back to seed characters below
      }

      const savedCharacterId = localStorage.getItem('chatterra_characterId')
      const initialCharacter = seedCharacters.find(c => c.id === savedCharacterId) || seedCharacter
      selectedCharacterIdRef.current = initialCharacter.id
      setCharacters(seedCharacters)
      setSelectedCharacter(initialCharacter)
      void loadHistoryForCharacter(uid, initialCharacter)
    }

    void loadContactPreferences()
    void loadCharacters()
  }, [])

  useEffect(() => {
    if (!userId) return
    let stopped = false
    let syncing = false

    const syncWorkspace = async () => {
      if (syncing || document.visibilityState === 'hidden') return
      syncing = true
      try {
        const snapshot = await getSyncSnapshot(userId)
        if (stopped) return

        setCharacters(current => {
          const unchanged = current.length === snapshot.characters.length
            && current.every((character, index) => (
              character.id === snapshot.characters[index]?.id
              && character.updatedAt === snapshot.characters[index]?.updatedAt
            ))
          return unchanged ? current : snapshot.characters
        })

        const activeCharacter = snapshot.characters.find(character => (
          character.id === selectedCharacterIdRef.current
        )) || snapshot.characters[0]
        if (activeCharacter) {
          if (selectedCharacterIdRef.current !== activeCharacter.id) {
            selectedCharacterIdRef.current = activeCharacter.id
            localStorage.setItem('chatterra_characterId', activeCharacter.id)
          }
          setSelectedCharacter(current => (
            current.id === activeCharacter.id && current.updatedAt === activeCharacter.updatedAt
              ? current
              : activeCharacter
          ))
        }

        setPinnedCharacterIds(current => {
          const next = new Set(snapshot.pinnedCharacterIds)
          if (current.size === next.size && [...current].every(id => next.has(id))) return current
          return next
        })
        setPinnedCharacterOrder(current => (
          hasSameOrder(current, snapshot.pinnedCharacterIds) ? current : snapshot.pinnedCharacterIds
        ))

        const newestConversationByCharacter = new Map<string, typeof snapshot.conversations[number]>()
        snapshot.conversations.forEach(conversation => {
          if (!newestConversationByCharacter.has(conversation.characterId)) {
            newestConversationByCharacter.set(conversation.characterId, conversation)
          }
        })

        const nextMetadata: Record<string, string> = {}
        const nextPreviews: Record<string, string> = {}
        const nextLastMessageAtByCharacter: Record<string, string> = {}
        const changedCharacterIds = new Set<string>()
        newestConversationByCharacter.forEach((conversation, characterId) => {
          const version = [
            conversation.id,
            conversation.updatedAt,
            conversation.latestMessage?.id || ''
          ].join(':')
          nextMetadata[characterId] = version
          if (conversation.latestMessage?.content) {
            nextPreviews[characterId] = conversation.latestMessage.content
          }
          const lastMessageAt = conversation.lastMessageAt || conversation.latestMessage?.createdAt
          if (lastMessageAt) nextLastMessageAtByCharacter[characterId] = lastMessageAt
          if (conversationMetadataRef.current[characterId] !== version) {
            changedCharacterIds.add(characterId)
          }
        })
        Object.keys(conversationMetadataRef.current).forEach(characterId => {
          if (!(characterId in nextMetadata)) changedCharacterIds.add(characterId)
        })

        if (hasWorkspaceSnapshotRef.current && changedCharacterIds.size > 0) {
          setUnreadCharacterIds(current => {
            const next = new Set(current)
            changedCharacterIds.forEach(characterId => {
              if (characterId !== selectedCharacterIdRef.current) next.add(characterId)
            })
            return next
          })
          changedCharacterIds.forEach(characterId => {
            if (characterId === selectedCharacterIdRef.current) return
            const cached = conversationCacheRef.current[characterId]
            const nextConversationId = newestConversationByCharacter.get(characterId)?.id || null
            if (cached && cached.conversationId !== nextConversationId) {
              delete conversationCacheRef.current[characterId]
            }
          })
        }

        conversationMetadataRef.current = nextMetadata
        setProactivePreviews(nextPreviews)
        setLastMessageAtByCharacter(current => (
          hasSameTimestamps(current, nextLastMessageAtByCharacter)
            ? current
            : nextLastMessageAtByCharacter
        ))
        hasWorkspaceSnapshotRef.current = true

        if (!activeCharacter) return
        const activeConversation = newestConversationByCharacter.get(activeCharacter.id)
        const activeCache = conversationCacheRef.current[activeCharacter.id]
        if (activeConversation && activeCache?.conversationId !== activeConversation.id) {
          conversationCacheRef.current[activeCharacter.id] = {
            conversationId: activeConversation.id,
            messages: activeCache?.messages || [],
            behaviorStatus: activeCache?.behaviorStatus || 'Online'
          }
          setConversationId(activeConversation.id)
          localStorage.setItem('chatterra_conversationId', activeConversation.id)
        } else if (!activeConversation && activeCache?.conversationId) {
          const starterMessages: ChatMessage[] = [{
            id: `starter-${activeCharacter.id}-${Date.now()}`,
            sender: 'ai',
            text: starterMessageForCharacter(activeCharacter)
          }]
          conversationCacheRef.current[activeCharacter.id] = {
            conversationId: null,
            messages: starterMessages,
            behaviorStatus: activeCache.behaviorStatus
          }
          setConversationId(null)
          setMessages(starterMessages)
          localStorage.removeItem('chatterra_conversationId')
        }
      } catch {
        // Keep the last usable local snapshot until connectivity recovers.
      } finally {
        syncing = false
      }
    }

    void syncWorkspace()
    const interval = window.setInterval(() => void syncWorkspace(), 3_000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void syncWorkspace()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stopped = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [userId])

  useEffect(() => {
    if (selectedCharacterIdRef.current !== selectedCharacter.id) return
    conversationCacheRef.current[selectedCharacter.id] = {
      conversationId,
      messages: stableMessagesForCache(messages),
      behaviorStatus
    }
  }, [behaviorStatus, conversationId, messages, selectedCharacter.id])

  useEffect(() => {
    if (!userId) return
    let stopped = false
    let polling = false

    const pollForProactiveMessages = async () => {
      if (polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        const response = await fetch(apiUrl('/api/proactive/poll'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId })
        })
        if (!response.ok) return
        const data = await response.json()
        if (stopped || !Array.isArray(data.deliveries) || data.deliveries.length === 0) return
        setProactivePreviews(current => {
          const next = { ...current }
          data.deliveries.forEach((delivery: any) => {
            if (typeof delivery.characterId === 'string' && typeof delivery.content === 'string') {
              next[delivery.characterId] = delivery.content
            }
          })
          return next
        })
        data.deliveries.forEach((delivery: any) => {
          if (typeof delivery.characterId === 'string') {
            markCharacterActive(delivery.characterId, typeof delivery.createdAt === 'string'
              ? delivery.createdAt
              : new Date().toISOString())
          }
        })
        setUnreadCharacterIds(current => {
          const next = new Set(current)
          data.deliveries.forEach((delivery: any) => {
            if (delivery.characterId && delivery.characterId !== selectedCharacter.id) {
              next.add(String(delivery.characterId))
            }
          })
          return next
        })
      } catch {
        // The regular chat request will surface backend availability when the user sends.
      } finally {
        polling = false
      }
    }

    void pollForProactiveMessages()
    const interval = window.setInterval(() => void pollForProactiveMessages(), 15_000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void pollForProactiveMessages()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      stopped = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [userId, selectedCharacter.id])

  useEffect(() => {
    if (!conversationId) return
    let stopped = false
    let syncing = false

    const syncConversation = async () => {
      if (syncing || document.visibilityState === 'hidden') return
      syncing = true
      try {
        const response = await fetch(apiUrl(`/api/conversations/${conversationId}/messages`))
        if (!response.ok) return
        const data = await response.json()
        if (stopped || !Array.isArray(data.messages)) return
        const serverMessages = mapServerMessages(data.messages)
        setMessages(current => {
          if (current.some(message => message.loading)) return current
          const mergedMessages = mergeMessageUiState(current, serverMessages)
          const unchanged = current.length === mergedMessages.length
            && current.every((message, index) => (
              message.id === mergedMessages[index]?.id
              && message.sender === mergedMessages[index]?.sender
              && message.text === mergedMessages[index]?.text
              && message.translation === mergedMessages[index]?.translation
              && message.translationVisible === mergedMessages[index]?.translationVisible
              && message.voice?.status === mergedMessages[index]?.voice?.status
              && message.voice?.audioUrl === mergedMessages[index]?.voice?.audioUrl
              && message.voiceTranscriptVisible === mergedMessages[index]?.voiceTranscriptVisible
            ))
          return unchanged ? current : mergedMessages
        })
      } catch {
        // Keep the current local transcript until the backend is reachable again.
      } finally {
        syncing = false
      }
    }

    void syncConversation()
    const interval = window.setInterval(() => void syncConversation(), 3_000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void syncConversation()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stopped = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [conversationId])

  const handleCharacterSelect = (nextCharacter: Character) => {
    conversationCacheRef.current[selectedCharacter.id] = {
      conversationId,
      messages: stableMessagesForCache(messages),
      behaviorStatus
    }
    selectedCharacterIdRef.current = nextCharacter.id
    setSelectedCharacter(nextCharacter)
    setShowConversationMenu(false)
    const cached = conversationCacheRef.current[nextCharacter.id]
    setConversationId(cached?.conversationId || null)
    setMessages(cached?.messages || [])
    setBehaviorStatus(cached?.behaviorStatus || 'Online')
    localStorage.setItem('chatterra_characterId', nextCharacter.id)
    setUnreadCharacterIds(current => {
      if (!current.has(nextCharacter.id)) return current
      const next = new Set(current)
      next.delete(nextCharacter.id)
      return next
    })
    const uid = userId || localStorage.getItem('chatterra_userId')
    if (uid) void loadHistoryForCharacter(uid, nextCharacter)
  }

  const updateMessagesForCharacter = (
    characterId: string,
    update: (current: ChatMessage[]) => ChatMessage[]
  ) => {
    if (selectedCharacterIdRef.current === characterId) {
      setMessages(update)
      return
    }
    const cached = conversationCacheRef.current[characterId] || {
      conversationId: null,
      messages: [],
      behaviorStatus: 'Online'
    }
    conversationCacheRef.current[characterId] = {
      ...cached,
      messages: stableMessagesForCache(update(cached.messages))
    }
  }

  const updateConversationForCharacter = (characterId: string, nextConversationId: string) => {
    const cached = conversationCacheRef.current[characterId] || {
      conversationId: null,
      messages: [],
      behaviorStatus: 'Online'
    }
    conversationCacheRef.current[characterId] = {
      ...cached,
      conversationId: nextConversationId
    }
    if (selectedCharacterIdRef.current === characterId) {
      setConversationId(nextConversationId)
      localStorage.setItem('chatterra_conversationId', nextConversationId)
    }
  }

  const updateBehaviorForCharacter = (characterId: string, nextBehaviorStatus: string) => {
    const cached = conversationCacheRef.current[characterId] || {
      conversationId: null,
      messages: [],
      behaviorStatus: 'Online'
    }
    conversationCacheRef.current[characterId] = {
      ...cached,
      behaviorStatus: nextBehaviorStatus
    }
    if (selectedCharacterIdRef.current === characterId) {
      setBehaviorStatus(nextBehaviorStatus)
    }
  }

  const togglePinnedCharacter = async () => {
    const uid = userId || localStorage.getItem('chatterra_userId')
    if (!uid) return
    const characterId = selectedCharacter.id
    const nextPinned = !pinnedCharacterIds.has(characterId)
    const previousPinnedOrder = pinnedCharacterOrder
    setShowConversationMenu(false)
    setPinnedCharacterIds(current => {
      const next = new Set(current)
      if (nextPinned) next.add(characterId)
      else next.delete(characterId)
      return next
    })
    setPinnedCharacterOrder(current => (
      nextPinned
        ? [characterId, ...current.filter(id => id !== characterId)]
        : current.filter(id => id !== characterId)
    ))

    try {
      const response = await fetch(
        apiUrl(`/api/users/${encodeURIComponent(uid)}/characters/${encodeURIComponent(characterId)}/pin`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: nextPinned })
        }
      )
      if (!response.ok) throw new Error('Could not update pin preference')
    } catch {
      setPinnedCharacterIds(current => {
        const next = new Set(current)
        if (nextPinned) next.delete(characterId)
        else next.add(characterId)
        return next
      })
      setPinnedCharacterOrder(previousPinnedOrder)
    }
  }

  const toggleMessageTranslation = (message: ChatMessage) => {
    const characterId = selectedCharacter.id
    if (message.translationVisible) {
      updateMessagesForCharacter(characterId, current => current.map(item => item.id === message.id
        ? { ...item, translationVisible: false, translationError: undefined }
        : item))
      return
    }
    if (message.translationLoading || message.translation) {
      updateMessagesForCharacter(characterId, current => current.map(item => item.id === message.id
        ? { ...item, translationVisible: true, translationError: undefined }
        : item))
      return
    }

    updateMessagesForCharacter(characterId, current => current.map(item => item.id === message.id
      ? { ...item, translationVisible: true, translationLoading: true, translationError: undefined }
      : item))

    void (async () => {
      try {
        const response = message.sourceMessageId
          ? await fetch(
              apiUrl(`/api/messages/${encodeURIComponent(message.sourceMessageId)}/translations`),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userId: userId || localStorage.getItem('chatterra_userId'),
                  targetLanguage: 'en',
                  segmentIndex: message.segmentIndex || 0
                })
              }
            )
          : await fetch(
              apiUrl('/api/translations'),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  text: message.text,
                  targetLanguage: 'en'
                })
              }
            )
        const data = await response.json().catch(() => ({}))
        if (!response.ok || typeof data.translation?.text !== 'string') {
          throw new Error(data.error || 'Translation unavailable')
        }
        updateMessagesForCharacter(characterId, current => current.map(item => item.id === message.id
          ? {
              ...item,
              translation: data.translation.text,
              translationLoading: false,
              translationError: undefined
            }
          : item))
      } catch (error) {
        updateMessagesForCharacter(characterId, current => current.map(item => item.id === message.id
          ? {
              ...item,
              translationLoading: false,
              translationError: error instanceof Error ? error.message : 'Translation unavailable'
            }
          : item))
      }
    })()
  }

  const toggleVoiceTranscript = (message: ChatMessage) => {
    if (message.voice?.status !== 'ready') return
    updateMessagesForCharacter(selectedCharacter.id, current => current.map(item => (
      item.id === message.id
        ? { ...item, voiceTranscriptVisible: !item.voiceTranscriptVisible }
        : item
    )))
  }

  const handleDraftChange = (draft: string) => {
    const characterId = selectedCharacter.id
    setMessageDrafts(current => {
      if (draft) return { ...current, [characterId]: draft }
      if (!(characterId in current)) return current

      const next = { ...current }
      delete next[characterId]
      return next
    })
  }

  const handleCharacterEditorSave = async () => {
    if (!editingCharacter) return
    if (!editingCharacter.name.trim()) {
      setCharacterEditorError('Name is required.')
      return
    }

    const isNewCharacter = !editingCharacter.id
    const endpoint = isNewCharacter
      ? apiUrl('/api/characters')
      : apiUrl(`/api/characters/${editingCharacter.id}`)

    setIsSavingCharacter(true)
    setCharacterEditorError('')

    try {
      const res = await fetch(endpoint, {
        method: isNewCharacter ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingCharacter)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save character')

      const savedCharacter = data.character as Character
      setCharacters(prev => isNewCharacter
        ? [...prev, savedCharacter]
        : prev.map(character => character.id === savedCharacter.id ? savedCharacter : character))

      if (isNewCharacter) {
        selectedCharacterIdRef.current = savedCharacter.id
        setSelectedCharacter(savedCharacter)
        localStorage.setItem('chatterra_characterId', savedCharacter.id)
        const uid = userId || localStorage.getItem('chatterra_userId')
        if (uid) void loadHistoryForCharacter(uid, savedCharacter)
      } else {
        setSelectedCharacter(prev => prev.id === savedCharacter.id ? savedCharacter : prev)
        if (selectedCharacter.id === savedCharacter.id) {
          localStorage.setItem('chatterra_characterId', savedCharacter.id)
        }
      }

      setShowCharacterEditor(false)
      setEditingCharacter(null)
    } catch (error) {
      setCharacterEditorError(error instanceof Error ? error.message : 'Failed to save character')
    } finally {
      setIsSavingCharacter(false)
    }
  }

  const clearCurrentCharacterHistory = async () => {
    const uid = userId || localStorage.getItem('chatterra_userId')
    if (!uid) return
    const targetCharacter = selectedCharacter

    await fetch(apiUrl('/api/chat-history'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, characterId: targetCharacter.id })
    })

    const starterMessages: ChatMessage[] = [{
      id: `starter-${targetCharacter.id}-${Date.now()}`,
      sender: 'ai',
      text: starterMessageForCharacter(targetCharacter)
    }]
    conversationCacheRef.current[targetCharacter.id] = {
      conversationId: null,
      messages: starterMessages,
      behaviorStatus: 'Online'
    }
    if (selectedCharacterIdRef.current === targetCharacter.id) {
      setConversationId(null)
      setMessages(starterMessages)
      setBehaviorStatus('Online')
      localStorage.removeItem('chatterra_conversationId')
    }
  }

  const handleAddAction = (action: 'group' | 'character' | 'clear') => {
    setShowAddDrawer(false)

    if (action === 'clear') {
      void clearCurrentCharacterHistory()
      return
    }

    if (action === 'character') {
      openNewCharacterEditor()
      return
    }

    window.alert('Start Group Chat is not implemented yet.')
  }

  const sendMessage = (text: string, voice?: VoiceTranscriptMetadata) => {
    if (!text) return
    const targetCharacter = selectedCharacter
    const targetCharacterId = targetCharacter.id
    const targetConversationId = conversationId
    markCharacterActive(targetCharacterId)
    setScrollToEndRequest(current => current + 1)
    const userMsg: ChatMessage = { id: makeMessageId(), sender: 'user', text, segmentIndex: 0 }
    const loadingId = makeMessageId()
    const loadingMsg: ChatMessage = { id: loadingId, sender: 'ai', text: '', loading: true }

    setMessages(prev => [...prev, userMsg, loadingMsg])

    void (async () => {
      try {
        const res = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            character: targetCharacter,
            userId: userId || localStorage.getItem('chatterra_userId'),
            conversationId: targetConversationId,
            voice: voice
              ? {
                  originalText: voice.originalText,
                  correctedText: voice.correctedText,
                  detectedLanguage: voice.detectedLanguage,
                  confidence: voice.confidence,
                  audioAvailable: voice.audioAvailable
                }
              : undefined
          })
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Chat request failed')
        markCharacterActive(targetCharacterId)
        if (typeof data.conversationId === 'string') {
          updateConversationForCharacter(targetCharacterId, data.conversationId)
        }
        if (typeof data.userMessageId === 'string') {
          updateMessagesForCharacter(targetCharacterId, prev2 => prev2.map(message => message.id === userMsg.id
            ? {
                ...message,
                id: data.userMessageId,
                sourceMessageId: data.userMessageId,
                segmentIndex: 0
              }
            : message))
        }
        if (data.behavior) {
          const activity = String(data.behavior.activity || 'Online')
            .replace(/_/g, ' ')
            .replace(/^./, value => value.toUpperCase())
          updateBehaviorForCharacter(targetCharacterId, activity)
        }
        if (data.behavior?.decision === 'no_reply' || data.reply === null) {
          updateMessagesForCharacter(targetCharacterId, prev2 => prev2.filter(m => m.id !== loadingId))
        } else if (typeof data.reply !== 'string') {
          throw new Error('The server returned no usable response.')
        } else {
          const aiMessages = responseMessages(data)
          if (aiMessages.length === 0) throw new Error('The server returned no usable response.')
          updateMessagesForCharacter(targetCharacterId, prev2 => {
            const hasLoadingMessage = prev2.some(message => message.id === loadingId)
            return hasLoadingMessage
              ? prev2.flatMap(message => message.id === loadingId ? aiMessages : [message])
              : [...prev2, ...aiMessages]
          })
        }
      } catch (error) {
        console.error('Chat request failed', error)
        updateMessagesForCharacter(targetCharacterId, prev2 => prev2.filter(m => m.id !== loadingId))
      }
    })()
  }

  return (
    <div className="chat-shell">
      <aside className="contacts-pane">
        <div className="contacts-header">
          <label className="wechat-search" aria-label="Search conversations">
            <span className="wechat-search-icon">⌕</span>
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search"
            />
          </label>

          {/* Characters are source-managed; the editor remains available for existing routes. */}
        </div>

        <div className="contacts-list">
          {visibleCharacters.map(ch => (
            <button
              type="button"
              key={ch.id}
              className={[
                'contact-item',
                selectedCharacter.id === ch.id ? 'active' : '',
                pinnedCharacterIds.has(ch.id) ? 'pinned' : ''
              ].filter(Boolean).join(' ')}
              onClick={() => handleCharacterSelect(ch)}
            >
              <div className="contact-avatar">
                {avatarContent(ch)}
              </div>
              <div className="contact-meta">
                <div className="contact-name-row">
                  <div className="contact-name">{ch.name}</div>
                  {unreadCharacterIds.has(ch.id) && <span className="contact-unread" aria-label="New message" />}
                </div>
                <div className="contact-preview">{proactivePreviews[ch.id] || ch.personality}</div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="chat-pane">
        <div className="top-bar">
          <div className="top-bar-identity">
            <button
              type="button"
              className="top-bar-avatar chat-character-edit-trigger"
              onClick={() => openCharacterEditor(selectedCharacter)}
              aria-label={`Edit ${selectedCharacter.name}`}
              title="Edit character"
            >
              {avatarContent(selectedCharacter)}
            </button>
            <div className="title">
              <button
                type="button"
                className="name chat-character-edit-trigger"
                onClick={() => openCharacterEditor(selectedCharacter)}
                title="Edit character"
              >
                {selectedCharacter.name}
              </button>
              <div className="status">{selectedCharacter.role || 'Conversation partner'} · {behaviorStatus}</div>
            </div>
          </div>
          <div className="conversation-menu-wrap">
            <button
              type="button"
              className="conversation-menu-button"
              onClick={() => setShowConversationMenu(current => !current)}
              aria-label="Conversation options"
              aria-expanded={showConversationMenu}
              title="Conversation options"
            >
              <span aria-hidden="true">...</span>
            </button>
            {showConversationMenu && (
              <>
                <button
                  type="button"
                  className="conversation-menu-backdrop"
                  aria-label="Close conversation menu"
                  onClick={() => setShowConversationMenu(false)}
                />
                <div className="conversation-menu" role="menu" aria-label="Conversation options">
                  <button type="button" role="menuitem" onClick={() => void togglePinnedCharacter()}>
                    {pinnedCharacterIds.has(selectedCharacter.id) ? 'Unpin Conversation' : 'Pin Conversation'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowConversationMenu(false)
                      openCharacterEditor(selectedCharacter)
                    }}
                  >
                    Edit Character
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      setShowConversationMenu(false)
                      void clearCurrentCharacterHistory()
                    }}
                  >
                    Clear History
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <ChatWindow
          messages={messages}
          character={selectedCharacter}
          onEditCharacter={() => openCharacterEditor(selectedCharacter)}
          scrollToEndRequest={scrollToEndRequest}
          onToggleTranslation={toggleMessageTranslation}
          onToggleVoiceTranscript={toggleVoiceTranscript}
        />
        <InputBox
          key={selectedCharacter.id}
          onSend={sendMessage}
          draft={messageDrafts[selectedCharacter.id] || ''}
          onDraftChange={handleDraftChange}
          language={selectedCharacter.language}
        />
      </main>

      {showCharacterEditor && editingCharacter && (
        <div className="character-modal-backdrop" onClick={closeCharacterEditor}>
          <div
            className="character-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="character-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="character-modal-header">
              <div id="character-modal-title" className="character-modal-title">
                {editingCharacter.id ? 'Edit Character' : 'Add Character'}
              </div>
              <button type="button" className="character-modal-close" onClick={closeCharacterEditor} aria-label="Close">×</button>
            </div>

            <div className="character-form-grid">
              <div className="character-avatar-editor field-wide">
                <span>Avatar</span>
                <div className="character-avatar-row">
                  <button
                    type="button"
                    className="character-avatar-picker"
                    onClick={() => avatarFileInputRef.current?.click()}
                    aria-label="Upload avatar"
                  >
                    {avatarContent(editingCharacter)}
                    <span className="avatar-upload-overlay">Upload</span>
                  </button>
                  <div className="character-avatar-tools">
                    {editingCharacter.avatar && (
                      <button
                        type="button"
                        className="avatar-tool-button secondary"
                        onClick={() => setEditingCharacter(prev => prev ? { ...prev, avatar: '' } : prev)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    ref={avatarFileInputRef}
                    type="file"
                    accept="image/*"
                    className="avatar-file-input"
                    onChange={handleAvatarFileSelected}
                  />
                </div>
              </div>

              {editableFields.map(field => (
                <label
                  key={String(field.key)}
                  className={"character-field " + (field.multiline ? 'field-wide' : '')}
                >
                  <span>{field.label}</span>
                  {field.multiline ? (
                    <textarea
                      value={editingCharacter[field.key] || ''}
                      onChange={(e) => setEditingCharacter(prev => prev ? { ...prev, [field.key]: e.target.value } : prev)}
                    />
                  ) : (
                    <input
                      value={editingCharacter[field.key] || ''}
                      onChange={(e) => setEditingCharacter(prev => prev ? { ...prev, [field.key]: e.target.value } : prev)}
                      autoFocus={field.key === 'name'}
                    />
                  )}
                </label>
              ))}

              {editingCharacter.id && (
                <div className="character-metadata field-wide">
                  <span>ID: {editingCharacter.id}</span>
                  {editingCharacter.createdAt && <span>Created: {new Date(editingCharacter.createdAt).toLocaleString()}</span>}
                  {editingCharacter.updatedAt && <span>Updated: {new Date(editingCharacter.updatedAt).toLocaleString()}</span>}
                </div>
              )}
            </div>

            {characterEditorError && <div className="character-form-error" role="alert">{characterEditorError}</div>}

            <div className="character-modal-actions">
              <button type="button" className="character-cancel" onClick={closeCharacterEditor} disabled={isSavingCharacter}>Cancel</button>
              <button type="button" className="character-save" onClick={handleCharacterEditorSave} disabled={isSavingCharacter}>
                {isSavingCharacter ? 'Saving...' : editingCharacter.id ? 'Save Changes' : 'Add Character'}
              </button>
            </div>
          </div>
        </div>
      )}

      {avatarCropSource && (
        <div className="avatar-crop-backdrop" onClick={closeAvatarCropper}>
          <div
            className="avatar-crop-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="avatar-crop-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="avatar-crop-header">
              <div id="avatar-crop-title" className="avatar-crop-title">Crop Avatar</div>
              <button type="button" className="character-modal-close" onClick={closeAvatarCropper} aria-label="Close">×</button>
            </div>
            <div
              ref={avatarCropViewportRef}
              className={"avatar-crop-viewport " + (isDraggingAvatar ? 'dragging' : '')}
              onPointerDown={handleAvatarCropPointerDown}
              onPointerMove={handleAvatarCropPointerMove}
              onPointerUp={handleAvatarCropPointerUp}
              onPointerCancel={handleAvatarCropPointerUp}
            >
              <img
                ref={avatarCropImageRef}
                src={avatarCropSource}
                alt=""
                className={"avatar-crop-image fit-" + avatarCropFit}
                style={{
                  transform: `translate(-50%, -50%) translate(${avatarCropPosition.x}px, ${avatarCropPosition.y}px) scale(${avatarCropScale})`
                }}
                onLoad={(event) => {
                  const image = event.currentTarget
                  setAvatarCropFit(image.naturalWidth > image.naturalHeight ? 'wide' : 'tall')
                  setAvatarCropPosition(prev => clampAvatarCropPosition(prev))
                }}
                draggable={false}
              />
              <div className="avatar-crop-grid" aria-hidden="true" />
            </div>
            <label className="avatar-zoom-control">
              <span>Zoom</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.01"
                value={avatarCropScale}
                onChange={handleAvatarCropScaleChange}
              />
            </label>
            <div className="avatar-crop-actions">
              <button type="button" className="character-cancel" onClick={closeAvatarCropper}>Cancel</button>
              <button type="button" className="character-save" onClick={applyAvatarCrop}>Use Avatar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
