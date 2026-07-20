import React, {useState, useEffect} from 'react'
import ChatWindow from '../components/ChatWindow'
import InputBox from '../components/InputBox'
import character, {characters, Character} from '../data/character'

type Message = { id: number; sender: 'ai' | 'user'; text: string; loading?: boolean }

export default function ChatPage(): JSX.Element{
  const [messages, setMessages] = useState<Message[]>([])
  const [userId, setUserIdentifier] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [selectedCharacter, setSelectedCharacter] = useState<Character>(character)

  useEffect(()=>{
    // get or create a persistent userId
    let uid = localStorage.getItem('chatterra_userId')
    if (!uid) { uid = String(Date.now()); localStorage.setItem('chatterra_userId', uid); }
    setUserIdentifier(uid);

    const savedCharacterId = localStorage.getItem('chatterra_characterId')
    const initialCharacter = characters.find(c => c.id === savedCharacterId) || character;
    setSelectedCharacter(initialCharacter);

    // load conversations for user and latest messages
    (async ()=>{
      try{
        const cRes = await fetch(`http://localhost:3000/api/conversations?userId=${uid}`)
        if (!cRes.ok) throw new Error('no convs')
        const cData = await cRes.json()
        const matchingConversation = (cData.conversations || []).find((conv:any) => conv.characterId === initialCharacter.id) || (cData.conversations && cData.conversations.length>0 ? cData.conversations[0] : null)
        if (matchingConversation){
          const conv = matchingConversation
          setConversationId(conv.id)
          localStorage.setItem('chatterra_conversationId', conv.id);
          const mRes = await fetch(`http://localhost:3000/api/conversations/${conv.id}/messages`)
          const mData = await mRes.json()
          const mapped: Message[] = (mData.messages||[]).map((m:any)=>({ id: Number(String(m.id).slice(-9)) || Date.now(), sender: m.senderRole === 'user' ? 'user' : 'ai', text: m.content }))
          setMessages(mapped)
          return
        }
      }catch(e){
        // ignore and fall back to default greeting
      }
      // fallback: initial greeting
      setMessages([{id:1, sender:'ai', text: `Hello, I'm ${initialCharacter.name}. Let's start the conversation. Tell me briefly about your background.`}]);
    })()
  }, [])

  const handleCharacterSelect = (nextCharacter: Character) => {
    setSelectedCharacter(nextCharacter)
    localStorage.setItem('chatterra_characterId', nextCharacter.id)
    setConversationId(null)
    setMessages([{id:1, sender:'ai', text: nextCharacter.id === 'c2'
      ? 'Hi. First, I will correct your English and programmer mistakes, then I will help you practice naturally. Start by telling me about your current project.'
      : `Hello, I'm ${nextCharacter.name}. Let's start the interview. Tell me briefly about your background.`}])
  }

  const sendMessage = (text: string) => {
    if(!text) return
    const userMsg: Message = {id: Date.now(), sender: 'user', text}
    const loadingId = Date.now() + 1
    const loadingMsg: Message = {id: loadingId, sender: 'ai', text: '', loading: true}

    // use functional update to avoid stale state
    setMessages(prev => {
      const updated = [...prev, userMsg, loadingMsg]

      // fire-and-forget async request using the current updated history
      ;(async () => {
        try{
          const res = await fetch('http://localhost:3000/api/chat',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({message:text, history: updated, character: selectedCharacter, userId, conversationId})
          })
          const data = await res.json()
          // persist conversationId if provided
          if (data.conversationId && !conversationId) {
            setConversationId(data.conversationId)
            localStorage.setItem('chatterra_conversationId', data.conversationId)
          }
          const aiMsg: Message = {id: Date.now()+2, sender:'ai', text: data.reply}
          setMessages(prev2 => prev2.map(m => m.id === loadingId ? aiMsg : m))
        }catch(e){
          const errMsg: Message = {id: Date.now()+2, sender:'ai', text: 'Sorry, the server is unreachable.'}
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
          <div>
            <div className="app-title">Chatterra</div>
            <div className="app-subtitle">English practice</div>
          </div>
          <div className="me-dot">Me</div>
        </div>

        <div className="contacts-list">
          {characters.map(ch => (
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
