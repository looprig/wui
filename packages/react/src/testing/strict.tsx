/**
 * `renderHook` under a REAL StrictMode double-mount.
 *
 * ## Why `vitest-browser-react`'s own `wrapper` is not enough — measured
 *
 * 04-react.md (Tasks 4.8 and 4.17) opts into StrictMode with
 * `renderHook(hook, { wrapper: strict })`, where `strict` renders
 * `<StrictMode>{children}</StrictMode>`. That does NOT double-invoke effects.
 * Measured on 2026-08-28 against react 19.2.8 + vitest-browser-react 2.2.0, one
 * `useEffect(fn, [])` counting its own mounts:
 *
 *   render(<StrictMode><C/></StrictMode>)              -> 2 mounts, 1 cleanup
 *   render(<Wrapper/>), StrictMode inside Wrapper      -> 1 mount,  0 cleanups
 *   render(<Wrapper><C/></Wrapper>), same as `wrapper` -> 1 mount,  0 cleanups
 *
 * The double-RENDER still happens one level down (the hook body runs twice), so
 * the tree really is in strict mode — it is only the mount/unmount/remount
 * simulation that is driven by the root. `vitest-browser-react` applies
 * `wrapper` INSIDE the root element (`strictModeIfNeeded(wrapUiIfNeeded(ui,
 * Wrapper))`), so a wrapper can never put StrictMode at the root.
 *
 * That makes the plan's Task 4.8 hollow as written: its assertion is
 * `openCount - closedCount === 1`, which a single mount satisfies trivially.
 * This helper puts `StrictMode` at the root element instead, which is the one
 * arrangement that produces the remount, and `strict.test.tsx` pins that.
 *
 * `configure({ reactStrictMode: true })` from `vitest-browser-react/pure` would
 * also reach the root, but its `config` lives in a different optimized bundle
 * from the default entry's `render` (verified: toggling it there leaves the
 * default entry's render single-pass), and switching every render in this file
 * to `/pure` would also drop the global `beforeEach(cleanup)` the setup file
 * registers.
 */
import { StrictMode, useEffect } from "react";
import { render } from "vitest-browser-react";

export interface StrictHookResult<T> {
  /** The value the last COMMITTED render produced, mirroring `renderHook`'s own ref. */
  readonly result: { readonly current: T };
  rerender: () => Promise<void>;
  unmount: () => Promise<void>;
}

export async function renderHookStrict<T>(hook: () => T): Promise<StrictHookResult<T>> {
  const result: { current: T } = { current: undefined as T };

  function Harness(): null {
    const value = hook();
    useEffect(() => {
      result.current = value;
    });
    return null;
  }

  const tree = (
    <StrictMode>
      <Harness />
    </StrictMode>
  );
  const rendered = await render(tree);
  return {
    result,
    rerender: () => rendered.rerender(tree),
    unmount: () => rendered.unmount(),
  };
}
