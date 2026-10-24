# Daily review reminder and interface language regression

Verified locally against the production build on 2026-10-23. These changes have not been deployed as part of this verification.

## Behavior

- Removed the dashboard review banner and its reserved space.
- On daily login, wait for user data and the daily coin claim to settle. Show the review dialog after coin notifications, ahead of achievement dialogs.
- Once-per-day history is scoped to the account and this browser, using the same Shanghai calendar day as coin rewards. Reloading and repeated authentication events do not reopen it. A page left open across midnight does not interrupt an ongoing session with the next day's login reminder.
- Dismissal moves the count to the header badge between coins and the account email. The badge breathes, supports keyboard focus and honors reduced motion. No badge is shown when no words are due. During other activities it remains informational so it cannot steal focus or interrupt a running timer.
- Review starts a queue of up to 12 currently due words through the existing test preparation flow.
- English and Chinese interface labels, game messages, countdowns, result screens, dates, hover text, and common dialogs follow the chosen language. Missing English definitions use a localized fallback without replacing the selected word sense or altering saved Chinese meaning data.

## Validation

- All four TypeScript/Deno checks passed.
- 237 automated tests passed, 0 failed.
- Production build passed. Existing large dictionary chunk warning remains; the dictionary remains lazy loaded.
- Desktop viewport checks: 1366×768, 1440×900 and 1920×1080. No portrait acceptance tests were used.
- Fresh account sequence: daily coins visible with no review dialog; after Collect, review visible with no coin or achievement dialog. Escape returns focus to the badge; reload on the same day does not repeat the dialog.
- Nine Lines: wrong answer retained across an EN→ZH switch while paused; completed 9/9, 8 lines, 1710 points; English result text contained no Chinese.
- Word Orbit: wrong answer, fall/recovery, pause, language switch without resetting input, completion and saved results verified. Its current visual design is explicitly rejected by the user and is pending a separate Spline-based redesign; this regression does not accept its appearance.
- Review badge CTA: prepared 12 due words and completed the classic quiz 12/12; English preparation, play, definitions and results contained no Chinese.
- Official Supabase only, project `mkdxdlsjisqazermmfoe`: account A persisted 9 puzzle and 12 orbit learning events with matching revision totals (21). Account B persisted 12 classic learning events and one completed-test event. Both had zero unprojected records. No Docker database was used.
- Dedicated QA accounts were isolated from real users. Cleanup evidence is retained in the temporary reports listed below.

## Evidence (local temporary files)

- `/tmp/vocab-reminder-locale-typecheck-final.log`
- `/tmp/vocab-reminder-locale-tests-final.log`
- `/tmp/vocab-reminder-locale-build-final.log`
- `/tmp/vocab-reminder-notification-sequence.json`
- `/tmp/vocab-reminder-cloud-final.json`
- `/tmp/vocab-reminder-locale-cleanup-result.json`
- `/tmp/vocab-reminder-first-login-cleanup-result.json`
- `/tmp/vocab-dashboard-reminder-en-1366.png`
- `/tmp/vocab-reminder-dialog-en-1366.png`
- `/tmp/vocab-puzzle-locale-en-active-1366.png`
- `/tmp/vocab-puzzle-locale-en-result-1366.png`

Browser resource logs included missing optional profiles for new QA accounts (HTTP 406) and intermittent external resource timeouts. The tested game resources and cloud learning projection completed successfully; this is not a claim that every network request was error-free.
