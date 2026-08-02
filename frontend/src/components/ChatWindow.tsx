import React, {useEffect, useLayoutEffect, useRef, useState} from 'react'
import { createPortal } from 'react-dom'
import MessageBubble, { ChatMessage } from './MessageBubble'
import { Character } from '../data/character'

type ScrollPosition = { top: number; atBottom: boolean }
type MessageMenu = { message: ChatMessage; x: number; y: number }

const bottomThreshold = 4

export default function ChatWindow({
  messages,
  character,
  userAvatar,
  userName,
  onEditCharacter,
  scrollToEndRequest,
  onToggleTranslation,
  onToggleVoiceTranscript
}:{
  messages: ChatMessage[]
  character: Character
  userAvatar?: string
  userName?: string
  onEditCharacter: () => void
  scrollToEndRequest: number
  onToggleTranslation: (message: ChatMessage) => void
  onToggleVoiceTranscript: (message: ChatMessage) => void
}): JSX.Element{
  const ref = useRef<HTMLDivElement | null>(null)
  const scrollPositionsRef = useRef<Record<string, ScrollPosition>>({})
  const activeCharacterIdRef = useRef(character.id)
  const handledScrollRequestRef = useRef(scrollToEndRequest)
  const ignoreScrollEventsRef = useRef(false)
  const scrollReleaseTimerRef = useRef<number | null>(null)
  const [messageMenu, setMessageMenu] = useState<MessageMenu | null>(null)

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
        ?? element.scrollHeight - element.clientHeight - element.scrollTop <= bottomThreshold
      scrollPositionsRef.current[character.id] = { top: maxScrollTop, atBottom: true }
      scrollTo(maxScrollTop, wasAtBottom ? 'auto' : 'smooth')
      return
    }

    const restoredTop = !savedPosition || savedPosition.atBottom
      ? maxScrollTop
      : Math.min(savedPosition.top, maxScrollTop)
    if (!savedPosition) {
      scrollPositionsRef.current[character.id] = { top: maxScrollTop, atBottom: true }
    }
    scrollTo(restoredTop, 'auto')
  }, [character.id, messages, scrollToEndRequest])

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
    const menuWidth = message.voice?.status === 'ready' ? 154 : 190
    const menuHeight = 48
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
      atBottom: distanceFromBottom <= bottomThreshold
    }
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
      {messages.map(m => (
        <MessageBubble
          key={m.id}
          msg={m}
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
            style={{ left: messageMenu.x, top: messageMenu.y }}
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
