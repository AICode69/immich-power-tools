import { Autocomplete, AutocompleteOption } from "@/components/ui/autocomplete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PERSON_THUBNAIL_PATH } from "@/config/routes";
import { searchPeople } from "@/handlers/api/people.handler";
import { cn } from "@/lib/utils";
import { IFaceLabelGroup, IFaceLabelSuggestion } from "@/types/faceLabel";
import { IPerson } from "@/types/person";
import { EyeOff, Images, ListFilter, ScanFace, SkipForward, Users } from "lucide-react";
import React, { useState } from "react";
import FaceCrop from "./FaceCrop";
import FullPhotoPreview from "./FullPhotoPreview";
import GroupFacesDialog from "./GroupFacesDialog";
import SuggestionChips from "./SuggestionChips";

export interface IClusterDecision {
  action: "name" | "merge" | "hide" | "skip";
  name?: string;
  targetPersonId?: string;
}

interface IProps {
  group: IFaceLabelGroup;
  decision?: IClusterDecision;
  focused?: boolean;
  /** Faces unticked in the review dialog, held by the board. */
  excludedFaceIds?: string[];
  onExcludedChange: (faceIds: string[]) => void;
  onChange: (decision: IClusterDecision | undefined) => void;
  onFocus: () => void;
}

export default function ClusterCard({
  group,
  decision,
  focused,
  excludedFaceIds = [],
  onExcludedChange,
  onChange,
  onFocus,
}: IProps) {
  const [activeFaceIndex, setActiveFaceIndex] = useState(0);
  const [showPhoto, setShowPhoto] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);

  const activeFace = group.sampleFaces[activeFaceIndex] ?? group.sampleFaces[0];
  const keptCount = group.faceCount - excludedFaceIds.length;

  const handleSuggestion = (suggestion: IFaceLabelSuggestion) => {
    if (
      decision?.action === "merge" &&
      decision.targetPersonId === suggestion.personId
    ) {
      onChange(undefined);
      return;
    }
    // Picking an existing person means merging into them, which keeps their
    // birthday and thumbnail rather than creating a second record.
    onChange({
      action: "merge",
      targetPersonId: suggestion.personId,
      name: suggestion.name,
    });
  };

  const loadOptions = async (value: string): Promise<AutocompleteOption[]> => {
    if (!value.trim()) return [];
    const people: IPerson[] = await searchPeople(value);
    return people
      .filter((p) => p.name)
      .map((p) => ({
        label: p.name,
        value: p.id,
        imageUrl: PERSON_THUBNAIL_PATH(p.id),
      }));
  };

  const decisionLabel = () => {
    if (!decision) return null;
    if (decision.action === "hide") return "Will be hidden";
    if (decision.action === "skip") return "Skipped";
    if (decision.action === "merge") {
      return group.kind === "faces"
        ? `Assign to ${decision.name}`
        : `Merge into ${decision.name}`;
    }
    return `Name "${decision.name}"`;
  };

  return (
    <div
      onFocus={onFocus}
      onMouseEnter={onFocus}
      tabIndex={0}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-3 transition",
        focused && "ring-2 ring-primary/50",
        decision?.action === "skip" && "opacity-50",
        decision?.action === "hide" && "opacity-60 grayscale"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setReviewOpen(true)}
            title="Review every face in this group and untick anyone who is not this person"
            className="flex items-center gap-1 rounded px-1 -mx-1 hover:bg-accent hover:text-accent-foreground"
          >
            <Images className="h-3.5 w-3.5" />
            {excludedFaceIds.length > 0 ? (
              <span className="font-medium text-primary">
                {keptCount} of {group.faceCount} faces
              </span>
            ) : (
              <span>
                {group.faceCount} {group.faceCount === 1 ? "face" : "faces"}
              </span>
            )}
            <ListFilter className="h-3 w-3 opacity-60" />
          </button>
          {group.kind === "faces" ? (
            <Badge variant="outline" className="gap-1" title="Immich never grouped these into a person">
              <ScanFace className="h-3 w-3" />
              unassigned
            </Badge>
          ) : (
            group.clusterIds.length > 1 && (
              <Badge variant="secondary" className="gap-1">
                <Users className="h-3 w-3" />
                {group.clusterIds.length} clusters
              </Badge>
            )
          )}
        </div>
        <div className="flex items-center gap-1">
          {group.kind === "cluster" && (
            <Button
              size="sm"
              variant={decision?.action === "hide" ? "default" : "ghost"}
              className="h-7 px-2"
              title="Not a real person — hide it in Immich"
              onClick={() =>
                onChange(decision?.action === "hide" ? undefined : { action: "hide" })
              }
            >
              <EyeOff className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant={decision?.action === "skip" ? "default" : "ghost"}
            className="h-7 px-2"
            title="Skip — don't show this again"
            onClick={() =>
              onChange(decision?.action === "skip" ? undefined : { action: "skip" })
            }
          >
            <SkipForward className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Face crops: click one to see the whole photo it came from. */}
      <div className="grid grid-cols-6 gap-1">
        {group.sampleFaces.map((face, index) => (
          <FaceCrop
            key={face.faceId}
            face={face}
            selected={index === activeFaceIndex && showPhoto}
            title={face.fileName || "Show the full photo"}
            onClick={() => {
              setActiveFaceIndex(index);
              setShowPhoto(index !== activeFaceIndex ? true : !showPhoto);
            }}
          />
        ))}
      </div>

      {/* The filename is what a filename-based suggestion is built on, so it
          is worth showing rather than making the user open the photo. */}
      {activeFace?.fileName && (
        <p
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={activeFace.fileName}
        >
          {activeFace.fileName}
        </p>
      )}

      {showPhoto && activeFace && <FullPhotoPreview face={activeFace} />}

      <SuggestionChips
        suggestions={group.suggestions}
        selectedPersonId={
          decision?.action === "merge" ? decision.targetPersonId : undefined
        }
        onSelect={handleSuggestion}
        showShortcuts={focused}
      />

      <Autocomplete
        value=""
        initialValue={inputValue}
        placeholder="Type a name…"
        createNewLabel="Name as"
        loadOptions={loadOptions}
        onChange={(e) => setInputValue(e.target.value)}
        onOptionSelect={(option) => {
          setInputValue(option.label);
          onChange({
            action: "merge",
            targetPersonId: option.value,
            name: option.label,
          });
        }}
        onCreateNew={(value) => {
          setInputValue(value);
          onChange({ action: "name", name: value });
        }}
      />

      {decision && (
        <p className="text-xs font-medium text-primary">
          {decisionLabel()}
          {excludedFaceIds.length > 0 && (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {excludedFaceIds.length} face(s) left out
            </span>
          )}
        </p>
      )}

      <GroupFacesDialog
        group={group}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        excludedFaceIds={excludedFaceIds}
        onChange={onExcludedChange}
      />
    </div>
  );
}
