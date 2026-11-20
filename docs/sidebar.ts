export const sidebar = {
  "/docs/": [
    {
      text: "Introduction",
      items: [
        { text: "Get started", link: "/docs/get-started" },
        { text: "Why Typewriter", link: "/docs/why-typewriter" },
        { text: "Requirements", link: "/docs/requirements" },
      ],
    },
    {
      text: "Concepts",
      items: [
        { text: "Architecture", link: "/docs/concepts/architecture" },
        { text: "State", link: "/docs/concepts/state" },
        { text: "Mutations", link: "/docs/concepts/mutations" },
        { text: "Executing mutations", link: "/docs/concepts/executing" },
        {
          text: "Querying",
          items: [
            {
              text: "Current state",
              link: "/docs/concepts/querying/current-state",
            },
            {
              text: "Mutation history",
              link: "/docs/concepts/querying/mutation-history",
            },
            {
              text: "Live updates",
              link: "/docs/concepts/querying/live-updates",
            },
          ],
        },
        {
          text: "Accounts",
          items: [
            {
              text: "Accounts and credentials",
              link: "/docs/concepts/accounts/overview",
            },
            {
              text: "Authorization",
              link: "/docs/concepts/accounts/authorization",
            },
            {
              text: "Managing accounts",
              link: "/docs/concepts/accounts/managing",
            },
          ],
        },
      ],
    },
    {
      text: "Production",
      items: [
        { text: "Deployment", link: "/docs/production/deployment" },
        {
          text: "Chain integration",
          link: "/docs/production/chain-integration",
        },
        { text: "Force inclusion", link: "/docs/production/force-inclusion" },
      ],
    },
    {
      text: "Guides",
      items: [
        { text: "Local development", link: "/docs/guides/local-development" },
        {
          text: "Browser session keys",
          link: "/docs/guides/browser-session-keys",
        },
      ],
    },
    {
      text: "API reference",
      items: [],
    },
  ],
};
