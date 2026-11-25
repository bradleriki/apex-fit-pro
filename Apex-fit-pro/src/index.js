import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Capacitor } from "@capacitor/core";
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<React.StrictMode><App /></React.StrictMode>);

// Register the service worker in production web builds so the site can be installed on a phone.
// Not needed inside the Android app, which already has everything on the device.
if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator && !Capacitor.isNativePlatform()) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
