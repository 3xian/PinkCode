import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isMacosDesktop } from "./utils/platform";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('Missing root element: expected <div id="root"> in index.html');
}

// macOS Overlay titlebar: pad left rail for traffic lights + drag strip.
if (isMacosDesktop()) {
  document.documentElement.classList.add("platform-macos-desktop");
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
