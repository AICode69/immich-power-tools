/**
 * Tunables for the Power Face Label suggestion engine.
 *
 * Everything here is a heuristic. The defaults are deliberately conservative —
 * a wrong suggestion that gets accepted in bulk is far more expensive to undo
 * than a missing suggestion is to type by hand.
 */

/** Face-embedding cosine similarity below this never becomes a suggestion. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.55;

/** Two unnamed clusters at or above this similarity are treated as one person. */
export const DEFAULT_GROUP_THRESHOLD = 0.75;

/** Clusters with fewer faces than this are skipped by default (noise). */
export const DEFAULT_MIN_FACE_COUNT = 2;

/** Groups shown per review batch. */
export const DEFAULT_BATCH_SIZE = 24;

/**
 * How many unnamed clusters are pulled in one pass for grouping. Pairwise
 * comparison is O(n^2 * 512); 300 keeps that in the low milliseconds. Raising
 * it materially is the fastest way to make this page feel slow.
 */
export const CLUSTER_WINDOW_SIZE = 300;

/** Sample faces per cluster used to query for similar named people. */
export const SAMPLE_FACES_PER_CLUSTER = 3;

/**
 * Nearest neighbours fetched per sample face. The HNSW index only accelerates
 * `ORDER BY embedding <=> $1 LIMIT k`, so named-person filtering happens after
 * the KNN — hence the over-fetch.
 */
export const KNN_OVERFETCH = 200;

/** Sample assets shown per group in the UI. */
export const SAMPLE_ASSETS_PER_GROUP = 6;

/** Signal weights. Face similarity dominates; the rest adjust the ordering. */
export const SIGNAL_WEIGHTS = {
  face: 1,
  filename: 0.45,
  social: 0.15,
};

/**
 * Penalty applied when a candidate already has a face in the *same* asset.
 * A person is not in one photo twice, so this is close to a disqualification.
 * A single shared photo is penalised (collages and photos-of-photos exist);
 * two or more is treated as proof and drops the candidate entirely.
 */
export const SAME_ASSET_PENALTY = 0.6;
export const SAME_ASSET_HARD_DROP = 2;

/**
 * Grouping guards. Union-find has no natural brake, so one marginal edge can
 * chain half a page into a single component. Cap the size and require the
 * component to be a near-clique rather than merely connected.
 */
export const GROUP_MAX_SIZE = 8;
export const GROUP_MIN_PAIRWISE_SIMILARITY = 0.62;

/**
 * A token must beat the person's base rate by this factor to count. Without
 * it, the most-photographed person wins every suggestion in a library with one
 * dominant subject.
 */
export const TOKEN_MIN_LIFT = 3;

/** A token→person association needs at least this many supporting assets. */
export const TOKEN_MIN_SUPPORT = 3;

/** ...and at least this share of that token's assets must be the same person. */
export const TOKEN_MIN_PRECISION = 0.6;

/** Support at which the filename signal reaches full strength. */
export const TOKEN_SATURATION_SUPPORT = 10;

/**
 * A token present in more than this share of the library identifies nobody
 * (think a folder every photo lives under). Discarded at index time.
 */
export const TOKEN_MAX_LIBRARY_SHARE = 0.25;

/** Shortest token worth keeping. */
export const TOKEN_MIN_LENGTH = 3;

/** Token index is considered stale after this long. */
export const TOKEN_INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Merge payload chunk size when collapsing groups. */
export const MERGE_CHUNK_SIZE = 20;

/**
 * Camera, phone and app filename prefixes. These are ubiquitous and carry no
 * identity information, so they are dropped before scoring.
 */
export const TOKEN_STOP_WORDS = new Set([
  "img", "image", "images", "dsc", "dscf", "dscn", "pxl", "vid", "video",
  "mvimg", "pano", "panorama", "screenshot", "screenshots", "screen", "shot",
  "photo", "photos", "picture", "pictures", "pic", "pics", "wa", "whatsapp",
  "signal", "telegram", "messenger", "snapchat", "burst", "cover", "edit",
  "edited", "copy", "final", "export", "exported", "original", "originals",
  "resized", "compressed", "untitled", "new", "temp", "tmp", "misc", "other",
  "camera", "gopro", "drone", "raw", "jpeg", "jpg", "png", "heic", "heif",
  "mov", "mp4", "gif", "webp", "tiff", "arw", "cr2", "nef", "dng", "live",
  "google", "photos", "takeout", "backup", "backups", "upload", "uploads",
  "download", "downloads", "media", "files", "album", "albums", "folder",
  "year", "years", "month", "day", "date", "and", "the", "with", "from",
]);

/** Tokens that are pure numbers, dates, times or resolutions carry no identity. */
export const TOKEN_NUMERIC_PATTERN = /^\d+$/;
export const TOKEN_DATELIKE_PATTERN = /^(19|20)\d{2}([-_]?\d{2}){0,2}$/;
export const TOKEN_RESOLUTION_PATTERN = /^\d+x\d+$/;
