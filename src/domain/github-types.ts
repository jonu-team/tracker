/** Подмножество ответов GitHub REST API, которое использует трекер. */

export interface GhUser {
  login: string
  id: number
  name?: string | null
  type?: string
}

export interface GhLabel {
  name: string
  color?: string
  description?: string | null
}

export type GhStateReason = 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null

export interface GhIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason?: GhStateReason
  labels: (GhLabel | string)[]
  assignees?: GhUser[] | null
  assignee?: GhUser | null
  user: GhUser | null
  comments: number
  created_at: string
  updated_at: string
  closed_at: string | null
  html_url: string
  pull_request?: unknown
}

export interface GhComment {
  id: number
  body: string
  user: GhUser | null
  created_at: string
  updated_at: string
  html_url: string
}

export interface GhRepo {
  id: number
  name: string
  full_name: string
  private: boolean
  default_branch: string
  has_issues: boolean
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean }
}

export interface GhContentFile {
  type: 'file' | 'dir'
  name: string
  path: string
  sha: string
  size: number
}

export interface IssuePatch {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null
  labels?: string[]
  assignees?: string[]
}

export interface NewIssue {
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
}

// GraphQL: история задачи. Версии описания GitHub отдаёт только через GraphQL.

export interface GqlLogin {
  login: string
}

interface GqlEvent {
  id: string
  createdAt: string
  actor: GqlLogin | null
}

export type GqlTimelineItem =
  | (GqlEvent & { __typename: 'LabeledEvent' | 'UnlabeledEvent'; label: { name: string } })
  /** Назначить можно и бота: тогда `login` есть, а у удалённого аккаунта — нет. */
  | (GqlEvent & { __typename: 'AssignedEvent' | 'UnassignedEvent'; assignee: Partial<GqlLogin> | null })
  | (GqlEvent & { __typename: 'RenamedTitleEvent'; previousTitle: string; currentTitle: string })
  | (GqlEvent & { __typename: 'ClosedEvent' | 'ReopenedEvent' })
  | {
      __typename: 'IssueComment'
      id: string
      databaseId: number
      createdAt: string
      author: GqlLogin | null
      body: string
      url: string
    }

/** Версия описания. `diff` — полный текст тела после правки; у удалённой версии — null. */
export interface GqlContentEdit {
  id: string
  editedAt: string
  deletedAt: string | null
  editor: GqlLogin | null
  diff: string | null
}

export interface GqlIssueActivity {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  createdAt: string
  updatedAt: string
  author: GqlLogin | null
  labels: { nodes: { name: string }[] } | null
  assignees: { nodes: GqlLogin[] }
  /**
   * Новые версии первыми. Самая старая — исходный текст: GitHub сохраняет его
   * при первой правке, поэтому у задачи без правок версий нет вовсе.
   */
  userContentEdits: { totalCount: number; nodes: GqlContentEdit[] } | null
  /** По времени; запрос берёт последние события. */
  timelineItems: { totalCount: number; nodes: GqlTimelineItem[] }
}

export function labelNames(issue: Pick<GhIssue, 'labels'>): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name))
}

export function assigneeLogins(issue: Pick<GhIssue, 'assignees' | 'assignee'>): string[] {
  if (issue.assignees?.length) return issue.assignees.map((user) => user.login)
  return issue.assignee ? [issue.assignee.login] : []
}
