import { ASSET_PREVIEW_PATH } from "@/config/routes";
import { cn } from "@/lib/utils";
import { IFaceSample } from "@/types/faceLabel";
import React, { useMemo } from "react";

interface IProps {
  face: IFaceSample;
  className?: string;
  /** Extra room around the detected box, as a fraction of its size. */
  padding?: number;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
}

/**
 * Shows just the face, cropped out of the asset preview with CSS.
 *
 * Immich gives us a bounding box in the coordinate space the detector ran on
 * (`imageWidth`/`imageHeight`), not the preview's pixel size — so everything is
 * normalised to fractions first and the browser does the scaling. No server-side
 * image work, and the preview is already cached by the thumbnail proxy.
 */
export default function FaceCrop({
  face,
  className,
  padding = 0.4,
  selected,
  onClick,
  title,
}: IProps) {
  const style = useMemo<React.CSSProperties>(() => {
    const { boundingBox, imageWidth, imageHeight } = face;
    if (!imageWidth || !imageHeight) {
      return { backgroundImage: `url(${ASSET_PREVIEW_PATH(face.assetId)})` };
    }

    const boxWidth = (boundingBox.x2 - boundingBox.x1) / imageWidth;
    const boxHeight = (boundingBox.y2 - boundingBox.y1) / imageHeight;
    const centreX = (boundingBox.x1 + boundingBox.x2) / 2 / imageWidth;
    const centreY = (boundingBox.y1 + boundingBox.y2) / 2 / imageHeight;

    // Square crop around the face so portrait and landscape faces look alike.
    const size = Math.min(1, Math.max(boxWidth, boxHeight) * (1 + padding));
    const zoom = size > 0 ? 1 / size : 1;

    // background-position is a percentage of the *overflow*, so a face dead
    // centre needs 50% and one at the edge needs 0% or 100%.
    const positionX = size >= 1 ? 50 : (Math.min(Math.max(centreX - size / 2, 0), 1 - size) / (1 - size)) * 100;
    const positionY = size >= 1 ? 50 : (Math.min(Math.max(centreY - size / 2, 0), 1 - size) / (1 - size)) * 100;

    return {
      backgroundImage: `url(${ASSET_PREVIEW_PATH(face.assetId)})`,
      backgroundSize: `${zoom * 100}% ${zoom * 100}%`,
      backgroundPosition: `${positionX}% ${positionY}%`,
      backgroundRepeat: "no-repeat",
    };
  }, [face, padding]);

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "relative aspect-square w-full overflow-hidden rounded-md bg-muted bg-cover transition",
        onClick && "cursor-pointer hover:opacity-90",
        selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
        className
      )}
      style={style}
    />
  );
}
