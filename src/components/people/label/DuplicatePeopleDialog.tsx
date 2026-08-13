import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import Loader from "@/components/ui/loader";
import { PERSON_THUBNAIL_PATH } from "@/config/routes";
import {
  listDuplicatePeople,
  mergeDuplicatePeople,
} from "@/handlers/api/faceLabel.handler";
import { IDuplicatePersonGroup } from "@/types/faceLabel";
import { Copy, Loader2 } from "lucide-react";
import React, { useState } from "react";
import toast from "react-hot-toast";

export default function DuplicatePeopleDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<IDuplicatePersonGroup[]>([]);
  const [merging, setMerging] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchGroups = () => {
    setLoading(true);
    setErrorMessage(null);
    listDuplicatePeople()
      .then((response) => setGroups(response.groups))
      .catch((error) => setErrorMessage(error.message))
      .finally(() => setLoading(false));
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) fetchGroups();
  };

  const handleMerge = async (group: IDuplicatePersonGroup) => {
    setMerging(group.key);
    try {
      await mergeDuplicatePeople(
        group.primary.id,
        group.duplicates.map((d) => d.id)
      );
      setGroups((prev) => prev.filter((g) => g.key !== group.key));
      toast.success(`Merged ${group.duplicates.length + 1} records`);
    } catch (error: any) {
      toast.error(error.message ?? "Merge failed");
    } finally {
      setMerging(null);
    }
  };

  const renderContent = () => {
    if (loading) return <Loader />;
    if (errorMessage) {
      return <p className="py-6 text-sm text-destructive">{errorMessage}</p>;
    }
    if (groups.length === 0) {
      return (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No duplicate names found.
        </p>
      );
    }

    return (
      <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
        {groups.map((group) => (
          <div
            key={group.key}
            className="flex items-center justify-between gap-3 rounded-md border p-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              {[group.primary, ...group.duplicates].map((personRecord) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={personRecord.id}
                  src={PERSON_THUBNAIL_PATH(personRecord.id)}
                  alt=""
                  title={`${personRecord.name} — ${personRecord.faceCount} faces`}
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                  loading="lazy"
                />
              ))}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{group.primary.name}</p>
                <p className="text-xs text-muted-foreground">
                  {group.duplicates.length + 1} records · {group.totalFaces} faces
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={merging === group.key}
              onClick={() => handleMerge(group)}
            >
              {merging === group.key && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              Merge
            </Button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Copy className="mr-2 h-3.5 w-3.5" />
          Duplicates
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Duplicate people</DialogTitle>
          <DialogDescription>
            People whose names match once case and punctuation are ignored. The
            record with the most faces is kept. Merging cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {renderContent()}
      </DialogContent>
    </Dialog>
  );
}
