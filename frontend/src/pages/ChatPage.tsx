import React, {useState, useEffect, useMemo} from 'react'
import ChatWindow from '../components/ChatWindow'
import InputBox from '../components/InputBox'
import seedCharacter, {characters as seedCharacters, Character} from '../data/character'

type Message = { id: string; sender: 'ai' | 'user'; text: string; loading?: boolean }
type CharacterTextKey = 'name' | 'avatar' | 'role' | 'company' | 'scenario' | 'goal' | 'language' | 'personality' | 'background' | 'systemPromptTemplate'
type CharacterSettingKey = 'maxResponseTokens' | 'temperature' | 'contextWindow'

const makeMessageId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`

const editableFields: Array<{
  key: CharacterTextKey
  label: string
  multiline?: boolean
}> = [
  { key: 'name', label: 'Name' },
  { key: 'avatar', label: 'Avatar' },
  { key: 'role', label: 'Role' },
  { key: 'company', label: 'Company' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'goal', label: 'Goal' },
  { key: 'language', label: 'Language' },
  { key: 'personality', label: 'Personality', multiline: true },
  { key: 'background', label: 'Background', multiline: true },
  { key: 'systemPromptTemplate', label: 'System Prompt Template', multiline: true }
]

const defaultCharacterSettings = {
  maxResponseTokens: 600,
  temperature: 0.7,
  contextWindow: 8
}

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
  systemPromptTemplate: '',
  defaultSettings: { ...defaultCharacterSettings }
})

export default function ChatPage(): JSX.Element{
  const [messages, setMessages] = useState<Message[]>([])
  const [userId, setUserIdentifier] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [characters, setCharacters] = useState<Character[]>(seedCharacters)
  const [selectedCharacter, setSelectedCharacter] = useState<Character>(seedCharacter)
  const [searchText, setSearchText] = useState('')
  const [showAddDrawer, setShowAddDrawer] = useState(false)
  const [showCharacterEditor, setShowCharacterEditor] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null)
  const [isSavingCharacter, setIsSavingCharacter] = useState(false)
  const [characterEditorError, setCharacterEditorError] = useState('')

  const visibleCharacters = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return characters
    return characters.filter(ch => [ch.name, ch.role, ch.company, ch.personality].join(' ').toLowerCase().includes(query))
  }, [characters, searchText])

  const starterMessage = (nextCharacter: Character) => {
    return nextCharacter.id === 'c2'
      ? 'Hi. First, I will correct your English and programmer mistakes, then I will help you practice naturally. Start by telling me about your current project.'
      : `Hello, I'm ${nextCharacter.name}. Let's start the interview. Tell me briefly about your background.`
  }

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

    setMessages([{ id: makeMessageId(), sender: 'ai', text: starterMessage(nextCharacter) }])
  }

  const openCharacterEditor = (character: Character) => {
    setEditingCharacter({
      ...character,
      defaultSettings: {
        ...defaultCharacterSettings,
        ...character.defaultSettings
      }
    })
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

  useEffect(() => {
    if (!showCharacterEditor) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCharacterEditor()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.classList.add('modal-open')

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.classList.remove('modal-open')
    }
  }, [showCharacterEditor, isSavingCharacter])

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

  const updateCharacterSetting = (key: CharacterSettingKey, rawValue: string) => {
    setEditingCharacter(prev => {
      if (!prev) return prev
      return {
        ...prev,
        defaultSettings: {
          ...prev.defaultSettings,
          [key]: rawValue === '' ? undefined : Number(rawValue)
        }
      }
    })
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
    setMessages([{ id: makeMessageId(), sender: 'ai', text: starterMessage(selectedCharacter) }])
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

  const sendMessage = (text: string) => {
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
            body: JSON.stringify({ message: text, history: updated, character: selectedCharacter, userId, conversationId })
          })
          const data = await res.json()
          if (data.conversationId && !conversationId) {
            setConversationId(data.conversationId)
            localStorage.setItem('chatterra_conversationId', data.conversationId)
          }
          const aiMsg: Message = { id: makeMessageId(), sender: 'ai', text: data.reply }
          setMessages(prev2 => prev2.map(m => m.id === loadingId ? aiMsg : m))
        } catch (e) {
          const errMsg: Message = { id: makeMessageId(), sender: 'ai', text: 'Sorry, the server is unreachable.' }
          setMessages(prev2 => prev2.map(m => m.id === loadingId ? errMsg : m))
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
            <div
              key={ch.id}
              className={"contact-item " + (selectedCharacter.id === ch.id ? 'active' : '')}
              onClick={() => handleCharacterSelect(ch)}
            >
              <button
                type="button"
                className="contact-avatar contact-edit-trigger"
                onClick={(e) => {
                  e.stopPropagation()
                  openCharacterEditor(ch)
                }}
                aria-label={`Edit ${ch.name}`}
              >
                {ch.avatar || ch.name.slice(0, 1)}
              </button>
              <div className="contact-meta">
                <button
                  type="button"
                  className="contact-name contact-edit-trigger"
                  onClick={(e) => {
                    e.stopPropagation()
                    openCharacterEditor(ch)
                  }}
                >
                  {ch.name}
                </button>
                <div className="contact-preview">{ch.personality}</div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-pane">
        <div className="top-bar">
          <div className="title">
            <div className="name">{selectedCharacter.name}</div>
            <div className="status">{selectedCharacter.role} · Online</div>
          </div>
          <button
            type="button"
            className="top-bar-edit"
            onClick={() => openCharacterEditor(selectedCharacter)}
            aria-label={`Edit ${selectedCharacter.name}`}
            title="Edit character"
          >
            ✎
          </button>
        </div>

        <ChatWindow messages={messages} />
        <InputBox onSend={sendMessage} />
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

              <fieldset className="character-settings field-wide">
                <legend>Model Settings</legend>
                <label className="character-field">
                  <span>Max Response Tokens</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={editingCharacter.defaultSettings?.maxResponseTokens ?? ''}
                    onChange={(e) => updateCharacterSetting('maxResponseTokens', e.target.value)}
                  />
                </label>
                <label className="character-field">
                  <span>Temperature</span>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={editingCharacter.defaultSettings?.temperature ?? ''}
                    onChange={(e) => updateCharacterSetting('temperature', e.target.value)}
                  />
                </label>
                <label className="character-field">
                  <span>Context Messages</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={editingCharacter.defaultSettings?.contextWindow ?? ''}
                    onChange={(e) => updateCharacterSetting('contextWindow', e.target.value)}
                  />
                </label>
              </fieldset>

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
    </div>
  )
}
