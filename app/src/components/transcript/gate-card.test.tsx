import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  GATE_KIND_ASK_USER,
  GATE_KIND_FORM,
  GATE_KIND_OPEN_URL,
  GATE_KIND_PERMISSION,
} from "@looprig/protocol";
import { openGate } from "../../test/gates";
import { GateCard } from "./gate-card";

describe("GateCard", () => {
  it("renders the answerable card for a permission gate", async () => {
    render(<GateCard gate={openGate({ kind: GATE_KIND_PERMISSION })} onRespond={vi.fn()} />);
    await expect.element(page.getByTestId("permission-gate-card")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=unsupported-gate-card]")).toBeNull();
  });

  it.each([GATE_KIND_ASK_USER, GATE_KIND_FORM, GATE_KIND_OPEN_URL])(
    "renders the answer-in-the-TUI card for %s",
    async (kind) => {
      render(<GateCard gate={openGate({ kind })} onRespond={vi.fn()} />);
      const card = page.getByTestId("unsupported-gate-card");
      await expect.element(card).toBeInTheDocument();
      expect(card.element().getAttribute("data-gate-kind")).toBe(kind);
      expect(card.element().textContent).toContain("Answer this in the TUI");
      // No approve/deny anywhere: those actions belong to a resolver that never
      // declared them, and submitting one tells the user they resolved
      // something they did not.
      expect(document.querySelectorAll("[data-testid^=gate-action-]").length).toBe(0);
      expect(document.querySelector("[data-testid=permission-gate-card]")).toBeNull();
    },
  );

  it("treats an unknown future kind as unanswerable rather than guessing", async () => {
    // Allow-list, not deny-list. A kind harness adds later blocks the loop just
    // as hard, and the only safe render is one that says where to answer it.
    render(<GateCard gate={openGate({ kind: "harness.something_new" })} onRespond={vi.fn()} />);
    const card = page.getByTestId("unsupported-gate-card");
    await expect.element(card).toBeInTheDocument();
    expect(card.element().getAttribute("data-gate-kind")).toBe("harness.something_new");
  });

  it("still names the gate, so an unanswerable one is not an anonymous stall", async () => {
    // The failure mode this replaces is a session that looks idle forever
    // while a gate nobody rendered blocks the loop.
    render(<GateCard gate={openGate({ kind: GATE_KIND_ASK_USER })} onRespond={vi.fn()} />);
    const card = page.getByTestId("unsupported-gate-card");
    await expect.element(card).toBeInTheDocument();
    expect(card.element().textContent).toContain("Run a shell command");
    expect(card.element().textContent).toContain("4f5a6b7c-8d9e-4f0a-8b1c-2d3e4f5a6b7c");
    expect(card.element().getAttribute("role")).toBe("alert");
  });

  it("shows an open-url gate's validated origin, which is what the trust decision is about", async () => {
    // gate.ValidateGate enforces that `origin` is a bare scheme+host — no path,
    // query, fragment or userinfo — precisely so it can be displayed as an
    // origin structurally rather than by convention.
    const bare = openGate({ kind: GATE_KIND_OPEN_URL });
    render(
      <GateCard
        gate={{ ...bare, prompt: { ...bare.prompt, origin: "https://example.com" } }}
        onRespond={vi.fn()}
      />,
    );
    const origin = page.getByTestId("gate-origin");
    await expect.element(origin).toBeInTheDocument();
    expect(origin.element().textContent).toBe("https://example.com");
  });

  it("omits the origin line for a kind that never carries one", async () => {
    render(<GateCard gate={openGate({ kind: GATE_KIND_ASK_USER })} onRespond={vi.fn()} />);
    await expect.element(page.getByTestId("unsupported-gate-card")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=gate-origin]")).toBeNull();
  });
});
