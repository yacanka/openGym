import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const exec = promisify(execFile)
const db = process.env.OPENGYM_TEST_DATABASE
if (!db || !/^opengym_test_[a-zA-Z0-9_]+$/.test(db))
  throw new Error(
    'Set OPENGYM_TEST_DATABASE to an EMPTY isolated opengym_test_* database. Connection uses standard PG* environment variables.'
  )
const sql = async (command) =>
  (
    await exec('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', command], {
      maxBuffer: 1024 * 1024
    })
  ).stdout
const file = async (filename) =>
  exec('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', filename], {
    maxBuffer: 1024 * 1024
  })
if ((await sql("select to_regclass('public.profiles') is null")).trim() !== 't')
  throw new Error('Test database must be empty; existing application data will not be modified.')
await file('supabase/tests/bootstrap.sql')
for (const name of [
  '20261017220828_core.sql',
  '20261017220932_operations.sql',
  '20261017220942_notifications.sql',
  '20261017221419_invite_foreign_key_indexes.sql'
])
  await file('supabase/migrations/' + name)
await file('supabase/tests/cron-fixture.sql')
// Execute the production scheduler body with local extension boundaries.
const temporary = await mkdtemp(path.join(tmpdir(), 'opengym-cron-test-'))
try {
  const migration = await readFile('supabase/migrations/20261017220953_cron.sql', 'utf8')
  const filename = path.join(temporary, 'cron.sql')
  await writeFile(filename, migration.split('\n').filter(line => !line.startsWith('create extension')).join('\n'))
  await file(filename)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
await file('supabase/migrations/20261018000603_admin_notifications.sql')
for (const name of ['core.sql', 'notifications.sql', 'admin.sql', 'admin-notifications.sql'])
  await file('supabase/tests/' + name)
console.log('Core, notification, admin, admission and reminder SQL tests passed.')

// Exercise actual concurrent PostgreSQL sessions, not a mock of transaction semantics.
const users = [randomUUID(), randomUUID()],
  sessions = [randomUUID(), randomUUID()],
  code = randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(),
  campaign = randomUUID()
for (let i = 0; i < 2; i++)
  await sql(
    `insert into auth.users(id,email,email_confirmed_at)values('${users[i]}','fixture-${i}@example.test',now());insert into auth.sessions(id,user_id)values('${sessions[i]}','${users[i]}');`
  )
const asUser = (i, query) =>
  `begin;set local role authenticated;select set_config('request.jwt.claims','${JSON.stringify({
    sub: users[i],
    session_id: sessions[i]
  })}',true);create temporary table result as ${query};select pg_sleep(0.1);commit;select * from result;`
try {
  const writes = await Promise.all(
    [0, 1].map(() =>
      sql(asUser(0, `select public.save_user_state('{"workouts":[]}',0,'${randomUUID()}')`))
    )
  )
  const results = writes.flatMap((value) =>
    value
      .split('\n')
      .filter((line) => line.includes('"status"'))
      .map((line) => JSON.parse(line))
  )
  assert.deepEqual(results.map((value) => value.status).sort(), ['conflict', 'saved'])
  assert.equal(
    (await sql(`select version from public.user_states where user_id='${users[0]}'`)).trim(),
    '1'
  )
  await sql(
    `update private.accounts set admitted=false where user_id in('${users[0]}','${users[1]}');insert into private.invites(code)values('${code}')`
  )
  const redemptions = await Promise.allSettled(
    [0, 1].map((i) => sql(asUser(i, `select public.redeem_invite('${code}')`)))
  )
  assert.equal(redemptions.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(redemptions.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(
    (
      await sql(
        `select count(*) from private.accounts where user_id in('${users[0]}','${users[1]}') and admitted`
      )
    ).trim(),
    '1'
  )
  console.log('Concurrent first writes and single-use invitation tests passed.')
  await sql(`update private.accounts set role='admin',admitted=true where user_id='${users[0]}';
    insert into private.push_subscriptions(endpoint,user_id,keys,session_id) values('https://fcm.googleapis.com/concurrency-fixture','${users[0]}','{"p256dh":"test-public","auth":"test-auth"}','${sessions[0]}')`)
  await Promise.all([0,1].map(() => sql(asUser(0,
    `select public.admin_create_notification('Concurrent test','Body','user','${users[0]}',null,'${campaign}')`))))
  assert.equal((await sql(`select count(*) from private.notification_jobs where campaign_id='${campaign}'`)).trim(),'1')
  await Promise.all([0,1].map(() => sql(asUser(0, `select public.admin_cancel_notification('${campaign}')`))))
  assert.equal((await sql(`select status from private.notification_jobs where campaign_id='${campaign}'`)).trim(),'cancelled')
  console.log('Concurrent admin submission and cancellation tests passed.')
} finally {
  await sql(
    `delete from private.admin_notifications where id='${campaign}';delete from private.invites where code='${code}';delete from auth.sessions where user_id in('${users[0]}','${users[1]}');delete from auth.users where id in('${users[0]}','${users[1]}')`
  )
}

await file('supabase/tests/cron.sql')
console.log('Scheduler SQL tests passed with local Vault/HTTP/Cron contract adapters.')
