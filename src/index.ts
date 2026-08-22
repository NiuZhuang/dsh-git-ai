/**
 * Native git-ai bridge for the harness interception points. Listens on
 * `tools/pre-execute` / `tools/post-execute`, translates "which file an agent
 * edited, with which model, in which session" into git-ai's generic `agent-v1`
 * checkpoint payloads, and invokes `git-ai checkpoint <preset> --hook-input
 * stdin` with that JSON. git-ai itself is never modified: file-edit tools send
 * `ai_agent` checkpoints after a successful edit, and bash/pwsh tools bracket
 * every run with `pre_shell_command` / `post_shell_command` checkpoints so
 * git-ai's file snapshots attribute whatever the command changed.
 * @module @deepseek-ai/dsh-hooks-git-ai
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'hooks-git-ai'
export const inject = ['shell']

/** Plugin config: the git-ai executable, identity fields, and checkpoint knobs. */
export interface Config {
  /**
   * git-ai executable; a bare name resolves through PATH. The command is
   * shell-quoted, so a path with spaces is safe.
   */
  gitAiPath: string
  /** The agent name stamped on every checkpoint (the `agent_name` field). */
  agentName: string
  /** Explicit model stamp; empty falls back to `agent.options.model`. */
  model: string
  /** The git-ai generic-integration preset to invoke (`agent-v1`). */
  checkpointPreset: string
  /** git-ai invocation timeout in ms. */
  timeoutMs: number
  /** Whether bash/pwsh tools emit pre/post shell checkpoints (default true). */
  trackBash: boolean
}

export const Config: z<Config> = z.object({
  gitAiPath: z.string().default('git-ai'),
  agentName: z.string().default('deepseek-harness'),
  model: z.string().default(''),
  checkpointPreset: z.string().default('agent-v1'),
  timeoutMs: z.number().default(10_000),
  trackBash: z.boolean().default(true),
})

/** Tool names whose successful calls capture edited file paths. */
const FILE_EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
/** Tool names that run shell commands whose effects need before/after snapshots. */
const BASH_TOOLS = new Set(['bash', 'pwsh'])

/**
 * Run the plugin: register pre/post tool listeners that fire git-ai checkpoints.
 * Every git-ai failure is logged and swallowed so the agent flow never breaks.
 * @param ctx - Cordis context carrying the shell executor.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  /** bash call ids whose pre checkpoint ran; post fires only when this holds. */
  const pendingBash = new Set<string>()

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (config.trackBash && isBashTool(exec.name) && exec.agent) {
      pendingBash.add(exec.callId)
      await runCheckpoint(ctx, config, buildShellPayload(exec, exec.agent, config, 'pre_shell_command'), exec.signal)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    if (agent && isBashTool(exec.name) && pendingBash.delete(exec.callId)) {
      // The post snapshot closes the before/after pair even when the command failed.
      await runCheckpoint(ctx, config, buildShellPayload(exec, agent, config, 'post_shell_command'), exec.signal)
    } else if (agent && isFileEditTool(exec.name) && !result.isError) {
      const filePaths = extractEditedFilePaths(exec, agent)
      if (filePaths.length > 0) {
        await runCheckpoint(ctx, config, buildAiAgentPayload(agent, filePaths, config), exec.signal)
      }
    }
    return next()
  })
}

// --- payload construction ---

/** Identity fields shared by every agent-v1 payload. */
interface AgentV1Base {
  repo_working_dir: string
  agent_name: string
  model: string
  conversation_id: string
}

/** Fields common to one tool execution plus its owning agent. */
function basePayload(agent: Agent, config: Config): AgentV1Base {
  return {
    repo_working_dir: agent.session.header.cwd ?? process.cwd(),
    agent_name: config.agentName,
    model: config.model !== '' ? config.model : agent.options.model ?? '',
    conversation_id: agent.session.header.id,
  }
}

/** One agent-v1 checkpoint payload: identity fields plus its event type and per-event extras. */
interface AgentV1Checkpoint extends AgentV1Base {
  type: string
  edited_filepaths?: string[]
  tool_use_id?: string
  command?: string | undefined
}

/** A post-edit `ai_agent` payload listing the files the tool just changed. */
function buildAiAgentPayload(
  agent: Agent,
  filePaths: string[],
  config: Config,
): AgentV1Checkpoint {
  return {
    ...basePayload(agent, config),
    type: 'ai_agent',
    edited_filepaths: filePaths,
  }
}

/** A `pre_shell_command` / `post_shell_command` payload for one bash run. */
function buildShellPayload(
  exec: ToolExecution,
  agent: Agent,
  config: Config,
  type: 'pre_shell_command' | 'post_shell_command',
): AgentV1Checkpoint {
  return {
    ...basePayload(agent, config),
    type,
    tool_use_id: exec.callId,
    command: commandOf(exec.arguments),
  }
}

/** The `command` argument of a shell tool, or undefined when absent. */
function commandOf(args: unknown): string | undefined {
  const value = asObject(args)?.command
  return typeof value === 'string' ? value : undefined
}

/** Extract the absolute edited file paths a successful edit tool call reported. */
function extractEditedFilePaths(exec: ToolExecution, agent: Agent): string[] {
  const raw = asObject(exec.arguments)
  // Tool arguments cross the lossless-JSON materialization boundary and pass
  // schema validation before post-execute, so a non-object cannot reach here.
  /* v8 ignore next -- non-object arguments are rejected by tool schema validation */
  if (!raw) return []
  const cwd = agent.session.header.cwd ?? process.cwd()
  if (exec.name === 'write' || exec.name === 'edit') {
    return typeof raw.file_path === 'string' && raw.file_path.length > 0
      ? [resolvePath(raw.file_path, cwd)]
      : []
  }
  /* v8 ignore next -- write/edit returned above, so only str_replace_editor reaches here */
  if (exec.name === 'str_replace_editor') {
    // `view` is read-only: snapshotting it as an edit would misattribute nothing.
    if (raw.command === 'view') return []
    return typeof raw.path === 'string' && raw.path.length > 0 ? [resolvePath(raw.path, cwd)] : []
  }
  /* v8 ignore next -- FILE_EDIT_TOOLS contains no other names, so this return is unreachable */
  return []
}

function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name)
}

function isBashTool(name: string): boolean {
  return BASH_TOOLS.has(name)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  /* v8 ignore else -- tool arguments are validated as JSON objects before policy, so non-objects never reach here */
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  /* v8 ignore next -- see the ignore else note above */
  return undefined
}

/** Resolve a tool-reported path against the session cwd into an absolute path. */
function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}

/** POSIX-style single-quote a shell word (git-ai paths may contain spaces). */
function shellQuote(value: string): string {
  const quote = String.fromCharCode(39)
  const escaped = value.replace(/'/g, () => `${quote}\\${quote}${quote}`)
  return `${quote}${escaped}${quote}`
}

// --- git-ai invocation ---

/**
 * Run one `git-ai checkpoint <preset> --hook-input stdin` with the payload on
 * stdin, in the agent's working directory. Failures (missing binary, nonzero
 * exit, executor rejection) are logged as warnings and never propagated.
 * @param ctx - Cordis context carrying the shell executor.
 * @param config - resolved plugin config.
 * @param payload - the agent-v1 checkpoint object.
 * @param signal - the owning tool call's cancellation signal.
 */
async function runCheckpoint(ctx: Context, config: Config, payload: AgentV1Checkpoint, signal: AbortSignal): Promise<void> {
  try {
    // The explicit ShellExecutor typing also loads dsh-shell's Context
    // declaration merge, giving `ctx.shell` its typed surface below.
    const shell: ShellExecutor = ctx.shell
    const result = await shell.run(shell.resolve({
      command: `${shellQuote(config.gitAiPath)} checkpoint ${config.checkpointPreset} --hook-input stdin`,
      stdin: `${JSON.stringify(payload)}\n`,
      timeoutMs: config.timeoutMs,
      signal,
      workdir: payload.repo_working_dir,
    }))
    if (result.exitCode !== 0) {
      ctx.logger.warn(`hooks-git-ai: git-ai checkpoint exited with code ${String(result.exitCode)}: ${result.stderr.text}`)
    }
  } catch (error: unknown) {
    // The shell executor resolves infrastructure failures (missing binary,
    // unusable workdir) instead of rejecting; this arm is defensive.
    /* v8 ignore start -- a rejection cannot occur in practice, see the shell executor contract */
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`hooks-git-ai: git-ai checkpoint failed: ${message}`)
    /* v8 ignore stop */
  }
}
