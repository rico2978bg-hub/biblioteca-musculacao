import { ApiError, sha256, validatePayment, type ProviderPayment, type PaymentOrder } from './core.ts';

export interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  APP_ORIGIN?: string;
  SITE_ORIGIN?: string;
  SEO_INDEXING_ENABLED?: string;
  GOOGLE_SITE_VERIFICATION?: string;
  GOOGLE_ANALYTICS_ID?: string;
  ANALYTICS_ENABLED?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RATE_LIMIT_SALT?: string;
  BUNNY_STREAM_LIBRARY_ID?: string;
  BUNNY_STREAM_API_KEY?: string;
  BUNNY_EMBED_TOKEN_KEY?: string;
  BUNNY_SECURITY_CONFIRMED?: string;
  MERCADO_PAGO_ACCESS_TOKEN?: string;
  MERCADO_PAGO_WEBHOOK_SECRET?: string;
  MERCADO_PAGO_COLLECTOR_ID?: string;
  MERCADO_PAGO_LIVE_MODE?: string;
  PAYMENTS_ENABLED?: string;
  [key: string]: unknown;
}

export type Json = Record<string, unknown>;
export type Profile = { id: string; display_name: string; role: 'user' | 'admin'; enabled: boolean };
export type User = { id: string; email?: string; email_confirmed_at?: string; factors?: { id: string; status: string; factor_type: string }[] };
export type Session = { user: User; profile: Profile; accessToken: string; aal: string };
type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; user: User };

export function configured(env: Env, ...keys: (keyof Env)[]): void {
  if (keys.some(k => !env[k] || typeof env[k] !== 'string')) {
    throw new ApiError(503, 'INTEGRATION_PENDING', 'Esta função aguarda a configuração segura dos serviços.');
  }
}

export async function externalFetch(url: string, init: RequestInit, message: string, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const headers = new Headers(init.headers);
  headers.set('User-Agent', 'BibliotecaMusculacao-Server/1.0');
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal, redirect: 'manual' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    const reason = controller.signal.aborted ? 'timeout'
      : /denied|forbidden|blocked|not allowed|egress/i.test(detail) ? 'blocked'
      : /dns|resolve/i.test(detail) ? 'dns'
      : /tls|certificate/i.test(detail) ? 'tls'
      : 'network';
    console.error(JSON.stringify({ event: 'provider_fetch_failed', provider: new URL(url).hostname, reason }));
    throw new ApiError(502, 'PROVIDER_UNAVAILABLE', message);
  } finally {
    clearTimeout(timer);
  }
}

export async function externalJson<T>(url: string, init: RequestInit = {}, message = 'O serviço está temporariamente indisponível.'): Promise<T> {
  const response = await externalFetch(url, init, message);
  if (!response.ok) {
    // Do not propagate provider responses: they may contain PII, signed URLs or access tokens.
    if (response.status === 429) throw new ApiError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde alguns minutos.');
    const status = response.status === 401 || response.status === 403 ? 401 : [400, 404, 409, 422].includes(response.status) ? response.status : 502;
    throw new ApiError(status, 'PROVIDER_REJECTED', message);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return null as T;
  const body = await response.text();
  if (!body) return null as T;
  try { return JSON.parse(body) as T; } catch { throw new ApiError(502, 'INVALID_PROVIDER_RESPONSE', message); }
}

export class Supabase {
  env: Env;
  constructor(env: Env) {
    configured(env, 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
    if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(env.SUPABASE_URL!)) throw new ApiError(503, 'INVALID_CONFIGURATION', 'Serviço de dados sem configuração válida.');
    this.env = env;
  }
  get url(): string { return this.env.SUPABASE_URL!.replace(/\/$/, ''); }
  headers(service = false, token?: string): Record<string, string> {
    const key = service ? this.env.SUPABASE_SERVICE_ROLE_KEY! : this.env.SUPABASE_ANON_KEY!;
    // Modern API keys identify the application. Only a session token or legacy JWT goes in Bearer.
    const bearer = token || (key.startsWith('sb_') ? undefined : key);
    return { apikey: key, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
  }
  async auth<T = Json>(path: string, method = 'GET', body?: unknown, token?: string, service = false): Promise<T> {
    return externalJson<T>(`${this.url}/auth/v1${path}`, {
      method, headers: { ...this.headers(service, token), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, 'Não foi possível concluir a autenticação. Confira os dados ou tente novamente.');
  }
  async db<T = Json[]>(table: string, method = 'GET', body?: unknown, params: Record<string, string> = {}, returnRows = true, ignoreDuplicates = false): Promise<T> {
    const query = new URLSearchParams(params);
    return externalJson<T>(`${this.url}/rest/v1/${table}?${query}`, {
      method, headers: {
        ...this.headers(true),
        'Content-Type': 'application/json', Prefer: `${ignoreDuplicates ? 'resolution=ignore-duplicates,' : ''}${returnRows ? 'return=representation' : 'return=minimal'}`,
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async rpc<T>(name: string, body: unknown): Promise<T> { return this.db<T>(`rpc/${name}`, 'POST', body); }
  async rate(request: Request, bucket: string, limit = 10, windowSeconds = 900, identity = ''): Promise<void> {
    configured(this.env, 'RATE_LIMIT_SALT');
    // Cloudflare overwrites CF-Connecting-IP in production. Do not expose this Worker behind an untrusted reverse proxy.
    const ip = request.headers.get('cf-connecting-ip') || 'local-development';
    const key = await sha256(`${this.env.RATE_LIMIT_SALT}:${bucket}:${ip}:${identity}`);
    const result = await this.rpc<{ allowed: boolean }>('rate_limit', { p_key_hash: key, p_limit: limit, p_window_seconds: windowSeconds });
    if (result?.allowed !== true) throw new ApiError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde alguns minutos.');
  }
}

export function parseCookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get('cookie') || '').split(';').map(part => {
    const i = part.indexOf('=');
    return i < 0 ? ['', ''] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([k]) => !!k));
}

export function tokenCookies(data: TokenResponse, output: string[]): void {
  const opts = '; Path=/; Secure; HttpOnly; SameSite=Lax';
  output.push(`__Host-dm_access=${data.access_token}; Max-Age=${Math.max(1, Math.min(data.expires_in, 3600))}${opts}`);
  output.push(`__Host-dm_refresh=${data.refresh_token}; Max-Age=2592000${opts}`);
}
export function clearCookies(output: string[]): void {
  for (const name of ['__Host-dm_access', '__Host-dm_refresh']) output.push(`${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
}

/** Claims are decoded ONLY after Supabase /user has validated this same access token. */
export function validatedClaims(token: string): Json {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)) as Json;
  } catch { throw new ApiError(401, 'INVALID_SESSION', 'Entre novamente na sua conta.'); }
}

export async function requireSession(request: Request, sb: Supabase, output: string[], admin = false, allowAdminAal1 = false): Promise<Session> {
  const cookies = parseCookies(request);
  let accessToken = cookies['__Host-dm_access'];
  let user: User | undefined;
  if (accessToken) {
    try { user = await sb.auth<User>('/user', 'GET', undefined, accessToken); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
  }
  if (!user && cookies['__Host-dm_refresh']) {
    try {
      const refreshed = await sb.auth<TokenResponse>('/token?grant_type=refresh_token', 'POST', { refresh_token: cookies['__Host-dm_refresh'] });
      accessToken = refreshed.access_token;
      tokenCookies(refreshed, output);
      // Validate newly returned user directly against the Auth server too.
      user = await sb.auth<User>('/user', 'GET', undefined, accessToken);
    } catch (error) {
      clearCookies(output);
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, 'SESSION_EXPIRED', 'Sua sessão expirou. Entre novamente.');
      throw error;
    }
  }
  if (!user || !accessToken) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Entre para continuar.');
  if (!user.email_confirmed_at) throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Confirme seu e-mail para continuar.');
  const [profile] = await sb.db<Profile[]>('profiles', 'GET', undefined, { id: `eq.${user.id}`, select: 'id,display_name,role,enabled', limit: '1' });
  if (!profile || !profile.enabled) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Esta conta está bloqueada. Entre em contato com o professor.');
  const claims = validatedClaims(accessToken);
  if (claims.sub !== user.id || Number(claims.exp) * 1000 <= Date.now()) throw new ApiError(401, 'INVALID_SESSION', 'Entre novamente.');
  const aal = String(claims.aal || 'aal1');
  if (admin && profile.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', 'Acesso exclusivo da administração.');
  if (admin && !allowAdminAal1 && aal !== 'aal2') throw new ApiError(403, 'MFA_REQUIRED', 'Confirme o código do autenticador para administrar a plataforma.');
  return { user, profile, accessToken, aal };
}

export async function requireAccess(session: Session, sb: Supabase): Promise<void> {
  if (session.profile.role === 'admin') {
    if (session.aal !== 'aal2') throw new ApiError(403, 'MFA_REQUIRED', 'Confirme o código do autenticador.');
    return;
  }
  const valid = await sb.rpc<boolean>('has_access', { p_user_id: session.user.id });
  if (valid !== true) throw new ApiError(403, 'ACCESS_REQUIRED', 'Este conteúdo exige uma assinatura ou matrícula gratuita válida.');
}

export async function audit(sb: Supabase, actor: string, action: string, targetType: string, targetId: string, metadata: Json = {}): Promise<void> {
  // Audit only whitelisted summaries, never request bodies, tokens or full payment payloads.
  await sb.db('audit_logs', 'POST', { actor_id: actor, action, target_type: targetType, target_id: targetId, metadata }, {}, false);
}

export async function settings(sb: Supabase, key: string): Promise<Json> {
  const [row] = await sb.db<{ value: Json }[]>('settings', 'GET', undefined, { key: `eq.${key}`, select: 'value', limit: '1' });
  return row?.value || {};
}

export async function bunny<T>(env: Env, path: string, method = 'GET', body?: unknown): Promise<T> {
  configured(env, 'BUNNY_STREAM_LIBRARY_ID', 'BUNNY_STREAM_API_KEY');
  if (!/^\d+$/.test(env.BUNNY_STREAM_LIBRARY_ID!)) throw new ApiError(503, 'INVALID_CONFIGURATION', 'Biblioteca de vídeo inválida.');
  return externalJson<T>(`https://video.bunnycdn.com/library/${env.BUNNY_STREAM_LIBRARY_ID}${path}`, {
    method, headers: { AccessKey: env.BUNNY_STREAM_API_KEY!, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 'O serviço de vídeo está temporariamente indisponível.');
}

export async function mercadoPago<T>(env: Env, path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
  configured(env, 'MERCADO_PAGO_ACCESS_TOKEN', 'MERCADO_PAGO_COLLECTOR_ID', 'MERCADO_PAGO_LIVE_MODE');
  return externalJson<T>(`https://api.mercadopago.com${path}`, {
    method, headers: { Authorization: `Bearer ${env.MERCADO_PAGO_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 'O provedor de pagamento está temporariamente indisponível.');
}

export async function applyProviderPayment(env: Env, sb: Supabase, paymentId: string, eventId: string): Promise<Json> {
  if (!/^\d{1,30}$/.test(paymentId)) throw new ApiError(400, 'INVALID_PAYMENT_ID', 'Pagamento inválido.');
  const payment = await mercadoPago<ProviderPayment>(env, `/v1/payments/${paymentId}`);
  if (String(payment.id) !== paymentId || !payment.external_reference || !/^[0-9a-f-]{36}$/i.test(payment.external_reference)) {
    throw new ApiError(409, 'UNRELATED_PAYMENT', 'Pagamento sem pedido reconhecido.');
  }
  const [order] = await sb.db<PaymentOrder[]>('payment_orders', 'GET', undefined, { id: `eq.${payment.external_reference}`, select: '*', limit: '1' });
  if (!order) throw new ApiError(409, 'ORDER_NOT_FOUND', 'Pedido de pagamento não encontrado.');
  const status = validatePayment(payment, order, env.MERCADO_PAGO_COLLECTOR_ID!, env.MERCADO_PAGO_LIVE_MODE === 'true');
  return sb.rpc<Json>('process_payment', {
    p_order_id: order.id, p_provider_payment_id: String(payment.id), p_status: status,
    p_provider_updated_at: payment.date_last_updated, p_event_id: eventId,
    p_amount_cents: Math.round(Number(payment.transaction_amount) * 100), p_currency: payment.currency_id,
    p_approved_at: payment.date_approved || null,
  });
}

export async function reconcileOrderPayments(env: Env, sb: Supabase, order: Pick<PaymentOrder, 'id' | 'provider_payment_id'>, eventPrefix: string): Promise<{ checked: number; failed: number }> {
  const result = await mercadoPago<{ results: ProviderPayment[] }>(env, `/v1/payments/search?external_reference=${encodeURIComponent(order.id)}&sort=date_created&criteria=desc&limit=10`);
  const allIds = [...new Set([...(order.provider_payment_id ? [order.provider_payment_id] : []), ...(result.results || []).map(p => String(p.id))])];
  let checked = 0; let failed = 0;
  if (allIds.length > 2) { failed++; console.error(JSON.stringify({ event: 'multiple_payment_attempts_need_review', order_id: order.id })); }
  for (const id of allIds.slice(0, 2)) {
    try { await applyProviderPayment(env, sb, id, `${eventPrefix}:${order.id}:${id}:${Date.now()}`); checked++; }
    catch { failed++; console.error(JSON.stringify({ event: 'payment_reconciliation_order_failed', order_id: order.id })); }
  }
  return { checked, failed };
}

/** Recovery path for lost/reordered webhooks. Every remote object is checked by applyProviderPayment. */
export async function reconcilePayments(env: Env, sb: Supabase): Promise<{ checked: number; failed: number }> {
  configured(env, 'MERCADO_PAGO_ACCESS_TOKEN', 'MERCADO_PAGO_COLLECTOR_ID');
  // Include approved terms to recover refunds and chargebacks after the original payment.
  const orders = await sb.rpc<PaymentOrder[]>('claim_reconciliation_orders', { p_limit: 5 });
  let checked = 0; let failed = 0;
  for (const order of orders) {
    try {
      // Five orders × (one search + two payments × three calls) + claim <= 36 subrequests,
      // within Workers Free's 50 limit. Cursor rotates all orders, including old approvals.
      const result = await reconcileOrderPayments(env, sb, order, 'reconcile');
      checked += result.checked; failed += result.failed;
    } catch { failed++; }
  }
  if (failed) console.error(JSON.stringify({ event: 'payment_reconciliation_failed', count: failed }));
  return { checked, failed };
}
