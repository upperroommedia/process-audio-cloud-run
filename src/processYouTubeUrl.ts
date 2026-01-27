import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { unlink } from 'fs/promises';
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
  const args = [
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
  args.push(...cookieArgs);

  // Add JS runtime
  args.push('--no-js-runtimes', '--js-runtimes', 'node');

  if (!isDevelopment) {
    args.push('--force-ipv4');
  }

  args.push(url);

  const command = `${ytdlpPath} ${args.join(' ')}`;
  log.debug('Executing yt-dlp to get audio URL', { command });

  const cleaned = { done: false };

  return new Promise<YouTubeAudioUrlResult>((resolve, reject) => {
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
      cleanupCookiesFile(cookiesFilePath, cleaned);
      reject(new Error(`yt-dlp spawn error: ${err}`));
    });

    ytdlp.on('close', (code) => {
      cleanupCookiesFile(cookiesFilePath, cleaned);
      if (code === 0) {
        const lines = stdout
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
            });
            resolve({ url: streamUrl, format, duration });
          } else {
            log.error('Invalid URL in yt-dlp output', { lines });
            reject(new Error('yt-dlp did not return a valid URL'));
          }
        } else if (lines.length >= 1 && lines[lines.length - 1].startsWith('http')) {
          // Fallback: just a URL
          const streamUrl = lines[lines.length - 1];
          log.info('Extracted YouTube audio URL (minimal info)', { urlLength: streamUrl.length });
          resolve({ url: streamUrl, format: 'unknown' });
        } else {
          log.error('Unexpected yt-dlp output format', { stdout, stderr, lines });
          reject(new Error(`Failed to parse yt-dlp output: ${stdout}`));
        }
      } else {
        log.error('yt-dlp failed to get URL', { code, stderr });
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
      }
    });
  });
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
  // -N 12: concurrent fragments (DASH); helps throughput from YouTube to cloud.
  const args = ['-f', 'bestaudio/best', '-N', '12', '--no-playlist', '-o', '-'];

  // Add cookies
  const { args: cookieArgs, cookiesFilePath } = await prepareCookiesArgs(realtimeDB, isDevelopment, log);
  args.push(...cookieArgs);

  // Add JS runtime
  args.push('--no-js-runtimes', '--js-runtimes', 'node');
  log.debug('Using Node.js as JavaScript runtime for yt-dlp');

  if (!isDevelopment) {
    args.push('--force-ipv4');
  }

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

/**
 * Downloads only the needed section from YouTube using yt-dlp.
 * Uses --download-sections with stream copy (-c copy) for efficiency.
 * Does NOT transcode - our ffmpeg will handle transcoding and filtering.
 * This avoids the ffmpeg exit code 251 issue when combining --download-sections with -x.
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
  // -N 12: concurrent fragments (DASH); helps throughput from YouTube to cloud.
  const args = [
    '-f',
    'bestaudio/best', // Get best audio format
    '-N',
    '12',
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
  args.push('--ffmpeg-location', ffmpegDir);
  args.push('--verbose'); // Add verbose logging to see ffmpeg commands and detailed errors

  // yt-dlp now expects an external JS runtime for full YouTube support.
  // We use Node.js since it's already installed in our container.
  // Clear default (deno) first, then enable node.
  args.push('--no-js-runtimes', '--js-runtimes', 'node');
  log.debug('Using Node.js as JavaScript runtime for yt-dlp');

  // Add cookies
  const { args: cookieArgs, cookiesFilePath } = await prepareCookiesArgs(realtimeDB, isDevelopment, log);
  args.push(...cookieArgs);

  if (!isDevelopment) {
    args.push('--force-ipv4');
  }

  args.push(url);

  const command = `${ytdlpPath} ${args.join(' ')}`;
  log.info('Executing yt-dlp section download with precise cuts', {
    command,
    sectionRange,
    outputFilePath,
    note: 'Using --force-keyframes-at-cuts for frame-accurate cuts at exact start/end times',
  });

  const cleaned = { done: false };

  return new Promise<string>((resolve, reject) => {
    let previousPercent = -1;

    const ytdlp = spawn(ytdlpPath, args);

    ytdlp.on('error', (err) => {
      log.error('yt-dlp spawn error', { error: err });
      cleanupCookiesFile(cookiesFilePath, cleaned);
      reject(new Error(`yt-dlp spawn error: ${err}`));
    });

    ytdlp.on('close', (code, signal) => {
      cleanupCookiesFile(cookiesFilePath, cleaned);
      const dir = path.dirname(outputFilePath);
      const baseName = path.basename(outputFilePath);
      let files: string[] = [];
      try {
        files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      } catch (err) {
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
            note: 'File contains EXACT time range - no additional seeking needed',
          });
          resolve(actualPath);
        } else {
          // Fallback: check if file exists without extension
          if (fs.existsSync(outputFilePath)) {
            log.info('yt-dlp section download completed successfully', { outputFilePath });
            resolve(outputFilePath);
          } else {
            reject(new Error(`Output file was not created. Expected file starting with: ${baseName}`));
          }
        }
      } else {
        log.error('yt-dlp exited with error code', { code, signal });
        reject(
          new Error(`yt-dlp exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. Check logs for details.`)
        );
      }
    });

    ytdlp.stderr?.on('data', (data) => {
      if (cancelToken.isCancellationRequested) {
        ytdlp.kill('SIGTERM');
        reject(new Error('Download operation was cancelled'));
        return;
      }

      const stderrStr = data.toString();

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
              });
            })
            .catch((err) => {
              log.error('Node DNS also failed for hostname', {
                hostname: failedHost,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
      }

      // Log ffmpeg command line when yt-dlp shows it (for --download-sections)
      if (stderrStr.includes('ffmpeg command line:')) {
        const ffmpegCmdMatch = stderrStr.match(/ffmpeg command line: (.+)/);
        if (ffmpegCmdMatch) {
          const ffmpegCmd = ffmpegCmdMatch[1];
          log.info('yt-dlp ffmpeg command detected', { command: ffmpegCmd });
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
          log.error('yt-dlp fatal error detected', { stderr: stderrStr.trim() });
          reject(new Error(`yt-dlp error: ${stderrStr.trim()}`));
        }
      }
    });
  });
};
