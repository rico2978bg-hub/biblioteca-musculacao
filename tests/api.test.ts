import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ApiError, assertSameOrigin, hasEntitlement, hmac, normalizeSearch, signedEmbed, sniffFile,
  tusSignature, validatePayment, verifyMercadoPagoSignature,
} from '../server/core.ts';
import { handleRequest } from '../server/index.ts';
import { requireAccess, type Env, type Session, Supabase } from '../server/services.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VIDEO = '33333333-3333-4333-8333-333333333333';
const ORDER = '44444444-4444-4444-8444-444444444444';
const now = Date.parse('2026-10-22T15:00:00Z');
const future = '2026-11-22T15:00:00Z';
const past = '2026-10-21T15:00:00Z';

test('Cadastro por si só não concede acesso; e-mail não verificado também não', () => {
  assert.equal(hasEntitlement(true, true, [], [], now), false);
  assert.equal(hasEntitlement(true, false, [{ status: 'active' }], [], now), false);
});
test('Matrícula e assinatura são fontes independentes; bloquear conta vence ambas', () => {
  const grant = { status: 'active', starts_at: past, expires_at: future };
  const paid = { status: 'active', period_start: past, period_end: future };
  assert.equal(hasEntitlement(true, true, [{ ...grant, status: 'cancelled' }], [paid], now), true);
  assert.equal(hasEntitlement(true, true, [grant], [{ ...paid, status: 'refunded' }], now), true);
  assert.equal(hasEntitlement(false, true, [grant], [paid], now), false);
  assert.equal(hasEntitlement(true, true, [{ ...grant, status: 'cancelled' }], [], now), false);
  assert.equal(hasEntitlement(true, true, [grant], [], now), true);
});
test('Prazo pago cancelado continua até o vencimento; estorno e datas inválidas não', () => {
  assert.equal(hasEntitlement(true, true, [], [{ status: 'cancelled', period_end: future }], now), true);
  assert.equal(hasEntitlement(true, true, [], [{ status: 'charged_back', period_end: future }], now), false);
  assert.equal(hasEntitlement(true, true, [{ status: 'active', expires_at: 'not-a-date' }], [], now), false);
  assert.equal(hasEntitlement(true, true, [{ status: 'active', expires_at: new Date(now).toISOString() }], [], now), false);
  assert.equal(hasEntitlement(true, true, [{ status: 'active', starts_at: future }], [], now), false);
});
test('Busca ignora caixa e acentos', () => {
  assert.equal(normalizeSearch(' GLÚTEOS '), 'gluteos');
  assert.equal(normalizeSearch('Posterior de Coxa'), 'posterior de coxa');
});
test('Mutações exigem origem exata, incluindo login e configuração', () => {
  assert.doesNotThrow(() => assertSameOrigin(new Request('https://app.test/api', { headers: { Origin: 'https://app.test' } }), 'https://app.test'));
  for (const origin of ['', 'https://evil.test', 'https://app.test.evil.test', 'http://app.test']) {
    assert.throws(() => assertSameOrigin(new Request('https://app.test/api', { headers: origin ? { Origin: origin } : {} }), 'https://app.test'), ApiError);
  }
});
test('Bunny embed usa SHA256 hexadecimal oficial e recusa prazo expirado', async () => {
  const sec = Math.floor(now / 1000); const expires = sec + 600;
  const url = new URL(await signedEmbed('private-key', '123', VIDEO, expires, sec));
  assert.equal(url.searchParams.get('token'), createHash('sha256').update('private-key' + VIDEO + expires).digest('hex'));
  assert.equal(url.searchParams.get('expires'), String(expires));
  await assert.rejects(signedEmbed('private-key', '123', VIDEO, sec, sec), { code: 'INVALID_EXPIRY' });
  await assert.rejects(signedEmbed('private-key', '123', VIDEO, sec + 3601, sec), { code: 'INVALID_EXPIRY' });
});
test('Bunny TUS assina biblioteca + chave + expiração + vídeo sem expor chave', async () => {
  assert.equal(await tusSignature('123', 'secret', VIDEO, 1900000000), createHash('sha256').update('123secret1900000000' + VIDEO).digest('hex'));
});

async function signedWebhook(overrides: { id?: string; requestId?: string; ts?: string; body?: object } = {}): Promise<Request> {
  const id = overrides.id || '123456'; const requestId = overrides.requestId || 'request-123';
  const ts = overrides.ts || String(Math.floor(Date.now() / 1000));
  const signature = await hmac('webhook-secret', `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`);
  return new Request(`https://app.test/api/webhooks/mercadopago?data.id=${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': `ts=${ts},v1=${signature}`, 'x-request-id': requestId },
    body: JSON.stringify(overrides.body || { type: 'payment', id: 'notice-1', data: { id } }),
  });
}
test('Webhook HMAC confere com implementação independente; recusa adulteração e replay antigo', async () => {
  const request = await signedWebhook({ ts: String(Math.floor(now / 1000)) });
  assert.equal(await verifyMercadoPagoSignature(request, 'webhook-secret', now), true);
  const independently = createHmac('sha256', 'webhook-secret').update(`id:123456;request-id:request-123;ts:${Math.floor(now / 1000)};`).digest('hex');
  assert.ok(request.headers.get('x-signature')?.includes(independently));
  assert.equal(await verifyMercadoPagoSignature(request, 'other-secret', now), false);
  assert.equal(await verifyMercadoPagoSignature(request, 'webhook-secret', now + 301_000), false);
  const swapped = new Request(request.url.replace('123456', '999999'), request);
  assert.equal(await verifyMercadoPagoSignature(swapped, 'webhook-secret', now), false);
});

const payment = { id: 123456, external_reference: ORDER, collector_id: 99, transaction_amount: 39.9, currency_id: 'BRL', live_mode: false, date_approved: '2026-10-21T15:00:00Z', date_last_updated: '2026-10-22T15:00:00Z', status: 'approved' };
const order = { id: ORDER, user_id: USER, amount_cents: 3990, currency: 'BRL', period_days: 30 };
test('Pagamento só associa pedido, valor, moeda, recebedor e ambiente corretos', () => {
  assert.equal(validatePayment(payment, order, '99', false), 'approved');
  for (const altered of [{ ...payment, external_reference: OTHER }, { ...payment, collector_id: 100 }, { ...payment, transaction_amount: 0.01 }, { ...payment, currency_id: 'USD' }, { ...payment, live_mode: true }]) {
    assert.throws(() => validatePayment(altered, order, '99', false), { code: 'PAYMENT_MISMATCH' });
  }
  assert.throws(() => validatePayment(payment, { ...order, status: 'approved', provider_payment_id: '98765' }, '99', false), { code: 'PAYMENT_MISMATCH' });
  assert.equal(validatePayment(payment, { ...order, status: 'rejected', provider_payment_id: '98765' }, '99', false), 'approved');
});
test('Pagamento pendente/recusado permanece assim; reembolso parcial revoga conservadoramente', () => {
  assert.equal(validatePayment({ ...payment, status: 'pending' }, order, '99', false), 'pending');
  assert.equal(validatePayment({ ...payment, status: 'rejected' }, order, '99', false), 'rejected');
  assert.equal(validatePayment({ ...payment, transaction_amount_refunded: 10 }, order, '99', false), 'refunded');
});
test('Aprovação exige data original válida, anterior à atualização e compatível com o pedido', () => {
  assert.equal(validatePayment(payment, order, '99', false), 'approved');
  for (const date of [undefined, null, 'invalid-date', '1970-01-01T00:00:00Z', '2099-01-01T00:00:00Z', '2026-10-22T16:00:00Z']) {
    assert.throws(() => validatePayment({ ...payment, date_approved: date }, order, '99', false), { code: 'INVALID_APPROVAL_DATE' });
  }
  assert.throws(() => validatePayment(payment, { ...order, created_at: '2026-10-22T15:00:00Z' }, '99', false), { code: 'INVALID_APPROVAL_DATE' });
});
test('Validação de arquivos confere assinatura; SVG, HTML e extensão enganosa são recusados', () => {
  assert.equal(sniffFile(new TextEncoder().encode('%PDF-1.7 contents'), 'material'), 'application/pdf');
  assert.equal(sniffFile(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'thumbnail'), 'image/png');
  assert.throws(() => sniffFile(new TextEncoder().encode('<svg onload="alert(1)">'), 'thumbnail'), ApiError);
  assert.throws(() => sniffFile(new TextEncoder().encode('<html>fake PDF</html>'), 'material'), ApiError);
});

const env: Env = {
  APP_ORIGIN: 'https://app.test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key', RATE_LIMIT_SALT: 'server-only-random-secret',
  MERCADO_PAGO_ACCESS_TOKEN: 'mp-token', MERCADO_PAGO_WEBHOOK_SECRET: 'webhook-secret', MERCADO_PAGO_COLLECTOR_ID: '99', MERCADO_PAGO_LIVE_MODE: 'false',
};
const token = (aal = 'aal1', userId = USER) => `header.${Buffer.from(JSON.stringify({ sub: userId, aal, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function req(path: string, method = 'GET', body?: unknown, aal = 'aal1'): Request {
  return new Request(`https://app.test${path}`, { method, headers: { Origin: 'https://app.test', 'Content-Type': 'application/json', Cookie: `__Host-dm_access=${token(aal)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
}

type MockOptions = { enabled?: boolean; verified?: boolean; role?: string; entitled?: boolean; onFetch?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined };
async function withProvider(options: MockOptions, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const custom = options.onFetch?.(url, init); if (custom) return custom;
    if (url.pathname === '/auth/v1/user') return response({ id: USER, email: 'aluno@example.test', email_confirmed_at: options.verified === false ? null : past, factors: [] });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: USER, display_name: 'Aluno', role: options.role || 'user', enabled: options.enabled !== false }]);
    if (url.pathname === '/rest/v1/rpc/has_access') return response(options.entitled === true);
    if (url.pathname === '/rest/v1/rpc/rate_limit') return response({ allowed: true, remaining: 9, retry_after: 60 });
    throw new Error(`Unexpected provider call in test: ${url.pathname}`);
  };
  try { await fn(); } finally { globalThis.fetch = original; }
}

test('Sem credenciais, config identifica demonstração e API protegida falha fechada', async () => {
  const config = await handleRequest(new Request('https://app.test/api/config'), {});
  const configBody = await config.json() as { configured: boolean; contacts: { instagram: string; whatsapp: string } };
  assert.equal(configBody.configured, false);
  assert.deepEqual(configBody.contacts, { instagram: 'https://www.instagram.com/seu_perfil/', whatsapp: 'https://wa.me/5511900000000' });
  const protectedRoute = await handleRequest(req(`/api/watch/${VIDEO}`), {});
  assert.equal(protectedRoute.status, 503);
  assert.equal(protectedRoute.headers.get('cache-control'), 'private, no-store');
});

test('Supabase usa chaves modernas em apikey e mantém Bearer para sessões e chaves legadas', async () => {
  for (const modern of [false, true]) {
    const publishable = modern ? 'sb_publishable_fixture' : env.SUPABASE_ANON_KEY!;
    const secret = modern ? 'sb_secret_fixture' : env.SUPABASE_SERVICE_ROLE_KEY!;
    const sb = new Supabase({ ...env, SUPABASE_ANON_KEY: publishable, SUPABASE_SERVICE_ROLE_KEY: secret });
    const sessionToken = token('aal2');
    const received: [string, string | null, string | null][] = [];
    await withProvider({ onFetch: (url, init) => {
      const headers = new Headers(init?.headers);
      received.push([url.pathname, headers.get('apikey'), headers.get('Authorization')]);
      return response({});
    } }, async () => {
      await sb.auth('/token?grant_type=password', 'POST');
      await sb.auth('/user', 'GET', undefined, sessionToken);
      await sb.auth('/invite', 'POST', {}, undefined, true);
      await sb.db('profiles');
    });
    assert.deepEqual(received, [
      ['/auth/v1/token', publishable, modern ? null : `Bearer ${publishable}`],
      ['/auth/v1/user', publishable, `Bearer ${sessionToken}`],
      ['/auth/v1/invite', secret, modern ? null : `Bearer ${secret}`],
      ['/rest/v1/profiles', secret, modern ? null : `Bearer ${secret}`],
    ]);
  }
});

test('Configuração real usa contatos informados quando ausentes e preserva edição administrativa', async () => {
  for (const configuredContacts of [{}, { instagram_url: 'https://www.instagram.com/outra_conta/', whatsapp_number: '5511999999999' }]) {
    await withProvider({ onFetch: url => url.pathname === '/rest/v1/settings' ? response([{ value: url.searchParams.get('key') === 'eq.public' ? configuredContacts : {} }]) : undefined }, async () => {
      const result = await handleRequest(req('/api/config'), env);
      assert.equal(result.status, 200);
      const body = await result.json() as { contacts: { instagram: string; whatsapp: string } };
      assert.deepEqual(body.contacts, {
        instagram: 'instagram_url' in configuredContacts ? configuredContacts.instagram_url : 'https://www.instagram.com/seu_perfil/',
        whatsapp: `https://wa.me/${'whatsapp_number' in configuredContacts ? configuredContacts.whatsapp_number : '5511900000000'}`,
      });
    });
  }
});

test('Rotas legadas de materiais foram removidas inclusive para conta autorizada e administrador AAL2', async () => {
  const original = globalThis.fetch; let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('Removed routes must not call providers'); };
  try {
    for (const account of ['anonymous', 'member', 'admin']) {
      for (const path of ['/api/materials', `/api/materials/${VIDEO}`, '/api/admin/materials', `/api/admin/materials/${VIDEO}`]) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
          const request = account === 'anonymous' ? new Request(`https://app.test${path}`, { method }) : req(path, method, undefined, account === 'admin' ? 'aal2' : 'aal1');
          const result = await handleRequest(request, env);
          assert.equal(result.status, 404, `${account} ${method} ${path}`);
          assert.equal((await result.json() as JsonResult).error, 'NOT_FOUND');
        }
      }
    }
    assert.equal(providerCalls, 0, 'No storage URL, metadata or upload authorization may be issued');
  } finally { globalThis.fetch = original; }
});
test('URL direta de vídeo sem sessão nunca obtém autorização', async () => {
  await withProvider({}, async () => {
    for (const path of [`/api/watch/${VIDEO}`]) {
      const result = await handleRequest(new Request(`https://app.test${path}`), env);
      assert.equal(result.status, 401);
      assert.equal((await result.json() as JsonResult).error, 'SIGN_IN_REQUIRED');
    }
  });
});
type JsonResult = { error?: string; [key: string]: unknown };
test('Conta verificada sem matrícula ou assinatura continua sem acessar vídeo', async () => {
  await withProvider({ entitled: false }, async () => {
    for (const path of [`/api/watch/${VIDEO}`]) {
      const result = await handleRequest(req(path), env);
      assert.equal(result.status, 403);
      assert.equal((await result.json() as JsonResult).error, 'ACCESS_REQUIRED');
    }
  });
});
test('Bloqueio de conta e ausência de confirmação de e-mail são verificados no servidor', async () => {
  for (const options of [{ enabled: false }, { verified: false }]) await withProvider(options, async () => {
    assert.equal((await handleRequest(req('/api/account'), env)).status, 403);
  });
});
test('Administrador em AAL1 não acessa painel e nem emite token de streaming', async () => {
  await withProvider({ role: 'admin', entitled: true }, async () => {
    assert.equal((await handleRequest(req('/api/admin/overview'), env)).status, 403);
    assert.equal((await handleRequest(req(`/api/watch/${VIDEO}`), env)).status, 403);
  });
});
test('Mesmo com assinatura, favoritos são sempre consultados pelo ID da sessão', async () => {
  let favoriteOwner = '';
  await withProvider({ entitled: true, onFetch: (url) => {
    if (url.pathname === '/rest/v1/favorites') { favoriteOwner = url.searchParams.get('user_id') || ''; return response([]); }
  } }, async () => {
    const result = await handleRequest(req(`/api/favorites?user_id=${OTHER}`), env);
    assert.equal(result.status, 200);
    assert.equal(favoriteOwner, `eq.${USER}`);
  });
});
test('Origem externa é recusada antes de enviar qualquer solicitação ao provedor', async () => {
  const original = globalThis.fetch; let called = false;
  globalThis.fetch = async () => { called = true; throw new Error(); };
  try {
    const result = await handleRequest(new Request('https://app.test/api/auth/signin', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' }), env);
    assert.equal(result.status, 403); assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});
test('Webhook inválido é recusado antes da API e do banco', async () => {
  await withProvider({}, async () => {
    const result = await handleRequest(new Request('https://app.test/api/webhooks/mercadopago?data.id=123456', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
    assert.equal(result.status, 401);
  });
});
test('Webhook autenticado consulta pagamento oficial e envia somente dados verificados à RPC atômica', async () => {
  const applications: Record<string, unknown>[] = [];
  await withProvider({ onFetch: (url, init) => {
    if (url.hostname === 'api.mercadopago.com' && url.pathname === '/v1/payments/123456') return response(payment);
    if (url.pathname === '/rest/v1/payment_orders') return response([order]);
    if (url.pathname === '/rest/v1/rpc/process_payment') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; applications.push(body);
      return response({ processed: applications.length === 1, status: 'approved', order_id: ORDER });
    }
  } }, async () => {
    const notification = await signedWebhook();
    assert.equal((await handleRequest(notification.clone(), env)).status, 200);
    assert.equal((await handleRequest(notification.clone(), env)).status, 200);
  });
  assert.equal(applications.length, 2);
  assert.equal(applications[0].p_order_id, ORDER);
  assert.equal(applications[0].p_amount_cents, 3990);
  assert.equal(applications[0].p_status, 'approved');
  assert.equal(applications[0].p_approved_at, payment.date_approved);
  assert.notEqual(applications[0].p_approved_at, applications[0].p_provider_updated_at);
  assert.equal(applications[0].p_event_id, applications[1].p_event_id);
});
test('Página de retorno do checkout não libera conteúdo nem escreve no banco', async () => {
  const result = await handleRequest(new Request('https://app.test/assinatura?retorno=sucesso&status=approved'), {
    ...env, ASSETS: { fetch: async () => new Response('<html>Interface</html>', { headers: { 'Content-Type': 'text/html' } }) },
  });
  assert.equal(result.status, 200); assert.equal(result.headers.get('Set-Cookie'), null);
});
test('Três usuários simultâneos preservam autorização independente', async () => {
  const checked = new Set<string>();
  await withProvider({ onFetch: (url, init) => {
    if (url.pathname === '/auth/v1/user') {
      const jwt = new Headers(init?.headers).get('Authorization')!.slice(7);
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as { sub: string };
      return response({ id: claims.sub, email_confirmed_at: past });
    }
    if (url.pathname === '/rest/v1/profiles') return response([{ id: url.searchParams.get('id')!.slice(3), display_name: '', role: 'user', enabled: true }]);
    if (url.pathname === '/rest/v1/rpc/has_access') { checked.add((JSON.parse(String(init?.body)) as { p_user_id: string }).p_user_id); return response(false); }
  } }, async () => {
    const results = await Promise.all([USER, OTHER, ORDER].map(userId => handleRequest(new Request(`https://app.test/api/watch/${VIDEO}`, { headers: { Cookie: `__Host-dm_access=${token('aal1', userId)}` } }), env)));
    assert.deepEqual(results.map(r => r.status), [403, 403, 403]);
  });
  assert.deepEqual([...checked].sort(), [USER, OTHER, ORDER].sort());
});
test('Regra MFA não depende apenas de esconder o menu', async () => {
  await assert.rejects(requireAccess({ user: { id: USER }, profile: { id: USER, display_name: '', role: 'admin', enabled: true }, accessToken: '', aal: 'aal1' } as Session, new Supabase(env)), { code: 'MFA_REQUIRED' });
});

test('Cadastro ignora permissões enviadas pelo cliente; senha de login preserva espaços', async () => {
  let signup: Record<string, unknown> = {}; let submittedPassword = '';
  await withProvider({ onFetch: (url, init) => {
    if (url.pathname === '/auth/v1/signup') { signup = JSON.parse(String(init?.body)); return response({}); }
    if (url.pathname === '/auth/v1/token') {
      submittedPassword = (JSON.parse(String(init?.body)) as { password: string }).password;
      return response({ access_token: token(), refresh_token: 'refresh-value', expires_in: 3600, user: { id: USER, email_confirmed_at: past } });
    }
  } }, async () => {
    assert.equal((await handleRequest(req('/api/auth/signup', 'POST', { email: 'x@example.test', password: ' Strong Password ', display_name: 'Aluno', role: 'admin', enabled: true, free_access: true }), env)).status, 202);
    const data = signup.data as Record<string, unknown>;
    assert.deepEqual(data, { display_name: 'Aluno' }); assert.equal(signup.role, undefined);
    const login = await handleRequest(req('/api/auth/signin', 'POST', { email: 'x@example.test', password: ' Strong Password ' }), env);
    assert.equal(login.status, 200); assert.equal(submittedPassword, ' Strong Password ');
    const cookies = login.headers.get('set-cookie') || '';
    assert.ok(cookies.includes('HttpOnly')); assert.ok(cookies.includes('Secure')); assert.ok(cookies.includes('SameSite=Lax'));
  });
});
test('Professor convida aluno sem escolher senha; cancela e reativa só a matrícula', async () => {
  const operations: string[] = [];
  await withProvider({ role: 'admin', entitled: true, onFetch: (url, init) => {
    if (url.pathname === '/auth/v1/invite') {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(data.password, undefined);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer service-key');
      return response({ id: OTHER });
    }
    if (url.pathname === '/rest/v1/memberships') { operations.push(String(init?.body)); return response([{ id: VIDEO }]); }
    if (url.pathname === '/rest/v1/audit_logs') return response(null, 204);
  } }, async () => {
    assert.equal((await handleRequest(req('/api/admin/users/invite', 'POST', { email: 'aluno@example.test', display_name: 'Aluno' }, 'aal2'), env)).status, 201);
    assert.equal((await handleRequest(req(`/api/admin/users/${OTHER}/grants`, 'POST', { expires_at: '2099-01-01T00:00:00Z' }, 'aal2'), env)).status, 201);
    assert.equal((await handleRequest(req(`/api/admin/grants/${VIDEO}`, 'PATCH', { status: 'cancelled' }, 'aal2'), env)).status, 200);
    assert.equal((await handleRequest(req(`/api/admin/grants/${VIDEO}`, 'PATCH', { status: 'active' }, 'aal2'), env)).status, 200);
  });
  assert.deepEqual(operations.map(value => (JSON.parse(value) as { status: string }).status), ['active', 'cancelled', 'active']);
  // Any subscription write would have been an unexpected fetch and failed the scenario.
});
test('Upload de vídeo entrega só autorização temporária e publicação aguarda processamento real', async () => {
  let ready = false; let published = false;
  const video = { id: VIDEO, title: 'Agachamento', description: '', difficulty: 'beginner', duration_seconds: 0, thumbnail_url: '/thumb.jpg', status: 'processing', published: false, bunny_video_id: OTHER };
  const streamingEnv = { ...env, BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'bunny-secret', BUNNY_SECURITY_CONFIRMED: 'true' };
  await withProvider({ role: 'admin', onFetch: (url, init) => {
    if (url.pathname === '/rest/v1/videos') {
      if (init?.method === 'PATCH') { published = (JSON.parse(String(init.body)) as { published: boolean }).published; return response(null, 204); }
      return response([video]);
    }
    if (url.hostname === 'video.bunnycdn.com') return response({ status: ready ? 4 : 0, length: ready ? 180 : 0, encodeProgress: ready ? 100 : 0 });
    if (url.pathname === '/rest/v1/audit_logs') return response(null, 204);
  } }, async () => {
    const upload = await handleRequest(req(`/api/admin/videos/${VIDEO}/upload`, 'POST', {}, 'aal2'), streamingEnv);
    assert.equal(upload.status, 200);
    const auth = await upload.json() as { signature: string; expirationTime: number; videoId: string };
    assert.equal(auth.videoId, OTHER); assert.equal(JSON.stringify(auth).includes('bunny-secret'), false);
    assert.equal(auth.signature, createHash('sha256').update('123bunny-secret' + auth.expirationTime + OTHER).digest('hex'));
    const early = await handleRequest(req(`/api/admin/videos/${VIDEO}/publish`, 'POST', { published: true }, 'aal2'), streamingEnv);
    assert.equal(early.status, 409); assert.equal(published, false);
    ready = true;
    const duplicate = await handleRequest(req(`/api/admin/videos/${VIDEO}/upload`, 'POST', {}, 'aal2'), streamingEnv);
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json() as { message: string }).message, /Este vídeo já está pronto/);
    assert.equal((await handleRequest(req(`/api/admin/videos/${VIDEO}/publish`, 'POST', { published: true }, 'aal2'), streamingEnv)).status, 200);
    assert.equal(published, true);
  });
});

test('Miniatura WebP usa a conexão segura do Supabase e aparece para o administrador antes da publicação', async () => {
  const img = await readFile(new URL('../public/brand/academia-960.webp', import.meta.url));
  const authEnv = { ...env, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture' };
  const video = { id: VIDEO, title: 'Aula', status: 'ready', published: false, thumbnail_storage_path: '', thumbnail_url: '' };
  let savedPath = '';
  const calls: string[] = [];
  await withProvider({ role: 'admin', onFetch: (url, init) => {
    if (url.pathname === '/rest/v1/videos') {
      if (init?.method === 'PATCH') {
        Object.assign(video, JSON.parse(String(init.body)));
        return response([{ id: VIDEO }]);
      }
      return response(url.searchParams.has('published') && !video.published ? [] : [video]);
    }
    if (url.pathname === '/rest/v1/audit_logs') return response(null, 204);
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('apikey'), 'sb_secret_fixture');
      assert.equal(headers.get('Authorization'), null);
      assert.equal(headers.get('User-Agent'), 'BibliotecaMusculacao-Server/1.0');
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal instanceof AbortSignal);
      if (init?.method === 'POST') {
        assert.equal(headers.get('Content-Type'), 'image/webp');
        assert.deepEqual(Buffer.from(init.body as Uint8Array), img);
        savedPath = url.pathname.split('/').at(-1)!;
        calls.push('upload');
        return response({}, 201);
      }
      assert.equal(url.pathname, `/storage/v1/object/authenticated/thumbnails/${savedPath}`);
      calls.push('download');
      return new Response(Uint8Array.from(img));
    }
  } }, async () => {
    const form = new FormData();
    form.set('file', new File([img], 'miniatura.webp', { type: 'image/webp' }));
    const adminPath = `/api/admin/videos/${VIDEO}/thumbnail`;
    const upload = await handleRequest(new Request('https://app.test' + adminPath, {
      method: 'POST', headers: { Origin: 'https://app.test', Cookie: `__Host-dm_access=${token('aal2')}` }, body: form,
    }), authEnv);
    assert.equal(upload.status, 200);
    assert.equal(video.thumbnail_storage_path, savedPath);
    assert.equal((await handleRequest(req(adminPath), authEnv)).status, 403);
    assert.equal((await handleRequest(req(video.thumbnail_url), authEnv)).status, 404);
    const preview = await handleRequest(req(adminPath, 'GET', undefined, 'aal2'), authEnv);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/webp');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), img);
    video.published = true;
    assert.equal((await handleRequest(new Request('https://app.test' + video.thumbnail_url), authEnv)).status, 200);
  });
  assert.deepEqual(calls, ['upload', 'download', 'download']);
});

test('Exclusão despublica primeiro, pode ser repetida após falha e remove os arquivos do vídeo certo', async () => {
  const thumb = `${VIDEO}.webp`;
  const video = { id: VIDEO, title: 'Aula', published: true, status: 'ready', deleted_at: null, bunny_video_id: OTHER, thumbnail_storage_path: thumb, thumbnail_url: `/api/thumbnails/${VIDEO}` };
  const events: string[] = [];
  let failStorage = true;
  await withProvider({ role: 'admin', onFetch: (url, init) => {
    if (url.pathname === '/rest/v1/videos') {
      if (init?.method === 'PATCH') {
        const change = JSON.parse(String(init.body));
        Object.assign(video, change);
        events.push(change.deleted_at ? 'hidden' : 'cleared');
        return new Headers(init.headers).get('Prefer') === 'return=representation' ? response([video]) : response(null, 204);
      }
      return response(url.searchParams.has('published') && !video.published ? [] : [video]);
    }
    if (url.pathname === '/rest/v1/audit_logs') return response(null, 204);
    if (url.hostname === 'video.bunnycdn.com') {
      assert.equal(video.published, false);
      assert.equal(init?.method, 'DELETE');
      assert.equal(url.pathname, `/library/123/videos/${OTHER}`);
      const alreadyDeleted = events.includes('bunny');
      events.push('bunny');
      return alreadyDeleted ? response({}, 404) : response({}, 200);
    }
    if (url.pathname === '/storage/v1/object/thumbnails') {
      assert.equal(init?.method, 'DELETE');
      assert.deepEqual(JSON.parse(String(init.body)), { prefixes: [thumb] });
      events.push('thumbnail');
      return failStorage ? response({}, 503) : response([]);
    }
  } }, async () => {
    const deleteEnv = { ...env, BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'fixture-bunny' };
    const path = `/api/admin/videos/${VIDEO}`;
    assert.equal((await handleRequest(req(path, 'DELETE'), deleteEnv)).status, 403);
    assert.equal(events.length, 0);
    assert.equal((await handleRequest(req(path, 'DELETE', undefined, 'aal2'), deleteEnv)).status, 502);
    assert.ok(video.deleted_at);
    assert.equal(video.published, false);
    assert.equal((await handleRequest(req(path + '/publish', 'POST', { published: true }, 'aal2'), deleteEnv)).status, 404);
    assert.equal((await handleRequest(req(`/api/thumbnails/${VIDEO}`), deleteEnv)).status, 404);
    failStorage = false;
    assert.equal((await handleRequest(req(path, 'DELETE', undefined, 'aal2'), deleteEnv)).status, 200);
    assert.equal(video.bunny_video_id, null);
    assert.equal(video.thumbnail_storage_path, null);
    assert.equal((await handleRequest(req(path, 'DELETE', undefined, 'aal2'), deleteEnv)).status, 200);
  });
  assert.deepEqual(events, ['hidden', 'bunny', 'thumbnail', 'bunny', 'thumbnail', 'cleared']);
});

test('Publicação usa duração real Bunny: permite 180 segundos e recusa qualquer excesso ou duração desconhecida', async () => {
  const streamingEnv = { ...env, BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'bunny-secret', BUNNY_SECURITY_CONFIRMED: 'true' };
  for (const length of [180, 180.001, 181, 0, -1]) {
    const writes: Record<string, unknown>[] = [];
    await withProvider({ role: 'admin', onFetch: (url, init) => {
      if (url.pathname === '/rest/v1/videos') {
        if (init?.method === 'PATCH') { writes.push(JSON.parse(String(init.body))); return response(null, 204); }
        return response([{ id: VIDEO, title: 'Técnica', description: '', difficulty: 'beginner', duration_seconds: 1, thumbnail_url: '/thumb.jpg', status: 'ready', published: true, bunny_video_id: OTHER }]);
      }
      if (url.hostname === 'video.bunnycdn.com') return response({ status: 4, length, encodeProgress: 100 });
      if (url.pathname === '/rest/v1/audit_logs') return response(null, 204);
    } }, async () => {
      const result = await handleRequest(req(`/api/admin/videos/${VIDEO}/publish`, 'POST', { published: true, duration_seconds: 1 }, 'aal2'), streamingEnv);
      assert.equal(result.status, length === 180 ? 200 : 409, `duration ${length}`);
      const body = await result.json() as JsonResult;
      if (length > 180) assert.equal(body.error, 'VIDEO_TOO_LONG');
      if (length <= 0) assert.equal(body.error, 'VIDEO_DURATION_UNAVAILABLE');
      assert.equal(writes.at(-1)?.published, length === 180, 'An earlier published state must also be removed for invalid duration');
    });
  }
});

test('Atualização do processamento mantém vídeo maior que 3 minutos despublicado e informa o motivo', async () => {
  let saved: Record<string, unknown> = {};
  await withProvider({ role: 'admin', onFetch: (url, init) => {
    if (url.pathname === '/rest/v1/videos') {
      if (init?.method === 'PATCH') { saved = JSON.parse(String(init.body)); return response(null, 204); }
      return response([{ id: VIDEO, title: 'Técnica', published: true, bunny_video_id: OTHER }]);
    }
    if (url.hostname === 'video.bunnycdn.com') return response({ status: 4, length: 180.1, encodeProgress: 100 });
    if (url.pathname === '/rest/v1/audit_logs') return response(null, 204);
  } }, async () => {
    const result = await handleRequest(req(`/api/admin/videos/${VIDEO}/refresh`, 'POST', {}, 'aal2'), { ...env, BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'bunny-secret' });
    assert.equal(result.status, 200);
    assert.deepEqual(saved, { status: 'ready', duration_seconds: 181, published: false });
    assert.match(String((await result.json() as JsonResult).publication_error), /3 minutos/);
  });
});

test('Reprodução autorizada não consulta nem retorna materiais de apoio', async () => {
  await withProvider({ entitled: true, onFetch: url => {
    if (url.pathname === '/rest/v1/videos') return response([{ id: VIDEO, title: 'Técnica', description: '', difficulty: 'beginner', duration_seconds: 180, thumbnail_url: '/thumb.jpg', status: 'ready', published: true, bunny_video_id: OTHER }]);
    if (url.pathname === '/rest/v1/rpc/catalog_search') return response({ items: [] });
  } }, async () => {
    const result = await handleRequest(req(`/api/watch/${VIDEO}`), { ...env, BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_EMBED_TOKEN_KEY: 'embed-secret', BUNNY_SECURITY_CONFIRMED: 'true' });
    assert.equal(result.status, 200);
    const body = await result.json() as JsonResult;
    assert.equal('materials' in body, false);
    assert.match(String(body.embed_url), /^https:\/\/player\.mediadelivery\.net\/embed\//);
  });
});
test('Checkout usa preço e conta do pedido atômico, sem confiar no cliente ou em mudança de plano', async () => {
  let preference: Record<string, unknown> = {};
  await withProvider({ onFetch: (url, init) => {
    if (url.pathname === '/rest/v1/settings') {
      const key = url.searchParams.get('key');
      return response([{ value: key === 'eq.plan' ? { enabled: true, amount_cents: 3990, currency: 'BRL', period_days: 30, title: 'Plano' } : { approved: true, terms_approved: true, privacy_approved: true, cancellation_approved: true } }]);
    }
    if (url.pathname === '/rest/v1/rpc/create_payment_order') {
      assert.equal((JSON.parse(String(init?.body)) as { p_user_id: string }).p_user_id, USER);
      return response({ ...order, amount_cents: 1990, plan_title: 'Preço anterior preservado', status: 'pending' });
    }
    if (url.pathname === '/checkout/preferences') {
      preference = JSON.parse(String(init?.body));
      return response({ id: 'preference-1', init_point: 'https://www.mercadopago.com.br/checkout/1', sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/1' });
    }
    if (url.pathname === '/rest/v1/payment_orders' && init?.method === 'PATCH') return response(null, 204);
  } }, async () => {
    const result = await handleRequest(req('/api/checkout', 'POST', { user_id: OTHER, amount_cents: 1, period_days: 366 }), { ...env, PAYMENTS_ENABLED: 'true', BUNNY_SECURITY_CONFIRMED: 'true', BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_EMBED_TOKEN_KEY: 'embed-secret', BUNNY_STREAM_API_KEY: 'stream-secret' });
    assert.equal(result.status, 200);
    assert.equal((await result.json() as { order_id: string }).order_id, ORDER);
  });
  assert.equal(preference.external_reference, ORDER);
  assert.equal((preference.items as { unit_price: number }[])[0].unit_price, 19.9);
});
test('Atualização manual encontra aprovação após tentativa recusada e identifica cada evento pelo pagamento', async () => {
  const eventIds: string[] = []; const processed: string[] = [];
  const oldNow = Date.now; const fixedNow = Date.now(); Date.now = () => fixedNow;
  try {
    await withProvider({ onFetch: (url, init) => {
      if (url.pathname === '/rest/v1/payment_orders') {
        if (url.searchParams.get('select') === 'provider_payment_id') return response([{ provider_payment_id: '111000' }]);
        return response([{ ...order, status: 'rejected', provider_payment_id: '111000' }]);
      }
      if (url.hostname === 'api.mercadopago.com' && url.pathname === '/v1/payments/search') return response({ results: [{ id: 222000, status: 'approved' }, { id: 111000, status: 'rejected' }] });
      if (url.hostname === 'api.mercadopago.com' && url.pathname.startsWith('/v1/payments/')) {
        const id = url.pathname.split('/').pop()!;
        return response({ ...payment, id, status: id === '111000' ? 'rejected' : 'approved' });
      }
      if (url.pathname === '/rest/v1/rpc/process_payment') {
        const data = JSON.parse(String(init?.body)) as Record<string, string>;
        eventIds.push(data.p_event_id); processed.push(data.p_status);
        return response({ processed: true, order_id: ORDER });
      }
    } }, async () => {
      const result = await handleRequest(req(`/api/orders/${ORDER}/refresh`, 'POST', {}), env);
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { refreshed: true, checked: 2, failed: 0 });
    });
  } finally { Date.now = oldNow; }
  assert.deepEqual(processed, ['rejected', 'approved']);
  assert.equal(new Set(eventIds).size, 2);
  assert.ok(eventIds[0].includes(':111000:')); assert.ok(eventIds[1].includes(':222000:'));
});
