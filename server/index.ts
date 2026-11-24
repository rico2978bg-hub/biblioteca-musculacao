import {
  ApiError, assertSameOrigin, email, isoDate, password, sha256, signedEmbed, sniffFile,
  text, tusSignature, uuid, verifyMercadoPagoSignature,
} from './core.ts';
import {
  Supabase, applyProviderPayment, audit, bunny, clearCookies, configured, externalFetch, mercadoPago,
  reconcileOrderPayments, reconcilePayments, requireAccess, requireSession, settings, tokenCookies,
  type Env, type Json, type Session, type User,
} from './services.ts';
import type { PaymentOrder } from './core.ts';
import {serveSite,siteRedirect,runtimeConfig} from './seo.ts';

type Video = {
  id: string; title: string; exercise?: string; description: string; difficulty: string; duration_seconds: number;
  thumbnail_url: string | null; thumbnail_storage_path?: string | null; status: string;
  published: boolean; bunny_video_id?: string | null; keywords?: string[];
  deleted_at?: string | null;
  video_taxonomies?: { taxonomies: { id: string; kind: string; name: string; slug: string } }[];
};
const videoSelect = 'id,title,exercise,description,difficulty,duration_seconds,thumbnail_url,keywords,status,published,bunny_video_id,thumbnail_storage_path,video_taxonomies(taxonomies(id,kind,name,slug))';
const adminVideoSelect = videoSelect + ',deleted_at';
const adminVideoFilters = { or: '(deleted_at.is.null,bunny_video_id.not.is.null,thumbnail_storage_path.not.is.null,thumbnail_url.not.is.null)' };
const defaultContacts = {
  instagram_url: 'https://www.instagram.com/seu_perfil/',
  whatsapp_number: '5511900000000',
};
const maxVideoSeconds = 180;
const safeVideo = (video: Video) => ({
  id: video.id, title: video.title, exercise: video.exercise || '', description: video.description, difficulty: video.difficulty,
  duration_seconds: video.duration_seconds, thumbnail_url: video.thumbnail_url, keywords: video.keywords || [],
  taxonomies: (video.video_taxonomies || []).map(v => v.taxonomies),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function boundedBytes(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > max) throw new ApiError(413, 'FILE_TOO_LARGE', 'O arquivo ou solicitação excede o tamanho permitido.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { await reader.cancel(); throw new ApiError(413, 'FILE_TOO_LARGE', 'O arquivo ou solicitação excede o tamanho permitido.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function bodyJson(request: Request): Promise<Json> {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', 'Envie os dados em JSON.');
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await boundedBytes(request, 32_768)));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed as Json;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_JSON', 'Solicitação inválida.');
  }
}

function pageParams(url: URL, max = 50): Record<string, string> {
  const cursor = url.searchParams.get('cursor');
  return { order: 'id.asc', limit: String(max), ...(cursor ? { id: `gt.${uuid(cursor)}` } : {}) };
}

async function adminPage(sb: Supabase, table: string, select: string, url: URL, filters: Record<string, string> = {}): Promise<Response> {
  const rows = await sb.db<Json[]>(table, 'GET', undefined, { select, ...pageParams(url, 51), ...filters });
  const items = rows.slice(0, 50);
  return json({ items, next_cursor: rows.length > 50 ? items[items.length - 1].id : null });
}

async function getVideo(sb: Supabase, id: string, publicOnly = true): Promise<Video> {
  const [video] = await sb.db<Video[]>('videos', 'GET', undefined, {
    id: `eq.${uuid(id)}`, select: publicOnly ? videoSelect : adminVideoSelect, limit: '1',
    ...(publicOnly ? { published: 'eq.true', status: 'eq.ready' } : {}),
  });
  if (!video) throw new ApiError(404, 'CONTENT_UNAVAILABLE', 'Este conteúdo está indisponível.');
  return video;
}

function planReady(env: Env, plan: Json, legal: Json): boolean {
  return env.PAYMENTS_ENABLED === 'true' && plan.enabled === true && legal.approved === true &&
    env.BUNNY_SECURITY_CONFIRMED === 'true' && !!env.BUNNY_STREAM_LIBRARY_ID && !!env.BUNNY_EMBED_TOKEN_KEY && !!env.BUNNY_STREAM_API_KEY &&
    legal.cancellation_approved === true && legal.terms_approved === true && legal.privacy_approved === true &&
    Number.isSafeInteger(plan.amount_cents) && Number(plan.amount_cents) >= 100 && Number(plan.amount_cents) <= 10_000_000 && plan.currency === 'BRL' &&
    Number.isInteger(plan.period_days) && Number(plan.period_days) >= 1 && Number(plan.period_days) <= 366 &&
    !!env.MERCADO_PAGO_ACCESS_TOKEN && !!env.MERCADO_PAGO_WEBHOOK_SECRET && !!env.MERCADO_PAGO_COLLECTOR_ID &&
    ['true', 'false'].includes(String(env.MERCADO_PAGO_LIVE_MODE));
}

async function publicConfig(env: Env): Promise<Response> {
  const ready = !!env.SUPABASE_URL && !!env.SUPABASE_ANON_KEY && !!env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ready) return json({ configured: false, demo: true, contacts: { instagram: defaultContacts.instagram_url, whatsapp: `https://wa.me/${defaultContacts.whatsapp_number}` }, plan: { enabled: false, price_cents: null, period_days: null, name: 'Acesso à biblioteca' } });
  const sb = new Supabase(env);
  const [config, plan, legal] = await Promise.all([settings(sb, 'public'), settings(sb, 'plan'), settings(sb, 'legal')]);
  return json({
    configured: true, demo: false,
    contacts: { instagram: config.instagram_url ?? defaultContacts.instagram_url, whatsapp: (config.whatsapp_number ?? defaultContacts.whatsapp_number) ? `https://wa.me/${config.whatsapp_number ?? defaultContacts.whatsapp_number}` : null },
    plan: { enabled: planReady(env, plan, legal), price_cents: plan.amount_cents || null, period_days: plan.period_days || null, name: plan.title || 'Acesso à biblioteca', renewal: 'manual' },
    banner: { enabled: config.banner_enabled === true, title: config.banner_title || '', text: config.banner_text || '', url: config.banner_url || '' },
    logo_url: config.logo_url || null,
  });
}

async function authRoutes(request: Request, env: Env, sb: Supabase, path: string, cookies: string[]): Promise<Response> {
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  const body = await bodyJson(request);
  const action = path.slice('/api/auth/'.length);
  await sb.rate(request, `auth:${action}`, action === 'signin' ? 10 : 5, 900);
  if (action === 'signup') {
    const address = email(body.email);
    await sb.rate(request, 'auth:email', 3, 3600, address);
    await sb.auth('/signup', 'POST', { email: address, password: password(body.password), data: { display_name: text(body.display_name || '', 100) } });
    // Even if Auth is misconfigured to auto-confirm, never auto-create an entitled session here.
    return json({ message: 'Se o cadastro puder ser realizado, você receberá um e-mail para confirmar sua conta.' }, 202);
  }
  if (action === 'signin') {
    const address = email(body.email);
    await sb.rate(request, 'signin:email', 15, 900, address);
    if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) throw new ApiError(400, 'INVALID_INPUT', 'Informe sua senha.');
    const data = await sb.auth<{ access_token: string; refresh_token: string; expires_in: number; user: User }>('/token?grant_type=password', 'POST', { email: address, password: body.password });
    if (!data.user.email_confirmed_at) throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Confirme seu e-mail antes de entrar.');
    const [profile] = await sb.db<Json[]>('profiles', 'GET', undefined, { id: `eq.${data.user.id}`, select: 'enabled,role', limit: '1' });
    if (!profile || profile.enabled !== true) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Esta conta está bloqueada.');
    tokenCookies(data, cookies);
    return json({ signed_in: true, mfa_required: profile.role === 'admin' });
  }
  if (action === 'recover') {
    const address = email(body.email);
    await sb.rate(request, 'recover:email', 3, 3600, address);
    try { await sb.auth('/recover', 'POST', { email: address }); }
    catch (error) { if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) throw error; }
    return json({ message: 'Se houver uma conta elegível, enviaremos as instruções de recuperação.' }, 202);
  }
  if (action === 'confirm') {
    const type = text(body.type, 20, true);
    if (!['signup', 'recovery', 'invite', 'email'].includes(type)) throw new ApiError(400, 'INVALID_TOKEN_TYPE', 'Link inválido.');
    const data = await sb.auth<{ access_token: string; refresh_token: string; expires_in: number; user: User }>('/verify', 'POST', { type, token_hash: text(body.token_hash, 512, true) });
    if (!data.user?.email_confirmed_at) throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Não foi possível confirmar este e-mail.');
    tokenCookies(data, cookies);
    return json({ verified: true, set_password: type === 'recovery' || type === 'invite' });
  }
  if (action === 'signout') {
    try { const session = await requireSession(request, sb, cookies); await sb.auth('/logout?scope=global', 'POST', undefined, session.accessToken); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) console.error(JSON.stringify({ event: 'logout_revoke_failed' }));
    }
    finally { clearCookies(cookies); }
    return json({ signed_out: true });
  }
  const session = await requireSession(request, sb, cookies, action.startsWith('mfa/'), action.startsWith('mfa/'));
  if (action === 'reset') {
    await sb.auth('/user', 'PUT', { password: password(body.password) }, session.accessToken);
    // A global logout invalidates refresh tokens; old access tokens remain valid until their short expiry.
    await sb.auth('/logout?scope=global', 'POST', undefined, session.accessToken);
    clearCookies(cookies);
    return json({ message: 'Senha atualizada. Entre novamente na sua conta.' });
  }
  if (action === 'mfa/enroll') {
    const verifiedFactor = (session.user.factors || []).some(f => f.status === 'verified');
    if (verifiedFactor && session.aal !== 'aal2') throw new ApiError(403, 'MFA_REQUIRED', 'Confirme seu autenticador atual primeiro.');
    const data = await sb.auth<Json>('/factors', 'POST', { factor_type: 'totp', friendly_name: 'Biblioteca de Musculação' }, session.accessToken);
    return json(data);
  }
  if (action === 'mfa/verify') {
    const factor = uuid(body.factor_id);
    const code = text(body.code, 6, true);
    if (!/^\d{6}$/.test(code) || !(session.user.factors || []).some(f => f.id === factor)) throw new ApiError(400, 'INVALID_MFA', 'Código de autenticação inválido.');
    const challenge = await sb.auth<{ id: string }>(`/factors/${factor}/challenge`, 'POST', {}, session.accessToken);
    const data = await sb.auth<{ access_token: string; refresh_token: string; expires_in: number; user: User }>(`/factors/${factor}/verify`, 'POST', { challenge_id: challenge.id, code }, session.accessToken);
    tokenCookies(data, cookies);
    return json({ verified: true });
  }
  throw new ApiError(404, 'NOT_FOUND', 'Função não encontrada.');
}

async function account(request: Request, sb: Supabase, session: Session): Promise<Response> {
  if (request.method === 'PATCH') {
    const body = await bodyJson(request);
    const displayName = text(body.display_name, 100, true);
    await sb.db('profiles', 'PATCH', { display_name: displayName }, { id: `eq.${session.user.id}` }, false);
    return json({ display_name: displayName });
  }
  if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  const filter = { user_id: `eq.${session.user.id}` };
  const [grants, subscriptions, orders, favorites, entitled] = await Promise.all([
    sb.db('memberships', 'GET', undefined, { ...filter, select: 'id,status,starts_at,expires_at,cancelled_at', order: 'created_at.desc', limit: '100' }),
    sb.db('subscriptions', 'GET', undefined, { ...filter, select: 'id,status,period_start,period_end,order_id', order: 'created_at.desc', limit: '100' }),
    sb.db('payment_orders', 'GET', undefined, { ...filter, select: 'id,amount_cents,currency,period_days,status,paid_at,access_until,created_at', order: 'created_at.desc', limit: '30' }),
    sb.db<{ video_id: string }[]>('favorites', 'GET', undefined, { ...filter, select: 'video_id', limit: '1000' }),
    sb.rpc<boolean>('has_access', { p_user_id: session.user.id }),
  ]);
  return json({
    user: { id: session.user.id, email: session.user.email }, profile: session.profile,
    entitlement: session.profile.role === 'admin' ? session.aal === 'aal2' : entitled,
    grants, subscriptions, orders, favorites: favorites.map(f => f.video_id), aal: session.aal,
    factors: (session.user.factors || []).map(f => ({ id: f.id, status: f.status, factor_type: f.factor_type })),
  });
}

async function checkout(request: Request, env: Env, sb: Supabase, session: Session): Promise<Response> {
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  await sb.rate(request, 'checkout', 3, 300, session.user.id);
  const [plan, legal] = await Promise.all([settings(sb, 'plan'), settings(sb, 'legal')]);
  if (!planReady(env, plan, legal)) throw new ApiError(503, 'CHECKOUT_PENDING', 'As condições comerciais e a configuração de pagamentos aguardam aprovação.');
  // Atomic account lock prevents duplicate orders from simultaneous clicks. The database
  // returns the immutable price/period snapshot and rejects overlapping paid terms.
  const order = await sb.rpc<PaymentOrder>('create_payment_order', {
    p_user_id: session.user.id, p_amount_cents: plan.amount_cents, p_period_days: plan.period_days,
    p_plan_title: text(plan.title || 'Acesso à biblioteca Biblioteca de Musculação', 180, true),
  });
  if (order.provider_preference_id) {
    const preference = await mercadoPago<{ init_point: string; sandbox_init_point: string }>(env, `/checkout/preferences/${encodeURIComponent(order.provider_preference_id)}`);
    return json({ order_id: order.id, checkout_url: env.MERCADO_PAGO_LIVE_MODE === 'true' ? preference.init_point : preference.sandbox_init_point });
  }
  const orderId = order.id;
  const origin = env.APP_ORIGIN!;
  const preference = await mercadoPago<{ id: string; init_point: string; sandbox_init_point: string }>(env, '/checkout/preferences', 'POST', {
    items: [{ id: orderId, title: order.plan_title || 'Acesso à biblioteca', quantity: 1, currency_id: 'BRL', unit_price: order.amount_cents / 100 }],
    payer: { email: session.user.email }, external_reference: orderId,
    back_urls: { success: `${origin}/?retorno=sucesso#assinatura`, pending: `${origin}/?retorno=pendente#assinatura`, failure: `${origin}/?retorno=falha#assinatura` },
    notification_url: `${origin}/api/webhooks/mercadopago`, auto_return: 'approved',
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }], installments: 1 },
    expires: true, expiration_date_to: new Date(Date.now() + 24 * 3600_000).toISOString(),
    metadata: { order_id: orderId },
  }, orderId);
  await sb.db('payment_orders', 'PATCH', { provider_preference_id: preference.id }, { id: `eq.${orderId}` }, false);
  return json({ order_id: orderId, checkout_url: env.MERCADO_PAGO_LIVE_MODE === 'true' ? preference.init_point : preference.sandbox_init_point });
}

async function storageUpload(request: Request, sb: Supabase): Promise<{ path: string }> {
  const max = 2 * 1024 * 1024;
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.startsWith('multipart/form-data;')) throw new ApiError(415, 'MULTIPART_REQUIRED', 'Selecione um arquivo.');
  const bytes = await boundedBytes(request, max + 32_768);
  let fields: FormData;
  try { fields = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new ApiError(400, 'INVALID_UPLOAD_FORM', 'Não foi possível ler a miniatura. Selecione a imagem novamente.'); }
  const file = fields.get('file');
  if (!file || typeof file === 'string' || file.size < 8 || file.size > max) throw new ApiError(413, 'INVALID_FILE_SIZE', 'A miniatura deve ter até 2 MB.');
  const data = new Uint8Array(await file.arrayBuffer());
  const mime = sniffFile(data, 'thumbnail');
  const extension = mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : 'jpg';
  const path = `${crypto.randomUUID()}.${extension}`;
  const message = 'Não foi possível salvar a miniatura no armazenamento.';
  const response = await externalFetch(`${sb.url}/storage/v1/object/thumbnails/${path}`, {
    method: 'POST', headers: { ...sb.headers(true), 'Content-Type': mime, 'x-upsert': 'false' },
    body: data,
  }, message, 20_000);
  if (!response.ok) throw new ApiError(502, 'UPLOAD_FAILED', message);
  return { path };
}

async function storageThumbnail(sb: Supabase, path?: string | null): Promise<Response> {
  if (!path || !/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(path)) throw new ApiError(404, 'THUMBNAIL_UNAVAILABLE', 'Miniatura indisponível.');
  const response = await externalFetch(`${sb.url}/storage/v1/object/authenticated/thumbnails/${path}`, {
    headers: sb.headers(true),
  }, 'Não foi possível carregar a miniatura.', 10_000);
  if (!response.ok) throw new ApiError(404, 'THUMBNAIL_UNAVAILABLE', 'Miniatura indisponível.');
  const mime = path.endsWith('.webp') ? 'image/webp' : path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return new Response(response.body, { headers: { 'Content-Type': mime } });
}

async function deleteThumbnail(sb: Supabase, path: string): Promise<void> {
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(path)) throw new ApiError(409, 'INVALID_THUMBNAIL_PATH', 'A miniatura antiga precisa ser revisada antes de concluir a exclusão.');
  const response = await externalFetch(`${sb.url}/storage/v1/object/thumbnails`, {
    method: 'DELETE', headers: { ...sb.headers(true), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }),
  }, 'Não foi possível excluir a miniatura. Tente concluir a exclusão novamente.');
  if (!response.ok) throw new ApiError(502, 'THUMBNAIL_DELETE_FAILED', 'Não foi possível excluir a miniatura. Tente concluir a exclusão novamente.');
  await response.body?.cancel();
}

async function deleteBunnyVideo(env: Env, id: string): Promise<void> {
  try { await bunny(env, `/videos/${uuid(id)}`, 'DELETE'); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
}

async function deleteVideo(sb: Supabase, env: Env, actor: string, video: Video): Promise<Response> {
  const { id } = video;
  if (!video.deleted_at) {
    const [marked] = await sb.db<Video[]>('videos', 'PATCH', { published: false, deleted_at: new Date().toISOString() }, {
      id: `eq.${id}`, deleted_at: 'is.null', select: 'id,deleted_at,bunny_video_id,thumbnail_storage_path,thumbnail_url',
    });
    video = marked || await getVideo(sb, id, false);
    if (marked) await audit(sb, actor, 'video.deletion_requested', 'video', id);
  }
  if (video.bunny_video_id) await deleteBunnyVideo(env, video.bunny_video_id);
  if (video.thumbnail_storage_path) await deleteThumbnail(sb, video.thumbnail_storage_path);
  if (video.bunny_video_id != null || video.thumbnail_storage_path != null || video.thumbnail_url != null) {
    await sb.db('videos', 'PATCH', { bunny_video_id: null, thumbnail_storage_path: null, thumbnail_url: null }, { id: `eq.${id}`, deleted_at: 'not.is.null' }, false);
  }
  return json({ deleted: true });
}

async function adminRoutes(request: Request, env: Env, sb: Supabase, session: Session, url: URL): Promise<Response> {
  const path = url.pathname; const method = request.method; const actor = session.user.id;
  await sb.rate(request, 'admin', 120, 60, actor);
  if (path === '/api/admin/access-records' && method === 'GET') {
    const kind = url.searchParams.get('kind');
    if (!kind || !['memberships', 'subscriptions', 'payment_orders'].includes(kind)) throw new ApiError(400, 'INVALID_LIST', 'Lista administrativa inválida.');
    const records = await sb.db<{id:string}[]>(kind, 'GET', undefined, { select: kind === 'payment_orders' ? 'id,user_id,status,amount_cents,currency,created_at,access_until' : '*', ...pageParams(url, 51) });
    return json({ items: records.slice(0,50), next_cursor: records.length > 50 ? records[49].id : null });
  }
  if (path === '/api/admin/overview' && method === 'GET') {
    const [users, authUsers, videos, grants, subscriptions, orders] = await Promise.all([
      sb.db('profiles', 'GET', undefined, { select: 'id,display_name,role,enabled,created_at', limit: '500' }),
      sb.auth<{ users: User[] }>('/admin/users?page=1&per_page=1000', 'GET', undefined, undefined, true),
      sb.db('videos', 'GET', undefined, { select: adminVideoSelect, order: 'created_at.desc', limit: '500', ...adminVideoFilters }),
      sb.db('memberships', 'GET', undefined, { select: '*', order: 'created_at.desc', limit: '1000' }),
      sb.db('subscriptions', 'GET', undefined, { select: '*', order: 'created_at.desc', limit: '1000' }),
      sb.db('payment_orders', 'GET', undefined, { select: 'id,user_id,status,amount_cents,currency,created_at,access_until', order: 'created_at.desc', limit: '100' }),
    ]);
    const addresses = new Map((authUsers.users || []).map(user => [user.id, user.email]));
    return json({ users: users.map(user => ({ ...user, email: addresses.get(String(user.id)) || '' })), videos, grants, subscriptions, orders });
  }
  if (path === '/api/admin/users' && method === 'GET') {
    const page = Number(url.searchParams.get('page') || '1');
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw new ApiError(400, 'INVALID_PAGE', 'Página inválida.');
    const auth = await sb.auth<{ users: User[]; next_page?: number }>('/admin/users?' + new URLSearchParams({ page: String(page), per_page: '50' }), 'GET', undefined, undefined, true);
    const ids = (auth.users || []).map(user => uuid(user.id));
    const profiles = ids.length ? await sb.db('profiles', 'GET', undefined, { id: `in.(${ids.join(',')})`, select: 'id,display_name,role,enabled,created_at' }) : [];
    const addresses = new Map((auth.users || []).map(user => [user.id, user.email]));
    return json({ items: profiles.map(profile => ({ ...profile, email: addresses.get(String(profile.id)) || '' })), next_page: auth.next_page || (ids.length === 50 ? page + 1 : null) });
  }
  if (path === '/api/admin/users/invite' && method === 'POST') {
    const body = await bodyJson(request); const address = email(body.email);
    const invited = await sb.auth<User>('/invite', 'POST', { email: address, data: { display_name: text(body.display_name || '', 100) } }, undefined, true);
    await audit(sb, actor, 'user.invited', 'profile', invited.id);
    return json({ id: invited.id, message: 'Convite enviado. O aluno definirá a própria senha.' }, 201);
  }
  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/(block|grants)$/);
  if (userMatch) {
    const id = uuid(userMatch[1]); const body = await bodyJson(request);
    if (userMatch[2] === 'block' && method === 'PATCH') {
      if (typeof body.enabled !== 'boolean' || id === actor) throw new ApiError(400, 'INVALID_ACCOUNT_CHANGE', 'Não é possível bloquear sua própria conta.');
      await sb.db('profiles', 'PATCH', { enabled: body.enabled }, { id: `eq.${id}` }, false);
      await audit(sb, actor, body.enabled ? 'account.enabled' : 'account.blocked', 'profile', id);
      return json({ enabled: body.enabled });
    }
    if (userMatch[2] === 'grants' && method === 'POST') {
      const expiry = isoDate(body.expires_at);
      if (expiry && Date.parse(expiry) <= Date.now()) throw new ApiError(400, 'INVALID_DATE', 'A validade precisa estar no futuro.');
      const [grant] = await sb.db<Json[]>('memberships', 'POST', { user_id: id, granted_by: actor, status: 'active', starts_at: new Date().toISOString(), expires_at: expiry });
      await audit(sb, actor, 'membership.granted', 'membership', String(grant.id), { user_id: id, expires_at: expiry });
      return json(grant, 201);
    }
  }
  const grantMatch = path.match(/^\/api\/admin\/grants\/([^/]+)$/);
  if (grantMatch && method === 'PATCH') {
    const id = uuid(grantMatch[1]); const body = await bodyJson(request);
    if (!['active', 'cancelled'].includes(String(body.status))) throw new ApiError(400, 'INVALID_STATUS', 'Situação de matrícula inválida.');
    const update: Json = { status: body.status, cancelled_at: body.status === 'cancelled' ? new Date().toISOString() : null };
    if (body.expires_at !== undefined) update.expires_at = isoDate(body.expires_at);
    if (update.expires_at && Date.parse(String(update.expires_at)) <= Date.now()) throw new ApiError(400, 'INVALID_DATE', 'A validade precisa estar no futuro.');
    const rows = await sb.db('memberships', 'PATCH', update, { id: `eq.${id}` });
    await audit(sb, actor, body.status === 'active' ? 'membership.reactivated' : 'membership.cancelled', 'membership', id);
    return json({ items: rows });
  }
  if (path === '/api/admin/taxonomies') {
    if (method === 'GET') return json({ items: await sb.db('taxonomies', 'GET', undefined, { select: '*', order: 'kind.asc,name.asc' }) });
    if (method === 'POST') {
      const body = await bodyJson(request);
      if (!['muscle', 'category', 'equipment'].includes(String(body.kind))) throw new ApiError(400, 'INVALID_TAXONOMY', 'Tipo de categoria inválido.');
      const slug = text(body.slug, 80, true);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, 'INVALID_SLUG', 'Use letras sem acentos, números e hífens no identificador.');
      const [row] = await sb.db<Json[]>('taxonomies', 'POST', { name: text(body.name, 100, true), slug, kind: body.kind });
      await audit(sb, actor, 'taxonomy.created', 'taxonomy', String(row.id));
      return json(row, 201);
    }
  }
  const taxonomyMatch = path.match(/^\/api\/admin\/taxonomies\/([^/]+)$/);
  if (taxonomyMatch && (method === 'PATCH' || method === 'DELETE')) {
    const id = uuid(taxonomyMatch[1]);
    const update = method === 'PATCH' ? { name: text((await bodyJson(request)).name, 100, true) } : undefined;
    await sb.db('taxonomies', method, update, { id: `eq.${id}` }, false);
    await audit(sb, actor, method === 'PATCH' ? 'taxonomy.updated' : 'taxonomy.deleted', 'taxonomy', id);
    return json({ saved: true });
  }
  if (path === '/api/admin/videos') {
    if (method === 'GET') return adminPage(sb, 'videos', adminVideoSelect, url, adminVideoFilters);
    if (method === 'POST') {
      const body = await bodyJson(request);
      const [row] = await sb.db<Json[]>('videos', 'POST', { title: text(body.title, 180, true), description: '', difficulty: 'beginner', status: 'draft', published: false, duration_seconds: 0, keywords: [] });
      await audit(sb, actor, 'video.created', 'video', String(row.id));
      return json(row, 201);
    }
  }
  const videoMatch = path.match(/^\/api\/admin\/videos\/([^/]+)(?:\/(upload|refresh|publish|thumbnail))?$/);
  if (videoMatch) {
    const id = uuid(videoMatch[1]); const action = videoMatch[2]; const video = await getVideo(sb, id, false);
    if (!action && method === 'DELETE') return deleteVideo(sb, env, actor, video);
    if (video.deleted_at) throw new ApiError(404, 'CONTENT_UNAVAILABLE', 'Este vídeo está excluído ou aguarda a conclusão da exclusão.');
    const active = { id: `eq.${id}`, deleted_at: 'is.null' };
    if (!action && method === 'GET') return json(video);
    if (!action && method === 'PATCH') {
      const body = await bodyJson(request); const update: Json = {};
      if (body.title !== undefined) update.title = text(body.title, 180, true);
      if (body.exercise !== undefined) update.exercise = text(body.exercise, 180);
      if (body.description !== undefined) update.description = text(body.description, 8000);
      if (body.difficulty !== undefined) {
        if (!['beginner', 'intermediate', 'advanced'].includes(String(body.difficulty))) throw new ApiError(400, 'INVALID_LEVEL', 'Dificuldade inválida.');
        update.difficulty = body.difficulty;
      }
      if (body.keywords !== undefined) {
        if (!Array.isArray(body.keywords) || body.keywords.length > 30) throw new ApiError(400, 'INVALID_KEYWORDS', 'Informe até 30 palavras-chave.');
        update.keywords = body.keywords.map(v => text(v, 80, true));
      }
      if (Object.keys(update).length) await sb.db('videos', 'PATCH', update, active, false);
      if (body.taxonomy_ids !== undefined) {
        if (!Array.isArray(body.taxonomy_ids) || body.taxonomy_ids.length > 40) throw new ApiError(400, 'INVALID_CATEGORIES', 'Categorias inválidas.');
        await sb.rpc('replace_video_taxonomies', { p_video_id: id, p_taxonomy_ids: [...new Set(body.taxonomy_ids.map(uuid))] });
      }
      await audit(sb, actor, 'video.updated', 'video', id);
      return json({ saved: true });
    }
    if (action === 'upload' && method === 'POST') {
      configured(env, 'BUNNY_STREAM_API_KEY', 'BUNNY_STREAM_LIBRARY_ID');
      let providerId = video.bunny_video_id;
      if (providerId) {
        const remote = await bunny<{ status: number }>(env, `/videos/${uuid(providerId)}`);
        if (remote.status !== 0) {
          const message = remote.status === 4 ? 'Este vídeo já está pronto. Para enviar outra aula, use Novo vídeo.'
            : [5, 6].includes(remote.status) ? 'O envio anterior falhou no Bunny. Crie um novo rascunho para reenviar.'
            : 'O Bunny já recebeu o arquivo. Clique em Atualizar processamento para conferir o estado.';
          throw new ApiError(409, 'UPLOAD_ALREADY_STARTED', message);
        }
      } else {
        const remote = await bunny<{ guid: string }>(env, '/videos', 'POST', { title: video.title });
        providerId = uuid(remote.guid);
        const [linked] = await sb.db('videos', 'PATCH', { bunny_video_id: providerId, status: 'processing', published: false }, {
          ...active, bunny_video_id: 'is.null', select: 'id',
        });
        if (!linked) {
          await deleteBunnyVideo(env, providerId);
          throw new ApiError(409, 'VIDEO_CHANGED', 'O vídeo mudou durante o envio. Atualize o painel e tente novamente.');
        }
      }
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const signature = await tusSignature(env.BUNNY_STREAM_LIBRARY_ID!, env.BUNNY_STREAM_API_KEY!, providerId, expires);
      await audit(sb, actor, 'video.upload_authorized', 'video', id);
      return json({ endpoint: 'https://video.bunnycdn.com/tusupload', videoId: providerId, libraryId: env.BUNNY_STREAM_LIBRARY_ID, expirationTime: expires, signature });
    }
    if ((action === 'refresh' || action === 'publish') && method === 'POST') {
      const body = await bodyJson(request);
      if (action === 'publish' && body.published === false) {
        await sb.db('videos', 'PATCH', { published: false }, active, false);
        await audit(sb, actor, 'video.unpublished', 'video', id);
        return json({ published: false });
      }
      if (!video.bunny_video_id) throw new ApiError(409, 'VIDEO_NOT_UPLOADED', 'Envie o vídeo antes de publicar.');
      const remote = await bunny<{ status: number; length: number; encodeProgress: number }>(env, `/videos/${uuid(video.bunny_video_id)}`);
      const status = remote.status === 4 ? 'ready' : [5, 6].includes(remote.status) ? 'failed' : 'processing';
      // Check the actual provider duration before rounding for the integer display column.
      // Even 180.1 seconds exceeds this version's three-minute requirement.
      const validDuration = Number.isFinite(remote.length) && remote.length > 0;
      const tooLong = validDuration && remote.length > maxVideoSeconds;
      const update: Json = { status, duration_seconds: validDuration ? Math.ceil(remote.length) : 0 };
      if (status !== 'ready' || !validDuration || tooLong) update.published = false;
      if (action === 'publish') {
        if (status !== 'ready') throw new ApiError(409, 'VIDEO_PROCESSING', 'Aguarde a conclusão do processamento antes de publicar.');
        if (!validDuration || tooLong) {
          await sb.db('videos', 'PATCH', update, active, false);
          await audit(sb, actor, 'video.publication_rejected', 'video', id, { reason: tooLong ? 'duration_limit' : 'duration_unavailable' });
          throw new ApiError(409, tooLong ? 'VIDEO_TOO_LONG' : 'VIDEO_DURATION_UNAVAILABLE', tooLong ? 'O vídeo deve ter no máximo 3 minutos. Envie uma versão com até 180 segundos.' : 'A duração do vídeo ainda não foi confirmada. Atualize o processamento antes de publicar.');
        }
        if (env.BUNNY_SECURITY_CONFIRMED !== 'true') throw new ApiError(503, 'STREAM_SECURITY_PENDING', 'Confirme a proteção de reprodução no serviço de streaming antes de publicar.');
        if (!video.thumbnail_url) throw new ApiError(409, 'THUMBNAIL_REQUIRED', 'Envie uma miniatura antes de publicar.');
        update.published = true;
      }
      await sb.db('videos', 'PATCH', update, active, false);
      await audit(sb, actor, action === 'publish' ? 'video.published' : 'video.status_refreshed', 'video', id, { status });
      return json({ ...update, encode_progress: remote.encodeProgress || 0, ...(tooLong ? { publication_error: 'O vídeo deve ter no máximo 3 minutos. Envie uma versão com até 180 segundos.' } : {}) });
    }
    if (action === 'thumbnail' && method === 'GET') return storageThumbnail(sb, video.thumbnail_storage_path);
    if (action === 'thumbnail' && method === 'POST') {
      const file = await storageUpload(request, sb);
      const [saved] = await sb.db('videos', 'PATCH', { thumbnail_storage_path: file.path, thumbnail_url: `/api/thumbnails/${id}` }, { ...active, select: 'id' });
      if (!saved) {
        await deleteThumbnail(sb, file.path);
        throw new ApiError(409, 'VIDEO_CHANGED', 'O vídeo mudou durante o envio da miniatura. Atualize o painel e tente novamente.');
      }
      await audit(sb, actor, 'video.thumbnail_uploaded', 'video', id);
      return json({ thumbnail_url: `/api/thumbnails/${id}` });
    }
  }
  if (path === '/api/admin/settings') {
    if (method === 'GET') return json({ public: { ...defaultContacts, ...await settings(sb, 'public') }, plan: await settings(sb, 'plan'), legal: await settings(sb, 'legal') });
    if (method === 'PATCH') {
      const body = await bodyJson(request); const key = String(body.key);
      if (!['public', 'plan', 'legal'].includes(key) || !body.value || Array.isArray(body.value) || typeof body.value !== 'object') throw new ApiError(400, 'INVALID_SETTINGS', 'Configuração inválida.');
      const value = body.value as Json; const safe: Json = {};
      if (key === 'public') {
        for (const k of ['banner_title', 'banner_text']) if (value[k] !== undefined) safe[k] = text(value[k], k === 'banner_text' ? 500 : 120);
        if (value.banner_enabled !== undefined) safe.banner_enabled = value.banner_enabled === true;
        for (const k of ['instagram_url', 'banner_url', 'logo_url']) {
          if (value[k] === undefined) continue;
          const raw = text(value[k], 500); if (raw) {
            let link: URL; try { link = new URL(raw); } catch { throw new ApiError(400, 'INVALID_URL', 'Informe um endereço HTTPS válido.'); }
            if (link.protocol !== 'https:' || (k === 'instagram_url' && !['instagram.com', 'www.instagram.com'].includes(link.hostname))) throw new ApiError(400, 'INVALID_URL', 'Endereço não permitido.');
          }
          safe[k] = raw;
        }
        if (value.whatsapp_number !== undefined) {
          const number = text(value.whatsapp_number, 15);
          if (number && !/^\d{10,15}$/.test(number)) throw new ApiError(400, 'INVALID_CONTACT', 'Informe DDI, DDD e número, somente dígitos.');
          safe.whatsapp_number = number;
        }
      } else if (key === 'plan') {
        if (!Number.isSafeInteger(value.amount_cents) || Number(value.amount_cents) < 100 || Number(value.amount_cents) > 10_000_000 || !Number.isInteger(value.period_days) || Number(value.period_days) < 1 || Number(value.period_days) > 366) throw new ApiError(400, 'INVALID_PLAN', 'Defina valor em centavos e prazo entre 1 e 366 dias.');
        Object.assign(safe, { enabled: value.enabled === true, title: text(value.title, 180, true), amount_cents: value.amount_cents, period_days: value.period_days, currency: 'BRL' });
      } else {
        for (const k of ['approved', 'cancellation_approved', 'terms_approved', 'privacy_approved']) safe[k] = value[k] === true;
        safe.approved_at = new Date().toISOString(); safe.approved_by = actor;
      }
      const current = await settings(sb, key);
      await sb.db('settings', 'PATCH', { value: { ...current, ...safe } }, { key: `eq.${key}` }, false);
      await audit(sb, actor, 'settings.updated', 'settings', key, { fields: Object.keys(safe) });
      return json({ saved: true });
    }
  }
  if (path === '/api/admin/reconcile' && method === 'POST') {
    await sb.rate(request, 'reconcile', 1, 300, actor);
    const result = await reconcilePayments(env, sb);
    await audit(sb, actor, 'payments.reconciled', 'payments', 'batch', result);
    return json(result);
  }
  throw new ApiError(404, 'NOT_FOUND', 'Função administrativa não encontrada.');
}

async function api(request: Request, env: Env, cookies: string[]): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  // Supporting files are outside this version, including every legacy admin/download path.
  // Keep any historical database rows and private objects; do not issue new authorizations.
  if (/^\/api\/(?:admin\/)?materials(?:\/|$)/.test(path)) throw new ApiError(404, 'NOT_FOUND', 'Página não encontrada.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path !== '/api/webhooks/mercadopago') {
    configured(env, 'APP_ORIGIN'); assertSameOrigin(request, env.APP_ORIGIN!);
  }
  if (path === '/api/health' && method === 'GET') return json({ ok: true, application: 'Biblioteca de Musculação', configured: !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY });
  if (path === '/api/config' && method === 'GET') return publicConfig(env);
  const sb = new Supabase(env);
  if (path === '/api/webhooks/mercadopago' && method === 'POST') {
    configured(env, 'MERCADO_PAGO_WEBHOOK_SECRET');
    if (!await verifyMercadoPagoSignature(request, env.MERCADO_PAGO_WEBHOOK_SECRET!)) throw new ApiError(401, 'INVALID_WEBHOOK', 'Notificação não autenticada.');
    const body = await bodyJson(request);
    const data = body.data as Json | undefined;
    const dataId = url.searchParams.get('data.id')!;
    if (body.type !== 'payment' || String(data?.id) !== dataId || !/^\d{1,30}$/.test(dataId)) throw new ApiError(400, 'UNSUPPORTED_WEBHOOK', 'Evento não suportado.');
    const result = await applyProviderPayment(env, sb, dataId, `webhook:${String(body.id || '')}:${request.headers.get('x-request-id')}`);
    return json({ received: true, processed: result.processed });
  }
  if (path.startsWith('/api/auth/')) return authRoutes(request, env, sb, path, cookies);
  if (path === '/api/catalog' && method === 'GET') {
    const level = url.searchParams.get('level') || '';
    if (level && !['beginner', 'intermediate', 'advanced'].includes(level)) throw new ApiError(400, 'INVALID_LEVEL', 'Nível inválido.');
    const cursor = url.searchParams.get('cursor');
    const result = await sb.rpc('catalog_search', {
      p_query: text(url.searchParams.get('q') || '', 150), p_difficulty: level || null,
      p_muscle: text(url.searchParams.get('muscle') || '', 80) || null,
      p_category: text(url.searchParams.get('category') || '', 80) || null,
      p_equipment: text(url.searchParams.get('equipment') || '', 80) || null,
      p_cursor: cursor ? uuid(cursor) : null, p_limit: 18,
    });
    return json(result);
  }
  if (path === '/api/taxonomies' && method === 'GET') return json({ items: await sb.db('taxonomies', 'GET', undefined, { select: 'id,kind,name,slug', order: 'name.asc' }) });
  const thumbnail = path.match(/^\/api\/thumbnails\/([^/]+)$/);
  if (thumbnail && method === 'GET') {
    const video = await getVideo(sb, uuid(thumbnail[1]));
    return storageThumbnail(sb, video.thumbnail_storage_path);
  }
  const session = await requireSession(request, sb, cookies, path.startsWith('/api/admin/'));
  if (path === '/api/account') return account(request, sb, session);
  if (path.startsWith('/api/admin/')) return adminRoutes(request, env, sb, session, url);
  if (path === '/api/checkout') return checkout(request, env, sb, session);
  const orderMatch = path.match(/^\/api\/orders\/([^/]+)\/refresh$/);
  if (orderMatch && method === 'POST') {
    const id = uuid(orderMatch[1]);
    await sb.rate(request, 'order:refresh', 5, 300, session.user.id);
    const [order] = await sb.db<{ provider_payment_id: string | null }[]>('payment_orders', 'GET', undefined, { id: `eq.${id}`, user_id: `eq.${session.user.id}`, select: 'provider_payment_id', limit: '1' });
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');
    const result = await reconcileOrderPayments(env, sb, { id, provider_payment_id: order.provider_payment_id }, 'user-reconcile');
    return json({ refreshed: true, ...result });
  }
  await requireAccess(session, sb);
  if (path === '/api/favorites' && method === 'GET') {
    const rows = await sb.db<{ video_id: string; videos: Video }[]>('favorites', 'GET', undefined, { user_id: `eq.${session.user.id}`, select: `video_id,videos!inner(${videoSelect})`, 'videos.published': 'eq.true', 'videos.status': 'eq.ready', order: 'created_at.desc', limit: '500' });
    return json({ items: rows.map(row => safeVideo(row.videos)) });
  }
  const favorite = path.match(/^\/api\/favorites\/([^/]+)$/);
  if (favorite && (method === 'POST' || method === 'DELETE')) {
    const id = uuid(favorite[1]);
    if (method === 'POST') {
      await getVideo(sb, id);
      // PostgreSQL resolves duplicate clicks atomically against PK(user_id,video_id).
      await sb.db('favorites', 'POST', { user_id: session.user.id, video_id: id }, { on_conflict: 'user_id,video_id' }, false, true);
    } else await sb.db('favorites', 'DELETE', undefined, { user_id: `eq.${session.user.id}`, video_id: `eq.${id}` }, false);
    return json({ saved: method === 'POST' });
  }
  const watch = path.match(/^\/api\/watch\/([^/]+)$/);
  if (watch && method === 'GET') {
    configured(env, 'BUNNY_EMBED_TOKEN_KEY', 'BUNNY_STREAM_LIBRARY_ID');
    if (env.BUNNY_SECURITY_CONFIRMED !== 'true') throw new ApiError(503, 'STREAM_SECURITY_PENDING', 'A reprodução protegida aguarda configuração.');
    const video = await getVideo(sb, uuid(watch[1]));
    if (!video.bunny_video_id) throw new ApiError(404, 'CONTENT_UNAVAILABLE', 'Este conteúdo está indisponível.');
    const expires = Math.floor(Date.now() / 1000) + 600;
    const embedUrl = await signedEmbed(env.BUNNY_EMBED_TOKEN_KEY!, env.BUNNY_STREAM_LIBRARY_ID!, video.bunny_video_id, expires);
    const taxonomies = (video.video_taxonomies || []).map(v => v.taxonomies);
    const matching = taxonomies.find(t => t.kind === 'muscle') || taxonomies.find(t => t.kind === 'category');
    const related = await sb.rpc<{ items: Json[] }>('catalog_search', { p_query: '', p_difficulty: null, p_muscle: matching?.kind === 'muscle' ? matching.slug : null, p_category: matching?.kind === 'category' ? matching.slug : null, p_equipment: null, p_cursor: null, p_limit: 7 });
    return json({ video: safeVideo(video), embed_url: embedUrl, expires_at: new Date(expires * 1000).toISOString(), related: related.items.filter(v => v.id !== video.id).slice(0, 6) });
  }
  throw new ApiError(404, 'NOT_FOUND', 'Página não encontrada.');
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const cookies: string[] = []; let response: Response;
  try {
    const redirect=siteRedirect(request,env);
    if(redirect)response=redirect;
    else if (url.pathname.startsWith('/api/')) response = await api(request, env, cookies);
    else response = await serveSite(request, env);
  } catch (error) {
    if (error instanceof ApiError) response = json({ error: error.code, message: error.message }, error.status);
    else {
      // No raw error, URL, token, body or email is written to logs.
      console.error(JSON.stringify({ event: 'request_failed', request_id: crypto.randomUUID() }));
      response = json({ error: 'INTERNAL_ERROR', message: 'Ocorreu uma falha. Tente novamente em instantes.' }, 500);
    }
  }
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  headers.set('X-Content-Type-Options', 'nosniff');
  // Bunny's allowed-referrer controls need the application origin; never send path/query cross-origin.
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const nonce=headers.get('X-Content-Nonce');headers.delete('X-Content-Nonce');
  const analytics=runtimeConfig(request,env).analyticsId;
  headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'${nonce?` 'nonce-${nonce}'`:''}${analytics?' https://www.googletagmanager.com':''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; font-src 'self'; connect-src 'self' https://video.bunnycdn.com${analytics?' https://*.google-analytics.com https://*.analytics.google.com':''}; frame-src https://player.mediadelivery.net https://iframe.mediadelivery.net; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`);
  if (url.pathname.startsWith('/api/')) {headers.set('Cache-Control', 'private, no-store');headers.set('X-Robots-Tag','noindex, nofollow');}
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  fetch: handleRequest,
  async scheduled(_controller: unknown, env: Env, context: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    if (!env.MERCADO_PAGO_ACCESS_TOKEN || !env.SUPABASE_SERVICE_ROLE_KEY) return;
    context.waitUntil(reconcilePayments(env, new Supabase(env)).catch(() => { console.error(JSON.stringify({ event: 'payment_reconciliation_unavailable' })); }));
  },
};
