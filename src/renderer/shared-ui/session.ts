import { useEffect, useState } from 'react'
import type { Session } from '../../shared'
import { api } from '../api'
const initial: Session = {
  id: '',
  updatedAt: 0,
  messages: [],
  running: false,
  approvals: [],
  tools: [],
  error: '',
  origin: 'chat',
  bubble: '',
}
export function useSession() {
  const [session, setSession] = useState(initial)
  useEffect(() => {
    const off = api.onSession(setSession)
    void api.getSession().then(setSession).catch(console.error)
    api.ready()
    return off
  }, [])
  return session
}
