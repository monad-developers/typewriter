// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice One variable per storage shape. Tests compare each decoded value
/// with its getter after `populate`.
contract StorageFixture {
    type Price is uint128;

    enum Status {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct Inner {
        uint256 count;
    }

    struct Metadata {
        uint64 lastUpdate;
        bool active;
        address admin;
        Inner inner;
    }

    struct Order {
        uint128 price;
        uint64 amount;
        Status status;
        bytes32 id;
    }

    struct Book {
        uint256 id;
        mapping(address account => uint256 amount) deposits;
        uint64[] levels;
        string name;
    }

    uint256 public totalSupply;
    address public owner;
    bool public paused;
    int16 public debt;
    uint8 public decimals;
    int256 public signedBig;
    bytes32 public salt;
    bytes4 public selector;
    uint48 public u48;
    uint56 public u56;
    int8 public i8;
    int48 public i48;
    Status public status;

    Metadata public metadata;
    Book internal book;

    uint128[3] public fixedNumbers;
    uint256[] public dynamicNumbers;
    Order[] public orders;
    uint128[2][3] public matrix;
    Inner[2] public inners;
    bool[] public flags;
    address[] public addresses;

    bytes public emptyBytes;
    bytes public shortBytes;
    bytes public exactBytes;
    bytes public longBytes;
    string public shortString;
    string public longString;

    mapping(address account => uint256 balance) public balances;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowances;
    mapping(uint256 id => Order order) public ordersById;
    mapping(int64 key => bool value) public signedKeys;
    mapping(bytes4 selector => address target) public bySelector;
    mapping(bool key => uint8 value) public byBool;
    mapping(address account => uint256[] values) public history;
    mapping(address account => string name) public names;
    mapping(uint8 outer => mapping(int256 inner => bytes32 value)) public nested;

    // Not supported by storage-layout.

    StorageFixture public self;
    Price public price;

    address public constant ALICE = 0x1111111111111111111111111111111111111234;
    address public constant BOB = 0x2222222222222222222222222222222222221234;

    function populate() external {
        totalSupply = 1_000_000 ether;
        owner = ALICE;
        paused = true;
        debt = -12_345;
        decimals = 18;
        signedBig = type(int256).min;
        salt = keccak256("salt");
        selector = this.populate.selector;
        u48 = type(uint48).max;
        u56 = type(uint56).max;
        i8 = type(int8).min;
        i48 = type(int48).min;
        status = Status.Filled;

        metadata = Metadata({lastUpdate: 1_700_000_000, active: true, admin: BOB, inner: Inner({count: 7})});
        book.id = 42;
        book.deposits[ALICE] = 100;
        book.deposits[BOB] = 200;
        book.levels.push(10);
        book.levels.push(20);
        book.levels.push(30);
        book.levels.push(40);
        book.levels.push(50);
        book.name = "order book with a name longer than thirty-one bytes";

        fixedNumbers = [uint128(1), 2, type(uint128).max];
        dynamicNumbers.push(11);
        dynamicNumbers.push(22);
        dynamicNumbers.push(33);
        orders.push(Order({price: 100, amount: 3, status: Status.Open, id: keccak256("order-0")}));
        orders.push(Order({price: 250, amount: 9, status: Status.Cancelled, id: keccak256("order-1")}));
        matrix = [[uint128(1), 2], [uint128(3), 4], [uint128(5), type(uint128).max]];
        inners[0] = Inner({count: 5});
        inners[1] = Inner({count: 6});
        for (uint256 i = 0; i < 40; i++) {
            flags.push(i % 3 == 0);
        }
        addresses.push(ALICE);
        addresses.push(BOB);
        addresses.push(address(this));

        shortBytes = hex"deadbeef";
        exactBytes = abi.encodePacked(keccak256("exactly thirty-two bytes"));
        longBytes = abi.encodePacked(keccak256("a"), keccak256("b"), hex"0102030405");
        shortString = "hello";
        longString = "a string that is longer than thirty-one bytes, so it uses the long form";

        balances[ALICE] = 1 ether;
        balances[BOB] = 2 ether;
        allowances[ALICE][BOB] = 500;
        allowances[BOB][ALICE] = type(uint256).max;
        ordersById[7] = Order({price: 999, amount: 1, status: Status.Filled, id: keccak256("order-7")});
        signedKeys[-1] = true;
        signedKeys[type(int64).min] = true;
        bySelector[this.populate.selector] = BOB;
        byBool[true] = 1;
        byBool[false] = 2;
        history[ALICE].push(1);
        history[ALICE].push(2);
        history[BOB].push(3);
        names[ALICE] = "alice";
        names[BOB] = "bob has a name that is much longer than thirty-one bytes";
        nested[1][-5] = keccak256("nested");

        self = this;
        price = Price.wrap(123);
    }

    function bookDeposits(address account) external view returns (uint256) {
        return book.deposits[account];
    }

    function bookLevels(uint256 index) external view returns (uint64) {
        return book.levels[index];
    }

    function bookLevelsLength() external view returns (uint256) {
        return book.levels.length;
    }

    function bookName() external view returns (string memory) {
        return book.name;
    }

    function bookId() external view returns (uint256) {
        return book.id;
    }

    function dynamicNumbersLength() external view returns (uint256) {
        return dynamicNumbers.length;
    }

    function ordersLength() external view returns (uint256) {
        return orders.length;
    }

    function flagsLength() external view returns (uint256) {
        return flags.length;
    }

    function historyLength(address account) external view returns (uint256) {
        return history[account].length;
    }
}
