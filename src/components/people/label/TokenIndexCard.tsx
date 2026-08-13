import { Button } from "@/components/ui/button";
import { IFaceLabelIndexStatus } from "@/types/faceLabel";
import { formatDistanceToNow } from "date-fns";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import React from "react";

interface IProps {
  status: IFaceLabelIndexStatus | null;
  building: boolean;
  onRebuild: () => void;
}

/**
 * Explains the filename signal and lets the user rebuild it. Without this the
 * feature looks like it is guessing; the counts make the learning visible.
 */
export default function TokenIndexCard({ status, building, onRebuild }: IProps) {
  const describe = () => {
    if (building) return "Reading filenames and folders from your labelled photos…";
    if (!status?.hasIndex) {
      return "Not built yet. Build it to suggest names from filename and folder patterns.";
    }
    const age = status.builtAt
      ? formatDistanceToNow(new Date(status.builtAt), { addSuffix: true })
      : "unknown";
    return `${status.tokensLearned.toLocaleString()} filename patterns learned from ${status.namedPeopleSeen.toLocaleString()} named people across ${status.assetsScanned.toLocaleString()} photos — updated ${age}.`;
  };

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/40 px-4 py-3">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Filename learning</p>
          <p className="text-xs text-muted-foreground">{describe()}</p>
          {status?.isStale && status.hasIndex && !building && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
              Out of date — rebuild to pick up names you have added since.
            </p>
          )}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onRebuild} disabled={building}>
        {building ? (
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
        )}
        {status?.hasIndex ? "Rebuild" : "Build"}
      </Button>
    </div>
  );
}
