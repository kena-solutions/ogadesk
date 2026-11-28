'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { chatSocketUrl, reconnectDelay } from '@/lib/chat/client-state'
import type { ServerFrame } from '@/lib/chat/protocol'

const PING_MS = 25_000
const TYPING_SHOWN_MS = 5_000
/** How often we repeat "I am typing" while the teammate keeps typing. */
const TYPING_RESEND_MS = 3_000
const TYPING_IDLE_MS = 4_000

/**
 * A teammate's live link to a website-chat conversation: whether the visitor
 * is on the page and typing, and a way to tell the visitor we are typing.
 * Does nothing (and opens no socket) unless `enabled`.
 */
export function useChatRoom(conversationId: string | null, enabled: boolean) {
  const [visitorOnline, setVisitorOnline] = useState(false)
  const [visitorTyping, setVisitorTyping] = useState(false)
  const socket = useRef<WebSocket | null>(null)
  const typingOff = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSent = useRef(0)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled || !conversationId) return
    let closed = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | null = null
    let ping: ReturnType<typeof setInterval> | null = null

    const later = () => {
      if (!closed) retry = setTimeout(() => void connect(), reconnectDelay(attempt++))
    }

    const connect = async () => {
      if (closed) return
      let token: string | null = null
      try {
        const res = await fetch('/api/chat/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversationId }),
        })
        if (res.status === 404 || res.status === 403) return // not a chat we may join: stop quietly
        token = res.ok ? ((await res.json()) as { token?: string }).token ?? null : null
      } catch {
        token = null
      }
      if (closed) return
      if (!token) return later()

      let ws: WebSocket
      try {
        ws = new WebSocket(chatSocketUrl(window.location.origin, conversationId, token))
      } catch {
        return later()
      }
      socket.current = ws
      ws.onopen = () => {
        attempt = 0
        ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), PING_MS)
      }
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data === 'pong') return
        let frame: ServerFrame
        try {
          frame = JSON.parse(e.data) as ServerFrame
        } catch {
          return
        }
        if (frame.type === 'presence') {
          setVisitorOnline(frame.visitorOnline)
          if (!frame.visitorOnline) setVisitorTyping(false)
        } else if (frame.type === 'typing' && frame.from === 'visitor') {
          setVisitorTyping(frame.on)
          if (typingOff.current) clearTimeout(typingOff.current)
          if (frame.on) typingOff.current = setTimeout(() => setVisitorTyping(false), TYPING_SHOWN_MS)
        } else if (frame.type === 'message' && frame.message.sender_type === 'customer') {
          setVisitorTyping(false)
        }
      }
      ws.onclose = () => {
        if (ping) clearInterval(ping)
        setVisitorOnline(false)
        setVisitorTyping(false)
        if (socket.current === ws) socket.current = null
        later()
      }
      ws.onerror = () => ws.close()
    }
    void connect()

    return () => {
      // A different conversation (or none) must not inherit this one's state.
      setVisitorOnline(false)
      setVisitorTyping(false)
      closed = true
      if (retry) clearTimeout(retry)
      if (ping) clearInterval(ping)
      if (typingOff.current) clearTimeout(typingOff.current)
      if (idle.current) clearTimeout(idle.current)
      socket.current?.close()
      socket.current = null
    }
  }, [conversationId, enabled])

  const send = (on: boolean) => {
    const ws = socket.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'typing', on }))
  }

  /** Call on every keystroke (`on = true`) and when the draft is cleared or sent (`false`). */
  const sendTyping = useCallback((on: boolean) => {
    if (idle.current) clearTimeout(idle.current)
    if (!on) {
      lastSent.current = 0
      send(false)
      return
    }
    const now = Date.now()
    if (now - lastSent.current >= TYPING_RESEND_MS) {
      lastSent.current = now
      send(true)
    }
    idle.current = setTimeout(() => {
      lastSent.current = 0
      send(false)
    }, TYPING_IDLE_MS)
  }, [])

  return { visitorOnline, visitorTyping, sendTyping }
}
