import { CodeBlock } from "../components/CodeBlock";

export function AboutFast() {
  return (
    <div className="min-h-screen w-full flex flex-col">
      {/* <div className="w-full border-b p-4 flex items-center gap-4">
        <a href="/fast" className="text-sm text-blue-500 hover:underline">
          ← Back
        </a>
      </div> */}

      <main className="max-w-3xl mx-auto px-6 py-10 flex flex-col gap-8 font-mono">
        {/* Overview */}
        <section>
          <p className="leading-relaxed mb-4">
            The /fast page is powered by a verticalized application
            architecture. It maximizes performance by giving applications more
            ownership over their transaction lifecycle.
          </p>
          <p className="leading-relaxed">
            It allows Monad to{" "}
            <strong>empower developers beyond "EVM but faster"</strong>.
          </p>

          {/* TODO(kyle) request flow */}
        </section>

        {/* Protocol */}
        <section>
          <h2 className="text-2xl font-bold mb-4">Protocol</h2>
          <p className="leading-relaxed mb-4">
            The smart contract has a several features that enable faster and
            more scalable execution.
          </p>
          <h3 className="text-lg font-semibold mb-4">
            Application-level account system
          </h3>
          <p className="leading-relaxed mb-4">
            The account system supports gas sponsorship, nonce managagement, and
            modern signature schemes.
          </p>
          <CodeBlock
            title="Transfer.sol"
            lang="solidity"
            code={`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct Account {
    address addr;
    uint256 nonce;
    uint256 balance;
}
`}
          />
          <h3 className="text-lg font-semibold mb-2">Privileged "scheduler"</h3>
          <p className="leading-relaxed mb-4">
            The scheduler submits transactions on behalf of users. It has a
            short-term monopoly over ordering transactions.
          </p>
          <p className="leading-relaxed mb-4">
            However, users can submit transactions while the scheduler is
            unresponsive or censoring with a fallback "force-inclusion"
            mechanism.
          </p>
          <CodeBlock
            title="Transfer.sol"
            lang="solidity"
            code={`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Token {
    address private immutable scheduler;

    function execute(/* ... */) external {
        if (msg.sender != scheduler) {
            revert("Only scheduler can execute");
        }
    }

    // ... force inclusion without scheduler
}
`}
          />

          <h3 className="text-lg font-semibold mb-2">Batched execution</h3>
          <p className="leading-relaxed mb-4">
            The scheduler processes many users transactions at once.
          </p>
          <CodeBlock
            title="Transfer.sol"
            lang="solidity"
            code={`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

function execute(Transfer[] calldata transfers) external {
    // ... check scheduler

    for (uint256 i = 0; i < transfers.length; i++) {
        // ... process transfers[i]
    }
}
`}
          />
          <h3 className="text-lg font-semibold mb-2">
            State compression with Merkle proofs
          </h3>

          <p className="leading-relaxed">
            While not implemented in this demo, the scheduler could compress
            state with merklization into a single bytes32 word, improving gas
            costs.
          </p>
        </section>

        {/* Server */}
        <section>
          <h2 className="text-2xl font-bold mb-4">Server</h2>
          <p className="leading-relaxed mb-4">
            The server acts as an intermediary between clients (browsers) and
            the Monad nodes. Clients don't interact with the network directly.
          </p>

          <h3 className="text-lg font-semibold mb-2">Transaction ordering</h3>
          <p className="leading-relaxed mb-4">
            The server controls the "scheduler" address in the protocol. It
            submits transactions for users and has control over their ordering.
          </p>

          <h3 className="text-lg font-semibold mb-2">
            Deterministic execution
          </h3>
          <p className="leading-relaxed mb-4">
            Because the scheduler has a short-term monopoly in the protocol, it
            can deterministically execute transactions without waiting for an
            onchain receipt.
          </p>
          <CodeBlock
            title="State shape"
            lang="ts"
            code={`const handleTransfer = (state: State, transfer: Transfer) => {
  const fromBalance = state.accounts[transfer.from]?.balance ?? 0n;
  const fromNonce = state.accounts[transfer.from]?.nonce ?? 0;

  state.accounts[transfer.from] = {
    balance: fromBalance - transfer.amount,
    nonce: fromNonce + 1,
  };
  state.accounts[transfer.to].balance = {
    balance: (state.accounts[transfer.to]?.balance ?? 0n) + transfer.amount,
    nonce: state.accounts[transfer.to]?.nonce ?? 0,
  };
}`}
          />

          <h3 className="text-lg font-semibold mb-2">
            "accepted" transaction state
          </h3>
          <p className="leading-relaxed mb-4">
            The "accepted" status is a server-side confirmation that the
            transfer is valid and will be included, no onchain receipt required.
          </p>

          <p className="leading-relaxed mb-4">
            With FIFO ordering, the server can issue this confirmation immediately.
          </p>
          <CodeBlock
            title="Transfer.sol"
            lang="typescript"
            code={`const state = {/* ... */};

const server = serve({
  routes: {
    "/api/transfer": {
      POST: async (req) => {
        const transfer = await req.json();

        // ... validate request

        handleTransfer(state, transfer);

        // ... schedule transaction for onchain execution

        // transaction is "accepted" without waiting for onchain receipt
        return Response.json({ id: transfer.id }, { status: 200 });
      }
    }
  }
});`}
          />
        </section>
      </main>
    </div>
  );
}
