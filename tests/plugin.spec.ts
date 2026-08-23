import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksGitAi from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * Full-loop git-ai bridge tests with a mock model, the real loop and bash
 * executor, and a fake git-ai executable that appends every checkpoint stdin
 * payload to a capture file. Covers file-edit attribution, shell bracketing,
 * failure containment, and identity passthrough.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-ai-'))
  dirs.push(dir)
  return dir
}

/** A fake git-ai: appends each checkpoint's stdin payload as one JSON line. */
function fakeGitAi(dir: string, exitCode = 0): { path: string; capture: string } {
  const capture = join(dir, 'checkpoints.jsonl')
  const path = join(dir, 'fake-git-ai')
  writeFileSync(path, `#!/usr/bin/env bash\nif [ "${exitCode}" -ne 0 ]; then exit ${exitCode}; fi\ncat >> "${capture}"\n`)
  chmodSync(path, 0o755)
  return { path, capture }
}

function readCheckpoints(capture: string): Array<Record<string, unknown>> {
  if (!existsSync(capture)) return []
  return readFileSync(capture, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

interface Harness {
  ctx: Context
  agent: Agent
  capture: string
}

async function harness(
  dir: string,
  adapter: MockAdapter,
  gitAiPath: string,
  config: Partial<HooksGitAi.Config> = {},
  agentOptions: AgentOptions = { provider: 'mock', model: 'mock-model' },
  meta: { cwd?: string } = { cwd: dir },
): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksGitAi, {
    gitAiPath,
    agentName: config.agentName ?? 'deepseek-harness',
    model: config.model ?? '',
    checkpointPreset: config.checkpointPreset ?? 'agent-v1',
    timeoutMs: config.timeoutMs ?? 10_000,
    trackBash: config.trackBash ?? true,
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('a1'), agentOptions, meta)
  return { ctx, agent, capture: join(dir, 'checkpoints.jsonl') }
}

function registerTool(ctx: Context, name: string, parameters: ParameterSchemaSpec): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: `${name} fixture`,
    parameters,
    async execute() {
      return [{ type: 'text', text: 'ok' }]
    },
  }))
}

async function runTurn(harness: Harness, adapter: MockAdapter): Promise<void> {
  const { ctx, agent } = harness
  registerTool(ctx, 'write', { file_path: { type: 'string' }, content: { type: 'string' } })
  registerTool(ctx, 'edit', { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } })
  registerTool(ctx, 'str_replace_editor', { command: { type: 'string' }, path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } })
  registerTool(ctx, 'bash', { command: { type: 'string' } })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests.length).toBeGreaterThan(0)
}

describe('dsh-git-ai bridge', () => {
  it('sends an ai_agent checkpoint after a successful write with identity passthrough', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: 'src/a.ts', content: 'x' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    const points = readCheckpoints(fake.capture)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      type: 'ai_agent',
      repo_working_dir: dir,
      edited_filepaths: [join(dir, 'src/a.ts')],
      agent_name: 'deepseek-harness',
      model: 'mock-model', // falls back to agent.options.model
      conversation_id: 'a1',
    })
  })

  it('records an edit and passes absolute paths through unchanged', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const absolute = join(dir, 'lib/b.ts')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: absolute, old_string: 'a', new_string: 'b' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    const points = readCheckpoints(fake.capture)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ type: 'ai_agent', edited_filepaths: [absolute] })
  })

  it('tracks str_replace but skips view on str_replace_editor', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'str_replace_editor', { command: 'str_replace', path: 'src/c.ts', old_string: 'a', new_string: 'b' }),
      toolCallResponse('c2', 'str_replace_editor', { command: 'view', path: 'src/c.ts' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    const points = readCheckpoints(fake.capture)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ type: 'ai_agent', edited_filepaths: [join(dir, 'src/c.ts')] })
  })

  it('brackets a bash tool with pre and post shell checkpoints sharing tool_use_id', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'cat > output.txt <<EOF\nhi\nEOF' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    const points = readCheckpoints(fake.capture)
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({
      type: 'pre_shell_command',
      tool_use_id: 'c1',
      command: 'cat > output.txt <<EOF\nhi\nEOF',
      repo_working_dir: dir,
    })
    expect(points[1]).toMatchObject({
      type: 'post_shell_command',
      tool_use_id: 'c1',
      command: 'cat > output.txt <<EOF\nhi\nEOF',
      repo_working_dir: dir,
    })
  })

  it('does not emit bash checkpoints when trackBash is false', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'ls' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path, { trackBash: false })
    await runTurn(h, adapter)

    expect(readCheckpoints(fake.capture)).toHaveLength(0)
  })

  it('uses an explicit model and agentName when configured', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: 'src/d.ts', content: 'x' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path, { model: 'explicit-model', agentName: 'my-agent' })
    await runTurn(h, adapter)

    const points = readCheckpoints(fake.capture)
    expect(points[0]).toMatchObject({ agent_name: 'my-agent', model: 'explicit-model' })
  })

  it('does not attribute a failed file edit', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: 'src/e.ts', content: 'x' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    h.ctx.tools.register(defineContentToolFixture({
      name: 'write',
      description: 'failing write fixture',
      parameters: { file_path: { type: 'string' }, content: { type: 'string' } },
      async execute() {
        throw new Error('boom')
      },
    }))
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await h.agent.whenIdle()

    const result = [...h.agent.session.events].find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(readCheckpoints(fake.capture)).toHaveLength(0)
  })

  it('a failing git-ai binary never fails the tool or the turn', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir, 1)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: 'src/f.ts', content: 'x' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    const result = [...h.agent.session.events].find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(false)
    expect(existsSync(fake.capture)).toBe(false)
  })

  it('a missing git-ai binary degrades to warnings and the turn completes', async () => {
    const dir = configDir()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: 'src/g.ts', content: 'x' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, join(dir, 'no-such-git-ai'))
    await runTurn(h, adapter)

    const result = [...h.agent.session.events].find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(false)
    expect(adapter.requests.length).toBeGreaterThan(0)
  })

  it('sends both shell and file-edit checkpoints for the same turn', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'mkdir -p src' }),
      toolCallResponse('c2', 'write', { file_path: 'src/h.ts', content: 'x' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    const points = readCheckpoints(fake.capture)
    expect(points.map(p => p.type)).toEqual(['pre_shell_command', 'post_shell_command', 'ai_agent'])
  })

  it('falls back to the process cwd and an empty model when the session omits them', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([textResponse('done')])
    const h = await harness(dir, adapter, fake.path)
    registerTool(h.ctx, 'write', { file_path: { type: 'string' } })
    const agent = h.ctx.agentLoop.create(SessionId('a2'), { provider: 'mock' })
    await h.ctx.tools.execute({
      callId: CallId('d1'),
      name: 'write',
      arguments: { file_path: 'src/y.ts' },
      agent,
      signal: new AbortController().signal,
    })

    const points = readCheckpoints(fake.capture)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      repo_working_dir: process.cwd(),
      model: '',
    })
  })

  it('a bash call without a command argument still brackets with the command omitted', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', {}),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    const points = readCheckpoints(fake.capture)
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({ type: 'pre_shell_command', tool_use_id: 'c1' })
    expect('command' in points[0]!).toBe(false)
  })

  it('file edits without a path emit no checkpoint', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { content: 'x' }),
      toolCallResponse('c2', 'str_replace_editor', { command: 'str_replace', old_string: 'a', new_string: 'b' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, fake.path)
    await runTurn(h, adapter)

    expect(readCheckpoints(fake.capture)).toHaveLength(0)
  })

  it('tool executions without an agent emit nothing', async () => {
    const dir = configDir()
    const fake = fakeGitAi(dir)
    const adapter = new MockAdapter([textResponse('done')])
    const h = await harness(dir, adapter, fake.path)
    registerTool(h.ctx, 'write', { file_path: { type: 'string' } })
    registerTool(h.ctx, 'bash', { command: { type: 'string' } })
    const signal = new AbortController().signal
    await h.ctx.tools.execute({ callId: CallId('d1'), name: 'bash', arguments: { command: 'ls' }, signal })
    await h.ctx.tools.execute({ callId: CallId('d2'), name: 'write', arguments: { file_path: 'src/x.ts' }, signal })

    expect(readCheckpoints(fake.capture)).toHaveLength(0)
  })

  it('a gitAiPath containing a single quote is shell-quoted safely', async () => {
    const dir = configDir()
    const capture = join(dir, 'quoted-checkpoints.jsonl')
    const path = join(dir, "fake'git-ai")
    writeFileSync(path, `#!/usr/bin/env bash\ncat >> "${capture}"\n`)
    chmodSync(path, 0o755)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { file_path: 'src/j.ts', content: 'x' }),
      textResponse('done'),
    ])
    const h = await harness(dir, adapter, path)
    await runTurn(h, adapter)

    const points = readCheckpoints(capture)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ type: 'ai_agent' })
  })
})
