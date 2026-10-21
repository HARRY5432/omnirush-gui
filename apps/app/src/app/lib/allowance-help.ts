// "How your allowance works" and "How to get a Good session": the help the
// usage meter, the out-of-tokens card, the rewards panel and the Good-session
// chip open. The same text is on omnirush.ai/guide (omnirush-ai.github.io,
// web/src/guide.ts); change both together.
//
// Where each rule comes from (omnirush-backend unless noted):
//   day / week        runtime_settings.grant_period_start/_end: a day is a UTC
//                     day, the week an ISO week from Monday 00:00 UTC;
//                     grant_parts (OmniRushDayAllowance, one row per UTC day)
//   parts             grant_parts module doc: Discord and GitHub links, the
//                     power credit (passing sessions of the last
//                     power_window_days, up to power_cap), extras, pot
//   charged tokens    gateway._record_tokens: uncached input, output,
//                     reasoning and cache writes in full, cached input at
//                     Settings.omnirush_cached_token_weight (0.25)
//   reservation       grants.OmniRushGrantService.reserve/settle
//   rewards           usable.reward_weight (power credit weights)
//   bands             usable.band_of, session_dock (one band up per passing
//                     session today; grace for new accounts / few sessions)
//   surcharge, pause  session_dock (warn, surcharge refunded to the pot when
//                     the session passes; cap for unrecorded sessions)
//   Good session      good-session.ts (the live checklist) and the quality
//                     dock's check texts (quality_controls texts)
// Numbers an admin can change (amounts, caps, percents, multipliers) are not
// written here: the app and the console show them from the server.

export const ALLOWANCE_GUIDE_URL = "https://omnirush.ai/guide";
export const ALLOWANCE_GUIDE_GOOD_SESSION_URL = `${ALLOWANCE_GUIDE_URL}#good-session`;

export const ALLOWANCE_HELP_TITLE = "How your allowance works";
export const ALLOWANCE_HELP_LINK = "How tokens work";
export const GOOD_SESSION_HELP_TITLE = "How to get a Good session";

export type HelpSection = { id: string; title: string; text?: string; points?: readonly string[] };

/** Midnight UTC on the user's clock: "5:30 AM" (India), "8:00 PM" (New York, summer). */
export function utcMidnightLocal(options: { timeZone?: string; now?: number } = {}): string {
  const now = new Date(options.now ?? Date.now());
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: options.timeZone }).format(midnight);
}

export const ALLOWANCE_SECTIONS: readonly HelpSection[] = Object.freeze([
  {
    id: "daily",
    title: "Your daily tokens",
    text: "You get a token allowance for each day, under a weekly cap. What is left shows in the sidebar and in Settings. Your daily tokens are the sum of:",
    points: [
      "Linked accounts: a linked Discord account and a linked GitHub account each add tokens every day. Link them on the console's Account page, which also shows when a link counts.",
      "Passing sessions: each session that passes the quality check adds tokens to every day of the following week, up to a cap. A usable session on Windows or macOS adds the most, then one on Linux or WSL, then other passing sessions; sessions that are cut off or very small add the least.",
      "Extras: approved project requests, ambassador boosts and other grants, while they last. A leaderboard win raises your linked-account and session parts by a percentage, and a referral raises your weekly cap.",
    ],
  },
  {
    id: "reset",
    title: "When it resets",
    points: [
      "Daily tokens refill at 00:00 UTC every day. The app shows the time on your clock next to the meter.",
      "The weekly cap resets on Monday at 00:00 UTC. When the cap is reached, the daily tokens wait for it.",
      "Unused daily tokens do not carry over to the next day.",
      "Your bonus pot holds one-time tokens (for example sign-up tokens, refunds and prizes). It is used only when today's tokens or the weekly cap run out, and it does not refill on its own.",
    ],
  },
  {
    id: "usage",
    title: "What uses tokens",
    text: "Every request the agent sends to the model uses tokens: your message, the conversation so far, the files and tool results the agent reads, and its answer.",
    points: [
      "Input tokens: count in full.",
      "Cached input: the part of the conversation the model already has from earlier turns counts at a fraction of its size (currently a quarter).",
      "Output tokens: the agent's answers, code and tool calls, in full.",
      "Reasoning tokens: the model's thinking, in full. A higher reasoning effort uses more.",
      "Sub-agents, automatic summaries and compaction are model requests too.",
      "While a request runs, a small amount is held; when it ends, the real count replaces it.",
    ],
  },
  {
    id: "lower",
    title: "What can lower it",
    points: [
      "Few passing sessions: if only a small share of your recent work passes the quality check (measured by tokens, across your larger sessions of the last week), your daily tokens are lowered to a percentage. The app shows a notice with the percent. Each session that passes today lifts you one step for the rest of the day. New accounts and accounts with only a few checked sessions keep their full allowance, unless they use a lot of tokens without uploading sessions.",
      "Sessions not uploaded: heavy use with few uploaded sessions can lower it too. Keep the app updated and recording on.",
      "Quality tier: while your tier is Limited, your tokens are reduced. The tier badge next to your name shows by how much when you point at it.",
      "Off-track sessions: a session that is clearly off track (not recorded, most tool calls failing, or no project and no code changed) gets a warning first. If it carries on, its tokens cost more. If it passes the quality check in the end, the extra comes back to your bonus pot.",
      "Paused session: a session that is not being recorded is paused after a set amount. Update OmniRush or turn recording back on, then start a new session.",
    ],
  },
  {
    id: "save",
    title: "Spending less",
    points: [
      "Start a new session for a new task: every turn sends the conversation again, so long chats cost more per turn.",
      "Use a lower reasoning effort for simple changes.",
      "Point the agent at the files that matter instead of asking it to read the whole project.",
    ],
  },
]);

export const GOOD_SESSION_SECTIONS: readonly HelpSection[] = Object.freeze([
  {
    id: "steps",
    title: "The checklist",
    text: "A Good session (the star) is the strictest quality check, stricter than the pass that adds daily tokens, and each one earns spins. The Good session chip above the message box checks these as you work; the star fills in after the server's check, once the session has uploaded.",
    points: [
      "In a project: open your project's own folder before you start (a general folder such as your home folder, Desktop or Downloads usually isn't one) and keep every edit inside it.",
      "Code changed: build or change real code, at least 2 code files and 30 lines, or 5 files and 150 lines. Docs, images, lock files and build output don't count.",
      "Ran or tested: have the agent build it, run it or run its tests (a test runner, compiler, linter or type check).",
      "Finished: let the last turn finish with the agent's answer. If it asks you something, answer it. If a turn stops early, send \"continue\".",
    ],
  },
  {
    id: "work",
    title: "Real work counts",
    points: [
      "Debugging, a feature, a refactor, performance or build work count most. Chats, read-only questions, coding puzzles and tutorial projects count less or not at all.",
      "Two real turns, or one long one. If a session is short, send one more follow-up.",
      "Few errors: if most tool calls fail, fix the setup (paths, dependencies) or ask the agent to step back.",
    ],
  },
  {
    id: "local",
    title: "Keep it local",
    points: [
      "Work with local code and test data. Cloud tools (gh, aws, vercel and the like), remote git (clone, pull, push), Docker, remote databases and web pages fail the project check.",
      "Avoid programs only your machine has (osascript, systemctl, adb and the like).",
      "If the agent calls a local dev server, start it in the same session.",
    ],
  },
  {
    id: "recording",
    title: "Keep recording on",
    points: [
      "Every turn uploads. Keep the app updated and recording on: a session that isn't recorded can't count.",
      "Don't quit while a turn is running or has just failed; the app asks before it lets you.",
    ],
  },
]);
