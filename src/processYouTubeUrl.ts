import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import {
  annotateYouTubeFailure,
  classifyYouTubeFailure,
  shouldEscalateToBrowserFallback,
  shouldEscalateToCookieProvider,
  YouTubeExtractionMode,
  YouTubeFailureClass,
} from './youtubeExtractionPolicy';

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

interface YouTubeCookieMetadata {
  rotatedAt?: string;
  exportedAt?: string;
  exportMethod?: string;
  profileType?: string;
  cookieHash?: string;
  sourceAccount?: string;
  lastHealthStatus?: 'healthy' | 'stale_or_challenged' | 'unknown';
  lastHealthCheckAt?: string;
  lastFailureClass?: YouTubeFailureClass;
  lastFailureAt?: string;
  lastFailureMessage?: string;
  lastSuccessAt?: string;
  lastSuccessfulMode?: YouTubeExtractionMode;
  lastUsedAt?: string;
  lastValidatedAt?: string;
  lastValidatedVideoId?: string;
  consecutiveFailures?: number;
  disabledUntil?: string;
}

interface YouTubeCookieContext {
  args: string[];
  cookiesFilePath?: string;
  hasCookies: boolean;
  metadata?: YouTubeCookieMetadata;
  loadedFromRealtimeDb: boolean;
  cookieBreakerOpen?: boolean;
  disabledUntil?: string;
}

interface BrowserFallbackResolveResponse {
  url: string;
  format?: string;
  duration?: number;
}

interface BrowserFallbackSectionResponse {
  downloadUrl: string;
  ext?: string;
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

type YouTubeAccessDecisionState =
  | 'public_ok'
  | 'public_bot_blocked'
  | 'cookie_ok'
  | 'cookie_stale'
  | 'browser_required';

interface YouTubeAccessDecision {
  state: YouTubeAccessDecisionState;
  mode: YouTubeExtractionMode;
  reason: string;
  publicFailureClass?: YouTubeFailureClass;
  publicFailureMessage?: string;
  cookieFailureClass?: YouTubeFailureClass;
  cookieFailureMessage?: string;
  cookieBreakerOpen?: boolean;
  disabledUntil?: string;
  cookieMetadata?: YouTubeCookieMetadata;
  decidedAt: string;
}

const YTDLP_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const YOUTUBE_ACCESS_DECISION_CACHE_TTL_MS = 10 * 60 * 1000;
const youtubeAccessDecisionCache = new Map<string, { expiresAt: number; decision: YouTubeAccessDecision }>();

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

function getNowIsoString(): string {
  return new Date().toISOString();
}

function getYouTubeVideoId(url: string): string | undefined {
  const match = url.match(/[?&]v=([^&]+)/) ?? url.match(/youtu\.be\/([^?&]+)/);
  return match?.[1];
}

function getYtDlpConcurrentFragments(): string {
  return process.env.YTDLP_CONCURRENT_FRAGMENTS?.trim() || '1';
}

function getPreferredYtDlpJsRuntime(): string {
  return process.env.YTDLP_JS_RUNTIME?.trim() || 'deno';
}

function getYouTubePublicProviderMaxAttempts(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_PUBLIC_PROVIDER_MAX_ATTEMPTS || '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getYouTubeCookieProviderMaxAttempts(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_COOKIE_PROVIDER_MAX_ATTEMPTS || '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getYouTubeCookieCircuitBreakerMinutes(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_COOKIE_CIRCUIT_BREAKER_MINUTES || '30', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

function getYtDlpSleepRequestsSeconds(): string | undefined {
  const value = process.env.YTDLP_SLEEP_REQUESTS_SECONDS?.trim();
  return value || undefined;
}

function getYtDlpSleepIntervalSeconds(): string | undefined {
  const value = process.env.YTDLP_SLEEP_INTERVAL_SECONDS?.trim();
  return value || undefined;
}

function getYtDlpMaxSleepIntervalSeconds(): string | undefined {
  const value = process.env.YTDLP_MAX_SLEEP_INTERVAL_SECONDS?.trim();
  return value || undefined;
}

function shouldUseCookiesForPublicVideos(): boolean {
  const value = process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS?.trim()?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isBrowserFallbackEnabled(): boolean {
  const endpoint = process.env.YOUTUBE_BROWSER_FALLBACK_URL?.trim();
  const explicit = process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED?.trim()?.toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no') return false;
  return !!endpoint;
}

function getBrowserFallbackUrl(): string | undefined {
  const endpoint = process.env.YOUTUBE_BROWSER_FALLBACK_URL?.trim();
  return endpoint ? endpoint.replace(/\/+$/, '') : undefined;
}

function getBrowserFallbackTimeoutMs(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_BROWSER_FALLBACK_TIMEOUT_MS || '45000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 45000;
}

function getRetryDelayMs(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_RETRY_DELAY_MS || '1500', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

function shouldEnableCookieHealthcheck(): boolean {
  const value = process.env.YTDLP_COOKIE_HEALTHCHECK_ENABLED?.trim()?.toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no';
}

function applyYtDlpRequestPacingArgs(args: string[]): void {
  const sleepRequests = getYtDlpSleepRequestsSeconds();
  const sleepInterval = getYtDlpSleepIntervalSeconds();
  const maxSleepInterval = getYtDlpMaxSleepIntervalSeconds();

  if (sleepRequests) {
    args.push('--sleep-requests', sleepRequests);
  }
  if (sleepInterval) {
    args.push('--sleep-interval', sleepInterval);
  }
  if (sleepInterval && maxSleepInterval) {
    args.push('--max-sleep-interval', maxSleepInterval);
  }
}

function buildDecisionCacheKey(ctx: LogContext | undefined, url: string): string | undefined {
  if (!ctx?.requestId) return undefined;
  return `${ctx.requestId}:${url}`;
}

function setCachedAccessDecision(ctx: LogContext | undefined, url: string, decision: YouTubeAccessDecision): void {
  const key = buildDecisionCacheKey(ctx, url);
  if (!key) return;
  youtubeAccessDecisionCache.set(key, {
    expiresAt: Date.now() + YOUTUBE_ACCESS_DECISION_CACHE_TTL_MS,
    decision,
  });
}

function getCachedAccessDecision(ctx: LogContext | undefined, url: string): YouTubeAccessDecision | undefined {
  const key = buildDecisionCacheKey(ctx, url);
  if (!key) return undefined;
  const cached = youtubeAccessDecisionCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    youtubeAccessDecisionCache.delete(key);
    return undefined;
  }
  return cached.decision;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAttemptWithRetries<T>(
  maxAttempts: number,
  run: (attemptNumber: number) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      return await run(attemptNumber);
    } catch (error) {
      lastError = error;
      if (attemptNumber < maxAttempts) {
        await sleep(getRetryDelayMs());
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildAnnotatedYouTubeError(message: string, mode: YouTubeExtractionMode): Error {
  const failureClass = classifyYouTubeFailure(message, mode);
  return new Error(annotateYouTubeFailure(message, failureClass, mode));
}

async function runCommandWithCapture(
  command: string,
  args: string[],
  errorPrefix: string,
  mode: YouTubeExtractionMode = 'public_provider'
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
      reject(
        buildAnnotatedYouTubeError(
          `${errorPrefix} exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr: ${stderr.trim()}`,
          mode
        )
      );
    });
  });
}

function cleanupCookiesFile(cookiesFilePath: string | undefined, cleaned: { done: boolean }): void {
  if (!cookiesFilePath || cleaned.done) return;
  cleaned.done = true;
  unlink(cookiesFilePath).catch(() => {});
}

const COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,-web_creator';
const POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,mweb,-web_creator';
const COOKIE_KEY = 'yt-dlp-cookies';
const COOKIE_META_KEY = 'yt-dlp-cookies-meta';

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

async function loadYouTubeCookieContext(
  realtimeDB: Database,
  isDevelopment: boolean,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<YouTubeCookieContext> {
  if (isDevelopment) {
    if (isRunningInDocker()) {
      log.warn('Skipping --cookies-from-browser in Docker (cookies cannot be decrypted without host keychain)');
      return { args: [], hasCookies: false, loadedFromRealtimeDb: false };
    }

    log.info('Using cookies from Chrome browser (development mode)');
    return {
      args: ['--cookies-from-browser', 'chrome'],
      hasCookies: true,
      loadedFromRealtimeDb: false,
    };
  }

  const cookiesPath = realtimeDB.ref(COOKIE_KEY);
  const cookieMetaPath = realtimeDB.ref(COOKIE_META_KEY);
  const [encodedCookies, metaSnapshot] = await Promise.all([cookiesPath.get(), cookieMetaPath.get()]);
  const metadata = metaSnapshot.exists() ? (metaSnapshot.val() as YouTubeCookieMetadata) : undefined;
  const disabledUntil = metadata?.disabledUntil;
  const cookieBreakerOpen = !!disabledUntil && Date.parse(disabledUntil) > Date.now();

  if (!encodedCookies.exists()) {
    log.warn('yt-dlp-cookies not found in realtimeDB', { metadata });
    return {
      args: [],
      hasCookies: false,
      metadata,
      loadedFromRealtimeDb: true,
      cookieBreakerOpen,
      disabledUntil,
    };
  }

  if (cookieBreakerOpen) {
    log.warn('Skipping cookie load because cookie circuit breaker is open', {
      disabledUntil,
      metadata,
    });
    return {
      args: [],
      hasCookies: false,
      metadata,
      loadedFromRealtimeDb: true,
      cookieBreakerOpen: true,
      disabledUntil,
    };
  }

  const cookiesFilePath = path.join(os.tmpdir(), `yt-dlp-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  try {
    const encodedValue = String(encodedCookies.val() || '');
    const decodedCookies = Buffer.from(encodedValue, 'base64').toString('utf8');
    const cookieHash = createHash('sha256').update(encodedValue).digest('hex').slice(0, 16);
    fs.writeFileSync(cookiesFilePath, decodedCookies, 'utf8');
    log.debug('Cookies file created from database', {
      path: cookiesFilePath,
      metadata,
      cookieHash,
    });

    await cookieMetaPath.update({
      lastUsedAt: getNowIsoString(),
      cookieHash,
    });

    return {
      args: ['--cookies', cookiesFilePath],
      cookiesFilePath,
      hasCookies: true,
      metadata,
      loadedFromRealtimeDb: true,
      cookieBreakerOpen: false,
    };
  } catch (err) {
    log.error('Failed to decode and write cookies file', { error: err });
    throw new Error(`Failed to decode and write cookies file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function updateCookieMetadata(
  realtimeDB: Database,
  patch: Record<string, unknown>,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<void> {
  try {
    await realtimeDB.ref(COOKIE_META_KEY).update(patch);
  } catch (err) {
    log.warn('Failed to update YouTube cookie metadata', {
      error: err instanceof Error ? err.message : String(err),
      patch,
    });
  }
}

async function recordCookieAttemptOutcome(
  realtimeDB: Database,
  mode: YouTubeExtractionMode,
  success: boolean,
  failureClass: YouTubeFailureClass | undefined,
  failureMessage: string | undefined,
  existingMetadata: YouTubeCookieMetadata | undefined,
  videoId: string | undefined,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<void> {
  const now = getNowIsoString();
  const patch: Record<string, unknown> = {
    lastHealthCheckAt: now,
  };

  if (success) {
    patch.lastHealthStatus = 'healthy';
    patch.lastSuccessAt = now;
    patch.lastSuccessfulMode = mode;
    patch.lastValidatedAt = now;
    patch.lastValidatedVideoId = videoId ?? null;
    patch.consecutiveFailures = 0;
    patch.disabledUntil = null;
  } else {
    patch.lastHealthStatus = failureClass === 'cookie_session_stale_or_challenged' ? 'stale_or_challenged' : 'unknown';
    patch.lastFailureAt = now;
    patch.lastFailureClass = failureClass ?? null;
    patch.lastFailureMessage = failureMessage?.slice(0, 1000);
    const nextConsecutiveFailures = (existingMetadata?.consecutiveFailures ?? 0) + 1;
    patch.consecutiveFailures = nextConsecutiveFailures;
    if (failureClass === 'cookie_session_stale_or_challenged') {
      const disabledUntil = new Date(Date.now() + getYouTubeCookieCircuitBreakerMinutes() * 60_000).toISOString();
      patch.disabledUntil = disabledUntil;
    }
  }

  await updateCookieMetadata(realtimeDB, patch, log);
}

function applyYouTubeExtractorArgs(
  args: string[],
  mode: YouTubeExtractionMode,
  log: ReturnType<typeof createLoggerWithContext>
): void {
  const providerBaseUrl = getPoTokenProviderBaseUrl();
  if (!providerBaseUrl) {
    if (mode === 'cookie_provider') {
      args.push('--extractor-args', COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS);
    }

    log.debug('Applying yt-dlp extractor args without PO token provider', {
      mode,
      extractorArgs: mode === 'cookie_provider' ? COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS : undefined,
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

  log.info('Applying yt-dlp extractor args with PO token provider', {
    mode,
    youtubeExtractorArgs: POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS,
    poTokenProviderBaseUrl: providerBaseUrl,
    poTokenProviderDisableInnertube: shouldDisableInnertubeForPoTokenProvider(),
  });
}

async function runCookieHealthcheck(
  ytdlpPath: string,
  url: YouTubeUrl,
  cookieContext: YouTubeCookieContext,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<void> {
  if (!cookieContext.hasCookies || !shouldEnableCookieHealthcheck()) return;

  const args = ['-J', '--no-playlist', '--skip-download', '--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime()];
  applyYtDlpRequestPacingArgs(args);
  args.push(...cookieContext.args);
  applyYouTubeExtractorArgs(args, 'cookie_provider', log);
  args.push(url);

  log.info('Running YouTube cookie healthcheck', {
    url,
    command: `${ytdlpPath} ${args.join(' ')}`,
  });

  await runCommandWithCapture(ytdlpPath, args, 'yt-dlp cookie healthcheck', 'cookie_provider');
}

async function callBrowserFallback<T>(
  payload: Record<string, unknown>,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<T> {
  const fallbackUrl = getBrowserFallbackUrl();
  if (!fallbackUrl) {
    throw new Error('YOUTUBE_BROWSER_FALLBACK_URL is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getBrowserFallbackTimeoutMs());

  try {
    const response = await fetch(fallbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Browser fallback HTTP ${response.status}: ${body}`);
    }

    return (await response.json()) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Browser fallback request failed', { error: message, fallbackUrl, payload });
    throw buildAnnotatedYouTubeError(`Browser fallback failed: ${message}`, 'browser_fallback');
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadBrowserFallbackSection(
  outputFilePath: string,
  fallbackResult: BrowserFallbackSectionResponse
): Promise<string> {
  const ext = fallbackResult.ext || 'm4a';
  const finalPath = `${outputFilePath}.${ext.replace(/^\./, '')}`;
  const response = await fetch(fallbackResult.downloadUrl, {
    headers: {
      'User-Agent': YTDLP_HTTP_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Browser fallback section download failed. HTTP ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(finalPath, bytes);
  return finalPath;
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
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const cachedDecision = getCachedAccessDecision(ctx, url);
  if (cachedDecision?.mode === 'browser_fallback') {
    log.info('Using cached YouTube access decision for trim routing', cachedDecision);
    return {
      strategy: 'direct_url',
      reason: 'browser_fallback_required_from_cached_access_decision',
      hasFragments: false,
      likelyDvr: false,
    };
  }
  const baseArgs = ['-J', '--no-playlist', '-f', 'bestaudio/best', '--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime()];
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };

  const buildArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    applyYtDlpRequestPacingArgs(args);
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
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

  const runAttempt = async (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): Promise<YouTubeTrimRoutingDecision> => {
    const args = buildArgs(mode, extraCookieArgs);
    log.info('Running YouTube trim routing preflight', {
      url,
      attempt: mode,
      usedCookies: mode === 'cookie_provider',
      command: `${ytdlpPath} ${args.join(' ')}`,
    });
    const { stdout, stderr } = await runCommandWithCapture(ytdlpPath, args, 'yt-dlp routing preflight', mode);
    if (stderr.trim()) {
      log.debug('yt-dlp routing preflight stderr', { attempt: mode, stderr: stderr.trim() });
    }
    return classifyOutput(stdout);
  };

  try {
    try {
      const result = await runAttemptWithRetries(getYouTubePublicProviderMaxAttempts(), () => runAttempt('public_provider'));
      setCachedAccessDecision(ctx, url, {
        state: 'public_ok',
        mode: 'public_provider',
        reason: 'routing_preflight_public_success',
        decidedAt: getNowIsoString(),
      });
      return result;
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');
      log.warn('Public YouTube routing preflight failed', {
        url,
        failureClass: publicFailureClass,
        error: publicMessage,
      });

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log);
          const result = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runAttempt('cookie_provider', activeCookieContext.args)
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'routing_preflight_cookie_success',
            publicFailureClass,
            publicFailureMessage: publicMessage,
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return result;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          if (shouldEscalateToBrowserFallback(cookieFailureClass, isBrowserFallbackEnabled()) || cookieContext.cookieBreakerOpen) {
            setCachedAccessDecision(ctx, url, {
              state: cookieFailureClass === 'cookie_session_stale_or_challenged' ? 'cookie_stale' : 'browser_required',
              mode: 'browser_fallback',
              reason: 'routing_preflight_browser_fallback_required',
              publicFailureClass,
              publicFailureMessage: publicMessage,
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              cookieMetadata: activeCookieContext.metadata,
              decidedAt: getNowIsoString(),
            });
          }
          throw buildAnnotatedYouTubeError(
            `yt-dlp routing preflight failed after public and cookie attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      if (cookieContext.cookieBreakerOpen && isBrowserFallbackEnabled()) {
        setCachedAccessDecision(ctx, url, {
          state: 'cookie_stale',
          mode: 'browser_fallback',
          reason: 'cookie_circuit_breaker_open',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          cookieBreakerOpen: true,
          disabledUntil: cookieContext.disabledUntil,
          cookieMetadata: cookieContext.metadata,
          decidedAt: getNowIsoString(),
        });
        return {
          strategy: 'direct_url',
          reason: 'browser_fallback_required_cookie_breaker_open',
          hasFragments: false,
          likelyDvr: false,
        };
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
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
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const cachedDecision = getCachedAccessDecision(ctx, url);

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
    '--no-js-runtimes',
    '--js-runtimes',
    getPreferredYtDlpJsRuntime(),
  ];
  applyYtDlpRequestPacingArgs(baseArgs);
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };

  const buildArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

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
    mode: YouTubeExtractionMode,
    attemptArgs: string[]
  ): Promise<YouTubeAudioUrlResult> => {
    log.debug('Executing yt-dlp to get audio URL', {
      command: `${ytdlpPath} ${attemptArgs.join(' ')}`,
      attempt: mode,
      usedCookies: mode === 'cookie_provider',
    });

    const result = await runYtDlp(attemptArgs);
    if (result.code === 0) {
      return extractFromResult(result, mode === 'cookie_provider');
    }

    log.error('yt-dlp failed to get URL', {
      code: result.code,
      stderr: result.stderr,
      attempt: mode,
      usedCookies: mode === 'cookie_provider',
    });
    throw buildAnnotatedYouTubeError(`yt-dlp exited with code ${result.code}: ${result.stderr}`, mode);
  };

  try {
    if (cachedDecision?.mode === 'browser_fallback') {
      log.info('Using cached browser fallback decision for direct URL extraction', cachedDecision);
      const fallback = await callBrowserFallback<BrowserFallbackResolveResponse>(
        {
          action: 'resolve_audio_url',
          youtubeUrl: url,
          requestContext: ctx,
        },
        log
      );

      return {
        url: fallback.url,
        format: fallback.format || 'unknown',
        duration: fallback.duration,
      };
    }

    if (cachedDecision?.mode === 'cookie_provider') {
      log.info('Using cached cookie-backed decision for direct URL extraction', cachedDecision);
      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (cookieContext.cookieBreakerOpen) {
        if (isBrowserFallbackEnabled()) {
          const fallback = await callBrowserFallback<BrowserFallbackResolveResponse>(
            {
              action: 'resolve_audio_url',
              youtubeUrl: url,
              requestContext: ctx,
            },
            log
          );

          return {
            url: fallback.url,
            format: fallback.format || 'unknown',
            duration: fallback.duration,
          };
        }
        throw buildAnnotatedYouTubeError(
          'Cached cookie-backed YouTube session is disabled by the cookie circuit breaker.',
          'cookie_provider'
        );
      }

      const cookieResult = await runExtractionAttempt('cookie_provider', buildArgs('cookie_provider', cookieContext.args));
      await recordCookieAttemptOutcome(
        realtimeDB,
        'cookie_provider',
        true,
        undefined,
        undefined,
        cookieContext.metadata,
        getYouTubeVideoId(url),
        log
      );
      return cookieResult;
    }

    try {
      const publicResult = await runAttemptWithRetries(getYouTubePublicProviderMaxAttempts(), () =>
        runExtractionAttempt('public_provider', buildArgs('public_provider'))
      );
      setCachedAccessDecision(ctx, url, {
        state: 'public_ok',
        mode: 'public_provider',
        reason: 'direct_url_public_success',
        decidedAt: getNowIsoString(),
      });
      return publicResult;
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');
      log.warn('Public YouTube direct URL extraction failed', {
        url,
        failureClass: publicFailureClass,
        error: publicMessage,
      });

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log);
          const cookieResult = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runExtractionAttempt('cookie_provider', buildArgs('cookie_provider', activeCookieContext.args))
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'direct_url_cookie_success',
            publicFailureClass,
            publicFailureMessage: publicMessage,
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return cookieResult;
        } catch (cookieAttemptError) {
          const cookieMessage = cookieAttemptError instanceof Error ? cookieAttemptError.message : String(cookieAttemptError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );

          if (shouldEscalateToBrowserFallback(cookieFailureClass, isBrowserFallbackEnabled())) {
            setCachedAccessDecision(ctx, url, {
              state: cookieFailureClass === 'cookie_session_stale_or_challenged' ? 'cookie_stale' : 'browser_required',
              mode: 'browser_fallback',
              reason: 'direct_url_browser_fallback_after_cookie_failure',
              publicFailureClass,
              publicFailureMessage: publicMessage,
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieMetadata: activeCookieContext.metadata,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              decidedAt: getNowIsoString(),
            });
            const fallback = await callBrowserFallback<BrowserFallbackResolveResponse>(
              {
                action: 'resolve_audio_url',
                youtubeUrl: url,
                requestContext: ctx,
              },
              log
            );

            return {
              url: fallback.url,
              format: fallback.format || 'unknown',
              duration: fallback.duration,
            };
          }

          throw buildAnnotatedYouTubeError(
            `yt-dlp failed after public and cookie direct URL attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      if (cookieContext.cookieBreakerOpen && isBrowserFallbackEnabled()) {
        setCachedAccessDecision(ctx, url, {
          state: 'cookie_stale',
          mode: 'browser_fallback',
          reason: 'direct_url_cookie_circuit_breaker_open',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          cookieBreakerOpen: true,
          disabledUntil: cookieContext.disabledUntil,
          cookieMetadata: cookieContext.metadata,
          decidedAt: getNowIsoString(),
        });
        const fallback = await callBrowserFallback<BrowserFallbackResolveResponse>(
          {
            action: 'resolve_audio_url',
            youtubeUrl: url,
            requestContext: ctx,
          },
          log
        );

        return {
          url: fallback.url,
          format: fallback.format || 'unknown',
          duration: fallback.duration,
        };
      }

      if (shouldEscalateToBrowserFallback(publicFailureClass, isBrowserFallbackEnabled())) {
        setCachedAccessDecision(ctx, url, {
          state: 'browser_required',
          mode: 'browser_fallback',
          reason: 'direct_url_browser_fallback_after_public_failure',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          decidedAt: getNowIsoString(),
        });
        const fallback = await callBrowserFallback<BrowserFallbackResolveResponse>(
          {
            action: 'resolve_audio_url',
            youtubeUrl: url,
            requestContext: ctx,
          },
          log
        );

        return {
          url: fallback.url,
          format: fallback.format || 'unknown',
          duration: fallback.duration,
        };
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
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
  ensureProductionPoTokenProviderConfigured(isDevelopment);

  log.info('Starting YouTube download (full stream)', { url, isDevelopment, startTime, duration });

  if (cancelToken.isCancellationRequested) {
    throw new Error('getYouTubeStream operation was cancelled');
  }
  let totalBytes = 0;
  let previousPercent = -1;

  // Pipes output to stdout - downloads FULL stream, seeking handled by our FFmpeg
  // NOTE: For precise section downloads with seeking, use getYouTubeAudioUrl + FFmpeg input seeking instead
  const args = ['-f', 'bestaudio/best', '-N', getYtDlpConcurrentFragments(), '--no-playlist', '-o', '-'];
  applyYtDlpRequestPacingArgs(args);
  let cookieContext: YouTubeCookieContext | undefined;
  if (shouldUseCookiesForPublicVideos()) {
    cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
    args.push(...cookieContext.args);
    applyYouTubeExtractorArgs(args, cookieContext.hasCookies ? 'cookie_provider' : 'public_provider', log);
  } else {
    applyYouTubeExtractorArgs(args, 'public_provider', log);
  }

  // Add JS runtime
  args.push('--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime());
  log.debug('Using configured JavaScript runtime for yt-dlp', { runtime: getPreferredYtDlpJsRuntime() });

  args.push(url);

  const command = `${ytdlpPath} ${args.join(' ')}`;
  log.debug('Executing yt-dlp command', { command });
  const ytdlp = spawn(ytdlpPath, args);
  const cleaned = { done: false };

  ytdlp.on('error', (err) => {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
    log.error('yt-dlp spawn error', { error: err });
    passThrough.emit('error', new Error(`getYoutubeStream error ${err}`));
  });

  ytdlp.on('close', (code) => {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
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
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const baseArgs = ['-J', '--no-playlist', '-f', 'bestaudio/best', '--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime()];
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };

  const buildArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    applyYtDlpRequestPacingArgs(args);
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
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

  const tryAttempt = async (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): Promise<YouTubeAudioFragmentsResult> => {
    const args = buildArgs(mode, extraCookieArgs);
    log.info('Extracting YouTube fragment metadata for targeted section download', {
      url,
      attempt: mode,
      usedCookies: mode === 'cookie_provider',
      command: `${ytdlpPath} ${args.join(' ')}`,
    });
    const { stdout, stderr } = await runCommandWithCapture(
      ytdlpPath,
      args,
      'yt-dlp fragment metadata extraction',
      mode
    );
    if (stderr.trim()) {
      log.debug('yt-dlp fragment metadata stderr', { attempt: mode, stderr: stderr.trim() });
    }
    return parseJson(stdout);
  };

  try {
    try {
      return await tryAttempt('public_provider');
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');
      log.warn('Public YouTube fragment metadata extraction failed', {
        url,
        failureClass: publicFailureClass,
        error: publicMessage,
      });

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log);
          const result = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            tryAttempt('cookie_provider', activeCookieContext.args)
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          return result;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          throw buildAnnotatedYouTubeError(
            `yt-dlp fragment metadata extraction failed after public and cookie attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
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
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const cachedDecision = getCachedAccessDecision(ctx, url);

  if (cachedDecision?.mode === 'browser_fallback') {
    log.info('Using cached browser fallback decision for section download', cachedDecision);
    const fallback = await callBrowserFallback<BrowserFallbackSectionResponse>(
      {
        action: 'download_section',
        youtubeUrl: url,
        startTime,
        duration,
        requestContext: ctx,
      },
      log
    );
    return await downloadBrowserFallbackSection(outputFilePath, fallback);
  }

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
    getYtDlpConcurrentFragments(),
    '--no-playlist',
    '--download-sections',
    sectionRange,
    '--force-keyframes-at-cuts', // CRITICAL: Re-encode for precise cuts (not stream copy)
    '-o',
    `${outputFilePath}.%(ext)s`, // Let yt-dlp add extension based on format (webm, m4a, etc.)
  ];
  applyYtDlpRequestPacingArgs(baseArgs);

  // yt-dlp needs ffmpeg for --download-sections and --force-keyframes-at-cuts
  const ffmpegPath = getFFmpegPath();
  const ffmpegDir = path.dirname(ffmpegPath);
  baseArgs.push('--ffmpeg-location', ffmpegDir);
  baseArgs.push('--verbose'); // Add verbose logging to see ffmpeg commands and detailed errors

  // yt-dlp now expects an external JS runtime for full YouTube support.
  // We default to Node.js here to avoid adding Deno to the container footprint.
  baseArgs.push('--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime());
  log.debug('Using configured JavaScript runtime for yt-dlp', { runtime: getPreferredYtDlpJsRuntime() });

  let cookieContext: YouTubeCookieContext | undefined;

  const buildAttemptArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

  const runSectionDownloadAttempt = async (
    mode: YouTubeExtractionMode,
    attemptArgs: string[]
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
        attempt: mode,
        usedCookies: mode === 'cookie_provider',
        note: 'Using --force-keyframes-at-cuts for frame-accurate cuts at exact start/end times',
      });

      const ytdlp = spawn(ytdlpPath, attemptArgs);

      ytdlp.on('error', (err) => {
        log.error('yt-dlp spawn error', { error: err, attempt: mode, usedCookies: mode === 'cookie_provider' });
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
              attempt: mode,
              usedCookies: mode === 'cookie_provider',
              note: 'File contains EXACT time range - no additional seeking needed',
            });
            resolveOnce(actualPath);
          } else {
            // Fallback: check if file exists without extension
            if (fs.existsSync(outputFilePath)) {
              log.info('yt-dlp section download completed successfully', {
                outputFilePath,
                attempt: mode,
                usedCookies: mode === 'cookie_provider',
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
            attempt: mode,
            usedCookies: mode === 'cookie_provider',
            stderr: stderrBuffer,
          });
          rejectOnce(
            new Error(
              annotateYouTubeFailure(
                `yt-dlp exited with code ${code}${signal ? ` (signal: ${signal})` : ''} on ${mode}. stderr: ${stderrBuffer}`,
                classifyYouTubeFailure(stderrBuffer || String(code), mode),
                mode
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
                  attempt: mode,
                  usedCookies: mode === 'cookie_provider',
                });
              })
              .catch((err) => {
                log.error('Node DNS also failed for hostname', {
                  hostname: failedHost,
                  error: err instanceof Error ? err.message : String(err),
                  attempt: mode,
                  usedCookies: mode === 'cookie_provider',
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
              attempt: mode,
              usedCookies: mode === 'cookie_provider',
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
              attempt: mode,
              usedCookies: mode === 'cookie_provider',
            });
            rejectOnce(buildAnnotatedYouTubeError(`yt-dlp error (${mode}): ${stderrStr.trim()}`, mode));
          }
        }
      });
    });

  const cleaned = { done: false };
  try {
    try {
      const publicResult = await runAttemptWithRetries(getYouTubePublicProviderMaxAttempts(), () =>
        runSectionDownloadAttempt('public_provider', buildAttemptArgs('public_provider'))
      );
      setCachedAccessDecision(ctx, url, {
        state: 'public_ok',
        mode: 'public_provider',
        reason: 'section_download_public_success',
        decidedAt: getNowIsoString(),
      });
      return publicResult;
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log);
          const cookieResult = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runSectionDownloadAttempt('cookie_provider', buildAttemptArgs('cookie_provider', activeCookieContext.args))
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'section_download_cookie_success',
            publicFailureClass,
            publicFailureMessage: publicMessage,
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return cookieResult;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );

          if (shouldEscalateToBrowserFallback(cookieFailureClass, isBrowserFallbackEnabled())) {
            setCachedAccessDecision(ctx, url, {
              state: cookieFailureClass === 'cookie_session_stale_or_challenged' ? 'cookie_stale' : 'browser_required',
              mode: 'browser_fallback',
              reason: 'section_download_browser_fallback_after_cookie_failure',
              publicFailureClass,
              publicFailureMessage: publicMessage,
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieMetadata: activeCookieContext.metadata,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              decidedAt: getNowIsoString(),
            });
            const fallback = await callBrowserFallback<BrowserFallbackSectionResponse>(
              {
                action: 'download_section',
                youtubeUrl: url,
                startTime,
                duration,
                requestContext: ctx,
              },
              log
            );
            return await downloadBrowserFallbackSection(outputFilePath, fallback);
          }

          throw buildAnnotatedYouTubeError(
            `yt-dlp section download failed after public and cookie attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      if (cookieContext.cookieBreakerOpen && isBrowserFallbackEnabled()) {
        setCachedAccessDecision(ctx, url, {
          state: 'cookie_stale',
          mode: 'browser_fallback',
          reason: 'section_download_cookie_circuit_breaker_open',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          cookieBreakerOpen: true,
          disabledUntil: cookieContext.disabledUntil,
          cookieMetadata: cookieContext.metadata,
          decidedAt: getNowIsoString(),
        });
        const fallback = await callBrowserFallback<BrowserFallbackSectionResponse>(
          {
            action: 'download_section',
            youtubeUrl: url,
            startTime,
            duration,
            requestContext: ctx,
          },
          log
        );
        return await downloadBrowserFallbackSection(outputFilePath, fallback);
      }

      if (shouldEscalateToBrowserFallback(publicFailureClass, isBrowserFallbackEnabled())) {
        setCachedAccessDecision(ctx, url, {
          state: 'browser_required',
          mode: 'browser_fallback',
          reason: 'section_download_browser_fallback_after_public_failure',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          decidedAt: getNowIsoString(),
        });
        const fallback = await callBrowserFallback<BrowserFallbackSectionResponse>(
          {
            action: 'download_section',
            youtubeUrl: url,
            startTime,
            duration,
            requestContext: ctx,
          },
          log
        );
        return await downloadBrowserFallbackSection(outputFilePath, fallback);
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
  }
};
