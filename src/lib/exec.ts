import { spawn } from 'node:child_process'
import { AppError } from './errors.js'

export async function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => {
      reject(
        new AppError('COMMAND_EXECUTION_FAILED', error.message, {
          command,
          args,
        }),
      )
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(
        new AppError('COMMAND_EXECUTION_FAILED', `${command} exited with code ${code}`, {
          command,
          args,
          stderr: stderr.trim() || undefined,
          stdout: stdout.trim() || undefined,
        }),
      )
    })
  })
}
