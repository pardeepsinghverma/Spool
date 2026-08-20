import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import { bestAudio, kbpsFromQuality } from '../src/browser/formatView.ts';

/**
 * The extraction layer, which is the part of Spool that YouTube is actively
 * trying to break.
 *
 * Two things are worth testing here and nothing else is: the client walk, which
 * is what turns "the app stopped working" into "the app got slower for a
 * moment"; and the parse, which is the only thing standing between yt-dlp's
 * output and a quality picker full of nonsense.
 *
 * Each case takes a fresh copy of the module — `preferredClient` and
 * `triedUpdate` are deliberately session-scoped, so a shared instance would
 * mean every test after the first ran against a warmed-up chain.
 */

let counter = 0;
const load = () => import(`../src/core/ytdlp.ts?fresh=${counter++}`);

beforeEach(native.reset);

const CHAIN = ['android_vr', 'tv', 'ios', 'web', null];

const blocked = () => Object.assign(new Error('HTTP Error 403: Forbidden'), { code: 'E_LIST' });

/** yt-dlp's own output, trimmed to the fields the parser reads. */
const payload = (over = {}) =>
  JSON.stringify({
    id: 'dQw4w9WgXcQ',
    title: 'A song',
    channel: 'A channel',
    duration: 212,
    formats: [],
    ...over,
  });

const ref = { videoId: 'dQw4w9WgXcQ', url: 'https://m.youtube.com/watch?v=dQw4w9WgXcQ', title: 'A song' };

/** Which client each listFormats call asked as, in order. */
const clientsTried = () => native.callsTo('listFormats').map((args) => args[3]);

describe('the client walk', () => {
  test('stops at the first client that answers', async () => {
    const { listFormats } = await load();
    await listFormats(ref);
    assert.deepEqual(clientsTried(), ['android_vr']);
  });

  test('walks the whole chain past a refusal', async () => {
    native.handlers.listFormats = async (_url, _pot, _vd, client) => {
      if (client !== 'web') throw blocked();
      return payload();
    };
    const { listFormats } = await load();
    const meta = await listFormats(ref);
    assert.deepEqual(clientsTried(), ['android_vr', 'tv', 'ios', 'web']);
    assert.equal(meta.title, 'A song');
  });

  test('remembers what worked, so the next call does not walk again', async () => {
    native.handlers.listFormats = async (_url, _pot, _vd, client) => {
      if (client !== 'ios') throw blocked();
      return payload();
    };
    const { listFormats } = await load();
    await listFormats(ref);
    native.calls.length = 0;
    await listFormats(ref);
    assert.deepEqual(clientsTried(), ['ios'], 'the working client is tried first');
  });

  test('a client with nothing usable is a refusal, not an answer', async () => {
    // Measured on the phone: a client refused mid-download hands back a manifest
    // with nothing in it, and yt-dlp calls that "Requested format is not
    // available". Reading it as a real answer stopped the walk on the second
    // client of five and failed the download with four still untried.
    const empty = () =>
      Object.assign(
        new Error('ERROR: [youtube] abc: Requested format is not available. Use --list-formats'),
        { code: 'E_LIST' },
      );
    native.handlers.listFormats = async (_url, _pot, _vd, client) => {
      if (client !== 'web') throw empty();
      return payload();
    };

    const { listFormats } = await load();
    await listFormats(ref);
    assert.deepEqual(clientsTried(), ['android_vr', 'tv', 'ios', 'web']);
  });

  test('a remembered client that stops working is not tried twice in one walk', async () => {
    let allow = 'ios';
    native.handlers.listFormats = async (_url, _pot, _vd, client) => {
      if (client !== allow) throw blocked();
      return payload();
    };
    const { listFormats } = await load();
    await listFormats(ref);
    allow = 'tv';
    native.calls.length = 0;
    await listFormats(ref);
    assert.deepEqual(clientsTried(), ['ios', 'android_vr', 'tv']);
  });

  test('a token pins the request, so there is nothing to walk', async () => {
    // A PO token pins the request to the web client, so walking the chain would
    // repeat the identical request five times.
    const { listFormats } = await load();
    await listFormats(ref, { poToken: 'abc', visitorData: 'def' });
    assert.deepEqual(clientsTried(), [null]);
    assert.deepEqual(native.callsTo('listFormats')[0].slice(1, 3), ['abc', 'def']);
  });

  test('visitorData without a token still walks', async () => {
    const { listFormats } = await load();
    await listFormats(ref, { visitorData: 'def' });
    assert.deepEqual(clientsTried(), ['android_vr']);
  });
});

describe('what counts as a refusal', () => {
  test('every shape of block keeps the walk going', async () => {
    for (const message of [
      'HTTP Error 403: Forbidden',
      'Sign in to confirm you are not a bot',
      'ERROR: unable to download video data',
      'Failed to extract any player response',
      'Precondition check failed',
      'Video unavailable',
    ]) {
      native.reset();
      let asked = 0;
      native.handlers.listFormats = async () => {
        asked++;
        throw new Error(message);
      };
      native.handlers.updateEngine = async () => {
        throw new Error('offline');
      };
      const { listFormats } = await load();
      await assert.rejects(() => listFormats(ref));
      assert.equal(asked, CHAIN.length, message);
    }
  });

  test('anything else is thrown at once rather than tried five times', async () => {
    // A broken pipe, a full disk or a cancel is not a reason to ask a different
    // client the same question.
    for (const message of ['ENOSPC: no space left on device', 'Download cancelled']) {
      native.reset();
      let asked = 0;
      native.handlers.listFormats = async () => {
        asked++;
        throw new Error(message);
      };
      const { listFormats } = await load();
      await assert.rejects(() => listFormats(ref), new RegExp(message.split(':')[0]));
      assert.equal(asked, 1, message);
    }
  });
});

describe('self-repair', () => {
  test('repairs the extractor once when every client is refused, then walks again', async () => {
    let updated = false;
    native.handlers.listFormats = async () => {
      if (!updated) throw blocked();
      return payload();
    };
    native.handlers.updateEngine = async () => {
      updated = true;
      return { status: 'updated', version: '2026.03.03' };
    };

    const { listFormats } = await load();
    await listFormats(ref);
    assert.equal(native.callsTo('updateEngine').length, 1);
    assert.equal(clientsTried().length, CHAIN.length + 1);
    assert.equal(clientsTried()[CHAIN.length], 'android_vr', 'the chain restarts from the top');
  });

  test('only once per session — it is a network call', async () => {
    native.handlers.listFormats = async () => {
      throw blocked();
    };
    const { listFormats } = await load();
    await assert.rejects(() => listFormats(ref));
    native.calls.length = 0;
    await assert.rejects(() => listFormats(ref));
    assert.equal(native.callsTo('updateEngine').length, 0);
    assert.equal(clientsTried().length, CHAIN.length, 'one walk, no second update');
  });

  test('an update that fails does not bury the reason the download failed', async () => {
    native.handlers.listFormats = async () => {
      throw new Error('HTTP Error 403: Forbidden');
    };
    native.handlers.updateEngine = async () => {
      throw new Error('no network');
    };
    const { listFormats } = await load();
    await assert.rejects(() => listFormats(ref), /403/);
  });

  test('the engine is extracted once however many callers arrive', async () => {
    let inits = 0;
    native.handlers.initialize = async () => {
      inits++;
      return '2026.01.01';
    };
    const { listFormats } = await load();
    await Promise.all([listFormats(ref), listFormats(ref), listFormats(ref)]);
    assert.equal(inits, 1);
  });

  test('a failed extraction is retried rather than remembered as done', async () => {
    let inits = 0;
    native.handlers.initialize = async () => {
      inits++;
      if (inits === 1) throw new Error('unzip failed');
      return '2026.01.01';
    };
    const { listFormats } = await load();
    await assert.rejects(() => listFormats(ref), /unzip failed/);
    await listFormats(ref);
    assert.equal(inits, 2);
  });
});

describe('parsing what the engine returns', () => {
  const format = (over) => ({
    format_id: '0',
    ext: 'mp4',
    vcodec: 'none',
    acodec: 'none',
    ...over,
  });

  test('malformed metadata is reported as such, not as a crash', async () => {
    native.handlers.listFormats = async () => '<html>are you a robot</html>';
    const { listFormats } = await load();
    await assert.rejects(() => listFormats(ref), /malformed metadata/);
  });

  test('missing fields fall back to what the caller already knew', async () => {
    native.handlers.listFormats = async () => JSON.stringify({});
    const { listFormats } = await load();
    const meta = await listFormats(ref);
    assert.equal(meta.id, ref.videoId);
    assert.equal(meta.title, ref.title);
    assert.equal(meta.channel, '');
    assert.equal(meta.durationSeconds, 0);
    assert.deepEqual(meta.formats, []);
  });

  test('uploader stands in for a missing channel', async () => {
    native.handlers.listFormats = async () => payload({ channel: undefined, uploader: 'Someone' });
    const { listFormats } = await load();
    assert.equal((await listFormats(ref)).channel, 'Someone');
  });

  test('storyboards are not qualities anyone can pick', async () => {
    native.handlers.listFormats = async () =>
      payload({
        formats: [
          format({ format_id: 'sb0', ext: 'mhtml', vcodec: 'none', acodec: 'none' }),
          format({ format_id: 'sb1', ext: 'mhtml' }),
          format({ format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', abr: 128 }),
        ],
      });
    const { listFormats } = await load();
    const meta = await listFormats(ref);
    assert.deepEqual(meta.formats.map((f) => f.id), ['140']);
  });

  test('a stream with neither audio nor video is dropped', async () => {
    native.handlers.listFormats = async () =>
      payload({ formats: [format({ format_id: 'x' }), format({ format_id: 'y', acodec: null })] });
    const { listFormats } = await load();
    assert.deepEqual((await listFormats(ref)).formats, []);
  });

  test('codecs are shortened to something a person recognises', async () => {
    native.handlers.listFormats = async () =>
      payload({
        formats: [
          format({ format_id: '1', vcodec: 'avc1.640028', height: 1080 }),
          format({ format_id: '2', vcodec: 'vp09.00.40.08', height: 720 }),
          format({ format_id: '3', vcodec: 'av01.0.08M.08', height: 480 }),
          format({ format_id: '4', acodec: 'mp4a.40.2', ext: 'm4a' }),
          format({ format_id: '5', acodec: 'opus', ext: 'webm' }),
          format({ format_id: '6', vcodec: 'exotic.1', height: 360 }),
        ],
      });
    const { listFormats } = await load();
    const codecs = Object.fromEntries(
      (await listFormats(ref)).formats.map((f) => [f.id, f.codec]),
    );
    assert.deepEqual(codecs, {
      1: 'h264',
      2: 'vp9',
      3: 'av1',
      4: 'aac',
      5: 'opus',
      6: 'exotic',
    });
  });

  test('a muxed stream is marked as carrying its own audio', async () => {
    native.handlers.listFormats = async () =>
      payload({
        formats: [
          format({ format_id: '18', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360 }),
          format({ format_id: '137', vcodec: 'avc1.640028', height: 1080 }),
        ],
      });
    const { listFormats } = await load();
    const meta = await listFormats(ref);
    assert.equal(meta.formats.find((f) => f.id === '18').muxed, true);
    assert.equal(meta.formats.find((f) => f.id === '137').muxed, false);
  });

  test('an approximate size stands in for a missing one', async () => {
    native.handlers.listFormats = async () =>
      payload({
        formats: [
          format({ format_id: 'a', acodec: 'opus', ext: 'webm', filesize: null, filesize_approx: 999 }),
        ],
      });
    const { listFormats } = await load();
    assert.equal((await listFormats(ref)).formats[0].size, 999);
  });

  test('video first, then tallest first', async () => {
    native.handlers.listFormats = async () =>
      payload({
        formats: [
          format({ format_id: 'a', acodec: 'mp4a.40.2', ext: 'm4a', abr: 128 }),
          format({ format_id: '720', vcodec: 'avc1', height: 720 }),
          format({ format_id: '2160', vcodec: 'avc1', height: 2160 }),
          format({ format_id: '1080', vcodec: 'avc1', height: 1080 }),
        ],
      });
    const { listFormats } = await load();
    assert.deepEqual(
      (await listFormats(ref)).formats.map((f) => f.id),
      ['2160', '1080', '720', 'a'],
    );
  });
});

describe('collapsing near-identical rungs', () => {
  test('keeps the largest file at each resolution', async () => {
    native.handlers.listFormats = async () =>
      JSON.stringify({
        formats: [
          { format_id: 'small', vcodec: 'vp9', height: 1080, filesize: 100 },
          { format_id: 'big', vcodec: 'avc1', height: 1080, filesize: 900 },
          { format_id: 'mid', vcodec: 'av01', height: 1080, filesize: 500 },
        ],
      });
    const { listFormats } = await load();
    const formats = (await listFormats(ref)).formats;
    assert.equal(formats.length, 1);
    assert.equal(formats[0].id, 'big');
  });

  test('a muxed rung is kept alongside the split one at the same height', async () => {
    native.handlers.listFormats = async () =>
      JSON.stringify({
        formats: [
          { format_id: '18', vcodec: 'avc1', acodec: 'mp4a', height: 360, filesize: 10 },
          { format_id: '134', vcodec: 'avc1', height: 360, filesize: 20 },
        ],
      });
    const { listFormats } = await load();
    assert.equal((await listFormats(ref)).formats.length, 2);
  });

  test('every audio rung in a container collapses to the biggest one', async () => {
    // This is the real shape of a YouTube listing, and the consequence is the
    // next test: audio is keyed by container alone, so 139 (48 kbps) and 140
    // (128 kbps) are the same key and only the larger survives.
    const { listFormats } = await load();
    native.handlers.listFormats = async () => YOUTUBE_AUDIO_LISTING;
    const formats = (await listFormats(ref)).formats;
    assert.deepEqual(
      formats.map((f) => `${f.id}@${f.kbps}`),
      ['140@128', '251@160'],
    );
  });

  test('so the Profile screen offers audio qualities the engine cannot honour', async () => {
    // "96 kbps" and "128 kbps" are both offered on Profile. After the collapse
    // the only rungs left are 128 (m4a) and 160 (opus), so 96 resolves to 128 —
    // the picker's lowest two settings produce the same file.
    const { listFormats } = await load();
    native.handlers.listFormats = async () => YOUTUBE_AUDIO_LISTING;
    const formats = (await listFormats(ref)).formats;

    const at = (setting) => bestAudio(formats, kbpsFromQuality(setting));
    assert.equal(at('Best available').kbps, 160);
    assert.equal(at('160 kbps').kbps, 160);
    assert.equal(at('128 kbps').kbps, 128);
    assert.equal(at('96 kbps').kbps, 128, '96 kbps is not reachable');
  });
});

/** itags 139/140 (m4a) and 249/250/251 (webm), as yt-dlp lists them. */
const YOUTUBE_AUDIO_LISTING = JSON.stringify({
  formats: [
    { format_id: '139', ext: 'm4a', acodec: 'mp4a.40.5', abr: 48, filesize: 1_000_000 },
    { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', abr: 128, filesize: 3_400_000 },
    { format_id: '249', ext: 'webm', acodec: 'opus', abr: 50, filesize: 1_100_000 },
    { format_id: '250', ext: 'webm', acodec: 'opus', abr: 70, filesize: 1_500_000 },
    { format_id: '251', ext: 'webm', acodec: 'opus', abr: 160, filesize: 3_900_000 },
  ],
});

describe('starting a download', () => {
  test('pairs a video-only stream with audio, and leaves a muxed one alone', async () => {
    const { startDownload } = await load();
    const video = { id: '137', kind: 'video', container: 'mp4', codec: 'h264', muxed: false };
    const muxed = { ...video, id: '18', muxed: true };
    const audio = { id: '140', kind: 'audio', container: 'm4a', codec: 'aac', muxed: false };

    await startDownload({ id: 'j1', ref, format: video, audioOnly: false }, () => {}).promise;
    await startDownload({ id: 'j2', ref, format: muxed, audioOnly: false }, () => {}).promise;
    await startDownload({ id: 'j3', ref, format: audio, audioOnly: true }, () => {}).promise;

    assert.deepEqual(
      native.callsTo('download').map(([args]) => args.format),
      [
        '137+bestaudio/bestvideo+bestaudio/best',
        '18/bestvideo+bestaudio/best',
        '140/bestaudio',
      ],
    );
  });

  test('every id is followed by a description of what it was', async () => {
    // A format id only means anything inside the manifest it came from, and the
    // client that listed the formats is not always the client that downloads
    // them — the listing succeeds on android_vr, the download is refused there,
    // the chain moves on, and the id now names nothing. Measured twice in a row
    // on the phone as `Requested format is not available`, which `looksBlocked`
    // does not recognise, so it is not even retried.
    const { startDownload } = await load();
    const audio = { id: '140', kind: 'audio', container: 'm4a', codec: 'aac', muxed: false, kbps: 129.5 };
    const video = { id: '137', kind: 'video', container: 'mp4', codec: 'h264', muxed: false, height: 1080 };

    await startDownload({ id: 'a', ref, format: audio, audioOnly: true }, () => {}).promise;
    await startDownload({ id: 'v', ref, format: video, audioOnly: false }, () => {}).promise;

    const [asked, askedVideo] = native.callsTo('download').map(([args]) => args.format);
    // The exact stream is still asked for first; the rest is what any client can
    // satisfy, capped at what was chosen rather than demanding it.
    assert.equal(asked, '140/bestaudio[abr<=130]/bestaudio');
    assert.equal(askedVideo, '137+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]');
  });

  test('progress for another job is not this job\'s progress', async () => {
    const { startDownload } = await load();
    let resolve;
    const held = new Promise((r) => (resolve = r));
    native.handlers.download = () => held;

    const seen = [];
    const job = startDownload({ id: 'mine', ref, format: { id: '140', kind: 'audio', container: 'm4a', codec: 'aac', muxed: false }, audioOnly: true }, (p) => seen.push(p.fraction));

    native.emit('onProgress', { id: 'theirs', fraction: 0.9, eta: 1, line: '' });
    native.emit('onProgress', { id: 'mine', fraction: 0.5, eta: 30, line: '' });
    assert.deepEqual(seen, [0.5]);

    resolve({ path: '/x.m4a', bytes: 10 });
    await job.promise;
  });

  test('unsubscribes when the download ends, however it ends', async () => {
    const { startDownload } = await load();
    const format = { id: '140', kind: 'audio', container: 'm4a', codec: 'aac', muxed: false };

    await startDownload({ id: 'ok', ref, format, audioOnly: true }, () => {}).promise;
    assert.equal(native.listenerCount('onProgress'), 0);

    native.handlers.download = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
    await assert.rejects(
      () => startDownload({ id: 'bad', ref, format, audioOnly: true }, () => {}).promise,
    );
    assert.equal(native.listenerCount('onProgress'), 0);
  });

  test('cancelling detaches the listener and tells the engine', async () => {
    const { startDownload } = await load();
    native.handlers.download = () => new Promise(() => {});
    const job = startDownload(
      { id: 'j1', ref, format: { id: '140', kind: 'audio', container: 'm4a', codec: 'aac', muxed: false }, audioOnly: true },
      () => {},
    );
    await Promise.resolve();
    job.cancel();
    assert.equal(native.listenerCount('onProgress'), 0);
    assert.deepEqual(native.callsTo('cancel'), [['j1']]);
  });

  test('a cancel that the engine has already forgotten is not an error', async () => {
    const { startDownload } = await load();
    native.handlers.download = () => new Promise(() => {});
    native.handlers.cancel = async () => {
      throw new Error('no such job');
    };
    const job = startDownload(
      { id: 'j1', ref, format: { id: '140', kind: 'audio', container: 'm4a', codec: 'aac', muxed: false }, audioOnly: true },
      () => {},
    );
    await Promise.resolve();
    job.cancel();
    await Promise.resolve();
  });

  test('carries the length through so the native trial guard can refuse it', async () => {
    const { startDownload } = await load();
    await startDownload(
      {
        id: 'j1',
        ref,
        format: { id: '140', kind: 'audio', container: 'm4a', codec: 'aac', muxed: false },
        audioOnly: true,
        seconds: 4200,
      },
      () => {},
    ).promise;
    assert.equal(native.callsTo('download')[0][0].seconds, 4200);
  });
});
