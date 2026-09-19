/**
 * AgentTeams session event types — pure types only, zero imports.
 *
 * This file intentionally imports nothing: both the host program (the
 * emitter in `events.ts`) and the browser program (the Conversation Node
 * definition) must be able to load these types and the `SessionEventMap`
 * declaration merge without pulling in host-side `Context` augmentations
 * (dsh-session's index declares `Context.sessions: SessionStore`, which
 * collides with the browser runtime's `ISessions` under the same name).
 * @module dsh-agent-teams/event-types
 */

/** Opens one team record: the captain created the team. */
export interface AgentTeamsTeamCreatedData {
  readonly teamId: string
  /** The captain session that owns this team (UI follows it). */
  readonly captainSessionId: string
  readonly name: string
  readonly description?: string
  readonly profile?: string
}

/** Records one member after its continuable subagent is spawned. */
export interface AgentTeamsMemberAddedData {
  readonly teamId: string
  readonly memberId: string
  readonly name: string
  readonly role?: string
}

/** Marks one member removed. */
export interface AgentTeamsMemberRemovedData {
  readonly teamId: string
  readonly memberId: string
}

/** Records one task in the team's task list. */
export interface AgentTeamsTaskCreatedData {
  readonly teamId: string
  readonly taskId: string
  readonly subject: string
  readonly dependencies: readonly string[]
  readonly assignee?: string
  readonly kind?: string
  readonly round?: number
}

/** Records one task status/assignee/output transition. */
export interface AgentTeamsTaskUpdatedData {
  readonly teamId: string
  readonly taskId: string
  readonly status: string
  readonly assignee?: string
  readonly output?: string
  readonly attempt?: number
  readonly attemptId?: string
  readonly verdict?: string
  readonly round?: number
}

/** Records one captain-only contract amendment on a task. */
export interface AgentTeamsTaskAmendedData {
  readonly teamId: string
  readonly taskId: string
  /** Amended contract field names (`objective`, `inScope`, …). */
  readonly fields: readonly string[]
  /** Why the previous contract was wrong. */
  readonly reason: string
  /** Reviews whose passing verdict a forced amendment invalidated. */
  readonly staledReviews?: readonly string[]
}

/** Records one captain-only replacement of a task that will not finish. */
export interface AgentTeamsTaskSupersededData {
  readonly teamId: string
  readonly taskId: string
  /** The task that replaced it. */
  readonly replacement: string
  readonly reason: string
  /** Non-terminal tasks whose dependencies or contracts were redirected. */
  readonly rewired: readonly string[]
}

/** Records one captain-only scope acceptance (post-hoc path acceptance). */
export interface AgentTeamsPathsAcceptedData {
  readonly teamId: string
  readonly taskId: string
  /** The paths added to the task's inScope. */
  readonly paths: readonly string[]
  readonly reason: string
}

/** Records one change to the pinned known-delta registry. */
export interface AgentTeamsDeltaPinnedData {
  readonly teamId: string
  readonly deltaId: string
  readonly check: string
  /** `pinned` or `unpinned`. */
  readonly action: 'pinned' | 'unpinned'
  readonly reason: string
}

/** Records a human halt from the captain chat. */
export interface AgentTeamsTeamHaltedData {
  readonly teamId: string
  readonly cancelledTasks: number
}

/** Records an explicit captain resume of a halted team. */
export interface AgentTeamsTeamResumedData {
  readonly teamId: string
  readonly reason: string
}

/** Closes one team record: the team was deleted. */
export interface AgentTeamsTeamDeletedData {
  readonly teamId: string
}

/** Records a staged plan that the user rejected before any member was spawned. */
export interface AgentTeamsPlanDiscardedData {
  readonly teamId: string
}

/** Records one rethink of a live plan (WP7): the diff the captain applied. */
export interface AgentTeamsPlanRevisedData {
  readonly teamId: string
  /** Monotone plan revision after this batch. */
  readonly revision: number
  /** Why the captain revised the plan (the batch reason). */
  readonly reason: string
  /** Task ids the batch created. */
  readonly added: readonly string[]
  /** Task ids the batch took out of the live graph by superseding them. */
  readonly removed: readonly string[]
  /** Task ids whose dependencies or owner the batch changed. */
  readonly rebound: readonly string[]
  /** Task ids whose running attempt the batch revoked. */
  readonly invalidated: readonly string[]
}

/** Records one mailbox message sent between team agents. */
export interface AgentTeamsMessageSentData {
  readonly teamId: string
  readonly messageId: string
  /** `captain` or a member name. */
  readonly from: string
  /** `captain` or a member name. */
  readonly to: string
  readonly content: string
  readonly ts: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one team record.
     * @param data - stable team identity and display name.
     */
    'agent-teams/team-created': AgentTeamsTeamCreatedData
    /**
     * Records one team member.
     * @param data - team identity, member child session, and display identity.
     */
    'agent-teams/member-added': AgentTeamsMemberAddedData
    /**
     * Records one member removal.
     * @param data - team identity and the member's child session id.
     */
    'agent-teams/member-removed': AgentTeamsMemberRemovedData
    /**
     * Records one task creation.
     * @param data - team identity, task id, subject, dependencies, assignee.
     */
    'agent-teams/task-created': AgentTeamsTaskCreatedData
    /**
     * Records one task transition.
     * @param data - team identity, task id, and the new status/assignee/output.
     */
    'agent-teams/task-updated': AgentTeamsTaskUpdatedData
    /**
     * Records one captain-only contract amendment.
     * @param data - team identity, task id, amended field names, and reason.
     */
    'agent-teams/task-amended': AgentTeamsTaskAmendedData
    /**
     * Records one captain-only replacement of a task that will not finish.
     * @param data - team identity, replaced task id, replacement id, reason, redirected ids.
     */
    'agent-teams/task-superseded': AgentTeamsTaskSupersededData
    /**
     * Records one captain-only post-hoc scope acceptance.
     * @param data - team identity, task id, accepted paths, reason.
     */
    'agent-teams/paths-accepted': AgentTeamsPathsAcceptedData
    /**
     * Records one change to the pinned known-delta registry.
     * @param data - team identity, delta id, check text, action, reason.
     */
    'agent-teams/delta-pinned': AgentTeamsDeltaPinnedData
    /**
     * Records one mailbox message.
     * @param data - team identity, sender, recipient, and content.
     */
    'agent-teams/message-sent': AgentTeamsMessageSentData
    /**
     * Records a human halt from the captain chat.
     * @param data - team identity and how many unfinished tasks were cancelled.
     */
    'agent-teams/team-halted': AgentTeamsTeamHaltedData
    /**
     * Records an explicit captain resume.
     * @param data - team identity and the resume reason.
     */
    'agent-teams/team-resumed': AgentTeamsTeamResumedData
    /**
     * Closes one team record after deletion.
     * @param data - stable team identity.
     */
    'agent-teams/team-deleted': AgentTeamsTeamDeletedData
    /**
     * Closes a staged plan rejected during pre-run review.
     * @param data - stable team identity.
     */
    'agent-teams/plan-discarded': AgentTeamsPlanDiscardedData

    /**
     * A live plan was revised in one atomic batch (WP7).
     * @param data - the revision and the diff it applied.
     */
    'agent-teams/plan-revised': AgentTeamsPlanRevisedData
  }
}

/**
 * The full set of `agent-teams/*` event names.
 *
 * The runtime list is the single source: the union type is derived from it, so a
 * new event cannot be added to the type without appearing here (and a test can
 * assert membership without re-typing the list).
 */
export const AGENT_TEAMS_EVENT_TYPES = [
  'agent-teams/team-created',
  'agent-teams/member-added',
  'agent-teams/member-removed',
  'agent-teams/task-created',
  'agent-teams/task-updated',
  'agent-teams/task-amended',
  'agent-teams/task-superseded',
  'agent-teams/paths-accepted',
  'agent-teams/delta-pinned',
  'agent-teams/plan-revised',
  'agent-teams/message-sent',
  'agent-teams/team-halted',
  'agent-teams/team-resumed',
  'agent-teams/team-deleted',
  'agent-teams/plan-discarded',
] as const

/** One `agent-teams/*` event name. */
export type AgentTeamsEventType = (typeof AGENT_TEAMS_EVENT_TYPES)[number]
