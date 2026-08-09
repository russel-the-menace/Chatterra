import React, { useEffect, useState } from 'react'
import { getStoredSession, WebLoginSession } from './api'
import ChatPage from './pages/ChatPage'
import LoginPage from './pages/LoginPage'

export default function App(): JSX.Element{
  const [session, setSession] = useState<WebLoginSession | undefined>(() => getStoredSession())
  useEffect(() => {
    const handleExpiredSession = () => setSession(undefined)
    window.addEventListener('chatterra-auth-expired', handleExpiredSession)
    return () => window.removeEventListener('chatterra-auth-expired', handleExpiredSession)
  }, [])
  if (!session) return <LoginPage onAuthenticated={setSession} />
  return <ChatPage onLoggedOut={() => setSession(undefined)} />
}
