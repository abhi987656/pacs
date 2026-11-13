// Runs a command with PACS_EDITION set (works the same in cmd, PowerShell and bash):
//   node scripts/edition.mjs master npm run build
import { spawnSync } from 'node:child_process'

const [edition, cmd, ...args] = process.argv.slice(2)
if (!['master', 'user'].includes(edition) || !cmd) {
  console.error('usage: node scripts/edition.mjs <master|user> <command> [args…]')
  process.exit(2)
}
const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, PACS_EDITION: edition } })
process.exit(r.status ?? 1)
