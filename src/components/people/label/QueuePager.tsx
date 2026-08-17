import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import React from "react";

interface IProps {
  page: number;
  totalPages: number;
  /** Clusters and unassigned faces matching the current filters. */
  total: number;
  pageSize: number;
  /** Cards actually rendered — grouping means this is usually fewer. */
  groupCount: number;
  disabled?: boolean;
  onPageChange: (page: number) => void;
}

export default function QueuePager({
  page,
  totalPages,
  total,
  pageSize,
  groupCount,
  disabled,
  onPageChange,
}: IProps) {
  if (total === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const go = (next: number) => onPageChange(Math.min(totalPages, Math.max(1, next)));

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {from.toLocaleString()}–{to.toLocaleString()}
        </span>{" "}
        of {total.toLocaleString()} clusters and faces
        <span className="mx-1.5">·</span>
        {groupCount} {groupCount === 1 ? "group" : "groups"} on this page
      </p>

      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={disabled || page <= 1}
          onClick={() => go(1)}
          title="First page"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={disabled || page <= 1}
          onClick={() => go(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2 text-xs tabular-nums">
          Page {page} of {totalPages}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={disabled || page >= totalPages}
          onClick={() => go(page + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={disabled || page >= totalPages}
          onClick={() => go(totalPages)}
          title="Last page"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
