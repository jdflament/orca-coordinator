// Orca operations the plugin needs: the plugin host API when this Orca offers the method
// (`host.has`), else the orca CLI. The host API's answer is not silently replaced by the CLI:
// when it fails, the error says which method.
import type { OrcaWorkerApi } from 'orca/worker'

export type Host = Pick<OrcaWorkerApi['host'], 'has'> & { call(method: string, params?: unknown): Promise<unknown> }
export type Cli = (args: string[]) => Promise<string>
export type Project = { id?: string; path?: string; displayName?: string; kind?: string }

/** Orca's projects (repos and folders): `project.list`, else `orca repo list`. */
export async function listProjects(host: Host | null, cli: Cli): Promise<Project[]> {
  if (host?.has('project.list')) {
    const answer = (await host.call('project.list', {}).catch((error: Error) => {
      throw new Error(`Orca project.list failed: ${error.message}`)
    })) as { projects?: { id: string; name: string; kind: string; path: string }[] } | null
    if (!Array.isArray(answer?.projects)) throw new Error('Orca project.list returned no projects list')
    // The host API names a project `name`; the CLI names it `displayName`.
    return answer.projects.map(({ id, name, kind, path }) => ({ id, path, displayName: name, kind }))
  }
  const response = JSON.parse(await cli(['repo', 'list', '--json'])) as { result?: { repos?: Project[] } }
  return response.result?.repos ?? []
}

export type ReportedAgent = { terminalId: string; kind: string }

/** The agents Orca reports in the focused workspace (`agents.list`): terminal and agent kind. Nothing else names an agent; no host API, no answer. */
export async function listReportedAgents(host: Host | null): Promise<ReportedAgent[]> {
  if (!host?.has('agents.list')) return []
  const answer = (await host.call('agents.list', {}).catch(() => null)) as { agents?: { terminalId: string | null; agent: string | null }[] } | null
  return (answer?.agents ?? []).filter((row) => row.agent).map((row) => ({ terminalId: String(row.terminalId ?? ''), kind: String(row.agent) }))
}

// ---- terminals ----
// The CLI names a terminal by handle (`term_…`), the host API by its own terminalId; Orca documents no mapping.
// The handle stays the identity (board, status line, CLI path). A host id is found per call: a terminal.list
// row of the handle's workspace whose id is the handle, else whose title is the handle's title and is unique.
// No unique row means no host id, and the CLI path runs.

export type TerminalRef = { handle: string; title: string; workspaceId: string }

/** Every terminal `orca terminal list` shows: the only list that has handles. */
export async function listCliTerminals(cli: Cli): Promise<TerminalRef[]> {
  const response = JSON.parse(await cli(['terminal', 'list', '--json'])) as { result?: { terminals?: { handle?: string; title?: string; worktreeId?: string }[] } }
  return (response.result?.terminals ?? []).map((row) => ({ handle: String(row.handle), title: String(row.title ?? ''), workspaceId: String(row.worktreeId ?? '') }))
}

async function findTerminal(cli: Cli, handle: string): Promise<TerminalRef | null> {
  return (await listCliTerminals(cli).catch(() => [])).find((terminal) => terminal.handle === handle) ?? null
}

async function hostCall<T>(host: Host, method: string, params: unknown): Promise<T> {
  return (await host.call(method, params).catch((error: Error) => {
    throw new Error(`Orca ${method} failed: ${error.message}`)
  })) as T
}

/** The host terminalId of a terminal, or null when the host API is missing, or names no single match. */
export async function hostTerminalId(host: Host | null, ref: TerminalRef | null): Promise<string | null> {
  if (!host?.has('terminal.list') || !ref?.workspaceId) return null
  const { terminals } = await hostCall<{ terminals?: { id: string; title?: string }[] }>(host, 'terminal.list', { workspaceId: ref.workspaceId })
  const rows = terminals ?? []
  if (rows.some((row) => row.id === ref.handle)) return ref.handle
  const sameTitle = ref.title ? rows.filter((row) => row.title === ref.title) : []
  return sameTitle.length === 1 ? sameTitle[0].id : null
}

/** Types text into a terminal and presses Enter: `terminal.sendText`, else two `orca terminal send`. */
export async function sendToTerminal(host: Host | null, cli: Cli, handle: string, text: string): Promise<void> {
  const id = host?.has('terminal.sendText') ? await hostTerminalId(host, await findTerminal(cli, handle)) : null
  if (host && id) {
    const answer = await hostCall<{ accepted?: boolean }>(host, 'terminal.sendText', { terminalId: id, text, enter: true })
    if (answer?.accepted === false) throw new Error('Orca terminal.sendText did not accept the text')
    return
  }
  await cli(['terminal', 'send', '--terminal', handle, '--text', text])
  await cli(['terminal', 'send', '--terminal', handle, '--text', '', '--enter'])
}

/** Shows a terminal and focuses its pane: `terminal.focus`, else `orca terminal switch`. */
export async function focusTerminal(host: Host | null, cli: Cli, handle: string): Promise<void> {
  const id = host?.has('terminal.focus') ? await hostTerminalId(host, await findTerminal(cli, handle)) : null
  if (host && id) {
    await hostCall(host, 'terminal.focus', { terminalId: id })
    return
  }
  await cli(['terminal', 'switch', '--terminal', handle])
}

/** Dispatched task titles by handle: `agents.list` `task.title` (it lists the focused workspace's agents only). */
export async function hostTaskTitles(host: Host | null, terminals: TerminalRef[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (!host?.has('agents.list')) return titles
  const { agents } = await hostCall<{ agents?: { terminalId: string | null; task?: { title: string } | null }[] }>(host, 'agents.list', {})
  const withTask = (agents ?? []).filter((row) => row.terminalId && row.task?.title)
  for (const terminal of withTask.length ? terminals : []) {
    const id = await hostTerminalId(host, terminal)
    const row = withTask.find((agent) => agent.terminalId === id)
    if (row?.task?.title) titles.set(terminal.handle, row.task.title)
  }
  return titles
}
