import React, { FormEvent, useState } from 'react'
import { login, WebLoginSession } from '../api'

export default function LoginPage({
  onAuthenticated,
}: {
  onAuthenticated: (session: WebLoginSession) => void
}): JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!username.trim() || !password) {
      setError('Enter your username and password.')
      return
    }

    try {
      setSubmitting(true)
      setError('')
      onAuthenticated(await login(username.trim(), password))
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Could not sign in.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark" aria-hidden="true">C</div>
        <h1>Chatterra</h1>
        <p>Sign in to your conversations</p>

        <label>
          <span>Username</span>
          <input
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect="off"
            onChange={event => setUsername(event.target.value)}
            placeholder="Username"
            value={username}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            autoCapitalize="none"
            autoComplete="current-password"
            onChange={event => setPassword(event.target.value)}
            placeholder="Password"
            type="password"
            value={password}
          />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" disabled={submitting} type="submit">
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
