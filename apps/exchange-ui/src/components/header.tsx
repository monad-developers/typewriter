"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/lib/utils";

const NAV_LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/info", label: "Info" },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="h-12 bg-card border-b border-border flex items-center px-4 md:px-6 shrink-0">
      <Link href="/trade" className="text-sm font-bold tracking-wide mr-8">
        Demo Exchange
      </Link>
      <nav className="flex items-center gap-1">
        {NAV_LINKS.map((link) => {
          const isActive = pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                isActive
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
