import { useAccountContext } from "../contexts/AccountContext";
import { useAddressInfo } from "../hooks/useAddressInfo";

function Toggle({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <div className="flex items-center gap-2 cursor-not-allowed">
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
  stateView,
  onStateViewChange,
}: {
  stateView: StateView;
  onStateViewChange: (v: StateView) => void;
}) {
  const { account } = useAccountContext();
  const { data } = useAddressInfo(account?.address, !!account);

  return (
    <header className="w-full border-b p-4 h-60 flex justify-between">
      <div className="flex items-start gap-2 flex-col">
        <code className="">
          address: <span className="">{account?.address}</span>
        </code>
        <code className="">
          balance: <span className="">{data?.balance ?? "..."}</span>
        </code>
        <code className="">
          transaction count: <span className="">{data?.txCount ?? "..."}</span>
        </code>
        <Toggle label="gas sponsorship" disabled />
        <Toggle label="session keys" disabled />
        <Toggle label="preflight optimizations" disabled />
        <code className="cursor-not-allowed">
          state view:{" "}
          <select
            value={stateView}
            onChange={(e) => onStateViewChange(e.target.value as StateView)}
            disabled
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
