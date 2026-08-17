import {
  FACE_LABEL_APPLY_PATH,
  FACE_LABEL_DUPLICATES_PATH,
  FACE_LABEL_GROUP_FACES_PATH,
  FACE_LABEL_QUEUE_PATH,
  FACE_LABEL_TOKEN_INDEX_PATH,
  MERGE_PERSON_PATH,
} from "@/config/routes";
import API from "@/lib/api";
import {
  IDuplicatePersonGroup,
  IFaceLabelApplyRequest,
  IFaceLabelApplyResponse,
  IFaceLabelGroupFacesResponse,
  IFaceLabelIndexStatus,
  IFaceLabelQueueFilters,
  IFaceLabelQueueResponse,
} from "@/types/faceLabel";

export const listFaceLabelQueue = (
  filters: IFaceLabelQueueFilters
): Promise<IFaceLabelQueueResponse> => {
  return API.get(FACE_LABEL_QUEUE_PATH, filters);
};

/** Every face behind one group, paged, for the review dialog. */
export const listGroupFaces = (params: {
  clusterIds?: string[];
  faceIds?: string[];
  page?: number;
}): Promise<IFaceLabelGroupFacesResponse> => {
  return API.get(FACE_LABEL_GROUP_FACES_PATH, {
    clusterIds: params.clusterIds?.join(",") || undefined,
    faceIds: params.faceIds?.join(",") || undefined,
    page: params.page ?? 1,
  });
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
