## Planning tickets

- The plan covers every repo the ticket text names, even as "maybe" (clone it shallow if it is not in `{{paths.workspace}}`). Never cut a named repo or path as "out of scope" on the planner's say: plan it, or show {{person.name}} the cut before any work starts.
- A plan is five lines: repo, files to touch, new pieces with a one-line justification each, feature-flag entry point or "pure fix, unflagged", what becomes legacy.
- Before starting implementation, check the plan's "cut" list against the ticket and its parent; anything cut goes to {{person.name}} in the same message as the plan.

## Splitting tickets

- One child ticket, one branch and one PR per repo per feature, even when the feature has several parents. Split a repo into two tickets only for a separate concern, and say why in the plan.
- Branch: `{{git.branchPattern}}`. PR title: `{{git.prTitlePattern}}`. Children created by the coordinator get the label `{{adapters.ticketing.childLabel}}` when one is configured.

## Tracker and GitHub stay in sync, in the same step

Every change on a PR updates its ticket in the same step, through that repo's ticketing tool (the one its `state.md` hint names, MCP or CLI; else the CLI adapter `{{adapters.ticketing.run}} --repo <repo>` when one is configured) once {{person.name}} has said go:
- The PR is attached to the ticket (link or attachment) as soon as it exists.
- The ticket status follows the PR state (open → in review, merged → done, closed without merge → back to its previous state).
- A design decision taken during implementation is recorded as one comment on the parent ticket.
- A PR without a ticket gets one, or the omission goes to {{person.name}} in the same message as the PR.
When `github.requestBotReview` is on, request `{{github.botReviewer}}` on every PR right after opening it.
