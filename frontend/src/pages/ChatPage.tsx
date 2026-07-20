import React, {useState, useEffect, useMemo} from 'react'
import ChatWindow from '../components/ChatWindow'
import InputBox from '../components/InputBox'
import character, {characters, Character} from '../data/character'

type Message = { id: string; sender: 'ai' | 'user'; text: string; loading?: boolean }

const makeMessageId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`

export default function ChatPage(): JSX.Element{
  const [messages, setMessages] = useState<Message[]>([])
  const [userId, setUserIdentifier] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [selectedCharacter, setSelectedCharacter] = useState<Character>(character)
  const [searchText, setSearchText] = useState('')
  const [showAddDrawer, setShowAddDrawer] = useState(false)

  const visibleCharacters = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return characters
    return characters.filter(ch => [ch.name, ch.role, ch.company, ch.personality].join(' ').toLowerCase().includes(query))
  }, [searchText])

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

  useEffect(() => {
    let uid = localStorage.getItem('chatterra_userId')
    if (!uid) {
      uid = String(Date.now())
      localStorage.setItem('chatterra_userId', uid)
    }
    setUserIdentifier(uid)

    const savedCharacterId = localStorage.getItem('chatterra_characterId')
    const initialCharacter = characters.find(c => c.id === savedCharacterId) || character
    setSelectedCharacter(initialCharacter)
    void loadHistoryForCharacter(uid, initialCharacter)
  }, [])

  const handleCharacterSelect = (nextCharacter: Character) => {
    setSelectedCharacter(nextCharacter)
    localStorage.setItem('chatterra_characterId', nextCharacter.id)
    const uid = userId || localStorage.getItem('chatterra_userId')
    if (uid) void loadHistoryForCharacter(uid, nextCharacter)
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

  const handleAddAction = (action: 'group' | 'contacts' | 'note' | 'clear') => {
    setShowAddDrawer(false)

    if (action === 'clear') {
      void clearCurrentCharacterHistory()
      return
    }

    const labels = {
      group: 'Start Group Chat',
      contacts: 'Add Contacts',
      note: 'New Note'
    }

    window.alert(`${labels[action]} is not implemented yet.`)
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
                  <button type="button" className="drawer-item" onClick={() => handleAddAction('contacts')}>
                    <span className="drawer-icon">👤+</span>
                    <span>Add Contacts</span>
                  </button>
                  <button type="button" className="drawer-item" onClick={() => handleAddAction('note')}>
                    <span className="drawer-icon">▣</span>
                    <span>New Note</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="contacts-list">
          {visibleCharacters.map(ch => (
            <button
              key={ch.id}
              className={"contact-item " + (selectedCharacter.id === ch.id ? 'active' : '')}
              onClick={() => handleCharacterSelect(ch)}
            >
              <div className="contact-avatar">{ch.avatar || ch.name.slice(0, 1)}</div>
              <div className="contact-meta">
                <div className="contact-name">{ch.name}</div>
                <div className="contact-preview">{ch.personality}</div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="chat-pane">
        <div className="top-bar">
          <div className="title">
            <div className="name">{selectedCharacter.name}</div>
            <div className="status">{selectedCharacter.role} · Online</div>
          </div>
        </div>

        <ChatWindow messages={messages} />
        <InputBox onSend={sendMessage} />
      </main>
    </div>
  )
}
