import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteStoredAccount } from "../lib/account-store";
import { useManifest } from "./useManifest";

export function useSignOut() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deploymentKey;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (storageKey === undefined) throw new Error("Missing manifest");
      await deleteStoredAccount(storageKey);
    },
    onSuccess: () => {
      queryClient.setQueryData(["storedAccount", storageKey], null);
    },
  });
}
