import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import "./app.css";

// The iMessage mock-up ships generic class names (.nav, .thread, .composer). Loading it lazily keeps its CSS out of the real app.
// The lookbook is a design reference. It is only defined in dev, so the production build drops the chunk.
const IMessagePreview = import.meta.env.DEV ? lazy(() => import("./imessage/IMessagePreview.tsx").then((module) => ({ default: module.IMessagePreview }))) : null;

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
const imessageLook = IMessagePreview !== null && window.location.pathname === "/imessage";
createRoot(root).render(
  <StrictMode>
    {IMessagePreview && imessageLook ? (
      <Suspense fallback={null}>
        <IMessagePreview />
      </Suspense>
    ) : (
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    )}
  </StrictMode>,
);
