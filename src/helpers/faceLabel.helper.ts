import {
  TOKEN_DATELIKE_PATTERN,
  TOKEN_MIN_LENGTH,
  TOKEN_MIN_LIFT,
  TOKEN_NUMERIC_PATTERN,
  TOKEN_RESOLUTION_PATTERN,
  TOKEN_SATURATION_SUPPORT,
  TOKEN_STOP_WORDS,
} from "@/config/constants/faceLabel.constant";

/**
 * Token splitting must stay identical on both sides of the feature: the index
 * build splits in Postgres with `regexp_split_to_table(..., '[^A-Za-z0-9]+')`
 * and the queue splits here. Same expression, same lowercasing — otherwise
 * learned tokens never match the ones we look up.
 */
export const TOKEN_SPLIT_REGEX = /[^A-Za-z0-9]+/;

/** Strip a trailing file extension, if there is one. */
export const stripExtension = (fileName: string): string =>
  fileName.replace(/\.[^.]*$/, "");

/**
 * External libraries mounted from Windows hosts store backslash paths, so
 * normalise before splitting or the whole path reads as one token.
 */
export const normalisePath = (originalPath: string): string =>
  (originalPath || "").replace(/\\/g, "/");

/** Last directory segment of a path, i.e. the folder the file sits in. */
export const parentFolderName = (originalPath: string): string => {
  const withoutFile = normalisePath(originalPath).replace(/\/[^/]*$/, "");
  return withoutFile.replace(/^.*\//, "");
};

/**
 * Is this token worth learning from? Rejects camera/app boilerplate, dates,
 * resolutions, bare numbers and anything too short to identify a person.
 */
export const isUsefulToken = (token: string): boolean => {
  if (token.length < TOKEN_MIN_LENGTH) return false;
  if (TOKEN_STOP_WORDS.has(token)) return false;
  if (TOKEN_NUMERIC_PATTERN.test(token)) return false;
  if (TOKEN_DATELIKE_PATTERN.test(token)) return false;
  if (TOKEN_RESOLUTION_PATTERN.test(token)) return false;
  return true;
};

const splitTokens = (value: string): string[] =>
  value
    .split(TOKEN_SPLIT_REGEX)
    .map((t) => t.toLowerCase())
    .filter(isUsefulToken);

/** Useful filename tokens for an asset (extension already removed). */
export const filenameTokens = (originalFileName: string): string[] =>
  splitTokens(stripExtension(originalFileName || ""));

/** Useful folder tokens for an asset. */
export const folderTokens = (originalPath: string): string[] =>
  splitTokens(parentFolderName(originalPath || ""));

/**
 * Wilson lower bound (95%) on the observed precision.
 *
 * Raw precision scores a token seen once, on one photo, as a perfect 1.0.
 * Wilson folds support and precision into a single number instead of needing
 * two separate thresholds, so 3-of-3 does not outrank 40-of-42.
 */
export const wilsonLowerBound = (successes: number, trials: number): number => {
  if (trials <= 0) return 0;
  const z = 1.96;
  const zSq = z * z;
  const p = successes / trials;
  const numerator =
    p +
    zSq / (2 * trials) -
    z * Math.sqrt((p * (1 - p)) / trials + zSq / (4 * trials * trials));
  return Math.max(0, numerator / (1 + zSq / trials));
};

/**
 * Does this token tell us more than simply guessing the most-photographed
 * person? Applied when the index is built, where base rates are known.
 *
 * This is the gate that is easy to leave out and expensive to omit: in a
 * library dominated by one subject, a generic token like "beach" has high
 * precision for them purely because they are in most photos. Without lift,
 * the feature confidently suggests that one person for everything.
 */
export const passesLiftGate = (
  matchingAssets: number,
  labeledAssetsWithToken: number,
  personBaseRate: number
): boolean => {
  if (labeledAssetsWithToken <= 0) return false;
  if (personBaseRate <= 0) return true;
  const precision = matchingAssets / labeledAssetsWithToken;
  return precision / personBaseRate >= TOKEN_MIN_LIFT;
};

/**
 * Strength of a learned token→person association, used at query time.
 * Rows reaching this point already passed the lift gate at build time.
 */
export const tokenAssociationScore = (
  matchingAssets: number,
  labeledAssetsWithToken: number
): number => {
  if (labeledAssetsWithToken <= 0) return 0;
  const wilson = wilsonLowerBound(matchingAssets, labeledAssetsWithToken);
  const supportWeight = Math.min(
    1,
    Math.log2(1 + matchingAssets) / Math.log2(1 + TOKEN_SATURATION_SUPPORT)
  );
  return wilson * supportWeight;
};

/** Cosine similarity between two equal-length embedding vectors. */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

/**
 * Immich stores embeddings as a pgvector column. Depending on driver version
 * they come back as a JSON-ish string or an array, so normalise both.
 */
export const parseEmbedding = (value: unknown): number[] | null => {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
};

export const blockedPairKey = (a: string, b: string): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;

/**
 * Collapse unnamed clusters that are probably the same person into groups.
 *
 * This is greedy agglomeration rather than plain union-find, because plain
 * union-find is single-linkage: one marginal edge chains unrelated clusters
 * together and the resulting group quietly fuses two different people. Three
 * guards prevent that:
 *
 *  - `blocked` pairs never join. Two clusters with a face in the *same photo*
 *    cannot be one person, no matter how similar the embeddings look.
 *  - components stop growing at `maxSize`.
 *  - a candidate only joins if it is similar to *every* existing member, not
 *    just to one of them, so components stay near-cliques.
 */
export const groupClusters = (
  clusterIds: string[],
  embeddings: Map<string, number[]>,
  options: {
    threshold: number;
    minPairwise: number;
    maxSize: number;
    blocked: Set<string>;
  }
): string[][] => {
  const groups: string[][] = [];
  const assigned = new Set<string>();

  for (const id of clusterIds) {
    if (assigned.has(id)) continue;
    const embedding = embeddings.get(id);
    const group = [id];
    assigned.add(id);

    if (embedding) {
      for (const other of clusterIds) {
        if (assigned.has(other)) continue;
        if (group.length >= options.maxSize) break;
        const otherEmbedding = embeddings.get(other);
        if (!otherEmbedding) continue;

        const fitsAll = group.every((member) => {
          if (options.blocked.has(blockedPairKey(member, other))) return false;
          const memberEmbedding = embeddings.get(member);
          if (!memberEmbedding) return false;
          const similarity = cosineSimilarity(memberEmbedding, otherEmbedding);
          const required = member === id ? options.threshold : options.minPairwise;
          return similarity >= required;
        });

        if (fitsAll) {
          group.push(other);
          assigned.add(other);
        }
      }
    }

    groups.push(group);
  }

  return groups;
};
