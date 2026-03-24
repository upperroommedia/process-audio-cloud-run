const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  downloadYouTubeSection,
  getYouTubeAudioUrl,
  getYouTubeTrimRoutingDecision,
} = require('../dist/processYouTubeUrl');
const { CancelToken } = require('../dist/CancelToken');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mockRealtimeDb = {
  ref: () => ({
    get: async () => ({
      exists: () => false,
      val: () => null,
    }),
  }),
};

const cases = [
  {
    name: 'Post-live DVR deep offset',
    url: 'https://www.youtube.com/watch?v=wgWazlLy3nU',
    startTime: 2476,
    duration: 20,
    expectedStrategies: ['direct_url', 'section_download'],
    toleranceSeconds: 2,
  },
  {
    name: 'Classic upload baseline',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    startTime: 30,
    duration: 20,
    expectedStrategy: 'direct_url',
    toleranceSeconds: 2,
  },
  {
    name: 'Long-form upload baseline',
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    startTime: 60,
    duration: 20,
    expectedStrategy: 'direct_url',
    toleranceSeconds: 2,
  },
];

function ffprobeDuration(filePath) {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', filePath],
    { encoding: 'utf8' }
  );
  if (probe.status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${probe.stderr || probe.stdout}`);
  }
  const value = Number.parseFloat((probe.stdout || '').trim());
  if (!Number.isFinite(value)) {
    throw new Error(`ffprobe returned non-numeric duration for ${filePath}: ${probe.stdout}`);
  }
  return value;
}

async function runCase(testCase) {
  const decision = await getYouTubeTrimRoutingDecision('yt-dlp', testCase.url, mockRealtimeDb);
  const outputBase = path.resolve(
    process.cwd(),
    '.tmp',
    'verification',
    `routing-${testCase.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  );
  fs.mkdirSync(path.dirname(outputBase), { recursive: true });

  let outputPath = '';
  if (decision.strategy === 'direct_url') {
    const direct = await getYouTubeAudioUrl('yt-dlp', testCase.url, mockRealtimeDb);
    outputPath = `${outputBase}.m4a`;
    const ffmpeg = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-seek_timestamp',
        '1',
        '-ss',
        String(testCase.startTime),
        '-i',
        direct.url,
        '-t',
        String(testCase.duration),
        '-vn',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        outputPath,
      ],
      { encoding: 'utf8' }
    );
    if (ffmpeg.status !== 0) {
      throw new Error(`ffmpeg direct trim failed: ${ffmpeg.stderr || ffmpeg.stdout}`);
    }
  } else {
    outputPath = await downloadYouTubeSection(
      'yt-dlp',
      testCase.url,
      outputBase,
      new CancelToken(),
      () => {},
      mockRealtimeDb,
      testCase.startTime,
      testCase.duration
    );
  }

  const actualDuration = ffprobeDuration(outputPath);
  const durationDiff = Math.abs(actualDuration - testCase.duration);
  const allowedStrategies = Array.isArray(testCase.expectedStrategies)
    ? testCase.expectedStrategies
    : testCase.expectedStrategy
      ? [testCase.expectedStrategy]
      : [];
  const strategyMatches = allowedStrategies.length === 0 || allowedStrategies.includes(decision.strategy);
  const durationMatches = durationDiff <= testCase.toleranceSeconds;

  return {
    name: testCase.name,
    url: testCase.url,
    expectedStrategy: testCase.expectedStrategy,
    expectedStrategies: allowedStrategies,
    strategy: decision.strategy,
    reason: decision.reason,
    hasFragments: decision.hasFragments,
    likelyDvr: decision.likelyDvr,
    fragmentCount: decision.fragmentCount,
    startTime: testCase.startTime,
    requestedDuration: testCase.duration,
    outputPath,
    actualDuration,
    durationDiff,
    strategyMatches,
    durationMatches,
    ok: strategyMatches && durationMatches,
  };
}

async function main() {
  const results = [];
  let failed = false;

  for (const testCase of cases) {
    process.stdout.write(`\n[verify] ${testCase.name} ...\n`);
    try {
      const result = await runCase(testCase);
      results.push(result);
      const expectedLabel = result.expectedStrategies?.length
        ? result.expectedStrategies.join('|')
        : result.expectedStrategy || 'any';
      process.stdout.write(
        `[verify] strategy=${result.strategy} expected=${expectedLabel} duration=${result.actualDuration.toFixed(
          3
        )}s diff=${result.durationDiff.toFixed(3)}s ok=${result.ok}\n`
      );
      if (!result.ok) {
        failed = true;
      }
    } catch (err) {
      failed = true;
      results.push({
        name: testCase.name,
        url: testCase.url,
        error: err instanceof Error ? err.message : String(err),
        ok: false,
      });
      process.stdout.write(`[verify] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  process.stdout.write(`\n[verify] summary\n${JSON.stringify(results, null, 2)}\n`);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
