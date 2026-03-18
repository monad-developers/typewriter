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
        transaction count: <span>{data?.txCount ?? "..."}</span>
      </code>
    </header>
  );
}
