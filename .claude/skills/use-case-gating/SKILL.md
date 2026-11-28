---
name: use-case-gating
description: Use before planning or implementing ANY customer-visible feature (nav item, dashboard widget or KPI, inbox/contact/bulk button, settings card). Decide which workspace use cases (developer, support, sales, marketing) the feature serves and register it so it appears automatically only for those workspaces.
---

# Use-case-driven UI

Workspaces pick use cases at onboarding (`accounts.use_cases`, editable in Settings > Profile). What the platform shows is driven by them. The source of truth is `src/lib/features/use-cases.ts`.

## Rule

**Before implementing a feature, decide which use cases it serves, add an id to `featureUseCases`, and gate the UI with `isFeatureEnabled(id, useCases)`.** Name the tag in the plan and the PR description. A feature that is not tagged is shown to everyone, so don't leave customer-visible features untagged by accident.

## How it works

- `useAuth().useCases` holds the picked use cases. It refreshes after onboarding and after the Settings card saves.
- `isFeatureEnabled(feature, useCases)` is true when: no feature id is given, no use case is picked (or still loading), the id is not listed, or at least one listed use case is picked.
- Hiding is cosmetic: nav rows, command-palette entries, dashboard widgets/KPI tiles and buttons. Pages stay reachable by URL, and existing data (tickets, deals) stays visible.

## Where to apply a tag

| Surface | How |
|---|---|
| Sidebar + command palette | `feature: 'nav.x'` on the item in `src/lib/nav.ts` (filtered in `sidebar.tsx` and `command-palette.tsx`) |
| Dashboard card | `WIDGET_FEATURE` in `src/lib/dashboard/layout.ts` (the page and the layout menu filter by it) |
| Dashboard KPI tile | `isFeatureEnabled('kpi.x', useCases)` in `components/dashboard/kpi-row.tsx` |
| Inbox / contact panel / bulk-action buttons | `isFeatureEnabled('action.x', useCases)` where the button renders |
| Settings / dashboard cards | `card.x` ids |

## Current mapping

| Id | Use cases |
|---|---|
| nav.pipelines | sales, support |
| nav.forms (incl. embeddable forms) | developer, support, sales, marketing |
| nav.broadcasts | marketing, sales |
| nav.automations | support, sales, marketing |
| nav.aiAgents | support, sales, marketing (developers don't need it) |
| widget.replyQueue | support, sales |
| widget.pipeline | sales, support |
| widget.campaigns | marketing, sales |
| kpi.dealsWon | sales |
| kpi.broadcasts | marketing |
| action.createDeal | sales |
| action.createTicket | support |
| action.sendTemplate | marketing, sales |
| card.developerChecklist | developer |

Always-on (untagged): Dashboard, Inbox, Contacts, Flows, Partner program, Settings.

## Checklist when adding a feature

1. Which of developer / support / sales / marketing needs it? Pick the narrowest honest set.
2. Add the id to `featureUseCases` (and update the table above).
3. Gate every entry point (nav, palette, widget, button), not just one.
4. Test with each use case alone and with none picked (everything should show).
5. Pipelines: every workspace gets both a Sales and a Support pipeline regardless of use cases (migrations 114 and 142). Don't depend on the use case to create data.
