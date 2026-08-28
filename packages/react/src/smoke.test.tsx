import { useState } from "react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

// Proves the whole toolchain end to end: React 19 renders, Playwright's
// Chromium dispatches a REAL click (not a synthesized event), and Vitest's
// retry-able `expect.element` sees the committed update. If this passes,
// every later task in this phase is a matter of application code.
function Counter(): React.ReactElement {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN((prev) => prev + 1)}>
      count {n}
    </button>
  );
}

test("browser mode renders React 19 and dispatches a real click", async () => {
  const screen = await render(<Counter />);
  await expect.element(screen.getByRole("button")).toHaveTextContent("count 0");
  await screen.getByRole("button").click();
  await expect.element(screen.getByRole("button")).toHaveTextContent("count 1");
});
