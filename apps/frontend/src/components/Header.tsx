import { useAccountContext } from "../contexts/AccountContext";
import { useAddressInfo } from "../hooks/useAddressInfo";
import { RpcLog } from "./RpcLog";
import { Tooltip } from "./ui/tooltip";

function Toggle({ label, disabled }: { label: string; disabled: boolean }) {
  const inner = (
    <div
      className={`flex items-center gap-2 ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <code>{label}:</code>
      <input type="checkbox" disabled={disabled} />
    </div>
  );

  if (disabled) {
    return <Tooltip content="Coming soon">{inner}</Tooltip>;
  }

  return inner;
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
  accessListEnabled,
  onAccessListToggle,
}: {
  stateView: StateView;
  onStateViewChange: (v: StateView) => void;
  accessListEnabled: boolean;
  onAccessListToggle: (v: boolean) => void;
}) {
  const { account } = useAccountContext();
  const { data } = useAddressInfo(account?.address, !!account);

  return (
    <header className="w-full border-b p-4 h-80 flex gap-4">
      <div className="flex items-start gap-2 flex-col flex-1 min-w-0">
        <h2 className="text-2xl font-bold">Account Overview</h2>
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
        <div className="flex items-center gap-2">
          <code>access list:</code>
          <input
            type="checkbox"
            checked={accessListEnabled}
            onChange={(e) => onAccessListToggle(e.target.checked)}
          />
        </div>
        <Toggle label="preflight optimizations" disabled />
        <Tooltip content="Coming soon">
          <code className="cursor-not-allowed opacity-50">
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
        </Tooltip>
      </div>
      <div className="border-l -my-4" />
      <div className="flex-1 min-w-0 -mr-4 -mb-4 -ml-4 pl-4">
        <RpcLog />
      </div>
    </header>
  );
}
