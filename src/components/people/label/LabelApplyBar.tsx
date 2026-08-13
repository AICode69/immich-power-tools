import FloatingBar from "@/components/shared/FloatingBar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import React from "react";

interface IProps {
  namedCount: number;
  hideCount: number;
  skipCount: number;
  mergeCount: number;
  mergeGroups: boolean;
  applying: boolean;
  onMergeGroupsChange: (value: boolean) => void;
  onPreview: () => void;
  onApply: () => void;
  onClear: () => void;
}

export default function LabelApplyBar({
  namedCount,
  hideCount,
  skipCount,
  mergeCount,
  mergeGroups,
  applying,
  onMergeGroupsChange,
  onPreview,
  onApply,
  onClear,
}: IProps) {
  const total = namedCount + hideCount + skipCount + mergeCount;
  if (total === 0) return null;

  const parts = [
    namedCount > 0 ? `${namedCount} to name` : null,
    mergeCount > 0 ? `${mergeCount} to merge` : null,
    hideCount > 0 ? `${hideCount} to hide` : null,
    skipCount > 0 ? `${skipCount} to skip` : null,
  ].filter(Boolean);

  return (
    <FloatingBar className="max-w-4xl px-4">
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm font-medium">{parts.join(" · ")}</span>

        <div className="flex items-center gap-2">
          <Checkbox
            id="merge-groups"
            checked={mergeGroups}
            onCheckedChange={(value) => onMergeGroupsChange(Boolean(value))}
          />
          <Label htmlFor="merge-groups" className="text-xs font-normal">
            Also merge grouped clusters
            <span className="ml-1 text-muted-foreground">(cannot be undone)</span>
          </Label>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClear} disabled={applying}>
            Clear
          </Button>
          <Button size="sm" variant="outline" onClick={onPreview} disabled={applying}>
            Preview
          </Button>
          <Button size="sm" onClick={onApply} disabled={applying}>
            {applying && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Apply
          </Button>
        </div>
      </div>
    </FloatingBar>
  );
}
