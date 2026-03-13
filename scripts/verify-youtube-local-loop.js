const fs = require('node:fs');
const path = require('node:path');

const { getYouTubeAudioUrl, getYouTubeTrimRoutingDecision, downloadYouTubeSection } = require('../dist/processYouTubeUrl');
const { createContext } = require('../dist/context');
const { CancelToken } = require('../dist/CancelToken');

process.env.NODE_ENV = 'production';

const fakeYtdlpPath = '/usr/src/app/scripts/fake-ytdlp.sh';
const artifactsDir = path.join(process.cwd(), '.tmp', 'youtube-loop');
fs.mkdirSync(artifactsDir, { recursive: true });
fs.chmodSync(fakeYtdlpPath, 0o755);

function createMockRealtimeDb(initialData) {
  const store = { ...initialData };
  return {
    _store: store,
    ref(key) {
      return {
        async get() {
          return {
            exists: () => Object.prototype.hasOwnProperty.call(store, key),
            val: () => store[key],
          };
        },
        async update(patch) {
          store[key] = { ...(store[key] || {}), ...patch };
        },
        async set(value) {
          store[key] = value;
        },
        async remove() {
          delete store[key];
        },
        async transaction(updateFn) {
          const next = updateFn(store[key]);
          if (typeof next === 'undefined') {
            return {
              committed: false,
              snapshot: {
                val: () => store[key],
              },
            };
          }
          store[key] = next;
          return {
            committed: true,
            snapshot: {
              val: () => store[key],
            },
          };
        },
      };
    },
  };
}

function encodeCookies() {
  return Buffer.from('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSAPISID\tfake\n', 'utf8').toString('base64');
}

async function runCase(testCase) {
  process.env.FAKE_YTDLP_SCENARIO = testCase.scenario;
  process.env.YOUTUBE_BROWSER_FALLBACK_URL = testCase.browserFallback ? 'http://browser-fallback:8090/fallback' : '';
  process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED = testCase.browserFallback ? 'true' : 'false';
  process.env.YOUTUBE_COOKIE_CIRCUIT_BREAKER_MINUTES = '30';

  const realtimeDb = createMockRealtimeDb(testCase.realtimeDb || {});
  const ctx = createContext(`local-${testCase.name}`, 'process-audio.trim');
  const url = 'https://www.youtube.com/watch?v=testvideo';
  const artifact = {
    name: testCase.name,
    scenario: testCase.scenario,
    browserFallback: testCase.browserFallback,
    status: 'pending',
  };

  try {
    let result;
    if (testCase.kind === 'direct') {
      result = await getYouTubeAudioUrl(fakeYtdlpPath, url, realtimeDb, ctx);
    } else if (testCase.kind === 'routing') {
      result = await getYouTubeTrimRoutingDecision(fakeYtdlpPath, url, realtimeDb, ctx);
    } else if (testCase.kind === 'section') {
      const outputBase = path.join(artifactsDir, `${testCase.name}.section`);
      result = await downloadYouTubeSection(
        fakeYtdlpPath,
        url,
        outputBase,
        new CancelToken(),
        () => {},
        realtimeDb,
        0,
        20,
        ctx
      );
    } else {
      throw new Error(`Unsupported case kind: ${testCase.kind}`);
    }

    artifact.status = 'ok';
    artifact.result = result;
    artifact.cookieMeta = realtimeDb._store['yt-dlp-cookies-meta'] || null;

    if (testCase.expectError) {
      throw new Error(`Expected failure but case succeeded: ${testCase.name}`);
    }
    if (testCase.assert) {
      testCase.assert(result, artifact.cookieMeta);
    }
  } catch (error) {
    artifact.status = 'error';
    artifact.error = error instanceof Error ? error.message : String(error);
    artifact.cookieMeta = realtimeDb._store['yt-dlp-cookies-meta'] || null;
    if (!testCase.expectError) {
      throw error;
    }
    if (testCase.assertError) {
      testCase.assertError(artifact.error, artifact.cookieMeta);
    }
  } finally {
    const artifactPath = path.join(artifactsDir, `${testCase.name}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  }
}

const cases = [
  {
    name: 'public-success-direct',
    kind: 'direct',
    scenario: 'public_success',
    browserFallback: false,
    realtimeDb: {},
    assert(result) {
      if (!result.url.includes('https://example.com/fake-audio.m4a')) {
        throw new Error('public-success-direct did not return the expected direct URL');
      }
    },
  },
  {
    name: 'cookie-stale-error',
    kind: 'direct',
    scenario: 'public_bot_cookie_stale',
    browserFallback: false,
    expectError: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
        exportMethod: 'manual-private-window',
        profileType: 'incognito',
      },
    },
    assertError(error, cookieMeta) {
      if (!String(error).includes('stale or challenged')) {
        throw new Error('cookie-stale-error did not surface the stale cookie failure');
      }
      if (!cookieMeta?.disabledUntil) {
        throw new Error('cookie-stale-error did not open the cookie circuit breaker');
      }
    },
  },
  {
    name: 'browser-fallback-direct',
    kind: 'direct',
    scenario: 'public_bot_cookie_stale',
    browserFallback: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
      },
    },
    assert(result) {
      if (!String(result.url).includes('browser-fallback-audio.m4a')) {
        throw new Error('browser-fallback-direct did not use the browser fallback URL');
      }
    },
  },
  {
    name: 'browser-fallback-section',
    kind: 'section',
    scenario: 'public_bot_cookie_stale',
    browserFallback: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        disabledUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        consecutiveFailures: 2,
      },
    },
    assert(result) {
      if (!fs.existsSync(result)) {
        throw new Error('browser-fallback-section did not write the fallback download to disk');
      }
    },
  },
];

async function main() {
  const summary = [];
  for (const testCase of cases) {
    process.stdout.write(`[youtube-loop] ${testCase.name}\n`);
    await runCase(testCase);
    summary.push({ name: testCase.name, status: 'ok' });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
