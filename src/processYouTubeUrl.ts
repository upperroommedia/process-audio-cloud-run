import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mkdtemp, rm, unlink, writeFile } from 'fs/promises';
import { Database } from 'firebase-admin/database';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';
import { getFFmpegPath } from './utils';
import dns from 'node:dns/promises';

/**
 * Result from getYouTubeAudioUrl containing the direct stream URL and metadata
 */
export interface YouTubeAudioUrlResult {
  url: string;
  format: string;
  duration?: number;
}

interface YouTubeFragmentFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string;
  protocol?: string;
  abr?: number;
  duration?: number;
  fragments?: Array<{ url?: string }>;
}

interface YouTubeJsonInfo {
  duration?: number;
  formats?: YouTubeFragmentFormat[];
}

interface YouTubeAudioFragmentsResult {
  duration?: number;
  formatId: string;
  ext: string;
  fragmentUrls: string[];
  fragmentDurationSeconds: number;
}

export type YouTubeTrimRoutingStrategy = 'direct_url' | 'section_download';

export interface YouTubeTrimRoutingDecision {
  strategy: YouTubeTrimRoutingStrategy;
  reason: string;
  formatId?: string;
  protocol?: string;
  hasFragments: boolean;
  likelyDvr: boolean;
  fragmentCount?: number;
}

const YTDLP_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function isRunningInDocker(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || process.env.DOCKER === 'true';
  } catch {
    return false;
  }
}

function extractPercent(line: string): number | null {
  const percentMatch = line.match(/(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)%/);
  return percentMatch ? parseFloat(percentMatch[1]) : null;
}

/**
 * Extract time from ffmpeg progress output (e.g., "time=00:00:03.84")
 * Returns time in seconds, or null if not found
 */
function extractFfmpegTime(line: string): number | null {
  // Match time=HH:MM:SS.ms or time=MM:SS.ms format
  const timeMatch = line.match(/time=(-?\d{1,2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseInt(timeMatch[3], 10);
    const centiseconds = parseInt(timeMatch[4], 10);
    // Handle negative time (e.g., time=-00:00:01.97)
    const totalSeconds = Math.abs(hours) * 3600 + minutes * 60 + seconds + centiseconds / 100;
    return hours < 0 ? -totalSeconds : totalSeconds;
  }
  return null;
}

function formatTimeForDownloadSections(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function parseFragmentDurationFromUrl(fragmentUrl: string | undefined): number | undefined {
  if (!fragmentUrl) return undefined;
  const match = fragmentUrl.match(/\/dur\/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function annotateYtDlpAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('the page needs to be reloaded')) {
    return `${message} The configured YouTube cookie session appears stale or challenged. Rotate the yt-dlp cookies from a fresh private browsing session and retry.`;
  }
  if (lower.includes('sign in to confirm you’re not a bot') || lower.includes("sign in to confirm you're not a bot")) {
    return `${message} Verify that production is using fresh yt-dlp cookies and that YTDLP_POT_PROVIDER_BASE_URL points to a healthy PO-token provider.`;
  }
  return message;
}

async function runCommandWithCapture(
  command: string,
  args: string[],
  errorPrefix: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`${errorPrefix} spawn error: ${err}`));
    });
    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(annotateYtDlpAuthError(`${errorPrefix} exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr: ${stderr.trim()}`)));
    });
  });
}

/**
 * Prepares cookies arguments for yt-dlp based on environment
 * Returns the args array and the path to the cookies file (if created)
 */
async function prepareCookiesArgs(
  realtimeDB: Database,
  isDevelopment: boolean,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<{ args: string[]; cookiesFilePath?: string }> {
  const args: string[] = [];
  let cookiesFilePath: string | undefined;

  if (isDevelopment) {
    if (isRunningInDocker()) {
      log.warn('Skipping --cookies-from-browser in Docker (cookies cannot be decrypted without host keychain)');
    } else {
      log.info('Using cookies from Chrome browser (development mode)');
      args.push('--cookies-from-browser', 'chrome');
    }
  } else {
    ensureProductionPoTokenProviderConfigured(isDevelopment);
    cookiesFilePath = path.join(os.tmpdir(), `yt-dlp-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const cookiesPath = realtimeDB.ref('yt-dlp-cookies');
    const encodedCookies = await cookiesPath.get();

    if (encodedCookies.exists()) {
      try {
        const decodedCookies = Buffer.from(encodedCookies.val(), 'base64').toString('utf8');
        fs.writeFileSync(cookiesFilePath, decodedCookies, 'utf8');
        log.debug('Cookies file created from database', { path: cookiesFilePath });
        args.push('--cookies', cookiesFilePath);
      } catch (err) {
        log.error('Failed to decode and write cookies file', { error: err });
        throw new Error(`Failed to decode and write cookies file: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      log.error('yt-dlp-cookies not found in realtimeDB');
      throw new Error('yt-dlp-cookies not found in realtimeDB - cookies are required for YouTube downloads');
    }
  }

  return { args, cookiesFilePath };
}

function cleanupCookiesFile(cookiesFilePath: string | undefined, cleaned: { done: boolean }): void {
  if (!cookiesFilePath || cleaned.done) return;
  cleaned.done = true;
  unlink(cookiesFilePath).catch(() => {});
}

const COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,-web_creator';
const POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,mweb,-web_creator';

function getPoTokenProviderBaseUrl(): string | undefined {
  const value = process.env.YTDLP_POT_PROVIDER_BASE_URL?.trim();
  return value ? value.replace(/\/+$/, '') : undefined;
}

function shouldDisableInnertubeForPoTokenProvider(): boolean {
  const value = process.env.YTDLP_POT_DISABLE_INNERTUBE?.trim()?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function ensureProductionPoTokenProviderConfigured(isDevelopment: boolean): void {
  if (isDevelopment) return;
  if (getPoTokenProviderBaseUrl()) return;
  throw new Error(
    'YTDLP_POT_PROVIDER_BASE_URL is required for production YouTube downloads. Deploy a bgutil PO-token provider and set this env var before retrying.'
  );
}

function shouldRetryWithoutCookies(isDevelopment: boolean): boolean {
  return isDevelopment;
}

function applyCookieSafeYouTubeExtractorArgs(
  args: string[],
  hasCookies: boolean,
  log: ReturnType<typeof createLoggerWithContext>
): void {
  if (!hasCookies) return;

  const providerBaseUrl = getPoTokenProviderBaseUrl();
  if (!providerBaseUrl) {
    args.push('--extractor-args', COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS);
    log.debug('Applying yt-dlp extractor args for cookie-authenticated YouTube request without PO token provider', {
      extractorArgs: COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS,
      poTokenProviderConfigured: false,
    });
    return;
  }

  args.push('--extractor-args', POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS);

  const providerArgs = [`base_url=${providerBaseUrl}`];
  if (shouldDisableInnertubeForPoTokenProvider()) {
    providerArgs.push('disable_innertube=1');
  }
  args.push('--extractor-args', `youtubepot-bgutilhttp:${providerArgs.join(';')}`);

  log.info('Applying yt-dlp extractor args for cookie-authenticated YouTube request with PO token provider', {
    youtubeExtractorArgs: POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS,
    poTokenProviderBaseUrl: providerBaseUrl,
    poTokenProviderDisableInnertube: shouldDisableInnertubeForPoTokenProvider(),
  });
}

function selectPreferredAudioFormat(formats: YouTubeFragmentFormat[]): YouTubeFragmentFormat | undefined {
  const candidates = formats.filter((f) => f && f.vcodec === 'none');
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const score = (fmt: YouTubeFragmentFormat): number => {
      let s = 0;
      if (fmt.ext === 'm4a') s += 100;
      if (fmt.format_id === '140') s += 50;
      if (typeof fmt.abr === 'number') s += Math.min(fmt.abr, 320);
      if (Array.isArray(fmt.fragments) && fmt.fragments.length > 0) s += 10;
      return s;
    };
    return score(b) - score(a);
  });

  return candidates[0];
}

export const getYouTubeTrimRoutingDecision = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  ctx?: LogContext
): Promise<YouTubeTrimRoutingDecision> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  const baseArgs = ['-J', '--no-playlist', '-f', 'bestaudio/best', '--no-js-runtimes', '--js-runtimes', 'node'];
  const { args: cookieArgs, cookiesFilePath } = await prepareCookiesArgs(realtimeDB, isDevelopment, log);
  const hasCookies = cookieArgs.length > 0;
  const cleaned = { done: false };

  const buildArgs = (useCookies: boolean): string[] => {
    const args = [...baseArgs];
    if (useCookies) {
      args.push(...cookieArgs);
      applyCookieSafeYouTubeExtractorArgs(args, true, log);
    }
    args.push(url);
    return args;
  };

  const classifyOutput = (stdout: string): YouTubeTrimRoutingDecision => {
    let parsed: YouTubeJsonInfo;
    try {
      parsed = JSON.parse(stdout) as YouTubeJsonInfo;
    } catch (err) {
      throw new Error(`Failed to parse yt-dlp JSON output for routing: ${err instanceof Error ? err.message : String(err)}`);
    }

    const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
    const selected = selectPreferredAudioFormat(formats);
    if (!selected) {
      return {
        strategy: 'direct_url',
        reason: 'no_audio_format_selected',
        hasFragments: false,
        likelyDvr: false,
      };
    }

    const fragmentUrls = (selected.fragments ?? []).map((f) => f?.url).filter((u): u is string => !!u);
    const firstFragmentUrl = fragmentUrls[0] ?? '';
    const hasFragments = fragmentUrls.length > 0;
    const likelyDvr =
      hasFragments &&
      (firstFragmentUrl.includes('playlist_type/DVR') ||
        firstFragmentUrl.includes('/source/yt_live_broadcast') ||
        firstFragmentUrl.includes('/live/1/'));

    if (likelyDvr) {
      return {
        strategy: 'section_download',
        reason: 'dvr_fragmented_audio_detected',
        formatId: selected.format_id,
        protocol: selected.protocol,
        hasFragments: true,
        likelyDvr: true,
        fragmentCount: fragmentUrls.length,
      };
    }

    return {
      strategy: 'direct_url',
      reason: hasFragments ? 'fragmented_non_dvr_audio_detected' : 'non_fragmented_audio_detected',
      formatId: selected.format_id,
      protocol: selected.protocol,
      hasFragments,
      likelyDvr: false,
      fragmentCount: hasFragments ? fragmentUrls.length : undefined,
    };
  };

  const runAttempt = async (useCookies: boolean, attempt: string): Promise<YouTubeTrimRoutingDecision> => {
    const args = buildArgs(useCookies);
    log.info('Running YouTube trim routing preflight', {
      url,
      attempt,
      usedCookies: useCookies,
      command: `${ytdlpPath} ${args.join(' ')}`,
    });
    const { stdout, stderr } = await runCommandWithCapture(ytdlpPath, args, 'yt-dlp routing preflight');
    if (stderr.trim()) {
      log.debug('yt-dlp routing preflight stderr', { attempt, stderr: stderr.trim() });
    }
    return classifyOutput(stdout);
  };

  try {
    try {
      return await runAttempt(hasCookies, hasCookies ? 'with_cookies' : 'without_cookies');
    } catch (cookieError) {
      if (!hasCookies || !shouldRetryWithoutCookies(isDevelopment)) throw cookieError;
      log.warn('Retrying routing preflight without cookies after cookie-enabled attempt failed', {
        firstError: cookieError instanceof Error ? cookieError.message : String(cookieError),
      });
      return await runAttempt(false, 'without_cookies_retry');
    }
  } finally {
    cleanupCookiesFile(cookiesFilePath, cleaned);
  }
};

/**
 * Gets the direct audio stream URL from YouTube using yt-dlp.
 * This URL can be used directly with FFmpeg for precise seeking.
 *
 * This approach is MORE RELIABLE than --download-sections because:
 * 1. We control the FFmpeg command directly (no silent failures)
 * 2. FFmpeg input seeking on HTTP URLs uses range requests (efficient)
 * 3. If seeking fails, FFmpeg will error out (not silently download from time 0)
 *
 * @returns The direct audio stream URL and format info
 */
export const getYouTubeAudioUrl = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  ctx?: LogContext
): Promise<YouTubeAudioUrlResult> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';

  log.info('Extracting YouTube audio stream URL', { url, isDevelopment });

  // Build yt-dlp command to get direct URL
  // -g (--get-url): Print the actual media URL
  // -f bestaudio: Get best audio format
  // --print format: Print format info
  const baseArgs = [
    '-f',
    'bestaudio/best',
    '-g', // Get URL only, don't download
    '--no-playlist',
    '--print',
    '%(duration)s', // Print duration
    '--print',
    '%(ext)s', // Print extension/format
  ];

  // Add cookies
  const { args: cookieArgs, cookiesFilePath } = await prepareCookiesArgs(realtimeDB, isDevelopment, log);
  const usedCookies = cookieArgs.length > 0;

  const cleaned = { done: false };

  const args = [...baseArgs, ...cookieArgs];
  applyCookieSafeYouTubeExtractorArgs(args, usedCookies, log);
  args.push('--no-js-runtimes', '--js-runtimes', 'node');
  args.push(url);

  const runYtDlp = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const ytdlp = spawn(ytdlpPath, args);
      let stdout = '';
      let stderr = '';

      ytdlp.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ytdlp.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ytdlp.on('error', (err) => {
        log.error('yt-dlp spawn error while getting URL', { error: err });
        reject(new Error(`yt-dlp spawn error: ${err}`));
      });

      ytdlp.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });

  const extractFromResult = (
    result: { code: number | null; stdout: string; stderr: string },
    attemptUsesCookies: boolean
  ): YouTubeAudioUrlResult => {
    const lines = result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim());

    // Output format: duration, ext, url (based on --print order)
    if (lines.length >= 3) {
      const duration = parseFloat(lines[0]) || undefined;
      const format = lines[1] || 'unknown';
      const streamUrl = lines[2];

      if (streamUrl && streamUrl.startsWith('http')) {
        log.info('Successfully extracted YouTube audio URL', {
          format,
          duration,
          urlLength: streamUrl.length,
          urlPreview: streamUrl.substring(0, 100) + '...',
          usedCookies: attemptUsesCookies,
        });
        return { url: streamUrl, format, duration };
      }

      log.error('Invalid URL in yt-dlp output', { lines, usedCookies: attemptUsesCookies });
      throw new Error('yt-dlp did not return a valid URL');
    }

    if (lines.length >= 1 && lines[lines.length - 1].startsWith('http')) {
      // Fallback: just a URL
      const streamUrl = lines[lines.length - 1];
      log.info('Extracted YouTube audio URL (minimal info)', {
        urlLength: streamUrl.length,
        usedCookies: attemptUsesCookies,
      });
      return { url: streamUrl, format: 'unknown' };
    }

    log.error('Unexpected yt-dlp output format', {
      stdout: result.stdout,
      stderr: result.stderr,
      lines,
      usedCookies: attemptUsesCookies,
    });
    throw new Error(`Failed to parse yt-dlp output: ${result.stdout}`);
  };

  const runExtractionAttempt = async (
    attemptArgs: string[],
    attemptUsesCookies: boolean,
    attemptLabel: string
  ): Promise<YouTubeAudioUrlResult> => {
    log.debug('Executing yt-dlp to get audio URL', {
      command: `${ytdlpPath} ${attemptArgs.join(' ')}`,
      attempt: attemptLabel,
      usedCookies: attemptUsesCookies,
    });

    const result = await runYtDlp(attemptArgs);
    if (result.code === 0) {
      return extractFromResult(result, attemptUsesCookies);
    }

    log.error('yt-dlp failed to get URL', {
      code: result.code,
      stderr: result.stderr,
      attempt: attemptLabel,
      usedCookies: attemptUsesCookies,
    });
    throw new Error(annotateYtDlpAuthError(`yt-dlp exited with code ${result.code}: ${result.stderr}`));
  };

  try {
    try {
      return await runExtractionAttempt(args, usedCookies, usedCookies ? 'with_cookies' : 'without_cookies');
    } catch (cookieAttemptError) {
      if (!usedCookies || !shouldRetryWithoutCookies(isDevelopment)) {
        throw cookieAttemptError;
      }

      const noCookieArgs = [...baseArgs, '--no-js-runtimes', '--js-runtimes', 'node', url];
      log.warn('Retrying yt-dlp URL extraction without cookies after cookie-enabled attempt failed', {
        firstError: cookieAttemptError instanceof Error ? cookieAttemptError.message : String(cookieAttemptError),
      });

      try {
        return await runExtractionAttempt(noCookieArgs, false, 'without_cookies_retry');
      } catch (noCookieRetryError) {
        const firstError =
          cookieAttemptError instanceof Error ? cookieAttemptError.message : String(cookieAttemptError);
        const retryError =
          noCookieRetryError instanceof Error ? noCookieRetryError.message : String(noCookieRetryError);
        throw new Error(
          `yt-dlp failed with cookies and without cookies. with-cookies error: ${firstError}; no-cookies retry error: ${retryError}`
        );
      }
    }
  } finally {
    cleanupCookiesFile(cookiesFilePath, cleaned);
  }
};

export const processYouTubeUrl = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  cancelToken: CancelToken,
  passThrough: Writable,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  startTime?: number,
  duration?: number,
  ctx?: LogContext
): Promise<ChildProcessWithoutNullStreams> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';

  log.info('Starting YouTube download (full stream)', { url, isDevelopment, startTime, duration });

  if (cancelToken.isCancellationRequested) {
    throw new Error('getYouTubeStream operation was cancelled');
  }
  let totalBytes = 0;
  let previousPercent = -1;

  // Pipes output to stdout - downloads FULL stream, seeking handled by our FFmpeg
  // NOTE: For precise section downloads with seeking, use getYouTubeAudioUrl + FFmpeg input seeking instead
  const args = ['-f', 'bestaudio/best', '-N', '4', '--no-playlist', '-o', '-'];

  // Add cookies
  const { args: cookieArgs, cookiesFilePath } = await prepareCookiesArgs(realtimeDB, isDevelopment, log);
  args.push(...cookieArgs);
  applyCookieSafeYouTubeExtractorArgs(args, cookieArgs.length > 0, log);

  // Add JS runtime
  args.push('--no-js-runtimes', '--js-runtimes', 'node');
  log.debug('Using Node.js as JavaScript runtime for yt-dlp');

  args.push(url);

  const command = `${ytdlpPath} ${args.join(' ')}`;
  log.debug('Executing yt-dlp command', { command });
  const ytdlp = spawn(ytdlpPath, args);
  const cleaned = { done: false };

  ytdlp.on('error', (err) => {
    cleanupCookiesFile(cookiesFilePath, cleaned);
    log.error('yt-dlp spawn error', { error: err });
    passThrough.emit('error', new Error(`getYoutubeStream error ${err}`));
  });

  ytdlp.on('close', (code) => {
    cleanupCookiesFile(cookiesFilePath, cleaned);
    if (code === 0) {
      log.debug('yt-dlp completed successfully', { totalMB: (totalBytes / (1024 * 1024)).toFixed(2) });
    } else {
      log.error('yt-dlp exited with error code', { code });
      passThrough.emit(
        'error',
        new Error('Spawn closed with non-zero error code. Please check logs for more information.')
      );
    }
  });

  ytdlp.stdout.on('end', () => {
    log.debug('yt-dlp stdout ended', { totalMB: (totalBytes / (1024 * 1024)).toFixed(2) });
  });

  ytdlp.stderr?.on('error', (err) => {
    log.error('yt-dlp stderr error', { error: err });
    passThrough.emit('error', new Error(`getYoutubeStream error: ${err}`));
  });

  ytdlp.stderr?.on('data', (data) => {
    if (cancelToken.isCancellationRequested) {
      passThrough.emit('error', new Error('getYouTubeStream operation was cancelled'));
      return;
    }
    const stderrStr = data.toString();

    // Log verbose output when using --download-sections for debugging
    if (startTime !== undefined && startTime !== null) {
      // Only log verbose lines that might be useful (not all of them to avoid spam)
      if (
        stderrStr.includes('ffmpeg') ||
        stderrStr.includes('ERROR') ||
        stderrStr.includes('WARNING') ||
        stderrStr.includes('Downloading')
      ) {
        log.debug('yt-dlp verbose output', { stderr: stderrStr.trim() });
      }
    }

    if (stderrStr.includes('download')) {
      const percent = extractPercent(stderrStr);
      if (percent !== null) {
        // Only update if percent has changed by an integer value (at least 1%)
        const percentInt = Math.floor(percent);
        if (percentInt !== previousPercent) {
          previousPercent = percentInt;
          updateProgressCallback(percent);
        }
      }
    }
    // Check for fatal errors - some errors might be non-fatal warnings
    if (stderrStr.includes('ERROR')) {
      // Some errors might occur after successful download (e.g., cleanup errors)
      // Only treat as fatal if it's a critical error
      const errorLower = stderrStr.toLowerCase();
      const isFatalError =
        errorLower.includes('aborting') ||
        errorLower.includes('failed') ||
        errorLower.includes('cannot') ||
        (errorLower.includes('ffmpeg exited') && !errorLower.includes('code 0'));

      if (isFatalError) {
        log.error('yt-dlp fatal error detected', { stderr: stderrStr.trim() });
        passThrough.emit('error', new Error(stderrStr.trim()));
        return;
      } else {
        // Non-fatal error/warning - log but don't fail
        log.warn('yt-dlp non-fatal error/warning', { stderr: stderrStr.trim() });
      }
    }
  });

  ytdlp.stdout?.on('data', (data) => {
    totalBytes += data.length;
  });

  // Handle EPIPE errors gracefully - they occur when the destination closes the pipe
  // Set up error handlers BEFORE piping to catch all errors
  ytdlp.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      log.debug('yt-dlp stdout EPIPE - destination may have closed pipe', { code: err.code });
      // EPIPE is expected when the destination (ffmpeg) closes stdin - don't treat as fatal
    } else {
      log.error('yt-dlp stdout error', { error: err, code: err.code });
      passThrough.emit('error', err);
    }
  });

  // Handle EPIPE on passThrough as well
  passThrough.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      log.debug('PassThrough EPIPE - ffmpeg may have closed stdin', { code: err.code });
      // Don't emit error for EPIPE - it's expected behavior when seeking
    } else {
      log.error('PassThrough error', { error: err, code: err.code });
    }
  });

  // Use end: false to prevent automatic closing - let the destination control when to end
  ytdlp.stdout.pipe(passThrough, { end: false });

  return ytdlp;
};

async function getYouTubeAudioFragments(
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  isDevelopment: boolean,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<YouTubeAudioFragmentsResult> {
  const baseArgs = ['-J', '--no-playlist', '-f', 'bestaudio/best', '--no-js-runtimes', '--js-runtimes', 'node'];
  const { args: cookieArgs, cookiesFilePath } = await prepareCookiesArgs(realtimeDB, isDevelopment, log);
  const hasCookies = cookieArgs.length > 0;
  const cleaned = { done: false };

  const buildArgs = (useCookies: boolean): string[] => {
    const args = [...baseArgs];
    if (useCookies) {
      args.push(...cookieArgs);
      applyCookieSafeYouTubeExtractorArgs(args, true, log);
    }
    args.push(url);
    return args;
  };

  const parseJson = (stdout: string): YouTubeAudioFragmentsResult => {
    let parsed: YouTubeJsonInfo;
    try {
      parsed = JSON.parse(stdout) as YouTubeJsonInfo;
    } catch (err) {
      throw new Error(`Failed to parse yt-dlp JSON output: ${err instanceof Error ? err.message : String(err)}`);
    }

    const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
    const selected = selectPreferredAudioFormat(formats);
    if (!selected) {
      throw new Error('No audio format was returned by yt-dlp');
    }

    const fragmentUrls = (selected.fragments ?? []).map((f) => f?.url).filter((u): u is string => !!u);
    if (fragmentUrls.length === 0) {
      throw new Error('No audio format with fragment list was returned by yt-dlp');
    }

    const totalDuration =
      (typeof parsed.duration === 'number' && Number.isFinite(parsed.duration) ? parsed.duration : undefined) ??
      (typeof selected.duration === 'number' && Number.isFinite(selected.duration) ? selected.duration : undefined);
    const urlFragmentDuration = parseFragmentDurationFromUrl(fragmentUrls[0]);
    const averageFragmentDuration =
      totalDuration && fragmentUrls.length > 0 ? totalDuration / fragmentUrls.length : undefined;
    const fragmentDurationSeconds = urlFragmentDuration ?? averageFragmentDuration ?? 5;

    return {
      duration: totalDuration,
      formatId: selected.format_id ?? 'unknown',
      ext: selected.ext ?? 'm4a',
      fragmentUrls,
      fragmentDurationSeconds,
    };
  };

  const tryAttempt = async (useCookies: boolean, attemptLabel: string): Promise<YouTubeAudioFragmentsResult> => {
    const args = buildArgs(useCookies);
    log.info('Extracting YouTube fragment metadata for targeted section download', {
      url,
      attempt: attemptLabel,
      usedCookies: useCookies,
      command: `${ytdlpPath} ${args.join(' ')}`,
    });
    const { stdout, stderr } = await runCommandWithCapture(ytdlpPath, args, 'yt-dlp fragment metadata extraction');
    if (stderr.trim()) {
      log.debug('yt-dlp fragment metadata stderr', { attempt: attemptLabel, stderr: stderr.trim() });
    }
    return parseJson(stdout);
  };

  try {
    try {
      return await tryAttempt(hasCookies, hasCookies ? 'with_cookies' : 'without_cookies');
    } catch (cookieError) {
      if (!hasCookies || !shouldRetryWithoutCookies(isDevelopment)) throw cookieError;
      log.warn('Retrying fragment metadata extraction without cookies after cookie-enabled attempt failed', {
        firstError: cookieError instanceof Error ? cookieError.message : String(cookieError),
      });
      return await tryAttempt(false, 'without_cookies_retry');
    }
  } finally {
    cleanupCookiesFile(cookiesFilePath, cleaned);
  }
}

async function downloadYouTubeSectionFromFragments(
  ytdlpPath: string,
  url: YouTubeUrl,
  outputFilePath: string,
  cancelToken: CancelToken,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  startTime: number,
  duration: number | undefined,
  ctx?: LogContext
): Promise<string> {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  const ffmpegPath = getFFmpegPath();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'yt-frag-'));

  try {
    const info = await getYouTubeAudioFragments(ytdlpPath, url, realtimeDB, isDevelopment, log);
    const fragmentCount = info.fragmentUrls.length;
    const fragmentDuration = info.fragmentDurationSeconds;
    const requestedEndForBoundedDownload = duration !== undefined ? startTime + duration : undefined;
    const safetyPaddingFragments = 2;
    const firstIndex = Math.max(0, Math.floor(startTime / fragmentDuration) - safetyPaddingFragments);
    const lastIndex =
      duration !== undefined
        ? Math.min(
            fragmentCount - 1,
            Math.ceil((requestedEndForBoundedDownload as number) / fragmentDuration) + safetyPaddingFragments
          )
        : fragmentCount - 1;

    if (firstIndex > lastIndex) {
      throw new Error(
        `Invalid fragment window for requested range: firstIndex=${firstIndex}, lastIndex=${lastIndex}, startTime=${startTime}, duration=${duration}`
      );
    }

    log.info('Using targeted YouTube fragment window download', {
      url,
      startTime,
      duration,
      fragmentCount,
      fragmentDurationSeconds: fragmentDuration,
      selectedFirstIndex: firstIndex,
      selectedLastIndex: lastIndex,
      selectedFragmentTotal: lastIndex - firstIndex + 1,
      formatId: info.formatId,
      ext: info.ext,
    });

    const fragmentFiles: string[] = [];
    const totalSelected = lastIndex - firstIndex + 1;
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      if (cancelToken.isCancellationRequested) {
        throw new Error('Targeted fragment download cancelled');
      }
      const fragmentUrl = info.fragmentUrls[index];
      const outputName = `frag-${String(index).padStart(6, '0')}.m4a`;
      const outputPath = path.join(workDir, outputName);

      const response = await fetch(fragmentUrl, {
        headers: {
          'User-Agent': YTDLP_HTTP_USER_AGENT,
          Accept: '*/*',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to download fragment sq=${index}. HTTP ${response.status} ${response.statusText}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(outputPath, bytes);
      fragmentFiles.push(outputPath);

      const completed = index - firstIndex + 1;
      updateProgressCallback(Math.min(95, Math.round((completed / totalSelected) * 95)));
    }

    const fragmentWindowStart = firstIndex * fragmentDuration;
    const localStart = Math.max(0, startTime - fragmentWindowStart);
    const finalOutputPath = `${outputFilePath}.m4a`;

    const ffmpegArgs = ['-y'];
    for (const fragmentFile of fragmentFiles) {
      ffmpegArgs.push('-i', fragmentFile);
    }

    // Concatenate downloaded audio fragments in decode domain (stable PTS), then trim precisely.
    const concatFilterInputs = fragmentFiles.map((_, i) => `[${i}:a]`).join('');
    const concatFilter = `${concatFilterInputs}concat=n=${fragmentFiles.length}:v=0:a=1[a]`;
    ffmpegArgs.push('-filter_complex', concatFilter, '-map', '[a]', '-ss', localStart.toFixed(3));
    if (duration !== undefined) {
      ffmpegArgs.push('-t', duration.toFixed(3));
    }
    ffmpegArgs.push('-vn', '-c:a', 'aac', '-b:a', '128k', finalOutputPath);
    await runCommandWithCapture(ffmpegPath, ffmpegArgs, 'ffmpeg fragment concat trim');

    let finalDuration = 0;
    try {
      const probe = await runCommandWithCapture(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', finalOutputPath],
        'ffprobe final fragment section'
      );
      const parsed = Number.parseFloat(probe.stdout.trim());
      finalDuration = Number.isFinite(parsed) ? parsed : 0;
    } catch (probeError) {
      throw new Error(
        `Failed to verify targeted fragment output duration: ${
          probeError instanceof Error ? probeError.message : String(probeError)
        }`
      );
    }

    if (finalDuration < 1) {
      throw new Error(`Targeted fragment output duration is too small (${finalDuration.toFixed(3)}s)`);
    }
    if (duration !== undefined && Math.abs(finalDuration - duration) > 3) {
      throw new Error(
        `Targeted fragment output duration mismatch. expected~${duration.toFixed(3)}s actual=${finalDuration.toFixed(3)}s`
      );
    }

    updateProgressCallback(100);
    log.info('Targeted fragment section download completed', {
      finalOutputPath,
      fragmentWindowStart,
      localStart,
      duration,
      finalDuration,
      selectedFragmentTotal: totalSelected,
    });
    return finalOutputPath;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Downloads only the needed section from YouTube.
 * Strategy order:
 * 1) Targeted fragment-window download + precise local trim (preferred for live DVR manifests)
 * 2) Fallback to yt-dlp --download-sections --force-keyframes-at-cuts
 *
 * @returns Path to the downloaded section file (original format, not MP3)
 */
export const downloadYouTubeSection = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  outputFilePath: string,
  cancelToken: CancelToken,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  startTime: number,
  duration: number | undefined,
  ctx?: LogContext
): Promise<string> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Preferred strategy for post-live DVR manifests: download only the required fragment window,
  // then do a precise local trim. This avoids ffmpeg seeking the full DASH master manifest.
  try {
    return await downloadYouTubeSectionFromFragments(
      ytdlpPath,
      url,
      outputFilePath,
      cancelToken,
      updateProgressCallback,
      realtimeDB,
      startTime,
      duration,
      ctx
    );
  } catch (fragmentError) {
    log.warn('Targeted fragment strategy failed; falling back to yt-dlp --download-sections', {
      error: fragmentError instanceof Error ? fragmentError.message : String(fragmentError),
      fallback: 'yt-dlp --download-sections --force-keyframes-at-cuts',
    });
  }

  log.info('Downloading YouTube section with precise cuts', {
    url,
    outputFilePath,
    startTime,
    duration,
    isDevelopment,
    note: 'Using --force-keyframes-at-cuts for EXACT timing - yt-dlp re-encodes at cut points',
  });

  if (cancelToken.isCancellationRequested) {
    throw new Error('Download operation was cancelled');
  }

  const startTimeStr = formatTimeForDownloadSections(startTime);
  const endTimeStr = duration !== undefined ? formatTimeForDownloadSections(startTime + duration) : 'inf';
  const sectionRange = `*${startTimeStr}-${endTimeStr}`;

  // Build yt-dlp command to download PRECISELY the requested section:
  // 1. --download-sections: Download only the specified time range
  // 2. --force-keyframes-at-cuts: CRITICAL - Re-encode at cut points for EXACT timing
  //    Without this, yt-dlp uses stream copy (-c copy) which cuts at keyframe boundaries,
  //    resulting in imprecise cuts (extra content before/after requested range).
  //    With this, yt-dlp re-encodes at the cut points, giving us frame-accurate cuts.
  // 3. -o: Output to file - yt-dlp adds extension based on format
  // This approach:
  // - Downloads only the section we need (efficient bandwidth)
  // - Gets EXACT cuts at requested start/end times (no extra content)
  // - yt-dlp handles re-encoding for precise cuts; our ffmpeg applies filters
  const baseArgs = [
    '-f',
    'bestaudio/best', // Get best audio format
    '-N',
    '4',
    '--no-playlist',
    '--download-sections',
    sectionRange,
    '--force-keyframes-at-cuts', // CRITICAL: Re-encode for precise cuts (not stream copy)
    '-o',
    `${outputFilePath}.%(ext)s`, // Let yt-dlp add extension based on format (webm, m4a, etc.)
  ];

  // yt-dlp needs ffmpeg for --download-sections and --force-keyframes-at-cuts
  const ffmpegPath = getFFmpegPath();
  const ffmpegDir = path.dirname(ffmpegPath);
  baseArgs.push('--ffmpeg-location', ffmpegDir);
  baseArgs.push('--verbose'); // Add verbose logging to see ffmpeg commands and detailed errors

  // yt-dlp now expects an external JS runtime for full YouTube support.
  // We use Node.js since it's already installed in our container.
  // Clear default (deno) first, then enable node.
  baseArgs.push('--no-js-runtimes', '--js-runtimes', 'node');
  log.debug('Using Node.js as JavaScript runtime for yt-dlp');

  // Add cookies for primary attempt (when available)
  const { args: cookieArgs, cookiesFilePath } = await prepareCookiesArgs(realtimeDB, isDevelopment, log);
  const hasCookies = cookieArgs.length > 0;

  const buildAttemptArgs = (useCookies: boolean): string[] => {
    const args = [...baseArgs];
    if (useCookies) {
      args.push(...cookieArgs);
      applyCookieSafeYouTubeExtractorArgs(args, true, log);
    }
    args.push(url);
    return args;
  };

  const runSectionDownloadAttempt = async (
    attemptArgs: string[],
    attemptUsesCookies: boolean,
    attemptLabel: string
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let previousPercent = -1;
      let stderrBuffer = '';
      let settled = false;

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const resolveOnce = (filePath: string): void => {
        if (settled) return;
        settled = true;
        resolve(filePath);
      };

      const command = `${ytdlpPath} ${attemptArgs.join(' ')}`;
      log.info('Executing yt-dlp section download with precise cuts', {
        command,
        sectionRange,
        outputFilePath,
        attempt: attemptLabel,
        usedCookies: attemptUsesCookies,
        note: 'Using --force-keyframes-at-cuts for frame-accurate cuts at exact start/end times',
      });

      const ytdlp = spawn(ytdlpPath, attemptArgs);

      ytdlp.on('error', (err) => {
        log.error('yt-dlp spawn error', { error: err, attempt: attemptLabel, usedCookies: attemptUsesCookies });
        rejectOnce(new Error(`yt-dlp spawn error: ${err}`));
      });

      ytdlp.on('close', (code, signal) => {
        if (settled) return;
        const dir = path.dirname(outputFilePath);
        const baseName = path.basename(outputFilePath);
        let files: string[] = [];
        try {
          files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        } catch {
          // Ignore readdir errors
        }

        if (code === 0) {
          // yt-dlp adds extension based on format, so find the actual file
          // The output template was `${outputFilePath}.%(ext)s`, so yt-dlp will create a file
          // with the base name plus the actual extension (e.g., .webm, .m4a)
          const actualFile = files.find((f) => {
            const fileBase = path.basename(f, path.extname(f));
            return fileBase === baseName || f.startsWith(baseName);
          });

          if (actualFile) {
            const actualPath = path.join(dir, actualFile);
            log.info('yt-dlp section download completed with precise cuts', {
              outputFilePath: actualPath,
              format: path.extname(actualFile),
              requestedStart: startTime,
              requestedDuration: duration,
              attempt: attemptLabel,
              usedCookies: attemptUsesCookies,
              note: 'File contains EXACT time range - no additional seeking needed',
            });
            resolveOnce(actualPath);
          } else {
            // Fallback: check if file exists without extension
            if (fs.existsSync(outputFilePath)) {
              log.info('yt-dlp section download completed successfully', {
                outputFilePath,
                attempt: attemptLabel,
                usedCookies: attemptUsesCookies,
              });
              resolveOnce(outputFilePath);
            } else {
              rejectOnce(new Error(`Output file was not created. Expected file starting with: ${baseName}`));
            }
          }
        } else {
          log.error('yt-dlp exited with error code', {
            code,
            signal,
            attempt: attemptLabel,
            usedCookies: attemptUsesCookies,
            stderr: stderrBuffer,
          });
          rejectOnce(
            new Error(
              annotateYtDlpAuthError(
                `yt-dlp exited with code ${code}${signal ? ` (signal: ${signal})` : ''} on ${attemptLabel}. stderr: ${stderrBuffer}`
              )
            )
          );
        }
      });

      ytdlp.stderr?.on('data', (data) => {
        if (cancelToken.isCancellationRequested) {
          ytdlp.kill('SIGTERM');
          rejectOnce(new Error('Download operation was cancelled'));
          return;
        }

        const stderrStr = data.toString();
        if (stderrBuffer.length < 50_000) {
          stderrBuffer += stderrStr;
        }

        // If ffmpeg inside yt-dlp fails DNS resolution, probe DNS from Node to isolate root cause
        if (stderrStr.includes('Failed to resolve hostname')) {
          const hostMatch = stderrStr.match(/Failed to resolve hostname\s+([^\s:]+)\s*:/);
          const failedHost = hostMatch?.[1];
          if (failedHost) {
            dns
              .lookup(failedHost)
              .then((result) => {
                log.info('Node DNS resolved hostname that ffmpeg could not', {
                  hostname: failedHost,
                  address: result.address,
                  family: result.family,
                  attempt: attemptLabel,
                  usedCookies: attemptUsesCookies,
                });
              })
              .catch((err) => {
                log.error('Node DNS also failed for hostname', {
                  hostname: failedHost,
                  error: err instanceof Error ? err.message : String(err),
                  attempt: attemptLabel,
                  usedCookies: attemptUsesCookies,
                });
              });
          }
        }

        // Log ffmpeg command line when yt-dlp shows it (for --download-sections)
        if (stderrStr.includes('ffmpeg command line:')) {
          const ffmpegCmdMatch = stderrStr.match(/ffmpeg command line: (.+)/);
          if (ffmpegCmdMatch) {
            const ffmpegCmd = ffmpegCmdMatch[1];
            log.info('yt-dlp ffmpeg command detected', {
              command: ffmpegCmd,
              attempt: attemptLabel,
              usedCookies: attemptUsesCookies,
            });
          }
        }

        // Parse progress - handle both yt-dlp percentage format AND ffmpeg time format
        // For --download-sections, ffmpeg reports time=HH:MM:SS.ms instead of percentage
        let percent: number | null = null;

        // Try ffmpeg time format first (used with --download-sections)
        const ffmpegTime = extractFfmpegTime(stderrStr);
        if (ffmpegTime !== null && ffmpegTime >= 0 && duration) {
          // Calculate percentage based on time and requested duration
          percent = Math.min(100, (ffmpegTime / duration) * 100);
        } else if (stderrStr.includes('download')) {
          // Fallback to yt-dlp percentage format (used for regular downloads)
          percent = extractPercent(stderrStr);
        }

        if (percent !== null) {
          const percentInt = Math.floor(percent);
          if (percentInt !== previousPercent) {
            previousPercent = percentInt;
            updateProgressCallback(percent);
          }
        }

        // Check for errors - capture detailed error info
        if (stderrStr.includes('ERROR')) {
          const errorLower = stderrStr.toLowerCase();
          const isFatalError =
            errorLower.includes('aborting') ||
            errorLower.includes('failed') ||
            errorLower.includes('cannot') ||
            (errorLower.includes('ffmpeg exited') && !errorLower.includes('code 0'));

          if (isFatalError) {
            log.error('yt-dlp fatal error detected', {
              stderr: stderrStr.trim(),
              attempt: attemptLabel,
              usedCookies: attemptUsesCookies,
            });
            rejectOnce(new Error(annotateYtDlpAuthError(`yt-dlp error (${attemptLabel}): ${stderrStr.trim()}`)));
          }
        }
      });
    });

  const cleaned = { done: false };
  try {
    const cookieAttemptLabel = hasCookies ? 'with_cookies' : 'without_cookies';
    try {
      return await runSectionDownloadAttempt(buildAttemptArgs(hasCookies), hasCookies, cookieAttemptLabel);
    } catch (cookieAttemptError) {
      if (!hasCookies || !shouldRetryWithoutCookies(isDevelopment)) {
        throw cookieAttemptError;
      }

      log.warn('Retrying yt-dlp section download without cookies after cookie-enabled attempt failed', {
        firstError: cookieAttemptError instanceof Error ? cookieAttemptError.message : String(cookieAttemptError),
      });

      try {
        return await runSectionDownloadAttempt(buildAttemptArgs(false), false, 'without_cookies_retry');
      } catch (noCookieRetryError) {
        const firstError =
          cookieAttemptError instanceof Error ? cookieAttemptError.message : String(cookieAttemptError);
        const retryError = noCookieRetryError instanceof Error ? noCookieRetryError.message : String(noCookieRetryError);
        throw new Error(
          `yt-dlp section download failed with cookies and without cookies. with-cookies error: ${firstError}; no-cookies retry error: ${retryError}`
        );
      }
    }
  } finally {
    cleanupCookiesFile(cookiesFilePath, cleaned);
  }
};
