export interface ComputeArchiveObjectKeyOptions {
  /** Path segment distinguishing sources, e.g. "td", "trust", "vstp", "schedule". */
  namespace: string;
  contentSha256: string;
  date: Date;
}

/** Deterministic, content-addressed archive key: "raw/<namespace>/yyyy/mm/dd/<sha256>.bin". */
export function computeArchiveObjectKey(options: ComputeArchiveObjectKeyOptions): string {
  const yyyy = options.date.getUTCFullYear();
  const mm = String(options.date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(options.date.getUTCDate()).padStart(2, "0");
  return `raw/${options.namespace}/${yyyy}/${mm}/${dd}/${options.contentSha256}.bin`;
}
