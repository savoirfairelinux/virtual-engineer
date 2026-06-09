import { createRoot } from "react-dom/client";
import { App, AppErrorBoundary } from "./App.tsx";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("No #root element");
createRoot(rootEl).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
