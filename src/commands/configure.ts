import * as p from '@clack/prompts'
import { Cli, z } from 'incur'
import { Chains } from 'porto'
import { parseEther, type Chain } from 'viem'
import { varsSchema } from '../lib/vars.js'
import { saveConfig, type AgentWalletConfig } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { Address } from '../lib/zod.js'
import { promptPermissionPolicy } from '../lib/permission-prompts.js'
import { getChainByIdOrName } from '../porto/service.js'
import type { PermissionPolicy, PortoService, SpendPeriod } from '../porto/service.js'
import type { SignerService } from '../signer/service.js'

type ConfigureCheckpointName = 'account' | 'agent_key'

type ConfigureCheckpointStatus = 'already_ok' | 'created' | 'updated' | 'skipped' | 'failed'

type ConfigureCheckpoint = {
  checkpoint: ConfigureCheckpointName
  status: ConfigureCheckpointStatus
  details?: Record<string, unknown>
}

// ── Chain selection ───────────────────────────────────────────────────────────

async function resolveConfigureChain(options: { chain?: string }, isAgent: boolean): Promise<Chain> {
  if (options.chain) {
    const chain = getChainByIdOrName(options.chain)
    if (!chain) {
      throw new AppError(
        'INVALID_CHAIN',
        `Unknown chain: "${options.chain}". Use a chain name (e.g. base-sepolia) or numeric chain ID.`,
      )
    }
    return chain
  }

  if (isAgent) {
    throw new AppError(
      'NON_INTERACTIVE_REQUIRES_FLAGS',
      'Non-interactive configure requires --chain <name|id> (e.g. --chain base-sepolia).',
    )
  }

  // Interactive: show chain picker
  const mainnets = Chains.all.filter((c) => !c.testnet)
  const testnets = Chains.all.filter((c) => Boolean(c.testnet))

  const chainOptions = [
    ...mainnets.map((c) => ({ value: c.id, label: c.name, hint: `chain ID ${c.id}` })),
    ...testnets.map((c) => ({ value: c.id, label: c.name, hint: `chain ID ${c.id} (testnet)` })),
  ]

  const selected = await p.select({
    message: 'Select chain:',
    initialValue: Chains.baseSepolia.id,
    options: chainOptions,
  })

  if (p.isCancel(selected)) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  const chain = Chains.all.find((c) => c.id === selected)
  if (!chain) {
    throw new AppError('INVALID_CHAIN', `Selected chain ID ${String(selected)} not found.`)
  }
  return chain
}

// ── Permission policy resolution ─────────────────────────────────────────────

function parseCallArg(value: string): { to: `0x${string}`; signature?: `0x${string}` } {
  const colonIdx = value.indexOf(':', 2)
  if (colonIdx === -1) return { to: value as `0x${string}` }
  return {
    to: value.slice(0, colonIdx) as `0x${string}`,
    signature: value.slice(colonIdx + 1) as `0x${string}`,
  }
}

type ConfigureOptions = {
  call?: string[]
  chain?: string
  createAccount?: boolean
  dialog: string
  expiry?: number
  feeLimit?: number
  spendLimit?: number
  spendPeriod: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
  spendToken?: string
}

async function resolvePermissionPolicy(options: ConfigureOptions, chain: Chain, isAgent: boolean): Promise<PermissionPolicy> {
  const prefillCalls = options.call?.length ? options.call.map(parseCallArg) : undefined

  if (!isAgent) {
    return promptPermissionPolicy({
      chain,
      prefill: {
        calls: prefillCalls ?? null,
        spendLimit: options.spendLimit?.toString(),
        spendPeriod: options.spendPeriod as SpendPeriod | undefined,
        spendToken: options.spendToken,
        feeLimit: options.feeLimit?.toString(),
        expiryDays: options.expiry,
      },
    })
  }

  // Non-interactive: require explicit flags
  if (options.spendLimit === undefined) {
    throw new AppError(
      'NON_INTERACTIVE_REQUIRES_FLAGS',
      'Non-interactive configure requires --spend-limit <amount> (e.g. --spend-limit 0.01).',
    )
  }
  if (options.expiry === undefined) {
    throw new AppError(
      'NON_INTERACTIVE_REQUIRES_FLAGS',
      'Non-interactive configure requires --expiry <days> (e.g. --expiry 7).',
    )
  }

  return {
    calls: prefillCalls ?? null,
    spendLimitWei: parseEther(options.spendLimit.toString() as `${number}`),
    spendPeriod: options.spendPeriod as SpendPeriod,
    ...(options.spendToken ? { spendToken: options.spendToken as `0x${string}` } : {}),
    feeLimit: options.feeLimit?.toString() as `${number}` | undefined,
    expiryDays: options.expiry,
  }
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function runAgentKeyStep(signer: SignerService, config: AgentWalletConfig): Promise<ConfigureCheckpoint> {
  const initialized = await signer.init()
  const { publicKey } = await signer.getPortoKey()
  saveConfig(config)
  const status = initialized.created ? 'created' : 'already_ok'
  return { checkpoint: 'agent_key', status, details: { backend: initialized.backend, keyId: initialized.keyId, publicKey } }
}

type AccountStepResult = {
  checkpoint: ConfigureCheckpoint
  address: `0x${string}`
  chainId: number | undefined
  permissionId: `0x${string}` | undefined
}

async function runAccountStep(
  porto: PortoService,
  config: AgentWalletConfig,
  options: ConfigureOptions,
  chain: Chain,
  policy: PermissionPolicy,
): Promise<AccountStepResult> {
  const hadAddress = Boolean(config.porto?.address)
  const shouldOnboard = Boolean(options.createAccount) || !config.porto?.address

  let address: `0x${string}`
  let chainId: number | undefined
  let permissionId: `0x${string}` | undefined
  let status: ConfigureCheckpointStatus

  if (shouldOnboard) {
    const onboardResult = await porto.onboard({
      policy,
      chain,
      createAccount: options.createAccount,
      dialogHost: options.dialog,
    })
    address = onboardResult.address
    chainId = onboardResult.chainId
    permissionId = onboardResult.grantedPermission?.id
    status = hadAddress ? 'updated' : 'created'
    saveConfig(config)
  } else {
    address = config.porto!.address!
    chainId = chain.id

    const existing = await porto.findMatchingPermission({
      address,
      policy,
      chainId,
      precallPermissions: config.porto?.precallPermissions,
    })

    if (existing) {
      permissionId = existing.id
      if (existing.chainId !== undefined) chainId = existing.chainId
      status = 'already_ok'
      saveConfig(config)
    } else {
      const grantResult = await porto.grant({ address, chain, policy })
      permissionId = grantResult.permissionId
      status = 'updated'
      saveConfig(config)
    }
  }

  return { checkpoint: { checkpoint: 'account', status, details: { address, chainId, permissionId } }, address, chainId, permissionId }
}

async function runFundingStep(
  porto: PortoService,
  address: `0x${string}`,
  chainId: number | undefined,
  dialogWasOpen: boolean,
  isAgent: boolean,
): Promise<boolean> {
  const balanceInfo = await porto.balance({ address, chainId })
  if (BigInt(balanceInfo.wei) > 0n) return true
  if (isAgent) return false

  if (dialogWasOpen) {
    // Dialog session is still open — go straight to funding in the same tab.
    try {
      await porto.fund({ address, chainId, skipConnect: true })
      return true
    } catch {
      p.log.warn('No funds yet — send funds to your address to get started.')
      return false
    }
  }

  // No dialog was open — ask first, then open a fresh one.
  const answer = await p.confirm({ message: 'No funds detected. Fund your account now?' })
  if (!p.isCancel(answer) && answer) {
    try {
      await porto.fund({ address, chainId })
      return true
    } catch {
      p.log.warn('Funding skipped — send funds to your address to get started.')
    }
  }
  return false
}

// ── Command ───────────────────────────────────────────────────────────────────

export const configureCommand = Cli.create('configure', {
  description: 'One-shot account setup: signer key, account, and default permissions',
  vars: varsSchema,
  options: z.object({
    chain: z.string().optional().describe('Chain name or ID (interactive picker if omitted)'),
    dialog: z.string().default('id.porto.sh').describe('Dialog host for Porto grant UI'),
    createAccount: z.boolean().optional().describe('Force creation of a new account'),
    call: z.array(z.string()).optional().describe('Allowed call: address[:signature] (repeatable)'),
    spendLimit: z.number().optional().describe('Spend limit as a decimal (ETH or --spend-token units)'),
    spendPeriod: z.enum(['minute', 'hour', 'day', 'week', 'month', 'year']).default('day').describe('Spend period'),
    expiry: z.number().int().optional().describe('Permission validity in days'),
    spendToken: Address.optional().describe('ERC-20 token address (default: native ETH)'),
    feeLimit: z.number().optional().describe('Fee cap per period'),
  }),
  alias: { chain: 'c' } as const,
  output: z.object({
    account: z.object({ address: z.string(), chainId: z.number().optional() }),
    checkpoints: z.array(z.object({
      checkpoint: z.enum(['account', 'agent_key']),
      status: z.enum(['already_ok', 'created', 'updated', 'skipped', 'failed']),
      details: z.record(z.string(), z.unknown()).optional(),
    })),
    command: z.literal('configure'),
    poweredBy: z.string(),
    setupMode: z.literal('local-admin'),
  }),
  examples: [
    { description: 'Interactive setup' },
    { options: { chain: 'base-sepolia', spendLimit: 0.01, expiry: 7 }, description: 'Non-interactive' },
    { options: { chain: 'base', call: ['0xA0b8…eB48', '0xdead…beef'], spendLimit: 0.01, expiry: 7 }, description: 'Multiple allowed contracts' },
    { options: { chain: 'base', call: ['0xA0b8…eB48:transfer(address,uint256)'], spendLimit: 0.01, expiry: 7 }, description: 'Allowlist with function selector' },
    { options: { chain: 'base', spendToken: '0xA0b8…eB48', spendLimit: 100, expiry: 30 }, description: 'ERC-20 spend limit' },
  ],
  async run(c) {
    const { config, porto, signer } = c.var

    p.intro('Configure wallet  ·  local-admin')

    const agentKeyCheckpoint = await runAgentKeyStep(signer, config)
    const { keyId, publicKey } = agentKeyCheckpoint.details as { keyId: string; backend: string; publicKey: string }
    p.note(
      [`ID:         ${keyId}`, `Public key: ${publicKey}`].join('\n'),
      agentKeyCheckpoint.status === 'created' ? 'Agent key created' : 'Agent key ready',
    )

    const chain = await resolveConfigureChain(c.options, c.agent)
    const policy = await resolvePermissionPolicy(c.options, chain, c.agent)

    // Note: porto/cli/Dialog prints the browser URL via raw console.log — known cosmetic limitation.
    const accountResult = await runAccountStep(porto, config, c.options, chain, policy)
    p.log.step(`Account ready  (${accountResult.address})`)

    // ── Funding ───────────────────────────────────────────────────────────────
    const { address, chainId } = accountResult
    const dialogWasOpen = porto.hasActiveSession()
    const funded = await runFundingStep(porto, address, chainId, dialogWasOpen, c.agent)

    // Finalize the dialog (send success, lets the user close the tab).
    await porto.finalizeDialog({ title: 'Setup complete', content: 'You can close this window.' })

    p.outro(
      funded
        ? 'Setup complete!  Run `openawa sign` to submit your first transaction.'
        : 'Setup complete!  Send funds to your account, then run `openawa sign`.',
    )

    const result = {
      account: { address: accountResult.address, chainId: accountResult.chainId ?? config.porto?.chainIds?.[0] },
      checkpoints: [agentKeyCheckpoint, accountResult.checkpoint],
      command: 'configure' as const,
      poweredBy: 'Porto',
      setupMode: 'local-admin' as const,
    }

    return c.ok(result, {
      cta: {
        commands: [
          { command: 'status', description: 'Inspect the new account' },
          { command: 'sign', description: 'Submit your first transaction' },
        ],
      },
    })
  },
})
