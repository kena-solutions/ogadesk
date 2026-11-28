"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { SuspensionGate } from "@/components/layout/suspension-gate";
import { SupportSessionBanner } from "@/components/layout/support-session-banner";
import { DashboardAnnouncements } from "@/components/announcements/dashboard-announcements";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { DefaultsSeeder } from "@/components/automations/defaults-seeder";
import { OnboardingDialog } from "@/components/onboarding/onboarding-dialog";
import { ReferralAttribution } from "@/components/partner/referral-attribution";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { UpgradeHost } from "@/components/billing/upgrade-host";
import { BrowserNotificationsListener } from "@/components/notifications/browser-notifications-listener";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadTitle } from "@/hooks/use-unread-title";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) -
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const t = useTranslations("DashboardShell");

  // Sidebar drawer state - only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <SignedInShell sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} closeSidebar={closeSidebar}>
      {children}
    </SignedInShell>
  );
}

// Split out so the unread realtime subscription (and the "(n)" tab
// title) only runs once a user is signed in.
function SignedInShell({
  children,
  sidebarOpen,
  setSidebarOpen,
  closeSidebar,
}: {
  children: React.ReactNode;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  closeSidebar: () => void;
}) {
  const totalUnread = useTotalUnread();
  useUnreadTitle(totalUnread);

  // The shell must never move; only <main> scrolls. Two things keep it that way:
  //  - overflow-clip (not hidden): `hidden` still lets focus / scrollIntoView slide the whole app up.
  //  - `relative` on the shell, the content column and <main>: an `absolute` element anywhere in a page (a hidden form
  //    input, a badge) is clipped and scrolled by its nearest *positioned* ancestor. Without one it escapes <main>, makes
  //    the whole document scrollable and the sidebar slides away (seen on Settings → Billing).
  return (
    <div className="relative flex h-screen overflow-clip bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless, renders nothing. */}
      <PresenceHeartbeat />
      {/* Covers the app while the platform admin has this business suspended. */}
      <SuspensionGate />
      {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless, renders nothing. */}
      <BrowserNotificationsListener />
      {/* Creates the default Unsubscribe automation once per account. */}
      <DefaultsSeeder />
      {/* First-login questions for the workspace owner (use cases, source). */}
      <OnboardingDialog />
      {/* Links this user to the partner whose ?ref= link they used (once). */}
      <ReferralAttribution />
      {/* Cmd/Ctrl+K search and quick actions (desktop only). */}
      <CommandPalette />
      <UpgradeHost />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} totalUnread={totalUnread} />
      <div className="relative flex flex-1 flex-col overflow-clip">
        <SupportSessionBanner />
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="relative flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {/* Announcements from the platform admin console (migration 108). */}
          <DashboardAnnouncements />
          {children}
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
