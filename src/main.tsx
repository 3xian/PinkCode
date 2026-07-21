import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('Missing root element: expected <div id="root"> in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Drop the HTML boot splash once React has painted the shell.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById("boot-splash");
    if (!splash) return;
    splash.classList.add("done");
    window.setTimeout(() => splash.remove(), 220);
  });
});
