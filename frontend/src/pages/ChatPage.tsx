import React, {useState} from 'react'
import ChatWindow from '../components/ChatWindow'
import InputBox from '../components/InputBox'
import CharacterCard from '../components/CharacterCard'
import character, {Character} from '../data/character'

type Message = { id: number; sender: 'ai' | 'user'; text: string; loading?: boolean }

export default function ChatPage(): JSX.Element{
  const [messages, setMessages] = useState<Message[]>([
    {id: 1, sender: 'ai', text: `Hello, I'm ${character.name}. Let's start the interview. Tell me briefly about your background.`}
  ])

  const sendMessage = async (text: string) => {
    if(!text) return
    const userMsg: Message = {id: Date.now(), sender: 'user', text}
    // append user message and a loading indicator for the assistant
    const loadingId = Date.now() + 1
    const loadingMsg: Message = {id: loadingId, sender: 'ai', text: '', loading: true}
    const updated = [...messages, userMsg, loadingMsg]
    setMessages(updated)

    try{
      const res = await fetch('http://localhost:3000/api/chat',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({message:text, history: updated, character})
      })
      const data = await res.json()
      const aiMsg: Message = {id: Date.now()+2, sender:'ai', text: data.reply}
      // replace loading message with real AI message
      setMessages(prev => prev.map(m => m.id === loadingId ? aiMsg : m))
    }catch(e){
      const errMsg: Message = {id: Date.now()+2, sender:'ai', text: 'Sorry, the server is unreachable.'}
      setMessages(prev => prev.map(m => m.id === loadingId ? errMsg : m))
    }
  }

  return (
    <div className="chat-page">
      <div className="top-bar">
        <button className="back">‹ Back</button>
        <div className="title">
          <div className="name">{character.name}</div>
          <div className="status">Online</div>
        </div>
      </div>

      <CharacterCard character={character} />

      <ChatWindow messages={messages} />

      <InputBox onSend={sendMessage} />
    </div>
  )
}
