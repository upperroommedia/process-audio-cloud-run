import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import { Database } from 'firebase-admin/database';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';
import { getFFmpegPath } from './utils';
import dns from 'node:dns/promises';

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

  log.info('Starting YouTube download', { url, isDevelopment, startTime, duration });

  if (cancelToken.isCancellationRequested) {
    throw new Error('getYouTubeStream operation was cancelled');
  }
  let totalBytes = 0;
  let previousPercent = -1;

  //pipes output to stdout
  const args = ['-f', 'bestaudio/best', '-N 4', '--no-playlist', '-o', '-'];

  // NOTE: --download-sections with -o - (stdout) is unreliable due to ffmpeg exit code 251
  // when using -c copy (stream copy) with HTTP input seeking to stdout.
  // Instead, we download the full stream and handle seeking in our ffmpeg command.
  // This is less efficient but more reliable.

  if (isDevelopment) {
    // In development, prefer cookies from Chrome browser when running on the host.
    // In Docker on macOS, Chrome cookies are typically not decryptable inside the container
    // since the host keychain is unavailable. In that case, skip cookies.
    if (isRunningInDocker()) {
      log.warn('Skipping --cookies-from-browser in Docker (cookies cannot be decrypted without host keychain)', {
        note: 'If you need cookies in Docker, provide plaintext cookies via realtimeDB or a mounted cookies.txt',
      });
    } else {
      log.info('Using cookies from Chrome browser (development mode)');
      args.push('--cookies-from-browser', 'chrome');
    }
  } else {
    // In production, use cookies from database
    const cookiesFilePath = path.join(__dirname, 'cookies.txt');
    const cookiesPath = realtimeDB.ref('yt-dlp-cookies');
    const encodedCookies = await cookiesPath.get();

    if (encodedCookies.exists()) {
      try {
        // Decode the base64 encoded cookies string
        const decodedCookies = Buffer.from(encodedCookies.val(), 'base64').toString('utf8');

        // Write the decoded contents to cookies.txt
        fs.writeFileSync(cookiesFilePath, decodedCookies, 'utf8');
        log.debug('Cookies file created from database');
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

  // yt-dlp now expects an external JS runtime for full YouTube support.
  // We use Node.js since it's already installed in our container.
  // Clear default (deno) first, then enable node.
  args.push('--no-js-runtimes', '--js-runtimes', 'node');
  log.debug('Using Node.js as JavaScript runtime for yt-dlp');

  args.push(url);

  const command = `${ytdlpPath} ${args.join(' ')}`;
  log.debug('Executing yt-dlp command', { command });
  const ytdlp = spawn(ytdlpPath, args);

  ytdlp.on('error', (err) => {
    log.error('yt-dlp spawn error', { error: err });
    passThrough.emit('error', new Error(`getYoutubeStream error ${err}`));
  });

  ytdlp.on('close', (code) => {
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

  log.info('Downloading YouTube section (no transcoding)', {
    url,
    outputFilePath,
    startTime,
    duration,
    isDevelopment,
    note: 'yt-dlp will download only the section using stream copy, our ffmpeg will transcode and filter',
  });

  if (cancelToken.isCancellationRequested) {
    throw new Error('Download operation was cancelled');
  }

  const startTimeStr = formatTimeForDownloadSections(startTime);
  const endTimeStr = duration !== undefined ? formatTimeForDownloadSections(startTime + duration) : 'inf';
  const sectionRange = `*${startTimeStr}-${endTimeStr}`;

  // Build yt-dlp command to:
  // 1. Download only the needed section (--download-sections) - uses ffmpeg with -c copy (stream copy, no transcoding)
  // 2. Output to file (-o) - let yt-dlp add the extension based on format
  // 3. NO -x --extract-audio - we'll let our ffmpeg handle transcoding and filtering
  // This approach:
  // - Downloads only the section we need (efficient bandwidth)
  // - Uses stream copy (no transcoding in yt-dlp, efficient CPU)
  // - Avoids ffmpeg exit code 251 issues
  // - Lets our ffmpeg do all processing in one pass (consistent quality)
  const args = [
    '-f',
    'bestaudio/best', // Get best audio format
    '-N',
    '4',
    '--no-playlist',
    '--download-sections',
    sectionRange,
    '-o',
    `${outputFilePath}.%(ext)s`, // Let yt-dlp add extension based on format (webm, m4a, etc.)
  ];

  // yt-dlp needs ffmpeg for --download-sections (uses ffmpeg with -c copy for stream copy)
  const ffmpegPath = getFFmpegPath();
  const ffmpegDir = path.dirname(ffmpegPath);
  args.push('--ffmpeg-location', ffmpegDir);
  args.push('--verbose'); // Add verbose logging to see ffmpeg commands and detailed errors

  // yt-dlp now expects an external JS runtime for full YouTube support.
  // We use Node.js since it's already installed in our container.
  // Clear default (deno) first, then enable node.
  args.push('--no-js-runtimes', '--js-runtimes', 'node');
  log.debug('Using Node.js as JavaScript runtime for yt-dlp');

  if (isDevelopment) {
    if (isRunningInDocker()) {
      log.warn('Skipping --cookies-from-browser in Docker (cookies cannot be decrypted without host keychain)', {
        note: 'If you need cookies in Docker, provide plaintext cookies via realtimeDB or a mounted cookies.txt',
      });
    } else {
      log.info('Using cookies from Chrome browser (development mode)');
      args.push('--cookies-from-browser', 'chrome');
    }
  } else {
    // In production, use cookies from database
    const cookiesFilePath = path.join(__dirname, 'cookies.txt');
    const cookiesPath = realtimeDB.ref('yt-dlp-cookies');
    const encodedCookies = await cookiesPath.get();

    if (encodedCookies.exists()) {
      try {
        const decodedCookies = Buffer.from(encodedCookies.val(), 'base64').toString('utf8');
        fs.writeFileSync(cookiesFilePath, decodedCookies, 'utf8');
        log.debug('Cookies file created from database');
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

  args.push(url);

  const command = `${ytdlpPath} ${args.join(' ')}`;
  log.info('Executing yt-dlp section download (stream copy, no transcoding)', {
    command,
    sectionRange,
    outputFilePath,
    note: 'Our ffmpeg will handle transcoding and filtering in one pass',
  });

  return new Promise<string>((resolve, reject) => {
    let previousPercent = -1;

    const ytdlp = spawn(ytdlpPath, args);

    ytdlp.on('error', (err) => {
      log.error('yt-dlp spawn error', { error: err });
      reject(new Error(`yt-dlp spawn error: ${err}`));
    });

    ytdlp.on('close', (code, signal) => {
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
          log.info('yt-dlp section download completed successfully', {
            outputFilePath: actualPath,
            format: path.extname(actualFile),
            note: 'File is in original format (stream copy), our ffmpeg will transcode and filter',
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
