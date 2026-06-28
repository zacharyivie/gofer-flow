import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router-dom";
import { installGoferApiFetchAuth } from "./lib/api.js";
import App from "./pages/App.jsx";
import "./styles/index.css";

installGoferApiFetchAuth();

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
  },
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
