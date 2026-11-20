# MailMind: local AI email assistant for Thunderbird

MailMind is a Thunderbird add-on for reading, writing, reviewing, sorting, filtering, filing and cleaning up email by chatting with an AI that runs **on your own computer**. It works with any OpenAI-compatible server, such as Ollama, LM Studio, the llama.cpp server or vLLM.

> "Sort through my 2021 emails and find anything that might be junk, then help me sort or delete them."

MailMind scans 2021, groups the mail by sender, and shows a review list like *"junk@email.com: 214 emails, never opened, spam-like subjects"*. You tick the senders or individual emails you want, then choose **Delete**, **Move**, **Archive** or **Mark as junk**. Nothing changes until you click, deleted mail goes to Trash, and every action can be undone.

## Install

1. **Thunderbird 128 or newer** (ESR 128/140 recommended).
2. **Let Thunderbird add-ons talk to Ollama.** Ollama blocks add-on requests by default, with a 403 error. In PowerShell, run:
   ```powershell
   [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "moz-extension://*", "User")
   # Optional but recommended: a bigger context window so the AI remembers more
   [Environment]::SetEnvironmentVariable("OLLAMA_CONTEXT_LENGTH", "16384", "User")
   ```
   Then quit Ollama from the system tray and start it again.
3. **Build the add-on**, or use the `.xpi` already in `artifacts/`:
   ```bash
   npm install
   npm run package        # → artifacts/mailmind-0.5.0.xpi
   ```
4. In Thunderbird, go to **Tools → Add-ons and Themes → ⚙ → Install Add-on From File…** and pick the `.xpi`.
5. Open MailMind's settings from the add-on's **Preferences** or the chat's **Settings** button, then click **Test connection & load models**. The default is `gemma4:latest` on `http://localhost:11434/v1`.
6. *Optional:* run `ollama pull nomic-embed-text` and enter it as the embedding model to turn on "search by meaning".

For development, run `npm run build` and load `dist/manifest.json` through **Debug Add-ons → Load Temporary Add-on**.

## Where to find it

| Place | What it does |
|---|---|
| **MailMind icon** in the left Spaces bar and the main toolbar | Opens the chat. **Pop out** opens the chat in a small window you can keep beside your mail. **History** lists your previous conversations so you can reopen or delete them; **New chat** keeps the old one there. |
| **MailMind button** in a message's header toolbar | Summarise, list action items, check for junk or phishing, explain, draft a reply in your style, **summarise the whole conversation**, **find dates & to-dos** and save them as a calendar file (.ics). |
| **MailMind button** in the compose window | Improve, fix grammar, shorten, notes → email, change tone, custom instructions, review before sending, suggest a subject. |
| **Right-click** on messages or folders | Ask about the selected emails, find all mail from a sender, find junk in a folder, suggest where to file the emails, **unsubscribe from a sender**, **what am I waiting on?** |
| **Notifications** (optional) | A daily briefing at the time you choose: unread mail, important emails with one-line summaries, follow-ups. |
| **Before sending** | Warns you if the email mentions an attachment but has none. |
| **Settings page** | Connection, models, behaviour, **automation** (auto-tagging, daily briefing, follow-up timing), **filter rules**, **recent actions with Undo**, clearing stored data. |

## Things to try in the chat

- "Find junk in my 2021 emails and help me delete it"
- "Search my emails and find all emails about my stock trading and list all the attachments"
  → expands "stock trading" into keywords and brokerages, searches them all, has the AI drop false hits such as
  "back in stock!" promos, then shows the emails plus an attachments card (filter by type, Open, Save, **Save all as .zip**).
  Follow-ups like "move those to a Trading folder" act on the same emails.
- "Who sent me the most email last year?"
- "Summarise my unread emails from this week"
- "Help me file the emails in my inbox"
- "Create a rule: anything from newsletters goes to a Reading folder and is marked read"
- "Move all emails from receipts@shop.example to Receipts"
- "Draft a polite email to my landlord about the broken heater"
- "Find the email where Dave sent the flight details" (works better with an embedding model)
- "What am I waiting on, and what haven't I answered?" → a **follow-ups** card: emails you sent that got no reply
  (with **Draft nudge**) and emails from people you write to that you haven't answered (with **Draft reply**). Snooze or dismiss items.
- "Which newsletters should I unsubscribe from?" → a **subscriptions** card ranked by unread volume, with **Unsubscribe**,
  **Move all to Trash** and **Rule for future mail**. Senders that look like spam get **Mark as junk** instead, because
  unsubscribing from spam confirms your address.
- "Summarise this whole thread" / "Add the meeting in this email to my calendar"
- "Tag the emails from this week" → AI tags (Needs reply, FYI, Receipt, Travel, Newsletter), one approval card per tag
  plus your own tags. Add them in **Settings → Automation → Add your own tag** (a name and a line saying which emails get it), or click **Suggest tags from my mail** and the AI proposes some for you to edit and add. Nothing is created until you click Add.
- "Give me my daily briefing"
- "Suggest some categories for my email" → the AI looks for topics in your recent mail (e.g. *Kids' school*, *Car*)
  and shows each idea as a card: rename it, untick senders that don't belong, then **Create** or **Not useful**.
  Then: "show my Kids' school emails from this term", "put coach@club.example in Kids' school".

## Safety and privacy

- **The AI can't change your mail by itself.** The tools it uses can only *propose* changes, and each proposal shows up as a card with Approve/Reject buttons. Tests check this (`tests/agent.test.ts`).
- **Deleted mail goes to Trash.** Anything already in Trash is skipped, so nothing is ever deleted permanently. Every action is logged, and **Undo** finds the messages by their Message-ID and moves them back.
- **Email content is treated as untrusted.** It's marked off in prompts, and the AI is told not to follow instructions inside emails. Even if an email does trick it, the worst it can do is suggest something you can reject.
- **Nothing leaves your computer.** MailMind only connects to the AI server you set. It warns you if that server isn't on your computer or local network. There's no telemetry. The one exception is **Unsubscribe**: when you click it for a sender, MailMind contacts that sender's unsubscribe link (one-click POST after Thunderbird asks your permission for that site, no cookies), opens their page in your browser, or opens an unsubscribe email that you send yourself.
- **Automation is off by default.** Auto-tagging only touches new mail from the last 2 days, at most 50 messages at a time, and every batch appears under *Recent actions* with Undo. The daily briefing only reads mail.
- **Junk scores are saved, not acted on.** New mail's senders get an AI junk score as they arrive, and a background scan slowly scores older mail (one month at a time, at most one AI request per minute). It pauses whenever the chat, popups or new-mail automation need the AI, and stops its current request so yours runs right away. A clean-up then reuses these scores instead of asking the AI again. **"👍 Not junk" always overrides a saved score** (and deletes it). Pressing Junk / Not Junk in Thunderbird makes MailMind judge that sender again, and so does writing to them. Scores also expire after 60 days. Both can be switched off, and the scores cleared, in Settings.
- **Categories.** Every sender gets a built-in category: junk, promo, newsletter, social, notification, security, order update, travel / booking, bills / finance, personal or important. Bills are never suggested for clean-up and always ask before deleting. Recent security codes are protected; ones older than 30 days are fair game.
- **Smart categories are suggestions.** About once a week (or when you ask) the AI suggests topic categories it notices in your mail. Nothing exists until you approve it, and senders you add or remove yourself are never changed by the AI. Smart categories never change emails or junk scores, and can be switched off or cleared in Settings.
- **Filter rules** are kept by the add-on and run on new mail, because Thunderbird doesn't let add-ons create its built-in filters. You can switch them off or delete them in Settings.

## How it works

```
src/
  background/main.ts        Spaces/toolbar buttons, menus, rules on new mail, attachment check before sending
  core/
    llm.ts                  OpenAI-compatible client (streaming, tool calls, embeddings)
    jsonTools.ts            Compatibility mode for models without native tool calling
    agent.ts                Tool-calling loop (step limit, trims history to fit the context window)
    conversations.ts        Saved chat conversations (history list)
    tools.ts                Tools the AI can use (read-only tools + tools that only make proposals)
    prompts.ts              System prompts
    mail.ts                 Wrappers around Thunderbird's messenger.* APIs
    triage.ts               Junk scoring by sender (heuristics + AI for uncertain senders)
    junkScores.ts           Saved AI junk verdicts per sender (new mail, clean-ups); user feedback overrides them
    backfill.ts             Background scan that scores older mail month by month
    aiActivity.ts           Tells the background scan when the AI is busy with something else
    smartCategories.ts      AI-suggested topic categories, approvals and per-sender placement
    actions.ts              Runs approved actions in batches, plus the undo log
    rules.ts                Filter rules
    filing.ts               Folder suggestions (filing history + AI)
    embeddings.ts           IndexedDB embedding cache + semantic search
    thread.ts               Rebuilds a conversation from References/In-Reply-To
    events.ts               Finds events and to-dos in an email, writes .ics files
    followups.ts            "Waiting on them" / "waiting on you"
    unsubscribe.ts          List-Unsubscribe parsing, ranking newsletters, unsubscribing
    autotag.ts              Optional AI tagging of new mail
    digest.ts               Daily briefing
  ui/
    chat/                   Chat page + review cards
    popups/                 Message and compose popups
    options/                Settings page
    presend/                "Forgot an attachment?" window
```

The AI runs inside the chat page rather than the background script, so long jobs aren't cut off when Thunderbird suspends the background script. If a model doesn't support native tool calling (for example `gemma3` on Ollama), MailMind detects this and switches to a JSON format that works with any model.

**Junk triage** uses the AI only where it's needed. First it groups mail by sender. Then it checks signals such as "you've written to them", "never opened", an unsubscribe link, Thunderbird's own junk score, and spam-like subjects. Only senders it isn't sure about, plus high-volume ones, go to the AI, about 10 senders per prompt. That keeps it fast even with thousands of emails.

## Tests

```bash
npm test                                                    # unit tests (fake Thunderbird APIs, scripted AI)
MAILMIND_IT=1 npx vitest run tests/ollama.integration.test.ts   # live test against your local model
npm run typecheck
```

## Roadmap

- Voice: local Whisper speech-to-text and text-to-speech through a small helper app
- A docked sidebar and native Thunderbird filters (these need Experiment APIs)
- Indexing message bodies in the background for better semantic search
- Writing events straight into Thunderbird's calendar (needs an Experiment API; for now MailMind saves an .ics file)
