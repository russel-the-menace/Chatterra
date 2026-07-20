import React from 'react'

type Message = { id: number; sender: 'ai'|'user'; text: string; loading?: boolean }

export default function MessageBubble({msg}:{msg:Message}): JSX.Element{
  const isUser = msg.sender === 'user'
  const bubbleClass = "bubble "+(isUser? 'user':'ai')
  return (
    <div className={"message-row "+(isUser? 'right':'left')}>
      <div className={bubbleClass}>
        {msg.loading ? (
          <span className="typing">
            <span className="dot"/> <span className="dot"/> <span className="dot"/>
          </span>
        ) : (
          msg.text
        )}
      </div>
    </div>
  )
}
