## Drafts written for {{person.name}}

Optional rule (`rules.optional: [drafts]`): for people who have the coordinator write text they post as their own.

- Write in the language and tone {{person.name}} configured (`person.language` = `{{person.language}}`, `person.tone` = `{{person.tone}}`; an empty value means no preference). UI labels stay verbatim in `{{person.uiTermsLanguage}}`, never translated or invented.
- A draft is facts plus, when needed, one neutral question. Never "I recommend" inside text {{person.name}} will post as their own.
- At most two proof links (PR, commit, line). No apology, no filler.
- Channels listed in `adapters.chat.draftOnlyChannels` ({{adapters.chat.draftOnlyChannels}}, plus those of a repo's own `chat` block) cannot be posted to by the bot: write the draft to a file, tell {{person.name}} where.
- Every draft waiting on "post" is a board decision too, added in the turn the draft is shown.
