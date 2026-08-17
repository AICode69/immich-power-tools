import { Autocomplete, AutocompleteOption } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { PERSON_THUBNAIL_PATH } from "@/config/routes";
import { searchPeople } from "@/handlers/api/people.handler";
import { IPerson } from "@/types/person";
import { Users } from "lucide-react";
import React from "react";

interface IProps {
  groupCount: number;
  /** The filename search that produced this page, if any. */
  search?: string;
  onAssignAll: (personId: string, name: string) => void;
  onNameAll: (name: string) => void;
}

/**
 * Assign every group on the page to one person in a single step.
 *
 * The reason this exists is the search box next to it: narrowing the queue to
 * "filenames containing taylor" and then ticking forty cards one at a time is
 * the same decision made forty times. Deciding once and reviewing the result
 * is both faster and easier to check, since the apply bar still reports what
 * is about to happen and Preview still lists the calls.
 */
export default function BulkAssignBar({
  groupCount,
  search,
  onAssignAll,
  onNameAll,
}: IProps) {
  if (groupCount === 0) return null;

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

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed bg-card px-3 py-2">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        {search ? (
          <>
            All {groupCount} {groupCount === 1 ? "group" : "groups"} matching{" "}
            <span className="font-mono font-medium text-foreground">{search}</span>
          </>
        ) : (
          <>
            All {groupCount} {groupCount === 1 ? "group" : "groups"} on this page
          </>
        )}
      </span>

      <div className="min-w-[16rem] flex-1">
        <Autocomplete
          value=""
          placeholder="Assign every group above to…"
          createNewLabel="Name them all"
          loadOptions={loadOptions}
          onOptionSelect={(option) => onAssignAll(option.value, option.label)}
          onCreateNew={(value) => onNameAll(value)}
        />
      </div>

      <span className="text-[11px] text-muted-foreground">
        Sets a decision on each card — nothing is sent until you press Apply.
      </span>
    </div>
  );
}
