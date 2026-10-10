import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaybackControls, type PlaybackControlsProps } from "./PlaybackControls.js";

function setup(overrides: Partial<PlaybackControlsProps> = {}): PlaybackControlsProps {
  return {
    atIso: "2026-09-03T09:30:00.000Z",
    playing: false,
    speed: 1,
    loading: false,
    atLiveEdge: false,
    quality: { status: "ok", gaps: [] },
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSpeed: vi.fn(),
    onJump: vi.fn(),
    onStep: vi.fn(),
    onReturnToLive: vi.fn(),
    ...overrides,
  };
}

describe("PlaybackControls", () => {
  it("shows the persistent Historical playback indicator and a Return to live button", () => {
    const props = setup();
    render(<PlaybackControls {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("Historical playback");
    fireEvent.click(screen.getByRole("button", { name: "Return to live" }));
    expect(props.onReturnToLive).toHaveBeenCalledOnce();
  });

  it("Jump is disabled until the time input changes, then calls onJump with the chosen ms", () => {
    const props = setup();
    render(<PlaybackControls {...props} />);
    const jump = screen.getByRole("button", { name: "Jump" });
    expect(jump).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Playback date and time"), {
      target: { value: "2026-09-03T08:00" },
    });
    expect(jump).toBeEnabled();
    fireEvent.click(jump);
    expect(props.onJump).toHaveBeenCalledWith(new Date("2026-09-03T08:00").getTime());
  });

  it("each step button calls onStep with its signed millisecond offset", () => {
    const props = setup();
    render(<PlaybackControls {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "-10s" }));
    fireEvent.click(screen.getByRole("button", { name: "+10m" }));
    expect(props.onStep).toHaveBeenNthCalledWith(1, -10_000);
    expect(props.onStep).toHaveBeenNthCalledWith(2, 600_000);
  });

  it("play toggles to pause and offers 0.25×–10× speeds", () => {
    const props = setup({ playing: true });
    render(<PlaybackControls {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(props.onPause).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "5" } });
    expect(props.onSpeed).toHaveBeenCalledWith(5);
    expect(screen.getByRole("option", { name: "0.25×" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "10×" })).toBeInTheDocument();
  });

  it("shows an admin the outage list, which they can minimise and which stays minimised", () => {
    window.localStorage.clear();
    const quality = {
      status: "stale" as const,
      gaps: ["TD PX feed gap 10:00–10:05 (unrecoverable; heartbeat lost)"],
      incomplete: true,
    };
    const { unmount } = render(<PlaybackControls {...setup({ quality })} />);
    expect(screen.getByLabelText("Feed gap warnings")).toHaveTextContent("feed gap 10:00–10:05");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /1 outage warning/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Feed gap warnings")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Remembered in this browser.
    unmount();
    render(<PlaybackControls {...setup({ quality })} />);
    expect(screen.queryByLabelText("Feed gap warnings")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /1 outage warning/ }));
    expect(screen.getByLabelText("Feed gap warnings")).toBeInTheDocument();
    window.localStorage.clear();
  });

  it("shows a non-admin only a small warning, with no outage details (owner, 2026-10-10)", () => {
    render(
      <PlaybackControls {...setup({ quality: { status: "stale", gaps: [], incomplete: true } })} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "Some data around this time may be incomplete.",
    );
    expect(screen.queryByLabelText("Feed gap warnings")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /outage/ })).not.toBeInTheDocument();
  });

  it("shows nothing about outages when there were none", () => {
    render(<PlaybackControls {...setup()} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Feed gap warnings")).not.toBeInTheDocument();
  });
});
