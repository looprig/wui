import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { GATE_APPROVAL_ACTIONS } from "@looprig/protocol";
import { openGate } from "../../test/gates";
import { PermissionGateCard } from "./permission-gate-card";

async function focusCard(): Promise<void> {
  const card = page.getByTestId("permission-gate-card");
  await expect.element(card).toBeInTheDocument();
  (card.element() as HTMLElement).focus();
}

describe("PermissionGateCard hotkeys", () => {
  it("maps y, a and n to the three actions while the card has focus", async () => {
    const onRespond = vi.fn();
    render(<PermissionGateCard gate={openGate()} onRespond={onRespond} />);
    await focusCard();

    await userEvent.keyboard("y");
    await userEvent.keyboard("a");
    await userEvent.keyboard("n");
    expect(onRespond.mock.calls).toEqual([
      [GATE_APPROVAL_ACTIONS.approve],
      [GATE_APPROVAL_ACTIONS.approveAlwaysWorkspace],
      [GATE_APPROVAL_ACTIONS.deny],
    ]);
  });

  it("ignores the keys when focus is outside the card", async () => {
    // A document-level handler would approve a permission gate because someone
    // typed the letter y into the composer. That is the bug this test exists
    // for, and it is Capstan §7's gotcha taken verbatim.
    const onRespond = vi.fn();
    render(
      <>
        <input data-testid="elsewhere" />
        <PermissionGateCard gate={openGate()} onRespond={onRespond} />
      </>,
    );
    await userEvent.click(page.getByTestId("elsewhere"));
    // Typed, not `fill`ed. `userEvent.fill` sets the value through the driver
    // without dispatching a single keydown, so a document-level handler would
    // sail past it — measured: with the hotkeys moved onto `document`, the
    // `fill` version of this test still PASSED. Real keystrokes are the only
    // thing that discriminates a scoped handler from a global one.
    await userEvent.keyboard("y");
    await userEvent.keyboard("a");
    await userEvent.keyboard("n");
    expect(onRespond.mock.calls).toEqual([]);
    expect((page.getByTestId("elsewhere").element() as HTMLInputElement).value).toBe("yan");
  });

  it("ignores a modified keystroke", async () => {
    // Cmd-A is select-all and Ctrl-N opens a window. A gate that answered
    // itself on either would be answering a keystroke the user aimed at the
    // browser.
    const onRespond = vi.fn();
    render(<PermissionGateCard gate={openGate()} onRespond={onRespond} />);
    await focusCard();

    await userEvent.keyboard("{Meta>}a{/Meta}");
    await userEvent.keyboard("{Control>}n{/Control}");
    await userEvent.keyboard("{Alt>}y{/Alt}");
    expect(onRespond.mock.calls).toEqual([]);
  });

  it("keeps only Deny live on the keyboard while a response is in flight", async () => {
    // The same fail-secure rule as the buttons: approving twice is a lost race,
    // but changing your mind to no must always land.
    const onRespond = vi.fn();
    render(<PermissionGateCard gate={openGate({ responding: true })} onRespond={onRespond} />);
    await focusCard();

    await userEvent.keyboard("y");
    await userEvent.keyboard("a");
    await userEvent.keyboard("n");
    expect(onRespond.mock.calls).toEqual([[GATE_APPROVAL_ACTIONS.deny]]);
  });

  it("answers nothing once another client has answered", async () => {
    const onRespond = vi.fn();
    render(<PermissionGateCard gate={openGate({ alreadyAnswered: true })} onRespond={onRespond} />);
    await focusCard();

    await userEvent.keyboard("y");
    await userEvent.keyboard("n");
    expect(onRespond.mock.calls).toEqual([]);
  });
});
