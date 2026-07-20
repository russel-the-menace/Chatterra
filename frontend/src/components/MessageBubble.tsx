import React from 'react'
import { Character } from '../data/character'

type Message = { id: string; sender: 'ai'|'user'; text: string; loading?: boolean }

const isImageAvatar = (avatar?: string) => Boolean(avatar && /^(data:image\/|blob:|https?:\/\/|\/)/.test(avatar))

export default function MessageBubble({
  msg,
  character,
  onEditCharacter
}:{
  msg: Message
  character: Character
  onEditCharacter: () => void
}): JSX.Element{
  const isUser = msg.sender === 'user'
  const bubbleClass = "bubble "+(isUser? 'user':'ai')
  const characterAvatar = isImageAvatar(character.avatar)
    ? <img src={character.avatar} alt="" />
    : <span>{character.avatar || character.name.slice(0, 1)}</span>

  return (
    <div className={"message-row "+(isUser? 'right':'left')}>
      {!isUser && (
        <button
          type="button"
          className="avatar assistant chat-character-edit-trigger"
          onClick={onEditCharacter}
          aria-label={`Edit ${character.name}`}
          title="Edit character"
        >
          {characterAvatar}
        </button>
      )}
      <div className="message-content">
        {!isUser && (
          <button
            type="button"
            className="message-character-name chat-character-edit-trigger"
            onClick={onEditCharacter}
            title="Edit character"
          >
            {character.name}
          </button>
        )}
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
      {isUser && <div className="avatar user">Me</div>}
    </div>
  )
}
