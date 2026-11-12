// What a board link points at. Board items carry their own url (the coordinator writes it from
// the tool it used); the panel recognises a few common hosts only to pick an icon and a label.
// Any other host stays a plain link.
import type { LinkHost } from './protocol'

const HOSTS: [(host: string, url: URL) => boolean, LinkHost][] = [
  [(h) => h === 'linear.app', { name: 'Linear', kind: 'ticket' }],
  [(h, u) => h.endsWith('.atlassian.net') && u.pathname.startsWith('/wiki'), { name: 'Confluence', kind: 'doc' }],
  [(h) => h.endsWith('.atlassian.net'), { name: 'Jira', kind: 'ticket' }],
  [(h) => h === 'github.com', { name: 'GitHub', kind: 'code' }],
  [(h) => h === 'gitlab.com', { name: 'GitLab', kind: 'code' }],
  [(h) => h === 'slack.com' || h.endsWith('.slack.com'), { name: 'Slack', kind: 'chat' }],
  [(h) => h === 'notion.so' || h.endsWith('.notion.so') || h.endsWith('.notion.site'), { name: 'Notion', kind: 'doc' }]
]

export function linkHost(url: unknown): LinkHost | undefined {
  if (typeof url !== 'string' || !url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    return HOSTS.find(([match]) => match(host, parsed))?.[1]
  } catch {
    return undefined
  }
}
