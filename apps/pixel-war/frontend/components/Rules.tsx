import { BOMB_COST, PAINT_COST, SHIELD_COST } from "pixel-war-sdk";
import type { AppConfig } from "../hooks/useConfig";

/// The canonical explainer for what makes this app a Typewriter demo rather than
/// a canvas with a database behind it. Edit here rather than duplicating the
/// story elsewhere in the UI.
export function Rules({ config }: { config: AppConfig | undefined }) {
  const batchOrder = config?.batchOrder ?? [];
  const gameOrder = batchOrder.filter((name) =>
    ["AdvanceEpoch", "Shield", "Paint", "Bomb"].includes(name),
  );

  return (
    <details className="border border-edge bg-panel p-3 text-xs leading-relaxed text-dim">
      <summary className="cursor-pointer text-ink">How the rules work</summary>

      <p className="mt-3">
        Every action you take is a <span className="text-ink">mutation</span>: a
        message you sign with a session key. The server orders mutations, runs
        them against its own copy of the contract, and answers{" "}
        <span className="text-ink">accepted</span> in milliseconds — then
        batches them onchain.
      </p>

      <p className="mt-3">
        Ordering is where the game lives. Every 50ms the server gathers the
        mutations it has received into one tick and sorts them by type:
      </p>
      <ol className="mt-2 ml-4 list-decimal">
        {gameOrder.map((name) => (
          <li key={name} className="text-ink">
            {name}
          </li>
        ))}
      </ol>
      <p className="mt-2">
        So within a single tick, defense beats offense: a shield you place in
        the same instant someone paints your pixel resolves first and absorbs
        the hit. Bombs run last, burying paints from that same tick. Nobody wins
        those races by being milliseconds faster or by paying more gas — the
        app's own ordering rule decides.
      </p>

      <p className="mt-3">
        <span className="text-ink">Energy</span> costs: paint {PAINT_COST},
        shield {SHIELD_COST}, bomb {BOMB_COST}. You get{" "}
        {config?.energyPerEpoch ?? 30} per epoch, and epochs advance when the
        server signs an <span className="text-ink">AdvanceEpoch</span> mutation
        — a clock made of state, not of timestamps, so the server's local
        execution and the onchain execution can never disagree about it.
      </p>

      <p className="mt-3">
        Shields absorb whole hits ({config?.maxShieldStack ?? 3} max per pixel)
        rather than expiring on a timer, for the same reason.
      </p>

      <p className="mt-3">
        <span className="text-ink">The server cannot censor you.</span> If it
        refuses your mutation, you can put it onchain yourself with{" "}
        <code>enqueue()</code>, and after {config?.forceInclusionDelay ?? 658}{" "}
        blocks anyone can execute it with <code>forceExecute()</code> whether
        the server likes it or not. See <code>scripts/force-paint.ts</code>.
      </p>

      {config !== undefined && (
        <p className="mt-3">
          Contract <code className="text-ink">{config.contract}</code> on chain{" "}
          {config.chainId}.
        </p>
      )}
    </details>
  );
}
