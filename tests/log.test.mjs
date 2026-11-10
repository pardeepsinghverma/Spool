import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as storage from './harness/stubs/async-storage.mjs';
import * as log from '../src/core/log.ts';

/**
 * The flight recorder.
 *
 * Everything here is a property of the *logger*, not of any feature that uses
 * it, and they are all about the same worry: this code runs on the failure
 * path. It is reached when a download is already dying, when a promise has
 * already rejected, when the process is about to be killed. So the interesting
 * cases are the hostile ones — a circular object, a getter that throws, a
 * storage layer that is refusing writes — and the property being asserted is
 * almost always "and it still did not throw".
 */

beforeEach(() => {
  storage.reset();
  log.reset();
});

describe('never taking the app down with it', () => {
  test('a circular object is recorded rather than thrown over', () => {
    const loop = { name: 'a' };
    loop.self = loop;
    log.info('test', 'circular', { loop });
    assert.equal(log.entries().length, 1);
    // The cycle is cut by the depth limit, not by a throw.
    assert.doesNotThrow(() => JSON.stringify(log.entries()[0]));
  });

  test('a getter that throws does not become the crash', () => {
    const hostile = {
      get boom() {
        throw new Error('no');
      },
    };
    assert.doesNotThrow(() => log.info('test', 'hostile', { hostile }));
    assert.equal(log.entries().length, 1);
  });

  test('a mirror that throws loses the echo, not the entry', () => {
    log.setMirror(() => {
      throw new Error('console is gone');
    });
    assert.doesNotThrow(() => log.info('test', 'mirrored'));
    assert.equal(log.entries().length, 1);
  });

  test('a storage layer refusing writes is not an error worth raising', async () => {
    storage.faults.write = true;
    log.error('test', 'something broke');
    await assert.doesNotReject(() => log.flush());
    // Still in memory, which is what matters for an export in this session.
    assert.equal(log.entries().length, 1);
  });

  test('unparseable stored history reads as no history', async () => {
    storage.seed('dl.log.prev', '{not json');
    assert.deepEqual(await log.previous(), []);
  });
});

describe('what must never be written down', () => {
  test('a token is reduced to the fact that there was one', () => {
    log.info('test', 'download', { poToken: 'MnRxAbCdEf', url: 'https://x/y' });
    const { data } = log.entries()[0];
    assert.equal(data.poToken, '<redacted 10>');
    assert.equal(data.url, 'https://x/y', 'a url is not a secret and is worth having');
  });

  test('every spelling of a credential is caught, and absence stays absence', () => {
    log.info('test', 'x', {
      visitorData: 'ok',
      cookieJar: 'a=b',
      authHeader: 'Bearer z',
      sessionId: '12345',
      poToken: null,
    });
    const { data } = log.entries()[0];
    assert.equal(data.cookieJar, '<redacted 3>');
    assert.equal(data.authHeader, '<redacted 8>');
    assert.equal(data.sessionId, '<redacted 5>');
    assert.equal(data.poToken, null, 'nothing to hide is worth saying plainly');
    assert.equal(data.visitorData, 'ok', 'not a credential: it identifies a session, not a right');
  });

  test('a secret nested one level down is still a secret', () => {
    log.info('test', 'x', { args: { poToken: 'abcdef' } });
    assert.equal(log.entries()[0].data.args.poToken, '<redacted 6>');
  });
});

describe('staying bounded', () => {
  test('one enormous string cannot crowd out the history', () => {
    log.info('test', 'big', { blob: 'x'.repeat(10_000) });
    const { blob } = log.entries()[0].data;
    assert.ok(blob.length < 2200, `kept ${blob.length}`);
    assert.match(blob, /\.\.\.\+8000$/, 'and it says how much was dropped');
  });

  test('the ring evicts the oldest rather than growing without limit', () => {
    for (let i = 0; i < 1200; i++) log.info('test', `entry ${i}`);
    const all = log.entries();
    assert.equal(all.length, 900);
    assert.equal(all[0].msg, 'entry 300', 'the oldest went first');
    assert.equal(all[899].msg, 'entry 1199');
  });

  test('debug is dropped unless someone asked for it', () => {
    log.debug('test', 'chatty');
    assert.equal(log.entries().length, 0);
    log.setVerbose(true);
    log.debug('test', 'chatty');
    assert.equal(log.entries().length, 1);
  });
});

describe('describing a failure', () => {
  test('the native error code is pulled out, because that is the discriminator', () => {
    const e = Object.assign(new Error('Download produced no file'), { code: 'E_NO_OUTPUT' });
    const d = log.describe(e);
    assert.equal(d.code, 'E_NO_OUTPUT');
    assert.equal(d.message, 'Download produced no file');
  });

  test('a thrown string is described rather than dropped', () => {
    assert.equal(log.describe('just a string').message, 'just a string');
    assert.equal(log.describe(undefined).message, 'undefined');
  });

  test('a coded error keeps no stack, because the stack is only the bridge', () => {
    // Anything carrying a native code was built by CodedError on the way out of
    // the module: its stack names the bridge and then a bundle URL, while the
    // failure itself happened in Python and is already in `message`. Measured
    // on the device: one refused client wrote ~700 bytes of which about 30 were
    // about the refusal, five times per walk.
    const e = Object.assign(new Error('ERROR: [youtube] x: Unable to download API page'), {
      code: 'E_EXTRACT',
    });
    e.stack = 'Error: ...\n    at CodedError (http://10.0.2.2:8081/index.bundle//&platform=android)';

    const d = log.describe(e);
    assert.equal(d.stack, undefined);
    assert.equal(d.code, 'E_EXTRACT');
    assert.match(d.message, /Unable to download/);
  });

  test('an uncoded error keeps one, because it is the only thing that says where', () => {
    const e = new Error('x');
    e.stack = ['Error: x', ...Array.from({ length: 40 }, (_, i) => `    at f${i}`)].join('\n');
    assert.equal(log.describe(e).stack.split('\n').length, 8);
  });
});

describe('correlating a flow', () => {
  test('every entry shares one id and carries its own elapsed time', () => {
    const f = log.flow('download', 'job-1', { videoId: 'abc' });
    f.step('asking');
    f.ok('done');

    const all = log.entries();
    assert.equal(all.length, 3);
    assert.equal(new Set(all.map((e) => e.flow)).size, 1, 'one id across the flow');
    for (const e of all) assert.equal(typeof e.ms, 'number');
    assert.equal(all[0].msg, '>> job-1');
    assert.equal(all[2].msg, 'OK done');
  });

  test('two overlapping flows do not read as one', () => {
    const a = log.flow('download', 'job-a');
    const b = log.flow('download', 'job-b');
    a.step('a1');
    b.step('b1');
    const ids = log.entries().map((e) => e.flow);
    assert.equal(new Set(ids).size, 2);
    assert.notEqual(ids[0], ids[1]);
  });

  test('a failure records at error level and keeps the native code', () => {
    const f = log.flow('download', 'job-1');
    f.fail(Object.assign(new Error('nope'), { code: 'E_DOWNLOAD' }));
    const last = log.entries().at(-1);
    assert.equal(last.level, 'error');
    assert.equal(last.data.code, 'E_DOWNLOAD');
  });

  test('giving up is a warning, not an error — a cancel is not a fault', () => {
    const f = log.flow('download', 'job-1');
    f.gaveUp('cancelled');
    assert.equal(log.entries().at(-1).level, 'warn');
  });
});

describe('surviving the process', () => {
  test('the previous run is moved aside before this one writes over it', async () => {
    storage.seed('dl.log', JSON.stringify([{ t: 1, level: 'info', scope: 'old', msg: 'before' }]));

    await log.restore();

    const prev = await log.previous();
    assert.equal(prev.length, 1);
    assert.equal(prev[0].msg, 'before');
    assert.equal(storage.raw('dl.log'), null, 'this run starts with a clean key');
  });

  test('restoring twice does not lose the run it saved the first time', async () => {
    storage.seed('dl.log', JSON.stringify([{ t: 1, level: 'info', scope: 'old', msg: 'before' }]));
    await log.restore();
    await log.restore();
    assert.equal((await log.previous())[0].msg, 'before');
  });

  test('a flush writes the ring where the next launch will look', async () => {
    log.info('test', 'kept');
    await log.flush();
    const written = JSON.parse(storage.raw('dl.log'));
    assert.equal(written.length, 1);
    assert.equal(written[0].msg, 'kept');
  });
});

describe('the exported file', () => {
  test('the previous run comes first, because that is the one that broke', () => {
    const prev = [{ t: 0, level: 'error', scope: 'crash', msg: 'fatal error' }];
    const now = [{ t: 0, level: 'info', scope: 'boot', msg: 'bundle loaded' }];
    const text = log.dump(prev, now, { app: 'Spool android' });

    assert.ok(text.indexOf('previous run') < text.indexOf('this run'));
    assert.ok(text.includes('fatal error'));
    assert.ok(text.includes('app: Spool android'));
  });

  test('a run with no history does not claim an empty previous section', () => {
    const text = log.dump([], [{ t: 0, level: 'info', scope: 'boot', msg: 'x' }]);
    assert.ok(!text.includes('previous run'));
  });

  test('a line names its level, scope, flow and elapsed time', () => {
    const rendered = log.line({
      t: Date.parse('2026-08-21T10:20:30.400Z'),
      level: 'error',
      scope: 'download',
      msg: 'XX job-1',
      flow: 'download#1',
      ms: 1500,
      data: { code: 'E_DOWNLOAD' },
    });
    assert.match(rendered, /^\d\d:\d\d:\d\d\.\d\d\d E download /);
    assert.ok(rendered.includes('[download#1]'));
    assert.ok(rendered.includes('+1.50s'));
    assert.ok(rendered.includes('"code":"E_DOWNLOAD"'));
  });
});
