# Power Face Label

Bulk labelling for unnamed people, at `/people/label`.

Immich's own flow is one face at a time: open a person, type a name, repeat. This
page loads a batch of unnamed clusters, groups the ones that look like the same
person, ranks name suggestions from several independent signals, and applies the
whole batch in a couple of API calls. Nothing is written to Immich until you
press **Apply**.

## What it works on

Two kinds of unlabelled face, because Immich leaves them in two different states:

**Unassigned faces** (`asset_face.personId IS NULL`) — the important ones. Immich's
facial recognition only creates a person once it finds `minFaces` similar faces
(default **3**). Everything below that threshold is never grouped, never becomes a
person, and never appears in Immich's people view at all. On a large library this
is usually where nearly all the remaining work is, and it is invisible in Immich's
own UI. These have no person record, so labelling one means creating a person (or
picking an existing one) and attaching the face to it.

**Unnamed clusters** (`person.name = ''`) — groups Immich did form but nobody has
named. These are the ones Immich's people view already shows you.

The **What to review** setting in Tuning switches between them; the default covers
both, clusters first.

Relabelling already-named people is out of scope.

## How suggestions are ranked

Three signals combine into one confidence score. Every suggestion carries its own
evidence, visible on hover, so a name is never proposed without a reason.

### 1. Face similarity

The primary signal. Up to three sample faces per cluster are compared against the
faces of already-named people using the 512-dimension embeddings Immich stores in
`face_search`, via pgvector cosine distance.

The query is written as `ORDER BY embedding <=> probe LIMIT k` because that is the
only shape pgvector's HNSW index can accelerate — a `WHERE similarity > x` scan
would silently fall back to reading every embedding.

### 2. Filename and folder patterns

Photos exported from other tools or downloaded in bulk often carry an identifying
token in the filename or the containing folder — something like
`<handle>_2016-11-22_13-50-00-860.jpg`. Once a few of those are labelled, the rest
are predictable.

The index learns this from **your own existing labels only**. It splits filenames
and folder names into tokens, and for each token measures which named person
actually appears in those photos. Two gates decide whether a token counts:

- **Wilson lower bound** on the observed precision, so a token seen once on one
  photo does not score as highly as one seen forty times.
- **Lift** — the token must beat that person's base rate by at least 3×. This is
  the gate that matters most. In a library dominated by one subject, a generic
  token like `beach` has high precision for them purely because they are in most
  photos; without lift, the feature would confidently suggest the same person for
  everything.

Tokens that are too short, purely numeric, date-like, camera boilerplate
(`IMG`, `DSC`, `PXL`, …), or spread across too much of the library are discarded.

Build or rebuild the index from the card at the top of the page. It is a single
Postgres query and takes seconds to tens of seconds depending on library size.

### 3. Co-occurrence

Two directions, and the negative one is the more useful:

- **Same photo → almost certainly not that person.** A person does not appear
  twice in one photograph. One shared photo is penalised (collages and
  photos-of-photos exist); two or more removes the candidate entirely.
- **Same albums → weak positive.** People who show up in the same albums are
  plausible candidates.

## Grouping

Unnamed clusters — and, separately, unassigned faces — whose embeddings are
similar enough are grouped so one name covers several at once. Grouping is
deliberately conservative:

- items that share a photo are **never** grouped, whatever the embeddings say (two
  faces in one photo are two different people; for unassigned faces this needs no
  query, the asset id is already on the row);
- a group stops growing at 8 clusters;
- a cluster only joins if it is similar to *every* existing member, not just one —
  plain single-linkage chaining is how "group similar clusters" quietly fuses two
  different people.

## Applying

| Action | Unnamed cluster | Unassigned face |
|---|---|---|
| Name | Renames the cluster (reversible) | Creates a person, then attaches the face |
| Merge / Assign | Absorbs the cluster into an existing person (**not reversible**) | Attaches the face to that person (reversible — reassign or unassign) |
| Hide | Marks the cluster hidden in Immich | Not applicable; recorded as a skip instead |
| Skip | Remembered locally so it stops appearing | Same |

Assigning a face uses `PUT /api/faces/{personId}` with `{ id: faceId }`. Note the
path parameter is the **person**, not the face, despite the route name — verified
against Immich's `PersonService.reassignFacesById(auth, personId, dto)`.

Renames and hides go out as a single `PUT /api/people` call. Merges follow, one
call per target, and **only if the rename succeeded** — there is no point merging
faces into a cluster that could not be named.

Renaming happens before merging on purpose. Merging destroys the secondary person
records; if it ran first and the rename then failed, you would be left with a
merged-but-unnamed super-cluster and no way to tell whether the grouping was even
correct.

Because merging cannot be undone (Immich has no split operation), **grouped
clusters are only renamed unless you tick "Also merge grouped clusters"**. Naming
alone still labels everything; it just leaves the records separate.

**Preview** runs the whole batch as a dry run and reports the exact Immich requests
that would be sent, without sending them. Worth using on a first run.

## Keyboard

With a card focused (hover or tab):

| Key | Action |
|---|---|
| `1`–`9` | Accept that numbered suggestion |
| `H` | Mark as junk / hide |
| `S` | Skip |
| `Esc` | Clear the decision |

Shortcuts are suppressed while the name field has focus.

## Tuning

Behind the **Tuning** button: batch size, minimum faces per cluster, the
suggestion threshold, and the grouping threshold. Raise the grouping threshold if
unrelated people are being grouped together.

Defaults live in `src/config/constants/faceLabel.constant.ts`.

## Required Immich API key permissions

`person.read`, `person.update`, `person.create`, `person.merge`, `face.read`,
`face.update`, `asset.read`, `asset.view` — see
`FACE_LABEL_PERMISSIONS` in `src/config/permissions.ts`. A key created with the
"All" checkbox covers these.

## Privacy

The learned filename statistics contain filename fragments and Immich person ids.
They are stored **only** in the local app database (`data/*.db`, gitignored) and
are never transmitted anywhere. The feature makes no outbound network calls beyond
your own Immich server and its database, and does not use the configured AI
provider.

## Implementation notes

| Path | Purpose |
|---|---|
| `src/pages/api/people/label/queue.ts` | Clustering, grouping and the three signals |
| `src/pages/api/people/label/token-index.ts` | Builds the filename/folder index |
| `src/pages/api/people/label/apply.ts` | The only write path |
| `src/pages/api/people/label/duplicates.ts` | Same-name cleanup |
| `src/helpers/faceLabel.helper.ts` | Tokenising, scoring, grouping |
| `src/components/people/label/` | The UI |

Reads go directly to Immich's Postgres via Drizzle; every write goes through
Immich's REST API, so thumbnails, audit tables and sync state stay consistent.

Filename tokens are split in Postgres during the index build and in JavaScript at
query time. Both use `[^A-Za-z0-9]+` and lowercase the result, and both apply the
same stop-word filters from `faceLabel.helper.ts` — if those ever diverge, learned
tokens will stop matching the ones being looked up.
