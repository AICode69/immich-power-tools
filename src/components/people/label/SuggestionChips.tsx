import { Badge } from "@/components/ui/badge";
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PERSON_THUBNAIL_PATH } from "@/config/routes";
import { cn } from "@/lib/utils";
import { IFaceLabelSuggestion } from "@/types/faceLabel";
import { AlertTriangle } from "lucide-react";
import React from "react";

interface IProps {
  suggestions: IFaceLabelSuggestion[];
  selectedPersonId?: string;
  onSelect: (suggestion: IFaceLabelSuggestion) => void;
  /** Shows 1-9 hints when this card has keyboard focus. */
  showShortcuts?: boolean;
}

const confidenceTone = (confidence: number) => {
  if (confidence >= 0.8) return "border-emerald-500/60 bg-emerald-500/10";
  if (confidence >= 0.6) return "border-amber-500/60 bg-amber-500/10";
  return "border-muted-foreground/30";
};

export default function SuggestionChips({
  suggestions,
  selectedPersonId,
  onSelect,
  showShortcuts,
}: IProps) {
  if (suggestions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No suggestion — type a name below.
      </p>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((suggestion, index) => {
          const selected = selectedPersonId === suggestion.personId;
          return (
            <TooltipRoot key={suggestion.personId}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(suggestion)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition hover:bg-accent",
                    confidenceTone(suggestion.confidence),
                    selected && "ring-2 ring-primary"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={PERSON_THUBNAIL_PATH(suggestion.personId)}
                    alt=""
                    className="h-5 w-5 rounded-full object-cover"
                    loading="lazy"
                  />
                  <span className="max-w-[10rem] truncate font-medium">
                    {suggestion.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round(suggestion.confidence * 100)}%
                  </span>
                  {suggestion.signals.sharedAssets > 0 && (
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                  )}
                  {showShortcuts && index < 9 && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      {index + 1}
                    </Badge>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="mb-1 font-medium">Why {suggestion.name}?</p>
                {suggestion.evidence.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-4 text-xs">
                    {suggestion.evidence.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs">Face similarity only.</p>
                )}
              </TooltipContent>
            </TooltipRoot>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
