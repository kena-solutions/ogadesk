@AGENTS.md

## Git remotes

- Push only to `fork` (github.com/kena-solutions/ogadesk), branch `main`. Never push to `origin` (ArnasDon/wacrm, the open-source upstream); there is no write access there and it must never be attempted.
- `origin` is read-only: fetch from it and pull in specific features when the user asks (cherry-pick or merge selectively), then push the result to `fork`.
- If the target remote is ever ambiguous, ask before pushing.

## Use-case-driven UI

What the platform shows is driven by the workspace's picked use cases (developer / support / sales / marketing). **Before planning or implementing any customer-visible feature (nav item, dashboard widget or KPI, inbox/contact/bulk button, settings card), decide which use cases it serves, register an id in `src/lib/features/use-cases.ts` and gate every entry point with `isFeatureEnabled`.** Name the tag in the plan and PR. Details, the current mapping and a checklist: `.claude/skills/use-case-gating/SKILL.md`.

## Changelog (public page at /changelog)

The changelog is generated from git at build time (`scripts/build-changelog.mjs` → `src/lib/changelog.generated.json`). A commit appears on it only if its message has a `Changelog:` trailer.

- Add the trailer to every customer-visible `feat` and `fix` commit (and to `perf`/other commits a customer would notice). Leave it off refactors, tests, CI, docs, internal tooling and admin-only changes.
- The type sets the badge: `feat` → New, `fix` → Fixed, anything else → Improved. The commit date is the entry date.
- Write the trailer for customers, not developers: one short sentence about what they can now do or what now works, no file names, table names or jargon.
- Add translations on extra lines when you can: `Changelog-fr:`, `Changelog-es:`, `Changelog-pt:`, `Changelog-ko:`, `Changelog-ar:`, `Changelog-hi:`, `Changelog-id:`, `Changelog-sw:`. Missing languages fall back to English.
- Put the trailers last in the message, before the `Co-Authored-By` line. Example:

  ```
  feat(inbox): snooze a conversation until later

  Changelog: Snooze a conversation and it comes back to the top of your inbox when it's time.
  Changelog-fr: Mettez une conversation en pause : elle revient en haut de votre boîte au bon moment.
  ```

- Never edit `changelog.generated.json` by hand; `src/lib/changelog.ts` holds only the hand-written history from before this existed.
