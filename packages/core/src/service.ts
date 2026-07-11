/**
 * The chat service. Every access flows through the scope policy; every sent
 * message flows the same pipeline:
 *
 *   policy.canPost → rate limit → persist → touch thread
 *     → realtime emit to every participant
 *     → presence miss → notifier ('chat.message_received') for offline ones
 *
 * Realtime/notifier failures never fail the send (fire-and-forget with an
 * onError hook) — the message is persisted; delivery is best-effort, exactly
 * like @aymenkits/notify-core's channel isolation.
 */
import { createRateLimiter, RateLimiter } from './ratelimit'
import {
  ChatError,
  ChatEventNames,
  ChatMessage,
  ChatThread,
  MessageStore,
  NotifierLike,
  PresenceLike,
  RealtimeLike,
  ScopePolicy,
  ThreadReadState,
  ThreadStore,
  ThreadWithUnread,
} from './types'

export interface CreateChatServiceArgs<Ctx = unknown> {
  stores: { threads: ThreadStore; messages: MessageStore }
  /** Scope type → its rules. Unknown types are rejected outright. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policy: { scopes: Record<string, ScopePolicy<any, Ctx>> }
  /** Delivery transport (@aymenkits/chat-socketio provides one). Omit in tests. */
  realtime?: RealtimeLike
  /** Online check — offline recipients get the notifier. Omit → notify all. */
  presence?: PresenceLike
  /** Pairs with @aymenkits/notify-core — offline recipients get 'chat.message_received'. */
  notifier?: NotifierLike
  /** Per-sender flood control. Default { windowMs: 10_000, max: 10 }; false disables. */
  rateLimit?: { windowMs: number; max: number } | false
  /** Outbound event names — match your deployed clients. */
  events?: Partial<ChatEventNames>
  /** Default 4000. */
  textMaxLength?: number
  /** Notification preview length. Default 140. */
  previewLength?: number
  /**
   * Shape the realtime payload your deployed clients expect (sync — thread
   * and message are already loaded). Default:
   * `{ threadId, scopeType, scopeId, message }`.
   */
  formatRealtimePayload?: (input: { thread: ChatThread; message: ChatMessage }) => unknown
  /** Delivery failure observability (sends never fail on it). */
  onError?: (stage: 'realtime' | 'notify', error: unknown) => void
  /** Clock override for tests. */
  now?: () => Date
}

export interface SendMessageInput<Ctx = unknown> {
  scopeType: string
  scopeId: string
  senderId: string
  text: string
  data?: Record<string, unknown> | null
  ctx?: Ctx
}

export interface ChatService<Ctx = unknown> {
  /** Find or create the thread for a scope; keeps the roster in sync. */
  getOrCreateThread(input: { scopeType: string; scopeId: string; ctx?: Ctx }): Promise<ChatThread>
  sendMessage(input: SendMessageInput<Ctx>): Promise<ChatMessage>
  /** App-authored message (status changes, offers) — no sender, notifies everyone. */
  postSystemMessage(input: {
    scopeType: string
    scopeId: string
    text: string
    data?: Record<string, unknown> | null
    ctx?: Ctx
  }): Promise<ChatMessage>
  /** Newest first; `before` pages backwards. */
  listMessages(input: {
    threadId: string
    userId: string
    before?: Date
    limit?: number
    ctx?: Ctx
  }): Promise<ChatMessage[]>
  listThreads(input: { userId: string; limit?: number; offset?: number }): Promise<{
    items: ThreadWithUnread[]
    total: number
  }>
  markRead(input: { threadId: string; userId: string }): Promise<void>
  unreadCount(input: { threadId: string; userId: string }): Promise<number>
  unreadTotal(input: { userId: string }): Promise<number>
  /**
   * "Seen by" — one entry per participant (readAt null = never opened).
   * Requires the optional ThreadStore.getReadStates.
   */
  readStates(input: { threadId: string; userId: string }): Promise<ThreadReadState[]>
}

const DEFAULT_EVENTS: ChatEventNames = {
  messageNew: 'chat:new_message',
  threadRead: 'chat:read',
}

export function createChatService<Ctx = unknown>(args: CreateChatServiceArgs<Ctx>): ChatService<Ctx> {
  const { stores, realtime, presence, notifier, onError } = args
  const now = args.now ?? (() => new Date())
  const events: ChatEventNames = { ...DEFAULT_EVENTS, ...args.events }
  const textMaxLength = args.textMaxLength ?? 4000
  const previewLength = args.previewLength ?? 140
  const limiter: RateLimiter | null =
    args.rateLimit === false
      ? null
      : createRateLimiter(args.rateLimit ?? { windowMs: 10_000, max: 10 }, () => now().getTime())

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function policyFor(scopeType: string): ScopePolicy<any, Ctx> {
    const p = args.policy.scopes[scopeType]
    if (!p) {
      throw new ChatError('UNKNOWN_SCOPE_TYPE', 400, `No chat policy for scope type '${scopeType}'.`)
    }
    return p
  }

  async function loadScopeOrThrow(scopeType: string, scopeId: string, ctx?: Ctx): Promise<unknown> {
    const scope = await policyFor(scopeType).loadScope(scopeId, ctx)
    if (!scope) throw new ChatError('SCOPE_NOT_FOUND', 404, `${scopeType} '${scopeId}' not found.`)
    return scope
  }

  function sameRoster(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    const set = new Set(a)
    return b.every((id) => set.has(id))
  }

  async function getOrCreate(scopeType: string, scopeId: string, ctx?: Ctx): Promise<{ thread: ChatThread; scope: unknown }> {
    const scope = await loadScopeOrThrow(scopeType, scopeId, ctx)
    const participantIds = policyFor(scopeType).participants(scope)
    let thread = await stores.threads.findByScope(scopeType, scopeId)
    if (!thread) {
      thread = await stores.threads.create({ scopeType, scopeId, participantIds })
    } else if (!sameRoster(thread.participantIds, participantIds)) {
      await stores.threads.setParticipants(thread.id, participantIds)
      thread = { ...thread, participantIds }
    }
    return { thread, scope }
  }

  function assertText(text: string): void {
    if (!text || text.trim().length === 0) {
      throw new ChatError('EMPTY_MESSAGE', 400, 'Message text is required.')
    }
    if (text.length > textMaxLength) {
      throw new ChatError('MESSAGE_TOO_LONG', 400, `Messages are limited to ${textMaxLength} characters.`)
    }
  }

  function emit(userIds: string[], event: string, payload: unknown): void {
    if (!realtime) return
    for (const userId of userIds) {
      try {
        realtime.emitToUser(userId, event, payload)
      } catch (err) {
        onError?.('realtime', err)
      }
    }
  }

  async function offlineAmong(userIds: string[]): Promise<string[]> {
    if (!presence) return userIds
    const flags = await Promise.all(userIds.map((id) => presence.isOnline(id)))
    return userIds.filter((_, i) => !flags[i])
  }

  async function deliver(thread: ChatThread, message: ChatMessage): Promise<void> {
    // Delivery must never fail a send: a throwing formatter is reported and
    // the default payload shape goes out instead.
    const defaultPayload = {
      threadId: thread.id,
      scopeType: thread.scopeType,
      scopeId: thread.scopeId,
      message,
    }
    let payload: unknown = defaultPayload
    if (args.formatRealtimePayload) {
      try {
        payload = args.formatRealtimePayload({ thread, message })
      } catch (err) {
        onError?.('realtime', err)
      }
    }
    emit(thread.participantIds, events.messageNew, payload)

    if (!notifier) return
    const recipients = thread.participantIds.filter((id) => id !== message.senderId)
    const offline = await offlineAmong(recipients)
    if (offline.length === 0) return
    try {
      await notifier.notify(offline, {
        type: 'chat.message_received',
        data: {
          threadId: thread.id,
          scopeType: thread.scopeType,
          scopeId: thread.scopeId,
          messageId: message.id,
          senderId: message.senderId,
          kind: message.kind,
          preview: message.text.slice(0, previewLength),
        },
      })
    } catch (err) {
      onError?.('notify', err)
    }
  }

  async function requireThread(threadId: string): Promise<ChatThread> {
    const thread = await stores.threads.findById(threadId)
    if (!thread) throw new ChatError('THREAD_NOT_FOUND', 404, 'Thread not found.')
    return thread
  }

  async function assertCanRead(thread: ChatThread, userId: string, ctx?: Ctx): Promise<void> {
    const policy = policyFor(thread.scopeType)
    if (policy.canRead) {
      const scope = await loadScopeOrThrow(thread.scopeType, thread.scopeId, ctx)
      if (await policy.canRead({ userId, scope, thread })) return
      throw new ChatError('READ_FORBIDDEN', 403, 'You cannot read this conversation.')
    }
    if (!thread.participantIds.includes(userId)) {
      throw new ChatError('NOT_PARTICIPANT', 403, 'You are not part of this conversation.')
    }
  }

  const service: ChatService<Ctx> = {
    async getOrCreateThread({ scopeType, scopeId, ctx }) {
      const { thread } = await getOrCreate(scopeType, scopeId, ctx)
      return thread
    },

    async sendMessage(input) {
      assertText(input.text)
      const { thread, scope } = await getOrCreate(input.scopeType, input.scopeId, input.ctx)

      if (!thread.participantIds.includes(input.senderId)) {
        throw new ChatError('NOT_PARTICIPANT', 403, 'You are not part of this conversation.')
      }
      const policy = policyFor(input.scopeType)
      if (policy.canPost && !(await policy.canPost({ userId: input.senderId, scope, thread }))) {
        throw new ChatError('POST_FORBIDDEN', 403, 'Posting is closed for this conversation.')
      }
      if (limiter) {
        const verdict = limiter.tryAcquire(input.senderId)
        if (!verdict.allowed) {
          throw new ChatError(
            'RATE_LIMITED',
            429,
            'You are sending messages too quickly.',
            verdict.retryAfterMs,
          )
        }
      }

      const message = await stores.messages.create({
        threadId: thread.id,
        senderId: input.senderId,
        kind: 'USER',
        text: input.text,
        data: input.data ?? null,
      })
      await stores.threads.touch(thread.id, now())
      await deliver(thread, message)
      return message
    },

    async postSystemMessage(input) {
      assertText(input.text)
      const { thread } = await getOrCreate(input.scopeType, input.scopeId, input.ctx)
      const message = await stores.messages.create({
        threadId: thread.id,
        senderId: null,
        kind: 'SYSTEM',
        text: input.text,
        data: input.data ?? null,
      })
      await stores.threads.touch(thread.id, now())
      await deliver(thread, message)
      return message
    },

    async listMessages({ threadId, userId, before, limit, ctx }) {
      const thread = await requireThread(threadId)
      await assertCanRead(thread, userId, ctx)
      return stores.messages.list(threadId, { before, limit: limit ?? 50 })
    },

    async listThreads({ userId, limit, offset }) {
      const { items, total } = await stores.threads.listForUser(userId, {
        limit: limit ?? 20,
        offset: offset ?? 0,
      })
      const withUnread: ThreadWithUnread[] = await Promise.all(
        items.map(async (thread) => ({
          thread,
          unreadCount: await stores.messages.countOthersSince(
            thread.id,
            userId,
            await stores.threads.getReadAt(thread.id, userId),
          ),
        })),
      )
      return { items: withUnread, total }
    },

    async markRead({ threadId, userId }) {
      const thread = await requireThread(threadId)
      if (!thread.participantIds.includes(userId)) {
        throw new ChatError('NOT_PARTICIPANT', 403, 'You are not part of this conversation.')
      }
      const at = now()
      await stores.threads.markRead(threadId, userId, at)
      // Read receipt to the other participants.
      emit(
        thread.participantIds.filter((id) => id !== userId),
        events.threadRead,
        { threadId, userId, at },
      )
    },

    async unreadCount({ threadId, userId }) {
      const thread = await requireThread(threadId)
      if (!thread.participantIds.includes(userId)) {
        throw new ChatError('NOT_PARTICIPANT', 403, 'You are not part of this conversation.')
      }
      return stores.messages.countOthersSince(threadId, userId, await stores.threads.getReadAt(threadId, userId))
    },

    async unreadTotal({ userId }) {
      // v1: bounded by the first page of threads (both apps show ≤20 in the
      // inbox); a dedicated store method can replace this without API change.
      const { items } = await service.listThreads({ userId, limit: 100 })
      return items.reduce((sum, t) => sum + t.unreadCount, 0)
    },

    async readStates({ threadId, userId }) {
      const thread = await requireThread(threadId)
      if (!thread.participantIds.includes(userId)) {
        throw new ChatError('NOT_PARTICIPANT', 403, 'You are not part of this conversation.')
      }
      if (!stores.threads.getReadStates) {
        throw new ChatError('NOT_SUPPORTED', 501, 'This store does not track read states.')
      }
      const stored = new Map(
        (await stores.threads.getReadStates(threadId)).map((s) => [s.userId, s.readAt]),
      )
      return thread.participantIds.map((id) => ({ userId: id, readAt: stored.get(id) ?? null }))
    },
  }
  return service
}
