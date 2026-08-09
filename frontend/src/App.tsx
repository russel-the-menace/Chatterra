import React, { useEffect, useState } from 'react'
import { getStoredSession, WebLoginSession } from './api'
import ChatPage from './pages/ChatPage'
import LoginPage from './pages/LoginPage'

type Appearance = 'automatic' | 'light' | 'dark'
const APPEARANCE_STORAGE_KEY = 'chatterra.web.appearance'

const readStoredAppearance = (): Appearance => {
  const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'automatic'
}

const applyAppearance = (appearance: Appearance) => {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  const resolved = appearance === 'automatic'
    ? (systemTheme.matches ? 'dark' : 'light')
    : appearance
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

export default function App(): JSX.Element{
  const [session, setSession] = useState<WebLoginSession | undefined>(() => getStoredSession())
  const [appearance, setAppearance] = useState<Appearance>(readStoredAppearance)
  useEffect(() => {
    const syncPreference = () => setAppearance(readStoredAppearance())
    window.addEventListener('chatterra-appearance-changed', syncPreference)
    return () => window.removeEventListener('chatterra-appearance-changed', syncPreference)
  }, [])
  useEffect(() => {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
    const syncTheme = () => applyAppearance(appearance)
    syncTheme()
    if (appearance !== 'automatic') return undefined
    systemTheme.addEventListener('change', syncTheme)
    return () => systemTheme.removeEventListener('change', syncTheme)
  }, [appearance, session])
  useEffect(() => {
    const handleExpiredSession = () => setSession(undefined)
    window.addEventListener('chatterra-auth-expired', handleExpiredSession)
    return () => window.removeEventListener('chatterra-auth-expired', handleExpiredSession)
  }, [])
  if (!session) return <LoginPage onAuthenticated={setSession} />
  return <ChatPage onLoggedOut={() => setSession(undefined)} />
}
