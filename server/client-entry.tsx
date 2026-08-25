import React from "react";
import { createRoot } from "react-dom/client";
import RoomApp from "../components/room-app";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Cinder Room could not find its application root.");
}

createRoot(root).render(
  <React.StrictMode>
    <RoomApp />
  </React.StrictMode>,
);
