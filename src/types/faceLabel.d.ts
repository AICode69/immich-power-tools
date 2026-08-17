export interface IFaceBoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface IFaceSample {
  faceId: string;
  assetId: string;
  /** Original filename, shown so a filename-driven suggestion is checkable. */
  fileName?: string;
  /** Dimensions the detector ran on — the bounding box is in these coordinates. */
  imageWidth: number;
  imageHeight: number;
  boundingBox: IFaceBoundingBox;
}

export interface IFaceLabelSignals {
  face: number;
  /** A known person's name appearing literally in the filename or folder. */
  name: number;
  filename: number;
  social: number;
  /** Photos where this candidate already appears alongside the cluster. */
  sharedAssets: number;
}

export interface IFaceLabelSuggestion {
  personId: string;
  name: string;
  confidence: number;
  signals: IFaceLabelSignals;
  /** Human-readable reasons, shown so a suggestion is never a black box. */
  evidence: string[];
}

export type FaceLabelKind = "cluster" | "faces";

export interface IFaceLabelGroup {
  id: string;
  /**
   * "cluster" — unnamed person records Immich grouped but nobody named.
   * "faces"   — faces Immich never grouped at all (below its minFaces
   *             threshold), which have no person record yet.
   */
  kind: FaceLabelKind;
  /** Person ids, when kind is "cluster". */
  clusterIds: string[];
  /** Face ids, when kind is "faces". */
  faceIds: string[];
  faceCount: number;
  sampleFaces: IFaceSample[];
  suggestions: IFaceLabelSuggestion[];
}

export interface IFaceLabelQueueResponse {
  groups: IFaceLabelGroup[];
  page: number;
  /** Clusters and faces scanned per page — not the number of cards. */
  pageSize: number;
  /** Total clusters + unassigned faces matching the current filters. */
  total: number;
  totalPages: number;
  counts: { clusters: number; unassigned: number };
}

export type FaceLabelScope = "both" | "clusters" | "unassigned";

export interface IFaceLabelQueueFilters {
  scope?: FaceLabelScope;
  pageSize?: number;
  minFaceCount?: number;
  similarityThreshold?: number;
  groupThreshold?: number;
  page?: number;
  /** Substring match against the original filename and path. */
  search?: string;
}

export type FaceLabelAction = "name" | "merge" | "hide" | "skip";

export interface IFaceLabelApplyItem {
  clusterIds?: string[];
  faceIds?: string[];
  /**
   * Faces the user unticked while reviewing the group. They are kept out of
   * whatever the group is named or merged into.
   */
  excludedFaceIds?: string[];
  action: FaceLabelAction;
  name?: string;
  targetPersonId?: string;
}

/** One page of the faces behind a group, for the review dialog. */
export interface IFaceLabelGroupFacesResponse {
  faces: IFaceSample[];
  total: number;
  page: number;
  pageSize: number;
}

export interface IFaceLabelApplyRequest {
  items: IFaceLabelApplyItem[];
  mergeGroups?: boolean;
  dryRun?: boolean;
}

export interface IFaceLabelApplyResult {
  clusterIds: string[];
  faceIds: string[];
  action: FaceLabelAction;
  status: "applied" | "partial" | "failed" | "skipped";
  error?: string;
}

export interface IFaceLabelApplyResponse {
  dryRun: boolean;
  mergeGroups: boolean;
  results: IFaceLabelApplyResult[];
  summary: Record<string, number>;
  plannedCalls: { method: string; path: string; body: unknown }[];
}

export interface IFaceLabelIndexStatus {
  builtAt: string | null;
  assetsScanned: number;
  tokensLearned: number;
  namedPeopleSeen: number;
  isStale: boolean;
  hasIndex: boolean;
}

export interface IDuplicatePerson {
  id: string;
  name: string;
  isHidden: boolean;
  faceCount: number;
}

export interface IDuplicatePersonGroup {
  key: string;
  primary: IDuplicatePerson;
  duplicates: IDuplicatePerson[];
  totalFaces: number;
}
