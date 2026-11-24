import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

// Actual embedded PostgreSQL, with only Supabase-managed auth/storage scaffolding stubbed.
// This tests our SQL/RLS/transactions; it does not emulate remote Auth, SMTP, streaming or payments.
const db = new PGlite({ extensions: { unaccent, pg_trgm } });
const admin = '00000000-0000-4000-8000-000000000001';
const alice = '00000000-0000-4000-8000-000000000002';
const bob = '00000000-0000-4000-8000-000000000003';
const unverified = '00000000-0000-4000-8000-000000000004';
const video = '10000000-0000-4000-8000-000000000001';
const legacyVideo = '10000000-0000-4000-8000-000000000099';
const paidAt = new Date(Date.now() - 60_000).toISOString();
const newer = new Date(Date.now() - 30_000).toISOString();

async function scalar<T = unknown>(sql: string, args: unknown[] = []): Promise<T> {
  const result = await db.query<Record<string, T>>(sql, args);
  return Object.values(result.rows[0])[0];
}
async function access(user: string): Promise<boolean> {
  return scalar<boolean>('select public.has_access($1::uuid)', [user]);
}
async function order(user: string): Promise<string> {
  return scalar<string>('insert into public.payment_orders(user_id,amount_cents,currency,period_days) values ($1,3990,\'BRL\',30) returning id', [user]);
}
async function payment(id: string, paymentId: string, status: string, event: string, timestamp = paidAt, cents = 3990, approvedAt: string | null = status === 'approved' ? timestamp : null): Promise<any> {
  return scalar('select public.process_payment($1::uuid,$2,$3,$4::timestamptz,$5,$6::integer,$7,$8::timestamptz)', [id, paymentId, status, timestamp, event, cents, 'BRL', approvedAt]);
}

before(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema storage;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/001_initial.sql', import.meta.url), 'utf8'));
  // Simulate data that must survive the scope update on an existing installation.
  await db.query("insert into public.videos(id,title,duration_seconds,status,published,bunny_video_id) values ($1,'Arquivo anterior',181,'ready',true,'legacy-private-id')", [legacyVideo]);
  await db.query("insert into public.materials(title,storage_path,mime_type,size_bytes,published) values ('Material anterior','legacy.pdf','application/pdf',20,true)");
  await db.exec(await readFile(new URL('../supabase/migrations/002_professor_version_scope.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/003_video_deletion.sql', import.meta.url), 'utf8'));
  for (const id of [admin, alice, bob, unverified]) {
    await db.query('insert into auth.users(id,raw_user_meta_data,email_confirmed_at) values ($1,$2,$3)', [
      id, JSON.stringify({ display_name: id === admin ? 'Professor' : 'Aluno', role: 'admin', enabled: true }),
      id === unverified ? null : paidAt,
    ]);
  }
  await db.query("update public.profiles set role='admin' where id=$1", [admin]);
});
after(async () => { await db.close(); });

test('scope migration fills supplied contacts and keeps legacy videos/materials private without deleting records', async () => {
  assert.deepEqual(await scalar('select value from public.settings where key=\'public\''), {
    instagram_url: 'https://www.instagram.com/seu_perfil/', whatsapp_number: '5511900000000', banner_title: '', banner_text: '', banner_url: '',
  });
  assert.equal(await scalar('select published from public.videos where id=$1', [legacyVideo]), false);
  assert.equal(await scalar('select duration_seconds from public.videos where id=$1', [legacyVideo]), 181);
  assert.equal(await scalar("select count(*)::int from public.materials where title='Material anterior'"), 1);
  assert.equal(await scalar("select public from storage.buckets where id='materials'"), false);
  await assert.rejects(db.query("update public.videos set published=true where id=$1", [legacyVideo]), /videos_published_duration_check/);
});

test('signup ignores admin metadata; unpaid/unverified accounts are denied', async () => {
  assert.equal(await scalar('select role from public.profiles where id=$1', [alice]), 'user');
  assert.equal(await access(admin), true);
  assert.equal(await access(alice), false);
  await db.query('insert into public.memberships(user_id,granted_by) values ($1,$2)', [unverified, admin]);
  assert.equal(await access(unverified), false);
});

test('free enrollment cancellation/reactivation and account blocking are independent', async () => {
  const grant = await scalar<string>('insert into public.memberships(user_id,granted_by) values ($1,$2) returning id', [alice, admin]);
  assert.equal(await access(alice), true);
  await db.query("update public.memberships set status='cancelled',cancelled_at=now() where id=$1", [grant]);
  assert.equal(await access(alice), false);
  await db.query("update public.memberships set status='active',cancelled_at=null where id=$1", [grant]);
  assert.equal(await access(alice), true);
  await db.query('update public.profiles set enabled=false where id=$1', [alice]);
  assert.equal(await access(alice), false);
  await db.query('update public.profiles set enabled=true where id=$1', [alice]);
  assert.equal(await access(alice), true);
  await db.query("update public.memberships set status='cancelled' where id=$1", [grant]);
});

test('pending/declined stay protected; approved grants correct user once', async () => {
  const id = await order(alice);
  assert.equal((await payment(id, 'mp-1', 'pending', 'pending-1')).status, 'pending');
  assert.equal(await access(alice), false);
  assert.equal((await payment(id, 'mp-1', 'rejected', 'rejected-1')).status, 'rejected');
  assert.equal(await access(alice), false);
  await assert.rejects(payment(id, 'mp-1', 'approved', 'bad-value', paidAt, 1), /mismatch/);
  const approved = await payment(id, 'mp-1', 'approved', 'approved-1', newer);
  assert.equal(approved.processed, true);
  assert.equal(await access(alice), true);
  assert.equal(await access(bob), false);
  const duplicate = await payment(id, 'mp-1', 'approved', 'approved-1', newer);
  assert.equal(duplicate.reason, 'duplicate');
  const repeat = await payment(id, 'mp-1', 'approved', 'approved-another', new Date().toISOString());
  assert.equal(repeat.access_until, approved.access_until);
  assert.equal(await scalar('select count(*)::int from public.subscriptions where order_id=$1', [id]), 1);
  assert.equal((await payment(id, 'mp-1', 'pending', 'old-pending', paidAt)).reason, 'stale');
  assert.equal(await access(alice), true);
});

test('refunds/chargebacks revoke their order only; delayed approval never restores them', async () => {
  const id = await order(bob);
  await payment(id, 'mp-2', 'approved', 'approved-2');
  assert.equal(await access(bob), true);
  await payment(id, 'mp-2', 'refunded', 'refunded-2', newer);
  assert.equal(await access(bob), false);
  assert.equal((await payment(id, 'mp-2', 'approved', 'late-approval-2', new Date().toISOString())).reason, 'terminal');
  assert.equal(await access(bob), false);
  const grant = await scalar<string>('insert into public.memberships(user_id,granted_by) values ($1,$2) returning id', [bob, admin]);
  assert.equal(await access(bob), true);
  const second = await order(bob);
  await payment(second, 'mp-3', 'approved', 'approved-3');
  await db.query("update public.memberships set status='cancelled' where id=$1", [grant]);
  assert.equal(await access(bob), true);
  await db.query("update public.subscriptions set status='cancelled' where order_id=$1", [second]);
  assert.equal(await access(bob), true, 'cancel renewal preserves paid term');
  await payment(second, 'mp-3', 'charged_back', 'chargeback-3', newer);
  assert.equal(await access(bob), false);
});

test('provider payment cannot be associated with two accounts/orders', async () => {
  const id = await order(bob);
  await assert.rejects(payment(id, 'mp-1', 'approved', 'stolen-payment'), /another order|unique|duplicate/i);
  assert.equal(await scalar('select count(*)::int from public.subscriptions where order_id=$1', [id]), 0);
});

test('checkout creation reuses a snapshot under repeated requests and refuses current paid term', async () => {
  await assert.rejects(db.query("select public.create_payment_order($1,3990,30,'Acesso')", [alice]), /already active/);
  await assert.rejects(db.query("select public.create_payment_order($1,3990,30,'Acesso')", [unverified]), /unavailable/);
  const results = await Promise.all(Array.from({length:3}, () => scalar<any>("select public.create_payment_order($1,3990,30,'Acesso')", [bob])));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  const changedPlan = await scalar<any>("select public.create_payment_order($1,5990,60,'Novo plano')", [bob]);
  assert.equal(changedPlan.id, results[0].id);
  assert.equal(changedPlan.amount_cents, 3990);
  assert.equal(changedPlan.period_days, 30);
});

test('multiple payment attempts compare time independently and bind each attempt permanently', async () => {
  const id = await order(bob);
  await payment(id, 'retry-B', 'pending', 'retry-b-pending', paidAt);
  await payment(id, 'retry-A', 'rejected', 'retry-a-rejected', new Date().toISOString());
  const approved = await payment(id, 'retry-B', 'approved', 'retry-b-approved', newer);
  assert.equal(approved.processed, true, 'newer rejection A cannot hide older approval B');
  assert.equal(await access(bob), true);
  const other = await order(alice);
  await assert.rejects(payment(other, 'retry-A', 'approved', 'retry-a-stolen', new Date().toISOString()), /another order/);
  await payment(id, 'retry-B', 'refunded', 'retry-b-refund', new Date(Date.now()+1000).toISOString());
  assert.equal(await access(bob), false);
});

test('late reconciliation uses original approval date, never last update or processing time', async () => {
  const id = await order(bob);
  const originalApproval = new Date(Date.now() - 31 * 86400_000).toISOString();
  const created = new Date(Date.now() - 32 * 86400_000).toISOString();
  const update = new Date().toISOString();
  await db.query('update public.payment_orders set created_at=$2 where id=$1', [id, created]);
  await assert.rejects(payment(id, 'late-date', 'approved', 'late-no-date', update, 3990, null), /approval date/);
  await assert.rejects(payment(id, 'late-date', 'approved', 'late-future-date', update, 3990, '2099-01-01T00:00:00Z'), /approval date/);
  await assert.rejects(payment(id, 'late-date', 'approved', 'late-before-order', update, 3990, '1970-01-01T00:00:00Z'), /approval date/);
  const result = await payment(id, 'late-date', 'approved', 'late-original-date', update, 3990, originalApproval);
  const savedPaidAt = await scalar<string>('select paid_at::text from public.payment_orders where id=$1', [id]);
  assert.equal(Date.parse(savedPaidAt), Date.parse(originalApproval));
  assert.equal(Date.parse(result.access_until), Date.parse(originalApproval) + 30 * 86400_000);
  assert.equal(await access(bob), false, 'a term paid 31 days ago is not recreated as a fresh 30-day term');
  const repeat = await payment(id, 'late-date', 'approved', 'late-original-repeat', new Date(Date.now() + 1000).toISOString(), 3990, originalApproval);
  assert.equal(repeat.access_until, result.access_until);
});

test('search combines accent-insensitive text and taxonomy filters; hides private IDs/drafts', async () => {
  await db.query("insert into public.videos(id,title,exercise,description,difficulty,duration_seconds,status,published,bunny_video_id,keywords) values ($1,'Agachamento para glúteos','Agachamento livre','Posterior de coxa','intermediate',180,'ready',true,'private-bunny-id',array['TÉCNICA'])", [video]);
  await db.query("insert into public.videos(title) values ('Agachamento rascunho')");
  const muscle = await scalar<string>("insert into public.taxonomies(kind,name,slug) values ('muscle','Glúteos','gluteos') returning id");
  await db.query('select public.replace_video_taxonomies($1::uuid,$2::uuid[])', [video, [muscle]]);
  const result = await scalar<any>('select public.catalog_search($1,$2,$3)', ['GLUTEOS','intermediate','gluteos']);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, video);
  assert.equal(result.items[0].bunny_video_id, undefined);
  assert.equal(result.items[0].taxonomies[0].slug, 'gluteos');
  assert.equal((await scalar<any>("select public.catalog_search('tecnica')")).items.length, 1);
  assert.equal((await scalar<any>("select public.catalog_search('GLUTEOS agachamento')")).items.length, 1);
  assert.equal((await scalar<any>("select public.catalog_search('posterior de coxa')")).items.length, 1);
  assert.equal((await scalar<any>("select public.catalog_search('gluteos','beginner')")).items.length, 0);
  assert.equal((await scalar<any>("select public.catalog_search('%')")).items.length, 0);
  await assert.rejects(db.query("insert into public.videos(title,published) values ('Ainda processando',true)"), /check constraint/);
  await assert.rejects(db.query('select public.replace_video_taxonomies($1::uuid,$2::uuid[])', [video, ['99999999-0000-4000-8000-000000000000']]), /foreign key/);
  assert.equal(await scalar('select count(*)::int from public.video_taxonomies where video_id=$1', [video]), 1, 'failed replacement rolls back deleted associations');
});

test('RLS isolates favorites/profiles and rejects client privilege changes/service RPCs', async () => {
  await db.query('insert into public.favorites(user_id,video_id) values ($1,$3),($2,$3)', [alice,bob,video]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [alice]);
  await db.exec('set role authenticated');
  try {
    const profiles = await db.query<{id:string}>('select id from public.profiles');
    assert.deepEqual(profiles.rows.map(p => p.id), [alice]);
    const favorites = await db.query<{user_id:string}>('select user_id from public.favorites');
    assert.deepEqual(favorites.rows.map(p => p.user_id), [alice]);
    await assert.rejects(db.query("update public.profiles set role='admin' where id=$1", [alice]), /permission denied/);
    await assert.rejects(db.query('insert into public.memberships(user_id,granted_by) values ($1,$1)', [alice]), /permission denied/);
    await assert.rejects(db.query('select public.has_access($1::uuid)', [bob]), /permission denied/);
    await assert.rejects(db.query('select bunny_video_id from public.videos'), /permission denied/);
    await assert.rejects(db.query('select storage_path from public.materials'), /permission denied/);
    await assert.rejects(db.query('delete from public.favorites where user_id=$1', [bob]), /permission denied/);
  } finally { await db.exec('reset role'); }
});

test('rate limit is atomic across three simultaneous requests and stores only keyed hashes', async () => {
  const results = await Promise.all(Array.from({length:3}, () => scalar<any>('select public.rate_limit($1,2,60)', ['a'.repeat(64)])));
  assert.equal(results.filter(r => r.allowed).length, 2);
  assert.equal(results.filter(r => !r.allowed).length, 1);
  await assert.rejects(db.query("select public.rate_limit('192.0.2.1',2,60)"), /Invalid rate limit/);
});

test('materials bucket stays private; financial/audit history is append-only to service', async () => {
  assert.equal(await scalar("select public from storage.buckets where id='materials'"), false);
  await db.exec('set role service_role');
  try {
    await assert.rejects(db.query('delete from public.audit_logs'), /permission denied/);
    await assert.rejects(db.query("update public.payment_events set outcome='forged'"), /permission denied/);
    assert.equal(typeof await access(alice), 'boolean');
  } finally { await db.exec('reset role'); }
});

test('reconciliation claims rotate through old orders instead of starving them behind newest rows', async () => {
  for (let i=0; i<7; i++) await order(bob);
  const first = await scalar<any[]>('select public.claim_reconciliation_orders(3)');
  const second = await scalar<any[]>('select public.claim_reconciliation_orders(3)');
  assert.equal(first.length, 3);
  assert.equal(second.length, 3);
  assert.equal(first.some(a => second.some(b => a.id === b.id)), false);
  assert.ok(first.every(o => o.last_reconciled_at));
  assert.ok((await scalar<any[]>('select public.claim_reconciliation_orders(100)')).length <= 5);
});

test('restore-security is idempotent and restores the Auth trigger and private bucket', async () => {
  const security = await readFile(new URL('../supabase/restore-security.sql', import.meta.url), 'utf8');
  await db.exec('drop trigger on_auth_user_created on auth.users');
  await db.exec("update storage.buckets set public=true where id='materials'");
  await db.exec(security);
  await db.exec(security);
  assert.equal(await scalar("select public from storage.buckets where id='materials'"), false);
  const newcomer = '00000000-0000-4000-8000-000000000005';
  await db.query('insert into auth.users(id,email_confirmed_at) values ($1,now())', [newcomer]);
  assert.equal(await scalar('select role from public.profiles where id=$1', [newcomer]), 'user');
  await db.exec('set role authenticated');
  try {
    await assert.rejects(db.query('select public.claim_reconciliation_orders(1)'), /permission denied/);
    await assert.rejects(db.query("select public.create_payment_order($1,3990,30,'Acesso')", [newcomer]), /permission denied/);
  } finally { await db.exec('reset role'); }
});
