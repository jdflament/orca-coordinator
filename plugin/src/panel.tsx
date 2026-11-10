// The Coordinator panel: a clean overview of the coordinator's board —
// what needs the user, workstreams/features, tasks, repos/PRs, subagents —
// plus agents live in Orca (read straight from Orca, never mirrored).
// Orca draws this component tree itself; no DOM, no hooks: state lives in atoms.
import {
  atom,
  Badge,
  Box,
  Button,
  Card,
  Collapsible,
  EmptyState,
  Grid,
  Heading,
  host,
  IconButton,
  List,
  ListItem,
  on,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import type { BoardDecision, BoardOption, BoardSnapshot } from './protocol'

/** Done tasks kept in the collapsible before the "… and N older" note. */
const DONE_SHOWN = 15

/** The worker's last answer; null until it starts. */
const snapshot = atom<BoardSnapshot | null>(null)
/** Decisions this panel already reported to the worker (survives reloads). */
const answered = atom('answered', {} as Record<string, string>, { persist: 'plugin' })
/** Agents running in Orca terminals, straight from the host. */
const liveAgents = atom<{ terminalId?: string; title?: string; agent?: string; state: string }[]>([])
/** A transient message for the latest failed action. */
const failure = atom('')
/** Whether the coordinator's tab is the one on screen; null = unknown. */
const onCoordinatorTab = atom<boolean | null>(null)

async function respond(decision: BoardDecision, option: BoardOption): Promise<void> {
  try {
    await plugin.request('decision.respond', { decisionId: decision.id, optionId: option.id })
    set(failure, '')
    update(answered, (prev) => ({ ...prev, [decision.id]: option.label }))
  } catch (err) {
    set(failure, `could not record your choice: ${(err as Error).message}`)
  }
}

/** Quick actions queue into the inbox; the coordinator acts on its next turn. */
async function sendCommand(command: string, target: string): Promise<void> {
  try {
    await plugin.request('command.send', { command, target })
    set(failure, '')
  } catch (err) {
    set(failure, `could not send ${command}: ${(err as Error).message}`)
  }
}

/** The worker resolves the coordinator terminal and brings it to the front. */
async function focusCoordinator(): Promise<void> {
  try {
    const result = await plugin.request('coordinator.focus', {})
    set(failure, result.ok ? '' : result.error || 'could not find the coordinator terminal')
    if (result.ok) set(onCoordinatorTab, true)
  } catch (err) {
    set(failure, `could not jump to the coordinator: ${(err as Error).message}`)
  }
}

/** Where the jump button lives while the panel is open. */
const VISIBLE_POLL_MS = 3000

/** Runs once before the first render; subscriptions end with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('board.changed', (payload) => set(snapshot, payload)))
  ctx.subscriptions.push(
    on('agent.status.changed', ({ terminalId, title, state }) => {
      update(liveAgents, (list) => {
        const next = [...list]
        const index = terminalId ? next.findIndex((a) => a.terminalId === terminalId) : -1
        if (index === -1) next.push({ terminalId, title, state })
        else next[index] = { ...next[index], title: title ?? next[index].title, state }
        return next
      })
    })
  )
  // Seed live agents from Orca itself; the event above keeps them current.
  if (host.has('agents.list')) {
    host
      .call('agents.list')
      .then((agents) => {
        const list = Array.isArray(agents) ? agents : []
        set(
          liveAgents,
          list.map((a) => ({ terminalId: a.terminalId, title: a.title, agent: a.agent, state: a.state }))
        )
      })
      .catch(() => undefined)
  }
  void plugin.request('board.get').then(
    (payload) => set(snapshot, payload),
    (err) => set(snapshot, { board: null, error: `worker failed: ${(err as Error).message}`, boardPath: '' })
  )
  // "Is the coordinator's tab on screen?" — polled so the jump button hides
  // while the user is already looking at the coordinator.
  const refreshVisible = async (): Promise<void> => {
    try {
      const result = await plugin.request('coordinator.visible')
      if (result.ok) set(onCoordinatorTab, result.visible)
    } catch {
      // keep the last answer
    }
  }
  void refreshVisible()
  const poll = setInterval(() => void refreshVisible(), VISIBLE_POLL_MS)
  if (typeof (poll as { unref?: () => void }).unref === 'function') {
    ;(poll as { unref?: () => void }).unref()
  }
  ctx.subscriptions.push({ dispose: () => clearInterval(poll as unknown as number) })
}

function statusTone(status: string): string {
  if (status === 'done' || status === 'shipped' || status === 'success') return 'success'
  if (status === 'blocked' || status === 'waiting' || status === 'paused' || status === 'review') return 'warning'
  if (status === 'active' || status === 'working' || status === 'building') return 'accent'
  return 'neutral'
}

function repoIcon(kind: string): string {
  if (kind === 'pr') return 'branch'
  if (kind === 'feature') return 'rocket'
  return 'package'
}

function DecisionCard({ decision }: { decision: BoardDecision }) {
  const chosen = read(answered)[decision.id]
  const settled = decision.status === 'answered' || chosen !== undefined
  const answer = decision.answer ?? chosen
  return (
    <Card title={decision.title} description={decision.context || undefined}>
      {settled ? (
        <Row gap="xs" align="center">
          <Badge tone="success">answered</Badge>
          <Text size="sm">{answer}</Text>
        </Row>
      ) : (
        <Row gap="xs" wrap>
          {decision.options.map((option) => (
            <Button
              key={option.id}
              variant={option.recommended ? 'solid' : 'outline'}
              tone={option.recommended ? 'accent' : 'neutral'}
              size="sm"
              onPress={() => void respond(decision, option)}
            >
              {option.recommended ? `★ ${option.label}` : option.label}
            </Button>
          ))}
        </Row>
      )}
    </Card>
  )
}

function StopButton({ target, label }: { target: string; label: string }) {
  return (
    <IconButton
      icon="stop"
      label={`Stop ${label}`}
      tooltip="Ask the coordinator to stop this agent"
      size="sm"
      onPress={() => void sendCommand('stop', target)}
    />
  )
}

export default function Panel() {
  const current = read(snapshot)
  const failureText = read(failure)

  if (current === null) {
    return (
      <Progress label="Reading the board" />
    )
  }

  const board = current.board
  if (!board) {
    return (
      <EmptyState
        title="Board unavailable"
        description={current.error}
        icon="warning"
      />
    )
  }

  const tasks = board.tasks ?? []
  const decisions = board.decisions ?? []
  const pending = decisions.filter((d) => d.status !== 'answered' && read(answered)[d.id] === undefined)
  const workstreams = board.workstreams ?? []
  const repos = board.repos ?? []
  const subagents = board.agents ?? []
  const instructions = (board.instructions ?? []).filter((i) => i.status !== 'done')
  const live = read(liveAgents)
  const openTasks = tasks.filter((t) => t.status !== 'done')
  const doneTasks = tasks.filter((t) => t.status === 'done')
  const active = tasks.filter((t) => t.status === 'active').length
  const blocked = tasks.filter((t) => t.status === 'blocked').length
  const queued = tasks.filter((t) => t.status === 'queued').length
  const busy = live.filter((a) => a.state === 'working').length + subagents.filter((a) => a.state === 'working').length
  /** Nothing in flight: the panel falls back to just focus + what needs the user. */
  const idle = openTasks.length === 0 && busy === 0

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Coordinator</Heading>
        <Row gap="xs" align="center">
          <Badge tone="success">live</Badge>
          <RelativeTime at={Date.parse(board.updatedAt ?? '') || Date.now()} muted />
        </Row>
      </Row>

      {board.focus ? (
        <Text muted size="sm" truncate>
          {board.focus}
        </Text>
      ) : null}

      {openTasks.length > 0 ? (
        <Grid columns={3} gap="sm">
          <Card title="Active">
            <Badge tone="accent">{active}</Badge>
          </Card>
          <Card title="Blocked">
            <Badge tone={blocked > 0 ? 'warning' : 'neutral'}>{blocked}</Badge>
          </Card>
          <Card title="Queued">
            <Badge tone="neutral">{queued}</Badge>
          </Card>
        </Grid>
      ) : null}

      {!idle && instructions.length > 0 ? (
        <Stack gap="xs">
          <Heading level={3}>Instructions</Heading>
          <List label="Instructions">
            {instructions.map((instruction) => (
              <ListItem
                key={instruction.id}
                title={instruction.text}
                description={instruction.to || undefined}
                icon="lightbulb"
              />
            ))}
          </List>
        </Stack>
      ) : null}

      {pending.length > 0 ? (
        <Stack gap="sm">
          <Heading level={3}>Needs you</Heading>
          {pending.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </Stack>
      ) : null}

      {workstreams.length > 0 ? (
        <Stack gap="xs">
          <Heading level={3}>Features</Heading>
          <List label="Features">
            {workstreams.map((ws) => (
              <ListItem key={ws.id} title={ws.title} description={ws.notes || undefined} icon="layers">
                <Row justify="between" align="center" gap="sm">
                  <Badge tone={statusTone(ws.status)}>{ws.status}</Badge>
                  {ws.progress != null ? (
                    <Box grow>
                      <Progress label={`${ws.progress}%`} value={ws.progress} />
                    </Box>
                  ) : null}
                </Row>
              </ListItem>
            ))}
          </List>
        </Stack>
      ) : null}

      {repos.length > 0 ? (
        <Stack gap="xs">
          <Heading level={3}>Repos & PRs</Heading>
          <List label="Repos and PRs">
            {repos.map((repo) => (
              <ListItem
                key={repo.id}
                title={repo.name}
                description={repo.detail || undefined}
                icon={repoIcon(repo.kind)}
              >
                <Badge tone={statusTone(repo.status)}>{repo.status}</Badge>
              </ListItem>
            ))}
          </List>
        </Stack>
      ) : null}

      {subagents.length > 0 || live.length > 0 ? (
        <Stack gap="xs">
          <Row justify="between" align="center">
            <Heading level={3}>Agents</Heading>
            {busy > 0 ? <Badge tone="accent">{busy} working</Badge> : null}
          </Row>
          <List label="Agents">
            {subagents.map((agent) => (
              <ListItem
                key={agent.name}
                title={agent.name}
                description={[agent.role, agent.detail].filter(Boolean).join(' · ') || undefined}
                icon="agent"
              >
                <Row justify="between" align="center" gap="sm">
                  <Badge tone={statusTone(agent.state)}>{agent.state}</Badge>
                  {agent.state === 'working' ? (
                    <StopButton target={agent.name} label={agent.name} />
                  ) : null}
                </Row>
              </ListItem>
            ))}
            {live.map((agent) => (
              <ListItem
                key={`live-${agent.terminalId ?? agent.title ?? 'x'}`}
                title={agent.title ?? agent.agent ?? 'agent'}
                description={agent.agent || 'Orca terminal'}
                icon="terminal"
              >
                <Row justify="between" align="center" gap="sm">
                  <Badge tone={statusTone(agent.state)}>{agent.state}</Badge>
                  {agent.state === 'working' ? (
                    <StopButton target={agent.terminalId ?? ''} label={agent.title ?? 'agent'} />
                  ) : null}
                </Row>
              </ListItem>
            ))}
          </List>
        </Stack>
      ) : null}

      {tasks.length > 0 ? (
        <Stack gap="xs">
          <Heading level={3}>Tasks</Heading>
          <List label="Open tasks">
            {openTasks.map((task) => (
              <ListItem
                key={task.id}
                title={task.title}
                description={[task.assignee, task.detail].filter(Boolean).join(' · ') || undefined}
                icon={task.status === 'blocked' ? 'warning' : 'play'}
              >
                <Row justify="between" align="center" gap="sm">
                  <Badge tone={statusTone(task.status)}>{task.status}</Badge>
                  {task.status === 'blocked' ? (
                    <IconButton
                      icon="zap"
                      label={`Nudge ${task.id}`}
                      tooltip="Ask the coordinator to unblock and retry"
                      size="sm"
                      onPress={() => void sendCommand('nudge', task.id)}
                    />
                  ) : null}
                </Row>
              </ListItem>
            ))}
          </List>
          {doneTasks.length > 0 ? (
            <Collapsible title={`Done (${doneTasks.length})`}>
              <List label="Done tasks">
                {doneTasks.slice(-DONE_SHOWN).reverse().map((task) => (
                  <ListItem
                    key={task.id}
                    title={task.title}
                    description={task.assignee || undefined}
                    icon="check"
                  >
                    <Badge>done</Badge>
                  </ListItem>
                ))}
              </List>
              {doneTasks.length > DONE_SHOWN ? (
                <Text muted size="xs">
                  … and {doneTasks.length - DONE_SHOWN} older
                </Text>
              ) : null}
            </Collapsible>
          ) : null}
        </Stack>
      ) : null}

      {failureText ? (
        <Card title="Last action">
          <Text tone="danger" size="sm">
            {failureText}
          </Text>
        </Card>
      ) : null}

      {!idle && (board.log ?? []).length > 0 ? (
        <Stack gap="xs">
          <Heading level={3}>Log</Heading>
          {(board.log ?? []).slice(-6).map((entry) => (
            <Text key={entry.at + entry.text} muted size="xs" truncate>
              {entry.text}
            </Text>
          ))}
        </Stack>
      ) : null}

      {read(onCoordinatorTab) === false ? (
        <Button variant="outline" tone="neutral" onPress={() => void focusCoordinator()}>
          Jump to coordinator
        </Button>
      ) : null}
    </Stack>
  )
}
