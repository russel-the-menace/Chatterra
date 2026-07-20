import React, {useState} from 'react'

export default function InputBox({onSend}:{onSend:(text:string)=>void}): JSX.Element{
  const [text, setText] = useState('')
  const submit = ()=>{
    if(!text.trim()) return
    onSend(text.trim())
    setText('')
  }
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="input-box">
      <textarea
        value={text}
        onChange={e=>setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type your message..."
      />
      <button className="send" onClick={submit}>Send</button>
    </div>
  )
}
