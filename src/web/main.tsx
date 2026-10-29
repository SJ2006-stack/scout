import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { IMessagePreview } from "./imessage/IMessagePreview.tsx";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
const imessageLook = window.location.pathname === "/imessage";
createRoot(root).render(
  <StrictMode>
    {imessageLook ? <IMessagePreview /> : <App />}
  </StrictMode>,
);
