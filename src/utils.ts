import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { exec } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { path as ffprobeStatic } from 'ffprobe-static';
import { ProcessAudioInputType, AudioSource, CustomMetadata, FilePaths } from './types';
import { Bucket } from '@google-cloud/storage';
import axios from 'axios';

export const throwErrorOnSpecificStderr = (stderrLine: string) => {
  const errorMessages = ['Output file is empty'];
  for (const errorMessage of errorMessages) {
    if (stderrLine.includes(errorMessage)) {
      throw new Error(`Ffmpeg error: ${errorMessage} found in stderr: ${stderrLine}`);
    }
  }
};

export const logMemoryUsage = async (message: string) => {
  const memoryUsage = process.memoryUsage();
  const tempDir = os.tmpdir();
  const files = await readdir(tempDir);
  let totalSize = 0;

  for (const file of files) {
    const filePath = path.join(tempDir, file);
    const fileStats = await stat(filePath);
    totalSize += fileStats.size;
  }
  const memoryUsageInMB = {
    rss: (memoryUsage.rss / (1024 * 1024)).toFixed(2), // Resident Set Size
    heapTotal: (memoryUsage.heapTotal / (1024 * 1024)).toFixed(2), // Total size of the allocated heap
    heapUsed: (memoryUsage.heapUsed / (1024 * 1024)).toFixed(2), // Actual memory used
    external: (memoryUsage.external / (1024 * 1024)).toFixed(2), // Memory used by C++ objects bound to JavaScript objects
    tempDir: (totalSize / (1024 * 1024)).toFixed(2), // Memory used by the tempDir in MB
  };

  console.log(message, memoryUsageInMB);
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
  // '10:20:30:500'  Example time string
  if (!timeStr) {
    return 0;
  }
  const [hours, minutes, secondsAndMilliseconds] = timeStr.split(':');
  if (!secondsAndMilliseconds) {
    return 0;
  }
  const [seconds, milliseconds] = secondsAndMilliseconds.split('.');

  return (parseInt(hours) * 60 * 60 + parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + parseInt(milliseconds);
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
      console.error('FFMPEG not installed', err);
    } else {
      console.log('FFMPEG version', stdout);
    }
  });
}

export function loadStaticFFMPEG(): typeof ffmpeg {
  if (!ffmpegStatic) {
    console.error('ffmpeg-static not found');
  } else {
    logFFMPEGVersion(ffmpegStatic);
    console.log('ffmpeg-static found', ffmpegStatic);
    ffmpeg.setFfmpegPath(ffmpegStatic);
    console.log('ffprobe-static found', ffprobeStatic);
    ffmpeg.setFfprobePath(ffprobeStatic);
  }
  return ffmpeg;
}

export const uploadSermon = async (
  inputFilePath: string,
  destinationFilePath: string,
  bucket: Bucket,
  customMetadata: CustomMetadata
) => {
  console.log('custom metadata', customMetadata);
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
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      }
      resolve(metadata?.format?.duration || 0);
    });
  });
};

export async function downloadFile(fileUrl: string, outputLocationPath: string): Promise<void> {
  const writer = createWriteStream(outputLocationPath);

  return axios({
    method: 'get',
    url: fileUrl,
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
      console.log(`Downloading ${filePath} to ${tempFilePaths[key]}`);
    }
  }
  await Promise.all(promises);
  return tempFilePaths;
};

export async function executeWithTimout<T>(
  asyncFunc: () => Promise<T>,
  cancelFunc: () => void,
  delay: number
): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      cancelFunc();
      console.error('Function timeout', `Timeout of ${delay / 1000} seconds exceeded`);
      reject(new Error(`Timeout of ${delay / 1000} seconds exceeded`));
    }, delay);
  });

  return Promise.race([asyncFunc(), timeoutPromise]);
}

export function validateAddIntroOutroData(data: unknown): data is ProcessAudioInputType {
  if (!(data instanceof Object)) return false;
  const inputData = data as Partial<ProcessAudioInputType>;

  if ('youtubeUrl' in inputData) {
    if (!inputData.youtubeUrl) {
      const errorMessage = 'youtubeUrl cannot be empty if defined';
      console.error('Invalid Argument', errorMessage);
      return false;
    }
  } else if ('storageFilePath' in inputData) {
    if (!inputData.storageFilePath) {
      const errorMessage = 'storageFilePath cannot me empty if defined';
      console.error('Invalid Argument', errorMessage);
      return false;
    }
  } else {
    const errorMessage =
      'inputData must contain either a valid youtubeUrl (string) or storageFilePath (string) properties';
    console.error('Invalid Argument', errorMessage);
    return false;
  }

  if (
    !inputData.id ||
    inputData.startTime === undefined ||
    inputData.startTime === null ||
    inputData.duration === null ||
    inputData.duration === undefined
  ) {
    const errorMessage =
      'Data must contain id (string), startTime (number), and endTime (number) properties || optionally introUrl (string) and outroUrl (string)';
    console.error('Invalid Argument', errorMessage);
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
    console.error('Invalid URL:', error);
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
