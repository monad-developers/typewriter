import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  EIP712_TYPES,
  MAX_DEADLINE,
  messageFor,
  type Tool,
} from "pixel-war-sdk";
import { useCallback, useState } from "react";
import { hashTypedData } from "viem";
import type { SubmittedPixelWarMutation } from "../../src/app";
import { useAccountContext } from "../contexts/AccountContext";
import { useDomainContext } from "../contexts/DomainContext";
import { request } from "../lib/api";
import { signP256 } from "../lib/sessionKey";

const MUTATION_FOR_TOOL: Record<Tool, "Paint" | "Shield" | "Bomb"> = {
  paint: "Paint",
  shield: "Shield",
  bomb: "Bomb",
};

export type ActionInput = {
  tool: Tool;
  x: number;
  y: number;
  color: number;
};

export type ActionResult = {
  id: number;
  /// Milliseconds from click to the server's `accepted` response. This is the
  /// number the whole design is about.
  latencyMs: number;
};

export function useAction() {
  const { account, takeNonce } = useAccountContext();
  const { domain } = useDomainContext();
  const queryClient = useQueryClient();
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (input: ActionInput): Promise<ActionResult> => {
      if (account === null) throw new Error("Not signed in");
      if (domain === null) throw new Error("Missing domain");

      const name = MUTATION_FOR_TOOL[input.tool];
      const params: Record<string, unknown> = {
        x: input.x,
        y: input.y,
        nonce: takeNonce(),
        deadline: MAX_DEADLINE,
      };
      // Shield takes the pixel but not a color: it defends whatever the team
      // already holds there.
      if (name !== "Shield") params.color = input.color;

      const message = messageFor(name, params);
      const hash = hashTypedData({
        domain,
        types: { [name]: EIP712_TYPES[name] },
        primaryType: name,
        message,
        // hashTypedData cannot model a runtime-chosen primaryType over a
        // multi-type schema; the payload above is valid for the chosen type.
      } as Parameters<typeof hashTypedData>[0]);

      const startedAt = performance.now();
      const rawSignature = await signP256(account.sessionKey, hash);
      const { id } = await request<{ id: number }>("/api", {
        method: "POST",
        body: {
          name,
          params: message,
          signature: {
            account: account.accountId,
            keyId: BigInt(account.keyId),
            rawSignature,
          },
        } satisfies SubmittedPixelWarMutation<typeof name>,
      });

      return { id, latencyMs: Math.round(performance.now() - startedAt) };
    },
    onSuccess: (result) => {
      setLastLatencyMs(result.latencyMs);
      setLastError(null);
      void queryClient.invalidateQueries({ queryKey: ["accountState"] });
    },
    onError: (error) => {
      setLastError(error instanceof Error ? error.message : String(error));
      void queryClient.invalidateQueries({ queryKey: ["accountState"] });
    },
  });

  const clearError = useCallback(() => setLastError(null), []);

  return { ...mutation, lastLatencyMs, lastError, clearError };
}
