/**
 * src/main.tsx
 * React 19 앱 진입점 — createRoot 사용
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";
import App from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
