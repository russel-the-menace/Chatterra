import React from 'react'
import { Character } from '../data/character'

export type ChatMessage = {
  id: string
  sender: 'ai' | 'user'
  text: string
  loading?: boolean
  sourceMessageId?: string
  segmentIndex?: number
  translation?: string
  translationVisible?: boolean
  translationLoading?: boolean
  translationError?: string
}

const isImageAvatar = (avatar?: string) => Boolean(avatar && /^(data:image\/|blob:|https?:\/\/|\/)/.test(avatar))

export default function MessageBubble({
  msg,
  character,
  onEditCharacter,
  onMessageContextMenu
}:{
  msg: ChatMessage
  character: Character
  onEditCharacter: () => void
  onMessageContextMenu: (event: React.MouseEvent<HTMLDivElement>, message: ChatMessage) => void
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
        <div
          className={bubbleClass}
          onContextMenu={event => onMessageContextMenu(event, msg)}
        >
          {msg.loading ? (
            <span className="typing">
              <span className="dot"/> <span className="dot"/> <span className="dot"/>
            </span>
          ) : (
            msg.text
          )}
        </div>
        {msg.translationVisible && !msg.loading && (
          <div
            className={`message-translation${msg.translationError ? ' error' : ''}`}
            role="status"
            aria-live="polite"
            aria-busy={msg.translationLoading || undefined}
          >
            {msg.translationLoading
              ? (
                  <span className="translation-loading">
                    <span className="translation-spinner" aria-hidden="true" />
                    <span>Translating...</span>
                  </span>
                )
              : msg.translationError || msg.translation}
          </div>
        )}
      </div>
      {isUser && <div className="avatar user">Me</div>}
    </div>
  )
}
