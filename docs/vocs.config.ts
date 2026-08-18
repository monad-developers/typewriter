import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "Typewriter",
  description:
    "A framework for crypto apps that need custom transaction sequencing, fast confirmations, and built-in gas sponsorship.",
  sidebar: [
    {
      text: "Introduction",
      items: [
        { text: "What is Typewriter?", link: "/" },
        { text: "How it works", link: "/how-it-works" },
        { text: "Concepts", link: "/concepts" },
      ],
    },
    {
      text: "Guides",
      items: [
        { text: "Get started", link: "/guides/get-started" },
        { text: "Project structure", link: "/guides/project-structure" },
        {
          text: "Define your state and mutations",
          link: "/guides/state-and-mutations",
        },
        { text: "Authorize mutations", link: "/guides/authorize-mutations" },
        {
          text: "Sequence transactions",
          link: "/guides/sequence-transactions",
        },
        { text: "Write API endpoints", link: "/guides/api-endpoints" },
      ],
    },
    {
      text: "API Reference",
      items: [
        { text: "Solidity", link: "/reference/solidity" },
        { text: "TypeScript", link: "/reference/typescript" },
      ],
    },
    {
      text: "Examples",
      items: [
        { text: "Token", link: "/examples/token" },
        { text: "Order Book", link: "/examples/order-book" },
      ],
    },
  ],
});
