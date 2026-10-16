import type { ListObjectsOptions, ListObjectsResult, StorageAdapter, StoredObjectInfo } from "./types";

const DEFAULT_LIST_LIMIT = 1000;

export const paginateKeys = (
  objects: StoredObjectInfo[],
  options: ListObjectsOptions = {}
): ListObjectsResult => {
  const prefix = options.prefix ?? "";
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const sorted = objects
    .filter((o) => o.key.startsWith(prefix) && (!options.cursor || o.key > options.cursor))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const page = sorted.slice(0, limit);
  return {
    objects: page,
    cursor: sorted.length > limit ? page[page.length - 1].key : undefined,
  };
};

export async function* listAllObjects(
  storage: StorageAdapter,
  prefix = ""
): AsyncGenerator<StoredObjectInfo> {
  if (typeof storage.list !== "function") return;
  let cursor: string | undefined;
  do {
    const page = await storage.list({ prefix, cursor });
    for (const object of page.objects) yield object;
    cursor = page.cursor;
  } while (cursor);
}
