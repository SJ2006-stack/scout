import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./app.css";

// The iMessage mock-up ships generic class names (.nav, .thread, .composer). Loading it lazily keeps its CSS out of the real app.
const IMessagePreview = lazy(() => import("./imessage/IMessagePreview.tsx").then((module) => ({ default: module.IMessagePreview })));

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
const imessageLook = window.location.pathname === "/imessage";
createRoot(root).render(
  <StrictMode>
    {imessageLook ? (
      <Suspense fallback={null}>
        <IMessagePreview />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
