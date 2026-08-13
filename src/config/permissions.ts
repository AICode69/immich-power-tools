export interface Permission {
  name: string;
  description: string;
}

export const IMPORT_PERMISSIONS: Permission[] = [
  { name: "asset.read", description: "Check for existing assets" },
  { name: "asset.upload", description: "Upload new assets" },
  { name: "album.read", description: "Read album data" },
  { name: "album.create", description: "Create new albums" },
  { name: "album.update", description: "Update album metadata" },
  { name: "albumAsset.create", description: "Add assets to albums" },
  { name: "tag.create", description: "Tag imported assets" },
  { name: "tag.asset", description: "Assign tags to assets" },
];

export const WORKFLOW_PERMISSIONS: Permission[] = [
  { name: "asset.read", description: "Query and filter assets" },
  { name: "asset.update", description: "Favorite, archive, update metadata" },
  { name: "album.read", description: "Read album data" },
  { name: "album.create", description: "Create new albums" },
  { name: "album.update", description: "Update album metadata" },
  { name: "albumAsset.create", description: "Add assets to albums" },
  { name: "albumAsset.delete", description: "Remove assets from albums" },
  { name: "tag.create", description: "Create tags" },
  { name: "tag.asset", description: "Assign tags to assets" },
];

export const FACE_LABEL_PERMISSIONS: Permission[] = [
  { name: "person.read", description: "Read people and face clusters" },
  { name: "person.update", description: "Name people and hide junk clusters" },
  { name: "person.merge", description: "Merge clusters into one person" },
  { name: "asset.read", description: "Read filenames and folders for name suggestions" },
  { name: "asset.view", description: "Show face thumbnails and photos" },
];

export const getPermissionNames = (permissions: Permission[]): string[] =>
  permissions.map((p) => p.name);
