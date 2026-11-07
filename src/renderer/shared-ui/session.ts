import { useEffect, useState } from 'react'
import type { Session } from '../../shared'
import { api } from '../api'
import { observeSnapshot } from './synchronization'
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
    const off = observeSnapshot(api.getSession, api.onSession, setSession)
    api.ready()
    return off
  }, [])
  return session
}
