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

/** Compiles `source` as App.sol, next to Typewriter.sol, with solc. */
function compile(source: string): SolcOutput {
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "Typewriter.sol": { content: TYPEWRITER },
          "App.sol": {
            content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.21;\nimport "Typewriter.sol";\n${source}`,
          },
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
  return output;
}

function parse(source: string) {
  return parseSolidity(compile(source), "App.sol");
}

/** The app's mutations, as `Name(id): type name, ...`. */
function mutations(source: string): string[] {
  return Object.entries(parse(source).mutations)
    .filter(([name]) => !Object.hasOwn(BUILTIN_MUTATIONS, name))
    .map(
      ([name, { id, params }]) =>
        `${name}(${id}): ${params.map(({ name, type }) => `${type} ${name}`).join(", ")}`,
    );
}

/** A contract with `state`, the scheduler constructor, and `body`. */
function app(body: string, name = "App"): string {
  return `
contract ${name} is Typewriter {
    struct State { uint256 total; }
    State internal state;
    constructor(address scheduler) Typewriter(scheduler) {}
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

struct Order {
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
${app(`
    enum Mutation { Place }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Place)) abi.decode(mutationData, (Order));
    }`)}`),
  ).toMatchInlineSnapshot(`
    [
      "Place(0): uint256 amount, int256 delta, address to, bool flag, bytes4 selector, bytes data, string memo, address token, uint8 side, uint128 price, uint256[3] fixedSize, uint8[2][] nested, tuple leg, tuple[] legs",
    ]
  `);
  const { Place } = parse(`
struct Inner { uint8 side; uint128 price; }
struct Outer { Inner leg; Inner[] legs; }
${app(`
    enum Mutation { Place }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Place)) abi.decode(mutationData, (Outer));
    }`)}`).mutations;
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

test("parseSolidity reads the ways dispatch can branch and decode", () => {
  expect(
    mutations(`
struct A { uint256 a; }
struct B { uint256 b; }
struct C { uint256 c; }
struct D { uint256 d; }

${app(`
    enum Mutation { A, B, C, D }

    function applyC(C memory) internal {}

    function dispatch(uint8 id, bytes memory input, bytes32) internal override {
        if (uint8(Mutation.A) == id) {
            A memory a = abi.decode(input, (A));
            state.total += a.a;
        }
        if (Mutation(id) == Mutation.B) {
            if (state.total > 0) {
                state.total += abi.decode(input, (B)).b;
            }
        } else if (id == uint8(Mutation.C)) applyC(abi.decode(input, (C)));
        else if (id == uint8(Mutation.D)) {
            D memory d = abi.decode(input, (D));
            state.total = d.d;
        }
    }`)}`),
  ).toMatchInlineSnapshot(`
    [
      "A(0): uint256 a",
      "B(1): uint256 b",
      "C(2): uint256 c",
      "D(3): uint256 d",
    ]
  `);
});

test("parseSolidity reads Mutation and dispatch from a base contract", () => {
  expect(
    mutations(`
import {Typewriter as Base} from "Typewriter.sol";

struct Add { uint256 amount; }

abstract contract Counter is Base {
    enum Mutation { Add }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) abi.decode(mutationData, (Add));
    }
}

contract Helper {}

contract App is Counter {
    struct State { uint256 total; }
    State internal state;
    constructor(address scheduler) Base(scheduler) {}
}`),
  ).toMatchInlineSnapshot(`
    [
      "Add(0): uint256 amount",
    ]
  `);
});

test("parseSolidity errors when the file defines no app contract", () => {
  expect(() =>
    parse(`
abstract contract Base is Typewriter {}
contract Other {}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App.sol must define one contract that inherits Typewriter and isn't abstract, but defines none"`,
  );
});

test("parseSolidity errors when the file defines more than one app contract", () => {
  const body = `
    enum Mutation { Add }
    struct Add { uint256 amount; }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) abi.decode(mutationData, (Add));
    }`;
  expect(() =>
    parse(`${app(body, "First")}${app(body, "Second")}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App.sol must define one contract that inherits Typewriter and isn't abstract, but defines First, Second"`,
  );
});

test("parseSolidity errors when the path was not compiled", () => {
  expect(() =>
    parseSolidity(compile(COUNTER), "Missing.sol"),
  ).toThrowErrorMatchingInlineSnapshot(`"Missing.sol was not compiled"`);
});

test("parseSolidity errors when the constructor takes more than the scheduler", () => {
  expect(() =>
    parse(`
contract App is Typewriter {
    constructor(address scheduler, uint256) Typewriter(scheduler) {}
    function dispatch(uint8, bytes memory, bytes32) internal override {}
}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must declare \`constructor(address scheduler)\` and pass it to \`Typewriter(scheduler)\`, but its constructor takes (address, uint256)"`,
  );
});

test("parseSolidity errors when the app fixes the scheduler", () => {
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

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) {
            state.total += Math.double(abi.decode(mutationData, (Add)).amount);
        }
    }`)}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App calls an external library function, which typewriter can't execute offchain; make the library's functions internal"`,
  );
});

test("parseSolidity errors when the app has no Mutation enum", () => {
  expect(() =>
    parse(
      app(
        "function dispatch(uint8, bytes memory, bytes32) internal override {}",
      ),
    ),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must declare \`enum Mutation\` inside the contract or a base contract, with a member for each mutation"`,
  );
});

test("parseSolidity errors when Mutation is declared outside the contract", () => {
  expect(() =>
    parse(`
enum Mutation { Add }
struct Add { uint256 amount; }
${app(`
    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) abi.decode(mutationData, (Add));
    }`)}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App must declare \`enum Mutation\` inside the contract or a base contract, with a member for each mutation"`,
  );
});

test("parseSolidity errors when a mutation has a built-in name", () => {
  expect(() =>
    parse(
      app(`
    enum Mutation { CreateAccount }
    function dispatch(uint8, bytes memory, bytes32) internal override {}`),
    ),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation.CreateAccount is reserved by typewriter; rename it"`,
  );
});

test("parseSolidity errors when a mutation has a built-in ID", () => {
  const members = Array.from({ length: 254 }, (_, i) => `M${i}`);
  const branches = members.map(
    (member) =>
      `if (mutation == uint8(Mutation.${member})) abi.decode(mutationData, (Params));`,
  );
  expect(() =>
    parse(
      app(`
    struct Params { uint256 value; }
    enum Mutation { ${members.join(", ")} }
    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        ${branches.join("\n        ")}
    }`),
    ),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Mutation.M253 has ID 253, but typewriter reserves IDs from 253; Mutation can have at most 253 members"`,
  );
});

test("parseSolidity errors when a mutation has no dispatch branch", () => {
  expect(() =>
    parse(
      app(`
    enum Mutation { Add, Sub }
    struct Add { uint256 amount; }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) abi.decode(mutationData, (Add));
        // Only a comparison with Mutation.Sub counts as its branch.
        if (mutation == 1) abi.decode(mutationData, (Add));
    }`),
    ),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App.dispatch has no branch for Mutation.Sub; add \`if (mutation == uint8(Mutation.Sub))\`"`,
  );
});

test("parseSolidity errors when a mutation has two dispatch branches", () => {
  expect(() =>
    parse(
      app(`
    enum Mutation { Add }
    struct Add { uint256 amount; }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) abi.decode(mutationData, (Add));
        if (mutation == uint8(Mutation.Add)) abi.decode(mutationData, (Add));
    }`),
    ),
  ).toThrowErrorMatchingInlineSnapshot(
    `"App.dispatch has more than one branch for Mutation.Add"`,
  );
});

test("parseSolidity errors when a branch doesn't decode one struct", () => {
  const dispatch = (branch: string) =>
    app(`
    enum Mutation { Add }
    struct Add { uint256 amount; }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) {
            ${branch}
        }
    }`);

  const error = (branch: string) => {
    try {
      parse(dispatch(branch));
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect({
    none: error("state.total += 1;"),
    twice: error(
      "abi.decode(mutationData, (Add)); abi.decode(mutationData, (Add));",
    ),
    elementary: error("abi.decode(mutationData, (uint256));"),
    tuple: error("abi.decode(mutationData, (Add, uint256));"),
    otherBytes: error("abi.decode(abi.encode(1), (Add));"),
  }).toMatchInlineSnapshot(`
    {
      "elementary": "The Mutation.Add branch of App.dispatch must decode mutationData into a struct once, as \`abi.decode(mutationData, (Add))\`",
      "none": "The Mutation.Add branch of App.dispatch must decode mutationData into a struct once, as \`abi.decode(mutationData, (Add))\`",
      "otherBytes": "The Mutation.Add branch of App.dispatch must decode mutationData into a struct once, as \`abi.decode(mutationData, (Add))\`",
      "tuple": "The Mutation.Add branch of App.dispatch must decode mutationData into a struct once, as \`abi.decode(mutationData, (Add))\`",
      "twice": "The Mutation.Add branch of App.dispatch must decode mutationData into a struct once, as \`abi.decode(mutationData, (Add))\`",
    }
  `);
});

test("parseSolidity errors when a param has no ABI type", () => {
  expect(() =>
    parse(`
struct Callback { function() external fn; }
${app(`
    enum Mutation { Call }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Call)) abi.decode(mutationData, (Callback));
    }`)}`),
  ).toThrowErrorMatchingInlineSnapshot(
    `"Callback.fn has type function () external, which can't be a mutation param"`,
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
