import chipkey from '@chipkey/cli'
import { bytesToHex, hexToBytes, normalizeHex } from '../lib/encoding.js'
import { AppError } from '../lib/errors.js'
import { runCommand } from '../lib/exec.js'
import type { InitKeyOptions, SignHashMode, SignerBackend } from './types.js'

type ChipkeyResponse = {
  ok: boolean
  [key: string]: unknown
}

function resolveChipkeyBinary(): string {
  return process.env.CHIPKEY_BINARY ?? chipkey.resolveBinary()
}

function parseResponse(stdout: string): ChipkeyResponse {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'chipkey returned no output.')
  }

  try {
    return JSON.parse(trimmed) as ChipkeyResponse
  } catch {
    throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'chipkey returned invalid JSON.', {
      output: trimmed,
    })
  }
}

function assertOk(response: ChipkeyResponse) {
  if (response.ok) return

  const errorPayload = response.error as { code?: string; message?: string } | undefined
  throw new AppError(
    errorPayload?.code ?? 'SIGNER_BACKEND_ERROR',
    errorPayload?.message ?? 'chipkey command failed.',
    response,
  )
}

export class ChipkeyBackend implements SignerBackend {
  readonly name = 'chipkey'

  private async run(...args: string[]): Promise<ChipkeyResponse> {
    const binary = resolveChipkeyBinary()
    try {
      const { stdout } = await runCommand(binary, args)
      const response = parseResponse(stdout)
      assertOk(response)
      return response
    } catch (error) {
      if (error instanceof AppError && error.code === 'COMMAND_EXECUTION_FAILED') {
        const stdout = String(error.details?.stdout ?? '')
        if (stdout.trim()) {
          const response = parseResponse(stdout)
          assertOk(response)
          return response
        }
      }
      throw error
    }
  }

  async create(keyId: string, _options: InitKeyOptions) {
    const response = await this.run('create', '--key-id', keyId)

    const publicKey = normalizeHex(String(response.publicKey ?? '')) as `0x${string}`
    if (!/^0x[0-9a-f]+$/i.test(publicKey)) {
      throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'chipkey returned an invalid public key.')
    }

    return { publicKey }
  }

  async getPublicKey(keyId: string) {
    const response = await this.run('create', '--key-id', keyId)
    const publicKey = normalizeHex(String(response.publicKey ?? '')) as `0x${string}`

    if (!/^0x[0-9a-f]+$/i.test(publicKey)) {
      throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'chipkey returned an invalid public key.')
    }

    return publicKey
  }

  async sign(keyId: string, payload: Uint8Array, hash: SignHashMode) {
    const response = await this.run(
      'sign',
      '--key-id',
      keyId,
      '--payload-hex',
      bytesToHex(payload),
      '--hash',
      hash,
    )

    const signature = normalizeHex(String(response.signature ?? ''))
    return hexToBytes(signature)
  }

  async info(keyId: string) {
    const response = await this.run('info', '--key-id', keyId)
    return { exists: Boolean(response.exists) }
  }
}
