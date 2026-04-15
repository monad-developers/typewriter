"use client";

import { useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { accountOptions } from "~/lib/account";
import { useBalances } from "~/hooks/use-balances";
import { useOrders } from "~/hooks/use-orders";
import { useCloseOrderMutation } from "~/hooks/use-close-order";
import { instrumentsOptions } from "~/lib/queries";
import { q32ToPrice, fromLots, TokenAmount, type InstrumentConfig } from "order-book-sdk";
import { tokenName, instrumentConfig } from "~/lib/constants";

const PANEL_TABS = [
  { id: "orders", label: "Open Orders" },
  { id: "balances", label: "Balances" },
] as const;

type PanelTabId = (typeof PANEL_TABS)[number]["id"];

function formatPrice(raw: string, inst: InstrumentConfig): string {
  const n = q32ToPrice(BigInt(raw), inst);
  if (n === 0) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatQuantity(raw: string, inst: InstrumentConfig): string {
  const rawAmount = fromLots(BigInt(raw), inst.baseLotExp);
  const amount = TokenAmount.fromRaw(rawAmount, inst.base);
  if (amount.human === 0) return "0";
  return amount.human.toLocaleString();
}

function OrdersTab() {
  const { data: account } = useQuery(accountOptions);
  const { data: ordersData, isLoading } = useOrders(account?.accountId);
  const { data: instruments } = useSuspenseQuery(instrumentsOptions);
  const closeOrder = useCloseOrderMutation();

  const orders = ordersData?.orders ?? [];

  function getInstrumentName(id: number): string {
    const inst = instruments.find((i) => Number(i.id) === id);
    return inst?.displayName ?? `#${id}`;
  }

  async function handleCancel(orderIndex: number) {
    try {
      await closeOrder.mutateAsync({ orderId: orderIndex });
    } catch {
      // error displayed via mutation state
    }
  }

  if (!account) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Sign in to view orders
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No open orders
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-3 h-8 text-xs font-medium text-muted-foreground border-b border-border shrink-0">
        <span className="w-[20%]">Instrument</span>
        <span className="w-[12%]">Side</span>
        <span className="w-[22%] text-right">Price</span>
        <span className="w-[22%] text-right">Quantity</span>
        <span className="w-[24%] text-right">Action</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {orders.map((order) => {
          const isBuy = order.side === 0;
          const inst = instrumentConfig(order.instrumentId);
          return (
            <div
              key={order.orderIndex}
              className="flex items-center px-3 h-8 text-sm tabular-nums hover:bg-muted/30 transition-colors"
            >
              <span className="w-[20%] text-xs">
                {getInstrumentName(order.instrumentId)}
              </span>
              <span
                className={cn(
                  "w-[12%] text-xs font-medium",
                  isBuy ? "text-bid" : "text-ask",
                )}
              >
                {isBuy ? "Buy" : "Sell"}
              </span>
              <span className="w-[22%] text-right text-xs">
                {formatPrice(order.price, inst)}
              </span>
              <span className="w-[22%] text-right text-xs">
                {formatQuantity(order.quantity, inst)}
              </span>
              <span className="w-[24%] text-right">
                <button
                  type="button"
                  onClick={() => void handleCancel(order.orderIndex)}
                  disabled={closeOrder.isPending}
                  className="px-2 py-0.5 text-xs text-destructive border border-destructive/30 rounded hover:bg-destructive/10 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {closeOrder.error && (
        <div className="px-3 py-1.5 text-xs text-destructive border-t border-border">
          {closeOrder.error instanceof Error
            ? closeOrder.error.message
            : "Cancel failed"}
        </div>
      )}
    </div>
  );
}

function BalancesTab() {
  const { data: account } = useQuery(accountOptions);
  const { data, isLoading } = useBalances(account?.accountId);

  if (!account) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Sign in to view balances
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  const entries = Object.entries(data?.balances ?? {}).filter(
    ([, val]) => val !== "0",
  );

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No balances
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-3 h-8 text-xs font-medium text-muted-foreground border-b border-border shrink-0">
        <span className="w-1/2">Asset</span>
        <span className="w-1/2 text-right">Balance</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {entries.map(([address, rawBalance]) => {
          const amount = TokenAmount.fromRaw(
            BigInt(rawBalance),
            address as `0x${string}`,
          );
          return (
            <div
              key={address}
              className="flex items-center px-3 h-8 text-sm tabular-nums hover:bg-muted/30 transition-colors"
            >
              <span className="w-1/2 text-xs font-medium">
                {tokenName(address)}
              </span>
              <span className="w-1/2 text-right text-xs">
                {amount.human.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OrdersPanel() {
  const [tab, setTab] = useState<PanelTabId>("orders");

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center border-b border-border shrink-0">
        {PANEL_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "w-full px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
              tab === t.id
                ? "text-foreground border-b-[1px] border-foreground"
                : "text-muted-foreground hover:text-foreground border-b-[1px] border-transparent",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "orders" ? <OrdersTab /> : <BalancesTab />}
      </div>
    </div>
  );
}
