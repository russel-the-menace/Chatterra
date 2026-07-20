import React from 'react'

type Message = { id: number; sender: 'ai'|'user'; text: string }

export default function MessageBubble({msg}:{msg:Message}): JSX.Element{
  const isUser = msg.sender === 'user'
  return (
    <div className={"message-row "+(isUser? 'right':'left')}>
      <div className={"bubble "+(isUser? 'user':'ai')}>{msg.text}</div>
    </div>
  )
}
