import { describe, expect, it, onTestFinished } from 'vitest'

import {
  buildConfigureArgs,
  ensureAccountFunding,
  extractDialogUrl,
  getLiveNetwork,
  launchVirtualBrowser,
  makeIsolatedEnv,
  readAgentWalletConfig,
  runCli,
  spawnCli,
} from './helpers.js'

const FLOW_TIMEOUT_MS = 10 * 60 * 1_000
const DIALOG_URL_PATTERN = /https?:\/\/\S+\/dialog\S*relayUrl=/
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

describe('e2e flow', () => {
  it(
    'configure → sign → status → idempotent rerun → regrant → second chain',
    async () => {
      const env = await makeIsolatedEnv()
      const network = getLiveNetwork()
      const allowlistTo = (process.env.AGENT_WALLET_E2E_ALLOWLIST_TO ?? DEAD_ADDRESS) as `0x${string}`
      const dialogHost = process.env.AGENT_WALLET_E2E_DIALOG_HOST

      const browser = await launchVirtualBrowser()
      onTestFinished(() => browser.close())
      const { page } = browser

      // ── Configure: create account + grant permissions ───────────────────────

      const configure = spawnCli(
        buildConfigureArgs({ calls: [allowlistTo], chain: 'base-sepolia', createAccount: true, dialogHost, json: true, spendLimit: '0.01', spendPeriod: 'day', expiry: '7' }),
        env.env,
      )

      const configureDialogLine = await configure.waitFor(DIALOG_URL_PATTERN, 60_000)
      await page.goto(extractDialogUrl(configureDialogLine)!, { waitUntil: 'domcontentloaded' })

      // wallet_connect(createAccount + grantPermissions): sign-up triggers the passkey ceremony
      // and approves the permission grant in one step; WebAuthn virtual authenticator auto-responds.
      await page.getByTestId('sign-up').click()

      const configureResult = await configure.done()
      expect(
        configureResult.exitCode,
        `configure failed:\nstdout: ${configureResult.stdout}\nstderr: ${configureResult.stderr}`,
      ).toBe(0)
      expect(configureResult.payload).toMatchInlineSnapshot({
        account: { address: expect.any(String) },
        checkpoints: [
          { details: { keyId: expect.any(String) } },
          { details: { address: expect.any(String), permissionId: expect.any(String) } },
        ],
      }, `
        {
          "account": {
            "address": Any<String>,
            "chainId": 84532,
          },
          "checkpoints": [
            {
              "checkpoint": "agent_key",
              "details": {
                "backend": "chipkey",
                "keyId": Any<String>,
              },
              "status": "created",
            },
            {
              "checkpoint": "account",
              "details": {
                "address": Any<String>,
                "chainId": 84532,
                "permissionId": Any<String>,
              },
              "status": "created",
            },
          ],
          "command": "configure",
          "cta": {
            "commands": [
              {
                "command": "openawa status",
                "description": "Inspect the new account",
              },
              {
                "command": "openawa sign",
                "description": "Submit your first transaction",
              },
            ],
            "description": "Suggested commands:",
          },
          "poweredBy": "Porto",
          "setupMode": "local-admin",
        }
      `)

      // ── Get account details ───────────────────────────────────────────────

      const statusCheck = await runCli(['status', '--json'], env.env)
      expect(statusCheck.exitCode).toBe(0)
      const account = (statusCheck.payload as Record<string, unknown>)?.account as { address: `0x${string}` }
      const accountAddress = account.address
      // After configure, precall is stored locally. The permission may already be
      // on-chain (createAccount submits a tx) or still precall-pending.
      expect(statusCheck.payload).toMatchInlineSnapshot({
        account: { address: expect.any(String) },
        activation: { state: expect.any(String) },
        chains: {
          '84532': {
            balance: { formatted: expect.any(String) },
            permissions: {
              active: expect.any(Number),
              latestExpiry: expect.toSatisfy((v) => v === null || typeof v === 'string'),
              total: expect.any(Number),
            },
          },
        },
        precallPermissions: [{ expiry: expect.any(String), id: expect.any(String) }],
        signer: { keyId: expect.any(String) },
      }, `
        {
          "account": {
            "address": Any<String>,
          },
          "activation": {
            "state": Any<String>,
          },
          "chains": {
            "84532": {
              "balance": {
                "formatted": Any<String>,
                "symbol": "ETH",
              },
              "chainName": "Base Sepolia",
              "permissions": {
                "active": Any<Number>,
                "latestExpiry": toSatisfy<[Function anonymous]>,
                "total": Any<Number>,
              },
              "warnings": [],
            },
          },
          "command": "status",
          "poweredBy": "Porto",
          "precallPermissions": [
            {
              "chainId": 84532,
              "expiry": Any<String>,
              "id": Any<String>,
            },
          ],
          "signer": {
            "backend": "chipkey",
            "curve": "p256",
            "exists": true,
            "keyId": Any<String>,
          },
          "warnings": [],
        }
      `)

      // ── Fund account for signing tests (testnet only) ─────────────────────

      await ensureAccountFunding({ accountAddress, chainId: 84532, network })

      // ── Sign an allowed call ──────────────────────────────────────────────

      const allowedResult = await runCli(
        ['sign', '--json', '--calls', JSON.stringify([{ data: '0x', to: allowlistTo, value: '0x0' }])],
        env.env,
        180_000,
      )
      expect(
        allowedResult.exitCode,
        `allowed sign failed:\nstdout: ${allowedResult.stdout}\nstderr: ${allowedResult.stderr}`,
      ).toBe(0)
      expect(allowedResult.payload).toMatchInlineSnapshot([
        {},
        {},
        {},
        {},
        { bundleId: expect.any(String), txHash: expect.any(String) },
      ], `
        [
          {
            "stage": "prepare_calls",
          },
          {
            "stage": "sign_digest",
          },
          {
            "stage": "send_prepared",
          },
          {
            "stage": "await_settlement",
          },
          {
            "bundleId": Any<String>,
            "command": "sign",
            "poweredBy": "Porto",
            "status": "success",
            "txHash": Any<String>,
          },
        ]
      `)

      // ── Reject a disallowed call ──────────────────────────────────────────

      const disallowedTo = allowlistTo.toLowerCase() === ZERO_ADDRESS ? DEAD_ADDRESS : ZERO_ADDRESS
      const disallowedResult = await runCli(
        ['sign', '--json', '--calls', JSON.stringify([{ data: '0x', to: disallowedTo, value: '0x0' }])],
        env.env,
      )
      expect(disallowedResult.exitCode).not.toBe(0)
      expect(disallowedResult.payload).toMatchInlineSnapshot({
        message: expect.stringContaining('UnauthorizedCall'),
      }, `
        {
          "code": "PORTO_SEND_PREPARE_FAILED",
          "message": StringContaining "UnauthorizedCall",
        }
      `)

      // ── Status: verify full state in json and toon modes ──────────────────

      const jsonStatus = await runCli(['status', '--json'], env.env)
      expect(jsonStatus.exitCode).toBe(0)
      const statusAccount = (jsonStatus.payload as Record<string, unknown>)?.account as { address: string }
      expect(statusAccount?.address?.toLowerCase()).toBe(accountAddress.toLowerCase())
      expect(jsonStatus.payload).toMatchInlineSnapshot({
        account: { address: expect.any(String) },
        activation: { state: expect.any(String) },
        chains: {
          '84532': {
            balance: { formatted: expect.any(String) },
            permissions: {
              active: expect.any(Number),
              latestExpiry: expect.toSatisfy((v) => v === null || typeof v === 'string'),
              total: expect.any(Number),
            },
          },
        },
        signer: { keyId: expect.any(String) },
      }, `
        {
          "account": {
            "address": Any<String>,
          },
          "activation": {
            "state": Any<String>,
          },
          "chains": {
            "84532": {
              "balance": {
                "formatted": Any<String>,
                "symbol": "ETH",
              },
              "chainName": "Base Sepolia",
              "permissions": {
                "active": Any<Number>,
                "latestExpiry": toSatisfy<[Function anonymous]>,
                "total": Any<Number>,
              },
              "warnings": [],
            },
          },
          "command": "status",
          "poweredBy": "Porto",
          "precallPermissions": [],
          "signer": {
            "backend": "chipkey",
            "curve": "p256",
            "exists": true,
            "keyId": Any<String>,
          },
          "warnings": [],
        }
      `)

      // ── Rerun configure: verify idempotency ───────────────────────────────

      const rerun = spawnCli(
        buildConfigureArgs({ calls: [allowlistTo], chain: 'base-sepolia', dialogHost, json: true, spendLimit: '0.01', spendPeriod: 'day', expiry: '7' }),
        env.env,
      )

      // A dialog may or may not appear on rerun depending on permission state
      const rerunDialogLine = await rerun.waitFor(DIALOG_URL_PATTERN, 15_000).catch(() => null)
      if (rerunDialogLine) {
        await page.goto(extractDialogUrl(rerunDialogLine)!, { waitUntil: 'domcontentloaded' })
        // wallet_connect(selectAccount + grantPermissions): one click handles sign-in and permission grant.
        await page.getByTestId('sign-in').click()
      }

      const rerunResult = await rerun.done()
      expect(rerunResult.exitCode).toBe(0)
      expect(rerunResult.payload).toMatchObject({ command: 'configure' })

      const checkpoints = parseCheckpoints(rerunResult.payload)
      expect(checkpoints.get('agent_key')).toBe('already_ok')
      expect(checkpoints.get('account')).toBe('already_ok')

      // ── Verify persisted config after idempotent rerun ────────────────────

      const config = await readAgentWalletConfig(env.configHome)
      expect(config.porto?.address?.toLowerCase()).toBe(accountAddress.toLowerCase())
      expect(config).toMatchInlineSnapshot({
        porto: { address: expect.any(String) },
        signer: { keyId: expect.any(String) },
      }, `
        {
          "porto": {
            "address": Any<String>,
            "chainIds": [
              84532,
            ],
            "dialogHost": "id.porto.sh",
            "precallPermissions": [],
          },
          "signer": {
            "backend": "chipkey",
            "keyId": Any<String>,
          },
          "version": 1,
        }
      `)

      // ── Regrant: force grant path by changing spend limit ─────────────────

      const regrant = spawnCli(
        buildConfigureArgs({ calls: [allowlistTo], chain: 'base-sepolia', dialogHost, json: true, spendLimit: '0.02', spendPeriod: 'day', expiry: '7' }),
        env.env,
      )

      const regrantDialogLine = await regrant.waitFor(DIALOG_URL_PATTERN, 30_000)
      await page.goto(extractDialogUrl(regrantDialogLine)!, { waitUntil: 'domcontentloaded' })
      await page.getByTestId('sign-in').click()

      const regrantResult = await regrant.done()
      expect(
        regrantResult.exitCode,
        `regrant failed:\nstdout: ${regrantResult.stdout}\nstderr: ${regrantResult.stderr}`,
      ).toBe(0)

      const regrantCheckpoints = parseCheckpoints(regrantResult.payload)
      expect(regrantCheckpoints.get('agent_key')).toBe('already_ok')
      expect(regrantCheckpoints.get('account')).toBe('updated')

      // ── Verify persisted config after regrant ─────────────────────────────

      const configAfterRegrant = await readAgentWalletConfig(env.configHome)
      expect(configAfterRegrant.porto?.address?.toLowerCase()).toBe(accountAddress.toLowerCase())
      expect(configAfterRegrant).toMatchInlineSnapshot({
        porto: {
          address: expect.any(String),
          precallPermissions: [{
            address: expect.any(String),
            expiry: expect.any(Number),
            id: expect.any(String),
            key: { publicKey: expect.any(String) },
          }],
        },
        signer: { keyId: expect.any(String) },
      }, `
        {
          "porto": {
            "address": Any<String>,
            "chainIds": [
              84532,
            ],
            "dialogHost": "id.porto.sh",
            "precallPermissions": [
              {
                "address": Any<String>,
                "chainId": 84532,
                "expiry": Any<Number>,
                "id": Any<String>,
                "key": {
                  "publicKey": Any<String>,
                  "type": "p256",
                },
                "permissions": {
                  "calls": [
                    {
                      "to": "0x000000000000000000000000000000000000dEaD",
                    },
                  ],
                  "spend": [
                    {
                      "limit": "25000000000000000000",
                      "period": "day",
                      "token": "0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e",
                    },
                    {
                      "limit": "20000000000000000",
                      "period": "day",
                      "token": null,
                    },
                  ],
                },
              },
            ],
          },
          "signer": {
            "backend": "chipkey",
            "keyId": Any<String>,
          },
          "version": 1,
        }
      `)

      // ── Second chain: configure OP Sepolia ────────────────────────────────

      const secondChain = spawnCli(
        buildConfigureArgs({ chain: 'op-sepolia', dialogHost, json: true, spendLimit: '0.01', spendPeriod: 'day', expiry: '7' }),
        env.env,
      )

      const secondChainDialogLine = await secondChain.waitFor(DIALOG_URL_PATTERN, 30_000)
      await page.goto(extractDialogUrl(secondChainDialogLine)!, { waitUntil: 'domcontentloaded' })
      await page.getByTestId('sign-in').click()

      const secondChainResult = await secondChain.done()
      expect(
        secondChainResult.exitCode,
        `second chain configure failed:\nstdout: ${secondChainResult.stdout}\nstderr: ${secondChainResult.stderr}`,
      ).toBe(0)

      const secondChainCheckpoints = parseCheckpoints(secondChainResult.payload)
      expect(secondChainCheckpoints.get('agent_key')).toBe('already_ok')
      expect(secondChainCheckpoints.get('account')).toMatch(/^(created|updated)$/)

      // ── Status shows both chains ──────────────────────────────────────────

      const multiChainStatus = await runCli(['status', '--json'], env.env)
      expect(multiChainStatus.exitCode).toBe(0)
      expect(multiChainStatus.payload).toMatchInlineSnapshot({
        account: { address: expect.any(String) },
        activation: { state: expect.any(String) },
        chains: {
          '11155420': {
            balance: { formatted: expect.any(String) },
            permissions: {
              active: expect.any(Number),
              latestExpiry: expect.toSatisfy((v) => v === null || typeof v === 'string'),
              total: expect.any(Number),
            },
          },
          '84532': {
            balance: { formatted: expect.any(String) },
            permissions: {
              active: expect.any(Number),
              latestExpiry: expect.toSatisfy((v) => v === null || typeof v === 'string'),
              total: expect.any(Number),
            },
          },
        },
        precallPermissions: [
          { expiry: expect.any(String), id: expect.any(String) },
          { expiry: expect.any(String), id: expect.any(String) },
        ],
        signer: { keyId: expect.any(String) },
      }, `
        {
          "account": {
            "address": Any<String>,
          },
          "activation": {
            "state": Any<String>,
          },
          "chains": {
            "11155420": {
              "balance": {
                "formatted": Any<String>,
                "symbol": "ETH",
              },
              "chainName": "OP Sepolia",
              "permissions": {
                "active": Any<Number>,
                "latestExpiry": toSatisfy<[Function anonymous]>,
                "total": Any<Number>,
              },
              "warnings": [],
            },
            "84532": {
              "balance": {
                "formatted": Any<String>,
                "symbol": "ETH",
              },
              "chainName": "Base Sepolia",
              "permissions": {
                "active": Any<Number>,
                "latestExpiry": toSatisfy<[Function anonymous]>,
                "total": Any<Number>,
              },
              "warnings": [],
            },
          },
          "command": "status",
          "poweredBy": "Porto",
          "precallPermissions": [
            {
              "chainId": 84532,
              "expiry": Any<String>,
              "id": Any<String>,
            },
            {
              "chainId": 11155420,
              "expiry": Any<String>,
              "id": Any<String>,
            },
          ],
          "signer": {
            "backend": "chipkey",
            "curve": "p256",
            "exists": true,
            "keyId": Any<String>,
          },
          "warnings": [],
        }
      `)

      // ── Verify persisted config after second chain ─────────────────────────

      const configAfterSecondChain = await readAgentWalletConfig(env.configHome)
      expect(configAfterSecondChain.porto?.address?.toLowerCase()).toBe(accountAddress.toLowerCase())
      expect(configAfterSecondChain).toMatchInlineSnapshot({
        porto: {
          address: expect.any(String),
          precallPermissions: [
            {
              address: expect.any(String),
              expiry: expect.any(Number),
              id: expect.any(String),
              key: { publicKey: expect.any(String) },
            },
            {
              address: expect.any(String),
              expiry: expect.any(Number),
              id: expect.any(String),
              key: { publicKey: expect.any(String) },
            },
          ],
        },
        signer: { keyId: expect.any(String) },
      }, `
        {
          "porto": {
            "address": Any<String>,
            "chainIds": [
              84532,
              11155420,
            ],
            "dialogHost": "id.porto.sh",
            "precallPermissions": [
              {
                "address": Any<String>,
                "chainId": 84532,
                "expiry": Any<Number>,
                "id": Any<String>,
                "key": {
                  "publicKey": Any<String>,
                  "type": "p256",
                },
                "permissions": {
                  "calls": [
                    {
                      "to": "0x000000000000000000000000000000000000dEaD",
                    },
                  ],
                  "spend": [
                    {
                      "limit": "25000000000000000000",
                      "period": "day",
                      "token": "0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e",
                    },
                    {
                      "limit": "20000000000000000",
                      "period": "day",
                      "token": null,
                    },
                  ],
                },
              },
              {
                "address": Any<String>,
                "chainId": 11155420,
                "expiry": Any<Number>,
                "id": Any<String>,
                "key": {
                  "publicKey": Any<String>,
                  "type": "p256",
                },
                "permissions": {
                  "calls": [
                    {
                      "signature": "0x32323232",
                      "to": "0x3232323232323232323232323232323232323232",
                    },
                  ],
                  "spend": [
                    {
                      "limit": "20000000000000000",
                      "period": "day",
                      "token": null,
                    },
                  ],
                },
              },
            ],
          },
          "signer": {
            "backend": "chipkey",
            "keyId": Any<String>,
          },
          "version": 1,
        }
      `)

      // ── Sign without --chain fails with AMBIGUOUS_CHAIN ───────────────────

      const ambiguousSign = await runCli(
        ['sign', '--json', '--calls', JSON.stringify([{ data: '0x', to: allowlistTo, value: '0x0' }])],
        env.env,
      )
      expect(ambiguousSign.exitCode).not.toBe(0)
      expect(ambiguousSign.payload).toMatchInlineSnapshot({
        message: expect.stringContaining('chain'),
      }, `
        {
          "code": "AMBIGUOUS_CHAIN",
          "message": StringContaining "chain",
        }
      `)
    },
    FLOW_TIMEOUT_MS,
  )
})

function parseCheckpoints(payload: Record<string, unknown> | unknown[] | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!payload || Array.isArray(payload)) return map
  const checkpoints = payload.checkpoints
  if (!Array.isArray(checkpoints)) return map
  for (const cp of checkpoints) {
    if (cp && typeof cp === 'object' && 'checkpoint' in cp && 'status' in cp) {
      map.set(String(cp.checkpoint), String(cp.status))
    }
  }
  return map
}
