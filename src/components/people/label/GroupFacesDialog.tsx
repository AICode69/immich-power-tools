import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Loader from "@/components/ui/loader";
import { GROUP_FACES_PAGE_SIZE } from "@/config/constants/faceLabel.constant";
import { listGroupFaces } from "@/handlers/api/faceLabel.handler";
import { cn } from "@/lib/utils";
import { IFaceLabelGroup, IFaceSample } from "@/types/faceLabel";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import FaceCrop from "./FaceCrop";
import FullPhotoPreview from "./FullPhotoPreview";

interface IProps {
  group: IFaceLabelGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Face ids currently unticked for this group. */
  excludedFaceIds: string[];
  onChange: (excludedFaceIds: string[]) => void;
}

/**
 * Review every face in a group and untick the ones that are somebody else.
 *
 * Face clustering is never perfect, and a large cluster almost always carries
 * a handful of strangers. Without this the only honest options are to accept
 * a group wholesale or reject it wholesale — so a 539-face cluster with four
 * bad faces had to be abandoned entirely.
 *
 * Exclusions are held per page-load rather than written anywhere: they travel
 * with the decision and are consumed by the apply call.
 */
export default function GroupFacesDialog({
  group,
  open,
  onOpenChange,
  excludedFaceIds,
  onChange,
}: IProps) {
  const [faces, setFaces] = useState<IFaceSample[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewFace, setPreviewFace] = useState<IFaceSample | null>(null);

  const excluded = new Set(excludedFaceIds);
  const totalPages = Math.max(1, Math.ceil(total / GROUP_FACES_PAGE_SIZE));

  const fetchFaces = useCallback(() => {
    setLoading(true);
    setErrorMessage(null);
    listGroupFaces({
      clusterIds: group.clusterIds.length ? group.clusterIds : undefined,
      faceIds: group.faceIds.length ? group.faceIds : undefined,
      page,
    })
      .then((response) => {
        setFaces(response.faces);
        setTotal(response.total);
      })
      .catch((error) => setErrorMessage(error.message))
      .finally(() => setLoading(false));
  }, [group.clusterIds, group.faceIds, page]);

  // Reset on close rather than on open: resetting on open would fetch the
  // stale page first and then page 1, two requests for one dialog.
  useEffect(() => {
    if (!open) {
      setPage(1);
      setPreviewFace(null);
    }
  }, [open]);

  useEffect(() => {
    if (open) fetchFaces();
  }, [open, fetchFaces]);

  const toggle = (faceId: string) => {
    const next = new Set(excluded);
    if (next.has(faceId)) next.delete(faceId);
    else next.add(faceId);
    onChange(Array.from(next));
  };

  const setAllOnPage = (keep: boolean) => {
    const next = new Set(excluded);
    for (const face of faces) {
      if (keep) next.delete(face.faceId);
      else next.add(face.faceId);
    }
    onChange(Array.from(next));
  };

  const keptOnPage = faces.filter((face) => !excluded.has(face.faceId)).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Review {total.toLocaleString()} faces</DialogTitle>
          <DialogDescription>
            Untick anyone who is not this person. Unticked faces are left out of
            the name or merge — for a cluster they are moved to a new unnamed
            group so they come back around for labelling.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-y py-2">
          <span className="text-sm font-medium">
            {excludedFaceIds.length > 0
              ? `${excludedFaceIds.length.toLocaleString()} excluded`
              : "All faces kept"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setAllOnPage(true)}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Keep page
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAllOnPage(false)}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              Exclude page
            </Button>
            {excludedFaceIds.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => onChange([])}>
                Reset
              </Button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <Loader />
          ) : errorMessage ? (
            <p className="p-4 text-sm text-destructive">{errorMessage}</p>
          ) : (
            <>
              {previewFace && (
                <div className="mb-3">
                  <FullPhotoPreview face={previewFace} />
                </div>
              )}
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                {faces.map((face) => {
                  const isExcluded = excluded.has(face.faceId);
                  return (
                    <div key={face.faceId} className="relative">
                      <FaceCrop
                        face={face}
                        title={face.fileName || "Toggle this face"}
                        selected={previewFace?.faceId === face.faceId}
                        className={cn(isExcluded && "opacity-30 grayscale")}
                        onClick={() => toggle(face.faceId)}
                      />
                      {/* Separate hit target so a user can inspect the whole
                          photo without changing their selection. */}
                      <button
                        type="button"
                        title="Show the full photo"
                        onClick={() =>
                          setPreviewFace(
                            previewFace?.faceId === face.faceId ? null : face
                          )
                        }
                        className="absolute bottom-0.5 right-0.5 rounded bg-background/80 px-1 text-[10px] backdrop-blur-sm hover:bg-background"
                      >
                        view
                      </button>
                      {isExcluded && (
                        <span className="pointer-events-none absolute left-0.5 top-0.5 rounded-full bg-destructive p-0.5 text-destructive-foreground">
                          <X className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {keptOnPage} of {faces.length} kept on this page
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
