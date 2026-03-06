import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { execa } from 'execa'
import { spawn as ptySpawn } from 'node-pty'
import { chromium, type Page } from 'playwright'
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'

type PendingMatcher = {
  pattern: string | RegExp
  resolve: (line: string) => void
  reject: (err: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

function stripAnsiCodes(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
}

export type CliRunResult = {
  exitCode: number
  payload: Record<string, unknown> | unknown[] | null
  stderr: string
  stdout: string
}

export type CliHandle = {
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>
  done(): Promise<CliRunResult>
}

export type InteractiveCliHandle = CliHandle & {
  sendKeys(keys: string): void
}

export type VirtualBrowser = {
  page: Page
  close(): Promise<void>
}

type IsolatedEnv = {
  configHome: string
  env: NodeJS.ProcessEnv
}

type AgentWalletConfig = {
  porto?: {
    address?: `0x${string}`
    chainIds?: number[]
    precallPermissions?: unknown[]
  }
}

const DEFAULT_RELAY_RPC_URL = 'https://rpc.porto.sh'
const BASE_SEPOLIA_EXP_TOKEN = '0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e'
const BASE_SEPOLIA_FAUCET_VALUE = '0x340aad21b3b700000'
const PROCESS_TIMEOUT_MS = 3 * 60 * 1_000
const DEBUG = process.env.AGENT_WALLET_E2E_DEBUG === '1'
const BROWSER_HEADLESS =
  process.env.AGENT_WALLET_E2E_HEADLESS !== '0' && process.env.AGENT_WALLET_E2E_HEADLESS !== 'false'

export async function makeIsolatedEnv(): Promise<IsolatedEnv> {
  const configHome = await mkdtemp(path.join(os.tmpdir(), 'openawa-e2e-'))
  return {
    configHome,
    env: {
      ...process.env,
      AGENT_WALLET_CONFIG_HOME: configHome,
    },
  }
}

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<CliRunResult> {
  if (DEBUG) {
    console.error(`[e2e][runCli] node dist/cli.js ${args.join(' ')}`)
  }

  const result = await execa('node', ['dist/cli.js', ...args], {
    env,
    reject: false,
    timeout: timeoutMs,
  })

  const timeoutNote = result.timedOut
    ? `\n[e2e][runCli] timed out after ${String(timeoutMs)}ms`
    : ''
  const stderr = `${result.stderr}${timeoutNote}`

  if (DEBUG) {
    console.error(
      `[e2e][runCli] exit=${String(result.exitCode ?? 1)} timedOut=${String(result.timedOut)}\nstdout:\n${result.stdout}\n\nstderr:\n${stderr}`,
    )
  }

  const output = (result.stdout || stderr || '').trim()

  return {
    exitCode: result.exitCode ?? 1,
    payload: parseJsonPayload(output),
    stderr,
    stdout: result.stdout,
  }
}

export function getLiveNetwork(): 'prod' | 'testnet' {
  return process.env.AGENT_WALLET_E2E_NETWORK === 'prod' ? 'prod' : 'testnet'
}

export async function readAgentWalletConfig(configHome: string): Promise<AgentWalletConfig> {
  const configPath = path.join(configHome, 'openawa', 'config.json')
  const raw = await readFile(configPath, 'utf8')
  return JSON.parse(raw) as AgentWalletConfig
}

/**
 * Spawns a CLI process and returns a handle for sequentially waiting on stdout
 * patterns (pexpect-style) before acting, then collecting the final result.
 */
export function spawnCli(args: string[], env: NodeJS.ProcessEnv): CliHandle {
  if (DEBUG) {
    console.error(`[e2e][spawnCli] node dist/cli.js ${args.join(' ')}`)
  }

  const child = spawn('node', ['dist/cli.js', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let stdoutBuffer = ''
  let cliExited = false
  let cliExitCode: number | null = null

  const bufferedLines: string[] = []

  const pendingMatchers: PendingMatcher[] = []

  const checkMatchers = (line: string) => {
    for (let i = pendingMatchers.length - 1; i >= 0; i--) {
      const matcher = pendingMatchers[i]!
      const matched =
        typeof matcher.pattern === 'string'
          ? line.includes(matcher.pattern)
          : matcher.pattern.test(line)
      if (matched) {
        clearTimeout(matcher.timeoutId)
        pendingMatchers.splice(i, 1)
        matcher.resolve(line)
      }
    }
  }

  const onLine = (line: string) => {
    stdout += `${line}\n`
    bufferedLines.push(line)
    if (DEBUG) console.error(`[e2e][stdout] ${line}`)
    checkMatchers(line)
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    while (stdoutBuffer.includes('\n')) {
      const newlineIndex = stdoutBuffer.indexOf('\n')
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      onLine(line)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (DEBUG) console.error(`[e2e][stderr] ${chunk}`)
  })

  child.once('exit', (code) => {
    cliExited = true
    cliExitCode = code ?? 1
    for (const matcher of pendingMatchers) {
      clearTimeout(matcher.timeoutId)
      matcher.reject(new Error(`CLI exited before pattern matched: ${String(matcher.pattern)}`))
    }
    pendingMatchers.length = 0
  })

  return {
    waitFor(pattern: string | RegExp, timeoutMs = 30_000): Promise<string> {
      // Check lines already seen before this call
      for (const line of bufferedLines) {
        const matched = typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line)
        if (matched) return Promise.resolve(line)
      }

      if (cliExited) {
        return Promise.reject(
          new Error(`CLI already exited; pattern not found: ${String(pattern)}`),
        )
      }

      return new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const idx = pendingMatchers.findIndex((m) => m.timeoutId === timeoutId)
          if (idx !== -1) pendingMatchers.splice(idx, 1)
          reject(
            new Error(`Timed out after ${String(timeoutMs)}ms waiting for: ${String(pattern)}`),
          )
        }, timeoutMs)
        pendingMatchers.push({ pattern, resolve, reject, timeoutId })
      })
    },

    async done(): Promise<CliRunResult> {
      // If the child has already exited (tracked by our own exit handler), use
      // the recorded code directly rather than waiting for an event that already fired.
      const exitCode =
        cliExited && cliExitCode !== null
          ? cliExitCode
          : await waitForProcessExit(child, PROCESS_TIMEOUT_MS)

      if (stdoutBuffer.length > 0) {
        onLine(stdoutBuffer)
        stdoutBuffer = ''
      }

      const output = (stdout || stderr).trim()
      return {
        exitCode,
        payload: parseJsonPayload(output),
        stderr,
        stdout,
      }
    },
  }
}

/**
 * Like spawnCli but runs the process inside a PTY so clack prompts work.
 * Use sendKeys() to answer prompts, waitFor() to gate on rendered text.
 */
export function spawnCliInteractive(args: string[], env: NodeJS.ProcessEnv): InteractiveCliHandle {
  if (DEBUG) {
    console.error(`[e2e][spawnCliInteractive] node dist/cli.js ${args.join(' ')}`)
  }

  const pty = ptySpawn(process.execPath, ['dist/cli.js', ...args], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: env as Record<string, string>,
  })

  let cleanOutput = ''
  let lineBuffer = ''
  let cliExited = false
  let cliExitCode = 1
  const bufferedLines: string[] = []
  const pendingMatchers: PendingMatcher[] = []

  const checkMatchers = (line: string) => {
    for (let i = pendingMatchers.length - 1; i >= 0; i--) {
      const matcher = pendingMatchers[i]!
      const matched =
        typeof matcher.pattern === 'string'
          ? line.includes(matcher.pattern)
          : matcher.pattern.test(line)
      if (matched) {
        clearTimeout(matcher.timeoutId)
        pendingMatchers.splice(i, 1)
        matcher.resolve(line)
      }
    }
  }

  const onLine = (line: string) => {
    bufferedLines.push(line)
    if (DEBUG) console.error(`[e2e][pty] ${line}`)
    checkMatchers(line)
  }

  pty.onData((data) => {
    const clean = stripAnsiCodes(data)
    cleanOutput += clean
    lineBuffer += clean
    while (lineBuffer.includes('\n')) {
      const idx = lineBuffer.indexOf('\n')
      const line = lineBuffer.slice(0, idx).trimEnd()
      lineBuffer = lineBuffer.slice(idx + 1)
      if (line.trim()) onLine(line)
    }
  })

  pty.onExit(({ exitCode }) => {
    cliExited = true
    cliExitCode = exitCode
    if (lineBuffer.trim()) {
      onLine(lineBuffer.trim())
      lineBuffer = ''
    }
    for (const matcher of pendingMatchers) {
      clearTimeout(matcher.timeoutId)
      matcher.reject(new Error(`CLI exited before pattern matched: ${String(matcher.pattern)}`))
    }
    pendingMatchers.length = 0
  })

  return {
    waitFor(pattern: string | RegExp, timeoutMs = 30_000): Promise<string> {
      for (const line of bufferedLines) {
        const matched = typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line)
        if (matched) return Promise.resolve(line)
      }
      if (cliExited) {
        return Promise.reject(
          new Error(`CLI already exited; pattern not found: ${String(pattern)}`),
        )
      }
      return new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const idx = pendingMatchers.findIndex((m) => m.timeoutId === timeoutId)
          if (idx !== -1) pendingMatchers.splice(idx, 1)
          reject(
            new Error(`Timed out after ${String(timeoutMs)}ms waiting for: ${String(pattern)}`),
          )
        }, timeoutMs)
        pendingMatchers.push({ pattern, resolve, reject, timeoutId })
      })
    },

    sendKeys(keys: string): void {
      pty.write(keys)
    },

    async done(): Promise<CliRunResult> {
      if (!cliExited) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pty.kill()
            reject(new Error(`CLI timed out after ${String(PROCESS_TIMEOUT_MS)}ms`))
          }, PROCESS_TIMEOUT_MS)
          pty.onExit(() => {
            clearTimeout(timeout)
            resolve()
          })
        })
      }
      if (lineBuffer.trim()) {
        onLine(lineBuffer.trim())
        lineBuffer = ''
      }
      const output = cleanOutput.trim()
      if (DEBUG) {
        console.error(`[e2e][pty][done] exit=${String(cliExitCode)}\noutput:\n${output}`)
      }
      return {
        exitCode: cliExitCode,
        payload: parseJsonPayload(output),
        stderr: '',
        stdout: cleanOutput,
      }
    },
  }
}

/**
 * Launches a Chromium browser with a WebAuthn virtual authenticator for
 * passkey ceremony automation.
 */
export async function launchVirtualBrowser(): Promise<VirtualBrowser> {
  const browser = await chromium.launch({
    args: [
      '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
      '--disable-web-security',
    ],
    headless: BROWSER_HEADLESS,
    slowMo: BROWSER_HEADLESS ? 0 : 150,
  })

  const context = await browser.newContext()
  const page = await context.newPage()

  if (DEBUG) {
    page.on('console', (message) => {
      console.error(`[e2e][browser][${message.type()}] ${message.text()}`)
    })
    page.on('pageerror', (error) => {
      console.error(`[e2e][browser][pageerror] ${error.message}`)
    })
    page.on('requestfailed', (request) => {
      console.error(
        `[e2e][browser][requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      )
    })
  }

  const cdpSession = await context.newCDPSession(page)
  await cdpSession.send('WebAuthn.enable')
  await cdpSession.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      automaticPresenceSimulation: true,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      protocol: 'ctap2',
      transport: 'internal',
    },
  })

  return {
    page,
    close: () => context.close(),
  }
}

/**
 * Extracts the first Porto dialog URL from a stdout line, or null if none.
 */
export function extractDialogUrl(line: string): string | null {
  const matches = line.match(/https?:\/\/\S+/g) ?? []
  return matches.find((url) => url.includes('/dialog') && url.includes('relayUrl=')) ?? null
}

export function buildConfigureArgs(parameters: {
  calls?: string[] // address[:signature] entries
  chain: string // chain name or id (e.g. 'base-sepolia')
  createAccount?: boolean
  dialogHost?: string
  expiry?: string
  json?: boolean // pass --json flag (default: false, uses TOON)
  spendLimit?: string
  spendPeriod?: string
}): string[] {
  const { calls, chain, createAccount, dialogHost, expiry, json, spendLimit, spendPeriod } =
    parameters

  const args = ['configure', '--chain', chain]

  if (json) args.push('--json')
  for (const call of calls ?? []) args.push('--call', call)
  if (createAccount) args.push('--create-account')
  if (dialogHost) args.push('--dialog', dialogHost)
  if (spendLimit) args.push('--spend-limit', spendLimit)
  if (spendPeriod) args.push('--spend-period', spendPeriod)
  if (expiry) args.push('--expiry', expiry)

  return args
}

export async function ensureAccountFunding(parameters: {
  accountAddress: `0x${string}`
  chainId: number
  network: 'prod' | 'testnet'
}): Promise<void> {
  const { accountAddress, chainId, network } = parameters
  if (network !== 'testnet') return
  if (chainId !== baseSepolia.id) return

  const rpcUrl = process.env.AGENT_WALLET_RELAY_URL ?? DEFAULT_RELAY_RPC_URL
  const payload = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: Date.now(),
      jsonrpc: '2.0',
      method: 'wallet_addFaucetFunds',
      params: [
        {
          address: accountAddress,
          chainId,
          tokenAddress: BASE_SEPOLIA_EXP_TOKEN,
          value: BASE_SEPOLIA_FAUCET_VALUE,
        },
      ],
    }),
  }).then(
    (response) =>
      response.json() as Promise<{
        result?: { transactionHash?: `0x${string}` }
        error?: { message?: string }
      }>,
  )

  if (payload.error) {
    throw new Error(
      `Failed to faucet-fund e2e account: ${payload.error.message ?? 'unknown relay error'}`,
    )
  }

  const faucetTxHash = payload.result?.transactionHash
  if (!faucetTxHash) {
    throw new Error('Relay faucet response did not include a transaction hash.')
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(baseSepolia.rpcUrls.default.http[0]),
  })

  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    const receipt = await publicClient
      .getTransactionReceipt({ hash: faucetTxHash })
      .catch(() => null)
    if (receipt?.blockNumber) {
      const latest = await publicClient.getBlockNumber()
      if (latest - receipt.blockNumber + 1n >= 1n) return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error(`Timed out waiting for faucet transaction confirmation: ${faucetTxHash}`)
}

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`CLI timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code ?? 1)
    })
  })
}

function parseJsonPayload(output: string): Record<string, unknown> | unknown[] | null {
  if (!output) return null
  // incur writes pretty-printed JSON as the last block; find the last line
  // starting with { or [ and parse from there. When running in a PTY, extra
  // text (e.g. "Suggested commands:") may follow the closing brace, so also
  // try stopping at the last standalone } or ] line.
  const lines = output.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    // Only match unindented { or [ — these are top-level JSON objects/arrays.
    // Indented ones are nested and should not be parsed independently.
    if (!line.startsWith('{') && !line.startsWith('[')) continue

    // First try: parse from i to end of output
    try {
      return JSON.parse(lines.slice(i).join('\n')) as Record<string, unknown> | unknown[]
    } catch {
      // Second try: parse from i to the last standalone closer (handles PTY
      // output that appends human-readable text after the closing brace).
      const closer = line.startsWith('{') ? '}' : ']'
      for (let j = lines.length - 1; j > i; j--) {
        if (lines[j]!.trim() === closer) {
          try {
            return JSON.parse(lines.slice(i, j + 1).join('\n')) as
              | Record<string, unknown>
              | unknown[]
          } catch {
            continue
          }
        }
      }
    }
  }
  return null
}
