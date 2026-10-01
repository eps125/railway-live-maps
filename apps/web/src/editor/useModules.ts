import { useCallback, useEffect, useState } from "react";
import { MapDocumentSchema, type MapDocument } from "@railway/map-schema";
import { readApiJson } from "./apiJson.js";
import type { EditorModule } from "./modulesSupport.js";
import type { AvailableModule } from "./ModulesPanel.js";

/** Milestone 85: the named modules (drafts and published versions). Re-fetched when the set of
 * slugs changes, and on `reload`. */
export function useModuleDocs(slugs: string[]): {
  modules: EditorModule[];
  reload: () => void;
} {
  const key = [...slugs].sort().join(",");
  const [modules, setModules] = useState<EditorModule[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key) {
      setModules([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/editor/modules?slugs=${encodeURIComponent(key)}`);
        if (!response.ok) return;
        const body = await readApiJson<{ modules: EditorModule[] }>(response);
        if (!cancelled) setModules(body.modules);
      } catch {
        // The canvas just shows no modules; the panel still lists them by slug.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { modules, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

interface EditorMapEntry {
  slug: string;
  name: string;
  kind?: "map" | "module";
  publishedVersion: number | null;
  usedBy?: string[];
}

/** Milestone 85: every module (for "Add a module"), and for a module, the maps using it. */
export function useModuleCatalogue(currentSlug: string): {
  available: AvailableModule[];
  usedBy: string[];
} {
  const [available, setAvailable] = useState<AvailableModule[]>([]);
  const [usedBy, setUsedBy] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/v1/editor/maps");
        if (!response.ok) return;
        const body = await readApiJson<{ maps: EditorMapEntry[] }>(response);
        if (cancelled) return;
        setAvailable(
          body.maps
            .filter((map) => map.kind === "module" && map.slug !== currentSlug)
            .map((map) => ({
              slug: map.slug,
              name: map.name,
              publishedVersion: map.publishedVersion,
            })),
        );
        setUsedBy(body.maps.find((map) => map.slug === currentSlug)?.usedBy ?? []);
      } catch {
        // Nothing to offer; the panel says so.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSlug]);
  return { available, usedBy };
}

/** Milestone 85: the assembled map a module is being edited inside (`?in=`), as its draft. */
export function useContextMap(contextSlug: string | null): MapDocument | null {
  const [doc, setDoc] = useState<MapDocument | null>(null);
  useEffect(() => {
    if (!contextSlug) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/v1/editor/maps/${encodeURIComponent(contextSlug)}/draft`,
        );
        if (!response.ok) return;
        const body = await readApiJson<{ canonicalDocument: unknown }>(response);
        const parsed = MapDocumentSchema.safeParse(body.canonicalDocument);
        if (!cancelled && parsed.success) setDoc(parsed.data);
      } catch {
        // No context: the module is edited on its own.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contextSlug]);
  return doc;
}
