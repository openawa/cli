import { describe, expect, it } from 'vitest'

import type { AgentWalletConfig } from '../lib/config.js'
import { getChainByIdOrName, resolveCommandChain } from './service.js'

const BASE_ID = 8453
const BASE_SEPOLIA_ID = 84532
const OP_MAINNET_ID = 10
const OP_SEPOLIA_ID = 11155420

function makeConfig(chainIds: number[]): AgentWalletConfig {
  return {
    version: 1,
    signer: { backend: 'chipkey' },
    porto: { chainIds, precallPermissions: [] },
  }
}

describe('getChainByIdOrName', () => {
  it.each([
    [8453, BASE_ID],
    ['8453', BASE_ID],
    ['base', BASE_ID],
    ['base-sepolia', BASE_SEPOLIA_ID],
    ['Base Sepolia', BASE_SEPOLIA_ID],
    ['BASESEPOLIA', BASE_SEPOLIA_ID],
    ['op-mainnet', OP_MAINNET_ID],
    ['op-sepolia', OP_SEPOLIA_ID],
    [99999, undefined],
    ['not-a-chain', undefined],
  ] as const)('resolves %s → %s', (input, expectedId) => {
    expect(getChainByIdOrName(input)?.id).toBe(expectedId)
  })
})

describe('resolveCommandChain', () => {
  describe('no flag', () => {
    it('throws MISSING_CHAIN_ID when no chains configured', () => {
      expect(() => resolveCommandChain(makeConfig([]))).toThrowError(
        expect.objectContaining({ code: 'MISSING_CHAIN_ID' }),
      )
    })

    it('throws MISSING_CHAIN_ID when porto config is absent', () => {
      const config: AgentWalletConfig = { version: 1, signer: { backend: 'chipkey' } }
      expect(() => resolveCommandChain(config)).toThrowError(
        expect.objectContaining({ code: 'MISSING_CHAIN_ID' }),
      )
    })

    it('returns the single configured chain', () => {
      expect(resolveCommandChain(makeConfig([BASE_ID])).id).toBe(BASE_ID)
    })

    it('throws AMBIGUOUS_CHAIN with --chain suggestions', () => {
      expect(() => resolveCommandChain(makeConfig([BASE_ID, BASE_SEPOLIA_ID]))).toThrowError(
        expect.objectContaining({
          code: 'AMBIGUOUS_CHAIN',
          message: expect.stringContaining('--chain base'),
        }),
      )
    })
  })

  describe('with --chain flag', () => {
    it('resolves by chain name', () => {
      expect(resolveCommandChain(makeConfig([BASE_SEPOLIA_ID]), 'base-sepolia').id).toBe(
        BASE_SEPOLIA_ID,
      )
    })

    it('resolves by chain ID string', () => {
      expect(resolveCommandChain(makeConfig([BASE_ID]), String(BASE_ID)).id).toBe(BASE_ID)
    })

    it('resolves when multiple chains configured and flag selects one', () => {
      expect(resolveCommandChain(makeConfig([BASE_ID, OP_SEPOLIA_ID]), 'op-sepolia').id).toBe(
        OP_SEPOLIA_ID,
      )
    })

    it('throws INVALID_CHAIN for an unknown chain name', () => {
      expect(() => resolveCommandChain(makeConfig([BASE_ID]), 'not-a-chain')).toThrowError(
        expect.objectContaining({ code: 'INVALID_CHAIN' }),
      )
    })

    it('throws CHAIN_NOT_CONFIGURED when chain is valid but not in config', () => {
      expect(() => resolveCommandChain(makeConfig([BASE_ID]), 'base-sepolia')).toThrowError(
        expect.objectContaining({ code: 'CHAIN_NOT_CONFIGURED' }),
      )
    })

    it('allows any valid chain when config has no chainIds', () => {
      // chainIds.length === 0 skips the "is it configured?" guard
      expect(resolveCommandChain(makeConfig([]), 'base-sepolia').id).toBe(BASE_SEPOLIA_ID)
    })
  })
})
