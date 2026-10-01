import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapDocumentSchema, type MapDocument } from "@railway/map-schema";
import { EditorStateProvider, useEditorState } from "./EditorState.js";
import { JoinsPanel, ModulesPanel } from "./ModulesPanel.js";
import { assemblyBackdrop, type EditorModule } from "./modulesSupport.js";

function doc(partial: Partial<MapDocument> & { id: string }): MapDocument {
  return MapDocumentSchema.parse({
    schemaVersion: 1,
    map: {
      id: partial.id,
      name: partial.id,
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "layer-track", name: "Track", visible: true, locked: false, order: 0 }],
    ...partial,
  });
}

function module(slug: string): EditorModule {
  const moduleDoc = doc({
    id: slug,
    elements: [
      {
        id: "up",
        type: "trackPath",
        layerId: "layer-track",
        zIndex: 0,
        points: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
      },
    ],
    joins: [
      {
        id: "west",
        name: "West",
        points: [
          { x: 0, y: -10 },
          { x: 0, y: 10 },
        ],
      },
      {
        id: "east",
        name: "East",
        points: [
          { x: 200, y: -10 },
          { x: 200, y: 10 },
        ],
      },
    ],
  });
  return {
    slug,
    name: slug === "a" ? "Alpha" : "Bravo",
    draft: moduleDoc,
    draftRevision: 1,
    published: moduleDoc,
    publishedVersion: 1,
  };
}

/** Shows the document's modules, so a test can read what the panel did. */
function ModulesProbe(): JSX.Element {
  const { document } = useEditorState();
  return <pre data-testid="modules">{JSON.stringify(document.modules ?? [])}</pre>;
}

function Harness({ start, modules }: { start: MapDocument; modules: EditorModule[] }) {
  return (
    <EditorStateProvider initialDocument={start}>
      <Panel modules={modules} />
      <ModulesProbe />
    </EditorStateProvider>
  );
}

function Panel({ modules }: { modules: EditorModule[] }): JSX.Element {
  const { document } = useEditorState();
  const view = assemblyBackdrop(document, modules);
  return (
    <ModulesPanel
      slug="assembled"
      modules={modules}
      available={[
        { slug: "a", name: "Alpha", publishedVersion: 1 },
        { slug: "b", name: "Bravo", publishedVersion: 1 },
      ]}
      backdrop={view.items}
      offsets={view.offsets}
      issues={view.issues}
      onOpen={vi.fn()}
    />
  );
}

function modulesNow(): unknown {
  return JSON.parse(screen.getByTestId("modules").textContent ?? "[]");
}

describe("ModulesPanel", () => {
  it("adds modules side by side, then attaches one by its joins", () => {
    render(<Harness start={doc({ id: "assembled" })} modules={[module("a"), module("b")]} />);

    fireEvent.change(screen.getByLabelText("Add a module"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Add a module"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(modulesNow()).toEqual([
      { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
      { slug: "b", placement: { kind: "at", x: 300, y: 0 } },
    ]);

    const bravo = screen
      .getAllByRole("listitem")
      .find((li) => li.textContent?.startsWith("Bravo"))!;
    fireEvent.click(within(bravo).getByLabelText("Attach by a join"));
    fireEvent.change(within(bravo).getByLabelText("Its join"), { target: { value: "west" } });
    fireEvent.change(within(bravo).getByLabelText("at its join"), { target: { value: "east" } });
    expect(modulesNow()).toEqual([
      { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
      { slug: "b", placement: { kind: "attached", join: "west", to: "a", toJoin: "east" } },
    ]);
    expect(within(bravo).getByText("Its West joins Alpha's East")).toBeInTheDocument();

    // Back to free placement keeps it exactly where the joins put it.
    fireEvent.click(within(bravo).getByLabelText("Place freely"));
    expect((modulesNow() as unknown[])[1]).toEqual({
      slug: "b",
      placement: { kind: "at", x: 200, y: 0 },
    });
  });

  it("shows why modules don't fit", () => {
    const start = doc({
      id: "assembled",
      modules: [
        { slug: "a", placement: { kind: "at", x: 0, y: 0 } },
        { slug: "b", placement: { kind: "attached", join: "nope", to: "a", toJoin: "east" } },
      ],
    });
    render(<Harness start={start} modules={[module("a"), module("b")]} />);
    expect(screen.getByRole("list", { name: "Module problems" })).toHaveTextContent(
      'Module b has no join "nope"',
    );
  });
});

describe("JoinsPanel", () => {
  it("renames and deletes a module's joins", () => {
    render(
      <EditorStateProvider initialDocument={module("a").draft!}>
        <JoinsPanel moduleSlug="a" usedBy={["carlisle"]} onOpen={vi.fn()} />
        <JoinsProbe />
      </EditorStateProvider>,
    );
    const names = screen.getAllByLabelText("Join name");
    fireEvent.change(names[0]!, { target: { value: "To Preston" } });
    fireEvent.blur(names[0]!);
    expect(screen.getByTestId("joins")).toHaveTextContent('"To Preston"');

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]!);
    expect(JSON.parse(screen.getByTestId("joins").textContent!)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "carlisle" })).toHaveAttribute(
      "href",
      "/editor/a?in=carlisle",
    );
  });
});

function JoinsProbe(): JSX.Element {
  const { document } = useEditorState();
  return <pre data-testid="joins">{JSON.stringify(document.joins ?? [])}</pre>;
}
