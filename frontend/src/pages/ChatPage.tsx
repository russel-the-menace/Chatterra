import React, {useState, useEffect, useMemo, useRef} from 'react'
import ChatWindow from '../components/ChatWindow'
import InputBox from '../components/InputBox'
import seedCharacter, {characters as seedCharacters, Character} from '../data/character'
import { VoiceTranscriptMetadata } from '../voice/types'
import { starterMessageForCharacter } from '../languagePolicy'

type Message = { id: string; sender: 'ai' | 'user'; text: string; loading?: boolean }
type CharacterTextKey = 'name' | 'role' | 'company' | 'scenario' | 'goal' | 'language' | 'personality' | 'background' | 'systemPromptTemplate'
type Point = { x: number; y: number }

const makeMessageId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
const isImageAvatar = (avatar?: string) => Boolean(avatar && /^(data:image\/|blob:|https?:\/\/|\/)/.test(avatar))

const avatarContent = (character: Pick<Character, 'avatar' | 'name'>) => {
  if (isImageAvatar(character.avatar)) {
    return <img src={character.avatar} alt="" />
  }
  return <span>{character.avatar || character.name.slice(0, 1) || '?'}</span>
}

const editableFields: Array<{
  key: CharacterTextKey
  label: string
  multiline?: boolean
}> = [
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'company', label: 'Company' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'goal', label: 'Goal' },
  { key: 'language', label: 'Language' },
  { key: 'personality', label: 'Personality', multiline: true },
  { key: 'background', label: 'Background', multiline: true },
  { key: 'systemPromptTemplate', label: 'System Prompt Template', multiline: true }
]

const createCharacterDraft = (): Character => ({
  id: '',
  name: '',
  avatar: '',
  role: '',
  company: '',
  scenario: '',
  goal: '',
  language: 'English only',
  personality: '',
  background: '',
  systemPromptTemplate: ''
})

export default function ChatPage(): JSX.Element{
  const [messages, setMessages] = useState<Message[]>([])
  const [userId, setUserIdentifier] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>(seedCharacters)
  const [selectedCharacter, setSelectedCharacter] = useState<Character>(seedCharacter)
  const [behaviorStatus, setBehaviorStatus] = useState('Online')
  const [searchText, setSearchText] = useState('')
  const [showAddDrawer, setShowAddDrawer] = useState(false)
  const [showCharacterEditor, setShowCharacterEditor] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null)
  const [isSavingCharacter, setIsSavingCharacter] = useState(false)
  const [characterEditorError, setCharacterEditorError] = useState('')
  const [avatarCropSource, setAvatarCropSource] = useState<string | null>(null)
  const [avatarCropScale, setAvatarCropScale] = useState(1)
  const [avatarCropPosition, setAvatarCropPosition] = useState<Point>({ x: 0, y: 0 })
  const [avatarCropFit, setAvatarCropFit] = useState<'wide' | 'tall'>('tall')
  const [isDraggingAvatar, setIsDraggingAvatar] = useState(false)
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null)
  const avatarCropViewportRef = useRef<HTMLDivElement | null>(null)
  const avatarCropImageRef = useRef<HTMLImageElement | null>(null)
  const avatarDragRef = useRef<{ pointerId: number; pointerX: number; pointerY: number; x: number; y: number } | null>(null)

  const visibleCharacters = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return characters
    return characters.filter(ch => [ch.name, ch.role, ch.company, ch.personality].join(' ').toLowerCase().includes(query))
  }, [characters, searchText])

  const loadHistoryForCharacter = async (uid: string, nextCharacter: Character) => {
    setConversationId(null)

    try {
      const cRes = await fetch(`http://localhost:3000/api/conversations?userId=${uid}`)
      if (!cRes.ok) throw new Error('no convs')

      const cData = await cRes.json()
      const matchingConversation = (cData.conversations || [])
        .filter((conv: any) => conv.characterId === nextCharacter.id)
        .sort((a: any, b: any) => (b.lastMessageAt || b.updatedAt || b.createdAt || '').localeCompare(a.lastMessageAt || a.updatedAt || a.createdAt || ''))[0]

      if (matchingConversation) {
        setConversationId(matchingConversation.id)
        localStorage.setItem('chatterra_conversationId', matchingConversation.id)

        const mRes = await fetch(`http://localhost:3000/api/conversations/${matchingConversation.id}/messages`)
        const mData = await mRes.json()
        const mapped: Message[] = (mData.messages || []).map((m: any) => ({
          id: String(m.id),
          sender: m.senderRole === 'user' ? 'user' : 'ai',
          text: m.content
        }))
        setMessages(mapped)
        return
      }
    } catch (e) {
      // fall through to default greeting
    }

    setMessages([{ id: makeMessageId(), sender: 'ai', text: starterMessageForCharacter(nextCharacter) }])
  }

  const openCharacterEditor = (character: Character) => {
    setEditingCharacter({ ...character })
    setShowCharacterEditor(true)
    setShowAddDrawer(false)
    setCharacterEditorError('')
  }

  const openNewCharacterEditor = () => {
    setEditingCharacter(createCharacterDraft())
    setShowCharacterEditor(true)
    setShowAddDrawer(false)
    setCharacterEditorError('')
  }

  const closeCharacterEditor = () => {
    if (isSavingCharacter) return
    setShowCharacterEditor(false)
    setEditingCharacter(null)
    setCharacterEditorError('')
  }

  const clampAvatarCropPosition = (position: Point, scale = avatarCropScale): Point => {
    const image = avatarCropImageRef.current
    const viewport = avatarCropViewportRef.current
    if (!image || !viewport || !image.naturalWidth || !image.naturalHeight) return position

    const viewportSize = viewport.clientWidth || 320
    const aspect = image.naturalWidth / image.naturalHeight
    const baseWidth = aspect >= 1 ? viewportSize * aspect : viewportSize
    const baseHeight = aspect >= 1 ? viewportSize : viewportSize / aspect
    const maxX = Math.max(0, (baseWidth * scale - viewportSize) / 2)
    const maxY = Math.max(0, (baseHeight * scale - viewportSize) / 2)

    return {
      x: Math.min(maxX, Math.max(-maxX, position.x)),
      y: Math.min(maxY, Math.max(-maxY, position.y))
    }
  }

  const closeAvatarCropper = () => {
    setAvatarCropSource(null)
    setAvatarCropScale(1)
    setAvatarCropPosition({ x: 0, y: 0 })
    setAvatarCropFit('tall')
    setIsDraggingAvatar(false)
    avatarDragRef.current = null
    if (avatarFileInputRef.current) avatarFileInputRef.current.value = ''
  }

  const handleAvatarFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setCharacterEditorError('Please choose an image file.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setAvatarCropSource(String(reader.result || ''))
      setAvatarCropScale(1)
      setAvatarCropPosition({ x: 0, y: 0 })
      setAvatarCropFit('tall')
      setCharacterEditorError('')
    }
    reader.onerror = () => setCharacterEditorError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  const handleAvatarCropScaleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextScale = Number(event.target.value)
    setAvatarCropScale(nextScale)
    setAvatarCropPosition(prev => clampAvatarCropPosition(prev, nextScale))
  }

  const handleAvatarCropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    avatarDragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: avatarCropPosition.x,
      y: avatarCropPosition.y
    }
    setIsDraggingAvatar(true)
  }

  const handleAvatarCropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = avatarDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    setAvatarCropPosition(clampAvatarCropPosition({
      x: drag.x + event.clientX - drag.pointerX,
      y: drag.y + event.clientY - drag.pointerY
    }))
  }

  const handleAvatarCropPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = avatarDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    avatarDragRef.current = null
    setIsDraggingAvatar(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const applyAvatarCrop = () => {
    const image = avatarCropImageRef.current
    const viewport = avatarCropViewportRef.current
    if (!image || !viewport || !editingCharacter) return

    const imageRect = image.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const sourceX = (viewportRect.left - imageRect.left) * image.naturalWidth / imageRect.width
    const sourceY = (viewportRect.top - imageRect.top) * image.naturalHeight / imageRect.height
    const sourceSize = viewportRect.width * image.naturalWidth / imageRect.width
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) return

    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height)
    const croppedAvatar = canvas.toDataURL('image/jpeg', 0.88)
    setEditingCharacter(prev => prev ? { ...prev, avatar: croppedAvatar } : prev)
    closeAvatarCropper()
  }

  useEffect(() => {
    if (!showCharacterEditor) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (avatarCropSource) {
          closeAvatarCropper()
        } else {
          closeCharacterEditor()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.classList.add('modal-open')

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.classList.remove('modal-open')
    }
  }, [showCharacterEditor, isSavingCharacter, avatarCropSource])

  useEffect(() => {
    let uid = localStorage.getItem('chatterra_userId')
    if (!uid) {
      uid = String(Date.now())
      localStorage.setItem('chatterra_userId', uid)
    }
    setUserIdentifier(uid)
    const loadCharacters = async () => {
      try {
        const res = await fetch('http://localhost:3000/api/characters')
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.characters) && data.characters.length > 0) {
            setCharacters(data.characters)
            const savedCharacterId = localStorage.getItem('chatterra_characterId')
            const initialCharacter = data.characters.find((c: Character) => c.id === savedCharacterId) || data.characters[0]
            setSelectedCharacter(initialCharacter)
            await loadHistoryForCharacter(uid, initialCharacter)
            return
          }
        }
      } catch (e) {
        // fall back to seed characters below
      }

      const savedCharacterId = localStorage.getItem('chatterra_characterId')
      const initialCharacter = seedCharacters.find(c => c.id === savedCharacterId) || seedCharacter
      setCharacters(seedCharacters)
      setSelectedCharacter(initialCharacter)
      void loadHistoryForCharacter(uid, initialCharacter)
    }

    void loadCharacters()
  }, [])

  const handleCharacterSelect = (nextCharacter: Character) => {
    setSelectedCharacter(nextCharacter)
    setBehaviorStatus('Online')
    localStorage.setItem('chatterra_characterId', nextCharacter.id)
    const uid = userId || localStorage.getItem('chatterra_userId')
    if (uid) void loadHistoryForCharacter(uid, nextCharacter)
  }

  const handleCharacterEditorSave = async () => {
    if (!editingCharacter) return
    if (!editingCharacter.name.trim()) {
      setCharacterEditorError('Name is required.')
      return
    }

    const isNewCharacter = !editingCharacter.id
    const endpoint = isNewCharacter
      ? 'http://localhost:3000/api/characters'
      : `http://localhost:3000/api/characters/${editingCharacter.id}`

    setIsSavingCharacter(true)
    setCharacterEditorError('')

    try {
      const res = await fetch(endpoint, {
        method: isNewCharacter ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingCharacter)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save character')

      const savedCharacter = data.character as Character
      setCharacters(prev => isNewCharacter
        ? [...prev, savedCharacter]
        : prev.map(character => character.id === savedCharacter.id ? savedCharacter : character))

      if (isNewCharacter) {
        setSelectedCharacter(savedCharacter)
        localStorage.setItem('chatterra_characterId', savedCharacter.id)
        const uid = userId || localStorage.getItem('chatterra_userId')
        if (uid) void loadHistoryForCharacter(uid, savedCharacter)
      } else {
        setSelectedCharacter(prev => prev.id === savedCharacter.id ? savedCharacter : prev)
        if (selectedCharacter.id === savedCharacter.id) {
          localStorage.setItem('chatterra_characterId', savedCharacter.id)
        }
      }

      setShowCharacterEditor(false)
      setEditingCharacter(null)
    } catch (error) {
      setCharacterEditorError(error instanceof Error ? error.message : 'Failed to save character')
    } finally {
      setIsSavingCharacter(false)
    }
  }

  const clearCurrentCharacterHistory = async () => {
    const uid = userId || localStorage.getItem('chatterra_userId')
    if (!uid) return

    await fetch('http://localhost:3000/api/chat-history', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, characterId: selectedCharacter.id })
    })

    setConversationId(null)
    setMessages([{ id: makeMessageId(), sender: 'ai', text: starterMessageForCharacter(selectedCharacter) }])
    localStorage.removeItem('chatterra_conversationId')
  }

  const handleAddAction = (action: 'group' | 'character' | 'clear') => {
    setShowAddDrawer(false)

    if (action === 'clear') {
      void clearCurrentCharacterHistory()
      return
    }

    if (action === 'character') {
      openNewCharacterEditor()
      return
    }

    window.alert('Start Group Chat is not implemented yet.')
  }

  const sendMessage = (text: string, voice?: VoiceTranscriptMetadata) => {
    if (!text) return
    const userMsg: Message = { id: makeMessageId(), sender: 'user', text }
    const loadingId = makeMessageId()
    const loadingMsg: Message = { id: loadingId, sender: 'ai', text: '', loading: true }

    setMessages(prev => {
      const updated = [...prev, userMsg, loadingMsg]

      ;(async () => {
        try {
          const res = await fetch('http://localhost:3000/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              history: updated,
              character: selectedCharacter,
              userId: userId || localStorage.getItem('chatterra_userId'),
              conversationId,
              voice: voice
                ? {
                    originalText: voice.originalText,
                    correctedText: voice.correctedText,
                    detectedLanguage: voice.detectedLanguage,
                    confidence: voice.confidence,
                    audioAvailable: voice.audioAvailable
                  }
                : undefined
            })
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || 'Chat request failed')
          if (data.conversationId && !conversationId) {
            setConversationId(data.conversationId)
            localStorage.setItem('chatterra_conversationId', data.conversationId)
          }
          if (data.behavior) {
            const activity = String(data.behavior.activity || 'Online')
              .replace(/_/g, ' ')
              .replace(/^./, value => value.toUpperCase())
            setBehaviorStatus(activity)
          }
          if (data.behavior?.decision === 'no_reply' || data.reply === null) {
            setMessages(prev2 => prev2.filter(m => m.id !== loadingId))
          } else if (typeof data.reply !== 'string') {
            throw new Error('The server returned no usable response.')
          } else {
            const aiMsg: Message = {
              id: makeMessageId(),
              sender: 'ai',
              text: typeof data.reply === 'string' ? data.reply : 'Sorry, I could not generate a response.'
            }
            setMessages(prev2 => prev2.map(m => m.id === loadingId ? aiMsg : m))
          }
        } catch (error) {
          console.error('Chat request failed', error)
          setMessages(prev2 => prev2.filter(m => m.id !== loadingId))
        }
      })()

      return updated
    })
  }

  return (
    <div className="chat-shell">
      <aside className="contacts-pane">
        <div className="contacts-header">
          <label className="wechat-search" aria-label="Search conversations">
            <span className="wechat-search-icon">⌕</span>
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search"
            />
          </label>

          <div className="add-menu-wrap">
            <button
              className={"wechat-add-button " + (showAddDrawer ? 'open' : '')}
              onClick={() => setShowAddDrawer(prev => !prev)}
              aria-label="Add"
              aria-expanded={showAddDrawer}
            >
              <span className="plus">+</span>
            </button>

            {showAddDrawer && (
              <>
                <button
                  className="drawer-backdrop"
                  aria-label="Close add menu"
                  onClick={() => setShowAddDrawer(false)}
                />
                <div className="wechat-drawer" role="menu" aria-label="Add menu">
                  <button type="button" className="drawer-item" onClick={() => handleAddAction('group')}>
                    <span className="drawer-icon">💬</span>
                    <span>Start Group Chat</span>
                  </button>
                  <button type="button" className="drawer-item" onClick={() => handleAddAction('character')}>
                    <span className="drawer-icon">👤+</span>
                    <span>Add Character</span>
                  </button>
                  <button type="button" className="drawer-item" onClick={() => handleAddAction('clear')}>
                    <span className="drawer-icon">⌫</span>
                    <span>Clear History</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="contacts-list">
          {visibleCharacters.map(ch => (
            <button
              type="button"
              key={ch.id}
              className={"contact-item " + (selectedCharacter.id === ch.id ? 'active' : '')}
              onClick={() => handleCharacterSelect(ch)}
            >
              <div className="contact-avatar">
                {avatarContent(ch)}
              </div>
              <div className="contact-meta">
                <div className="contact-name">
                  {ch.name}
                </div>
                <div className="contact-preview">{ch.personality}</div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="chat-pane">
        <div className="top-bar">
          <div className="top-bar-identity">
            <button
              type="button"
              className="top-bar-avatar chat-character-edit-trigger"
              onClick={() => openCharacterEditor(selectedCharacter)}
              aria-label={`Edit ${selectedCharacter.name}`}
              title="Edit character"
            >
              {avatarContent(selectedCharacter)}
            </button>
            <div className="title">
              <button
                type="button"
                className="name chat-character-edit-trigger"
                onClick={() => openCharacterEditor(selectedCharacter)}
                title="Edit character"
              >
                {selectedCharacter.name}
              </button>
              <div className="status">{selectedCharacter.role || 'Conversation partner'} · {behaviorStatus}</div>
            </div>
          </div>
        </div>

        <ChatWindow
          messages={messages}
          character={selectedCharacter}
          onEditCharacter={() => openCharacterEditor(selectedCharacter)}
        />
        <InputBox onSend={sendMessage} language={selectedCharacter.language} />
      </main>

      {showCharacterEditor && editingCharacter && (
        <div className="character-modal-backdrop" onClick={closeCharacterEditor}>
          <div
            className="character-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="character-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="character-modal-header">
              <div id="character-modal-title" className="character-modal-title">
                {editingCharacter.id ? 'Edit Character' : 'Add Character'}
              </div>
              <button type="button" className="character-modal-close" onClick={closeCharacterEditor} aria-label="Close">×</button>
            </div>

            <div className="character-form-grid">
              <div className="character-avatar-editor field-wide">
                <span>Avatar</span>
                <div className="character-avatar-row">
                  <button
                    type="button"
                    className="character-avatar-picker"
                    onClick={() => avatarFileInputRef.current?.click()}
                    aria-label="Upload avatar"
                  >
                    {avatarContent(editingCharacter)}
                    <span className="avatar-upload-overlay">Upload</span>
                  </button>
                  <div className="character-avatar-tools">
                    {editingCharacter.avatar && (
                      <button
                        type="button"
                        className="avatar-tool-button secondary"
                        onClick={() => setEditingCharacter(prev => prev ? { ...prev, avatar: '' } : prev)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    ref={avatarFileInputRef}
                    type="file"
                    accept="image/*"
                    className="avatar-file-input"
                    onChange={handleAvatarFileSelected}
                  />
                </div>
              </div>

              {editableFields.map(field => (
                <label
                  key={String(field.key)}
                  className={"character-field " + (field.multiline ? 'field-wide' : '')}
                >
                  <span>{field.label}</span>
                  {field.multiline ? (
                    <textarea
                      value={editingCharacter[field.key] || ''}
                      onChange={(e) => setEditingCharacter(prev => prev ? { ...prev, [field.key]: e.target.value } : prev)}
                    />
                  ) : (
                    <input
                      value={editingCharacter[field.key] || ''}
                      onChange={(e) => setEditingCharacter(prev => prev ? { ...prev, [field.key]: e.target.value } : prev)}
                      autoFocus={field.key === 'name'}
                    />
                  )}
                </label>
              ))}

              {editingCharacter.id && (
                <div className="character-metadata field-wide">
                  <span>ID: {editingCharacter.id}</span>
                  {editingCharacter.createdAt && <span>Created: {new Date(editingCharacter.createdAt).toLocaleString()}</span>}
                  {editingCharacter.updatedAt && <span>Updated: {new Date(editingCharacter.updatedAt).toLocaleString()}</span>}
                </div>
              )}
            </div>

            {characterEditorError && <div className="character-form-error" role="alert">{characterEditorError}</div>}

            <div className="character-modal-actions">
              <button type="button" className="character-cancel" onClick={closeCharacterEditor} disabled={isSavingCharacter}>Cancel</button>
              <button type="button" className="character-save" onClick={handleCharacterEditorSave} disabled={isSavingCharacter}>
                {isSavingCharacter ? 'Saving...' : editingCharacter.id ? 'Save Changes' : 'Add Character'}
              </button>
            </div>
          </div>
        </div>
      )}

      {avatarCropSource && (
        <div className="avatar-crop-backdrop" onClick={closeAvatarCropper}>
          <div
            className="avatar-crop-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="avatar-crop-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="avatar-crop-header">
              <div id="avatar-crop-title" className="avatar-crop-title">Crop Avatar</div>
              <button type="button" className="character-modal-close" onClick={closeAvatarCropper} aria-label="Close">×</button>
            </div>
            <div
              ref={avatarCropViewportRef}
              className={"avatar-crop-viewport " + (isDraggingAvatar ? 'dragging' : '')}
              onPointerDown={handleAvatarCropPointerDown}
              onPointerMove={handleAvatarCropPointerMove}
              onPointerUp={handleAvatarCropPointerUp}
              onPointerCancel={handleAvatarCropPointerUp}
            >
              <img
                ref={avatarCropImageRef}
                src={avatarCropSource}
                alt=""
                className={"avatar-crop-image fit-" + avatarCropFit}
                style={{
                  transform: `translate(-50%, -50%) translate(${avatarCropPosition.x}px, ${avatarCropPosition.y}px) scale(${avatarCropScale})`
                }}
                onLoad={(event) => {
                  const image = event.currentTarget
                  setAvatarCropFit(image.naturalWidth > image.naturalHeight ? 'wide' : 'tall')
                  setAvatarCropPosition(prev => clampAvatarCropPosition(prev))
                }}
                draggable={false}
              />
              <div className="avatar-crop-grid" aria-hidden="true" />
            </div>
            <label className="avatar-zoom-control">
              <span>Zoom</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.01"
                value={avatarCropScale}
                onChange={handleAvatarCropScaleChange}
              />
            </label>
            <div className="avatar-crop-actions">
              <button type="button" className="character-cancel" onClick={closeAvatarCropper}>Cancel</button>
              <button type="button" className="character-save" onClick={applyAvatarCrop}>Use Avatar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
