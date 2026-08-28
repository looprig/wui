import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import "./styles/theme.css";
import { createAppRouter } from "./router";

// StrictMode is on in the real app, not just under test: every hook in
// @looprig/react is pinned against the double-mount, and the one place that
// actually exercises it is a root-level StrictMode like this one.
const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={createAppRouter()} />
  </StrictMode>,
);
