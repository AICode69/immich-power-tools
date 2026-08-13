export interface IFaceBoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface IFaceSample {
  faceId: string;
  personId: string;
  assetId: string;
  /** Dimensions the detector ran on — the bounding box is in these coordinates. */
  imageWidth: number;
  imageHeight: number;
  boundingBox: IFaceBoundingBox;
}

export interface IFaceLabelSignals {
  face: number;
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

export interface IFaceLabelGroup {
  id: string;
  /** One or more unnamed people that look like the same person. */
  clusterIds: string[];
  faceCount: number;
  sampleFaces: IFaceSample[];
  suggestions: IFaceLabelSuggestion[];
}

export interface IFaceLabelQueueResponse {
  groups: IFaceLabelGroup[];
  windowSize: number;
  hasMore: boolean;
}

export interface IFaceLabelQueueFilters {
  batchSize?: number;
  minFaceCount?: number;
  similarityThreshold?: number;
  groupThreshold?: number;
  page?: number;
}

export type FaceLabelAction = "name" | "merge" | "hide" | "skip";

export interface IFaceLabelApplyItem {
  clusterIds: string[];
  action: FaceLabelAction;
  name?: string;
  targetPersonId?: string;
}

export interface IFaceLabelApplyRequest {
  items: IFaceLabelApplyItem[];
  mergeGroups?: boolean;
  dryRun?: boolean;
}

export interface IFaceLabelApplyResult {
  clusterIds: string[];
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
