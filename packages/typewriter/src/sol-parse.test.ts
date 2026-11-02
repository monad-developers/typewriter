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
 * Compiles `source` as App.sol, next to Typewriter.sol and `files`, with
 * solc.
 */
function compile(source: string, files: Record<string, string> = {}) {
  const header = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.21;\n";
  const sources = Object.fromEntries(
    Object.entries({ ...files, "App.sol": source }).map(([path, content]) => [
      path,
      { content: `${header}import "Typewriter.sol";\n${content}` },
    ]),
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "Typewriter.sol": { content: TYPEWRITER }, ...sources },
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

/** A contract with `state`, the scheduler constructor, `dispatch`, and `body`. */
function app(body: string, name = "App"): string {
  return `
contract ${name} is Typewriter {
    struct State { uint256 total; }
    State internal state;
    constructor(address scheduler) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
    ${body}
}`;
}

const COUNTER = `
struct State {
    uint256 total;
}

library AddMutation {
    struct Add {
        uint256 amount;
    }
}

library SubMutation {
    struct Sub {
        uint256 amount;
    }
}

contract Counter is Typewriter {
    State internal state;

    enum Mutation {
        Add,
        Sub
    }

    constructor(address scheduler) Typewriter(scheduler) {}

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) {
            AddMutation.Add memory add = abi.decode(mutationData, (AddMutation.Add));
            state.total += add.amount;
        } else if (mutation == uint8(Mutation.Sub)) {
            SubMutation.Sub memory sub = abi.decode(mutationData, (SubMutation.Sub));
            state.total -= sub.amount;
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

struct Place {
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
    Leg[] legs;
}
${app("enum Mutation { Place }")}`),
  ).toMatchInlineSnapshot(`
    [
      "Place(0): uint256 amount, int256 delta, address to, bool flag, bytes4 selector, bytes data, string memo, address token, uint8 side, uint128 price, uint256[3] fixedSize, uint8[2][] nested, tuple leg, tuple[] legs",
    ]
  `);

  const { Place } = parse(`
struct Inner { uint8 side; uint128 price; }
struct Place { Inner leg; Inner[] legs; }
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

test("parseSolidity finds mutation structs in libraries and imported files", () => {
  expect(
    mutations(
      `
import "Mutations.sol";

library SubMutation {
    struct Sub { int256 amount; }
}
${app("enum Mutation { Add, Sub }")}`,
      {
        "Mutations.sol":
          "library AddMutation { struct Add { uint256 amount; } }",
        // App.sol doesn't import it, so its struct doesn't count.
        "Other.sol": "struct Sub { bool unrelated; }",
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
    struct State { uint256 total; }
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
    parse(`abstract ${app("enum Mutation { Add } struct Add { uint256 a; }")}`),
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
    struct State { uint256 total; }
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
${app(`
    enum Mutation { Add }
    struct Add { uint256 amount; }

    function add(uint256 amount) external {
        state.total += Math.double(amount);
    }`)}`),
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
struct Add { uint256 amount; }
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

test("parseSolidity errors when a mutation has no struct, or more than one", () => {
  expect(() =>
    parse(app("enum Mutation { Add }")),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation.Add takes its params from a struct named Add, but App.sol and its imports define none"`,
  );
  expect(() =>
    parse(`
library AddMutation { struct Add { uint256 amount; } }
library LegacyAddMutation { struct Add { uint128 amount; } }
${app("enum Mutation { Add }")}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation.Add takes its params from a struct named Add, but App.sol and its imports define AddMutation.Add, LegacyAddMutation.Add"`,
  );
});

test("parseSolidity errors when a param has no ABI type", () => {
  expect(() =>
    parse(`
struct Call { function() external fn; }
${app("enum Mutation { Call }")}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Call.fn has type function () external, which can't be a mutation param"`,
  );
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
