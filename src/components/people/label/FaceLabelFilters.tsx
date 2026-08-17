import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FaceLabelScope, IFaceLabelQueueFilters } from "@/types/faceLabel";
import { SlidersHorizontal } from "lucide-react";
import React from "react";

interface IProps {
  filters: IFaceLabelQueueFilters;
  onChange: (filters: Partial<IFaceLabelQueueFilters>) => void;
  disabled?: boolean;
}

export default function FaceLabelFilters({ filters, onChange, disabled }: IProps) {
  const field = (
    key: keyof IFaceLabelQueueFilters,
    label: string,
    hint: string,
    step: number,
    min: number,
    max: number
  ) => (
    <div className="space-y-1">
      <Label htmlFor={key} className="text-xs">
        {label}
      </Label>
      <Input
        id={key}
        type="number"
        step={step}
        min={min}
        max={max}
        value={filters[key] ?? ""}
        onChange={(e) => onChange({ [key]: Number(e.target.value) })}
        className="h-8"
      />
      <p className="text-[11px] leading-tight text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
          Tuning
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="end">
        <div className="space-y-1">
          <Label className="text-xs">What to review</Label>
          <Select
            value={filters.scope ?? "both"}
            onValueChange={(value) => onChange({ scope: value as FaceLabelScope })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Everything</SelectItem>
              <SelectItem value="unassigned">Unassigned faces only</SelectItem>
              <SelectItem value="clusters">Unnamed clusters only</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-tight text-muted-foreground">
            Unassigned faces are the ones Immich never grouped into a person — it only
            forms a group at 3+ similar faces, so everything below that is invisible in
            Immich&apos;s own people view.
          </p>
        </div>
        {field(
          "pageSize",
          "Page size",
          "Clusters and faces scanned per page. Grouping only happens within a page, so a bigger page groups better but loads slower.",
          10,
          1,
          300
        )}
        {field(
          "minFaceCount",
          "Minimum faces",
          "Skip tiny clusters. Does not apply to unassigned faces — those are always single faces.",
          1,
          1,
          50
        )}
        {field(
          "similarityThreshold",
          "Suggestion threshold",
          "How alike a known face must be before it is suggested.",
          0.05,
          0,
          1
        )}
        {field(
          "groupThreshold",
          "Grouping threshold",
          "How alike two unnamed clusters must be to be treated as one person. Raise it if unrelated people are being grouped.",
          0.05,
          0,
          1
        )}
      </PopoverContent>
    </Popover>
  );
}
