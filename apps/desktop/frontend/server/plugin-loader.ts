import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LearnFlowPluginRegistry, type LearnFlowPluginServerPackage } from '../src/plugin-api.ts'

type PluginModule = {
  default?: LearnFlowPluginServerPackage
  plugin?: LearnFlowPluginServerPackage
}

async function existingServerEntry(directory: string) {
  for (const filename of ['server.ts', 'server.js', 'server.mjs']) {
    const candidate = resolve(directory, filename)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // A plugin may intentionally omit its server contribution.
    }
  }
  return undefined
}

async function packageFingerprint(directory: string) {
  const records: string[] = []
  async function visit(current: string) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const metadata = await stat(path)
        records.push(`${relative(directory, path)}:${metadata.size}:${metadata.mtimeMs}`)
      }
    }
  }
  await visit(directory)
  return createHash('sha256').update(records.join('\n')).digest('hex').slice(0, 20)
}

export async function loadLearnFlowPluginRegistry(root = resolve(process.cwd(), 'plugins')) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === 'ENOENT') return new LearnFlowPluginRegistry([])
    throw error
  }
  const packages: LearnFlowPluginServerPackage[] = []
  for (const entry of entries.filter(item => item.isDirectory() && !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    const packageDirectory = resolve(root, entry.name)
    const serverEntry = await existingServerEntry(packageDirectory)
    if (!serverEntry) continue
    const loaded = await import(`${pathToFileURL(serverEntry).href}?v=${await packageFingerprint(packageDirectory)}`) as PluginModule
    const plugin = loaded.default || loaded.plugin
    if (!plugin) throw new Error(`plugin_contract_invalid:${entry.name} does not export default or plugin`)
    packages.push(plugin)
  }
  return new LearnFlowPluginRegistry(packages)
}

export function createLearnFlowPluginRegistryProvider(options: {
  root?: string
  reload?: boolean
  load?: typeof loadLearnFlowPluginRegistry
} = {}) {
  const load = options.load || loadLearnFlowPluginRegistry
  let cached: Promise<LearnFlowPluginRegistry> | undefined
  return {
    get() {
      if (options.reload) return load(options.root)
      cached ||= load(options.root)
      return cached
    },
  }
}
