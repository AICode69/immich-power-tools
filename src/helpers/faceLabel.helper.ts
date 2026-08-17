import {
  NAME_MATCH_MIN_PREFIX,
  NAME_MATCH_SCORES,
  TOKEN_DATELIKE_PATTERN,
  TOKEN_HEXLIKE_PATTERN,
  TOKEN_MIN_LENGTH,
  TOKEN_MIN_LIFT,
  TOKEN_NUMERIC_PATTERN,
  TOKEN_RESOLUTION_PATTERN,
  TOKEN_SATURATION_SUPPORT,
  TOKEN_STOP_WORDS,
} from "@/config/constants/faceLabel.constant";

/**
 * Token splitting must stay identical on both sides of the feature: the index
 * build splits in Postgres and the queue splits here. Same boundaries, same
 * squeeze, same lowercasing — otherwise learned tokens never match the ones we
 * look up. `SQL_TOKEN_EXPANSION` below is the Postgres twin of
 * `expandBoundaries`; change one and you must change the other.
 */
export const TOKEN_SPLIT_REGEX = /[^A-Za-z0-9]+/;

/** Strip a trailing file extension, if there is one. */
export const stripExtension = (fileName: string): string =>
  fileName.replace(/\.[^.]*$/, "");

/**
 * Insert split points that punctuation alone misses.
 *
 * Real libraries name files every possible way, and a single unsplit token is
 * a token that never matches anything:
 *
 *   TaylorMorgan2024 -> Taylor Morgan 2024
 *   IMGTaylor01      -> IMG Taylor 01
 *   HTMLParser       -> HTML Parser
 *
 * Order matters — the acronym rule has to run before the plain camelCase rule,
 * or `HTMLParser` becomes `HTMLP arser`.
 */
export const expandBoundaries = (value: string): string =>
  value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2");

/**
 * Collapse runs of three or more identical characters.
 *
 * Social exports and handles pad names for effect — `taylorrr__export_*.jpg`,
 * `taaaaylor_2024.jpg`. Squeezing lets those reach the same token as the
 * ordinary spelling. Runs of two are left alone so `taylor` stays `taylor`.
 */
export const squeezeRepeats = (token: string): string =>
  token.replace(/(.)\1{2,}/g, "$1");

/**
 * Postgres equivalent of `expandBoundaries`, as a SQL expression over `expr`.
 * Kept here so the two definitions sit side by side.
 */
export const SQL_TOKEN_EXPANSION = (expr: string): string => `
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(${expr}, '([A-Z]+)([A-Z][a-z])', '\\1 \\2', 'g'),
        '([a-z0-9])([A-Z])', '\\1 \\2', 'g'),
      '([A-Za-z])([0-9])', '\\1 \\2', 'g'),
    '([0-9])([A-Za-z])', '\\1 \\2', 'g')`;

/** Postgres equivalent of `squeezeRepeats`, as a SQL expression over `expr`. */
export const SQL_TOKEN_SQUEEZE = (expr: string): string =>
  `regexp_replace(${expr}, '(.)\\1{2,}', '\\1', 'g')`;

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
  // Content hashes and uuid fragments look like words to the splitter but are
  // unique per asset, so they only bloat the index.
  if (TOKEN_HEXLIKE_PATTERN.test(token) && /\d/.test(token)) return false;
  return true;
};

/**
 * Split a filename or folder name into the tokens worth learning from.
 *
 * Emits the plain token and, when squeezing changes it, the squeezed form too,
 * so `taylorrr` reaches the same token as `taylor` without losing the
 * literal spelling.
 */
const splitTokens = (value: string): string[] => {
  const out = new Set<string>();
  for (const part of expandBoundaries(value).split(TOKEN_SPLIT_REGEX)) {
    const token = part.toLowerCase();
    if (isUsefulToken(token)) out.add(token);
    const squeezed = squeezeRepeats(token);
    if (squeezed !== token && isUsefulToken(squeezed)) out.add(squeezed);
  }
  return Array.from(out);
};

/** Useful filename tokens for an asset (extension already removed). */
export const filenameTokens = (originalFileName: string): string[] =>
  splitTokens(stripExtension(originalFileName || ""));

/** Useful folder tokens for an asset. */
export const folderTokens = (originalPath: string): string[] =>
  splitTokens(parentFolderName(originalPath || ""));

/**
 * Tokens for a person's name, used to match names that appear literally in
 * filenames. Squeezed the same way filename tokens are, so both sides meet.
 */
export const personNameTokens = (name: string): string[] => {
  const out = new Set<string>();
  for (const part of expandBoundaries(name || "").split(TOKEN_SPLIT_REGEX)) {
    const token = part.toLowerCase();
    if (token.length < TOKEN_MIN_LENGTH) continue;
    out.add(squeezeRepeats(token));
  }
  return Array.from(out);
};

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

export interface PersonNameIndex {
  /** Name token -> ids of every person carrying it. */
  byToken: Map<string, string[]>;
  /** Person id -> the tokens of their own name. */
  tokensByPerson: Map<string, string[]>;
}

/**
 * Index named people by the tokens of their names.
 *
 * The learned token index can only speak about filenames that already sit next
 * to a labelled face, so it is silent on a person whose photos are all
 * unlabelled — exactly the cold-start case this feature exists for. Matching
 * filenames against the names Immich already knows costs one small query and
 * covers it.
 */
export const buildPersonNameIndex = (
  people: { id: string; name: string }[]
): PersonNameIndex => {
  const byToken = new Map<string, string[]>();
  const tokensByPerson = new Map<string, string[]>();

  for (const person of people) {
    const tokens = personNameTokens(person.name).filter(
      (token) => !TOKEN_STOP_WORDS.has(token)
    );
    if (tokens.length === 0) continue;
    tokensByPerson.set(person.id, tokens);
    for (const token of tokens) {
      const list = byToken.get(token) ?? [];
      if (!list.includes(person.id)) list.push(person.id);
      byToken.set(token, list);
    }
  }

  return { byToken, tokensByPerson };
};

export interface NameMatch {
  score: number;
  /** The filename/folder token that produced the match. */
  token: string;
  exact: boolean;
}

/**
 * Score how strongly a set of filename/folder tokens names a known person.
 *
 * A token shared by several people is divided between them, so a common family
 * name never outranks a distinctive given name. Matching every prefix of the
 * token rather than scanning all names keeps this linear in token length.
 */
export const matchNamesInTokens = (
  tokens: string[],
  index: PersonNameIndex
): Map<string, NameMatch> => {
  const matches = new Map<string, NameMatch>();

  const record = (personId: string, score: number, token: string, exact: boolean) => {
    const existing = matches.get(personId);
    if (!existing || existing.score < score) {
      matches.set(personId, { score, token, exact });
    }
  };

  const seenTokens = new Set<string>();

  for (const raw of tokens) {
    const token = squeezeRepeats(raw);
    if (token.length < TOKEN_MIN_LENGTH || TOKEN_STOP_WORDS.has(token)) continue;
    seenTokens.add(token);

    const exactPeople = index.byToken.get(token);
    if (exactPeople) {
      const share = NAME_MATCH_SCORES.exact / exactPeople.length;
      for (const personId of exactPeople) record(personId, share, token, true);
    }

    // `taylorrr` -> `taylor`, `taylors` -> `taylor`. Only prefixes long
    // enough to be a name are considered.
    for (let length = NAME_MATCH_MIN_PREFIX; length < token.length; length++) {
      const prefix = token.slice(0, length);
      const people = index.byToken.get(prefix);
      if (!people) continue;
      const share = NAME_MATCH_SCORES.prefix / people.length;
      for (const personId of people) record(personId, share, token, false);
    }
  }

  // Every part of the name present at once ("taylor" and "morgan") is far
  // stronger evidence than either half alone.
  for (const [personId, match] of Array.from(matches.entries())) {
    const nameTokens = index.tokensByPerson.get(personId);
    if (!nameTokens || nameTokens.length < 2) continue;
    if (nameTokens.every((token) => seenTokens.has(token))) {
      matches.set(personId, { ...match, score: NAME_MATCH_SCORES.fullName });
    }
  }

  return matches;
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
