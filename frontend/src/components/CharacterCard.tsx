import React from 'react'
import { Character } from '../data/character'

export default function CharacterCard({character}:{character:Character}): JSX.Element{
  return (
    <div className="character-card">
      <div className="avatar">{character.avatar || '👤'}</div>
      <div className="meta">
        <div className="role">{character.role} @ {character.company}</div>
        <div className="personality">{character.personality}</div>
      </div>
    </div>
  )
}
