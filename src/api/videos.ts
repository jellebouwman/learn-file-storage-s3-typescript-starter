import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
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

  await cfg.s3Client
    .file(filename, { bucket: cfg.s3Bucket })
    .write(Bun.file(filepath), { type: video.type });

  const newVideo = {
    ...videoMetaData,
    videoURL: `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${filename}`,
  };

  updateVideo(cfg.db, newVideo);

  await Bun.file(filepath).delete();

  return respondWithJSON(200, newVideo);
}
