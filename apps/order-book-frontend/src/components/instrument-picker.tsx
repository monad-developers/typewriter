"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { instrumentsOptions } from "~/lib/queries";
import { cn } from "~/lib/utils";

export function InstrumentPicker({
  selected,
  onSelect,
  className
}: {
  selected: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const { data: instruments } = useSuspenseQuery(instrumentsOptions);
  const current = instruments.find((i) => i.id === selected);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-muted transition-colors outline-none", className)}>
        <span className="font-bold text-sm text-foreground">
          {current?.displayName ?? selected.replace("-", "/")}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {instruments.map((inst) => (
          <DropdownMenuItem
            key={inst.id}
            className={cn(
              "text-sm cursor-pointer",
              inst.id === selected && "bg-muted"
            )}
            onClick={() => onSelect(inst.id)}
          >
            {inst.displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
