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
    })) as { projects?: Project[] } | null
    if (!Array.isArray(answer?.projects)) throw new Error('Orca project.list returned no projects list')
    return answer.projects
  }
  const response = JSON.parse(await cli(['repo', 'list', '--json'])) as { result?: { repos?: Project[] } }
  return response.result?.repos ?? []
}
