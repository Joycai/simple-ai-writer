import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/fonts";
import "../../src/styles/global.css";
import { applyThemeId } from "../../src/lib/theme/scheme";
import { Studio } from "./Studio";
import "./studio.css";

applyThemeId("paper", "light");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Studio />
  </StrictMode>,
);
