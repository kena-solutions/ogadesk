# Marketing backlog

Deferred marketing work, parked on 2026-11-28 after the comparison-page batch. Pick from here when marketing comes up again.

## Already shipped (for context)

- English feature, country, use-case and integration pages; comparison pages for WATI, Respond.io, Interakt, Trengo, Chatwoot, DoubleTick, Twilio, 360dialog, Gupshup and SleekFlow; the `/compare` hub.
- French core, country, feature and comparison pages at `/fr/...`.
- WhatsApp pricing guide (EN and FR) with Meta's rates, the cost calculator and the wa.me link generator.
- Anti-spam policy, branded 404 pages, Meta Business Partner badge, "Last used" tag on login and signup.
- Content lives in `src/lib/marketing/pages.ts`; Meta rates in `src/lib/marketing/whatsapp-rates.ts`.

## Languages

The long-form pages exist in English and French only. The app, landing page and login are already translated in 9 languages. A new language is not just translation: it needs a route change, pages written for local search, local facts and a native-speaker review.

- Route work: extend `MarketingPage.lang`, `guardLocale` and `pagePath` in `src/lib/marketing/route.ts`, the UI strings in `marketing-page-view.tsx`, footer links and the compare hub.
- Portuguese: Mozambique and Angola. Spanish: Mexico and Colombia.
- Later: Arabic (check right-to-left), Swahili, Hindi, Indonesian, Korean.
- French remainder, content only: API and webhooks, OTP, the four integration pages, the four use-case pages.

## New page types

- Security and data-protection page. Needs confirmed facts: hosting region, encryption, backups, who can access data.
- Customer stories. Needs real customers who agree to be named.
- Own pricing and FAQ page.
- More country pages: Namibia, Mauritius, Sierra Leone, Liberia ("Rest of Africa" Meta rates).
- Industry pages, one at a time, once we know who we are selling to.
- Glossary pages: what the WhatsApp Business API, opt-in and message templates are.

## Tools and assets

- Link generator: QR code output. New free tools: template generator, message-length counter.
- Click-to-WhatsApp ads page: currently "coming soon". Make it live only when the Meta integration ships.
- Social share images per page.
- Blog posts, and a demo video on the landing page.

## Conversion and trust

- Carry the chosen billing period (monthly, quarterly, annual) from the landing toggle to signup and checkout.
- Testimonials and logos. Needs real ones.
- Refresh the partner page now that OgaDesk is a Meta Business Partner.
- Review the anti-spam policy, sections 7 and 8 (they promise suspension and spam reporting).
- Submit the sitemap in Google Search Console and check that the new pages are indexed.
