import React, {useEffect, useRef} from 'react'
import MessageBubble from './MessageBubble'
import { Character } from '../data/character'

type Message = { id: string; sender: 'ai'|'user'; text: string; loading?: boolean }

export default function ChatWindow({
  messages,
  character,
  onEditCharacter
}:{
  messages: Message[]
  character: Character
  onEditCharacter: () => void
}): JSX.Element{
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(()=>{
    ref.current?.scrollTo({top: ref.current.scrollHeight, behavior: 'smooth'})
  },[messages])

  return (
    <div className="chat-window" ref={ref}>
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
