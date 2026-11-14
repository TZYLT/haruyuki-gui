/**
 * Browser entry for the sample page.
 *
 * Exists so the real-browser layout check has something to load. It reads the
 * locale from the query string -- the check drives it by navigating to
 * `?locale=zh-CN` -- and mounts the page. Nothing else: this file is test
 * scaffolding, not part of the package's API.
 */

import { createRoot } from "react-dom/client";

import { SamplePage } from "./SamplePage.js";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("sample page needs a #root element");
}

const requested = new URLSearchParams(window.location.search).get("locale") ?? "en";

createRoot(container).render(<SamplePage locale={requested} />);
