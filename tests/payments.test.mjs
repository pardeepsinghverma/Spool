import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import * as storage from './harness/stubs/async-storage.mjs';
import { loadAccount, reset as resetAccount } from '../src/core/account.ts';
import { licence, reset as resetLicence } from '../src/core/license.ts';
import {
  SUPPORT_WHATSAPP,
  claimParts,
  formatDate,
  formatRupees,
  loadPendingOrder,
  reset,
  savePendingOrder,
  startPayment,
  submitScreenshot,
  supportWhatsapp,
  whatsappUrl,
} from '../src/core/payments.ts';

/**
 * Paying by UPI screenshot.
 *
 * What is provable from here is the shape of what goes out and the reading of
 * what comes back — the OCR is native and the parsing is on the server, and
 * neither is reachable. The property worth a suite: every answer the server
 * can give ends in something the user can do next, and an approval lands the
 * licence before the sheet says so.
 */

const SERVER = 'https://licence.example';
const NOW = Date.now();

let sent = [];
const realFetch = globalThis.fetch;
const RealFormData = globalThis.FormData;

/** React Native's FormData takes `{uri,name,type}` parts; Node's refuses them. */
class RecordingFormData {
  constructor() {
    this.parts = [];
  }
  append(name, value) {
    this.parts.push([name, value]);
  }
}

const answer = (status, body) => {
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return { ok: status < 300, status, json: async () => body };
  };
};

/**
 * React Native's XMLHttpRequest, as far as `upload()` uses it, answered by the
 * same `globalThis.fetch` stub the other tests install — so a test reads what
 * was sent the same way whichever transport carried it, and `via` says which.
 *
 * Uploads must go by XHR: Expo's global fetch throws "Unsupported FormDataPart
 * implementation" on a `{uri}` part, which is how every claim failed on the
 * emulator while these tests, stubbing fetch, stayed green.
 */
const RealXHR = globalThis.XMLHttpRequest;
class FetchBackedXHR {
  open(method, url) {
    this.method = method;
    this.url = url;
    this.headers = {};
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  abort() {}
  send(body) {
    globalThis
      .fetch(this.url, { method: this.method, headers: this.headers, body, via: 'xhr' })
      .then(async (r) => {
        this.status = r.status;
        let parsed;
        try {
          parsed = await r.json();
        } catch {
          parsed = undefined;
        }
        this.responseText = parsed === undefined ? '<html>' : JSON.stringify(parsed);
        this.onload?.();
      }, () => this.onerror?.());
  }
}

beforeEach(async () => {
  native.reset();
  storage.reset();
  resetAccount();
  resetLicence();
  reset();
  sent = [];
  globalThis.FormData = RecordingFormData;
  globalThis.XMLHttpRequest = FetchBackedXHR;
  native.handlers.licenceStatus = () => ({
    entitled: false,
    expiresAt: 0,
    plan: '',
    device: 'dev',
    server: SERVER,
  });
  storage.seed('dl.account', JSON.stringify({ session: 'sess', email: 'a@b.co' }));
  await loadAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.FormData = RealFormData;
  globalThis.XMLHttpRequest = RealXHR;
});

describe('whatsappUrl', () => {
  test('encodes the message so the order code survives the trip', () => {
    assert.equal(
      whatsappUrl('919464263538', 'Order SPL7K2M9Q & paid ₹29?'),
      'https://wa.me/919464263538?text=Order%20SPL7K2M9Q%20%26%20paid%20%E2%82%B929%3F',
    );
  });

  test('strips anything that is not a digit from the number', () => {
    assert.ok(whatsappUrl('+91 94642-63538', 'x').startsWith('https://wa.me/919464263538?'));
  });
});

describe('formatting', () => {
  test('paise to rupees, without a pointless .00', () => {
    assert.equal(formatRupees(2900), '₹29');
    assert.equal(formatRupees(24900), '₹249');
    assert.equal(formatRupees(2950), '₹29.50');
    assert.equal(formatRupees(2905), '₹29.05');
  });

  test('a date reads as day, short month, year', () => {
    assert.match(formatDate(new Date(2027, 2, 12, 12).getTime()), /^12 Mar 2027$/);
  });
});

describe('startPayment', () => {
  test('posts the plan with the session and learns the support number', async () => {
    answer(200, {
      order: 'SPL1',
      plan: 'monthly',
      amountPaise: 2900,
      upiUrl: 'upi://pay?pa=x@y',
      vpa: 'x@y',
      payee: 'X',
      whatsapp: '911234567890',
      expiresAt: NOW + 3_600_000,
    });

    const started = await startPayment('monthly');

    assert.equal(started.ok, true);
    assert.equal(started.order.order, 'SPL1');
    assert.equal(sent[0].init.headers.authorization, 'Bearer sess');
    assert.deepEqual(JSON.parse(sent[0].init.body), { plan: 'monthly' });
    assert.equal(supportWhatsapp(), '911234567890');
  });

  test('before any server answer, the support number is the fallback', () => {
    assert.equal(supportWhatsapp(), SUPPORT_WHATSAPP);
  });

  test('payments switched off is said plainly', async () => {
    answer(503, { error: 'payments not configured' });
    const started = await startPayment('annual');
    assert.equal(started.ok, false);
    assert.match(started.message, /not open right now/);
  });

  test('signed out is reported as such, so the sheet can open the account', async () => {
    resetAccount();
    storage.reset();
    await loadAccount();
    const started = await startPayment('annual');
    assert.equal(started.ok, false);
    assert.equal(started.signedOut, true);
    assert.deepEqual(sent, []);
  });
});

describe('submitScreenshot', () => {
  test('sends order, text and a JPEG part, as multipart with no hand-set content-type', async () => {
    answer(200, { status: 'review', reasons: ['x'], details: {}, whatsapp: '911', message: 'm' });

    await submitScreenshot('SPL1', 'file:///cache/upload/shot.jpg', 'Paid\n₹29.00');

    const { init } = sent[0];
    assert.ok(init.body instanceof RecordingFormData);
    assert.deepEqual(init.body.parts, claimParts('SPL1', 'file:///cache/upload/shot.jpg', 'Paid\n₹29.00'));
    assert.deepEqual(init.body.parts[2][1], {
      uri: 'file:///cache/upload/shot.jpg',
      name: 'payment-SPL1.jpg',
      type: 'image/jpeg',
    });
    assert.equal(init.headers['content-type'], undefined, 'the transport must write the boundary itself');
    assert.equal(init.headers.authorization, 'Bearer sess');
    assert.equal(init.via, 'xhr', "a {uri} part through Expo's fetch never leaves the phone");
  });

  test('approved: the date is recorded and the licence synced before it resolves', async () => {
    const paid = NOW + 30 * 86_400_000;
    let call = 0;
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), init });
      call++;
      const body =
        call === 1
          ? { status: 'approved', plan: 'monthly', paidThrough: paid, details: { utr: '123', amountPaise: 2900 } }
          : { entitled: true, token: 'good.token', paidThrough: paid, plan: 'monthly' };
      return { ok: true, status: 200, json: async () => body };
    };
    native.handlers.rememberLicence = () => {
      native.handlers.licenceStatus = () => ({
        entitled: true,
        expiresAt: NOW + 3 * 86_400_000,
        plan: 'monthly',
        device: 'dev',
        server: SERVER,
      });
      return true;
    };
    await savePendingOrder({ order: 'SPL1', upiUrl: 'upi://x', expiresAt: NOW + 1000 });

    const claim = await submitScreenshot('SPL1', 'file:///x.jpg', 'text');

    assert.equal(claim.status, 'approved');
    assert.equal(claim.details.utr, '123');
    assert.equal(licence().entitled, true, 'the token landed before the sheet was told');
    assert.equal(licence().paidThrough, paid);
    assert.ok(sent[1].url.includes('/v1/licence?device=dev'));
    assert.equal(await loadPendingOrder(), null, 'a settled order is not offered again');
  });

  test('rejected: the reasons and the WhatsApp message come through untouched', async () => {
    answer(200, {
      status: 'rejected',
      reasons: ['The amount does not match.', 'The payee is someone else.'],
      details: { utr: '9', amountPaise: 100, paidAt: null, payer: null },
      whatsapp: '919464263538',
      message: 'Hi, order SPL1',
    });

    const claim = await submitScreenshot('SPL1', 'file:///x.jpg', '');

    assert.equal(claim.status, 'rejected');
    assert.deepEqual(claim.reasons, ['The amount does not match.', 'The payee is someone else.']);
    assert.equal(claim.message, 'Hi, order SPL1');
  });

  test('every 4xx the contract names is a sentence, not a code', async () => {
    for (const error of ['bad order', 'no image', 'not an image', 'image too large']) {
      answer(400, { error });
      const claim = await submitScreenshot('SPL1', 'file:///x.jpg', '');
      assert.equal(claim.status, 'error');
      assert.doesNotMatch(claim.message, new RegExp(error));
    }
    answer(409, { error: 'order already used' });
    assert.match((await submitScreenshot('SPL1', 'file:///x.jpg', '')).message, /already been sent/);
  });
});

describe('the pending order', () => {
  test('survives a process death, and expires', async () => {
    await savePendingOrder({ order: 'SPL1', upiUrl: 'upi://x', expiresAt: NOW + 1000 });
    assert.equal((await loadPendingOrder(NOW)).order, 'SPL1');
    assert.equal(await loadPendingOrder(NOW + 2000), null);
  });
});
