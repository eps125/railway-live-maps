import { useEditorDispatch, useEditorState } from "./EditorState.js";

/** docs/MAP_EDITOR_SPEC.md §7: "Layer visibility/lock/order." Up/down swaps `order` with the
 * adjacent layer (via `reorderLayer` twice, one per side) rather than a full drag-reorder UI —
 * a documented MVP simplification, same spirit as the canvas's deferred 45°-drawing etc. */
export function LayersPanel(): JSX.Element {
  const { document: doc } = useEditorState();
  const dispatch = useEditorDispatch();

  const sorted = [...doc.layers].sort((a, b) => a.order - b.order);

  function swap(layerId: string, direction: -1 | 1): void {
    const index = sorted.findIndex((l) => l.id === layerId);
    const otherIndex = index + direction;
    if (index < 0 || otherIndex < 0 || otherIndex >= sorted.length) return;
    const current = sorted[index]!;
    const other = sorted[otherIndex]!;
    dispatch({
      type: "dispatchCommand",
      command: { type: "reorderLayer", layerId: current.id, newOrder: other.order },
    });
    dispatch({
      type: "dispatchCommand",
      command: { type: "reorderLayer", layerId: other.id, newOrder: current.order },
    });
  }

  return (
    <section aria-label="Layers">
      <h3>Layers</h3>
      <ul>
        {sorted.map((layer, index) => (
          <li key={layer.id}>
            <label>
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(e) =>
                  dispatch({
                    type: "dispatchCommand",
                    command: {
                      type: "setLayerProperty",
                      layerId: layer.id,
                      property: "visible",
                      value: e.target.checked,
                    },
                  })
                }
              />
              {layer.name}
            </label>
            <label>
              <input
                type="checkbox"
                checked={layer.locked}
                onChange={(e) =>
                  dispatch({
                    type: "dispatchCommand",
                    command: {
                      type: "setLayerProperty",
                      layerId: layer.id,
                      property: "locked",
                      value: e.target.checked,
                    },
                  })
                }
              />
              Locked
            </label>
            <button type="button" disabled={index === 0} onClick={() => swap(layer.id, -1)}>
              ↑
            </button>
            <button
              type="button"
              disabled={index === sorted.length - 1}
              onClick={() => swap(layer.id, 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
