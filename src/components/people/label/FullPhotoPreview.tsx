import { ASSET_PREVIEW_PATH } from "@/config/routes";
import { useConfig } from "@/contexts/ConfigContext";
import { IFaceSample } from "@/types/faceLabel";
import { ExternalLink } from "lucide-react";
import React from "react";

interface IProps {
  face: IFaceSample;
}

/**
 * The whole photo with the face outlined.
 *
 * A cropped face is often not enough to recognise somebody — context (who they
 * are standing with, where, when) is what settles it. The outline is positioned
 * in percentages so it tracks the image at any size.
 */
export default function FullPhotoPreview({ face }: IProps) {
  const { exImmichUrl } = useConfig();

  const { boundingBox, imageWidth, imageHeight } = face;
  const hasBox = Boolean(imageWidth && imageHeight);

  const box = hasBox
    ? {
        left: `${(boundingBox.x1 / imageWidth) * 100}%`,
        top: `${(boundingBox.y1 / imageHeight) * 100}%`,
        width: `${((boundingBox.x2 - boundingBox.x1) / imageWidth) * 100}%`,
        height: `${((boundingBox.y2 - boundingBox.y1) / imageHeight) * 100}%`,
      }
    : null;

  return (
    <div className="relative w-full overflow-hidden rounded-md bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={ASSET_PREVIEW_PATH(face.assetId)}
        alt="Photo containing the face being labelled"
        className="h-auto max-h-[420px] w-full object-contain"
        loading="lazy"
      />
      {box && (
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
          style={box}
        />
      )}
      {exImmichUrl && (
        <a
          href={`${exImmichUrl}/photos/${face.assetId}`}
          target="_blank"
          rel="noreferrer"
          className="absolute right-2 top-2 flex items-center gap-1 rounded bg-background/80 px-2 py-1 text-xs backdrop-blur-sm hover:bg-background"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </a>
      )}
    </div>
  );
}
