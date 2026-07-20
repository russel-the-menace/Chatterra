import React, {useEffect, useRef} from 'react'
import MessageBubble from './MessageBubble'

type Message = { id: number; sender: 'ai'|'user'; text: string; loading?: boolean }

export default function ChatWindow({messages}:{messages:Message[]}): JSX.Element{
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(()=>{
    ref.current?.scrollTo({top: ref.current.scrollHeight, behavior: 'smooth'})
  },[messages])

  return (
    <div className="chat-window" ref={ref}>
      {messages.map(m=> <MessageBubble key={m.id} msg={m} />)}
    </div>
  )
}
