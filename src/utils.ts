import os from 'os';
import path from 'path';
import { exec, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { stat } from 'fs/promises';
import { ProcessAudioInputType, AudioSource, CustomMetadata, FilePaths } from './types';
import { Bucket } from '@google-cloud/storage';
import axios from 'axios';
import logger, { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';

export const throwErrorOnSpecificStderr = (stderrLine: string) => {
  const errorMessages = ['Output file is empty'];
  for (const errorMessage of errorMessages) {
    if (stderrLine.includes(errorMessage)) {
      throw new Error(`Ffmpeg error: ${errorMessage} found in stderr: ${stderrLine}`);
    }
  }
};

/**
 * Log process memory and optionally "our" /tmp usage (sum of tempFiles sizes).
 * Avoids scanning all of os.tmpdir(); when tempFiles is passed, satisfies GCP "calculate memory including /tmp".
 */
export const logMemoryUsage = async (
  message: string,
  ctx?: LogContext,
  tempFiles?: Set<string>
): Promise<void> => {
  const log = createLoggerWithContext(ctx);
  const memoryUsage = process.memoryUsage();
  let tempDirMB = 0;

  if (tempFiles && tempFiles.size > 0) {
    for (const filePath of tempFiles) {
      try {
        const fileStats = await stat(filePath);
        tempDirMB += fileStats.size;
      } catch {
        /* ignore missing or inaccessible */
      }
    }
    tempDirMB = parseFloat((tempDirMB / (1024 * 1024)).toFixed(2));
  }

  const memoryUsageInMB = {
    rss: parseFloat((memoryUsage.rss / (1024 * 1024)).toFixed(2)),
    heapTotal: parseFloat((memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)),
    heapUsed: parseFloat((memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)),
    external: parseFloat((memoryUsage.external / (1024 * 1024)).toFixed(2)),
    tempDir: tempDirMB,
  };

  log.debug(message, memoryUsageInMB);
};

export const createTempFile = (fileName: string, tempFiles: Set<string>) => {
  try {
    if (!existsSync(os.tmpdir())) {
      mkdirSync(os.tmpdir());
    }
    const filePath = path.join(os.tmpdir(), fileName);
    tempFiles.add(filePath);
    return filePath;
  } catch (err) {
    throw new Error(`Error creating temp file: ${err}`);
  }
};

export const convertStringToMilliseconds = (timeStr: string): number => {
  // Example time string: '10:20:30.500' (HH:MM:SS.ms format from ffmpeg)
  if (!timeStr) {
    return 0;
  }
  const [hours, minutes, secondsAndMilliseconds] = timeStr.split(':');
  if (!secondsAndMilliseconds) {
    return 0;
  }
  const [seconds, milliseconds] = secondsAndMilliseconds.split('.');

  const h = parseInt(hours, 10);
  const m = parseInt(minutes, 10);
  const s = parseInt(seconds, 10);
  const ms = parseInt(milliseconds || '0', 10);

  // Validate parsed values to prevent NaN propagation
  if (isNaN(h) || isNaN(m) || isNaN(s) || isNaN(ms)) {
    logger.warn('Failed to parse time string', { timeStr, hours, minutes, seconds, milliseconds });
    return 0;
  }

  return (h * 60 * 60 + m * 60 + s) * 1000 + ms;
};

export function secondsToTimeFormat(durationSeconds: number) {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds - hours * 3600) / 60);
  const seconds = durationSeconds - hours * 3600 - minutes * 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toFixed(3)
    .padStart(6, '0')}`;
}

function logFFMPEGVersion(ffmpegStaticPath: string) {
  exec(`${ffmpegStaticPath} -version`, (err, stdout) => {
    if (err) {
      logger.error('FFMPEG not installed', err);
    } else {
      logger.info('FFMPEG version', stdout);
    }
  });
}

export function getFFmpegPath(): string {
  // Check common ffmpeg locations in priority order
  const ffmpegPaths = [
    '/usr/bin/ffmpeg', // Linux/Docker (apt install)
    '/opt/homebrew/bin/ffmpeg', // macOS ARM (Homebrew)
    '/usr/local/bin/ffmpeg', // macOS Intel (Homebrew) or manual install
  ];

  for (const ffmpegPath of ffmpegPaths) {
    if (existsSync(ffmpegPath)) {
      logFFMPEGVersion(ffmpegPath);
      logger.info('Using ffmpeg', { path: ffmpegPath });
      return ffmpegPath;
    }
  }

  throw new Error(`ffmpeg not found. Checked: ${ffmpegPaths.join(', ')}. Install via apt (Docker) or brew (macOS)`);
}

export function getFFprobePath(): string {
  // Check common ffprobe locations in priority order
  const ffprobePaths = [
    '/usr/bin/ffprobe', // Linux/Docker (apt install)
    '/opt/homebrew/bin/ffprobe', // macOS ARM (Homebrew)
    '/usr/local/bin/ffprobe', // macOS Intel (Homebrew) or manual install
  ];

  for (const ffprobePath of ffprobePaths) {
    if (existsSync(ffprobePath)) {
      return ffprobePath;
    }
  }

  throw new Error(`ffprobe not found. Checked: ${ffprobePaths.join(', ')}. Install via apt (Docker) or brew (macOS)`);
}

export const uploadSermon = async (
  inputFilePath: string,
  destinationFilePath: string,
  bucket: Bucket,
  customMetadata: CustomMetadata
) => {
  logger.info('custom metadata', customMetadata);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  await bucket.upload(inputFilePath, { destination: destinationFilePath });
  await bucket.file(destinationFilePath).setMetadata({
    contentType: 'audio/mpeg',
    contentDisposition,
    metadata: customMetadata,
  });
};

export const getDurationSeconds = (filePath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const ffprobePath = getFFprobePath();
    const proc = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}: ${stderr}`));
        return;
      }

      try {
        const metadata = JSON.parse(stdout);
        const duration = parseFloat(metadata.format?.duration || '0');
        resolve(duration);
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
};

/**
 * Rewrites emulator URLs to use the correct host when running in Docker.
 * URLs stored in Firestore may contain 127.0.0.1, but inside Docker,
 * we need to use host.docker.internal to reach the host machine.
 */
function rewriteEmulatorUrl(url: string): string {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const emulatorHost = process.env.FIREBASE_EMULATOR_HOST;

  if (isDevelopment && emulatorHost && emulatorHost !== '127.0.0.1' && emulatorHost !== 'localhost') {
    // Replace 127.0.0.1 or localhost with the configured emulator host
    return url
      .replace(/http:\/\/127\.0\.0\.1:/g, `http://${emulatorHost}:`)
      .replace(/http:\/\/localhost:/g, `http://${emulatorHost}:`);
  }
  return url;
}

export async function downloadFile(fileUrl: string, outputLocationPath: string): Promise<void> {
  const writer = createWriteStream(outputLocationPath);
  const rewrittenUrl = rewriteEmulatorUrl(fileUrl);

  if (rewrittenUrl !== fileUrl) {
    logger.debug('Rewrote emulator URL', { original: fileUrl, rewritten: rewrittenUrl });
  }

  return axios({
    method: 'get',
    url: rewrittenUrl,
    responseType: 'stream',
  }).then((response) => {
    //ensure that the user can call `then()` only when the file has
    //been downloaded entirely.

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      let error: unknown = null;
      writer.on('error', (err: unknown) => {
        error = err;
        writer.close();
        reject(err);
      });
      writer.on('close', () => {
        if (!error) {
          resolve();
        }
        //no need to call the reject here, as it will have been called in the
        //'error' stream;
      });
    });
  });
}

export const downloadFiles = async (
  bucket: Bucket,
  filePaths: FilePaths,
  tempFiles: Set<string>
): Promise<FilePaths> => {
  const tempFilePaths: FilePaths = { INTRO: undefined, OUTRO: undefined };
  const promises: Promise<unknown>[] = [];
  // get key and value of filePaths
  for (const [key, filePath] of Object.entries(filePaths) as [keyof FilePaths, string | undefined][]) {
    if (filePath) {
      tempFilePaths[key] = createTempFile(path.basename(filePath).split('?')[0], tempFiles);
      promises.push(downloadFile(filePath, tempFilePaths[key] as string));
      logger.info(`Downloading ${filePath} to ${tempFilePaths[key]}`);
    }
  }
  await Promise.all(promises);
  return tempFilePaths;
};

export async function executeWithTimeout<T>(
  asyncFunc: () => Promise<T>,
  cancelFunc: () => void,
  delay: number
): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      cancelFunc();
      logger.error('Function timeout', `Timeout of ${delay / 1000} seconds exceeded`);
      reject(new Error(`Timeout of ${delay / 1000} seconds exceeded`));
    }, delay);
  });

  return Promise.race([asyncFunc(), timeoutPromise]);
}

export function validateAddIntroOutroData(data: unknown): data is ProcessAudioInputType {
  if (!(data instanceof Object)) return false;
  const inputData = data as Partial<ProcessAudioInputType>;

  // Validate id is a non-empty string
  if (typeof inputData.id !== 'string' || !inputData.id) {
    logger.error('Invalid Argument', 'id must be a non-empty string');
    return false;
  }

  // Validate startTime is a finite number (can be 0)
  if (typeof inputData.startTime !== 'number' || !Number.isFinite(inputData.startTime)) {
    logger.error('Invalid Argument', 'startTime must be a finite number');
    return false;
  }

  // Validate duration is a positive finite number
  if (typeof inputData.duration !== 'number' || !Number.isFinite(inputData.duration) || inputData.duration <= 0) {
    logger.error('Invalid Argument', 'duration must be a positive finite number');
    return false;
  }

  // Validate audio source (youtubeUrl or storageFilePath)
  if ('youtubeUrl' in inputData) {
    if (typeof inputData.youtubeUrl !== 'string' || !inputData.youtubeUrl) {
      logger.error('Invalid Argument', 'youtubeUrl must be a non-empty string');
      return false;
    }
  } else if ('storageFilePath' in inputData) {
    if (typeof inputData.storageFilePath !== 'string' || !inputData.storageFilePath) {
      logger.error('Invalid Argument', 'storageFilePath must be a non-empty string');
      return false;
    }
  } else {
    logger.error(
      'Invalid Argument',
      'inputData must contain either a valid youtubeUrl (string) or storageFilePath (string) properties'
    );
    return false;
  }

  // Validate optional fields if present
  if (inputData.introUrl !== undefined && (typeof inputData.introUrl !== 'string' || !inputData.introUrl)) {
    logger.error('Invalid Argument', 'introUrl must be a non-empty string if provided');
    return false;
  }

  if (inputData.outroUrl !== undefined && (typeof inputData.outroUrl !== 'string' || !inputData.outroUrl)) {
    logger.error('Invalid Argument', 'outroUrl must be a non-empty string if provided');
    return false;
  }

  return true;
}

function removeTimestampParam(urlString: string): string {
  try {
    const url = new URL(urlString);
    url.searchParams.delete('t'); // Remove the 't' query parameter
    return url.toString();
  } catch (error) {
    logger.error('Invalid URL:', error);
    return urlString; // Return the original URL if parsing fails
  }
}

export function getAudioSource(data: ProcessAudioInputType): AudioSource {
  if ('youtubeUrl' in data) {
    return {
      id: data.id,
      source: removeTimestampParam(data.youtubeUrl),
      type: 'YouTubeUrl',
    };
  } else {
    return {
      id: data.id,
      source: data.storageFilePath,
      type: 'StorageFilePath',
    };
  }
}
