#!/usr/bin/env node

/**
 * Research/debug script (not product code).
 *
 * Purpose:
 * - inspect wallet_getKeys and related Porto relay behavior
 * - experiment with key/permission lifecycle during configure/sign flows
 *
 * Safety:
 * - this script is for manual investigation only
 * - not used by the CLI runtime
 * - not used by CI tests
 */

import { Chains, Mode, Porto } from 'porto'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as WalletActions from 'porto/viem/WalletActions'
import * as WalletClient from 'porto/viem/WalletClient'
import * as Key from 'porto/viem/Key'
import { createPublicClient, http, toHex } from 'viem'

const DEFAULT_RPC_URL = process.env.AGENT_WALLET_RELAY_URL ?? 'https://rpc.porto.sh'
const DEFAULT_LIMIT = 20
const DEFAULT_CHAIN_ID = 84532
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_GRANT_WAIT_MS = 15_000
const DEFAULT_FAUCET_CONFIRMATIONS = 1
const BASE_SEPOLIA_EXP_TOKEN = '0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e'
const BASE_SEPOLIA_FAUCET_VALUE = '0x340aad21b3b700000'

function ensureHeadlessBrowserGlobals() {
  let nav = globalThis.navigator
  if (typeof nav === 'undefined') {
    nav = {
      maxTouchPoints: 0,
      userAgent: 'node',
      userAgentData: { mobile: false },
    }
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: nav,
      writable: true,
    })
  }

  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      location: {
        hostname: 'localhost',
        origin: 'http://localhost',
      },
      navigator: nav,
    }
  }
}

function parseArgs(argv) {
  const options = {
    account: undefined,
    addNormalKey: false,
    chainId: DEFAULT_CHAIN_ID,
    chainIds: undefined,
    createMockAccount: false,
    grantWaitMs: DEFAULT_GRANT_WAIT_MS,
    limit: DEFAULT_LIMIT,
    rpcUrl: DEFAULT_RPC_URL,
    separateGrant: false,
    spendUsd: 1,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  }

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token) continue

    if (!token.startsWith('--') && !options.account) {
      options.account = token
      continue
    }

    if (token === '--add-normal-key') {
      options.addNormalKey = true
      continue
    }

    if (token === '--create-mock-account') {
      options.createMockAccount = true
      continue
    }

    if (token === '--separate-grant') {
      options.separateGrant = true
      continue
    }

    if (token === '--rpc-url') {
      options.rpcUrl = argv[i + 1] ?? options.rpcUrl
      i += 1
      continue
    }

    if (token === '--chain-ids') {
      const raw = argv[i + 1] ?? ''
      i += 1
      const parsed = raw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
      options.chainIds = parsed.length > 0 ? parsed : undefined
      continue
    }

    if (token === '--chain-id') {
      const parsed = Number(argv[i + 1] ?? '')
      i += 1
      if (Number.isInteger(parsed) && parsed > 0) {
        options.chainId = parsed
      }
      continue
    }

    if (token === '--limit') {
      const parsed = Number(argv[i + 1] ?? '')
      i += 1
      if (Number.isInteger(parsed) && parsed > 0) {
        options.limit = parsed
      }
      continue
    }

    if (token === '--grant-wait-ms') {
      const parsed = Number(argv[i + 1] ?? '')
      i += 1
      if (Number.isInteger(parsed) && parsed >= 0) {
        options.grantWaitMs = parsed
      }
      continue
    }

    if (token === '--ttl-seconds') {
      const parsed = Number(argv[i + 1] ?? '')
      i += 1
      if (Number.isInteger(parsed) && parsed > 0) {
        options.ttlSeconds = parsed
      }
      continue
    }

    if (token === '--spend-usd') {
      const parsed = Number(argv[i + 1] ?? '')
      i += 1
      if (Number.isFinite(parsed) && parsed > 0) {
        options.spendUsd = parsed
      }
      continue
    }
  }

  return options
}

async function rpc(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: Date.now(),
      jsonrpc: '2.0',
      method,
      params,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${method} HTTP ${response.status}: ${body}`)
  }

  const payload = await response.json()
  if (payload.error) {
    throw new Error(`${method} RPC ${payload.error.code}: ${payload.error.message}`)
  }

  return payload.result
}

function parseHexBigInt(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string' && value.startsWith('0x')) return BigInt(value)
  if (typeof value === 'string' && value.length > 0) return BigInt(value)
  return 0n
}

function formatExpiry(expiryValue) {
  const expiry = parseHexBigInt(expiryValue)
  if (expiry === 0n) {
    return {
      active: true,
      iso: 'never',
    }
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  const active = expiry > now
  const asNumber = Number(expiry)
  const iso = Number.isFinite(asNumber) ? new Date(asNumber * 1000).toISOString() : 'out-of-range'

  return { active, iso }
}

function shortHash(value) {
  if (typeof value !== 'string') return String(value)
  if (value.length <= 16) return value
  return `${value.slice(0, 10)}..${value.slice(-6)}`
}

function usage() {
  console.log(
    'Usage: node scripts/debug-wallet-getkeys.mjs <account> [--rpc-url <url>] [--chain-ids 8453,84532] [--limit 20]',
  )
  console.log(
    '       node scripts/debug-wallet-getkeys.mjs --add-normal-key --create-mock-account [--chain-id 84532] [--ttl-seconds 604800] [--spend-usd 1]',
  )
  console.log(
    '       node scripts/debug-wallet-getkeys.mjs --add-normal-key --create-mock-account --separate-grant [--chain-id 84532]',
  )
  console.log('Notes:')
  console.log('  - This script is headless-only and never opens Porto dialog UI.')
  console.log(
    '  - Adding a key is intentionally limited to --create-mock-account to avoid implicit interactive/passkey flows.',
  )
  console.log(
    '  - --separate-grant runs explicit calls: create account, grant permission, then activation send to persist onchain.',
  )
  console.log(
    '  - --grant-wait-ms controls how long to poll relay wallet_getKeys for persisted normal key after separate grant.',
  )
}

function resolveChain(chainId) {
  if (chainId === Chains.base.id) return Chains.base
  if (chainId === Chains.baseSepolia.id) return Chains.baseSepolia
  throw new Error(`Unsupported chain id ${String(chainId)} (supported: 8453, 84532).`)
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForPersistedNormalKey({ account, chainId, rpcUrl, timeoutMs }) {
  const startedAt = Date.now()
  let polls = 0
  while (Date.now() - startedAt <= timeoutMs) {
    polls += 1
    const keysByChain = await rpc(rpcUrl, 'wallet_getKeys', [
      { address: account, chainIds: [chainId] },
    ])
    const chainKey = `0x${chainId.toString(16)}`
    const keys = Array.isArray(keysByChain?.[chainKey]) ? keysByChain[chainKey] : []
    const hasNormal = keys.some((key) => key?.role === 'normal')
    if (hasNormal) {
      return { polls, visible: true }
    }
    await sleep(1_000)
  }
  return { polls, visible: false }
}

async function ensureFaucetFundsIfAvailable({ account, chain, rpcUrl }) {
  if (chain.id !== Chains.baseSepolia.id) return { skipped: true }

  const faucet = await rpc(rpcUrl, 'wallet_addFaucetFunds', [
    {
      address: account,
      chainId: chain.id,
      tokenAddress: BASE_SEPOLIA_EXP_TOKEN,
      value: BASE_SEPOLIA_FAUCET_VALUE,
    },
  ])
  const faucetTxHash = typeof faucet?.transactionHash === 'string' ? faucet.transactionHash : null
  if (!faucetTxHash) {
    throw new Error(
      `wallet_addFaucetFunds returned no transaction hash (message: ${String(faucet?.message ?? 'none')}).`,
    )
  }

  const confirmations = await waitForTransactionConfirmations({
    chain,
    confirmations: DEFAULT_FAUCET_CONFIRMATIONS,
    timeoutMs: 30_000,
    transactionHash: faucetTxHash,
  })

  return {
    confirmationPolls: confirmations.polls,
    confirmationWaitMs: confirmations.waitedMs,
    confirmations: confirmations.confirmations,
    confirmedAtBlock: confirmations.latestBlock,
    includedInBlock: confirmations.includedBlock,
    message: faucet?.message,
    skipped: false,
    transactionHash: faucetTxHash,
  }
}

function resolveChainRpcUrl(chain) {
  const rpcUrl = chain?.rpcUrls?.default?.http?.[0]
  if (!rpcUrl) {
    throw new Error(`Missing public RPC URL for chain ${String(chain?.id ?? 'unknown')}.`)
  }
  return rpcUrl
}

async function waitForTransactionConfirmations({
  chain,
  confirmations,
  timeoutMs,
  transactionHash,
}) {
  const startedAt = Date.now()
  let polls = 0
  const required = BigInt(confirmations)
  const publicClient = createPublicClient({
    chain,
    transport: http(resolveChainRpcUrl(chain)),
  })

  while (Date.now() - startedAt <= timeoutMs) {
    polls += 1
    const receipt = await publicClient
      .getTransactionReceipt({ hash: transactionHash })
      .catch(() => null)
    if (receipt?.blockNumber) {
      const latestBlock = await publicClient.getBlockNumber()
      const count = latestBlock - receipt.blockNumber + 1n
      if (count >= required) {
        return {
          confirmations: Number(count),
          includedBlock: receipt.blockNumber,
          latestBlock,
          polls,
          waitedMs: Date.now() - startedAt,
        }
      }
    }
    await sleep(1_000)
  }

  throw new Error(
    `Timed out waiting for faucet tx ${transactionHash} to reach ${confirmations} confirmations within ${timeoutMs}ms.`,
  )
}

async function waitForBundleTerminal({ bundleId, rpcUrl, timeoutMs }) {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const status = await rpc(rpcUrl, 'wallet_getCallsStatus', [bundleId]).catch((error) => {
      return { error: error instanceof Error ? error.message : String(error) }
    })
    if (
      status &&
      typeof status === 'object' &&
      Number.isInteger(status.status) &&
      status.status >= 200
    ) {
      if (status.status === 200 || status.status === 201) {
        return status
      }
      throw new Error(
        `Activation bundle ${bundleId} reached terminal failure status ${status.status}.`,
      )
    }
    if (status && typeof status === 'object' && typeof status.error === 'string') {
      throw new Error(`wallet_getCallsStatus failed for ${bundleId}: ${status.error}`)
    }
    await sleep(1_000)
  }
  throw new Error(
    `Timed out waiting for call bundle ${bundleId} to reach successful terminal status within ${timeoutMs}ms.`,
  )
}

async function activateGrantedPermissionOnchain({
  account,
  chain,
  client,
  rpcUrl,
  sessionPrivateKey,
  sessionPublicKey,
  timeoutMs,
}) {
  const prepared = await WalletActions.prepareCalls(client, {
    chainId: chain.id,
    from: account,
    // No-op self call. In separate mode we scope permission to this account address.
    calls: [{ data: '0x', to: account, value: 0n }],
    key: {
      prehash: false,
      publicKey: sessionPublicKey,
      type: 'secp256k1',
    },
  })

  const signature = await Key.sign(
    {
      privateKey: () => sessionPrivateKey,
      publicKey: sessionPublicKey,
      role: 'session',
      type: 'secp256k1',
    },
    {
      address: null,
      payload: prepared.digest,
      wrap: false,
    },
  )

  const sent = await WalletActions.sendPreparedCalls(client, {
    capabilities: prepared.capabilities,
    chainId: toHex(chain.id),
    context: prepared.context,
    key: prepared.key,
    signature,
  })

  const bundleId = Array.isArray(sent) ? sent[0]?.id : sent?.id
  if (!bundleId) {
    throw new Error('Permission activation send returned no bundle id.')
  }

  const status = await waitForBundleTerminal({
    bundleId,
    rpcUrl,
    timeoutMs,
  })
  return { bundleId, statusCode: status.status }
}

async function addNormalKey(options) {
  if (!options.createMockAccount) {
    throw new Error(
      'Headless key grant requires --create-mock-account. For passkey-admin accounts, use the interactive configure flow.',
    )
  }

  const chain = resolveChain(options.chainId)
  const sessionPrivateKey = generatePrivateKey()
  const sessionAccount = privateKeyToAccount(sessionPrivateKey)
  const expiry = Math.floor(Date.now() / 1000) + options.ttlSeconds
  const spendLimit = BigInt(Math.round(options.spendUsd * 1_000_000))
  const feeTokenSymbol = chain.id === Chains.baseSepolia.id ? 'EXP' : 'native'
  const connectPermissionRequest = {
    expiry,
    feeToken: {
      limit: '1',
      symbol: feeTokenSymbol,
    },
    key: {
      // Porto docs use address as public identifier for secp256k1.
      publicKey: sessionAccount.address,
      type: 'secp256k1',
    },
    permissions: {
      calls: [{ signature: 'transfer(address,uint256)' }],
      spend: [{ limit: spendLimit, period: 'day' }],
    },
  }

  const mode = Mode.relay({ mock: true })
  const porto = Porto.create({
    announceProvider: false,
    chains: [Chains.base, Chains.baseSepolia],
    mode,
    relay: http(options.rpcUrl),
  })

  const client = WalletClient.fromPorto(porto, {
    chain,
  })

  try {
    console.log(`[headless] creating mock account on chain ${chain.id}...`)
    const created = await WalletActions.connect(client, {
      chainIds: [chain.id],
      createAccount: true,
      ...(options.separateGrant ? {} : { grantPermissions: connectPermissionRequest }),
    })
    const targetAddress = created.accounts[0]?.address
    if (!targetAddress) {
      throw new Error('Failed to create mock account in relay mode.')
    }
    console.log(`Created mock account: ${targetAddress}`)
    let permissionId
    if (options.separateGrant) {
      console.log('[headless] granting normal key via standalone wallet_grantPermissions...')
      const separatePermissionRequest = {
        expiry,
        feeToken: {
          // Use a high cap for debug activation to avoid offchain fee-limit failures.
          limit: '1000000000000000000',
          symbol: feeTokenSymbol,
        },
        key: {
          publicKey: sessionAccount.address,
          type: 'secp256k1',
        },
        // Keep scope explicit and minimal for activation debugging.
        permissions: {
          calls: [{ to: targetAddress }],
        },
      }
      const granted = await WalletActions.grantPermissions(client, {
        ...separatePermissionRequest,
        address: targetAddress,
        chainId: chain.id,
      })
      permissionId = granted.id
      if (!permissionId) {
        throw new Error('wallet_grantPermissions returned no permission id.')
      }
      console.log(`[headless] granted permission id: ${permissionId}`)

      if (chain.id === Chains.baseSepolia.id) {
        console.log('[headless] funding mock account via wallet_addFaucetFunds...')
      }
      const faucet = await ensureFaucetFundsIfAvailable({
        account: targetAddress,
        chain,
        rpcUrl: options.rpcUrl,
      })
      if (!faucet.skipped) {
        console.log(`[headless] faucet tx accepted (tx=${faucet.transactionHash ?? 'none'})`)
        console.log(
          `[headless] faucet tx confirmations=${faucet.confirmations} (target=${DEFAULT_FAUCET_CONFIRMATIONS}, confirmationPolls=${faucet.confirmationPolls}, waitMs=${faucet.confirmationWaitMs}, includedBlock=${faucet.includedInBlock}, latestBlock=${faucet.confirmedAtBlock})`,
        )
        if (typeof faucet.message === 'string' && faucet.message.length > 0) {
          console.log(`[headless] faucet message: ${faucet.message}`)
        }
      }

      console.log(
        '[headless] activating granted key with session-signed wallet_sendPreparedCalls...',
      )
      const activation = await activateGrantedPermissionOnchain({
        account: targetAddress,
        chain,
        client,
        rpcUrl: options.rpcUrl,
        sessionPrivateKey,
        sessionPublicKey: sessionAccount.address,
        timeoutMs: Math.max(options.grantWaitMs, 10_000),
      })
      console.log(
        `[headless] activation bundle succeeded (status ${activation.statusCode}): ${activation.bundleId}`,
      )

      const visibilityTimeoutMs = Math.max(options.grantWaitMs, 1_000)
      console.log(
        `[headless] checking relay persistence (wallet_getKeys) for up to ${visibilityTimeoutMs}ms...`,
      )
      const observed = await waitForPersistedNormalKey({
        account: targetAddress,
        chainId: chain.id,
        rpcUrl: options.rpcUrl,
        timeoutMs: visibilityTimeoutMs,
      })
      if (!observed.visible) {
        throw new Error(
          `Activation call completed but wallet_getKeys still missing normal key after ${visibilityTimeoutMs}ms (${observed.polls} polls).`,
        )
      }
      console.log(`[headless] relay now shows normal key after ${observed.polls} poll(s).`)
    } else {
      const granted = created.accounts[0]?.capabilities?.permissions?.[0]
      if (!granted?.id) {
        throw new Error('Mock account created but no granted permission was returned.')
      }
      permissionId = granted.id
      console.log('Granted test non-admin key during wallet_connect (grantPermissions capability).')
    }

    console.log(`  permissionId: ${permissionId}`)
    console.log(`  keyType: secp256k1`)
    console.log(`  keyPublicIdentifier: ${sessionAccount.address}`)
    console.log(`  testPrivateKey: ${sessionPrivateKey}`)
    console.log('  NOTE: test key only; do not use for real funds.')
    return {
      account: targetAddress,
      permissionId,
    }
  } finally {
    porto.destroy()
  }
}

async function loadState(options) {
  const keyParams = options.chainIds
    ? [{ address: options.account, chainIds: options.chainIds }]
    : [{ address: options.account }]

  const [keysByChain, history] = await Promise.all([
    rpc(options.rpcUrl, 'wallet_getKeys', keyParams),
    rpc(options.rpcUrl, 'wallet_getCallsHistory', [
      {
        address: options.account,
        limit: options.limit,
        sort: 'desc',
      },
    ]),
  ])

  return { keysByChain, history }
}

function renderState(options, state) {
  console.log(`RPC URL: ${options.rpcUrl}`)
  console.log(`Account: ${options.account}`)
  if (options.chainIds) {
    console.log(`Requested chainIds: ${options.chainIds.join(', ')}`)
  }
  console.log('')

  const keyHashSet = new Set()
  let normalCount = 0
  let adminCount = 0

  for (const [chainHex, keys] of Object.entries(state.keysByChain ?? {})) {
    const chainId = Number.parseInt(chainHex, 16)
    console.log(`Chain ${chainHex} (${chainId})`)

    if (!Array.isArray(keys) || keys.length === 0) {
      console.log('  - no keys')
      continue
    }

    for (const key of keys) {
      const role = key?.role ?? 'unknown'
      const hash = key?.hash ?? 'unknown'
      keyHashSet.add(String(hash).toLowerCase())
      if (role === 'normal') normalCount += 1
      if (role === 'admin') adminCount += 1

      const expiry = formatExpiry(key?.expiry)
      const permissionsCount = Array.isArray(key?.permissions) ? key.permissions.length : 0
      console.log(
        `  - role=${role} type=${key?.type ?? 'unknown'} hash=${shortHash(String(hash))} active=${String(expiry.active)} expiry=${expiry.iso} permissions=${permissionsCount}`,
      )
    }
  }

  console.log('')
  console.log(`Summary: admin keys=${adminCount}, non-admin(normal) keys=${normalCount}`)

  const historyList = Array.isArray(state.history) ? state.history : []
  const unknownHashes = new Set()
  for (const entry of historyList) {
    const keyHash = String(entry?.keyHash ?? '').toLowerCase()
    if (keyHash && !keyHashSet.has(keyHash)) {
      unknownHashes.add(keyHash)
    }
  }

  console.log(`Recent bundles checked: ${historyList.length}`)
  if (unknownHashes.size > 0) {
    console.log('History includes key hashes not present in current wallet_getKeys response:')
    for (const hash of unknownHashes) {
      console.log(`  - ${hash}`)
    }
  } else {
    console.log('All recent bundle key hashes are present in current wallet_getKeys response.')
  }
}

async function main() {
  ensureHeadlessBrowserGlobals()

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage()
    return
  }

  const options = parseArgs(process.argv)
  if (!options.account && !options.createMockAccount) {
    usage()
    process.exitCode = 1
    return
  }

  if (options.addNormalKey) {
    if (options.account) {
      throw new Error(
        '--add-normal-key ignores explicit account input. Use --create-mock-account to create + grant in a headless flow.',
      )
    }
    if (!options.chainIds) {
      options.chainIds = [options.chainId]
    }
    const result = await addNormalKey(options)
    if (!options.account) {
      options.account = result.account
    }
    console.log('')
  }

  const state = await loadState(options)
  renderState(options, state)
}

main().catch((error) => {
  const asError = error instanceof Error ? error : new Error(String(error))
  console.error(`Error: ${asError.message}`)
  if (asError.cause) {
    console.error(`Cause: ${String(asError.cause)}`)
  }
  if (asError.stack) {
    console.error(asError.stack)
  }
  process.exitCode = 1
})
