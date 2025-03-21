import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import { Database } from 'firebase-admin/database';

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
  realtimeDB: Database
): Promise<ChildProcessWithoutNullStreams> => {
  console.log('Streaming audio from youtube video:', url);
  if (cancelToken.isCancellationRequested) {
    throw new Error('getYouTubeStream operation was cancelled');
  }
  let totalBytes = 0;
  const cookiesFilePath = path.join(__dirname, 'cookies.txt');

  const cookiesPath = realtimeDB.ref('yt-dlp-cookies');
  const encodedCookies = await cookiesPath.get();
  if (encodedCookies.exists()) {
    try {
      // Decode the base64 encoded cookies string
      const decodedCookies = Buffer.from(encodedCookies.val(), 'base64').toString('utf8');

      // Write the decoded contents to cookies.txt
      fs.writeFileSync(cookiesFilePath, decodedCookies, 'utf8');
      console.log('cookies.txt file created from yt-dlp-cookies realtimeDB variable.');
    } catch (err) {
      console.error('Failed to decode and write cookies file:', err);
      process.exit(1);
    }
  } else {
    console.error('Could not find yt-dlp-cookies in the realtimeDB');
    process.exit(1);
  }

  //pipes output to stdout
  const args = ['--cookies', cookiesFilePath, '-f', 'bestaudio', '-N 4', '--no-playlist', '-o', '-'];
  if (encodedCookies.exists()) {
    args.push('--cookies', cookiesFilePath);
  }
  args.push(url);

  // Log the actual command
  const command = `${ytdlpPath} ${args.join(' ')}`;
  console.log('Executing command:', JSON.stringify(command));
  const ytdlp = spawn(ytdlpPath, args);

  ytdlp.on('error', (err) => {
    console.error('ytdlp Error:', err);
    passThrough.emit('error', new Error(`getYoutubeStream error ${err}`));
  });

  ytdlp.on('close', (code) => {
    console.log('ytdlp spawn closed with code', code);
    if (code && code !== 0) {
      console.error('Spawn closed with non-zero code of:', code);
      passThrough.emit(
        'error',
        new Error('Spawn closed with non-zero error code. Please check logs for more information.')
      );
    }
  });

  ytdlp.on('exit', () => {
    console.log('ytdlp spawn exited');
  });

  ytdlp.stdout.on('end', () => {
    console.log('ytdlp stdout ended');
    console.log('Number of MB streamed', totalBytes / (1024 * 1024));
  });

  ytdlp.stderr?.on('error', (err) => {
    console.error('ytdlp stderr Error:', err);
    passThrough.emit('error', new Error(`getYoutubeStream error: ${err}`));
  });

  ytdlp.stderr?.on('data', (data) => {
    if (cancelToken.isCancellationRequested) {
      passThrough.emit('error', new Error('getYouTubeStream operation was cancelled'));
      return;
    }
    if (data.includes('download')) {
      const percent = extractPercent(data.toString());
      if (percent) {
        // update progress only when transcoding has not started
        updateProgressCallback(percent);
      }
    }
    if (data.toString().includes('ERROR')) {
      passThrough.emit('error', new Error(data.toString()));
      return;
    }
    console.debug('ytdlp stderr:', data.toString());
  });

  ytdlp.stdout?.on('data', (data) => {
    totalBytes += data.length;
  });

  ytdlp.stdout.pipe(passThrough);

  return ytdlp;
};
