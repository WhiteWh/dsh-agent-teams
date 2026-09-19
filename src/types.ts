/**
 * Durable AgentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-agent-teams/types
 */

/** Task lifecycle statuses in progression order. */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  /** Work is finished but a path outside inScope needs the captain's decision. */
  | 'awaiting_scope_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Replaced by another task (`supersededBy`); terminal, and not a failure. */
  | 'superseded'

/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled', 'superseded']

/**
 * Terminal statuses that mean "this work will never finish", as opposed to
 * `completed` (done) or `failed` (red, but evidence of a real attempt). Dead work
 * keeps its history without blocking delivery, and the scheduler never
 * dispatches it.
 */
export const DEAD_TASK_STATUSES: readonly TaskStatus[] = ['cancelled', 'superseded']

/** Statuses in which a task can still change (nothing terminal is in here). */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['pending', 'claimed', 'in_progress']

/**
 * Statuses that mean "this task is settled": finished, red, dead. The panel and
 * the progress summary treat all four the same way — the work is not pending.
 */
export const SETTLED_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled', 'superseded']

/** Structured quality-gate kind. Absent / unknown values are treated as `work`. */
export type TaskKind =
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'work'

export const TASK_KINDS: readonly TaskKind[] = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
  'work',
]

/** Review / requirements conclusion. Only `pass` may complete those kinds. */
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject' | 'stale'

/**
 * Verdicts a reviewer may submit and the durable layer accepts.
 *
 * `stale` is deliberately in this list but not in the `update_task` parameter
 * enum: only the captain's forced contract amendment produces it, by invalidating
 * a review that passed judgment on a contract that has since changed.
 */
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['pass', 'needs_revision', 'reject', 'stale']

/** Finding severity used by review / requirements output. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'blocker'

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['low', 'medium', 'high', 'blocker']

/** One structured review finding. */
export interface ReviewFinding {
  /** Stable id, for example `SEC-001`. */
  id: string
  severity: FindingSeverity
  file?: string
  line?: number
  problem: string
  requiredFix: string
  resolved?: boolean
}

/** One acceptance criterion result recorded at completion. */
export interface AcceptanceResult {
  criterion: string
  /**
   * `waived` means the criterion could not be measured honestly — it is red on
   * the baseline for a reason outside this task, or no measurement exists. It
   * counts as covered only with a non-empty {@link AcceptanceResult.evidence}
   * naming the reason, and the captain's reviewer has to confirm it before the
   * team may declare delivery.
   */
  status: 'passed' | 'failed' | 'waived'
  evidence?: string
}

/** How one acceptance criterion is judged. */
export type AcceptanceMode = 'pass' | 'no_regression'

/**
 * One acceptance criterion. A bare string is the `pass` mode. `no_regression`
 * means "not worse than the named baseline", so a `passed` result has to carry
 * the baseline reference in its evidence.
 */
export interface AcceptanceCriterion {
  text: string
  mode?: AcceptanceMode
  baseline?: string
}

/** One verification command result recorded at completion. */
export interface CommandResult {
  command: string
  /** `waived` requires a non-empty {@link CommandResult.evidence}, like acceptance. */
  status: 'passed' | 'failed' | 'waived'
  exitCode?: number
  evidence?: string
}

/** What one review confirms about the waivers of the task it judged. */
export interface WaiverConfirmation {
  /** Task whose waivers are being confirmed. */
  taskId: string
  /** Why the waivers are acceptable. */
  reason: string
  /** Optional machine-readable list of the waived criteria/commands. */
  waived?: string[]
}

/** Profile / team review-loop limits. */
export interface ReviewPolicy {
  requirementsMinRounds?: number
  requirementsMaxRounds?: number
  codeMaxRounds?: number
  maxRepairAttempts?: number
  requiredReviewers?: string[]
  /**
   * Whether a member may submit `waived` results at all. Defaults to true;
   * `false` turns a waiver into an ordinary gate failure.
   */
  allowWaivers?: boolean
}

/**
 * One known difference between this workspace and a check's expectation
 * (WP6.3): a check that is red for a reason outside the lane's control.
 *
 * Pinning it once lets a verification task whose `commandsRun` names `check`
 * submit `waived` with the pinned evidence instead of inventing a reason per
 * lane, and it keeps the delta visible in `agent_teams_status`.
 */
export interface KnownDelta {
  /** Stable id used by `pin_delta`/`unpin_delta` and by the auto evidence text. */
  id: string
  /** The command or criterion text this delta explains. */
  check: string
  /** What a green run would have to show. */
  expected: string
  /** Why the check is red here, in the captain's words. */
  reason: string
  /** Identity that pinned it (`captain`). */
  pinnedBy: string
  /** Epoch ms when it was pinned. */
  at: number
}

/** One captain-only contract amendment recorded on a quality task. */export interface TaskRevision {
  /** Epoch ms when the amendment was applied. */
  at: number
  /** Identity that applied it (`captain`). */
  by: string
  /** Why the previous contract was wrong; kept for the audit trail. */
  reason: string
  /** Amended contract field names (`objective`, `acceptance`, …). */
  fields: string[]
  /** Previous values of the amended fields; fields absent before are omitted. */
  previous: Record<string, unknown>
}

/** One task of a team's task list. */
export interface TeamTask {
  /** Stable task id from the profile template; absent for ad-hoc tasks. */
  profileSeedId?: string
  /** Stable task id within the team (`t1`, `t2`, …). */
  id: string
  /** Brief title for the task. */
  subject: string
  /** What needs to be done. */
  description?: string
  status: TaskStatus
  /** Member name (or `captain`) the task is assigned to; unassigned tasks await a claim. */
  assignee?: string
  /** Task ids that must reach `completed` before this task can be claimed. */
  dependencies: string[]
  /** The worker's written result, set when the task completes or fails. */
  output?: string
  /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
  attempt?: number
  /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
  attemptId?: string
  /** Opaque generation for a revocation/handoff that has not started its next attempt yet. */
  handoffId?: string
  /** Previous activation retained until a handoff drain succeeds (retryable). */
  handoffFromMemberId?: string
  /** A handoff is quiescing the old owner; the scheduler must not dispatch it yet. */
  reassigning?: boolean
  /** Quality-gate kind. Missing values are treated as `work`. */
  kind?: TaskKind
  /** Review / requirements / repair loop index, 1-based when present. */
  round?: number
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  /** Acceptance criteria: a plain string, or a `{text, mode?, baseline?}` object. */
  acceptance?: (string | AcceptanceCriterion)[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
  /**
   * Set when this task's latest report contains `waived` results. Delivery is
   * blocked until a `review` task against this task confirms them.
   */
  hasWaivers?: boolean
  /** Set on a `review` task when it confirms the waivers of the task it judged. */
  waiverConfirmation?: WaiverConfirmation
  reviewedTaskId?: string
  reviewedAttempt?: number
  /** Repair source: the implementation / previous successful artifact. */
  sourceTaskId?: string
  sourceFindingIds?: string[]
  /** User-constraint / goal items this task claims to cover. */
  coverageOf?: string[]
  /** Captain-only contract amendments, oldest first (see amendTaskContract). */
  revisions?: TaskRevision[]
  /**
   * The task that replaced this one, set when the status became `superseded`.
   * A dependency on a superseded task counts as satisfied once its replacement
   * is satisfied, recursively (see `unsatisfiedDependencies`).
   */
  supersededBy?: string
  createdAt: number
  updatedAt: number
}

/** Member lifecycle status. */
export type MemberStatus = 'idle' | 'working' | 'removed'

/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display name inside the team. */
  name: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** Resolved LLM provider route captured when this member was created. */
  provider?: string
  /** Resolved model captured when this member was created. */
  model?: string
  /** Resolved reasoning effort captured from the captain or target model default. */
  reasoningEffort?: string
  /** Prompt specific to this member's execution turns. */
  executionPrompt?: string
  /** Configured second-choice route. */
  fallback?: TeamModelFallback
  /** Active route after fallback, without changing the primary descriptor route. */
  activeProvider?: string
  activeModel?: string
  /** Whether the fallback route is currently active. */
  fallbackActive?: boolean
  joinedAt: number
  status: MemberStatus
  /** Execution admission is closed while a failed/pending handoff is drained. */
  stopping?: boolean
  /**
   * Last member-start failure, recorded so the captain can see why a member
   * never acquired a session instead of observing an unexplained `unspawned`
   * member. Cleared by the next successful start.
   */
  spawnError?: string
}

/** One mailbox message. */
export interface TeamMessage {
  id: string
  /** `captain` or a member name. */
  from: string
  /** `captain` or a member name. */
  to: string
  content: string
  ts: number
  /** Process-local delivery lease; prevents fallback and direct delivery racing. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
  /** Guidance is scoped to the recipient's execution generation, when present. */
  taskId?: string
  attemptId?: string
  /** Cancelled delivery is retained for audit but must not wake the recipient. */
  discardedAt?: number
}

/** Snapshot of the named profile used to seed a team. */
export interface TeamModelFallback {
  provider: string
  model: string
}

export interface TeamProfileSnapshot {
  name: string
  description?: string
  protocol?: string
  executionPrompt?: string
  fallback?: TeamModelFallback
  /** Frozen planning mode: captain plans the graph; seed keeps template tasks. */
  taskPlanning?: 'captain' | 'seed'
  /**
   * Paths every implementation/repair task of this team inherits from the
   * creating profile's `taskPlanning.sharedInScope` (WP4/S10). They are added to
   * the task's `inScope` and excluded from the overlap comparison.
   */
  sharedInScope?: string[]
  /**
   * Frozen progress weighting from `taskPlanning.weights` (WP8/S16): `'equal'`
   * makes the equal count the team's default percentage, a table overrides the
   * per-kind defaults. Absent means the built-in kind table.
   */
  progressWeights?: 'equal' | Record<string, number>
  /** Frozen review-loop policy from the creating profile. */
  reviewPolicy?: ReviewPolicy
}

/** The full durable team record. */
export interface TeamState {
  /** Original team name. */
  name: string
  /** Sanitized directory id; the team's stable identity. */
  id: string
  /** Team purpose/goal. */
  description?: string
  /** Immutable named profile snapshot, when created from a profile. */
  profile?: TeamProfileSnapshot
  /** Session id of the captain agent that owns this team. */
  captainSessionId: string
  createdAt: number
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
  /**
   * Checks that are known to be red here for a reason outside the lanes that run
   * them (WP6.3). Optional: teams created before the registry existed simply have
   * none, and a waiver then needs its own evidence as before.
   */
  knownDeltas?: KnownDelta[]
  /**
   * Two-phase execution lifecycle. Missing means `running` for durable
   * compatibility with teams created before staging existed.
   */
  phase?: 'staged' | 'running'
  /**
   * Human-facing review sub-state while `phase` is `staged`. Missing staged
   * records are treated as `awaiting_review` for backward compatibility.
   * `awaiting_feedback` means the user returned to chat and the Captain must
   * ask what should change before editing this same draft.
   */
  planReviewState?: 'awaiting_review' | 'awaiting_feedback'
  /** Timestamp written only after a staged plan is explicitly approved. */
  approvedAt?: number
  /**
   * Human halt from the captain chat. The team remains on disk, members stay
   * available, and unfinished work is cancelled until the captain resumes.
   */
  halted?: boolean
  /** Timestamp of the latest human halt, when present. */
  haltedAt?: number
  /** Review-loop policy snapshot copied from the creating profile, when present. */
  reviewPolicy?: ReviewPolicy
  /** Set when an automatic review/repair loop hits its configured ceiling. */
  escalated?: boolean
}
