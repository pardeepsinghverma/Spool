import React, { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { request, type Reply } from './account';
import { type Plan, updatePricesFromLivePlans, rememberPaidThrough, syncLicence } from './license';
import * as log from './log';

export type LivePlan = {
  code: string;
  name: string;
  amountPaise: number;
  amount: string;
  per: string;
  note: string;
  intervalUnit: string;
  intervalCount: number;
  currency: string;
};

export type LivePaymentSettings = {
  vpa: string;
  payee: string;
  qrImageUrl: string;
  whatsapp: string;
};

const KEY_CACHED_PLANS = 'spool.live_plans';
const KEY_CACHED_SETTINGS = 'spool.live_settings';

let cachedPlans: LivePlan[] = [
  {
    code: 'daily',
    name: '1-Day Pass',
    amountPaise: 100,
    amount: '₹1',
    per: 'a day',
    note: '1 day of full access. Paid once, by UPI.',
    intervalUnit: 'day',
    intervalCount: 1,
    currency: 'INR',
  },
  {
    code: 'monthly',
    name: 'Monthly',
    amountPaise: 2900,
    amount: '₹29',
    per: 'a month',
    note: 'Pay each month by UPI. Nothing renews on its own.',
    intervalUnit: 'month',
    intervalCount: 1,
    currency: 'INR',
  },
  {
    code: 'annual',
    name: 'Yearly',
    amountPaise: 24900,
    amount: '₹249',
    per: 'a year',
    note: 'Works out at ₹20.75 a month. Paid once, by UPI.',
    intervalUnit: 'year',
    intervalCount: 1,
    currency: 'INR',
  },
];

let cachedSettings: LivePaymentSettings = {
  vpa: 'vermapardeep.official@okaxis',
  payee: 'PARDEEP VERMA',
  qrImageUrl: '/paymentqrcode.jpeg',
  whatsapp: '919464263538',
};

/**
 * Fetch plans and payment settings directly from the live dashboard / server.
 */
export async function fetchLivePlans(): Promise<{ plans: LivePlan[]; settings: LivePaymentSettings }> {
  try {
    const reply = await request('/v1/plans', { method: 'GET', auth: false });
    if (reply.kind === 'ok' && Array.isArray(reply.body.plans) && reply.body.plans.length > 0) {
      cachedPlans = reply.body.plans;
      if (typeof reply.body.vpa === 'string' && reply.body.vpa) cachedSettings.vpa = reply.body.vpa;
      if (typeof reply.body.payee === 'string' && reply.body.payee) cachedSettings.payee = reply.body.payee;
      if (typeof reply.body.qrImageUrl === 'string' && reply.body.qrImageUrl) cachedSettings.qrImageUrl = reply.body.qrImageUrl;
      if (typeof reply.body.whatsapp === 'string' && reply.body.whatsapp) cachedSettings.whatsapp = reply.body.whatsapp;
      learnSupport(cachedSettings.whatsapp);

      updatePricesFromLivePlans(cachedPlans);

      void AsyncStorage.setItem(KEY_CACHED_PLANS, JSON.stringify(cachedPlans));
      void AsyncStorage.setItem(KEY_CACHED_SETTINGS, JSON.stringify(cachedSettings));
    }
  } catch (e) {
    log.warn('payments', 'failed to fetch live plans', { error: String(e) });
  }

  return { plans: cachedPlans, settings: cachedSettings };
}

export function useLivePlans() {
  const [plans, setPlans] = useState<LivePlan[]>(cachedPlans);
  const [settings, setSettings] = useState<LivePaymentSettings>(cachedSettings);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(KEY_CACHED_PLANS).then((stored) => {
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            cachedPlans = parsed;
            setPlans(parsed);
            updatePricesFromLivePlans(parsed);
          }
        } catch {}
      }
    });

    void AsyncStorage.getItem(KEY_CACHED_SETTINGS).then((stored) => {
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed === 'object') {
            cachedSettings = { ...cachedSettings, ...parsed };
            setSettings(cachedSettings);
          }
        } catch {}
      }
    });

    setLoading(true);
    void fetchLivePlans().then((res) => {
      setPlans(res.plans);
      setSettings(res.settings);
      setLoading(false);
    });
  }, []);

  return { plans, settings, loading };
}

/**
 * The support line, used where the server has not told us one yet (the
 * "forgot password" link is reached before any order exists). One constant in
 * one place; the server's answer to `/v1/pay/start` and `/v1/pay/claim`
 * replaces it for the rest of the process.
 */
export const SUPPORT_WHATSAPP = '919464263538';
let support = SUPPORT_WHATSAPP;
export const supportWhatsapp = () => support;

const learnSupport = (value: unknown) => {
  if (typeof value === 'string' && /^\d{8,15}$/.test(value)) support = value;
};

/** An upload of a few hundred kilobytes over a poor mobile connection. */
const UPLOAD_TIMEOUT_MS = 45_000;

export type Order = {
  order: string;
  plan: string;
  amountPaise: number;
  upiUrl: string;
  vpa: string;
  payee: string;
  whatsapp: string;
  qrImageUrl?: string;
  /** Epoch ms after which the server will not accept a claim against it. */
  expiresAt: number;
};

export type Started = { ok: true; order: Order } | { ok: false; message: string; signedOut?: boolean };

/**
 * `wa.me` with a prefilled message. Pure, so the encoding is tested rather
 * than trusted: an order code or a `&` in the text that reached WhatsApp
 * unencoded would truncate the message at exactly the part that matters.
 */
export function whatsappUrl(number: string, message: string): string {
  const digits = number.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/** `2900` → `₹29`, `2950` → `₹29.50`. Paise are what the server counts in. */
export function formatRupees(paise: number): string {
  const whole = Math.floor(paise / 100);
  const rest = Math.abs(paise % 100);
  return rest ? `₹${whole}.${String(rest).padStart(2, '0')}` : `₹${whole}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `12 Mar 2027`, in local time. Hand-rolled so nothing depends on Intl data in Hermes. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function payError(reply: Reply): string {
  switch (reply.kind) {
    case 'offline':
      return 'Could not reach Spool. Check your connection and try again.';
    case 'unconfigured':
      return 'Sign in first — a payment is added to your account.';
    case 'signed-out':
      return 'You have been signed out. Sign in again to continue.';
    case 'blocked':
      return 'This account has been blocked. Contact support on WhatsApp.';
    case 'ok':
      return '';
  }
  const error = String(reply.body.error ?? '');
  switch (error) {
    case 'payments not configured':
      return 'Payments are not open right now. Try again later.';
    case 'unknown plan':
      return 'That plan is not on offer any more. Close this and open it again.';
    case 'slow down':
      return 'Too many tries. Wait a minute and try again.';
    case 'bad order':
      return 'That payment code has expired. Start again to get a new one.';
    case 'order already used':
      return 'A screenshot has already been sent for this payment code. Start again for a new payment.';
    case 'no image':
    case 'not an image':
      return 'That file could not be read as an image. Pick the screenshot again.';
    case 'image too large':
      return 'That image is too large to send. Try a plain screenshot instead.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}

/** Ask the server for an order: the code, the amount and the UPI link to pay it. */
export async function startPayment(plan: string): Promise<Started> {
  const reply = await request('/v1/pay/start', { method: 'POST', auth: true, body: { plan } });
  if (reply.kind !== 'ok') {
    return {
      ok: false,
      message: payError(reply),
      signedOut: reply.kind === 'signed-out' || reply.kind === 'unconfigured',
    };
  }
  const b = reply.body;
  if (typeof b.order !== 'string' || typeof b.upiUrl !== 'string') {
    return { ok: false, message: payError({ kind: 'offline' }) };
  }
  learnSupport(b.whatsapp);
  log.info('pay', 'order started', { plan, order: b.order });
  return {
    ok: true,
    order: {
      order: b.order,
      plan: b.plan ? String(b.plan) : plan,
      amountPaise: Number(b.amountPaise) || 0,
      upiUrl: b.upiUrl,
      vpa: typeof b.vpa === 'string' ? b.vpa : '',
      payee: typeof b.payee === 'string' ? b.payee : '',
      whatsapp: typeof b.whatsapp === 'string' ? b.whatsapp : support,
      qrImageUrl: typeof b.qrImageUrl === 'string' ? b.qrImageUrl : undefined,
      expiresAt: Number(b.expiresAt) || 0,
    },
  };
}

export type ClaimDetails = {
  utr: string;
  amountPaise: number;
  paidAt: number | null;
  payer: string | null;
};

export type Claim =
  | { status: 'approved'; plan: string; paidThrough: number; details: ClaimDetails }
  | {
      status: 'review' | 'rejected';
      reasons: string[];
      details: ClaimDetails;
      whatsapp: string;
      message: string;
    }
  | { status: 'error'; message: string; signedOut?: boolean };

/**
 * The multipart fields, in order. Separate from the upload so the shape is
 * testable without a FormData that understands React Native's `{uri}` parts.
 */
export function claimParts(
  order: string,
  imageUri: string,
  ocrText: string,
): [string, string | { uri: string; name: string; type: string }][] {
  return [
    ['order', order],
    ['text', ocrText],
    ['image', { uri: imageUri, name: `payment-${order}.jpg`, type: 'image/jpeg' }],
  ];
}

const details = (raw: unknown): ClaimDetails => {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    utr: typeof d.utr === 'string' ? d.utr : '',
    amountPaise: Number(d.amountPaise) || 0,
    paidAt: typeof d.paidAt === 'number' ? d.paidAt : null,
    payer: typeof d.payer === 'string' ? d.payer : null,
  };
};

/**
 * Send the screenshot and what was read off it.
 *
 * On `approved` the licence is synced before this resolves, so the sheet's
 * next render already has the token — an approval screen over a still-locked
 * download button would be the app contradicting itself.
 */
export async function submitScreenshot(order: string, imageUri: string, ocrText: string): Promise<Claim> {
  const form = new FormData();
  for (const [name, value] of claimParts(order, imageUri, ocrText)) {
    // React Native's FormData takes `{uri, name, type}` for a file; the DOM
    // typings only know Blob, hence the cast.
    form.append(name, value as unknown as string);
  }

  const reply = await request('/v1/pay/claim', {
    method: 'POST',
    auth: true,
    body: form,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  if (reply.kind !== 'ok') {
    return {
      status: 'error',
      message: payError(reply),
      signedOut: reply.kind === 'signed-out' || reply.kind === 'unconfigured',
    };
  }

  const b = reply.body;
  learnSupport(b.whatsapp);
  if (b.status === 'approved') {
    const paidThrough = Number(b.paidThrough) || 0;
    const plan = typeof b.plan === 'string' ? b.plan : '';
    log.info('pay', 'claim approved', { order, plan });
    rememberPaidThrough(paidThrough, plan);
    await clearPendingOrder();
    await syncLicence({ force: true });
    return { status: 'approved', plan, paidThrough, details: details(b.details) };
  }
  if (b.status === 'review' || b.status === 'rejected') {
    log.info('pay', `claim ${b.status}`, { order });
    return {
      status: b.status,
      reasons: Array.isArray(b.reasons) ? b.reasons.map(String) : [],
      details: details(b.details),
      whatsapp: typeof b.whatsapp === 'string' ? b.whatsapp : support,
      message:
        typeof b.message === 'string' && b.message
          ? b.message
          : `Hi, I paid for Spool (order ${order}). Screenshot attached.`,
    };
  }
  return { status: 'error', message: payError({ kind: 'offline' }) };
}

/**
 * The order the user is in the middle of paying, persisted.
 *
 * Paying means leaving Spool for a UPI app, and Android is free to kill a
 * backgrounded process while the user is in there entering a PIN. Without this
 * they come back to a closed sheet and an order code they never wrote down —
 * having just paid against it. Kept only until it expires or a claim settles.
 */
const KEY_PENDING = 'dl.pendingOrder';

export async function savePendingOrder(order: Order): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PENDING, JSON.stringify(order));
  } catch {}
}

export async function loadPendingOrder(now = Date.now()): Promise<Order | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PENDING);
    const o = raw ? JSON.parse(raw) : null;
    if (!o || typeof o.order !== 'string' || typeof o.upiUrl !== 'string') return null;
    if (o.expiresAt && o.expiresAt <= now) {
      await clearPendingOrder();
      return null;
    }
    return o as Order;
  } catch {
    return null;
  }
}

export async function clearPendingOrder(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_PENDING);
  } catch {}
}

/** Test seam. */
export function reset() {
  support = SUPPORT_WHATSAPP;
}
