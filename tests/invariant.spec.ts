import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as Invariant from '../src/invariant.ts'

describe('hooks-git-ai invariant companion', () => {
  it('registers the package name with the invariants service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await Invariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('rejects a duplicate registration of the same package', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await Invariant.apply(ctx)
    expect(() => Invariant.apply(ctx)).toThrow(/already registered/)
    dispose()
  })
})
