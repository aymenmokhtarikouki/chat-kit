/**
 * First-class GROUP chat on top of the scope model. A group is just another
 * scope type — the group row is the domain object, its member list is the
 * thread roster — so everything the engine already does (delivery, unread,
 * read receipts, rate limiting, offline push) works unchanged for N users.
 *
 * What this module adds is the part domain scopes get for free from the app
 * (an order already knows its parties) but user-created groups don't:
 * membership CRUD with owner/admin/member permissions, and membership events
 * posted into the thread as system messages (structured `data` for client
 * i18n; the English text is a fallback).
 *
 * Wiring order:
 *   const groupStore = createMemoryGroupStore()            // or your table
 *   const chat = createChatService({ policy: { scopes: { group: groupScope(groupStore) } }, … })
 *   const groups = createGroupService({ store: groupStore, chat })
 */
import type { ChatService } from './service'
import { ChatError, ChatMessage, ScopePolicy } from './types'

// ─── Entities ────────────────────────────────────────────────────────────────

export type GroupRole = 'owner' | 'admin' | 'member'

export interface GroupMember {
  userId: string
  role: GroupRole
}

export interface ChatGroup {
  id: string
  name: string
  createdBy: string
  members: GroupMember[]
  createdAt: Date
}

// ─── Storage seam (the app implements this on its own schema) ────────────────

export interface GroupStore {
  create(data: { name: string; createdBy: string; members: GroupMember[] }): Promise<ChatGroup>
  findById(id: string): Promise<ChatGroup | null>
  setName(id: string, name: string): Promise<void>
  /** Full-roster write — keeps the store trivial and the update atomic. */
  setMembers(id: string, members: GroupMember[]): Promise<void>
  listForUser(userId: string): Promise<ChatGroup[]>
}

// ─── The scope: plugs a GroupStore into the chat policy ──────────────────────

/**
 * Scope policy for user-created groups. Register it once:
 * `policy: { scopes: { group: groupScope(groupStore) } }`.
 * Membership IS the roster — posting/reading stays members-only by the
 * engine's default participant checks.
 */
export function groupScope(store: GroupStore): ScopePolicy<ChatGroup> {
  return {
    loadScope: (id) => store.findById(id),
    participants: (group) => group.members.map((m) => m.userId),
  }
}

// ─── Membership events ───────────────────────────────────────────────────────

export type GroupEvent =
  | { type: 'group.created'; actorId: string; name: string }
  | { type: 'group.members_added'; actorId: string; userIds: string[] }
  | { type: 'group.member_removed'; actorId: string; userId: string }
  | { type: 'group.member_left'; userId: string }
  | { type: 'group.renamed'; actorId: string; name: string }
  | { type: 'group.role_changed'; actorId: string; userId: string; role: GroupRole }

function defaultDescribe(event: GroupEvent): string {
  switch (event.type) {
    case 'group.created':
      return `Group "${event.name}" created`
    case 'group.members_added':
      return event.userIds.length === 1 ? 'A member was added' : `${event.userIds.length} members were added`
    case 'group.member_removed':
      return 'A member was removed'
    case 'group.member_left':
      return 'A member left'
    case 'group.renamed':
      return `Group renamed to "${event.name}"`
    case 'group.role_changed':
      return 'A member role changed'
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface CreateGroupServiceArgs {
  store: GroupStore
  /** The chat service whose policy has `groupScope(store)` registered. */
  chat: ChatService
  /** The scope type the group scope was registered under. Default 'group'. */
  scopeType?: string
  /** Max members incl. owner. Default 256. */
  maxMembers?: number
  /** Group name length cap. Default 100. */
  nameMaxLength?: number
  /**
   * Post membership events into the thread as system messages (structured
   * `data` = the GroupEvent for client-side i18n). Default true; `describe`
   * overrides the fallback English copy. Set false to silence entirely.
   */
  systemMessages?: boolean
  describe?: (event: GroupEvent) => string
}

export interface GroupService {
  createGroup(input: { creatorId: string; name: string; memberIds?: string[] }): Promise<ChatGroup>
  /** owner/admin. Existing members are skipped, not errors. */
  addMembers(input: { groupId: string; actorId: string; memberIds: string[] }): Promise<ChatGroup>
  /** owner removes anyone (but owners); admin removes members only. */
  removeMember(input: { groupId: string; actorId: string; memberId: string }): Promise<ChatGroup>
  /** Anyone but the owner (transfer via setRole first, or delete app-side). */
  leaveGroup(input: { groupId: string; userId: string }): Promise<ChatGroup>
  /** owner/admin. */
  renameGroup(input: { groupId: string; actorId: string; name: string }): Promise<ChatGroup>
  /** owner only. Promoting to 'owner' transfers ownership (old owner → admin). */
  setRole(input: { groupId: string; actorId: string; memberId: string; role: GroupRole }): Promise<ChatGroup>
  /** Members-only view. */
  getGroup(input: { groupId: string; userId: string }): Promise<ChatGroup>
  listGroups(userId: string): Promise<ChatGroup[]>
}

export function createGroupService(args: CreateGroupServiceArgs): GroupService {
  const { store, chat } = args
  const scopeType = args.scopeType ?? 'group'
  const maxMembers = args.maxMembers ?? 256
  const nameMaxLength = args.nameMaxLength ?? 100
  const describe = args.describe ?? defaultDescribe
  const systemMessages = args.systemMessages ?? true

  function assertName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) throw new ChatError('EMPTY_MESSAGE', 400, 'Group name is required.')
    if (trimmed.length > nameMaxLength) {
      throw new ChatError('MESSAGE_TOO_LONG', 400, `Group names are limited to ${nameMaxLength} characters.`)
    }
    return trimmed
  }

  async function mustFind(groupId: string): Promise<ChatGroup> {
    const group = await store.findById(groupId)
    if (!group) throw new ChatError('SCOPE_NOT_FOUND', 404, 'Group not found.')
    return group
  }

  function memberOf(group: ChatGroup, userId: string): GroupMember {
    const member = group.members.find((m) => m.userId === userId)
    if (!member) throw new ChatError('NOT_PARTICIPANT', 403, 'You are not a member of this group.')
    return member
  }

  function assertManager(group: ChatGroup, userId: string): GroupMember {
    const member = memberOf(group, userId)
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new ChatError('POST_FORBIDDEN', 403, 'Only the owner or an admin can do that.')
    }
    return member
  }

  /** Membership event → system message (also re-syncs the thread roster). */
  async function announce(groupId: string, event: GroupEvent): Promise<ChatMessage | null> {
    if (!systemMessages) {
      // Still touch the thread so the roster re-syncs immediately.
      await chat.getOrCreateThread({ scopeType, scopeId: groupId })
      return null
    }
    return chat.postSystemMessage({
      scopeType,
      scopeId: groupId,
      text: describe(event),
      data: event as unknown as Record<string, unknown>,
    })
  }

  return {
    async createGroup({ creatorId, name, memberIds = [] }) {
      const cleanName = assertName(name)
      const unique = [...new Set(memberIds.filter((id) => id !== creatorId))]
      if (unique.length + 1 > maxMembers) {
        throw new ChatError('POST_FORBIDDEN', 400, `Groups are limited to ${maxMembers} members.`)
      }
      const group = await store.create({
        name: cleanName,
        createdBy: creatorId,
        members: [
          { userId: creatorId, role: 'owner' },
          ...unique.map((userId): GroupMember => ({ userId, role: 'member' })),
        ],
      })
      await announce(group.id, { type: 'group.created', actorId: creatorId, name: cleanName })
      return group
    },

    async addMembers({ groupId, actorId, memberIds }) {
      const group = await mustFind(groupId)
      assertManager(group, actorId)
      const existing = new Set(group.members.map((m) => m.userId))
      const added = [...new Set(memberIds)].filter((id) => !existing.has(id))
      if (added.length === 0) return group
      if (group.members.length + added.length > maxMembers) {
        throw new ChatError('POST_FORBIDDEN', 400, `Groups are limited to ${maxMembers} members.`)
      }
      const members = [...group.members, ...added.map((userId): GroupMember => ({ userId, role: 'member' }))]
      await store.setMembers(groupId, members)
      await announce(groupId, { type: 'group.members_added', actorId, userIds: added })
      return { ...group, members }
    },

    async removeMember({ groupId, actorId, memberId }) {
      const group = await mustFind(groupId)
      const actor = assertManager(group, actorId)
      const target = memberOf(group, memberId)
      if (target.role === 'owner') {
        throw new ChatError('POST_FORBIDDEN', 403, 'The owner cannot be removed.')
      }
      if (actor.role === 'admin' && target.role === 'admin') {
        throw new ChatError('POST_FORBIDDEN', 403, 'Admins can only remove members.')
      }
      const members = group.members.filter((m) => m.userId !== memberId)
      await store.setMembers(groupId, members)
      // Announce AFTER the write: the removed member no longer receives it.
      await announce(groupId, { type: 'group.member_removed', actorId, userId: memberId })
      return { ...group, members }
    },

    async leaveGroup({ groupId, userId }) {
      const group = await mustFind(groupId)
      const member = memberOf(group, userId)
      if (member.role === 'owner') {
        throw new ChatError(
          'POST_FORBIDDEN',
          403,
          'The owner cannot leave — transfer ownership first (setRole).',
        )
      }
      const members = group.members.filter((m) => m.userId !== userId)
      await store.setMembers(groupId, members)
      await announce(groupId, { type: 'group.member_left', userId })
      return { ...group, members }
    },

    async renameGroup({ groupId, actorId, name }) {
      const group = await mustFind(groupId)
      assertManager(group, actorId)
      const cleanName = assertName(name)
      await store.setName(groupId, cleanName)
      await announce(groupId, { type: 'group.renamed', actorId, name: cleanName })
      return { ...group, name: cleanName }
    },

    async setRole({ groupId, actorId, memberId, role }) {
      const group = await mustFind(groupId)
      const actor = memberOf(group, actorId)
      if (actor.role !== 'owner') {
        throw new ChatError('POST_FORBIDDEN', 403, 'Only the owner can change roles.')
      }
      memberOf(group, memberId)
      let members: GroupMember[]
      if (role === 'owner') {
        // Ownership transfer: exactly one owner at all times.
        members = group.members.map((m): GroupMember => {
          if (m.userId === memberId) return { ...m, role: 'owner' }
          if (m.userId === actorId) return { ...m, role: 'admin' }
          return m
        })
      } else {
        if (memberId === actorId) {
          throw new ChatError('POST_FORBIDDEN', 403, 'Transfer ownership before demoting yourself.')
        }
        members = group.members.map((m): GroupMember => (m.userId === memberId ? { ...m, role } : m))
      }
      await store.setMembers(groupId, members)
      await announce(groupId, { type: 'group.role_changed', actorId, userId: memberId, role })
      return { ...group, members }
    },

    async getGroup({ groupId, userId }) {
      const group = await mustFind(groupId)
      memberOf(group, userId)
      return group
    },

    async listGroups(userId) {
      return store.listForUser(userId)
    },
  }
}

// ─── In-memory reference store ───────────────────────────────────────────────

export function createMemoryGroupStore(): GroupStore & { rows: ChatGroup[] } {
  const rows: ChatGroup[] = []
  let seq = 0
  const clone = (g: ChatGroup): ChatGroup => ({ ...g, members: g.members.map((m) => ({ ...m })) })

  return {
    rows,
    async create(data) {
      const group: ChatGroup = {
        id: `grp_${++seq}`,
        name: data.name,
        createdBy: data.createdBy,
        members: data.members.map((m) => ({ ...m })),
        createdAt: new Date(),
      }
      rows.push(group)
      return clone(group)
    },
    async findById(id) {
      const row = rows.find((g) => g.id === id)
      return row ? clone(row) : null
    },
    async setName(id, name) {
      const row = rows.find((g) => g.id === id)
      if (row) row.name = name
    },
    async setMembers(id, members) {
      const row = rows.find((g) => g.id === id)
      if (row) row.members = members.map((m) => ({ ...m }))
    },
    async listForUser(userId) {
      return rows.filter((g) => g.members.some((m) => m.userId === userId)).map(clone)
    },
  }
}
