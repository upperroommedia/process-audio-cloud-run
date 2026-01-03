import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import { Database } from 'firebase-admin/database';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';

function extractPercent(line: string): number | null {
  const percentMatch = line.match(/(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)%/);
  return percentMatch ? parseFloat(percentMatch[1]) : null;
}

export const processYouTubeUrl = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  cancelToken: CancelToken,
  passThrough: Writable,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  ctx?: LogContext
): Promise<ChildProcessWithoutNullStreams> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';

  log.info('Starting YouTube download', { url, isDevelopment });

  if (cancelToken.isCancellationRequested) {
    throw new Error('getYouTubeStream operation was cancelled');
  }
  let totalBytes = 0;
  let previousPercent = -1;

  //pipes output to stdout
  const args = ['-f', 'bestaudio/best', '-N 4', '--no-playlist', '-o', '-'];

  if (isDevelopment) {
    // In development, use cookies from Chrome browser
    log.info('Using cookies from Chrome browser (development mode)');
    args.push('--cookies-from-browser', 'chrome');
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
    if (data.includes('download')) {
      const percent = extractPercent(data.toString());
      if (percent !== null) {
        // Only update if percent has changed by an integer value (at least 1%)
        const percentInt = Math.floor(percent);
        if (percentInt !== previousPercent) {
          previousPercent = percentInt;
          updateProgressCallback(percent);
        }
      }
    }
    if (data.toString().includes('ERROR')) {
      log.error('yt-dlp error detected', { stderr: data.toString() });
      passThrough.emit('error', new Error(data.toString()));
      return;
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
