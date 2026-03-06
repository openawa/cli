import { Cli, Errors, z } from 'incur'
import { saveConfig } from '../lib/config.js'
import { toAppError } from '../lib/errors.js'
import { varsSchema } from '../lib/vars.js'
import { Address, Hex } from '../lib/zod.js'
import { resolveCommandChain } from '../porto/service.js'

export const signCommand = Cli.create('sign', {
  description: 'Sign and submit prepared calls using the local hardware-backed agent key',
  vars: varsSchema,
  options: z.object({
    calls: z.string().describe('Calls JSON payload'),
    chain: z
      .string()
      .optional()
      .describe('Chain name or ID (required when multiple chains configured)'),
    address: Address.optional().describe('Account address override'),
  }),
  alias: { chain: 'c' } as const,
  output: z.object({
    command: z.literal('sign'),
    poweredBy: z.string(),
    status: z.string(),
    txHash: Hex.optional(),
    bundleId: z.string().optional(),
  }),
  examples: [
    {
      options: { calls: '[{"to":"0x...","value":"0x0","data":"0x"}]', chain: 'base-sepolia' },
      description: 'Sign a call on Base Sepolia',
    },
    {
      options: { calls: '[{"to":"0x...","value":"0x0"}]' },
      description: 'Sign when only one chain is configured',
    },
  ],
  async *run(c) {
    const { config, porto } = c.var
    try {
      const chain = resolveCommandChain(config, c.options.chain)
      const gen = porto.send({
        address: c.options.address as `0x${string}` | undefined,
        calls: c.options.calls,
        chain,
      })
      let next = await gen.next()
      while (!next.done) {
        // Stage progress chunks don't match the output schema (which describes the final result).
        // Cast is intentional — incur doesn't validate intermediate yields at runtime.
        yield next.value as never
        next = await gen.next()
      }
      const sendResult = next.value
      saveConfig(config)
      yield {
        command: 'sign' as const,
        poweredBy: 'Porto',
        status: sendResult.status,
        txHash: (sendResult.txHash ?? undefined) as `0x${string}` | undefined,
        bundleId: sendResult.bundleId,
      }
    } catch (error) {
      const appError = toAppError(error)
      const message = appError.details
        ? `${appError.message}\n\nDetails: ${JSON.stringify(appError.details, null, 2)}`
        : appError.message
      throw new Errors.IncurError({ code: appError.code, message })
    }
  },
})
