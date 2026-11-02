import { expect, test } from "bun:test";
import solc from "solc";
import {
  formatSolidityDeclaration,
  parseSolidity,
  type SolcOutput,
} from "./sol-parse";
import { BUILTIN_MUTATIONS } from "./typewriter-constants";

const TYPEWRITER = await Bun.file(
  new URL("./Typewriter.sol", import.meta.url),
).text();

/**
 * Compiles `source` as App.sol with solc, next to Typewriter.sol, State.sol
 * (`struct State`), and `files`. Every file imports Typewriter.sol and
 * State.sol.
 */
function compile(source: string, files: Record<string, string> = {}) {
  const header =
    '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.21;\nimport "Typewriter.sol";\nimport "State.sol";\n';
  const sources = Object.fromEntries(
    Object.entries({ ...files, "App.sol": source }).map(([path, content]) => [
      path,
      { content: `${header}${content}` },
    ]),
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "Typewriter.sol": { content: TYPEWRITER },
          "State.sol": {
            content:
              "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.21;\nstruct State { uint256 total; }",
          },
          ...sources,
        },
        settings: {
          outputSelection: {
            "*": {
              "": ["ast"],
              "*": ["abi", "storageLayout", "evm.bytecode.object"],
            },
          },
        },
      }),
    ),
  );
  const errors = (
    output.errors as { severity: string; formattedMessage: string }[]
  )?.filter(({ severity }) => severity === "error");
  if (errors?.length) {
    throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
  }
  return output as SolcOutput;
}

function parse(source: string, files?: Record<string, string>) {
  return parseSolidity(compile(source, files), "App.sol");
}

/** The app's mutations, as `Name(id): type name, ...`. */
function mutations(source: string, files?: Record<string, string>): string[] {
  return Object.entries(parse(source, files).mutations)
    .filter(([name]) => !Object.hasOwn(BUILTIN_MUTATIONS, name))
    .map(
      ([name, { id, params }]) =>
        `${name}(${id}): ${params.map(({ name, type }) => `${type} ${name}`).join(", ")}`,
    );
}

/** A mutation library for `name`, whose struct has `fields`. */
function mutation(name: string, fields = "uint256 amount;"): string {
  return `
library ${name}Mutation {
    struct ${name} { ${fields} }

    function execute(State storage state, ${name} memory mutation, bytes32 accountID) internal {}
}`;
}

/** An app contract with `state`, the scheduler constructor, `dispatch`, and `body`. */
function app(body: string, name = "App"): string {
  return `
contract ${name} is Typewriter {
    State internal state;
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
    ${body}
}`;
}

const COUNTER = `
library AddMutation {
    struct Add {
        uint256 amount;
    }

    function execute(State storage state, Add memory add, bytes32) internal {
        state.total += add.amount;
    }
}

library SubMutation {
    struct Sub {
        uint256 amount;
    }

    function execute(State storage state, Sub memory sub, bytes32) internal {
        state.total -= sub.amount;
    }
}

contract Counter is Typewriter {
    State internal state;

    enum Mutation {
        Add,
        Sub
    }

    constructor(address scheduler) Typewriter(scheduler) {}

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.Add)) {
            AddMutation.execute(state, abi.decode(mutationData, (AddMutation.Add)), accountID);
        } else if (mutation == uint8(Mutation.Sub)) {
            SubMutation.execute(state, abi.decode(mutationData, (SubMutation.Sub)), accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}`;

test("parseSolidity reads the app contract", () => {
  const output = compile(COUNTER);
  const { abi, bytecode, storageLayout, ...rest } = parseSolidity(
    output,
    "App.sol",
  );

  const { Counter } = output.contracts["App.sol"]!;
  expect(abi).toEqual(Counter!.abi);
  expect(bytecode).toBe(`0x${Counter!.evm.bytecode.object}`);
  expect(storageLayout).toEqual(Counter!.storageLayout);
  expect(rest).toMatchInlineSnapshot(`
    {
      "contractName": "Counter",
      "mutations": {
        "Add": {
          "id": 0,
          "params": [
            {
              "name": "amount",
              "type": "uint256",
            },
          ],
        },
        "AddCredential": {
          "id": 254,
          "params": [
            {
              "name": "expiration",
              "type": "uint40",
            },
            {
              "name": "keyType",
              "type": "uint8",
            },
            {
              "name": "permissions",
              "type": "uint256",
            },
            {
              "name": "publicKey",
              "type": "bytes",
            },
          ],
        },
        "CreateAccount": {
          "id": 253,
          "params": [
            {
              "name": "keyType",
              "type": "uint8",
            },
            {
              "name": "publicKey",
              "type": "bytes",
            },
          ],
        },
        "RemoveCredential": {
          "id": 255,
          "params": [
            {
              "name": "credentialID",
              "type": "uint64",
            },
          ],
        },
        "Sub": {
          "id": 1,
          "params": [
            {
              "name": "amount",
              "type": "uint256",
            },
          ],
        },
      },
    }
  `);
});

test("parseSolidity reads every ABI type a mutation param can have", () => {
  expect(
    mutations(`
type Price is uint128;
interface Token {}
enum Side { Buy, Sell }
uint256 constant SIZE = 3;

struct Leg {
    Side side;
    Price price;
}
${mutation(
  "Place",
  `
        uint amount;
        int delta;
        address payable to;
        bool flag;
        bytes4 selector;
        bytes data;
        string memo;
        Token token;
        Side side;
        Price price;
        uint256[SIZE] fixedSize;
        uint8[2][] nested;
        Leg leg;
        Leg[] legs;`,
)}
${app("enum Mutation { Place }")}`),
  ).toMatchInlineSnapshot(`
    [
      "Place(0): uint256 amount, int256 delta, address to, bool flag, bytes4 selector, bytes data, string memo, address token, uint8 side, uint128 price, uint256[3] fixedSize, uint8[2][] nested, tuple leg, tuple[] legs",
    ]
  `);

  const { Place } = parse(`
struct Inner { uint8 side; uint128 price; }
${mutation("Place", "Inner leg; Inner[] legs;")}
${app("enum Mutation { Place }")}`).mutations;
  expect(Place).toMatchInlineSnapshot(`
    {
      "id": 0,
      "params": [
        {
          "components": [
            {
              "name": "side",
              "type": "uint8",
            },
            {
              "name": "price",
              "type": "uint128",
            },
          ],
          "name": "leg",
          "type": "tuple",
        },
        {
          "components": [
            {
              "name": "side",
              "type": "uint8",
            },
            {
              "name": "price",
              "type": "uint128",
            },
          ],
          "name": "legs",
          "type": "tuple[]",
        },
      ],
    }
  `);
});

test("parseSolidity finds mutation libraries in imported files", () => {
  expect(
    mutations(
      `
import "Add.sol";
${mutation("Sub", "int256 amount;")}
${app("enum Mutation { Add, Sub }")}`,
      {
        "Add.sol": mutation("Add"),
        // App.sol doesn't import it, so its library doesn't count.
        "Other.sol": mutation("Other"),
      },
    ),
  ).toMatchInlineSnapshot(`
    [
      "Add(0): uint256 amount",
      "Sub(1): int256 amount",
    ]
  `);
});

test("parseSolidity errors when the path was not compiled", () => {
  expect(() =>
    parseSolidity(compile(COUNTER), "Missing.sol"),
  ).toThrowErrorMatchingInlineSnapshot(`"Missing.sol was not compiled"`);
});

test("parseSolidity errors when the file defines no app contract", () => {
  expect(() => parse("contract Other {}")).toThrowErrorMatchingInlineSnapshot(
    `"App.sol must define one contract that inherits Typewriter, but defines none"`,
  );
});

test("parseSolidity errors when the file defines more than one app contract", () => {
  expect(() =>
    parse(`${app("", "First")}${app("", "Second")}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App.sol must define one contract that inherits Typewriter, but defines First, Second"`,
  );
});

test("parseSolidity errors when the app inherits anything but Typewriter", () => {
  expect(() =>
    parse(`
contract Ownable {}
contract App is Typewriter, Ownable {
    State internal state;
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must inherit only Typewriter, but inherits Ownable, Typewriter"`,
  );
});

test("parseSolidity errors when the app contract is abstract", () => {
  expect(() =>
    parse(`abstract ${app("enum Mutation { Add }")}`),
  ).toThrowErrorMatchingInlineSnapshot(`"App must not be abstract"`);
});

test("parseSolidity errors when the constructor doesn't take only the scheduler", () => {
  expect(() =>
    parse(`
contract App is Typewriter {
    constructor(address scheduler, uint256) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must declare \`constructor(address scheduler)\` and pass it to \`Typewriter(scheduler)\`, but its constructor takes (address, uint256)"`,
  );
  expect(() =>
    parse(`
contract App is Typewriter(address(1)) {
    function dispatch(uint8, bytes memory, bytes32) internal override {}
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must declare \`constructor(address scheduler)\` and pass it to \`Typewriter(scheduler)\`, but its constructor takes ()"`,
  );
});

test("parseSolidity errors when state is missing or not a struct", () => {
  expect(() =>
    parse(`
contract App is Typewriter {
    uint256 internal state;
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must keep its state in a struct variable named \`state\`"`,
  );
  expect(() =>
    parse(`
contract App is Typewriter {
    State internal store;
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must keep its state in a struct variable named \`state\`"`,
  );
});

test("parseSolidity errors when the app calls an external library", () => {
  expect(() =>
    parse(`
library Math {
    function double(uint256 x) external pure returns (uint256) { return 2 * x; }
}
contract App is Typewriter {
    State internal state;
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {
        state.total = Math.double(state.total);
    }
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App calls an external library function, which typewriter can't execute offchain; make the library's functions internal"`,
  );
});

test("parseSolidity errors when the app has no Mutation enum", () => {
  expect(() => parse(app(""))).toThrowErrorMatchingInlineSnapshot(
    `"App must declare \`enum Mutation\` inside the contract, with a member for each mutation"`,
  );
  expect(() =>
    parse(`
enum Mutation { Add }
${mutation("Add")}
${app("")}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must declare \`enum Mutation\` inside the contract, with a member for each mutation"`,
  );
});

test("parseSolidity errors when a mutation has a built-in name", () => {
  expect(() =>
    parse(app("enum Mutation { CreateAccount }")),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation.CreateAccount is reserved by typewriter; rename it"`,
  );
});

test("parseSolidity errors when Mutation has more members than IDs", () => {
  const members = Array.from({ length: 254 }, (_, i) => `M${i}`);
  expect(() =>
    parse(app(`enum Mutation { ${members.join(", ")} }`)),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation has 254 members, but typewriter reserves IDs from 253; it can have at most 253"`,
  );
});

test("parseSolidity errors unless each mutation has one library", () => {
  expect(() =>
    parse(app("enum Mutation { Add }")),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation.Add needs one library named AddMutation in App.sol or its imports, but there are 0"`,
  );
  expect(() =>
    parse(
      `
import "Mutations.sol";
${app("enum Mutation { Add }")}`,
      {
        "Mutations.sol": 'import "A.sol" as A;\nimport "B.sol" as B;',
        "A.sol": mutation("Add"),
        "B.sol": mutation("Add"),
      },
    ),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation.Add needs one library named AddMutation in App.sol or its imports, but there are 2"`,
  );
});

test("parseSolidity allows other libraries, constants, and internal functions", () => {
  expect(
    mutations(`
${mutation("Add")}
${mutation("Sub")}
${app(`
    enum Mutation { Add }
    uint256 constant LIMIT = 10;
    function limit() internal pure returns (uint256) { return LIMIT; }
    function check() private pure {}`)}`),
  ).toMatchInlineSnapshot(`
    [
      "Add(0): uint256 amount",
    ]
  `);
});

test("parseSolidity errors when the app adds entrypoints or state outside state", () => {
  const error = (body: string) => {
    try {
      parse(app(`enum Mutation { Add }\n${body}`), {});
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect({
    publicFunction: error(
      "function total() public view returns (uint256) { return state.total; }",
    ),
    externalFunction: error("function poke() external {}"),
    fallback: error("fallback() external {}"),
    receive: error("receive() external payable {}"),
    publicConstant: error("uint256 public constant LIMIT = 10;"),
    variable: error("uint256 internal count;"),
    immutable: error("uint256 internal immutable START = 1;"),
  }).toMatchInlineSnapshot(`
    {
      "externalFunction": "App must not add public or external functions or variables, but declares \`poke\`",
      "fallback": "App must not add public or external functions or variables, but declares \`fallback\`",
      "immutable": "App must keep all its state in \`state\`, but declares \`START\`",
      "publicConstant": "App must not add public or external functions or variables, but declares \`LIMIT\`",
      "publicFunction": "App must not add public or external functions or variables, but declares \`total\`",
      "receive": "App must not add public or external functions or variables, but declares \`receive\`",
      "variable": "App must keep all its state in \`state\`, but declares \`count\`",
    }
  `);
  expect(() =>
    parse(`
contract App is Typewriter {
    State public state;
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must not add public or external functions or variables, but declares \`state\`"`,
  );
});

test("parseSolidity errors when a mutation library lacks its struct or execute", () => {
  const error = (library: string) => {
    try {
      parse(`${library}\n${app("enum Mutation { Add }")}`);
    } catch (error) {
      return (error as Error).message;
    }
  };
  const library = (body: string) => `library AddMutation {\n${body}\n}`;
  expect({
    noStruct: error(
      library(
        "struct Other { uint256 a; }\nfunction execute(State storage, Other memory, bytes32) internal {}",
      ),
    ),
    noExecute: error(library("struct Add { uint256 a; }")),
    renamed: error(
      library(
        "struct Add { uint256 a; }\nfunction executeAdd(State storage, Add memory, bytes32) internal {}",
      ),
    ),
    noAccountID: error(
      library(
        "struct Add { uint256 a; }\nfunction execute(State storage, Add memory) internal {}",
      ),
    ),
    otherState: error(
      library(
        "struct Other { uint256 a; }\nstruct Add { uint256 a; }\nfunction execute(Other storage, Add memory, bytes32) internal {}",
      ),
    ),
    calldata: error(
      library(
        "struct Add { uint256 a; }\nfunction execute(State storage, Add calldata, bytes32) internal {}",
      ),
    ),
    public: error(
      library(
        "struct Add { uint256 a; }\nfunction execute(State storage, Add memory, bytes32) public {}",
      ),
    ),
    returns: error(
      library(
        "struct Add { uint256 a; }\nfunction execute(State storage, Add memory, bytes32) internal returns (bool) { return true; }",
      ),
    ),
  }).toMatchInlineSnapshot(`
    {
      "calldata": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
      "noAccountID": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
      "noExecute": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
      "noStruct": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
      "otherState": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
      "public": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
      "renamed": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
      "returns": "AddMutation must declare \`struct Add\` with the mutation's params and \`function execute(State storage state, Add memory mutation, bytes32 accountID) internal\`",
    }
  `);
});

test("parseSolidity errors when a param has no ABI type", () => {
  expect(() =>
    parse(`
${mutation("Call", "function() external fn;")}
${app("enum Mutation { Call }")}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Call.fn has type function () external, which can't be a mutation param"`,
  );
});

test("parseSolidity errors when a mutation can execute differently offchain", () => {
  const error = (body: string) => {
    try {
      parse(`
interface Token { function transfer(address to, uint256 amount) external returns (bool); }
contract Other {}
library AddMutation {
    struct Add { address payable token; }
    function execute(State storage state, Add memory mutation, bytes32) internal { ${body} }
}
${app("enum Mutation { Add }")}`);
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect({
    timestamp: error("state.total = block.timestamp;"),
    number: error("state.total = block.number;"),
    coinbase: error("state.total = uint160(address(block.coinbase));"),
    prevrandao: error("state.total = block.prevrandao;"),
    basefee: error("state.total = block.basefee;"),
    gaslimit: error("state.total = block.gaslimit;"),
    blockhash: error("state.total = uint256(blockhash(1));"),
    gasleft: error("if (gasleft() > 1) state.total = 1;"),
    sender: error("state.total = uint160(msg.sender);"),
    origin: error("state.total = uint160(tx.origin);"),
    gasprice: error("state.total = tx.gasprice;"),
    balance: error("state.total = mutation.token.balance;"),
    selfBalance: error("state.total = address(this).balance;"),
    code: error("state.total = mutation.token.code.length;"),
    externalCall: error("Token(mutation.token).transfer(address(this), 1);"),
    call: error('(bool ok, ) = mutation.token.call(""); ok;'),
    staticcall: error('(bool ok, ) = mutation.token.staticcall(""); ok;'),
    transfer: error("mutation.token.transfer(1);"),
    create: error("new Other();"),
    assembly: error("assembly { sstore(0, 1) }"),
    allowed: error(
      "state.total = block.chainid + uint160(address(this)) + uint256(keccak256(abi.encode(mutation.token)));",
    ),
  }).toMatchInlineSnapshot(`
    {
      "allowed": undefined,
      "assembly": "AddMutation.execute uses inline assembly, which typewriter can't check; write it in Solidity",
      "balance": "AddMutation.execute uses \`mutation.token.balance\`, but offchain, typewriter runs the app contract alone",
      "basefee": "AddMutation.execute uses \`block.basefee\`, which can differ between offchain and onchain execution",
      "blockhash": "AddMutation.execute uses \`blockhash\`, which can differ between offchain and onchain execution",
      "call": "AddMutation.execute uses \`mutation.token.call\`, but offchain, typewriter runs the app contract alone",
      "code": "AddMutation.execute uses \`mutation.token.code\`, but offchain, typewriter runs the app contract alone",
      "coinbase": "AddMutation.execute uses \`block.coinbase\`, which can differ between offchain and onchain execution",
      "create": "AddMutation.execute uses \`new Other\`, but offchain, typewriter runs the app contract alone",
      "externalCall": "AddMutation.execute uses \`Token(…).transfer\`, but offchain, typewriter runs the app contract alone",
      "gasleft": "AddMutation.execute uses \`gasleft\`, which can differ between offchain and onchain execution",
      "gaslimit": "AddMutation.execute uses \`block.gaslimit\`, which can differ between offchain and onchain execution",
      "gasprice": "AddMutation.execute uses \`tx.gasprice\`, which can differ between offchain and onchain execution",
      "number": "AddMutation.execute uses \`block.number\`, which can differ between offchain and onchain execution",
      "origin": "AddMutation.execute uses \`tx.origin\`, which can differ between offchain and onchain execution",
      "prevrandao": "AddMutation.execute uses \`block.prevrandao\`, which can differ between offchain and onchain execution",
      "selfBalance": "AddMutation.execute uses \`address(…).balance\`, but offchain, typewriter runs the app contract alone",
      "sender": "AddMutation.execute uses \`msg.sender\`, which can differ between offchain and onchain execution",
      "staticcall": "AddMutation.execute uses \`mutation.token.staticcall\`, but offchain, typewriter runs the app contract alone",
      "timestamp": "AddMutation.execute uses \`block.timestamp\`, which can differ between offchain and onchain execution",
      "transfer": "AddMutation.execute uses \`mutation.token.transfer\`, but offchain, typewriter runs the app contract alone",
    }
  `);
});

test("parseSolidity checks every function a mutation can reach", () => {
  const error = (dispatch: string) => {
    try {
      parse(`
library Helpers {
    function unused() internal pure returns (uint256 x) { assembly { x := 1 } }
    function time() internal view returns (uint256) { return block.timestamp; }
    function timed(uint256 x) internal view returns (uint256) { return x + time(); }
    modifier onlyLater() { require(block.number > 1); _; }
    function later() internal onlyLater {}
}
type Amount is uint256;
function addAmounts(Amount a, Amount b) pure returns (Amount c) {
    assembly { c := add(a, b) }
}
using {addAmounts as +} for Amount global;
using Helpers for uint256;
${mutation("Add")}
contract App is Typewriter {
    State internal state;
    enum Mutation { Add }
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32 accountID) internal override { ${dispatch} }
}`);
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect({
    dispatch: error("state.total = uint160(msg.sender);"),
    call: error("state.total = Helpers.time();"),
    attached: error("state.total = state.total.timed();"),
    operator: error(
      "state.total = Amount.unwrap(Amount.wrap(1) + Amount.wrap(2));",
    ),
    modifier: error("Helpers.later();"),
    executionIndex: error("state.total = executionIndex;"),
    accounts: error("state.total = accounts[accountID].activeCredentials;"),
    nestedExecute: error('_execute(0, "", "");'),
    allowed: error(
      'verifySignature(KeyType.Secp256k1, bytes32(0), "", ""); state.total = uint160(SCHEDULER);',
    ),
  }).toMatchInlineSnapshot(`
    {
      "accounts": "App.dispatch uses Typewriter's \`accounts\`, which only Typewriter may read or change",
      "allowed": undefined,
      "attached": "Helpers.time uses \`block.timestamp\`, which can differ between offchain and onchain execution",
      "call": "Helpers.time uses \`block.timestamp\`, which can differ between offchain and onchain execution",
      "dispatch": "App.dispatch uses \`msg.sender\`, which can differ between offchain and onchain execution",
      "executionIndex": "App.dispatch uses Typewriter's \`executionIndex\`, which only Typewriter may read or change",
      "modifier": "Helpers.onlyLater uses \`block.number\`, which can differ between offchain and onchain execution",
      "nestedExecute": "App.dispatch uses Typewriter's \`_execute\`, which only Typewriter may read or change",
      "operator": "addAmounts uses inline assembly, which typewriter can't check; write it in Solidity",
    }
  `);
});

test("formatSolidityDeclaration types the entrypoint import", () => {
  expect(
    formatSolidityDeclaration({
      contractName: "Counter",
      abi: [],
      bytecode: "0x",
      storageLayout: {
        storage: [
          {
            astId: 1,
            contract: "src/Counter.sol:Counter",
            label: "state",
            offset: 0,
            slot: "0",
            type: "t_uint256",
          },
        ],
        types: {
          t_uint256: {
            encoding: "inplace",
            label: "uint256",
            numberOfBytes: "32",
          },
        },
      },
      mutations: {
        Add: { id: 0, params: [{ name: "amount", type: "uint256" }] },
        Reset: { id: 1, params: [] },
      },
    }),
  ).toMatchInlineSnapshot(`
    "// Generated by typewriter from Counter.sol. Do not edit by hand.

    declare const entrypoint: import("typewriter").TypewriterSolidityEntrypoint<{
      readonly storageLayout: {
        readonly storage: readonly [
          {
            readonly astId: 1;
            readonly contract: "src/Counter.sol:Counter";
            readonly label: "state";
            readonly offset: 0;
            readonly slot: "0";
            readonly type: "t_uint256";
          },
        ];
        readonly types: {
          readonly t_uint256: {
            readonly encoding: "inplace";
            readonly label: "uint256";
            readonly numberOfBytes: "32";
          };
        };
      };
      readonly mutations: {
        readonly Add: {
          readonly id: 0;
          readonly params: readonly [
            {
              readonly name: "amount";
              readonly type: "uint256";
            },
          ];
        };
        readonly Reset: {
          readonly id: 1;
          readonly params: readonly [];
        };
      };
    }>;
    export default entrypoint;
    "
  `);
});
