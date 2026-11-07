import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The data folder holds the database and the DICOM archive. Its location is stored in
// <userData>/config.json so it can be moved (e.g. to a bigger D: drive).
// It deliberately defaults to LOCALAPPDATA (not Documents) so that OneDrive does not
// upload patient images to the cloud.

interface AppConfig {
  dataDir?: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function readConfig(): AppConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as AppConfig
  } catch {
    return {}
  }
}

export function defaultDataDir(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'PersonalPACS', 'Data')
  }
  return join(app.getPath('userData'), 'Data')
}

export function resolveDataDir(): string {
  if (process.env.PACS_DATA_DIR) return process.env.PACS_DATA_DIR
  return readConfig().dataDir || defaultDataDir()
}

export function saveDataDir(dir: string): void {
  const cfg = readConfig()
  cfg.dataDir = dir
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

export interface DataPaths {
  dataDir: string
  archiveDir: string
  dbPath: string
  tmpDir: string
}

export function ensureDataPaths(): DataPaths {
  const dataDir = resolveDataDir()
  const archiveDir = join(dataDir, 'archive')
  const tmpDir = join(dataDir, 'tmp')
  for (const d of [dataDir, archiveDir, tmpDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  return { dataDir, archiveDir, dbPath: join(dataDir, 'pacs.db'), tmpDir }
}
