import type { FeatureId } from "@/lib/features/use-cases";
import {
  Bot,
  ClipboardList,
  Gift,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  Radio,
  Settings,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

// Single source of truth for the app's main navigation. The sidebar renders
// it and the command palette (Cmd/Ctrl+K) searches it, so a page added here
// shows up in both.

export interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational - doesn't affect routing or access.
   */
  beta?: boolean;
  /** Use-case gate (src/lib/features/use-cases.ts). Omitted = always shown. */
  feature?: FeatureId;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/forms", labelKey: "forms", icon: ClipboardList, feature: "nav.forms" },
  { href: "/pipelines", labelKey: "pipelines", icon: GitBranch, feature: "nav.pipelines" },
  { href: "/broadcasts", labelKey: "broadcasts", icon: Radio, feature: "nav.broadcasts" },
  { href: "/automations", labelKey: "automations", icon: Zap, feature: "nav.automations" },
  { href: "/flows", labelKey: "flows", icon: Workflow, beta: true },
  { href: "/agents", labelKey: "aiAgents", icon: Bot, feature: "nav.aiAgents" },
];

export const bottomNavItems: NavItem[] = [
  { href: "/affiliate", labelKey: "partner", icon: Gift },
  { href: "/settings", labelKey: "settings", icon: Settings },
];

