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
        { text: "State", link: "/docs/concepts/state" },
        {
          text: "Mutations",
          items: [
            {
              text: "Define mutations",
              link: "/docs/concepts/mutations/define",
            },
            {
              text: "Determinism",
              link: "/docs/concepts/mutations/determinism",
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
            { text: "Sign mutations", link: "/docs/concepts/accounts/signing" },
            { text: "Nonces", link: "/docs/concepts/accounts/nonces" },
          ],
        },
        {
          text: "Execution",
          items: [
            {
              text: "Execute mutations",
              link: "/docs/concepts/execution/execute",
            },
            { text: "Lifecycle", link: "/docs/concepts/execution/lifecycle" },
            { text: "Ordering", link: "/docs/concepts/execution/ordering" },
          ],
        },
        {
          text: "Querying",
          items: [
            { text: "Read state", link: "/docs/concepts/querying/state" },
            { text: "Mutation tables", link: "/docs/concepts/querying/tables" },
            { text: "Events", link: "/docs/concepts/querying/events" },
          ],
        },
      ],
    },
    {
      text: "Production",
      items: [
        {
          text: "Deploy the contract",
          link: "/docs/production/deploy-contract",
        },
        { text: "Self-hosting", link: "/docs/production/self-hosting" },
        {
          text: "Chain integration",
          items: [
            {
              text: "Chain requirements",
              link: "/docs/production/chain-requirements",
            },
            {
              text: "Transaction submission",
              link: "/docs/production/transaction-submission",
            },
            { text: "Reorgs", link: "/docs/production/reorgs" },
            {
              text: "Force inclusion",
              link: "/docs/production/force-inclusion",
            },
          ],
        },
        { text: "Restarts", link: "/docs/production/restarts" },
      ],
    },
    {
      text: "Guides",
      items: [
        { text: "Passkeys", link: "/docs/guides/passkeys" },
        { text: "Session keys", link: "/docs/guides/session-keys" },
        { text: "HTTP server", link: "/docs/guides/http-server" },
        { text: "Read models", link: "/docs/guides/read-models" },
      ],
    },
    {
      text: "API reference",
      items: [
        {
          text: "typewriter",
          items: [
            {
              text: "createTypewriter",
              link: "/docs/api-reference/typewriter/create-typewriter",
            },
            {
              text: "Typewriter instance",
              link: "/docs/api-reference/typewriter/instance",
            },
            { text: "Events", link: "/docs/api-reference/typewriter/events" },
            {
              text: "Database reference",
              link: "/docs/api-reference/typewriter/database",
            },
            { text: "Errors", link: "/docs/api-reference/typewriter/errors" },
          ],
        },
        { text: "typewriter/client", link: "/docs/api-reference/client" },
        {
          text: "Typewriter.sol",
          items: [
            {
              text: "Contract requirements",
              link: "/docs/api-reference/contract/requirements",
            },
            {
              text: "Authorization",
              link: "/docs/api-reference/contract/authorization",
            },
            {
              text: "Built-in mutations",
              link: "/docs/api-reference/contract/built-in-mutations",
            },
            {
              text: "Force inclusion",
              link: "/docs/api-reference/contract/force-inclusion",
            },
            {
              text: "Determinism rules",
              link: "/docs/api-reference/contract/determinism",
            },
          ],
        },
      ],
    },
  ],
};
