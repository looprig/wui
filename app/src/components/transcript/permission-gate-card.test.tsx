import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { GATE_APPROVAL_ACTIONS } from "@looprig/protocol";
import { openGate } from "../../test/gates";
import { PermissionGateCard } from "./permission-gate-card";

function actionLabels(): string[] {
  return [...document.querySelectorAll("[data-testid^=gate-action-]")].map((b) => b.textContent ?? "");
}

describe("PermissionGateCard", () => {
  it("offers exactly three actions, spelled the way harness matches them", async () => {
    // gate.ParseApprovalAction does an EXACT string match and rejects anything
    // else with gate_action_invalid. A lowercased or reworded label here is a
    // button that can only ever fail.
    render(<PermissionGateCard gate={openGate()} onRespond={vi.fn()} />);
    await expect.element(page.getByTestId("permission-gate-card")).toBeInTheDocument();
    expect(actionLabels()).toEqual([
      "Approve",
      "Approve always for this workspace",
      "Deny",
    ]);
  });

  it("dispatches the exact wire string for each action", async () => {
    const onRespond = vi.fn();
    render(<PermissionGateCard gate={openGate()} onRespond={onRespond} />);
    await expect.element(page.getByTestId("gate-action-approve")).toBeInTheDocument();

    await userEvent.click(page.getByTestId("gate-action-approve"));
    await userEvent.click(page.getByTestId("gate-action-always"));
    await userEvent.click(page.getByTestId("gate-action-deny"));
    expect(onRespond.mock.calls).toEqual([
      [GATE_APPROVAL_ACTIONS.approve],
      [GATE_APPROVAL_ACTIONS.approveAlwaysWorkspace],
      [GATE_APPROVAL_ACTIONS.deny],
    ]);
  });

  it("shows the prompt and says plainly that there is no mutation preview", async () => {
    render(<PermissionGateCard gate={openGate()} onRespond={vi.fn()} />);
    const title = page.getByTestId("gate-prompt-title");
    await expect.element(title).toBeInTheDocument();
    expect(title.element().textContent).toBe("Run a shell command");
    expect(document.querySelector("[data-testid=gate-prompt-body]")?.textContent).toBe("go test ./...");
    // PermissionRequested.Preview reaches neither the journal nor the wire
    // (design §3a). Saying so beats implying the diff was reviewed.
    expect(document.querySelector("[data-testid=gate-no-preview]")).not.toBeNull();
  });

  it("keeps Deny enabled while an approval is in flight", async () => {
    // Fail-secure: a user who changes their mind mid-request must always be
    // able to say no. The loser of a double answer gets gate_action_invalid,
    // which is rendered as "already answered" rather than as a lost decision.
    render(<PermissionGateCard gate={openGate({ responding: true })} onRespond={vi.fn()} />);
    const deny = page.getByTestId("gate-action-deny");
    await expect.element(deny).toBeInTheDocument();
    expect((deny.element() as HTMLButtonElement).disabled).toBe(false);
    expect((page.getByTestId("gate-action-approve").element() as HTMLButtonElement).disabled).toBe(true);
    expect((page.getByTestId("gate-action-always").element() as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a failed response with the error's own message and leaves the gate answerable", async () => {
    const failure = new Error("network error");
    render(<PermissionGateCard gate={openGate({ error: failure })} onRespond={vi.fn()} />);
    const error = page.getByTestId("gate-error");
    await expect.element(error).toBeInTheDocument();
    expect(error.element().textContent).toBe("network error");
    expect(error.element().getAttribute("role")).toBe("alert");
    expect((page.getByTestId("gate-action-deny").element() as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops offering actions once another client has answered", async () => {
    // gate_action_invalid means the decision was already made elsewhere.
    // Leaving the buttons live would offer a choice that can only ever fail,
    // and imply the user still holds a decision they do not.
    render(<PermissionGateCard gate={openGate({ alreadyAnswered: true })} onRespond={vi.fn()} />);
    const answered = page.getByTestId("gate-already-answered");
    await expect.element(answered).toBeInTheDocument();
    expect(actionLabels()).toEqual([]);
  });

  it("names the tool call the decision is about", async () => {
    // gate.subject is what lets a human tell WHICH parked call they are
    // approving when two are open at once.
    render(<PermissionGateCard gate={openGate()} onRespond={vi.fn()} />);
    const subject = page.getByTestId("gate-subject");
    await expect.element(subject).toBeInTheDocument();
    expect(subject.element().textContent).toContain("toolu_1");
  });

  it("falls back to a title when the prompt carries none", async () => {
    const bare = openGate();
    render(
      <PermissionGateCard
        gate={{ ...bare, prompt: { ...bare.prompt, title: "", body: "" } }}
        onRespond={vi.fn()}
      />,
    );
    const title = page.getByTestId("gate-prompt-title");
    await expect.element(title).toBeInTheDocument();
    expect(title.element().textContent).toBe("Permission required");
    expect(document.querySelector("[data-testid=gate-prompt-body]")).toBeNull();
  });

  it("is blue, because approvals are the human's decision", async () => {
    // §12: lime does, blue decides. An approval rendered lime reads as "go make
    // the LLM do something", which is the opposite of what is being asked.
    render(<PermissionGateCard gate={openGate()} onRespond={vi.fn()} />);
    const title = page.getByTestId("gate-prompt-title");
    await expect.element(title).toBeInTheDocument();
    expect(getComputedStyle(title.element()).color).toBe("rgb(162, 210, 255)");
  });
});
