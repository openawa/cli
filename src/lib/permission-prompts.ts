import * as p from '@clack/prompts'
import { parseEther } from 'viem'
import type { Chain } from 'viem'
import { Chains } from 'porto'
import type { PermissionPolicy, SpendPeriod } from '../porto/service.js'

const SPEND_PERIODS = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const

export async function promptPermissionPolicy(opts: {
  chain: Chain
  prefill?: {
    calls?: PermissionPolicy['calls']
    spendLimit?: string
    spendPeriod?: SpendPeriod
    spendToken?: string
    feeLimit?: string
    expiryDays?: number
  }
}): Promise<PermissionPolicy> {
  // ── Allowed calls ──────────────────────────────────────────────────
  p.note('Which contracts may the agent call?', 'Allowed calls')
  const anyTarget = await p.confirm({
    message: 'Allow calls to any contract?',
    initialValue: opts.prefill?.calls == null,
  })
  if (p.isCancel(anyTarget)) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  let calls: PermissionPolicy['calls'] = null
  if (!anyTarget) {
    calls = []
    let addMore = true
    while (addMore) {
      const to = await p.text({
        message: 'Contract address (0x...):',
        validate: (v) =>
          /^0x[0-9a-fA-F]{40}$/.test(v ?? '') ? undefined : 'Must be a valid 0x address',
      })
      if (p.isCancel(to)) {
        p.cancel('Cancelled')
        process.exit(0)
      }

      const sig = await p.text({
        message: 'Function signature (leave blank for any):',
        placeholder: 'transfer(address,uint256)',
      })
      if (p.isCancel(sig)) {
        p.cancel('Cancelled')
        process.exit(0)
      }

      calls.push({ to: to as `0x${string}`, ...(sig ? { signature: sig as `0x${string}` } : {}) })

      const more = await p.confirm({ message: 'Add another allowed call?', initialValue: false })
      if (p.isCancel(more)) {
        p.cancel('Cancelled')
        process.exit(0)
      }
      addMore = Boolean(more)
    }
  }

  // ── Spend limits ────────────────────────────────────────────────────
  const spendPeriod = await p.select({
    message: 'Spend limit period:',
    initialValue: opts.prefill?.spendPeriod ?? 'day',
    options: SPEND_PERIODS.map((period) => ({ value: period, label: period })),
  })
  if (p.isCancel(spendPeriod)) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  const spendTokenStr = await p.text({
    message: 'Spend token address (leave blank for native ETH):',
    placeholder: '0x...',
    initialValue: opts.prefill?.spendToken ?? '',
    validate: (v) => {
      if (!v) return undefined
      return /^0x[0-9a-fA-F]{40}$/.test(v)
        ? undefined
        : 'Must be a valid 0x address or blank for native'
    },
  })
  if (p.isCancel(spendTokenStr)) {
    p.cancel('Cancelled')
    process.exit(0)
  }
  const spendToken = spendTokenStr ? (spendTokenStr as `0x${string}`) : undefined

  const spendUnit = spendToken ? 'tokens' : 'ETH'
  const spendAmount = await p.text({
    message: `Spend limit in ${spendUnit} per ${String(spendPeriod)}:`,
    placeholder: '0.01',
    initialValue: opts.prefill?.spendLimit ?? '0.01',
    validate: (v) => {
      try {
        parseEther(v as `${number}`)
        return undefined
      } catch {
        return `Must be a valid amount (e.g. 0.01)`
      }
    },
  })
  if (p.isCancel(spendAmount)) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  // Porto testnets use EXP as the fee token (same address across chains); others use native currency
  const usesExpFee =
    opts.chain.id === Chains.baseSepolia.id || opts.chain.id === Chains.optimismSepolia.id
  const feeUnit = usesExpFee ? 'EXP' : opts.chain.nativeCurrency.symbol
  const defaultFeeLimit = usesExpFee ? '25' : '0.01'
  const feeLimit = await p.text({
    message: `Fee cap per period (${feeUnit}):`,
    placeholder: defaultFeeLimit,
    initialValue: opts.prefill?.feeLimit ?? defaultFeeLimit,
    validate: (v) => (isNaN(Number(v)) ? `Must be a valid ${feeUnit} amount` : undefined),
  })
  if (p.isCancel(feeLimit)) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  // ── Expiry ──────────────────────────────────────────────────────────
  const expiryDaysStr = await p.text({
    message: 'Valid for how many days?',
    placeholder: '7',
    initialValue: opts.prefill?.expiryDays != null ? String(opts.prefill.expiryDays) : '7',
    validate: (v) => {
      const n = parseInt(v ?? '', 10)
      return isNaN(n) || n < 1 ? 'Must be a positive integer' : undefined
    },
  })
  if (p.isCancel(expiryDaysStr)) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  const spendLimitWei = parseEther(spendAmount as `${number}`)
  const expiryDays = parseInt(expiryDaysStr as string, 10)

  // ── Summary ──────────────────────────────────────────────────────────
  const callsLine =
    calls == null
      ? 'any'
      : calls.map((c) => `${c.to}${c.signature ? ` — ${c.signature}` : ''}`).join('\n  • ')
  p.note(
    [
      `Allowed calls:  ${calls == null ? callsLine : `\n  • ${callsLine}`}`,
      `Spend limit:    ${String(spendAmount)} ${spendUnit} per ${String(spendPeriod)}${spendToken ? ` (token: ${spendToken})` : ''}`,
      `Fee cap/period: ${String(feeLimit)} ${feeUnit}`,
      `Expires:        ${String(expiryDays)} days`,
    ].join('\n'),
    'Summary',
  )

  const confirmed = await p.confirm({ message: 'Grant these permissions?', initialValue: true })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  return {
    calls,
    spendLimitWei,
    spendPeriod: spendPeriod as SpendPeriod,
    ...(spendToken ? { spendToken } : {}),
    feeLimit: feeLimit as `${number}`,
    expiryDays,
  }
}
