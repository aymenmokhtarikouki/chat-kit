/**
 * Core types. A chat THREAD is always attached to a SCOPE — the domain thing
 * the conversation is about: an order, a custom-cake inquiry, a salon↔customer
 * pair, a support case. The app declares each scope type in its policy; the
 * policy answers who the participants are and when posting is allowed. No
 * scope rule → no thread — deny by default.
 */

// ─── Entities ────────────────────────────────────────────────────────────────

export interface ChatThread {
  id: string
  scopeType: string
  scopeId: string
  /** Resolved from the policy at creation; refreshed when the roster drifts. */
  participantIds: string[]
  createdAt: Date
  lastMessageAt: Date | null
}

export type MessageKind = 'USER' | 'SYSTEM'

export interface ChatMessage {
  id: string
  threadId: string
  /** null for SYSTEM messages. */
  senderId: string | null
  kind: MessageKind
  text: string
  /** Structured payload (deep links, offer ids, …). */
  data: Record<string, unknown> | null
  createdAt: Date
}

export interface ThreadWithUnread {
  thread: ChatThread
  unreadCount: number
}

// ─── Storage seams (the app implements these on its own schema) ──────────────

export interface ThreadStore {
  create(data: { scopeType: string; scopeId: string; participantIds: string[] }): Promise<ChatThread>
  findByScope(scopeType: string, scopeId: string): Promise<ChatThread | null>
  findById(id: string): Promise<ChatThread | null>
  listForUser(
    userId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ items: ChatThread[]; total: number }>
  /** Bump lastMessageAt. */
  touch(threadId: string, at: Date): Promise<void>
  /** Roster drift (staff joined a salon, …) — keep the thread in sync. */
  setParticipants(threadId: string, participantIds: string[]): Promise<void>
  markRead(threadId: string, userId: string, at: Date): Promise<void>
  getReadAt(threadId: string, userId: string): Promise<Date | null>
}

export interface MessageStore {
  create(data: {
    threadId: string
    senderId: string | null
    kind: MessageKind
    text: string
    data: Record<string, unknown> | null
  }): Promise<ChatMessage>
  /** Newest first; `before` pages backwards through history. */
  list(threadId: string, opts: { before?: Date; limit: number }): Promise<ChatMessage[]>
  /** Unread = messages NOT sent by `userId`, created after `since` (null = all). */
  countOthersSince(threadId: string, userId: string, since: Date | null): Promise<number>
}

// ─── Pairs-with seams (shape-compatible with sibling kits) ───────────────────

/** Structurally satisfied by @notifykit/core's Notifier. */
export interface NotifierLike {
  notify(userIds: string | string[], event: { type: string; data?: unknown }): Promise<unknown>
}

/**
 * Delivery transport. @chatkit/socketio provides one over Socket.IO rooms;
 * anything with this shape works (SSE hub, tests, …).
 */
export interface RealtimeLike {
  emitToUser(userId: string, event: string, payload: unknown): void
}

/**
 * Presence check: recipients who are online get realtime only; offline ones
 * get the notifier (push). Omit presence → every recipient is also notified.
 * @chatkit/socketio's presence tracker satisfies this.
 */
export interface PresenceLike {
  isOnline(userId: string): boolean | Promise<boolean>
}

// ─── Policy — who chats with whom, about what ────────────────────────────────

export interface ScopePolicy<Scope = unknown, Ctx = unknown> {
  /** Load the domain object (order, inquiry, pair row). null → SCOPE_NOT_FOUND. */
  loadScope(scopeId: string, ctx?: Ctx): Promise<Scope | null> | Scope | null
  /** Who belongs to the thread — the roster. */
  participants(scope: Scope): string[]
  /** May this participant post right now? Default: yes (participants only). */
  canPost?(input: { userId: string; scope: Scope; thread: ChatThread }): boolean | Promise<boolean>
  /**
   * May this user read? Default: thread participants only (checked WITHOUT
   * loading the scope). Define it to allow e.g. admins — the scope is loaded
   * then.
   */
  canRead?(input: { userId: string; scope: Scope; thread: ChatThread }): boolean | Promise<boolean>
}

/** Outbound event names — override to match what deployed clients listen to. */
export interface ChatEventNames {
  /** New message in a thread. Default 'chat:new_message'. */
  messageNew: string
  /** Read receipt. Default 'chat:read'. */
  threadRead: string
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type ChatErrorCode =
  | 'UNKNOWN_SCOPE_TYPE'
  | 'SCOPE_NOT_FOUND'
  | 'THREAD_NOT_FOUND'
  | 'NOT_PARTICIPANT'
  | 'POST_FORBIDDEN'
  | 'READ_FORBIDDEN'
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'RATE_LIMITED'

export class ChatError extends Error {
  constructor(
    public code: ChatErrorCode,
    public status: number,
    message: string,
    /** Milliseconds until the next message is allowed (RATE_LIMITED only). */
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}
