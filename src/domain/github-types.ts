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

export function labelNames(issue: Pick<GhIssue, 'labels'>): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name))
}

export function assigneeLogins(issue: Pick<GhIssue, 'assignees' | 'assignee'>): string[] {
  if (issue.assignees?.length) return issue.assignees.map((user) => user.login)
  return issue.assignee ? [issue.assignee.login] : []
}
