import React, {useEffect, useLayoutEffect, useRef, useState} from 'react'
import { createPortal } from 'react-dom'
import MessageBubble, { ChatMessage } from './MessageBubble'
import { Character } from '../data/character'
import { chatTimeline } from '../chatTimeline'

type ScrollPosition = { top: number; atBottom: boolean }
type MessageMenu = { message: ChatMessage; x: number; y: number }
type AvatarPreview = { avatar?: string; name: string; muted?: boolean }
type MessageActionIconName = 'copy' | 'document' | 'forward' | 'quote' | 'translate'

const MessageActionIcon = ({ name }: { name: MessageActionIconName }) => {
  const common = {
    className: 'message-action-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (name === 'copy') {
    return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
  }
  if (name === 'document') {
    return <svg {...common}><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h4M8 12h8M8 16h6"/></svg>
  }
  if (name === 'forward') {
    return <svg {...common}><path d="M14 5l6 6-6 6"/><path d="M20 11H9a5 5 0 0 0-5 5v3"/></svg>
  }
  if (name === 'quote') {
    return <svg {...common}><path d="M9 11H5.5A2.5 2.5 0 0 0 3 13.5v1A2.5 2.5 0 0 0 5.5 17H7a2 2 0 0 0 2-2v-4Z"/><path d="M21 11h-3.5a2.5 2.5 0 0 0-2.5 2.5v1a2.5 2.5 0 0 0 2.5 2.5H19a2 2 0 0 0 2-2v-4Z"/></svg>
  }
  return <svg {...common}><path d="M4 5h16M12 5v14M7 19h10"/><path d="M7 5c.7 4.7 3.5 7.5 8.5 8.5M17 5c-.7 4.7-3.5 7.5-8.5 8.5"/></svg>
}

const nearLatestThreshold = 96
const isImageAvatar = (avatar?: string) => Boolean(avatar && /^(data:image\/|blob:|https?:\/\/|\/)/.test(avatar))

export default function ChatWindow({
  messages,
  character,
  userAvatar,
  userName,
  onEditCharacter,
  scrollToEndRequest,
  onLoadOlderMessages,
  onLatestStateChange,
  onToggleTranslation,
  onToggleVoiceTranscript,
  onQuoteMessage,
  onForwardMessage
}:{
  messages: ChatMessage[]
  character: Character
  userAvatar?: string
  userName?: string
  onEditCharacter: () => void
  scrollToEndRequest: number
  onLoadOlderMessages: () => Promise<void>
  onLatestStateChange: (atLatest: boolean) => void
  onToggleTranslation: (message: ChatMessage) => void
  onToggleVoiceTranscript: (message: ChatMessage) => void
  onQuoteMessage: (message: ChatMessage) => void
  onForwardMessage: (message: ChatMessage) => void
}): JSX.Element{
  const ref = useRef<HTMLDivElement | null>(null)
  const scrollPositionsRef = useRef<Record<string, ScrollPosition>>({})
  const activeCharacterIdRef = useRef(character.id)
  const handledScrollRequestRef = useRef(scrollToEndRequest)
  const ignoreScrollEventsRef = useRef(false)
  const scrollReleaseTimerRef = useRef<number | null>(null)
  const [messageMenu, setMessageMenu] = useState<MessageMenu | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<AvatarPreview | null>(null)
  const timelineItems = chatTimeline(messages)

  const releaseScrollCapture = (delay: number) => {
    if (scrollReleaseTimerRef.current !== null) {
      window.clearTimeout(scrollReleaseTimerRef.current)
    }
    scrollReleaseTimerRef.current = window.setTimeout(() => {
      ignoreScrollEventsRef.current = false
      scrollReleaseTimerRef.current = null
    }, delay)
  }

  const scrollTo = (top: number, behavior: ScrollBehavior) => {
    const element = ref.current
    if (!element) return
    ignoreScrollEventsRef.current = true
    element.scrollTo({ top, behavior })
    releaseScrollCapture(behavior === 'smooth' ? 700 : 50)
  }

  const allowManualScrolling = () => {
    if (scrollReleaseTimerRef.current !== null) {
      window.clearTimeout(scrollReleaseTimerRef.current)
      scrollReleaseTimerRef.current = null
    }
    ignoreScrollEventsRef.current = false
  }

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const characterChanged = activeCharacterIdRef.current !== character.id
    const sendRequested = handledScrollRequestRef.current !== scrollToEndRequest
    activeCharacterIdRef.current = character.id
    handledScrollRequestRef.current = scrollToEndRequest

    const savedPosition = scrollPositionsRef.current[character.id]
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)

    if (!characterChanged && sendRequested) {
      const wasAtBottom = savedPosition?.atBottom
        ?? element.scrollHeight - element.clientHeight - element.scrollTop <= nearLatestThreshold
      scrollPositionsRef.current[character.id] = { top: maxScrollTop, atBottom: true }
      onLatestStateChange(true)
      scrollTo(maxScrollTop, wasAtBottom ? 'auto' : 'smooth')
      return
    }

    const restoredTop = !savedPosition || savedPosition.atBottom
      ? maxScrollTop
      : Math.min(savedPosition.top, maxScrollTop)
    if (!savedPosition) {
      scrollPositionsRef.current[character.id] = { top: maxScrollTop, atBottom: true }
    }
    onLatestStateChange(!savedPosition || savedPosition.atBottom)
    scrollTo(restoredTop, 'auto')
  }, [character.id, messages, onLatestStateChange, scrollToEndRequest])

  useEffect(() => () => {
    if (scrollReleaseTimerRef.current !== null) {
      window.clearTimeout(scrollReleaseTimerRef.current)
    }
  }, [])

  useEffect(() => {
    setMessageMenu(null)
  }, [character.id])

  useEffect(() => {
    if (!messageMenu) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMessageMenu(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [messageMenu])

  useEffect(() => {
    if (!avatarPreview) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAvatarPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [avatarPreview])

  const openMessageMenu = (event: React.MouseEvent<HTMLDivElement>, message: ChatMessage) => {
    if (message.loading) return
    event.preventDefault()
    const menuWidth = message.voice?.status === 'ready' ? 154 : 296
    const menuHeight = message.voice?.status === 'ready' ? 78 : 82
    setMessageMenu({
      message,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    })
  }

  const copyMessage = async (message: ChatMessage) => {
    setMessageMenu(null)
    try {
      await navigator.clipboard.writeText(message.text)
    } catch {
      window.alert('Could not copy this message.')
    }
  }

  const handleScroll = () => {
    setMessageMenu(null)
    const element = ref.current
    if (!element || ignoreScrollEventsRef.current) return
    const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop
    scrollPositionsRef.current[character.id] = {
      top: element.scrollTop,
      atBottom: distanceFromBottom <= nearLatestThreshold
    }
    onLatestStateChange(distanceFromBottom <= nearLatestThreshold)
    if (element.scrollTop <= 32) void loadOlderMessages()
  }

  const loadOlderMessages = async () => {
    const element = ref.current
    if (!element) return
    const previousTop = element.scrollTop
    const previousHeight = element.scrollHeight
    await onLoadOlderMessages()
    requestAnimationFrame(() => {
      const nextElement = ref.current
      if (!nextElement) return
      const nextTop = previousTop + nextElement.scrollHeight - previousHeight
      nextElement.scrollTop = nextTop
      scrollPositionsRef.current[character.id] = { top: nextTop, atBottom: false }
    })
  }

  return (
    <div
      className="chat-window"
      ref={ref}
      onScroll={handleScroll}
      onWheel={allowManualScrolling}
      onTouchStart={allowManualScrolling}
      onPointerDown={event => {
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX >= bounds.right - 18) allowManualScrolling()
      }}
    >
      {timelineItems.map(item => (
        item.kind === 'date'
          ? <div className="chat-date-divider" key={item.key}>{item.label}</div>
          : <MessageBubble
              key={item.key}
              msg={item.message}
              character={character}
              userAvatar={userAvatar}
              userName={userName}
              onEditCharacter={onEditCharacter}
              onPreviewAvatar={(avatar, name, muted) => setAvatarPreview({ avatar, name, muted })}
              onMessageContextMenu={openMessageMenu}
            />
      ))}
      {messageMenu && createPortal(
        <div className="message-menu-backdrop" onMouseDown={() => setMessageMenu(null)}>
          <div
            className="message-context-menu"
            role="menu"
            aria-label="Message actions"
            style={{
              left: messageMenu.x,
              top: messageMenu.y,
              width: messageMenu.message.voice?.status === 'ready' ? 154 : 296,
              minHeight: messageMenu.message.voice?.status === 'ready' ? 76 : 78,
            }}
            onMouseDown={event => event.stopPropagation()}
          >
            {messageMenu.message.voice?.status === 'ready' ? (
              <button
                type="button"
                role="menuitem"
                disabled={messageMenu.message.voiceTranscriptionLoading}
                onClick={() => {
                  const message = messageMenu.message
                  setMessageMenu(null)
                  void onToggleVoiceTranscript(message)
                }}
              >
                <MessageActionIcon name="document" />
                <span>{messageMenu.message.voiceTranscriptionLoading
                  ? 'Converting...'
                  : messageMenu.message.voiceTranscriptVisible ? 'Hide text' : 'Convert to Text'}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const message = messageMenu.message
                    setMessageMenu(null)
                    onForwardMessage(message)
                  }}
                >
                  <MessageActionIcon name="forward" />
                  <span>Forward</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const message = messageMenu.message
                    setMessageMenu(null)
                    onQuoteMessage(message)
                  }}
                >
                  <MessageActionIcon name="quote" />
                  <span>Quote</span>
                </button>
                <button type="button" role="menuitem" onClick={() => void copyMessage(messageMenu.message)}>
                  <MessageActionIcon name="copy" />
                  <span>Copy</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const message = messageMenu.message
                    setMessageMenu(null)
                    onToggleTranslation(message)
                  }}
                >
                  <MessageActionIcon name="translate" />
                  <span>{messageMenu.message.translationVisible ? 'Hide translation' : 'Translate'}</span>
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
      {avatarPreview && createPortal(
        <div className="avatar-preview-backdrop" role="dialog" aria-modal="true" aria-label={`${avatarPreview.name}'s avatar`} onMouseDown={() => setAvatarPreview(null)}>
          <div className="avatar-preview-frame" onMouseDown={event => event.stopPropagation()}>
            {isImageAvatar(avatarPreview.avatar)
              ? <img src={avatarPreview.avatar} alt={`${avatarPreview.name}'s avatar`} />
              : <span className={avatarPreview.muted ? 'avatar-preview-initial muted' : 'avatar-preview-initial'}>{(avatarPreview.avatar || avatarPreview.name.trim().slice(0, 1) || '?').toUpperCase()}</span>}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
