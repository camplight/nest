import { BrandingProvider } from "../../nest-brand/BrandingProvider";
import { apiUrl } from "./config";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { FileViewerProvider } from "./canvas/FileViewer";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrandingProvider endpoint={apiUrl("/api/branding")} title="Workspace"><FileViewerProvider><App /></FileViewerProvider></BrandingProvider>
  </React.StrictMode>
);
