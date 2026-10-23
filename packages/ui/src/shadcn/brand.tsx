import type * as React from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#shadcn/ui/sidebar";

/** The OpenBus mark (src/brand/mark.svg), inline so it follows the theme. Decorative. */
export function BrandMark(props: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 12h14" />
      <circle cx="5" cy="12" r="2.25" />
      <circle cx="19" cy="12" r="2.25" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Sidebar header row: the mark and the wordmark (mono, 500, -0.01em), linking home. */
export function SidebarBrand({
  href = "/",
  name = "OpenBus",
}: {
  href?: string;
  name?: string;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild className="[&>svg]:size-6">
          <a href={href}>
            <BrandMark />
            <span className="font-mono text-base font-medium tracking-[-0.01em]">
              {name}
            </span>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
