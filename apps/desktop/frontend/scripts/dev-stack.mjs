import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const rootDir = path.resolve(frontendDir, '..')
const backendDir = path.join(rootDir, 'backend')
const pythonParts = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
const pythonBin = [
  path.join(backendDir, 'venv', ...pythonParts),
  path.resolve(rootDir, '../../backend/venv', ...pythonParts),
].find(existsSync) || 'python3'
const viteBin = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js')

async function readLocalEnv() {
  try {
    const source = await readFile(path.join(frontendDir, '.env.local'), 'utf8')
    return Object.fromEntries(source.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match) return []
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2')
      return [[match[1], value]]
    }))
  } catch {
    return {}
  }
}

const localEnv = await readLocalEnv()
const backendBase = String(
  process.env.LEARNFLOW_BACKEND_URL
    || process.env.LEARNFLOW_FORMAL_BACKEND_URL
    || process.env.VNEXT_BACKEND_URL
    || localEnv.LEARNFLOW_BACKEND_URL
    || localEnv.VNEXT_BACKEND_URL
    || localEnv.LEARNFLOW_FORMAL_BACKEND_URL
    || 'http://127.0.0.1:8011',
).replace(/\/$/, '')
const backendUrl = new URL(backendBase)
const localBackend = ['127.0.0.1', 'localhost', '::1'].includes(backendUrl.hostname)
const backendPort = Number(backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80))

let backendProcess = null
let viteProcess = null
let shuttingDown = false

function portIsOpen(hostname, port, timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = createConnection({ host: hostname, port })
    const finish = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function backendIsHealthy(timeoutMs = 900) {
  try {
    const response = await fetch(`${backendBase}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const payload = await response.json()
    return payload?.status === 'ok'
  } catch {
    return false
  }
}

async function waitForBackend() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await backendIsHealthy()) return
    if (backendProcess?.exitCode !== null) {
      throw new Error(`正式后端提前退出（exit ${backendProcess?.exitCode ?? 'unknown'}）`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`正式后端在 20 秒内没有通过健康检查：${backendBase}/health`)
}

function stopChild(child, signal = 'SIGTERM') {
  if (child && child.exitCode === null && !child.killed) child.kill(signal)
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  process.exitCode = exitCode
  stopChild(viteProcess)
  stopChild(backendProcess)
  setTimeout(() => {
    stopChild(viteProcess, 'SIGKILL')
    stopChild(backendProcess, 'SIGKILL')
    process.exit(exitCode)
  }, 1500)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(0))
}

try {
  if (localBackend && !await backendIsHealthy()) {
    if (await portIsOpen(backendUrl.hostname, backendPort)) {
      throw new Error(
        `端口 ${backendPort} 已被占用，但 ${backendBase}/health 未返回 LearnFlow 健康状态。请先停止占用该端口的进程。`,
      )
    }
    console.log(`[LearnFlow] 启动正式后端：${backendBase}`)
    backendProcess = spawn(
      pythonBin,
      ['-m', 'uvicorn', 'app.main:app', '--host', backendUrl.hostname, '--port', String(backendPort)],
      { cwd: backendDir, env: process.env, stdio: 'inherit' },
    )
    backendProcess.once('error', error => {
      console.error(`[LearnFlow] 正式后端启动失败：${error.message}`)
      shutdown(1)
    })
    await waitForBackend()
    backendProcess.once('exit', code => {
      if (!shuttingDown) {
        console.error(`[LearnFlow] 正式后端已退出（exit ${code ?? 'unknown'}）`)
        shutdown(code || 1)
      }
    })
  } else if (localBackend) {
    console.log(`[LearnFlow] 复用已运行的正式后端：${backendBase}`)
  } else {
    console.log(`[LearnFlow] 使用外部正式后端：${backendBase}`)
  }

  console.log('[LearnFlow] 启动页面：http://127.0.0.1:4175')
  viteProcess = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', '4175', '--strictPort'],
    {
      cwd: frontendDir,
      env: { ...process.env, LEARNFLOW_BACKEND_URL: backendBase },
      stdio: 'inherit',
    },
  )
  viteProcess.once('error', error => {
    console.error(`[LearnFlow] 页面服务启动失败：${error.message}`)
    shutdown(1)
  })
  viteProcess.once('exit', code => shutdown(code ?? 1))
} catch (error) {
  console.error(`[LearnFlow] ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
}
