import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import path from "path";
import { randomBytes } from "crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const formData = await req.formData();
  const video = formData.get("video");

  if (video instanceof File === false) {
    throw new BadRequestError("Video is not a file");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;

  if (video.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video is too large");
  }

  const videoMetaData = getVideo(cfg.db, videoId);

  if (!videoMetaData) {
    throw new NotFoundError("Video does not exist");
  }

  if (videoMetaData.userID !== userID) {
    throw new UserForbiddenError("Video does not belong to this user");
  }

  if (video.type !== "video/mp4") {
    throw new BadRequestError("Incorrect mime type, only accepting video/mp4");
  }

  const videoArrayBuffer = await video.arrayBuffer();
  const videoBuffer = Buffer.from(videoArrayBuffer);
  const mimeType = video.type;
  const [_mimeGroup, fileExtension] = mimeType.split("/");

  const filename = `${randomBytes(32).toString("hex")}.${fileExtension}`;
  const filepath = path.join("/tmp", filename);

  await Bun.write(filepath, videoBuffer);

  const videoOrientation = await getVideoOrientation(filepath);

  const processedFilePath = await processVideoForFastStart(filepath);

  await cfg.s3Client
    .file(`${videoOrientation}/${filename}`, { bucket: cfg.s3Bucket })
    .write(Bun.file(processedFilePath), { type: video.type });

  const newVideo = {
    ...videoMetaData,
    // videoURL: `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoOrientation}/${filename}`,
    videoURL: `${videoOrientation}/${filename}`,
  };

  updateVideo(cfg.db, newVideo);

  await Bun.file(filepath).delete();
  await Bun.file(processedFilePath).delete();

  return respondWithJSON(200, dbVideoToSignedVideo(cfg, newVideo));
}

type VideoOrientation = "landscape" | "portrait" | "other";
const FFPROBE_COMMAND = [
  "ffprobe",
  "-v",
  "error",
  "-print_format",
  "json",
  "-show_streams",
];

async function getVideoOrientation(
  filepath: string,
): Promise<VideoOrientation> {
  const proc = Bun.spawn([...FFPROBE_COMMAND, filepath], {
    stderr: "pipe",
    stdout: "pipe",
  });

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  const exited = await proc.exited;

  if (exited !== 0) {
    throw new Error(stderrText);
  }

  const probeData = JSON.parse(stdoutText);
  const firstStream = probeData?.streams?.[0];

  if (firstStream === undefined) {
    throw new Error(`Stream is not defined: ${JSON.stringify(probeData)}`);
  }

  const { width, height } = firstStream;

  if (typeof width !== "number") {
    throw new Error(`Width is not a number but: ${typeof width}`);
  }
  if (typeof height !== "number") {
    throw new Error(`Height is not a number but: ${typeof height}`);
  }

  return getVideoOrientationFromDimensions(width, height);
}

function getVideoOrientationFromDimensions(
  width: number,
  height: number,
): VideoOrientation {
  const ratio = width / height;
  const tolerance = 0.05;

  if (Math.abs(ratio - 16 / 9) <= tolerance) {
    return "landscape";
  } else if (Math.abs(ratio - 9 / 16) <= tolerance) {
    return "portrait";
  }
  return "other";
}

async function processVideoForFastStart(
  inputFilePath: string,
): Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    {
      stderr: "pipe",
    },
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errMsg = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed: ${errMsg}`);
  }

  return outputFilePath;
}

function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  return cfg.s3Client.presign(key, { expiresIn: expireTime });
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video): Video {
  if (!video.videoURL) {
    return video;
  }
  console.log({ video });
  const presignedUrl = generatePresignedURL(cfg, video.videoURL, 10000);

  return { ...video, videoURL: presignedUrl };
}
