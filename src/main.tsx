import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router";
import App from "./App";
import { DragSessionProvider } from "./contexts/DragSessionContext";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <DragSessionProvider>
        <App />
      </DragSessionProvider>
    </HashRouter>
  </React.StrictMode>,
);
