import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import "./app.css";

// The iMessage mock-up ships generic class names (.nav, .thread, .composer). Loading it lazily keeps its CSS out of the real app.
const IMessagePreview = lazy(() => import("./imessage/IMessagePreview.tsx").then((module) => ({ default: module.IMessagePreview })));

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
// The lookbook is a design reference, so it is not part of the production build.
const imessageLook = import.meta.env.DEV && window.location.pathname === "/imessage";
createRoot(root).render(
  <StrictMode>
    {imessageLook ? (
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
