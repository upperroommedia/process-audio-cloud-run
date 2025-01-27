import { CancelToken } from "./CancelToken";
import { Bucket, File } from "@google-cloud/storage";
import { Reference } from "firebase-admin/database";
import { convertStringToMilliseconds, createTempFile, logMemoryUsage, throwErrorOnSpecificStderr } from "./utils";
import { CustomMetadata, AudioSource } from "./types";
import { processYouTubeUrl } from "./processYouTubeUrl";
import { unlink } from "fs/promises";
import { PassThrough, Readable } from "stream";
import { ChildProcessWithoutNullStreams } from "child_process";
import { sermonStatus, sermonStatusType } from "./types";

const trimAndTranscode = async (
  ffmpeg: typeof import("fluent-ffmpeg"),
  ytdlpPath: string,
  cancelToken: CancelToken,
  bucket: Bucket,
  audioSource: AudioSource,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  docRef: FirebaseFirestore.DocumentReference,
  sermonStatus: sermonStatus,
  customMetadata: CustomMetadata,
  startTime?: number,
  duration?: number
): Promise<File> => {
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: "audio/mpeg",
    metadata: { contentDisposition, metadata: customMetadata },
    timeout: 30 * 60 * 1000, // 30 minutes in milliseconds
  });
  let inputSource: string | Readable | undefined;
  let ytdlp: ChildProcessWithoutNullStreams | undefined;
  let transcodingStarted = false;
  const updateDownloadProgress = (progress: number) => {
    if (!transcodingStarted) {
      console.log("Youtube Download progress (while transcoding has not yet started):", progress);
      realtimeDBRef.set(progress);
    } else {
      console.log("Youtube Download progress:", progress);
    }
  };
  try {
    if (audioSource.type === "YouTubeUrl") {
      // Process the audio source from YouTube
      const passThrough = new PassThrough();
      ytdlp = processYouTubeUrl(ytdlpPath, audioSource.source, cancelToken, passThrough, updateDownloadProgress);
      inputSource = passThrough;
    } else {
      // Process the audio source from storage
      const rawSourceFile = createTempFile(`raw-${audioSource.id}`, tempFiles);
      console.log("Downloading raw audio source to", rawSourceFile);
      await bucket.file(audioSource.source).download({ destination: rawSourceFile });
      console.log("Successfully downloaded raw audio source");
      inputSource = rawSourceFile;
    }

    // Download the raw audio source from storage

    const proc = ffmpeg().format("mp3").input(inputSource);
    if (startTime) proc.setStartTime(startTime);
    if (duration) proc.setDuration(duration);

    proc
      .audioCodec("libmp3lame")
      .audioFilters(["dynaudnorm=g=21:m=40:c=1:b=1", "afftdn", "pan=stereo|c0<c0+c1|c1<c0+c1"]) // Dynamiaclly adjust volume and remove background noise and balance left right audio
      .audioBitrate(128)
      .audioChannels(2)
      .audioFrequency(44100);

    let totalTimeMillis: number;
    let previousPercent = -1;
    const promiseResult = await new Promise<File>((resolve, reject) => {
      proc
        .on("start", async function (commandLine) {
          console.log("Trim And Transcode Spawned Ffmpeg with command: " + commandLine);
        })
        .on("end", async () => {
          console.log("Finished Trim and Transcode");
          if (ytdlp) {
            console.log("Killing ytdlp process");
            ytdlp.kill("SIGTERM"); // this sends a termination signal to the process
          }
          resolve(outputFile);
        })
        .on("error", (err) => {
          console.error("Trim and Transcode Error:", err);
          reject(err);
        })
        .on("codecData", (data) => {
          // HERE YOU GET THE TOTAL TIME
          console.log("Total duration: " + data.duration);
          totalTimeMillis = convertStringToMilliseconds(data.duration);
        })
        .on("stderr", (stderrLine) => {
          console.debug("Ffmpeg stdout:", stderrLine);
          try {
            throwErrorOnSpecificStderr(stderrLine);
          } catch (err) {
            reject(err);
          }
        })
        .on("progress", async (progress) => {
          if (cancelToken.isCancellationRequested) {
            console.log("Cancellation requested, killing ffmpeg process");
            proc.kill("SIGTERM"); // this sends a termination signal to the process
            if (ytdlp) {
              console.log("Killing ytdlp process");
              ytdlp.kill("SIGTERM"); // this sends a termination signal to the process
            }
            reject(new Error("Trim and Transcode operation was cancelled"));
          }
          if (!transcodingStarted) {
            transcodingStarted = true;
            await docRef.update({
              status: {
                ...sermonStatus,
                audioStatus: sermonStatusType.PROCESSING,
                message: "Trimming and Transcoding",
              },
            });
          }
          const timeMillis = convertStringToMilliseconds(progress.timemark);
          const calculatedDuration = duration
            ? duration * 1000
            : startTime
            ? totalTimeMillis - startTime * 1000
            : totalTimeMillis;
          const percent = Math.round(Math.max(0, ((timeMillis * 0.95) / calculatedDuration) * 100)); // go to 95% to leave room for the time it takes to Merge the files
          if (percent !== previousPercent) {
            previousPercent = percent;
            console.log("Trim and Transcode Progress:", percent);
            realtimeDBRef.set(percent);
          }
        })
        .pipe(writeStream);
    });
    if (typeof inputSource === "string") {
      // Delete raw audio from temp memory
      await logMemoryUsage("Before raw audio delete memory:");
      console.log("Deleting raw audio temp file:", inputSource);
      await unlink(inputSource);
      tempFiles.delete(inputSource);
      console.log("Successfully deleted raw audio temp file:", inputSource);
      await logMemoryUsage("After raw audio delete memory:");
    }

    return promiseResult;
  } catch (error) {
    console.error("Error in trimAndTranscode:", error);

    // Add additional cleanup logic if needed
    if (inputSource && typeof inputSource === "string") {
      console.log("Attempting to delete temporary file:", inputSource);
      try {
        await unlink(inputSource);
        tempFiles.delete(inputSource);
      } catch (unlinkError) {
        console.error("Failed to delete temporary file:", unlinkError);
      }
    }

    if (ytdlp) {
      console.log("Attempting to terminate YouTube download process");
      ytdlp.kill("SIGTERM");
    }

    throw error; // Bubble up the error
  } finally {
    console.log("Cleaning up resources after trimAndTranscode");
    await logMemoryUsage("After processing");
  }
};

export default trimAndTranscode;
