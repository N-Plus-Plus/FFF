<!-- Document ceiling: 90 lines; 5,800 characters including metadata. On overflow, apply AGENTS.md decision rule. -->
# Approved future outcomes

> **Repository instruction precedence:** [AGENTS.md](AGENTS.md) governs agent operating rules, owner-authorised requirements changes and unresolved conflicts.

This file is the repository's **future-only owner decision register**. It contains only owner-approved unfinished outcomes. It is not an implementation diary, completed-work history, speculative wishlist, test backlog, or permission for Codex to begin work. A task prompt still identifies what may be implemented now.

## Roadmap entry convention

Every approved unfinished outcome uses one unique level-three heading:

`### P<number> - Short title`

`P<number>` is the repository-local roadmap identifier and a loose priority/order signal. Lower numbers normally indicate earlier or more important work. Prefer gaps when assigning new IDs, commonly P10, P20, P30, so later items can be inserted without broad renumbering. Keep an existing ID stable unless the owner explicitly reprioritises that outcome. Gaps are valid and should not be tidied for appearance.

Each P heading represents exactly one outcome. Do not use one P heading as a priority bucket containing several independent features.

The body beneath the heading, up to the next `### P<number> - ...` heading, is the outcome description. It may be one sentence or several paragraphs/bullets. Describe the desired result and material boundaries, not an internal implementation plan.

Dependencies are optional. When useful, end the entry with:

`Depends on: P10, P20`

Omit the line when there is no meaningful dependency. Do not add mandatory Status, Owner, Complexity, dates, estimates or other project-management fields. Presence in this file already means **approved and unfinished**.

Example:

```markdown
### P10 - Short outcome title

Concise description of the intended result. Add detail only where it preserves an important product boundary or decision.

Depends on: P5
```

## Approved unfinished work

None.

## Maintenance

When the owner approves a new future outcome, add one P entry under **Approved unfinished work** using the convention above. Do not add speculative improvements discovered during unrelated tasks without owner approval.

When an outcome is substantively complete, remove its P entry. Preserve enduring requirements or implementation facts in the relevant specialist authority instead. Do not retain completed implementation as roadmap history merely because routine verification, documentation, deployment or owner acceptance has not yet been recorded, unless that remaining work is itself a meaningful owner-approved future outcome.

Keep only genuinely unfinished scope. Split combined legacy entries into separate P entries when they describe independently deliverable outcomes. Consolidate substantively duplicate entries rather than carrying parallel descriptions of the same future work.

If no approved unfinished outcomes remain, keep this file and the conventions above, with `None.` under **Approved unfinished work**.
