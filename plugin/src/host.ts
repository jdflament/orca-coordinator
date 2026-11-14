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
