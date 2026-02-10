import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");

  if (thumbnail instanceof File === false) {
    throw new BadRequestError("Thumbnail is not a file");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail is too large");
  }

  const mediaType = thumbnail.type;

  const imageArrayBuffer = await thumbnail.arrayBuffer();
  const imageBuffer = Buffer.from(imageArrayBuffer);
  const imageString = imageBuffer.toString("base64");
  const videoMetaData = getVideo(cfg.db, videoId);
  const dataURL = `data:${mediaType};base64,${imageString}`;

  if (videoMetaData?.userID !== userID) {
    throw new UserForbiddenError("Video does not belong to this user");
  }

  const newVideo = { ...videoMetaData, thumbnailURL: dataURL };

  updateVideo(cfg.db, newVideo);

  return respondWithJSON(200, newVideo);
}
