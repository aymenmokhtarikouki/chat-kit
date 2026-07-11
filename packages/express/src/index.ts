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
import { ChatError, ChatService, GroupService } from '@chatkit/core'

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
  readStates: Handler
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

    /** GET /chat/threads/:id/read-states — "seen by" per participant. */
    async readStates(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const threadId = str(req.params?.id)
        if (!threadId) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'thread id is required' } })
          return
        }
        res.status(200).json(wrap(await chat.readStates({ threadId, userId })))
      } catch (err) {
        fail(res, next, err)
      }
    },
  }
}

/**
 * Group-chat endpoints over a GroupService (same conventions as the chat
 * handlers — envelope-agnostic, auth from req.auth.userId by default):
 *
 *   const g = createGroupHandlers(groups, { wrapResponse })
 *   router.post('/chat/groups',                    requireAuth, g.create)
 *   router.get('/chat/groups',                     requireAuth, g.list)
 *   router.get('/chat/groups/:id',                 requireAuth, g.get)
 *   router.post('/chat/groups/:id/members',        requireAuth, g.addMembers)
 *   router.delete('/chat/groups/:id/members/:uid', requireAuth, g.removeMember)
 *   router.post('/chat/groups/:id/leave',          requireAuth, g.leave)
 *   router.patch('/chat/groups/:id',               requireAuth, g.rename)
 *   router.post('/chat/groups/:id/role',           requireAuth, g.setRole)
 */
export function createGroupHandlers(
  groups: GroupService,
  options: ChatHandlersOptions = {},
): {
  create: Handler
  list: Handler
  get: Handler
  addMembers: Handler
  removeMember: Handler
  leave: Handler
  rename: Handler
  setRole: Handler
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
      res.status(err.status).json({ error: { code: err.code, message: err.message } })
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

  function param(req: MinimalRequest, res: MinimalResponse, name: string): string | null {
    const value = req.params?.[name]
    if (typeof value !== 'string' || value.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: `${name} is required` } })
      return null
    }
    return value
  }

  return {
    async create(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const body = (req.body ?? {}) as { name?: string; memberIds?: string[] }
        if (typeof body.name !== 'string') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name is required' } })
          return
        }
        const memberIds = Array.isArray(body.memberIds)
          ? body.memberIds.filter((id): id is string => typeof id === 'string')
          : []
        const group = await groups.createGroup({ creatorId: userId, name: body.name, memberIds })
        res.status(201).json(wrap(group))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async list(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        res.status(200).json(wrap(await groups.listGroups(userId)))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async get(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const groupId = param(req, res, 'id')
        if (!groupId) return
        res.status(200).json(wrap(await groups.getGroup({ groupId, userId })))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async addMembers(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const groupId = param(req, res, 'id')
        if (!groupId) return
        const body = (req.body ?? {}) as { memberIds?: string[] }
        const memberIds = Array.isArray(body.memberIds)
          ? body.memberIds.filter((id): id is string => typeof id === 'string')
          : []
        if (memberIds.length === 0) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'memberIds is required' } })
          return
        }
        res.status(200).json(wrap(await groups.addMembers({ groupId, actorId: userId, memberIds })))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async removeMember(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const groupId = param(req, res, 'id')
        const memberId = groupId && param(req, res, 'uid')
        if (!groupId || !memberId) return
        res.status(200).json(wrap(await groups.removeMember({ groupId, actorId: userId, memberId })))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async leave(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const groupId = param(req, res, 'id')
        if (!groupId) return
        res.status(200).json(wrap(await groups.leaveGroup({ groupId, userId })))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async rename(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const groupId = param(req, res, 'id')
        if (!groupId) return
        const body = (req.body ?? {}) as { name?: string }
        if (typeof body.name !== 'string') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name is required' } })
          return
        }
        res.status(200).json(wrap(await groups.renameGroup({ groupId, actorId: userId, name: body.name })))
      } catch (err) {
        fail(res, next, err)
      }
    },

    async setRole(req, res, next) {
      try {
        const userId = requireUser(req, res)
        if (!userId) return
        const groupId = param(req, res, 'id')
        if (!groupId) return
        const body = (req.body ?? {}) as { memberId?: string; role?: string }
        if (typeof body.memberId !== 'string' || !['owner', 'admin', 'member'].includes(body.role ?? '')) {
          res.status(400).json({
            error: { code: 'INVALID_INPUT', message: 'memberId and role (owner|admin|member) are required' },
          })
          return
        }
        res.status(200).json(
          wrap(
            await groups.setRole({
              groupId,
              actorId: userId,
              memberId: body.memberId,
              role: body.role as 'owner' | 'admin' | 'member',
            }),
          ),
        )
      } catch (err) {
        fail(res, next, err)
      }
    },
  }
}
