import { describe, expect, it } from 'vitest'
import { buildLaneThreadName, resolveLaneRoute } from '../lane-routes.js'

describe('resolveLaneRoute', () => {
  it('matches lane by channel id first', () => {
    const route = resolveLaneRoute(
      {
        '123': { agentName: 'gemini', workingDirectory: '~/gemini' },
        gemini: { agentName: 'claude', workingDirectory: '~/claude' },
      },
      { id: '123', name: 'gemini' },
    )

    expect(route).toEqual({
      laneKey: '123',
      agentName: 'gemini',
      workingDirectory: '~/gemini',
    })
  })

  it('matches lane by channel name when id is not configured', () => {
    const route = resolveLaneRoute(
      {
        gemini: { agentName: 'gemini', workingDirectory: '~/gemini', lockAgent: true },
      },
      { id: '999', name: 'gemini' },
    )

    expect(route).toEqual({
      laneKey: 'gemini',
      agentName: 'gemini',
      workingDirectory: '~/gemini',
      lockAgent: true,
    })
  })

  it('returns null when no route matches', () => {
    expect(resolveLaneRoute({ claude: { agentName: 'claude' } }, { id: '1', name: 'gemini' })).toBeNull()
  })
})

describe('buildLaneThreadName', () => {
  it('uses a trimmed snippet from the first message', () => {
    const name = buildLaneThreadName(
      { agentName: 'gemini' },
      { content: '  Build   me   a dashboard for GPU jobs please  ' } as any,
    )

    expect(name).toBe('🔄 gemini — Build me a dashboard for GPU jobs please')
  })

  it('falls back when the first message is empty', () => {
    const name = buildLaneThreadName(
      { agentName: 'claude' },
      { content: '   ' } as any,
    )

    expect(name).toBe('🔄 claude — new session')
  })

  it('caps long snippets so thread names stay manageable', () => {
    const name = buildLaneThreadName(
      { agentName: 'gemini' },
      { content: 'a'.repeat(100) } as any,
    )

    expect(name).toBe(`🔄 gemini — ${'a'.repeat(60)}`)
  })
})
