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
        {/* Why */}
        <section>
          <h2 className="text-2xl font-bold mb-4">Why</h2>
          <p className="leading-relaxed mb-4">
            The standard transaction lifecycle: sign, broadcast to leader, wait
            for block inclusion + confirmation, can impose a practical latency
            and throughput bottleneck for applications.
          </p>
          <p className="leading-relaxed mb-4">
            For some applications, it's worth making tradeoffs for better user
            experience and less composability. These tradeoffs are only
            applicable at the application level, and are all opt-in. This design
            is not meant for infrastructure like USDC.
          </p>
          <p className="leading-relaxed mb-4">
            Polymarket is an example application that is willing to make these
            tradeoffs.
          </p>
          <p className="leading-relaxed">
            Monad can{" "}
            <strong>empower developers beyond "EVM but faster"</strong>.
          </p>
        </section>

        {/* Overview */}
        <section>
          <h2 className="text-2xl font-bold mb-4">How it works</h2>
          <p className="leading-relaxed mb-4">
            The /fast page uses a verticalized application architecture with a
            server as an intermediary between clients and the Monad network.
            Apps get faster confirmation (~50ms) and more ownership over their
            transaction lifecycle.
          </p>

          <pre className="text-xs leading-snug overflow-x-auto bg-zinc-900 text-zinc-300 rounded-lg p-4 mt-4">
            {`   Client                        Server                     Monad Network
      |                             |                             |
      |  (1) Sign transfer tx       |                             |
      |                             |                             |
      |  (2) POST /api/transfer     |                             |
      |-------------------------->  |                             |
      |                             |                             |
      |  (3) 200 OK                 |                             |
      |<--------------------------  |                             |
      |                             |                             |
      |                             |  (4) Submit tx batch        |
      |                             |-------------------------->  |
      |                             |  (5) Receipt                |
      |                             |<--------------------------  |
      |                             |                             |`}
          </pre>
        </section>

        {/* Protocol */}
        <section>
          <h2 className="text-2xl font-bold mb-4">Protocol</h2>
          <p className="leading-relaxed mb-4">
            The smart contract has several features that enable faster and more
            scalable execution.
          </p>
          <h3 className="text-lg font-semibold mb-4">
            Application-level account system
          </h3>
          <p className="leading-relaxed mb-4">
            The account system supports gas sponsorship, nonce management, and
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

// or 

struct Account {
    bytes32 id;
    Key[] keys;
    mapping(uint192 => uint64) nonceSeqs;
    uint256 balance;
}
`}
          />
          <h3 className="text-lg font-semibold mb-2">Privileged "scheduler"</h3>
          <p className="leading-relaxed mb-4">
            The scheduler submits transactions on behalf of users. It blocks
            transactions that run before it in the same block.
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
            The scheduler processes many user transactions at once.
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
            state with merklization into a single bytes32 word (or 4kb page),
            improving gas costs.
          </p>
        </section>

        {/* Server */}
        <section>
          <h2 className="text-2xl font-bold mb-4">Server</h2>
          <p className="leading-relaxed mb-4">
            The server acts as an intermediary between clients (browsers) and
            the Monad nodes. Clients don't interact with Monad nodes directly.
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
            Because the scheduler <strong>knows it cannot be front-run</strong>,
            it can deterministically simulate transactions without broadcasting
            them and waiting for an onchain receipt.
          </p>
          <p className="leading-relaxed mb-4">
            The server keeps track of all the relevant application state and can
            update it immediately when receives a transaction from a user.
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
          <table className="w-full text-sm mb-4 border border-black">
            <thead>
              <tr className="border-b border-black text-left">
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Latency</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-black">
                <td className="px-3 py-2 font-semibold">pending</td>
                <td className="px-3 py-2">Signed by the client</td>
                <td className="px-3 py-2">—</td>
              </tr>
              <tr className="border-b border-black bg-emerald-400">
                <td className="px-3 py-2 font-semibold">accepted</td>
                <td className="px-3 py-2">Confirmed by server</td>
                <td className="px-3 py-2">~50ms</td>
              </tr>
              <tr className="border-b border-black">
                <td className="px-3 py-2 font-semibold">proposed</td>
                <td className="px-3 py-2">Included in a block</td>
                <td className="px-3 py-2">~250ms</td>
              </tr>
              <tr className="border-b border-black">
                <td className="px-3 py-2 font-semibold">voted</td>
                <td className="px-3 py-2">1 validator confirmation</td>
                <td className="px-3 py-2">~650ms</td>
              </tr>
              <tr className="border-b border-black">
                <td className="px-3 py-2 font-semibold">finalized</td>
                <td className="px-3 py-2">2 validator confirmations</td>
                <td className="px-3 py-2">~1050ms</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-semibold">verified</td>
                <td className="px-3 py-2">5+ validator confirmations</td>
                <td className="px-3 py-2">~2250ms</td>
              </tr>
            </tbody>
          </table>
          <p className="leading-relaxed mb-4">
            The server can "accept" a transaction and submit it onchain later.
            FIFO ordering makes this especially simple — each transfer is
            processed immediately when it arrives.
          </p>
          <CodeBlock
            title="server.ts"
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

        {/* Trust Assumptions */}
        <section>
          <h2 className="text-2xl font-bold mb-4">Trust assumptions</h2>

          <h3 className="text-lg font-semibold mb-2">Ordering</h3>
          <p className="leading-relaxed mb-4">
            The scheduler submits transactions on behalf of users and blocks
            others from doing so. Users trust that it will not reorder or censor
            transactions for its own benefit.
          </p>

          <h3 className="text-lg font-semibold mb-2">Inclusion</h3>
          <p className="leading-relaxed mb-4">
            The "accepted" state is a promise from the server, not an onchain
            guarantee. Users trust that the scheduler will actually submit
            accepted transactions onchain.
          </p>

          <h2 className="text-2xl font-bold mb-4 mt-8">Mitigations</h2>

          <h3 className="text-lg font-semibold mb-2">Signed receipts</h3>
          <p className="leading-relaxed mb-4">
            The server could sign its "accepted" responses, giving clients a
            cryptographic proof that the server committed to including their
            transaction. If the server fails to include it, the client has the
            signed receipt as evidence.
          </p>

          <h3 className="text-lg font-semibold mb-2">Transaction chaining</h3>
          <p className="leading-relaxed mb-4">
            Users can declare that a transaction is only valid if a previous
            transaction with a specific nonce has already been executed. This
            lets clients take advantage of the "accepted" state without blindly
            trusting the server.
          </p>

          <h3 className="text-lg font-semibold mb-2">Force inclusion</h3>
          <p className="leading-relaxed mb-4">
            If the scheduler is unresponsive or censoring, users can bypass it
            and submit transactions directly to the contract. This is slower but
            removes the dependency on the scheduler.
          </p>
        </section>
      </main>
    </div>
  );
}
