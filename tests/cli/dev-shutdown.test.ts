import { describe, it, expect, vi } from "vitest";
import { createDevShutdown, type ChildHandle } from "@/cli/commands/dev";

const makeChild = (exitCode: number | null = null) => {
  let closeCb: (() => void) | undefined;
  const child: ChildHandle & { triggerClose: () => void } = {
    kill: vi.fn(),
    exitCode,
    onClose: (cb) => {
      closeCb = cb;
    },
    triggerClose: () => closeCb?.(),
  };
  return child;
};

const makeHarness = (child: ChildHandle | null) => {
  const cleanup = vi.fn();
  const exit = vi.fn();
  let scheduled: { fn: () => void; ms: number } | undefined;
  const cancel = vi.fn();
  const schedule = vi.fn((fn: () => void, ms: number) => {
    scheduled = { fn, ms };
    return cancel;
  });
  const { onSignal } = createDevShutdown({
    child,
    cleanup,
    exit,
    schedule,
    forceKillMs: 1000,
  });
  return { onSignal, cleanup, exit, schedule, cancel, fireTimer: () => scheduled?.fn() };
};

describe("createDevShutdown", () => {
  it("first signal sends SIGTERM and arms a force-kill timer without exiting yet", () => {
    const child = makeChild(null);
    const h = makeHarness(child);

    h.onSignal();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(h.schedule).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it("exits and cleans up when the child closes after SIGTERM", () => {
    const child = makeChild(null);
    const h = makeHarness(child);

    h.onSignal();
    child.triggerClose();

    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("force-kills and exits if the child never closes (timer fires)", () => {
    const child = makeChild(null);
    const h = makeHarness(child);

    h.onSignal();
    h.fireTimer();

    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("a second signal force-kills and exits immediately", () => {
    const child = makeChild(null);
    const h = makeHarness(child);

    h.onSignal();
    h.onSignal();

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("exits immediately when the child has already exited", () => {
    const child = makeChild(0);
    const h = makeHarness(child);

    h.onSignal();

    expect(child.kill).not.toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("exits immediately when there is no child (e.g. --no-server)", () => {
    const h = makeHarness(null);

    h.onSignal();

    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("only finishes once even if close fires after a force timer", () => {
    const child = makeChild(null);
    const h = makeHarness(child);

    h.onSignal();
    h.fireTimer();
    child.triggerClose();

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });
});
