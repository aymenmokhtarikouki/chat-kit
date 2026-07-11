/**
 * @chatkit/express — REST endpoints over a ChatService (the polling/paging
 * side of chat; realtime lives in @chatkit/socketio). Structural req/res
 * typing (Express 4 + 5), envelope-agnostic, auth-agnostic: by default the
 * user id comes from `req.auth.userId` (authkit middleware), override with
 * `getUserId` for any other auth setup.
 *
 *   const h = createChatHandlers(chat, { wrapResponse: createApiResponse })
 *   router.get('/chat/threads',           requireAuth, h.listThreads)
 *   router.get('/chat/threads/:id/messages', requireAuth, h.listMessages)
 *   router.post('/chat/messages',         requireAuth, h.send)
 *   router.post('/chat/threads/:id/read', requireAuth, h.markRead)
 *   router.get('/chat/unread',            requireAuth, h.unreadTotal)
 *
 * Full request/response shapes: contracts/API.md.
 */
import { ChatError, ChatService } from '@chatkit/core'

export interface MinimalRequest {
  headers: Record<string, unknown>
  query?: Record<string, unknown>
  params?: Record<string, unknown>
  body?: unknown
  auth?: { userId: string }
}
export interface MinimalResponse {
  status(code: number): MinimalResponse
  json(body: unknown): unknown
}
export type NextFn = (err?: unknown) => void
export type Handler = (req: MinimalRequest, res: MinimalResponse, next?: NextFn) => Promise<void>

export interface ChatHandlersOptions {
  /** Wrap successful payloads in your app's envelope. */
  wrapResponse?: (data: unknown) => unknown
  /** Where the authenticated user id lives. Default: req.auth?.userId. */
  getUserId?: (req: MinimalRequest) => string | undefined
  /** 'respond' (default) sends errors; 'next' forwards to your middleware. */
  onError?: 'respond' | 'next'
}

export function createChatHandlers(
  chat: ChatService,
  options: ChatHandlersOptions = {},
): {
  listThreads: Handler
  listMessages: Handler
  send: Handler
  markRead: Handler
  unreadTotal: Handler
} {
  const wrap = options.wrapResponse ?? ((data: unknown) => data)
  const getUserId = options.getUserId ?? ((req: MinimalRequest) => req.auth?.userId)
  const errorMode = options.onError ?? 'respond'

  function fail(res: MinimalResponse, next: NextFn | undefined, err: unknown): void {
    if (errorMode === 'next' && next) {
      next(err)
      return
    }
    if (err instanceof ChatError) {
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
        },
      })
      return
    }
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } })
  }

  function requireUser(req: MinimalRequest, res: MinimalResponse): string | null {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } })
      return null
    }
    return userId
  }

  function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /** Hostile-input safe: '', 'abc', -1 → undefined; caps at `max`. */
  function num(value: unknown, max?: number): number | undefined {
    if (value === undefined || value === '') return undefined
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return undefined
    return max !== undefined ? Math.min(n, max) : n
  }

  /** Invalid dates never reach the store. */
  function date(value: unknown): Date | undefined {
    const raw = str(value)
    if (!raw) return undefined
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? undefined : d
  }

  return {
    async listThreads(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const q = req.query ?? {}
        const result = await chat.listThreads({
          userId,
          limit: num(q.limit, 100),
          offset: num(q.offset),
        })
        res.status(200).json(wrap(result))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async listMessages(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const threadId = str(req.params?.id)
        if (!threadId) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'thread id is required' } })
          return
        }
        const q = req.query ?? {}
        const messages = await chat.listMessages({
          threadId,
          userId,
          before: date(q.before),
          limit: num(q.limit, 100),
        })
        res.status(200).json(wrap(messages))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async send(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const body = (req.body ?? {}) as {
          scopeType?: string
          scopeId?: string
          text?: string
          data?: Record<string, unknown> | null
        }
        if (!body.scopeType || !body.scopeId || typeof body.text !== 'string') {
          res.status(400).json({
            error: { code: 'INVALID_INPUT', message: 'scopeType, scopeId and text are required' },
          })
          return
        }
        const message = await chat.sendMessage({
          scopeType: body.scopeType,
          scopeId: body.scopeId,
          senderId: userId,
          text: body.text,
          data: body.data ?? null,
        })
        res.status(201).json(wrap(message))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async markRead(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const threadId = str(req.params?.id)
        if (!threadId) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'thread id is required' } })
          return
        }
        await chat.markRead({ threadId, userId })
        res.status(200).json(wrap({ ok: true }))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async unreadTotal(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        res.status(200).json(wrap({ unread: await chat.unreadTotal({ userId }) }))
      } catch (err) {
        fail(res, next, err)
      }
    },
  }
}
