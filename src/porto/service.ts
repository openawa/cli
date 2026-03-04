import { Chains, Mode, Porto } from 'porto'
import * as WalletActions from 'porto/viem/WalletActions'
import { createPublicClient, formatEther, http, parseEther, type Chain } from 'viem'
import { getCallsStatus } from 'viem/actions'
import * as WalletClient from 'porto/viem/WalletClient'

import { AppError } from '../lib/errors.js'
import { parseJsonFlag } from '../lib/encoding.js'
import type { AgentWalletConfig, PrecallPermission } from '../lib/config.js'
import type { SignerService } from '../signer/service.js'

// These wildcard values grant the agent permission to call any contract with any
// function. Spend limits and expiry below provide the primary risk boundaries.
// spend.limit is a bigint in native token base units (wei for ETH).
// feeToken.limit is a human-readable decimal string; Porto maps it to the minimum spend period.
const DEFAULT_GRANT_ANY_TARGET = '0x3232323232323232323232323232323232323232' as `0x${string}`
const DEFAULT_GRANT_ANY_SELECTOR = '0x32323232' as `0x${string}`
// Per-period fee cap (human-readable decimal string; Porto maps this to the minimum spend period)
const DEFAULT_GRANT_FEE_LIMIT_EXP    = '25'   as `${number}`  // 25 EXP/period on Base Sepolia
const DEFAULT_GRANT_FEE_LIMIT_NATIVE = '0.01' as `${number}`  // 0.01 ETH/period on mainnet

export type SpendPeriod = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

export type PermissionPolicy = {
  /** null = wildcard (any target, any selector) */
  calls: { to: `0x${string}`; signature?: `0x${string}` }[] | null
  /** Spend cap in native token base units (wei) */
  spendLimitWei: bigint
  /** Period over which the spend limit applies */
  spendPeriod: SpendPeriod
  /** ERC-20 token address for the spend limit; undefined = native token */
  spendToken?: `0x${string}`
  /** Fee cap per period as human-readable decimal; undefined → chain-specific default */
  feeLimit?: `${number}`
  /** Permission lifetime in days from now */
  expiryDays: number
}

type SendCall = {
  data?: `0x${string}`
  to: `0x${string}`
  value?: bigint | `0x${string}` | number | string
}

type OnboardOptions = {
  policy: PermissionPolicy
  chain: Chain
  createAccount?: boolean
  dialogHost?: string
}

type GrantOptions = {
  address?: `0x${string}`
  chain: Chain
  policy: PermissionPolicy
}

type SendOptions = {
  address?: `0x${string}`
  chain: Chain
  calls: string
}

type FundOptions = {
  address?: `0x${string}`
  chainId?: number
}

type PermissionsOptions = {
  address?: `0x${string}`
  chainId?: number
}

const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_RELAY_RPC_URL = 'https://rpc.porto.sh'
const ZERO_TX_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'
const BASE_SEPOLIA_EXP_TOKEN = '0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e'
const BASE_SEPOLIA_FAUCET_VALUE = '0x340aad21b3b700000'
const RELAY_REQUEST_TIMEOUT_MS = 20_000
const SEND_STAGE_TIMEOUT_MS = 90_000
const SEND_STATUS_REQUEST_TIMEOUT_MS = 12_000
const SEND_STATUS_POLL_TIMEOUT_MS = 45_000
const SEND_STATUS_POLL_INTERVAL_MS = 1_500

type RelayPermissionCall = {
  selector: `0x${string}`
  to: `0x${string}`
  type: 'call'
}

type RelayPermissionSpend = {
  limit: bigint | string | number
  period: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
  token?: `0x${string}` | null
  type: 'spend'
}

type RelayKeyRecord = {
  expiry: number | string
  hash?: `0x${string}`
  permissions: readonly (RelayPermissionCall | RelayPermissionSpend)[]
  publicKey: `0x${string}`
  role: 'admin' | 'normal'
  type: 'p256' | 'secp256k1' | 'webauthnp256'
}

type AgentPermissionSnapshot = {
  expiry: number
  id: `0x${string}`
  key: {
    publicKey: `0x${string}`
    type: 'p256' | 'secp256k1' | 'webauthn-p256'
  }
  permissions: {
    calls: { signature?: string; to?: `0x${string}` }[]
    spend: {
      limit: bigint
      period: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
      token?: `0x${string}` | null
    }[]
  }
}

/**
 * Resolves a Porto chain by numeric ID or by name (case-insensitive, spaces/hyphens ignored).
 * Examples: 8453, "base-sepolia", "Base Sepolia", "basesepolia", "op-mainnet", "opmainnet"
 */
export function getChainByIdOrName(idOrName: string | number): Chain | undefined {
  const asId = typeof idOrName === 'number' ? idOrName : parseInt(idOrName, 10)
  if (!isNaN(asId)) return Chains.all.find((c) => c.id === asId)
  const key = String(idOrName).toLowerCase().replace(/[\s-]+/g, '')
  return Chains.all.find((c) => c.name.toLowerCase().replace(/[\s-]+/g, '') === key)
}

/**
 * Resolves the chain for a command given the config and an optional --chain flag.
 * - 0 chains configured → MISSING_CHAIN_ID error
 * - 1 chain, no flag → return that chain silently
 * - N chains, no flag → AMBIGUOUS_CHAIN error with list
 * - flag provided → resolve by name/id, validate it's in configured set
 */
export function resolveCommandChain(config: AgentWalletConfig, chainFlag?: string): Chain {
  const chainIds = config.porto?.chainIds ?? []

  if (chainFlag) {
    const chain = getChainByIdOrName(chainFlag)
    if (!chain) {
      throw new AppError('INVALID_CHAIN', `Unknown chain: "${chainFlag}". Use a chain name (e.g. base-sepolia) or numeric chain ID.`)
    }
    if (chainIds.length > 0 && !chainIds.includes(chain.id)) {
      const knownNames = chainIds
        .map((id) => Chains.all.find((c) => c.id === id)?.name.toLowerCase().replace(/[\s-]+/g, '-') ?? String(id))
      throw new AppError(
        'CHAIN_NOT_CONFIGURED',
        `Chain "${chainFlag}" is not configured. Run \`openawa configure --chain ${chainFlag}\` first.\nConfigured: ${knownNames.join(', ')}`,
      )
    }
    return chain
  }

  if (chainIds.length === 0) {
    throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Run `openawa configure --chain <name>` first.')
  }

  if (chainIds.length === 1) {
    const chain = Chains.all.find((c) => c.id === chainIds[0])
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', `Configured chain ID ${String(chainIds[0])} is not a supported Porto chain.`)
    }
    return chain
  }

  // Multiple chains configured, no flag
  const names = chainIds.map(
    (id) => Chains.all.find((c) => c.id === id)?.name.toLowerCase().replace(/\s+/g, '-') ?? String(id),
  )
  throw new AppError(
    'AMBIGUOUS_CHAIN',
    `Multiple chains configured. Use --chain to specify one:\n${names.map((n) => `  --chain ${n}`).join('\n')}`,
  )
}

function resolveConfiguredChain(config: AgentWalletConfig, overrideChainId?: number): Chain | undefined {
  const chainId = overrideChainId ?? config.porto?.chainIds?.[0]
  if (!chainId) return undefined
  return Chains.all.find((c) => c.id === chainId)
}

function normalizeDialogHost(host?: string) {
  return host ?? 'id.porto.sh'
}

function normalizeRelayRpcUrl() {
  return process.env.AGENT_WALLET_RELAY_URL ?? DEFAULT_RELAY_RPC_URL
}

function normalizeRelayKeyType(type: RelayKeyRecord['type']) {
  if (type === 'webauthnp256') return 'webauthn-p256' as const
  return type
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMetadata(error: unknown) {
  if (!isObject(error)) {
    return {
      message: String(error),
    }
  }

  const candidate = error as Record<string, unknown>
  const message =
    typeof candidate.message === 'string'
      ? candidate.message
      : String(error)

  return {
    code:
      typeof candidate.code === 'string' || typeof candidate.code === 'number'
        ? candidate.code
        : undefined,
    details: typeof candidate.details === 'string' ? candidate.details : undefined,
    message,
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    shortMessage: typeof candidate.shortMessage === 'string' ? candidate.shortMessage : undefined,
  }
}

function parseRelayExpiry(expiry: number | string): number {
  if (typeof expiry === 'number') return expiry
  if (expiry.startsWith('0x')) return Number(BigInt(expiry))
  return Number(expiry)
}

function isRelayKeyRecord(value: unknown): value is RelayKeyRecord {
  if (!isObject(value)) return false
  if (typeof value.expiry !== 'number' && typeof value.expiry !== 'string') return false
  if (typeof value.hash !== 'undefined') {
    if (typeof value.hash !== 'string' || !value.hash.startsWith('0x')) return false
  }
  if (typeof value.publicKey !== 'string' || !value.publicKey.startsWith('0x')) return false
  if (value.role !== 'admin' && value.role !== 'normal') return false
  if (value.type !== 'p256' && value.type !== 'secp256k1' && value.type !== 'webauthnp256') return false
  if (!Array.isArray(value.permissions)) return false
  return true
}

function parseSendCalls(calls: string) {
  const parsed = parseJsonFlag<SendCall[]>(calls, 'INVALID_CALLS_JSON')

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('INVALID_CALLS_JSON', 'Send calls must be a non-empty JSON array.')
  }

  return parsed.map((call) => {
    if (!call.to) {
      throw new AppError('INVALID_CALLS_JSON', 'Each send call must include a `to` address.')
    }

    let value: bigint | undefined
    if (call.value !== undefined) {
      try {
        value = typeof call.value === 'bigint' ? call.value : BigInt(call.value)
      } catch {
        throw new AppError(
          'INVALID_CALLS_JSON',
          'Each send call `value` must be a non-negative integer (decimal or 0x hex).',
        )
      }

      if (value < 0n) {
        throw new AppError(
          'INVALID_CALLS_JSON',
          'Each send call `value` must be a non-negative integer (decimal or 0x hex).',
        )
      }
    }

    return {
      ...call,
      ...(value !== undefined ? { value } : {}),
    }
  })
}

let relayRequestId = 0

async function requestRelay<T>(method: string, params: unknown[]): Promise<T> {
  let response: Response
  try {
    response = await fetch(normalizeRelayRpcUrl(), {
      body: JSON.stringify({
        id: ++relayRequestId,
        jsonrpc: '2.0',
        method,
        params,
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const metadata = errorMetadata(error)
    const message = metadata.message.toLowerCase()
    const timedOut = message.includes('timed out') || message.includes('timeout') || message.includes('aborted')
    throw new AppError(
      timedOut ? 'RELAY_REQUEST_TIMEOUT' : 'RELAY_HTTP_ERROR',
      timedOut ? 'Relay request timed out.' : 'Relay request failed.',
      {
        ...metadata,
        method,
        timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
      },
    )
  }

  if (!response.ok) {
    throw new AppError('RELAY_HTTP_ERROR', 'Relay request failed.', {
      method,
      status: response.status,
      statusText: response.statusText,
    })
  }

  const payload = (await response.json()) as {
    error?: {
      code?: number
      data?: unknown
      message?: string
    }
    result?: T
  }

  if (payload.error) {
    throw new AppError('RELAY_RPC_ERROR', payload.error.message ?? 'Relay returned an error.', {
      code: payload.error.code,
      data: payload.error.data,
      method,
    })
  }

  if (typeof payload.result === 'undefined') {
    throw new AppError('RELAY_INVALID_RESPONSE', 'Relay response is missing result.', { method })
  }

  return payload.result
}

async function withTimeout<T>(
  operation: Promise<T>,
  options: {
    code: string
    message: string
    details?: Record<string, unknown>
    timeoutMs?: number
  },
) {
  const timeoutMs = options.timeoutMs ?? SEND_STAGE_TIMEOUT_MS
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new AppError(options.code, options.message, {
              ...options.details,
              timeoutMs,
            }),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Finds the granted permission for a specific key and chain from a wallet_connect response.
 *
 * On regrants (and cross-chain grants) Porto returns 2 entries with the same chainId, id,
 * and expiry:
 *   1. Stale — the relay's previously stored data for this key, with fee-relay call targets
 *      and selectors injected, and spend limits that may belong to a different chain (known
 *      relay bug: session keys leak cross-chain via the `accounts` table fallback).
 *   2. Correct — the permission as actually requested for this chain.
 *
 * Strategy: filter by publicKey, then by chainId, then pick the last entry when expiries are
 * equal (>= not >) so we always get entry 2 (the correct, as-requested permission).
 *
 * When chainId is provided and no entries match that chain, returns undefined — permissions
 * are chain-scoped.
 */
function findGrantedPermission<T extends { chainId?: number; expiry: number; key: { publicKey: string } }>(
  permissions: readonly T[] | undefined,
  publicKey: string,
  chainId?: number,
): T | undefined {
  let matching = (permissions ?? []).filter(
    (p) => p.key.publicKey.toLowerCase() === publicKey.toLowerCase(),
  )
  if (matching.length === 0) return undefined
  if (chainId !== undefined) {
    matching = matching.filter((p) => p.chainId === chainId)
    if (matching.length === 0) return undefined
  }
  return matching.reduce((best, p) => (p.expiry >= best.expiry ? p : best))
}

type CallsStatusSnapshot = Awaited<ReturnType<typeof getCallsStatus>>

function extractTransactionHash(snapshot: CallsStatusSnapshot) {
  const hash = snapshot.receipts?.[0]?.transactionHash
  return hash ? String(hash) : null
}

async function waitForBundleSettlement(
  client: ReturnType<typeof WalletClient.fromPorto>,
  bundleId: `0x${string}`,
) {
  const deadline = Date.now() + SEND_STATUS_POLL_TIMEOUT_MS
  let status = 'pending'
  let txHash: string | null = null

  while (Date.now() <= deadline) {
    try {
      const snapshot = await withTimeout(
        getCallsStatus(client, {
          id: bundleId,
        }),
        {
          code: 'PORTO_SEND_STATUS_TIMEOUT',
          details: {
            bundleId,
            stage: 'send_prepared',
          },
          message: 'Timed out while fetching call status.',
          timeoutMs: SEND_STATUS_REQUEST_TIMEOUT_MS,
        },
      )

      status = snapshot.status ?? status
      txHash = extractTransactionHash(snapshot)
      if (txHash) break

      if (status !== 'pending') break
    } catch {
      // Best effort polling only: continue until deadline.
    }

    if (Date.now() + SEND_STATUS_POLL_INTERVAL_MS > deadline) {
      break
    }
    await sleep(SEND_STATUS_POLL_INTERVAL_MS)
  }

  return {
    status,
    txHash,
  }
}

type WalletSession = {
  client: ReturnType<typeof WalletClient.fromPorto>
  destroy: () => void
}

let sharedWalletSession: WalletSession | undefined
let hasRegisteredSessionCleanup = false

async function getWalletClient(options: {
  address?: `0x${string}`
  chain?: Chain
  dialogHost?: string
  mode?: 'dialog' | 'relay'
}) {
  if (sharedWalletSession) {
    return {
      client: sharedWalletSession.client,
      close: () => {},
    }
  }

  const chain = options.chain ?? Chains.baseSepolia
  const transportMode = options.mode ?? 'dialog'
  let porto: ReturnType<typeof Porto.create>

  if (transportMode === 'relay') {
    porto = Porto.create({
      announceProvider: false,
      chains: [...Chains.all],
      mode: Mode.relay(),
      relay: http(normalizeRelayRpcUrl()),
    })
  } else {
    const { cli: createCliDialog } = await import('porto/cli/Dialog')
    const host = normalizeDialogHost(options.dialogHost)
    porto = Porto.create({
      announceProvider: false,
      chains: [...Chains.all],
      mode: Mode.dialog({
        host: new URL('/dialog', `https://${host}`).toString(),
        renderer: await createCliDialog(),
      }),
    })
  }

  sharedWalletSession = {
    client: WalletClient.fromPorto(porto, {
      ...(options.address ? { account: options.address } : {}),
      chain,
    }),
    destroy: () => porto.destroy(),
  }

  if (!hasRegisteredSessionCleanup) {
    hasRegisteredSessionCleanup = true
    process.once('exit', () => {
      closeWalletSession()
    })
  }

  return {
    client: sharedWalletSession.client,
    close: () => {},
  }
}

export function closeWalletSession() {
  sharedWalletSession?.destroy()
  sharedWalletSession = undefined
}

export class PortoService {
  constructor(
    private readonly config: AgentWalletConfig,
    private readonly signer: SignerService,
  ) {}

  private appendPrecallPermission(
    address: `0x${string}`,
    chainId: number,
    granted: { id: `0x${string}`; expiry: number; key: { publicKey: `0x${string}`; type: string }; permissions?: unknown },
  ) {
    const raw = granted.permissions as {
      calls?: { to?: `0x${string}`; signature?: string }[]
      spend?: { limit: bigint | string; period: string; token?: `0x${string}` | null }[]
    } | undefined

    const precall: PrecallPermission = {
      address,
      chainId,
      expiry: granted.expiry,
      id: granted.id,
      key: granted.key,
      permissions: {
        calls: raw?.calls ?? [],
        spend: (raw?.spend ?? []).map((s) => ({ limit: String(s.limit), period: s.period, token: s.token ?? null })),
      },
    }

    this.config.porto = {
      ...this.config.porto!,
      precallPermissions: [...(this.config.porto?.precallPermissions ?? []), precall],
    }
  }

  private async buildGrantPermissionsParam(
    chain: Chain,
    policy: PermissionPolicy,
  ) {
    const key = await this.signer.getPortoKey()
    const feeTokenSymbol = chain.id === Chains.baseSepolia.id ? 'EXP' : 'native'
    const feeLimit = policy.feeLimit
      ?? (chain.id === Chains.baseSepolia.id ? DEFAULT_GRANT_FEE_LIMIT_EXP : DEFAULT_GRANT_FEE_LIMIT_NATIVE)
    const calls = policy.calls
      ? policy.calls
      : [{ to: DEFAULT_GRANT_ANY_TARGET, signature: DEFAULT_GRANT_ANY_SELECTOR }]
    return {
      expiry: Math.floor(Date.now() / 1000) + policy.expiryDays * 24 * 60 * 60,
      feeToken: { limit: feeLimit, symbol: feeTokenSymbol },
      key,
      permissions: {
        calls,
        spend: [{ limit: policy.spendLimitWei, period: policy.spendPeriod, ...(policy.spendToken ? { token: policy.spendToken } : {}) }],
      },
    }
  }

  async listAgentPermissions(options: {
    address?: `0x${string}`
    chainId?: number
    includeExpired?: boolean
  }): Promise<AgentPermissionSnapshot[]> {
    const address = options.address ?? this.config.porto?.address
    if (!address) {
      throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `openawa configure` first.')
    }

    const chain = resolveConfiguredChain(this.config, options.chainId)
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
    }

    const agentKey = await this.signer.getPortoKey()
    const relayKeys = await requestRelay<Record<string, unknown>>('wallet_getKeys', [
      {
        address,
        chainIds: [chain.id],
      },
    ])

    const nowSeconds = Math.floor(Date.now() / 1_000)
    const flattened = Object.values(relayKeys)
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .filter(isRelayKeyRecord)

    return flattened
      .filter((candidate) => candidate.role === 'normal')
      .filter((candidate) => normalizeRelayKeyType(candidate.type) === agentKey.type)
      .filter((candidate) => candidate.publicKey.toLowerCase() === agentKey.publicKey.toLowerCase())
      .filter((candidate) => (options.includeExpired ? true : parseRelayExpiry(candidate.expiry) > nowSeconds))
      .map((candidate) => {
        const calls = candidate.permissions
          .filter((permission): permission is RelayPermissionCall => permission.type === 'call')
          .map((permission) => ({
            signature: permission.selector,
            to: permission.to,
          }))
        const spend = candidate.permissions
          .filter((permission): permission is RelayPermissionSpend => permission.type === 'spend')
          .map((permission) => ({
            limit: BigInt(permission.limit),
            period: permission.period,
            token: permission.token,
          }))

        return {
          expiry: parseRelayExpiry(candidate.expiry),
          id: (candidate.hash ?? candidate.publicKey) as `0x${string}`,
          key: {
            publicKey: candidate.publicKey,
            type: normalizeRelayKeyType(candidate.type),
          },
          permissions: {
            calls,
            spend,
          },
        }
      })
  }

  async findMatchingPermission(options: {
    address: `0x${string}`
    policy: PermissionPolicy
    chainId?: number
    precallPermissions?: PrecallPermission[]
  }): Promise<{ id: `0x${string}`; chainId?: number } | null> {
    const desiredCalls = options.policy.calls
      ? options.policy.calls
      : [{ to: DEFAULT_GRANT_ANY_TARGET, signature: DEFAULT_GRANT_ANY_SELECTOR }]
    const desiredSpendLimit = options.policy.spendLimitWei
    const desiredSpendPeriod = options.policy.spendPeriod
    const desiredSpendToken = options.policy.spendToken

    const callsMatch = (calls: { to?: `0x${string}`; signature?: string }[]) => {
      // Desired calls must all be present (subset check). Porto may add extra entries
      // (e.g. for fee handling), so exact length equality would give false negatives.
      return desiredCalls.every((desired) =>
        calls.some(
          (c) =>
            c.to?.toLowerCase() === desired.to.toLowerCase() &&
            (desired.signature === undefined || c.signature?.toLowerCase() === desired.signature.toLowerCase()),
        ),
      )
    }

    const isNativeToken = (token: `0x${string}` | null | undefined) =>
      token == null || token === NATIVE_TOKEN_ADDRESS

    const spendMatch = (spend: { limit: bigint | string; period: string; token?: `0x${string}` | null }[]) =>
      spend.some((s) => {
        if (s.period !== desiredSpendPeriod || BigInt(s.limit) !== desiredSpendLimit) return false
        if (desiredSpendToken === undefined) return isNativeToken(s.token)
        return s.token?.toLowerCase() === desiredSpendToken.toLowerCase()
      })

    const onchain = await this.listAgentPermissions({ address: options.address, chainId: options.chainId })
    for (const p of onchain) {
      if (callsMatch(p.permissions.calls) && spendMatch(p.permissions.spend)) {
        return { id: p.id }
      }
    }

    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const p of options.precallPermissions ?? []) {
      if (
        p.address === options.address &&
        (!options.chainId || p.chainId === options.chainId) &&
        p.expiry > nowSeconds &&
        callsMatch(p.permissions.calls) &&
        spendMatch(p.permissions.spend)
      ) {
        return { id: p.id, chainId: p.chainId }
      }
    }

    return null
  }

  async permissionSummary(options: { address?: `0x${string}`; chainId?: number }) {
    const permissions = await this.listAgentPermissions({
      address: options.address,
      chainId: options.chainId,
      includeExpired: true,
    })

    const nowSeconds = Math.floor(Date.now() / 1_000)
    const active = permissions.filter((permission) => permission.expiry > nowSeconds)
    const latestExpiry = active.length > 0 ? Math.max(...active.map((p) => p.expiry)) : null

    return {
      active: active.length,
      latestExpiry: latestExpiry !== null ? new Date(latestExpiry * 1_000).toISOString() : null,
      total: permissions.length,
    }
  }

  async onboard(options: OnboardOptions) {
    const chain = options.chain
    let session: Awaited<ReturnType<typeof getWalletClient>> | undefined
    try {
      try {
        session = await getWalletClient({
          chain,
          dialogHost: options.dialogHost,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('listen EPERM')) {
          throw new AppError(
            'PORTO_LOCAL_RELAY_BIND_FAILED',
            'Unable to start local Porto CLI relay listener. Ensure local loopback bind is allowed.',
            {
              hint: 'In restricted sandbox/CI environments, allow local port binding or run onboarding outside sandbox.',
            },
          )
        }
        throw error
      }

      const grantPermissionsParam = await this.buildGrantPermissionsParam(chain, options.policy)

      const response = await WalletActions.connect(session.client, {
        chainIds: [chain.id],
        ...(options.createAccount
          ? { createAccount: true }
          : { selectAccount: true }),
        grantPermissions: grantPermissionsParam,
      })

      const account = response.accounts[0]
      if (!account?.address) {
        throw new AppError('ONBOARD_FAILED', 'Porto onboarding did not return an account address.')
      }

      const grantedPermission = findGrantedPermission(
        response.accounts[0]?.capabilities?.permissions,
        grantPermissionsParam.key.publicKey,
        chain.id,
      ) ?? null

      // Align with Porto CLI UX: notify dialog of success so the web page
      // can render a completion state instead of staying idle/blank.
      try {
        const { messenger } = await import('porto/cli/Dialog')
        const isCreate = Boolean(options.createAccount)
        messenger.send('success', {
          title: isCreate ? 'Account created' : 'Account connected',
          content: isCreate
            ? 'You have successfully created an account.'
            : 'You have successfully signed in to your account.',
        })

        // Give the message channel a brief moment to flush before process exit.
        await new Promise((resolve) => setTimeout(resolve, 300))
      } catch {
        // Non-fatal for onboard result; CLI output remains source of truth.
      }

      const addressChanged =
        this.config.porto?.address &&
        this.config.porto.address.toLowerCase() !== account.address.toLowerCase()

      const existingChainIds = this.config.porto?.chainIds ?? []
      const newChainIds = [...new Set([...existingChainIds, chain.id])]

      this.config.porto = {
        ...this.config.porto,
        address: account.address,
        chainIds: newChainIds,
        dialogHost: normalizeDialogHost(options.dialogHost),
        precallPermissions: addressChanged ? [] : (this.config.porto?.precallPermissions ?? []),
      }

      if (grantedPermission) {
        this.appendPrecallPermission(account.address, chain.id, grantedPermission)
      }

      return {
        address: account.address,
        chainId: chain.id,
        grantedPermission: grantedPermission
          ? { id: grantedPermission.id, expiry: grantedPermission.expiry }
          : null,
      }
    } finally {
      session?.close()
    }
  }

  async grant(options: GrantOptions) {
    const address = options.address ?? this.config.porto?.address
    const chain = options.chain

    const session = await getWalletClient({
      address,
      chain,
      dialogHost: this.config.porto?.dialogHost,
    })

    try {
      const grantPermissionsParam = await this.buildGrantPermissionsParam(chain, options.policy)

      const connectResponse = await WalletActions.connect(session.client, {
        chainIds: [chain.id],
        ...(address ? { selectAccount: { address } } : { selectAccount: true }),
        grantPermissions: grantPermissionsParam,
      })

      const grantedPermission = findGrantedPermission(
        connectResponse.accounts[0]?.capabilities?.permissions,
        grantPermissionsParam.key.publicKey,
        chain.id,
      )

      if (!grantedPermission) {
        throw new AppError('GRANT_FAILED', 'Porto did not return a granted permission.')
      }

      // Align with Porto CLI UX: notify dialog of success so the web page
      // can render a completion state instead of staying idle/blank.
      try {
        const { messenger } = await import('porto/cli/Dialog')
        messenger.send('success', {
          title: 'Permissions granted',
          content: 'The agent has been granted the requested permissions.',
        })

        // Give the message channel a brief moment to flush before process exit.
        await new Promise((resolve) => setTimeout(resolve, 300))
      } catch {
        // Non-fatal for grant result; CLI output remains source of truth.
      }

      const resolvedAddress = (options.address ?? this.config.porto?.address) as `0x${string}`

      const existingChainIds = this.config.porto?.chainIds ?? []
      const newChainIds = [...new Set([...existingChainIds, chain.id])]

      this.config.porto = {
        ...this.config.porto,
        chainIds: newChainIds,
        precallPermissions: this.config.porto?.precallPermissions ?? [],
      }

      this.appendPrecallPermission(resolvedAddress, chain.id, grantedPermission)

      return {
        permissionId: grantedPermission.id,
        expiry: grantedPermission.expiry,
        key: grantedPermission.key,
      }
    } finally {
      session.close()
    }
  }

  async fund(options: FundOptions) {
    const chain = resolveConfiguredChain(this.config, options.chainId)
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
    }

    const session = await getWalletClient({
      address: options.address ?? this.config.porto?.address,
      chain,
      dialogHost: this.config.porto?.dialogHost,
    })

    try {
      const address = options.address ?? this.config.porto?.address
      if (!address) {
        throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `openawa configure` first.')
      }

      await WalletActions.connect(session.client, {
        chainIds: [chain.id],
        selectAccount: {
          address,
        },
      })

      const response = await WalletActions.addFunds(session.client, {
        address,
        chainId: chain.id,
        ...(chain.id === Chains.base.id ? { token: NATIVE_TOKEN_ADDRESS } : {}),
      })

      if (chain.id === Chains.baseSepolia.id && response.id === ZERO_TX_HASH) {
        try {
          const fallback = await requestRelay<{ transactionHash: `0x${string}` }>('wallet_addFaucetFunds', [
            {
              address,
              chainId: chain.id,
              tokenAddress: BASE_SEPOLIA_EXP_TOKEN,
              value: BASE_SEPOLIA_FAUCET_VALUE,
            },
          ])

          return {
            id: fallback.transactionHash,
            kind: 'faucet',
          }
        } catch (error) {
          const metadata = errorMetadata(error)
          throw new AppError(
            'FUNDING_UNCONFIRMED',
            'Funding dialog returned a placeholder transaction id and faucet fallback failed.',
            {
              ...metadata,
              hint: 'Re-run configure and complete the faucet/add-funds dialog flow again.',
            },
          )
        }
      }

      return {
        id: response.id,
        kind: chain.id === Chains.baseSepolia.id ? 'faucet' : 'onramp',
      }
    } finally {
      session.close()
    }
  }

  async *send(options: SendOptions): AsyncGenerator<
    { stage: 'prepare_calls' | 'sign_digest' | 'send_prepared' | 'await_settlement' },
    { txHash: string | null; bundleId: string; status: string },
    unknown
  > {
    const chain = options.chain

    const session = await getWalletClient({
      address: options.address ?? this.config.porto?.address,
      chain,
      dialogHost: this.config.porto?.dialogHost,
      mode: 'relay',
    })

    let stage: 'prepare_calls' | 'sign_digest' | 'send_prepared' | 'await_settlement' = 'prepare_calls'

    try {
      const key = await this.signer.getPortoKey()
      const calls = parseSendCalls(options.calls)
      const resolvedAddress = options.address ?? this.config.porto?.address

      let prepared: Awaited<ReturnType<typeof WalletActions.prepareCalls>>
      try {
        stage = 'prepare_calls'
        yield { stage }
        prepared = await withTimeout(
          WalletActions.prepareCalls(session.client, {
            calls: calls as any,
            chainId: chain.id,
            from: resolvedAddress,
            key,
          }),
          {
            code: 'PORTO_SEND_PREPARE_TIMEOUT',
            details: { stage },
            message: 'Timed out while preparing calls via Porto.',
          },
        )
      } catch (error) {
        if (error instanceof AppError) throw error
        const metadata = errorMetadata(error)
        throw new AppError('PORTO_SEND_PREPARE_FAILED', 'Porto failed to prepare calls.', {
          ...metadata,
          stage,
        })
      }

      let signatureResult: Awaited<ReturnType<SignerService['sign']>>
      try {
        stage = 'sign_digest'
        yield { stage }
        signatureResult = await this.signer.sign(prepared.digest, 'hex', 'none')
      } catch (error) {
        const metadata = errorMetadata(error)
        throw new AppError('PORTO_SEND_SIGN_FAILED', 'Local signer failed to sign prepared digest.', {
          ...metadata,
          stage,
        })
      }

      let response: Awaited<ReturnType<typeof WalletActions.sendPreparedCalls>>
      try {
        stage = 'send_prepared'
        yield { stage }
        response = await withTimeout(
          WalletActions.sendPreparedCalls(session.client, {
            ...prepared,
            signature: signatureResult.signature as `0x${string}`,
          }),
          {
            code: 'PORTO_SEND_SUBMIT_TIMEOUT',
            details: { stage },
            message: 'Timed out while submitting prepared calls via Porto.',
          },
        )
      } catch (error) {
        if (error instanceof AppError) throw error
        const metadata = errorMetadata(error)
        throw new AppError('PORTO_SEND_SUBMIT_FAILED', 'Porto failed to submit prepared calls.', {
          ...metadata,
          stage,
        })
      }

      const bundleId = response[0]?.id
      if (!bundleId) {
        throw new AppError('SEND_FAILED', 'Porto did not return a call bundle id.')
      }

      stage = 'await_settlement'
      yield { stage }
      const settlement = await waitForBundleSettlement(session.client, bundleId)

      // Precall permissions are now on-chain — clear them from local config.
      if (this.config.porto) {
        this.config.porto = { ...this.config.porto, precallPermissions: [] }
      }

      return {
        txHash: settlement.txHash,
        bundleId,
        status: settlement.status,
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      const metadata = errorMetadata(error)
      throw new AppError('PORTO_SEND_FAILED', 'Failed to prepare/sign/submit calls via Porto.', {
        ...metadata,
        stage,
      })
    } finally {
      session.close()
    }
  }

  async permissions(options: PermissionsOptions) {
    const permissions = await this.listAgentPermissions({
      address: options.address,
      chainId: options.chainId,
    })

    return {
      permissions,
    }
  }

  getChainDetails(chainId?: number) {
    const chain = resolveConfiguredChain(this.config, chainId)
    return chain
      ? {
          id: chain.id,
          name: chain.name,
        }
      : undefined
  }

  async balance(options: { address?: `0x${string}`; chainId?: number }) {
    const address = options.address ?? this.config.porto?.address
    if (!address) {
      throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `openawa configure` first.')
    }

    const chain = resolveConfiguredChain(this.config, options.chainId)
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
    }

    const rpcUrl = chain.rpcUrls.default.http[0]
    if (!rpcUrl) {
      throw new AppError('MISSING_RPC_URL', 'No default RPC URL is configured for the selected chain.', {
        chainId: chain.id,
      })
    }

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    const balanceWei = await publicClient.getBalance({ address })

    return {
      address,
      chainId: chain.id,
      chainName: chain.name,
      wei: balanceWei.toString(),
      formatted: formatEther(balanceWei),
      symbol: chain.nativeCurrency.symbol,
    }
  }

  async deployment(options: { address?: `0x${string}`; chainId?: number }) {
    const address = options.address ?? this.config.porto?.address
    if (!address) {
      throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `openawa configure` first.')
    }

    const chain = resolveConfiguredChain(this.config, options.chainId)
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
    }

    const rpcUrl = chain.rpcUrls.default.http[0]
    if (!rpcUrl) {
      throw new AppError('MISSING_RPC_URL', 'No default RPC URL is configured for the selected chain.', {
        chainId: chain.id,
      })
    }

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    const bytecode = await publicClient.getCode({
      address,
    })

    return {
      address,
      chainId: chain.id,
      chainName: chain.name,
      deployed: Boolean(bytecode && bytecode !== '0x'),
      bytecodeLength: bytecode ? (bytecode.length - 2) / 2 : 0,
    }
  }
}
