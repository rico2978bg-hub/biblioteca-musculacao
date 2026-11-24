/** Pure security and business rules, shared by the Worker and executable tests. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}

export type Grant = { status: string; starts_at?: string | null; expires_at?: string | null };
export type Subscription = { status: string; period_start?: string | null; period_end?: string | null };

export function hasEntitlement(enabled: boolean, verified: boolean, grants: Grant[], subscriptions: Subscription[], now = Date.now()): boolean {
  if (!enabled || !verified) return false;
  const validStart = (v?: string | null) => !v || (Number.isFinite(Date.parse(v)) && Date.parse(v) <= now);
  const validEnd = (v?: string | null) => !v || (Number.isFinite(Date.parse(v)) && Date.parse(v) > now);
  return grants.some(g => g.status === 'active' && validStart(g.starts_at) && validEnd(g.expires_at)) ||
    subscriptions.some(s => ['active', 'cancelled'].includes(s.status) && !!s.period_end && validStart(s.period_start) && validEnd(s.period_end));
}

export function assertSameOrigin(request: Request, expectedOrigin: string): void {
  if (!expectedOrigin || request.headers.get('origin') !== new URL(expectedOrigin).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ApiError(403, 'ORIGIN_REJECTED', 'A origem desta solicitação não foi autorizada.');
  }
}

export function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'INVALID_ID', 'Identificador inválido.');
  }
  return value;
}

export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ApiError(400, 'INVALID_INPUT', 'Confira os campos informados.');
  }
  return value.trim();
}

export function email(value: unknown): string {
  const v = text(value, 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new ApiError(400, 'INVALID_EMAIL', 'Informe um e-mail válido.');
  return v;
}

export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new ApiError(400, 'WEAK_PASSWORD', 'Use uma senha de 12 a 128 caracteres.');
  }
  return value;
}

export function isoDate(value: unknown, nullable = true): string | null {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ApiError(400, 'INVALID_DATE', 'Data inválida.');
  return new Date(value).toISOString();
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), v => v.toString(16).padStart(2, '0')).join('');
}

export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

export function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signedEmbed(key: string, libraryId: string, videoId: string, expires: number, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!key || !/^\d+$/.test(libraryId) || !Number.isInteger(expires) || expires <= now || expires > now + 3600) {
    throw new ApiError(400, 'INVALID_EXPIRY', 'A autorização de reprodução expirou.');
  }
  uuid(videoId);
  const token = await sha256(key + videoId + expires);
  return `https://player.mediadelivery.net/embed/${libraryId}/${videoId}?token=${token}&expires=${expires}&autoplay=false&preload=false&responsive=true`;
}

export async function tusSignature(libraryId: string, apiKey: string, videoId: string, expires: number): Promise<string> {
  uuid(videoId);
  return sha256(libraryId + apiKey + expires + videoId);
}

/** data.id MUST come from the URL, not the untrusted JSON body. */
export async function verifyMercadoPagoSignature(request: Request, secret: string, now = Date.now(), toleranceMs = 5 * 60 * 1000): Promise<boolean> {
  if (!secret) return false;
  const signature = request.headers.get('x-signature') || '';
  const parts = signature.split(',').map(v => v.trim().split('='));
  if (parts.filter(p => p[0] === 'ts').length !== 1 || parts.filter(p => p[0] === 'v1').length !== 1) return false;
  const ts = parts.find(p => p[0] === 'ts')?.[1] || '';
  const supplied = parts.find(p => p[0] === 'v1')?.[1] || '';
  const requestId = request.headers.get('x-request-id') || '';
  const dataId = new URL(request.url).searchParams.get('data.id') || '';
  if (!/^\d{10,13}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(supplied) || !/^[a-zA-Z0-9-]{1,200}$/.test(requestId) || !/^[a-zA-Z0-9-]{1,100}$/.test(dataId)) return false;
  const timestampMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(now - timestampMs) > toleranceMs) return false;
  const expected = await hmac(secret, `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`);
  return equalConstantTime(expected, supplied.toLowerCase());
}

export type ProviderPayment = {
  id: number | string; external_reference?: string; status?: string; transaction_amount?: number;
  transaction_amount_refunded?: number; currency_id?: string; collector_id?: number | string;
  date_last_updated?: string; date_approved?: string | null; live_mode?: boolean;
};
export type PaymentOrder = { id: string; amount_cents: number; currency: string; user_id: string; period_days: number; created_at?: string; plan_title?: string; status?: string; provider_preference_id?: string | null; provider_payment_id?: string | null };

export function validatePayment(payment: ProviderPayment, order: PaymentOrder, collectorId: string, liveMode: boolean): string {
  const updatedAt = Date.parse(payment.date_last_updated || '');
  const approvedAt = Date.parse(payment.date_approved || '');
  const orderCreatedAt = order.created_at ? Date.parse(order.created_at) : null;
  if (payment.external_reference !== order.id || String(payment.collector_id) !== collectorId || payment.currency_id !== order.currency ||
      !Number.isFinite(payment.transaction_amount) || Math.round(Number(payment.transaction_amount) * 100) !== order.amount_cents ||
      payment.live_mode !== liveMode || !Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > Date.now() + 300_000 ||
      (order.provider_payment_id && ['approved', 'refunded', 'charged_back'].includes(order.status || '') && String(payment.id) !== order.provider_payment_id)) {
    throw new ApiError(409, 'PAYMENT_MISMATCH', 'Pagamento incompatível com o pedido. A reconciliação requer revisão.');
  }
  const statuses = ['pending', 'in_process', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back'];
  if (!statuses.includes(payment.status || '')) throw new ApiError(409, 'UNKNOWN_PAYMENT_STATUS', 'Situação de pagamento desconhecida.');
  // The event timestamp orders updates; it must never become the start of a paid term.
  // Approval is mandatory only for an actual approval; reversals cannot grant access.
  if (payment.status === 'approved' && (!Number.isFinite(approvedAt) || approvedAt <= 0 || approvedAt > updatedAt || approvedAt > Date.now() + 300_000 ||
      (orderCreatedAt !== null && (!Number.isFinite(orderCreatedAt) || approvedAt < orderCreatedAt - 300_000)))) {
    throw new ApiError(409, 'INVALID_APPROVAL_DATE', 'O pagamento exige revisão da data de aprovação.');
  }
  // Conservative access suspension for partial refunds too; reviewed manually before any regrant.
  return Number(payment.transaction_amount_refunded || 0) > 0 ? 'refunded' : payment.status!;
}

export function sniffFile(bytes: Uint8Array, kind: 'material' | 'thumbnail'): string {
  const prefix = Array.from(bytes.slice(0, 8));
  if (kind === 'material' && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
  if (kind === 'thumbnail' && prefix.slice(0, 3).join(',') === '255,216,255') return 'image/jpeg';
  if (kind === 'thumbnail' && prefix.join(',') === '137,80,78,71,13,10,26,10') return 'image/png';
  if(kind==='thumbnail'&&bytes.length>=20&&new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(new TextDecoder().decode(bytes.slice(12,16)))&&new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true)===bytes.length-8)return 'image/webp';
  throw new ApiError(415, 'UNSUPPORTED_FILE', kind === 'material' ? 'Nesta versão, envie materiais em PDF.' : 'Envie uma miniatura JPEG, PNG ou WebP.');
}
