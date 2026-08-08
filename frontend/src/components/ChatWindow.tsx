import React, {useEffect, useLayoutEffect, useRef, useState} from 'react'
import { createPortal } from 'react-dom'
import MessageBubble, { ChatMessage } from './MessageBubble'
import { Character } from '../data/character'
import { chatTimeline } from '../chatTimeline'

type ScrollPosition = { top: number; atBottom: boolean }
type MessageMenu = { message: ChatMessage; x: number; y: number }

const nearLatestThreshold = 96

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

  const openMessageMenu = (event: React.MouseEvent<HTMLDivElement>, message: ChatMessage) => {
    if (message.loading) return
    event.preventDefault()
    const menuWidth = message.voice?.status === 'ready' ? 154 : 272
    const menuHeight = message.voice?.status === 'ready' ? 48 : 92
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
              width: messageMenu.message.voice?.status === 'ready' ? 154 : 272,
              minHeight: messageMenu.message.voice?.status === 'ready' ? 44 : 88,
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
                {messageMenu.message.voiceTranscriptionLoading
                  ? 'Converting...'
                  : messageMenu.message.voiceTranscriptVisible ? 'Hide text' : 'Convert to Text'}
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
                  Forward
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
                  Quote
                </button>
                <button type="button" role="menuitem" onClick={() => void copyMessage(messageMenu.message)}>
                  Copy
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
                  {messageMenu.message.translationVisible ? 'Hide translation' : 'Translate'}
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
