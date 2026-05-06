import { describe, expect, it } from 'vitest'
import { buildLaneThreadName, resolveLaneRoute } from '../lane-routes.js'

describe('resolveLaneRoute', () => {
  it('matches a route by channel id first', () => {
    const route = resolveLaneRoute(
      {
        '123': { agentName: 'openacp', lockAgent: true },
      },
      { id: '123', name: 'general' },
    )

    expect(route).toEqual({ laneKey: '123', agentName: 'openacp', lockAgent: true })
  })

  it('falls back to channel name match', () => {
    const route = resolveLaneRoute(
      {
        support: { agentName: 'support-bot' },
      },
      { id: '999', name: 'support' },
    )

    expect(route).toEqual({ laneKey: 'support', agentName: 'support-bot' })
  })
})

describe('buildLaneThreadName', () => {
  it('uses a trimmed snippet from the opening message', () => {
    const name = buildLaneThreadName(
      { agentName: 'openacp' },
      { content: '   Please help debug the Discord lane routing issue right now   ' } as any,
    )

    expect(name).toBe('🔄 openacp — Please help debug the Discord lane routing issue right now')
  })

  it('uses fallback text when the message is empty', () => {
    const name = buildLaneThreadName(
      { agentName: 'openacp' },
      { content: '   ' } as any,
    )

    expect(name).toBe('🔄 openacp — new session')
  })
})
