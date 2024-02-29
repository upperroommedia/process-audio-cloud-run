import express from "express";
import path from "path";
import { PassThrough } from "stream";
import { processYouTubeUrl } from "./processYouTubeUrl";

const app = express();
app.use(express.json());
// get the path to the yt-dlp binary
const ytdlpPath = path.join(__dirname, "../bin", "yt-dlp");
console.log("ytdlpPath", ytdlpPath);
app.get("/", (req, res) => {
  console.log("GET /", "Speed Test Running version 1.0.0");
  res.send(`Speed Test Running version 1.0.0 with ytdlpPath: ${ytdlpPath}`);
});

app.post("/speed-test", async (request, res) => {
  try {
    console.log(request.body);
    if (!request.body?.data?.url) {
      throw new Error("Invalid request, missing url");
    }
    console.log(ytdlpPath);
    const passThrough = new PassThrough();
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const ytdlp = processYouTubeUrl(
      ytdlpPath,
      request.body.data.url,
      passThrough,
      () => {}
    );

    const promiseResult = await new Promise<{ downloadSpeed: string }>(
      (resolve, reject) => {
        let totalBytes = 0;
        let startTime: number | undefined = undefined;
        passThrough
          .on("data", (data) => {
            if (!startTime) {
              startTime = Date.now();
            }
            totalBytes += data.length;
          })
          .on("error", (err) => {
            console.error("Passthrough Error:", err);
            reject(err);
          })
          .on("end", () => {
            console.log("Passthrough Ended");
            const endTime = Date.now();
            const duration = (endTime - (startTime || 0)) / 1000;
            console.log("Duration:", duration);
            const fileSize = totalBytes / 1024 / 1024; // Since we know the size of the file, we can hardcode it
            console.log("File size:", fileSize);
            const downloadSpeed = (fileSize / duration).toFixed(2);

            console.log(`Download speed ${downloadSpeed} Mbps`);
            resolve({ downloadSpeed: `${downloadSpeed} Mbps` });
          });
        ytdlp
          .on("start", async function (commandLine) {
            console.log(
              "Trim And Transcode Spawned Ffmpeg with command: " + commandLine
            );
          })

          .on("error", (err) => {
            console.error("Trim and Transcode Error:", err);
            reject(err);
          })
          .on("stderr", (stderrLine) => {
            console.debug("Ffmpeg stdout:", stderrLine);
          })
          .on("exit", (code) => {
            if (code !== 0) {
              reject("Download failed"); // If the download process exited with an error, throw an error
            }
          });
      }
    );

    res.send(promiseResult);
  } catch (error) {
    console.error("Error measuring download speed:", (error as any).message);
    res.status(500).send({ error: (error as any).message });
  }
});

const port = parseInt(process.env.PORT ?? "") || 8080;
app.listen(port, () => {
  console.log(`Youtube Speed Test: listening on port ${port}`);
});
