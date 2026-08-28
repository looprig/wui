// Proves the runner itself works: React 19 + vitest-browser-react mounting a
// component in real headless Chromium. If this fails, nothing else in Phase 5
// can be trusted to be testing what it claims.
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

function Smoke(): React.JSX.Element {
  return <p data-testid="smoke">wui</p>;
}

describe("test runner", () => {
  it("mounts a React component in a real browser", async () => {
    render(<Smoke />);
    await expect.element(page.getByTestId("smoke")).toHaveTextContent("wui");
  });
});
