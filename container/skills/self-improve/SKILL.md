---
name: self-improve
description: Propose improvements to your own capabilities, memory, or behavior. Use when you notice a pattern that could be automated, a task that was harder than it should be, or a capability that would genuinely help this group. Proposals are saved and surfaced to the user for discussion with Claude Code.
---

# Self-Improvement Proposals

You can propose improvements to yourself — new capabilities, better memory structures, workflow automations, integrations, or behavior changes. You can't modify the code directly, but you can draft a proposal that the user will discuss with Claude Code and implement if it's good.

## When to Propose

Propose when you notice one of these signals:
- A task you just did was harder than it should be (missing tool, missing context, repetitive steps)
- The user said "I wish you could..." or expressed frustration at a limitation
- You spotted a pattern in past conversations that could be automated
- You learned something that suggests a new useful integration (like a service the user uses regularly)
- You find yourself looking up the same information repeatedly (should be cached/structured)
- A skill you have could be extended to do something more useful for this specific group

Don't propose for every small thing. Propose when you're genuinely confident it would add value.

## Proposal Format

Save the proposal as `/workspace/group/improvements/YYYY-MM-DD-short-title.md`:

```
# Proposal: [Title]

Date: YYYY-MM-DD
Group: [your group name, from the folder you're running in]
Category: [capability | memory | workflow | integration | behavior]
Priority: [low | medium | high]

## Problem
[What friction or opportunity triggered this? Be specific — reference the actual task or conversation.]

## Proposed Improvement
[What should change? Could be: a new skill file, a CLAUDE.md update, a scheduled task, a new integration, a code change in the project. Be concrete.]

## Why Now
[What made you notice this? A specific user request, a repeated pattern, something you just learned?]

## Notes
[Constraints, dependencies, things Claude Code should know when implementing.]
```

## How to Notify the User

After saving the proposal, add a brief postscript to your response (or send via `send_message` if you've already replied):

```
_Improvement idea drafted: [Title] — mention it to Claude Code when you want to discuss it._
```

Keep it low-key. Don't interrupt your main response or make it a big deal. The user will pick it up when they're ready.

## Reviewing Past Proposals

The user might ask you to list or describe your proposals. Read files in `/workspace/group/improvements/` and summarize them.

If a proposal was implemented, note it in the file (add `Status: implemented` at the top) so you don't re-propose it.
