/**
 * @chatkit/socketio — Socket.IO wiring for @chatkit/core, structurally typed
 * (no socket.io import; any io-shaped server works, and tests use fakes).
 *
 * Wiring order (presence must exist before the service):
 *
 *   const presence  = createPresenceTracker()
 *   const transport = createSocketTransport(io)
 *   const chat      = createChatService({ realtime: transport, presence, … })
 *   attachChatGateway({ io, chat, identity: tokenService, presence })
 *
 * `identity` is anything with `verifyAccess(token) → { userId }` —
 * @authkit/core's TokenService fits as-is.
 */
import type { ChatError, ChatService, PresenceLike, RealtimeLike } from '@chatkit/core'

// ─── Structural Socket.IO shapes ─────────────────────────────────────────────

export interface SocketLike {
  id: string
  data: Record<string, unknown>
  handshake: { auth?: Record<string, unknown>; headers?: Record<string, unknown> }
  join(room: string): unknown
  emit(event: string, payload: unknown): unknown
  on(event: string, cb: (...args: never[]) => void): unknown
}

export interface ServerLike {
  use(mw: (socket: SocketLike, next: (err?: Error) => void) => void): unknown
  on(event: 'connection', cb: (socket: SocketLike) => void): unknown
  to(room: string): { emit(event: string, payload: unknown): unknown }
}

/** @authkit/core TokenService satisfies this. */
export interface IdentityLike {
  verifyAccess(token: string): { userId: string; claims?: unknown }
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

export function defaultUserRoom(userId: string): string {
  return `chat:user:${userId}`
}

// ─── Transport (RealtimeLike over rooms) ─────────────────────────────────────

export function createSocketTransport(
  io: ServerLike,
  opts: { userRoom?: (userId: string) => string } = {},
): RealtimeLike {
  const userRoom = opts.userRoom ?? defaultUserRoom
  return {
    emitToUser(userId, event, payload) {
      io.to(userRoom(userId)).emit(event, payload)
    },
  }
}

// ─── Presence ────────────────────────────────────────────────────────────────

export interface PresenceTracker extends PresenceLike {
  /** Called by the gateway; exposed for tests/custom wiring. */
  connected(userId: string): void
  disconnected(userId: string): void
  onlineCount(): number
}

/** Counts live sockets per user — a user with 2 tabs stays online until both close. */
export function createPresenceTracker(): PresenceTracker {
  const sockets = new Map<string, number>()
  return {
    isOnline(userId) {
      return (sockets.get(userId) ?? 0) > 0
    },
    connected(userId) {
      sockets.set(userId, (sockets.get(userId) ?? 0) + 1)
    },
    disconnected(userId) {
      const next = (sockets.get(userId) ?? 1) - 1
      if (next <= 0) sockets.delete(userId)
      else sockets.set(userId, next)
    },
    onlineCount() {
      return sockets.size
    },
  }
}

// ─── Gateway ─────────────────────────────────────────────────────────────────

export interface AttachChatGatewayArgs {
  io: ServerLike
  chat: ChatService
  identity: IdentityLike
  /** Feed the tracker given to createChatService. */
  presence?: PresenceTracker
  /** Inbound event names — match your deployed clients. */
  inbound?: { send?: string; read?: string }
  /** Where the token lives on the handshake. Default: handshake.auth.token. */
  getToken?: (socket: SocketLike) => string | undefined
  userRoom?: (userId: string) => string
  /** Called when a verified user connects/disconnects (audit, presence fan-out). */
  onConnection?: (userId: string, socket: SocketLike) => void
}

interface SendPayload {
  scopeType?: string
  scopeId?: string
  text?: string
  data?: Record<string, unknown> | null
}

type Ack = (result: { ok: true; data?: unknown } | { ok: false; code: string; message: string }) => void

function isChatError(err: unknown): err is ChatError {
  return err instanceof Error && err.name === 'ChatError'
}

function toAckError(err: unknown): { ok: false; code: string; message: string } {
  if (isChatError(err)) return { ok: false, code: err.code, message: err.message }
  return { ok: false, code: 'INTERNAL', message: 'Something went wrong' }
}

export function attachChatGateway(args: AttachChatGatewayArgs): void {
  const { io, chat, identity, presence } = args
  const inboundSend = args.inbound?.send ?? 'chat:send'
  const inboundRead = args.inbound?.read ?? 'chat:read'
  const userRoom = args.userRoom ?? defaultUserRoom
  const getToken =
    args.getToken ??
    ((socket: SocketLike) => {
      const token = socket.handshake.auth?.token
      return typeof token === 'string' ? token : undefined
    })

  io.use((socket, next) => {
    const token = getToken(socket)
    if (!token) {
      next(new Error('UNAUTHENTICATED'))
      return
    }
    try {
      const { userId } = identity.verifyAccess(token)
      socket.data.userId = userId
      next()
    } catch {
      next(new Error('UNAUTHENTICATED'))
    }
  })

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string
    socket.join(userRoom(userId))
    presence?.connected(userId)
    args.onConnection?.(userId, socket)

    socket.on('disconnect' as never, (() => {
      presence?.disconnected(userId)
    }) as never)

    socket.on(inboundSend as never, (async (payload: SendPayload, ack?: Ack) => {
      try {
        if (!payload?.scopeType || !payload.scopeId || typeof payload.text !== 'string') {
          ack?.({ ok: false, code: 'INVALID_INPUT', message: 'scopeType, scopeId and text are required' })
          return
        }
        const message = await chat.sendMessage({
          scopeType: payload.scopeType,
          scopeId: payload.scopeId,
          senderId: userId,
          text: payload.text,
          data: payload.data ?? null,
        })
        ack?.({ ok: true, data: message })
      } catch (err) {
        ack?.(toAckError(err))
      }
    }) as never)

    socket.on(inboundRead as never, (async (payload: { threadId?: string }, ack?: Ack) => {
      try {
        if (!payload?.threadId) {
          ack?.({ ok: false, code: 'INVALID_INPUT', message: 'threadId is required' })
          return
        }
        await chat.markRead({ threadId: payload.threadId, userId })
        ack?.({ ok: true })
      } catch (err) {
        ack?.(toAckError(err))
      }
    }) as never)
  })
}
