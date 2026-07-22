import React, {useEffect, useLayoutEffect, useRef} from 'react'
import MessageBubble from './MessageBubble'
import { Character } from '../data/character'

type Message = { id: string; sender: 'ai'|'user'; text: string; loading?: boolean }
type ScrollPosition = { top: number; atBottom: boolean }

const bottomThreshold = 4

export default function ChatWindow({
  messages,
  character,
  onEditCharacter,
  scrollToEndRequest
}:{
  messages: Message[]
  character: Character
  onEditCharacter: () => void
  scrollToEndRequest: number
}): JSX.Element{
  const ref = useRef<HTMLDivElement | null>(null)
  const scrollPositionsRef = useRef<Record<string, ScrollPosition>>({})
  const activeCharacterIdRef = useRef(character.id)
  const handledScrollRequestRef = useRef(scrollToEndRequest)
  const ignoreScrollEventsRef = useRef(false)
  const scrollReleaseTimerRef = useRef<number | null>(null)

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

  const handleScroll = () => {
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
          onEditCharacter={onEditCharacter}
        />
      ))}
    </div>
  )
}
