import PageLayout from "@/components/layouts/PageLayout";
import Header from "@/components/shared/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Loader from "@/components/ui/loader";
import {
  DEFAULT_GROUP_THRESHOLD,
  DEFAULT_MIN_FACE_COUNT,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SIMILARITY_THRESHOLD,
} from "@/config/constants/faceLabel.constant";
import {
  applyFaceLabels,
  getTokenIndexStatus,
  listFaceLabelQueue,
  rebuildTokenIndex,
} from "@/handlers/api/faceLabel.handler";
import {
  IFaceLabelApplyItem,
  IFaceLabelGroup,
  IFaceLabelIndexStatus,
  IFaceLabelQueueFilters,
} from "@/types/faceLabel";
import { PartyPopper, ScanFace, Search, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import BulkAssignBar from "./BulkAssignBar";
import ClusterCard, { IClusterDecision } from "./ClusterCard";
import DuplicatePeopleDialog from "./DuplicatePeopleDialog";
import FaceLabelFilters from "./FaceLabelFilters";
import LabelApplyBar from "./LabelApplyBar";
import QueuePager from "./QueuePager";
import TokenIndexCard from "./TokenIndexCard";

/** How long to wait after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 400;

export default function FaceLabelBoard() {
  const [groups, setGroups] = useState<IFaceLabelGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, IClusterDecision>>({});
  /** Group id -> faces the user unticked in the review dialog. */
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [mergeGroups, setMergeGroups] = useState(false);
  const [indexStatus, setIndexStatus] = useState<IFaceLabelIndexStatus | null>(null);
  const [buildingIndex, setBuildingIndex] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [pageInfo, setPageInfo] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [queueCounts, setQueueCounts] = useState<{
    clusters: number;
    unassigned: number;
  } | null>(null);
  const [filters, setFilters] = useState<IFaceLabelQueueFilters>({
    scope: "both",
    pageSize: DEFAULT_PAGE_SIZE,
    minFaceCount: DEFAULT_MIN_FACE_COUNT,
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    groupThreshold: DEFAULT_GROUP_THRESHOLD,
    page: 1,
    search: "",
  });

  const groupsRef = useRef<IFaceLabelGroup[]>([]);
  const focusedRef = useRef<string | null>(null);
  groupsRef.current = groups;
  focusedRef.current = focusedId;

  const fetchQueue = useCallback(() => {
    setLoading(true);
    setErrorMessage(null);
    listFaceLabelQueue(filters)
      .then((response) => {
        setGroups(response.groups);
        setQueueCounts(response.counts ?? null);
        setPageInfo({
          page: response.page,
          pageSize: response.pageSize,
          total: response.total,
          totalPages: response.totalPages,
        });
        setDecisions({});
        setExcluded({});
        setFocusedId(response.groups[0]?.id ?? null);
      })
      .catch((error) => setErrorMessage(error.message))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  // Searching on every keystroke would fire a fairly heavy query per letter.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((prev) =>
        prev.search === searchInput ? prev : { ...prev, search: searchInput, page: 1 }
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    getTokenIndexStatus()
      .then(setIndexStatus)
      .catch(() => setIndexStatus(null));
  }, []);

  const handleRebuildIndex = () => {
    setBuildingIndex(true);
    toast.loading("Learning from your existing labels…", { id: "token-index" });
    rebuildTokenIndex()
      .then((status) => {
        setIndexStatus(status);
        toast.success(
          `Learned ${status.tokensLearned.toLocaleString()} filename patterns`,
          { id: "token-index" }
        );
        fetchQueue();
      })
      .catch((error) => toast.error(error.message, { id: "token-index" }))
      .finally(() => setBuildingIndex(false));
  };

  const setDecision = (groupId: string, decision: IClusterDecision | undefined) => {
    setDecisions((prev) => {
      const next = { ...prev };
      if (decision) next[groupId] = decision;
      else delete next[groupId];
      return next;
    });
  };

  const setExcludedFor = (groupId: string, faceIds: string[]) => {
    setExcluded((prev) => {
      const next = { ...prev };
      if (faceIds.length > 0) next[groupId] = faceIds;
      else delete next[groupId];
      return next;
    });
  };

  // Keyboard driving: 1-9 accepts a suggestion on the focused card, H hides,
  // S skips, Escape clears. Suppressed while typing so the name input keeps
  // its own Enter/arrow handling.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      const groupId = focusedRef.current;
      if (!groupId) return;
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group) return;

      if (event.key >= "1" && event.key <= "9") {
        const suggestion = group.suggestions[Number(event.key) - 1];
        if (!suggestion) return;
        event.preventDefault();
        setDecision(groupId, {
          action: "merge",
          targetPersonId: suggestion.personId,
          name: suggestion.name,
        });
        return;
      }

      if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        setDecision(groupId, { action: "hide" });
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        setDecision(groupId, { action: "skip" });
      } else if (event.key === "Escape") {
        setDecision(groupId, undefined);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const applyToEveryGroup = (decision: IClusterDecision) => {
    setDecisions(
      Object.fromEntries(groups.map((group) => [group.id, decision]))
    );
    toast.success(
      `${groups.length} group(s) set — review the cards, then press Apply`
    );
  };

  const buildItems = (): IFaceLabelApplyItem[] =>
    Object.entries(decisions).map(([groupId, decision]) => {
      const group = groups.find((g) => g.id === groupId);
      return {
        clusterIds: group?.clusterIds ?? [],
        faceIds: group?.faceIds ?? [],
        excludedFaceIds: excluded[groupId] ?? [],
        action: decision.action,
        name: decision.name,
        targetPersonId: decision.targetPersonId,
      };
    });

  const handlePreview = async () => {
    try {
      const response = await applyFaceLabels({
        items: buildItems(),
        mergeGroups,
        dryRun: true,
      });
      const summary = response.plannedCalls
        .map((call) => `${call.method} ${call.path}`)
        .join("\n");
      toast(
        summary
          ? `Would send ${response.plannedCalls.length} request(s):\n${summary}`
          : "Nothing would be sent.",
        { duration: 8000 }
      );
    } catch (error: any) {
      toast.error(error.message ?? "Preview failed");
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const response = await applyFaceLabels({
        items: buildItems(),
        mergeGroups,
      });

      const failed = response.results.filter(
        (result) => result?.status === "failed" || result?.status === "partial"
      );
      const applied = response.results.filter((r) => r?.status === "applied").length;

      if (applied > 0) toast.success(`Applied ${applied} change(s)`);
      for (const failure of failed) {
        toast.error(failure.error ?? "One group could not be applied");
      }

      fetchQueue();
    } catch (error: any) {
      toast.error(error.message ?? "Apply failed");
    } finally {
      setApplying(false);
    }
  };

  const counts = Object.values(decisions).reduce(
    (acc, decision) => {
      if (decision.action === "name") acc.named += 1;
      else if (decision.action === "merge") acc.merged += 1;
      else if (decision.action === "hide") acc.hidden += 1;
      else if (decision.action === "skip") acc.skipped += 1;
      return acc;
    },
    { named: 0, merged: 0, hidden: 0, skipped: 0 }
  );

  const renderContent = () => {
    if (loading) return <Loader />;
    if (errorMessage) {
      return <div className="p-4 text-sm text-destructive">{errorMessage}</div>;
    }
    if (groups.length === 0) {
      const searching = Boolean(filters.search);
      const nothingAnywhere =
        !searching &&
        queueCounts !== null &&
        queueCounts.clusters === 0 &&
        queueCounts.unassigned === 0;
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
          <PartyPopper className="h-10 w-10 opacity-30" />
          <p className="text-sm">
            {searching
              ? `Nothing unlabelled matches "${filters.search}".`
              : nothingAnywhere
                ? "Everything is labelled — no unnamed clusters and no unassigned faces."
                : "Nothing matches these settings."}
          </p>
          {searching ? (
            <p className="max-w-sm text-center text-xs">
              The search covers the original filename and folder path of
              unlabelled faces only — anything already named will not appear.
            </p>
          ) : (
            !nothingAnywhere &&
            queueCounts && (
              <p className="max-w-sm text-center text-xs">
                {queueCounts.clusters} unnamed cluster(s) and {queueCounts.unassigned}{" "}
                unassigned face(s) were found but filtered out. Try lowering the
                minimum face count, or switching scope in Tuning.
              </p>
            )
          )}
        </div>
      );
    }

    return (
      <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {groups.map((group) => (
          <ClusterCard
            key={group.id}
            group={group}
            decision={decisions[group.id]}
            excludedFaceIds={excluded[group.id]}
            focused={focusedId === group.id}
            onFocus={() => setFocusedId(group.id)}
            onChange={(decision) => setDecision(group.id, decision)}
            onExcludedChange={(faceIds) => setExcludedFor(group.id, faceIds)}
          />
        ))}
      </div>
    );
  };

  return (
    <PageLayout className="!p-0 !mb-0 relative pb-24">
      <Header
        leftComponent={
          <span className="flex items-center gap-2 font-semibold">
            <ScanFace className="h-4 w-4" />
            Power Face Label
          </span>
        }
        rightComponent={
          <div className="flex items-center gap-2">
            <DuplicatePeopleDialog />
            <FaceLabelFilters
              filters={filters}
              disabled={loading}
              onChange={(next) =>
                setFilters((prev) => ({ ...prev, ...next, page: 1 }))
              }
            />
            <Button size="sm" variant="ghost" onClick={fetchQueue} disabled={loading}>
              Refresh
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-3 pb-0">
        <TokenIndexCard
          status={indexStatus}
          building={buildingIndex}
          onRebuild={handleRebuildIndex}
        />

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search unlabelled faces by filename or folder — e.g. taylor"
            className="pl-9 pr-9"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              title="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {!loading && (
          <QueuePager
            page={pageInfo.page}
            totalPages={pageInfo.totalPages}
            total={pageInfo.total}
            pageSize={pageInfo.pageSize}
            groupCount={groups.length}
            disabled={loading}
            onPageChange={(page) => setFilters((prev) => ({ ...prev, page }))}
          />
        )}

        {!loading && groups.length > 0 && (
          <BulkAssignBar
            groupCount={groups.length}
            search={filters.search}
            onAssignAll={(personId, name) =>
              applyToEveryGroup({ action: "merge", targetPersonId: personId, name })
            }
            onNameAll={(name) => applyToEveryGroup({ action: "name", name })}
          />
        )}
      </div>

      {renderContent()}

      {!loading && groups.length > 0 && pageInfo.totalPages > 1 && (
        <div className="px-3 pb-3">
          <QueuePager
            page={pageInfo.page}
            totalPages={pageInfo.totalPages}
            total={pageInfo.total}
            pageSize={pageInfo.pageSize}
            groupCount={groups.length}
            disabled={loading}
            onPageChange={(page) => setFilters((prev) => ({ ...prev, page }))}
          />
        </div>
      )}

      <LabelApplyBar
        namedCount={counts.named}
        mergeCount={counts.merged}
        hideCount={counts.hidden}
        skipCount={counts.skipped}
        mergeGroups={mergeGroups}
        applying={applying}
        onMergeGroupsChange={setMergeGroups}
        onPreview={handlePreview}
        onApply={handleApply}
        onClear={() => {
          setDecisions({});
          setExcluded({});
        }}
      />
    </PageLayout>
  );
}
