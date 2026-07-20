import React, {useState} from 'react'
import ChatWindow from '../components/ChatWindow'
import InputBox from '../components/InputBox'
import CharacterCard from '../components/CharacterCard'
import character, {Character} from '../data/character'

type Message = { id: number; sender: 'ai' | 'user'; text: string }

export default function ChatPage(): JSX.Element{
  const [messages, setMessages] = useState<Message[]>([
    {id: 1, sender: 'ai', text: `Hello, I'm ${character.name}. Let's start the interview. Tell me briefly about your background.`}
  ])

  const sendMessage = async (text: string) => {
    if(!text) return
    const userMsg: Message = {id: Date.now(), sender: 'user', text}
    setMessages(prev=>[...prev, userMsg])

    try{
      const res = await fetch('http://localhost:3000/api/chat',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({message:text, history: messages, character})
      })
      const data = await res.json()
      const aiMsg: Message = {id: Date.now()+1, sender:'ai', text: data.reply}
      setMessages(prev=>[...prev, aiMsg])
    }catch(e){
      const errMsg: Message = {id: Date.now()+1, sender:'ai', text: 'Sorry, the server is unreachable.'}
      setMessages(prev=>[...prev, errMsg])
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
