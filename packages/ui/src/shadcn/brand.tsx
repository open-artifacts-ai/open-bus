import type * as React from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#shadcn/ui/sidebar";

/**
 * The OpenBus mark (src/brand/mark.svg), inline so it follows the theme. Decorative.
 * Hub and spokes take currentColor; the three rings take the --ob-brand-* tokens.
 */
export function BrandMark(props: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      strokeWidth={2.6}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <g stroke="currentColor">
        <path d="M16 12.6v-1M11.5 20.4l-.87.5M20.5 20.4l.87.5" />
        <circle cx="16" cy="17.8" r="3.9" />
      </g>
      <circle cx="16" cy="6.8" r="3.5" stroke="var(--ob-brand-blue, #2f6bff)" />
      <circle
        cx="6.47"
        cy="23.3"
        r="3.5"
        stroke="var(--ob-brand-orange, #e55f00)"
      />
      <circle
        cx="25.53"
        cy="23.3"
        r="3.5"
        stroke="var(--ob-brand-red, #ff2d55)"
      />
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
