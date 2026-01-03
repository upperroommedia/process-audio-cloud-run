import { CancelToken } from './CancelToken';
import { Bucket, File } from '@google-cloud/storage';
import { Database, Reference } from 'firebase-admin/database';
import {
  convertStringToMilliseconds,
  createTempFile,
  logMemoryUsage,
  throwErrorOnSpecificStderr,
  getFFmpegPath,
  getDurationSeconds,
} from './utils';
import { CustomMetadata, AudioSource } from './types';
import { processYouTubeUrl, downloadYouTubeSection } from './processYouTubeUrl';
import { unlink } from 'fs/promises';
import { PassThrough, Readable } from 'stream';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { sermonStatus, sermonStatusType } from './types';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';

// Parse ffmpeg stderr for progress and duration
function parseFFmpegProgress(stderrLine: string): { time?: string; duration?: string } {
  const result: { time?: string; duration?: string } = {};

  // Parse time: time=00:01:23.45
  const timeMatch = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (timeMatch) {
    result.time = timeMatch[1];
  }

  // Parse duration: Duration: 00:05:30.12
  const durationMatch = stderrLine.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (durationMatch) {
    result.duration = durationMatch[1];
  }

  return result;
}

const trimAndTranscode = async (
  ytdlpPath: string,
  cancelToken: CancelToken,
  bucket: Bucket,
  audioSource: AudioSource,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  realtimeDB: Database,
  docRef: FirebaseFirestore.DocumentReference,
  sermonStatus: sermonStatus,
  customMetadata: CustomMetadata,
  startTime?: number,
  duration?: number,
  ctx?: LogContext
): Promise<File> => {
  const log = createLoggerWithContext(ctx);
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: 'audio/mpeg',
    metadata: { contentDisposition, metadata: customMetadata },
    timeout: 30 * 60 * 1000, // 30 minutes in milliseconds
  });
  let inputSource: string | Readable | undefined;
  let ytdlp: ChildProcessWithoutNullStreams | undefined;
  let proc: ReturnType<typeof spawn> | undefined;
  let transcodingStarted = false;
  let usedYtdlpSectionDownload = false;

  // Duration verification state - used to determine if secondary trim is needed
  // Secondary trim uses the KNOWN user-specified duration, NOT arbitrary values
  let secondaryTrimNeeded = false;
  let secondaryTrimDuration: number | undefined;
  const DURATION_TOLERANCE_SECONDS = 2; // Allow 2 seconds tolerance for encoding variance

  log.info('Starting trim and transcode', {
    sourceType: audioSource.type,
    startTime,
    duration,
    outputPath: outputFilePath,
  });

  // Calculate dynamic percentage ranges based on trimming parameters
  // Download is 5x faster than transcoding
  const DOWNLOAD_SPEED_MULTIPLIER = 5;

  /**
   * Calculates dynamic percentage ranges for download and transcode phases
   * @param startTime - Start time in seconds (undefined if no trimming)
   * @param duration - Duration in seconds (undefined if no trimming)
   * @param totalDuration - Total audio duration in seconds (optional, for better accuracy)
   * @returns Object with downloadEndPercent and transcodeStartPercent
   */
  const calculateProgressRanges = (
    startTime?: number,
    duration?: number,
    totalDuration?: number
  ): { downloadEndPercent: number; transcodeStartPercent: number } => {
    // Scenario 1: No trimming - transcoding starts immediately
    if (!startTime && !duration) {
      // Download is minimal since we start transcoding right away
      // Give download a tiny range (0-2%) for initial buffering
      return { downloadEndPercent: 2, transcodeStartPercent: 0 };
    }

    // Scenario 2 & 3: We have trimming parameters
    // Calculate time ranges
    const downloadTime = startTime || 0; // Time we need to download before transcoding

    // If we don't have duration but have startTime, we'll transcode from startTime to end
    // In this case, use a reasonable estimate or default
    const actualTranscodeTime = duration || (totalDuration ? totalDuration - downloadTime : 1000); // Default to large number if unknown

    // Total time we're processing: download time + transcode time
    const totalProcessingTime = downloadTime + actualTranscodeTime;

    // Calculate percentage ranges (0-98% for download+transcode, 98-100% for merge)
    // Formula: (downloadTime / totalProcessingTime) / 5 * 98
    // This accounts for download being 5x faster than transcoding
    // Example: 100 min audio, transcode 40-60: (40/60)/5 * 98 = 13.3%
    const downloadEndPercent =
      totalProcessingTime > 0
        ? Math.min(98, Math.round((downloadTime / totalProcessingTime / DOWNLOAD_SPEED_MULTIPLIER) * 98))
        : 0;

    // Transcode starts where download ends
    const transcodeStartPercent = downloadEndPercent;

    return { downloadEndPercent, transcodeStartPercent };
  };

  // Calculate ranges (will be updated if we get totalDuration later)
  let progressRanges = calculateProgressRanges(startTime, duration);

  log.info('Progress ranges calculated', {
    startTime,
    duration,
    downloadEndPercent: progressRanges.downloadEndPercent,
    transcodeStartPercent: progressRanges.transcodeStartPercent,
  });

  let maxDownloadProgress = -1;
  let lastLoggedProgress = -1; // Track last logged progress for console output
  const updateDownloadProgress = (progress: number) => {
    if (!transcodingStarted) {
      // Scale yt-dlp progress (0-100%) to 0-downloadEndPercent range
      const scaledProgress = Math.round(progress * (progressRanges.downloadEndPercent / 100));

      // Log progress to console more frequently (every 10% of raw progress)
      const progressDecile = Math.floor(progress / 10);
      if (progressDecile > lastLoggedProgress) {
        lastLoggedProgress = progressDecile;
        log.info('Download progress', {
          rawProgress: Math.round(progress),
          scaledProgress,
          downloadEndPercent: progressRanges.downloadEndPercent,
          phase: 'download',
        });
      }

      // Only update database if progress has increased (prevent backwards jumps)
      if (scaledProgress > maxDownloadProgress) {
        maxDownloadProgress = scaledProgress;
        realtimeDBRef.set(scaledProgress);
      }
    }
  };

  try {
    if (audioSource.type === 'YouTubeUrl') {
      log.info('Processing YouTube URL', { url: audioSource.source });

      // If we have startTime, use yt-dlp to download the EXACT section with --force-keyframes-at-cuts
      // This re-encodes at cut points for frame-accurate timing (no extra content before/after)
      // Our ffmpeg will then apply audio filters and convert to MP3
      if (startTime !== undefined && startTime !== null) {
        // Use generic extension - yt-dlp will add the actual extension based on format
        const ytdlpOutputFile = createTempFile(`ytdlp-${audioSource.id}`, tempFiles);
        log.info('Using yt-dlp to download EXACT section with precise cuts', {
          startTime,
          duration,
          outputFile: ytdlpOutputFile,
          note: 'Using --force-keyframes-at-cuts for frame-accurate timing',
        });

        // Download the section - no fallback, fail fast if this doesn't work
        const downloadedFile = await downloadYouTubeSection(
          ytdlpPath,
          audioSource.source,
          ytdlpOutputFile,
          cancelToken,
          updateDownloadProgress,
          realtimeDB,
          startTime,
          duration ?? undefined,
          ctx
        );

        // yt-dlp adds extension to output file (e.g., .webm, .m4a), so the actual file
        // path differs from the base path we registered. Update tempFiles to track the
        // actual file path for proper cleanup.
        if (downloadedFile !== ytdlpOutputFile) {
          tempFiles.delete(ytdlpOutputFile);
          tempFiles.add(downloadedFile);
          log.debug('Updated tempFiles tracking for yt-dlp output', {
            basePath: ytdlpOutputFile,
            actualPath: downloadedFile,
          });
        }

        // With --force-keyframes-at-cuts, yt-dlp re-encodes at cut points instead of using
        // stream copy. This gives us EXACT cuts at the requested start/end times.
        // No timestamp probing or offset calculation needed - the file contains precisely
        // the requested time range.

        // DURATION VERIFICATION: Verify the downloaded file has the expected duration
        // If it exceeds the expected duration, we'll apply a secondary trim using the
        // KNOWN user-specified duration - never an arbitrary value
        const actualDuration = await getDurationSeconds(downloadedFile);
        const expectedDuration = duration ?? Infinity; // Use user-specified duration
        const durationDifference = actualDuration - expectedDuration;
        const withinTolerance = duration === undefined || Math.abs(durationDifference) <= DURATION_TOLERANCE_SECONDS;

        log.info('Downloaded file duration verification', {
          actualDuration: actualDuration.toFixed(2),
          expectedDuration: duration !== undefined ? duration.toFixed(2) : 'not specified',
          durationDifference: durationDifference.toFixed(2),
          tolerance: DURATION_TOLERANCE_SECONDS,
          withinTolerance,
          requestedStart: startTime,
          requestedDuration: duration,
        });

        // Determine if secondary trim is needed based on KNOWN timestamps
        // Only trim if: duration was specified AND actual exceeds expected beyond tolerance
        if (duration !== undefined && actualDuration > expectedDuration + DURATION_TOLERANCE_SECONDS) {
          secondaryTrimNeeded = true;
          secondaryTrimDuration = duration; // Use the KNOWN user-specified duration
          log.warn('Downloaded file exceeds expected duration - will apply secondary trim', {
            actualDuration: actualDuration.toFixed(2),
            expectedDuration: duration.toFixed(2),
            excessSeconds: (actualDuration - duration).toFixed(2),
            action: `Will trim to exact ${duration} seconds as specified by user`,
            note: 'Secondary trim uses KNOWN duration value, not arbitrary trimming',
          });
        } else {
          log.info('yt-dlp section download ready for processing', {
            downloadedFile,
            requestedStart: startTime,
            requestedDuration: duration,
            actualDuration: actualDuration.toFixed(2),
            note: 'File duration within tolerance - no secondary trim needed',
          });
        }

        usedYtdlpSectionDownload = true;
        // Use the downloaded file as input - our ffmpeg will transcode and apply filters
        inputSource = downloadedFile;
      } else {
        // No startTime - use the old streaming approach
        const passThrough = new PassThrough();
        ytdlp = await processYouTubeUrl(
          ytdlpPath,
          audioSource.source,
          cancelToken,
          passThrough,
          updateDownloadProgress,
          realtimeDB,
          undefined,
          undefined,
          ctx
        );
        inputSource = passThrough;
      }
    } else {
      // Process the audio source from storage
      const rawSourceFile = createTempFile(`raw-${audioSource.id}`, tempFiles);
      log.debug('Downloading raw audio source', { source: audioSource.source, destination: rawSourceFile });
      await bucket.file(audioSource.source).download({ destination: rawSourceFile });
      inputSource = rawSourceFile;
    }

    // Build ffmpeg command
    const ffmpegPath = getFFmpegPath();
    const args: string[] = [];

    // Input options
    // When using yt-dlp downloadYouTubeSection with --force-keyframes-at-cuts, the file contains
    // the EXACT requested time range - no seeking needed. For other sources, we may need -ss/-t.
    const usingYtdlpSectionDownload =
      audioSource.type === 'YouTubeUrl' && startTime !== undefined && startTime !== null && usedYtdlpSectionDownload;

    if (typeof inputSource === 'string') {
      // File input
      if (!usingYtdlpSectionDownload && startTime) {
        // For regular files (not yt-dlp precise section), use input seeking for efficiency
        args.push('-ss', startTime.toString());
      }
      // For yt-dlp section: no seeking needed - file has exact cuts from --force-keyframes-at-cuts
      args.push('-i', inputSource);
    } else {
      // Stream/pipe input - must use stdin
      args.push('-i', 'pipe:0');
      // Only add -ss if NOT using yt-dlp section download (yt-dlp already handled cutting)
      if (startTime && !usingYtdlpSectionDownload) {
        // Use -ss after -i for pipe inputs (output seeking)
        args.push('-ss', startTime.toString());
        log.info('Using output seeking for pipe input', {
          startTime,
          note: 'Output seeking required for pipes - ffmpeg will decode then discard frames until startTime',
        });
      }
    }

    // Duration handling:
    // 1. For non-yt-dlp sources: always use -t with user-specified duration
    // 2. For yt-dlp section download: only add -t if secondary trim is needed
    //    Secondary trim uses the KNOWN user-specified duration (not arbitrary values)
    if (duration && !usingYtdlpSectionDownload) {
      args.push('-t', duration.toString());
    } else if (usingYtdlpSectionDownload && secondaryTrimNeeded && secondaryTrimDuration !== undefined) {
      // Apply secondary trim using the KNOWN user-specified duration
      // This is only triggered when ffprobe verified the file exceeds expected duration
      args.push('-t', secondaryTrimDuration.toString());
      log.info('Applying secondary trim with user-specified duration', {
        duration: secondaryTrimDuration,
        reason: 'Downloaded file exceeded expected duration beyond tolerance',
        note: 'Using KNOWN duration value from user input - not arbitrary trimming',
      });
    }

    // Audio codec and filters - ALWAYS applied to ensure consistent audio processing
    // These filters normalize, denoise, and adjust loudness regardless of input source
    const audioFilters =
      'dynaudnorm=g=21:m=40:c=1:b=0,afftdn,pan=stereo|c0<c0+c1|c1<c0+c1,loudnorm=I=-16:LRA=11:TP=-1.5';
    args.push('-acodec', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-ar', '44100', '-af', audioFilters, '-f', 'mp3');

    if (usingYtdlpSectionDownload) {
      log.info('Transcoding yt-dlp section and applying audio filters', {
        filters: audioFilters,
        secondaryTrimApplied: secondaryTrimNeeded,
        secondaryTrimDuration: secondaryTrimNeeded ? secondaryTrimDuration : undefined,
        note: secondaryTrimNeeded
          ? `Applying secondary trim to ${secondaryTrimDuration}s using KNOWN user-specified duration`
          : 'File has exact cuts from --force-keyframes-at-cuts, no secondary trim needed',
      });
    }

    // Output to pipe
    args.push('pipe:1');

    const commandLine = `${ffmpegPath} ${args.join(' ')}`;
    log.info('FFmpeg command', {
      command: commandLine,
      inputType: typeof inputSource === 'string' ? 'file' : 'pipe',
      args: args.join(' '),
      trimParameters: {
        startTime,
        requestedDuration: duration,
        usingYtdlpSectionDownload,
        secondaryTrimNeeded,
        secondaryTrimDuration: secondaryTrimNeeded ? secondaryTrimDuration : undefined,
        effectiveDuration: secondaryTrimNeeded
          ? secondaryTrimDuration
          : usingYtdlpSectionDownload
          ? 'handled by yt-dlp'
          : duration,
      },
    });

    proc = spawn(ffmpegPath, args, {
      stdio: typeof inputSource === 'string' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });

    // Pipe input if it's a stream
    if (typeof inputSource !== 'string') {
      if (!proc || !proc.stdin) {
        throw new Error('FFmpeg process or stdin is null but input is a stream');
      }
      inputSource.pipe(proc.stdin, { end: false });
      const procForErrorHandler = proc; // Capture for error handler

      // Handle EPIPE errors gracefully - they occur when ffmpeg closes stdin early (e.g., during seeking)
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.debug('FFmpeg stdin closed (EPIPE) - this is normal when seeking or process completes', {
            code: err.code,
          });
          // Don't kill the process - EPIPE is expected when the reader closes the pipe
        } else {
          log.error('FFmpeg stdin error', { error: err, code: err.code });
          procForErrorHandler.kill('SIGTERM');
        }
      });

      inputSource.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.debug('Input stream EPIPE - ffmpeg may have closed stdin', { code: err.code });
          // EPIPE is expected when the destination closes the pipe
        } else {
          log.error('Input stream error', { error: err, code: err.code });
          procForErrorHandler.kill('SIGTERM');
        }
      });
    }

    // Pipe output
    if (!proc.stdout) {
      throw new Error('FFmpeg stdout is null');
    }
    proc.stdout.pipe(writeStream);

    // Handle EPIPE on write stream (can occur if storage write fails or is cancelled)
    writeStream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        log.warn('Write stream EPIPE - storage may have closed connection', { code: err.code });
      } else {
        log.error('Write stream error', { error: err, code: err.code });
      }
      if (proc) {
        proc.kill('SIGTERM');
      }
    });

    proc.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        log.debug('FFmpeg stdout EPIPE - write stream may have closed', { code: err.code });
      } else {
        log.error('FFmpeg stdout error', { error: err, code: err.code });
      }
    });

    let totalTimeMillis: number | undefined;
    let loggedDurationWarning = false;
    let previousPercent = -1;
    let actualTranscodeStartPercent: number | undefined; // Fixed starting point for transcode phase

    if (!proc) {
      throw new Error('FFmpeg process not initialized');
    }

    // Capture proc in const for use in promise callbacks
    const ffmpegProc = proc;

    const promiseResult = await new Promise<File>((resolve, reject) => {
      ffmpegProc.on('error', (err) => {
        log.error('FFmpeg spawn error', { error: err });
        reject(err);
      });

      ffmpegProc.on('close', (code, signal) => {
        if (code === 0) {
          log.info('Trim and transcode completed successfully', {
            outputPath: outputFilePath,
            sourceType: audioSource.type,
            usedYtdlpSectionDownload,
            secondaryTrimApplied: secondaryTrimNeeded,
            trimDecision: {
              startTime,
              requestedDuration: duration,
              secondaryTrimDuration: secondaryTrimNeeded ? secondaryTrimDuration : undefined,
              note: secondaryTrimNeeded
                ? 'Applied secondary trim using KNOWN user-specified duration'
                : 'No secondary trim needed',
            },
          });
          if (ytdlp) {
            log.debug('Terminating yt-dlp process');
            ytdlp.kill('SIGTERM');
          }
          resolve(outputFile);
        } else {
          log.error('FFmpeg process failed', { exitCode: code, signal });
          reject(new Error(`FFmpeg process exited with code ${code}`));
        }
      });

      if (!ffmpegProc.stderr) {
        reject(new Error('FFmpeg stderr is null'));
        return;
      }

      ffmpegProc.stderr.on('data', async (data: Buffer) => {
        const stderrLine = data.toString();

        try {
          throwErrorOnSpecificStderr(stderrLine);
        } catch (err) {
          log.error('FFmpeg error detected in stderr', { stderrLine, error: err });
          ffmpegProc.kill('SIGTERM');
          reject(err);
          return;
        }

        // Parse progress and duration
        const progress = parseFFmpegProgress(stderrLine);

        if (progress.duration && !totalTimeMillis) {
          totalTimeMillis = convertStringToMilliseconds(progress.duration);
          log.info('Detected input duration', { duration: progress.duration, milliseconds: totalTimeMillis });
          // Recalculate progress ranges with actual total duration for better accuracy
          const totalDurationSeconds = totalTimeMillis / 1000;
          progressRanges = calculateProgressRanges(startTime, duration, totalDurationSeconds);
          log.info('Recalculated progress ranges with total duration', {
            totalDurationSeconds,
            downloadEndPercent: progressRanges.downloadEndPercent,
            transcodeStartPercent: progressRanges.transcodeStartPercent,
          });
        } else if (progress.time && !totalTimeMillis && !duration && !loggedDurationWarning) {
          // Log once when we start seeing time updates but no duration yet (helps debug pipe input issues)
          loggedDurationWarning = true;
          log.debug('Processing started but duration not yet detected from ffmpeg', {
            time: progress.time,
            note: 'Will use duration parameter if available, otherwise will log time elapsed only',
          });
        }

        if (progress.time) {
          if (cancelToken.isCancellationRequested) {
            log.warn('Cancellation requested, terminating processes');
            ffmpegProc.kill('SIGTERM');
            if (ytdlp) {
              ytdlp.kill('SIGTERM');
            }
            reject(new Error('Trim and Transcode operation was cancelled'));
            return;
          }

          if (!transcodingStarted) {
            transcodingStarted = true;
            // Use the current download progress as the starting point for transcoding
            // This ensures no jump - transcoding continues from where download left off
            // The download progress should have reached at least some value, use that as the starting point
            const initialTranscodePercent =
              maxDownloadProgress >= 0 ? maxDownloadProgress : progressRanges.transcodeStartPercent;
            // Store the fixed starting point for the entire transcode phase
            actualTranscodeStartPercent = initialTranscodePercent;
            log.info('Transcoding started', {
              downloadEndPercent: progressRanges.downloadEndPercent,
              transcodeStartPercent: progressRanges.transcodeStartPercent,
              currentDownloadProgress: maxDownloadProgress,
              initialTranscodePercent,
            });
            realtimeDBRef.set(initialTranscodePercent).catch((err) => {
              log.error('Failed to set initial transcode progress', { error: err });
            });
            previousPercent = initialTranscodePercent; // Start transcode progress tracking at current progress
            await docRef
              .update({
                status: {
                  ...sermonStatus,
                  audioStatus: sermonStatusType.PROCESSING,
                  message: 'Trimming and Transcoding',
                },
              })
              .catch((err) => log.error('Failed to update document status', { error: err }));
          }

          // Calculate progress - use duration parameter as fallback if totalTimeMillis isn't available
          const timeMillis = convertStringToMilliseconds(progress.time);
          let calculatedDuration: number | undefined;

          if (totalTimeMillis) {
            // Use detected duration from ffmpeg
            calculatedDuration = duration
              ? duration * 1000
              : startTime
              ? totalTimeMillis - startTime * 1000
              : totalTimeMillis;
          } else if (duration) {
            // Fallback to duration parameter if ffmpeg hasn't detected duration yet
            calculatedDuration = duration * 1000;
            log.debug('Using duration parameter for progress calculation', {
              duration,
              calculatedDuration,
              timeMillis,
            });
          }

          if (calculatedDuration && calculatedDuration > 0) {
            // Calculate percentage (0-100%) then scale to actualTranscodeStartPercent-98% range for trim/transcode phase
            // This continues from download for continuous progress: 0-100%
            // Use the fixed starting point captured when transcoding began
            const startPercent = actualTranscodeStartPercent ?? progressRanges.transcodeStartPercent;

            const rawPercent = Math.min(100, Math.max(0, (timeMillis / calculatedDuration) * 100));

            // Scale: 0-100% raw -> startPercent-98% final
            // Linear interpolation: startPercent + (rawPercent / 100) * (98 - startPercent)
            const transcodeRange = 98 - startPercent;
            const calculatedPercent = startPercent + (rawPercent / 100) * transcodeRange;
            const percent = Math.round(Math.max(startPercent, Math.min(98, calculatedPercent)));

            if (percent > previousPercent) {
              previousPercent = percent;
              log.debug('Processing progress', {
                percent,
                timeMillis,
                calculatedDuration,
                rawPercent: rawPercent.toFixed(2),
                hasTotalTimeMillis: !!totalTimeMillis,
                transcodeStartPercent: progressRanges.transcodeStartPercent,
                actualStartPercent: startPercent,
              });
              realtimeDBRef.set(percent).catch((err) => {
                log.error('Failed to update progress in realtimeDB', {
                  error: err instanceof Error ? err.message : String(err),
                  percent,
                });
              });
            } else if (percent < previousPercent) {
              log.debug('Skipping backwards progress update', {
                previousPercent,
                newPercent: percent,
                timeMillis,
                rawPercent: rawPercent.toFixed(2),
              });
            }
            // If percent === previousPercent, we don't update DB (avoid redundant writes)
          } else {
            // Log time elapsed even if we can't calculate percentage
            log.debug('Processing (duration unknown)', {
              timeMillis,
              timeElapsed: progress.time,
            });
          }
        }
      });
    });

    if (typeof inputSource === 'string') {
      // Delete raw audio from temp memory
      await logMemoryUsage('Before raw audio delete', ctx);
      log.debug('Deleting raw audio temp file', { file: inputSource });
      await unlink(inputSource);
      tempFiles.delete(inputSource);
      await logMemoryUsage('After raw audio delete', ctx);
    }

    return promiseResult;
  } catch (error) {
    log.error('Trim and transcode failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Cleanup: kill processes if they exist
    if (proc) {
      try {
        log.debug('Terminating FFmpeg process due to error');
        proc.kill('SIGTERM');
      } catch (killError) {
        log.warn('Failed to kill FFmpeg process', { error: killError });
      }
    }
    if (ytdlp) {
      try {
        log.debug('Terminating YouTube download process due to error');
        ytdlp.kill('SIGTERM');
      } catch (killError) {
        log.warn('Failed to kill yt-dlp process', { error: killError });
      }
    }

    // Cleanup: delete temp files
    if (inputSource && typeof inputSource === 'string') {
      try {
        await unlink(inputSource);
        tempFiles.delete(inputSource);
      } catch (unlinkError) {
        log.warn('Failed to delete temporary file during error cleanup', { file: inputSource, error: unlinkError });
      }
    }

    throw error; // Bubble up the error
  } finally {
    await logMemoryUsage('After trim and transcode', ctx);
  }
};

export default trimAndTranscode;
