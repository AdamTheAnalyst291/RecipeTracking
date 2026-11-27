import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./mealPlan/mealPlan.css";
import "./recipes/recipes.css";
import "./shopping/shopping.css";
import "./shell/shell.css";
import { App } from "./App.js";
import { registerServiceWorker } from "./pwa/register.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
registerServiceWorker();
