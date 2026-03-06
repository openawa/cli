import { Cli, z } from 'incur'
import { Chains } from 'porto'
import { AppError, toAppError } from '../lib/errors.js'
import { varsSchema } from '../lib/vars.js'
import { Address } from '../lib/zod.js'
import { getChainByIdOrName } from '../porto/service.js'

export const statusCommand = Cli.create('status', {
  description: 'Inspect account, signer health, permissions, and balances',
  vars: varsSchema,
  options: z.object({
    address: Address.optional().describe('Account address override'),
    chain: z.string().optional().describe('Filter to a specific chain'),
  }),
  alias: { chain: 'c' } as const,
  output: z.object({
    command: z.literal('status'),
    poweredBy: z.string(),
    account: z.object({ address: z.string().nullable() }),
    signer: z.object({
      keyId: z.string().optional(),
      backend: z.string(),
      curve: z.literal('p256'),
      exists: z.boolean(),
    }),
    activation: z.object({ state: z.enum(['active_onchain', 'precall_pending', 'unconfigured']) }),
    chains: z.record(
      z.string(),
      z.object({
        chainName: z.string(),
        permissions: z.object({
          active: z.number(),
          total: z.number(),
          latestExpiry: z.string().nullable(),
        }),
        balance: z.object({ formatted: z.string(), symbol: z.string() }).nullable(),
        warnings: z.array(z.object({ code: z.string(), message: z.string() })),
      }),
    ),
    precallPermissions: z.array(
      z.object({
        id: z.string(),
        chainId: z.number(),
        expiry: z.string(),
      }),
    ),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  }),
  async run(context) {
    const { config, porto, signer } = context.var
    const address = (context.options.address ?? config.porto?.address) as `0x${string}` | undefined
    const warnings: Array<{ code: string; message: string }> = []

    const signerInfo = await signer.info()

    let chainIdsToShow: number[] = config.porto?.chainIds ?? []
    if (context.options.chain) {
      const filtered = getChainByIdOrName(context.options.chain)
      if (!filtered) {
        throw new AppError(
          'INVALID_CHAIN',
          `Unknown chain: "${context.options.chain}". Use a chain name (e.g. base-sepolia) or numeric chain ID.`,
        )
      }
      chainIdsToShow = [filtered.id]
    }

    const chainsData: Record<
      string,
      {
        chainName: string
        permissions: { active: number; total: number; latestExpiry: string | null }
        balance: { formatted: string; symbol: string } | null
        warnings: Array<{ code: string; message: string }>
      }
    > = {}

    for (const chainId of chainIdsToShow) {
      const chain = Chains.all.find((candidate) => candidate.id === chainId)
      const chainName = chain?.name ?? `Chain ${String(chainId)}`
      const chainWarnings: Array<{ code: string; message: string }> = []

      let permSummary = { active: 0, total: 0, latestExpiry: null as string | null }
      if (address) {
        try {
          permSummary = await porto.permissionSummary({ address, chainId })
        } catch (error) {
          const appError = toAppError(error)
          chainWarnings.push({ code: appError.code, message: appError.message })
        }
      }

      let balanceData: { formatted: string; symbol: string } | null = null
      if (address) {
        try {
          const b = await porto.balance({ address, chainId })
          balanceData = { formatted: b.formatted, symbol: b.symbol }
        } catch (error) {
          const appError = toAppError(error)
          chainWarnings.push({ code: appError.code, message: appError.message })
        }
      }

      chainsData[String(chainId)] = {
        chainName,
        permissions: permSummary,
        balance: balanceData,
        warnings: chainWarnings,
      }
    }

    const nowSeconds = Math.floor(Date.now() / 1000)
    const precallPermissions = (config.porto?.precallPermissions ?? [])
      .filter((pp) => pp.expiry > nowSeconds)
      .map((pp) => ({
        id: pp.id,
        chainId: pp.chainId,
        expiry: new Date(pp.expiry * 1000).toISOString(),
      }))

    const totalActive = Object.values(chainsData).reduce(
      (sum, chainData) => sum + chainData.permissions.active,
      0,
    )
    const activationState: 'active_onchain' | 'precall_pending' | 'unconfigured' =
      totalActive > 0
        ? 'active_onchain'
        : precallPermissions.length > 0
          ? 'precall_pending'
          : 'unconfigured'

    return {
      command: 'status' as const,
      poweredBy: 'Porto',
      account: { address: address ?? null },
      signer: signerInfo as { keyId?: string; backend: string; curve: 'p256'; exists: boolean },
      activation: { state: activationState },
      chains: chainsData,
      precallPermissions,
      warnings,
    }
  },
})
