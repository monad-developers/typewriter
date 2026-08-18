import { defineConfig } from "vocs";

export default defineConfig({
  // The docs project lives in the repo's top-level `docs/` directory, so keep
  // the Vocs content root flat (pages/ at this directory) rather than the
  // default nested `docs/` to avoid a `docs/docs/pages` layout.
  rootDir: ".",
  title: "Typewriter",
  description:
    "A framework for crypto apps that need custom transaction sequencing, fast confirmations, and built-in gas sponsorship.",
  sidebar: [
    {
      text: "What is Typewriter?",
      link: "/",
    },
  ],
});
