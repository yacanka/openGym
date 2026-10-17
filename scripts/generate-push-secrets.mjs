import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const [origin, subject] = process.argv.slice(2)
if (
  !origin ||
  new URL(origin).origin !== origin ||
  !/^https?:\/\//.test(origin) ||
  !subject ||
  !/^(mailto:|https:\/\/)/.test(subject)
) {
  throw new Error(
    'Usage: node scripts/generate-push-secrets.mjs <app-origin> <mailto:contact-address>'
  )
}
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const jwk = privateKey.export({ format: 'jwk' })
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url')
]).toString('base64url')
const destination = fileURLToPath(new URL('../supabase/.env.local', import.meta.url))
await writeFile(
  destination,
  [
    `APP_ORIGINS=${origin}`,
    `VAPID_SUBJECT=${subject}`,
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${jwk.d}`,
    `DISPATCH_SECRET=${randomBytes(32).toString('hex')}`,
    ''
  ].join('\n'),
  { mode: 0o600, flag: 'wx' }
)
console.log(
  'Created supabase/.env.local with owner-only permissions. Existing files are never overwritten; values are not printed.'
)
