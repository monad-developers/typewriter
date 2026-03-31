"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { instrumentsOptions } from "~/lib/queries";
import { cn } from "~/lib/utils";

export function InstrumentPicker({ selected }: { selected: string }) {
  const { data: instruments } = useSuspenseQuery(instrumentsOptions);
  const router = useRouter();
  const current = instruments.find((i) => i.id === selected);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-muted transition-colors outline-none">
        <span className="font-mono font-bold text-sm text-foreground">
          {current?.displayName ?? selected.replace("-", "/")}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {instruments.map((inst) => (
          <DropdownMenuItem
            key={inst.id}
            className={cn(
              "font-mono text-sm cursor-pointer",
              inst.id === selected && "bg-muted"
            )}
            onClick={() => router.push(`/trade?instrument=${inst.id}`)}
          >
            {inst.displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
