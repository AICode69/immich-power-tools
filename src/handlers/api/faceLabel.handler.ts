import {
  FACE_LABEL_APPLY_PATH,
  FACE_LABEL_DUPLICATES_PATH,
  FACE_LABEL_QUEUE_PATH,
  FACE_LABEL_TOKEN_INDEX_PATH,
  MERGE_PERSON_PATH,
} from "@/config/routes";
import API from "@/lib/api";
import {
  IDuplicatePersonGroup,
  IFaceLabelApplyRequest,
  IFaceLabelApplyResponse,
  IFaceLabelIndexStatus,
  IFaceLabelQueueFilters,
  IFaceLabelQueueResponse,
} from "@/types/faceLabel";

export const listFaceLabelQueue = (
  filters: IFaceLabelQueueFilters
): Promise<IFaceLabelQueueResponse> => {
  return API.get(FACE_LABEL_QUEUE_PATH, filters);
};

export const applyFaceLabels = (
  request: IFaceLabelApplyRequest
): Promise<IFaceLabelApplyResponse> => {
  return API.post(FACE_LABEL_APPLY_PATH, request);
};

export const getTokenIndexStatus = (): Promise<IFaceLabelIndexStatus> => {
  return API.get(FACE_LABEL_TOKEN_INDEX_PATH, {});
};

export const rebuildTokenIndex = (): Promise<IFaceLabelIndexStatus> => {
  return API.post(FACE_LABEL_TOKEN_INDEX_PATH, {});
};

export const listDuplicatePeople = (): Promise<{
  groups: IDuplicatePersonGroup[];
}> => {
  return API.get(FACE_LABEL_DUPLICATES_PATH, {});
};

/** Collapse duplicate named people into the primary. Cannot be undone. */
export const mergeDuplicatePeople = (primaryId: string, duplicateIds: string[]) => {
  return API.post(MERGE_PERSON_PATH(primaryId), { ids: duplicateIds });
};
