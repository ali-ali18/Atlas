# Gemini agentic assistant and Alexa+: coherence of use (state as of Nov 2026)

Method note: ~13 searches/fetches. Primary sources fetched: Google Gemini and Chrome support pages, Google Chrome security blog (Dec 2025), Google I/O 2026 roundup (May 2026), ap2-protocol.org, an Amazon help page. Most Alexa+ evidence is secondary press. Fetch summaries were produced by a small model; quotes are paraphrases. Anything dated before mid-2026 is marked "older".

## 1. When do they act alone vs ask? Confirmation design (purchases, sending, booking)

### Takeaway
Google uses a layered, rule-based model: the user approves a plan up front, then gets a per-task confirmation, and sensitive classes (send, purchase, form submit, data change, sign-in) require confirmation every time, even with "Always allow". Several steps are handed back to the user rather than approved (financial transaction, terms of service, account creation). For Alexa+ I found no primary documentation of a confirmation design; only a post-hoc confirmation email from the provider.

### Cited Findings
- Gemini "tasks" (the support page's name for what the user called Gemini Agent): the first browsing task on a device triggers a Chrome permission request; after that Gemini asks confirmation before each browsing task. Sending communications, changing or deleting data, purchases, financial transactions, submitting web forms and Sign in with Google need confirmation each time, even with "Always allow". Built-in checks pause before sharing health, financial or government ID info. Gemini pauses and asks the user to take over for sign-in or sensitive entry. Requires AI Pro/Ultra, 18+, Keep Activity on, Personal Intelligence opt-in; not in EEA, UK, Switzerland, Nigeria. — [Google Gemini Help](https://support.google.com/gemini/answer/16596215)
- Same page lists an exception to the pattern: Gemini "can perform bulk actions on private Google Tasks without confirmation". Page also calls the feature experimental and says it "can make mistakes and do unexpected things." — [Google Gemini Help](https://support.google.com/gemini/answer/16596215)
- Chrome auto browse: Gemini asks the user to review its plan before starting; confirms before sending communications, modifying data, submitting forms, scheduling events, and accessing highly sensitive financial/health sites. It cannot finalize financial transactions, accept terms of service, or create accounts without the user taking over. Desktop only, US 18+, Pro/Ultra/Plus, not Incognito. — [Chrome Help](https://support.google.com/chrome/answer/16821166?hl=en)
- The same Chrome page lists failure modes Google itself names: clicking the wrong button, "buying something without permission", wrongly confirming a task is complete; and states "You are responsible for Gemini's actions, including purchases." — [Chrome Help](https://support.google.com/chrome/answer/16821166?hl=en)
- Chrome security post (8 Dec 2025): confirmations are triggered by a deterministic list of sensitive sites (banking, medical), by signing in via Google Password Manager (model never sees passwords), and by impactful actions (purchase, payment, message); the agent pauses and either asks permission or hands the final step to the user. Users can watch a work log, take over or stop. — [Google blog](https://blog.google/security/architecting-security-for-agentic/)
- Gemini Spark (announced I/O, May 2026): 24/7 background personal agent "designed to check with you before taking major actions". Beta planned for US AI Ultra subscribers; planned for summer 2026: texting/emailing Spark, custom sub-agents, and authorizing payments "with a set budget and approved merchants" (i.e. a pre-authorized autonomy envelope, not per-purchase approval). — [Google I/O 2026 roundup](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/)
- Older (2025) agentic checkout in AI Mode: user sets target price, gets notified, then confirms purchase details and taps "buy for me"; Google adds to merchant cart and completes checkout with Google Pay. US merchants incl. Wayfair, Chewy, Quince, select Shopify merchants. Loyalty programs not factored in at the time. — [9to5Google, Nov 2025](https://9to5google.com/2025/11/13/google-agentic-shopping/); [Tom's Guide on AI Mode checkout](https://www.tomsguide.com/tech-events/googles-new-universal-cart-uses-ai-to-track-deals-and-shop-across-apps) (search snippet only; page body not retrievable)
- AP2 (Agent Payments Protocol): open protocol, extension of A2A and UCP; uses cryptographically signed verifiable digital credentials called mandates, in an Open stage (user constraints/budget/allowed instruments, before a final cart) and a Closed stage (authorization for a finalized checkout or specific amount). Goal: non-repudiable audit trail for dispute resolution. Samples for human-present and human-not-present flows. v0.2, announced 16 Sep 2025; standardization moving to FIDO Alliance working groups. The page poses but does not answer who is liable when something goes wrong. Initial version supports cards; wallets on roadmap. — [ap2-protocol.org](https://ap2-protocol.org/)
- Universal Cart (I/O 2026): checkout "right on Google" via UCP and Google Pay, or hand-off to the retailer's site; built on Google Wallet so it can factor in loyalty and offers. The roundup page describes no explicit approval step for cart purchases. "This summer" for Search and Gemini app. — [Google I/O 2026 roundup](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/)
- Alexa+: Amazon says Nova Act (browser-agent) lets Alexa+ complete tasks on sites without APIs (navigate, fill forms), per a PYMNTS summary of a Wired piece that PYMNTS flags as sponsored content (Dec 2025). Nothing on confirmation. — [PYMNTS](https://www.pymnts.com/?p=3289499)
- Alexa+ third-party orders/bookings: Amazon's help page says the service provider sends a confirmation email to the Amazon account address; for questions, contact the provider. Page does not describe pre-action confirmation, payment handling or cancellation. (Hosted on a non-standard Amazon subdomain.) — [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/TGRz4Y1pwCan6UaCsa)
- Older, pre-Alexa+ voice shopping: optional voice code and the ability to disable voice purchasing; Amazon pointed to those settings after the 2017 dollhouse incident. Whether they govern Alexa+ agentic purchases is not established. — [Make Tech Easier](https://maketecheasier.com/smart-home/avoid-accidental-voice-purchasing-with-amazon-alexa)

### Inferences
- Google's coherence comes from a small number of stable rules (action class decides, not context): send/buy/submit/sign-in always confirm; money movement and ToS are human hand-offs; autonomy is widened only through explicit pre-authorization (budget + approved merchants, AP2 Open mandates).
- Weak spots: the bulk Google Tasks exception and the warning that the agent may buy "without permission" show the rule is not a hard guarantee; cart approval in Universal Cart is undocumented.
- Alexa+ confirmation design appears undocumented publicly; the visible pattern is "act, then provider emails you", which is inconsistent with Google's ask-first pattern (inference from absence; unverified).

### Gaps
- No primary Amazon source on whether Alexa+ asks before booking/buying, or on spending limits.
- Whether Spark's budget/merchant authorization and Universal Cart checkout actually shipped as of Nov 2026 not verified (sources are May 2026 announcements).
- No hard data on how often Google's confirmations trigger unnecessarily (friction); Google only says it will tune gating.

## 2. How progress and results are shown (cards, sources, listings)

### Takeaway
Google shows the agent's work as a visible, interruptible process (plan review, work log, live remote-browser view, take over) and shopping results as structured product/price surfaces (cart, price history). Alexa+ evidence on result presentation is thin.

### Cited Findings
- Gemini tasks: "View live" a remote browser, "Take over task", "Go back to Gemini"; stop browsing or stop the whole task from the text box; schedules managed on a Scheduled page and task thread. — [Google Gemini Help](https://support.google.com/gemini/answer/16596215)
- Chrome: pages Gemini visits appear in Chrome history with a Gemini action icon; chats appear in Gemini Apps Activity; Stop button in side panel. — [Chrome Help](https://support.google.com/chrome/answer/16821166?hl=en)
- Universal Cart: price history, deals, restock alerts, incompatibility flags with alternatives. — [Google I/O 2026 roundup](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/)
- Alexa.com (launched CES, 5 Jan 2026; US, Early Access at launch; ChatGPT-style chat; no voice input in browser; conversations continue across devices; integrations with Expedia, Yelp, Angi, Square). — [iPhone in Canada](https://www.iphoneincanada.ca/2026/01/05/amazon-pushes-alexa-beyond-echo-devices-with-a-big-web-move/)

### Inferences
- Google exposes the same three controls (watch, pause/take over, stop) across surfaces, which supports predictability; Alexa.com adds a screen surface to a voice-first product but I found no documentation of how progress or sources are rendered.

### Gaps
- No primary description of Alexa+ result cards, sources, or progress UI.
- Gemini app's in-chat card/source design for agent results not retrieved.

## 3. Memory transparency and controls

### Takeaway
Google ties agent behavior to an explicit, per-app opt-in layer (Personal Intelligence, Connected Apps) plus activity logs; Alexa+ offers a "Remember this" note store that is user-reviewable, but evidence on control depth is third-party.

### Cited Findings
- Tasks draw on Connected Apps, skills, chats, Personal Intelligence (incl. memory of past chats) and location; Personal Intelligence opt-in and Keep Activity are prerequisites; Connected Apps list is reviewable; remote browser/code-execution data deletable; turning off task mode does not erase Chrome data or chats. — [Google Gemini Help](https://support.google.com/gemini/answer/16596215)
- Personal Intelligence: user chooses whether and when to connect each app (Gmail, Photos; Calendar "soon" in AI Mode); expanded to nearly 200 countries without subscription (per I/O page). — [Google I/O 2026 roundup](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/)
- Secondary reporting: off by default, per-app disconnect, review via My Activity, Google says it does not train directly on Gmail/Photos content but prompts/responses may be used (sources disagree on detail; not verified against Google's own page). — [MindStudio](https://www.mindstudio.ai/blog/google-gemini-personal-intelligence-ai-search-your-data); [DataCamp](https://www.datacamp.com/blog/gemini-personal-intelligence)
- Daily Brief learns user preferences over time (per I/O page). — [Google I/O 2026 roundup](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/)
- Alexa+: Amazon product page says it remembers context so users can switch topics and return. — [Amazon Alexa+](https://www.amazon.com/alexaplus/dp/B0CXRRF584) (via search snippet)
- Alexa+ "Remember this": reviewable in Alexa app > More > Alexa Privacy > Review Info in Remember this; notes can be archived individually or all at once (help page says "archive", not delete). — [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/Tpng6L11q9FjjqgHsd) (search snippet); third-party blog claims no per-entry voice forget (unverified) — [memx.app](https://memx.app/blog/alexa-plus-remember-this/)

### Inferences
- Google separates three layers (connected data sources, chat memory, activity log) each with its own switch, which is clear but spread over several settings pages; Alexa+ separates explicit notes (visible, archivable) from implicit personalization (less visible).

### Gaps
- Gemini's saved-info/memory editing UI not retrieved from primary source.
- Alexa+ implicit-personalization controls not found; one launch-era article reported errors when opting out of data sharing (older, unverified).

## 4. Proactivity: briefs, price tracking, follow-ups, scheduled actions

### Takeaway
Google has made proactivity an explicit product object (Scheduled page, Daily Brief, Universal Cart alerts) that the user can see, pause and resume. Alexa+ proactivity is described mainly in launch marketing.

### Cited Findings
- Scheduled actions: run tasks at a set time or on an event (example: delayed flight); pause/resume from the task thread or Scheduled page; do not run when task mode is off or device off; max 15 concurrent tasks and schedules do not run at the limit. — [Google Gemini Help](https://support.google.com/gemini/answer/16596215)
- Daily Brief: prioritized digest from goals, inbox, calendar, tasks, with suggested next steps; from 20 May 2026 for Google AI subscribers 18+ in the Gemini app, US first; requires connecting Google apps. — [Google I/O 2026 roundup](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/)
- Price tracking: target-price alerts in AI Mode (2025); Universal Cart adds price history, drops and restock alerts. — [9to5Google](https://9to5google.com/2025/11/13/google-agentic-shopping/); [Google I/O 2026 roundup](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/)
- Alexa+ (launch-era marketing, older): warns of traffic delays, notifies about sales on items you've watched; pitched as "ambient assistance" running in the background. — [PYMNTS](https://www.pymnts.com/?p=3289499); [Amazon deal notifications via PPC Land](https://ppc.land/amazon-updates-alexa-to-notify-users-when-there-are-deals)

### Inferences
- Google's schedule objects are inspectable, which makes recurring behavior predictable; the limits (15 tasks, device awake for local browser) are the places behavior diverges from the "always on" promise.

### Gaps
- Whether Alexa+ can create and manage its own follow-ups or reminders autonomously ("Alexa+ follows up"): not found in primary sources.
- Daily Brief content/format and user complaints not found.

## 5. Prompt-injection defences and separation of user vs external content

### Takeaway
Google has the most explicit published architecture: separate critic model that never sees untrusted content, origin sets that restrict readable and writable sites, a parallel injection classifier, and deterministic confirmation triggers. Google states none of it is a guarantee. Amazon: nothing found.

### Cited Findings
- User Alignment Critic: separate Gemini model, runs after planning, checks each proposed action against the user's stated goal, sees only action metadata (not untrusted web content), can veto and send feedback to the planner; repeated failures return control to the user. — [Google blog, 8 Dec 2025](https://blog.google/security/architecting-security-for-agentic/)
- Origin Sets: gating function decides relevant origins; read-only origins (content visible to model) vs read-writable (agent can click/type); data from read-only origins can flow only to writable ones; the planner cannot add origins without gating approval; model-generated URLs checked deterministically; initial implementation tracks only the read-writable set. — [Google blog](https://blog.google/security/architecting-security-for-agentic/)
- Prompt-injection classifier on every page, in parallel with planning; spotlighting (prioritize user/system instructions over page content); adversarial training; automated red-teaming; bug bounty up to $20,000 for breaches of the agentic security boundaries. Google acknowledges it cannot catch everything. — [Google blog](https://blog.google/security/architecting-security-for-agentic/)
- Gemini support page: names hidden instructions in websites/documents as a risk and recommends active supervision; safeguards "do not fully prevent risks". — [Google Gemini Help](https://support.google.com/gemini/answer/16596215)
- Critic of the whole category (opinion): Lauren Weinstein argues against using any agentic browsing. — [Lauren Weinstein, Feb 2026](https://lauren.vortex.com/2026/02) (opinion, not tested)
- Alexa+: no published injection defences found. Nova Act has an AWS responsible-AI service card (not fetched): [AWS](https://docs.aws.amazon.com/ai/responsible-ai/nova-act/overview.html)

### Inferences
- The design principle most transferable: the component that authorizes actions never ingests untrusted content; permissions are scoped per task (origins) rather than global.
- Because Google itself documents "buying something without permission" as a possible failure, confirmation prompts are best read as a second layer, not proof of safety.

### Gaps
- Independent red-team results against Chrome auto browse not collected.
- Amazon's agent-security posture unknown; AWS service card not read.

## 6. Long tasks, errors, recovery; documented inconsistency complaints

### Takeaway
Both products ship as "experimental"/early, with documented gaps between promise and execution. Gemini failures are mostly stalls and wrong clicks with a clear takeover path; Alexa+ complaints center on basic reliability and latency, anecdotal and press-driven.

### Cited Findings
- Gemini: local browser tasks need device and Chrome awake, else may switch to remote browser (mobile only); usage limits by complexity; auto browse is desktop-only while tasks span mobile and web, a surface mismatch. — [Google Gemini Help](https://support.google.com/gemini/answer/16596215)
- Hands-on: Wired found auto browse better than prior agent tools but "didn't quite click" (mirror copy). — [Wired mirror](https://wirednews.pages.dev/story/google-chrome-auto-browse-hands-on)
- Third-party troubleshooting lists stalls on CAPTCHAs, cookie banners, logins, loops; a Chromium form-filling fix for stale form data (June 2026). — [Chrome Story](https://chromestory.com/2026/06/chromium-gemini-agent-form-filling-fix/) (secondary, not verified)
- Alexa+: WIRED (Reece Rogers, 6 Mar 2026, after a month on Echo Show 15) concluded it lacks basic reliability; one example was a bathroom-fan timer command that previously worked and now works intermittently; latency up to ~15 s reported. — [WIRED mirror](https://drwebdomain.blog/2026/03/08/why-is-alexa-so-bad-wired) (mirror; verify at wired.com)
- Counterpoint: TechRadar argues expectations for a free service may be too high; Consumer Reports praised conversation but criticized the app. — [TechRadar](https://www.techradar.com/ai-platforms-assistants/were-definitely-beta-testing-this-technology-is-alexa-really-bad-or-are-our-expectations-for-free-services-too-high); [AI Productivity roundup](https://aiproductivity.ai/news/amazon-alexa-plus-stumbles-real-world-testing/)
- Alexa+ launch-era: employee beta testers reported erratic behavior (e.g. ignored requests for silence). — [Benzatine](https://benzatine.com/news-room/amazon-alexa-beta-testers-share-frustrating-experiences-it-killed-my-fish) (secondary, anecdotal)

### Inferences
- The recurring inconsistency theme is regression of previously deterministic commands when moved to an LLM (Alexa+) and surface/availability fragmentation (Gemini: tasks vs Chrome vs Spark vs regions/tiers).
- Both vendors shift responsibility to the user in policy text (Google: "You are responsible for Gemini's actions").

### Gaps
- No quantitative reliability data for either product; all complaint evidence is anecdotal or reviewer-based.
- Recovery behavior for failed Alexa+ bookings undocumented.
- Status of Gemini Spark and Universal Cart in Nov 2026 unverified; Gemini in Chrome behavior beyond auto browse (page Q&A, etc.) not covered.
