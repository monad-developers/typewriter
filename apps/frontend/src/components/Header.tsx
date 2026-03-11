const MOCK_ACCOUNT = {
  address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  balance: 10,
  txCount: 142,
};

function Toggle({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <code>{label}:</code>
      <input type="checkbox" disabled={disabled} />
    </div>
  );
}

const STATE_VIEWS = [
  "local",
  "proposed",
  "voted",
  "finalized",
  "verified",
] as const;
export type StateView = (typeof STATE_VIEWS)[number];

export function Header({
  authed,
  stateView,
  onStateViewChange,
}: {
  authed: boolean;
  stateView: StateView;
  onStateViewChange: (v: StateView) => void;
}) {
  if (authed === false) return null;
  return (
    <header className="w-full border-b p-4 h-60 flex justify-between">
      <div className="flex items-start gap-2 flex-col">
        <code className="">
          address:{" "}
          <span className="">
            {MOCK_ACCOUNT.address.slice(0, 6)}...
            {MOCK_ACCOUNT.address.slice(-4)}
          </span>
        </code>
        <code className="">
          balance: <span className="">{MOCK_ACCOUNT.balance}</span>
        </code>
        <code className="">
          transaction count: <span className="">{MOCK_ACCOUNT.txCount}</span>
        </code>
        <Toggle label="gas sponsorship" disabled />
        <Toggle label="session keys" disabled />
        <Toggle label="preflight optimizations" disabled />
        <code>
          state view:{" "}
          <select
            value={stateView}
            onChange={(e) => onStateViewChange(e.target.value as StateView)}
          >
            {STATE_VIEWS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </code>
      </div>
    </header>
  );
}
