import { defineConfig } from "vocs/config";
import { sidebar } from "./sidebar.ts";

export default defineConfig({
  title: "Typewriter",
  titleTemplate: "%s – Typewriter",
  description:
    "A framework for crypto apps that need custom transaction sequencing, fast confirmations, and built-in gas sponsorship.",
  rootDir: ".",
  srcDir: ".",
  twoslash: false,
  redirects: [{ source: "/", destination: "/docs/get-started" }],
  sidebar,
  topNav: [
    { text: "Docs", link: "/docs/get-started", match: "/docs" },
    {
      text: "Examples",
      link: "https://github.com/monad-developers/typewriter/tree/main/apps",
    },
  ],
  socials: [
    { icon: "github", link: "https://github.com/monad-developers/typewriter" },
  ],
});
