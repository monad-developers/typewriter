import { Tooltip } from "../../components/ui/tooltip";
import { useAccountContext } from "../contexts/AccountContext";
import { useAddressInfo } from "../hooks/useAddressInfo";

export function Header() {
  const { account } = useAccountContext();
  const { data } = useAddressInfo(account?.address, !!account);

  return (
    <header className="w-full border-b p-4 flex items-start gap-2 flex-col">
      <h2 className="text-2xl font-bold">Account Overview</h2>
      <code>
        address: <span>{account?.address}</span>
      </code>
      <code>
        balance: <span>{data?.balance ?? "..."}</span>
      </code>
      <code>
        transaction count: <span>{data?.nonce ?? "..."}</span>
      </code>
      <div className="flex items-center gap-2">
        <code>gas sponsorship:</code>
        <input type="checkbox" checked disabled readOnly />
      </div>
      <Tooltip content="Coming soon">
        <div className="flex items-center gap-2 cursor-not-allowed opacity-50">
          <code>session keys:</code>
          <input type="checkbox" disabled />
        </div>
      </Tooltip>
    </header>
  );
}
