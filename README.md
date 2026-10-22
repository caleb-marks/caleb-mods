# caleb-mods

Three Claude Code mods.

## prompt-optimizer

- **Optimize prompt** button above the prompt box (or `/optimize <draft>`): Opus 5.5 (medium effort) rewrites your draft as one measurable `Goal:` paragraph. Press it again to restore your draft.
- **Next-prompt suggestion**: after each answer, Opus 5.5 (medium effort) writes the prompt you most likely send next (15 words or fewer). It shows as a button above the prompt box. In the desktop app, one click sends it. In the terminal, one click puts it in the box to edit.

## adhd-reminder

While your output style is named `ADHD`, adds the rules from `~/.claude/output-styles/adhd.md` beside each prompt, so long sessions keep the style. It follows the style the session actually uses, including one picked in the app. It does nothing without that file.

## quiet-tools

Draws each tool call in the terminal as one plain-English line of 20 words or fewer, for example "Check if the job scanner is still running". It hides tool output unless a call fails or is stopped. Press ctrl+o to see the full commands and output. It also asks Claude to write each command description for a beginner.

## Install

At the prompt of a terminal session:

```
/plugin install prompt-optimizer --marketplace caleb-marks/caleb-mods
/plugin install adhd-reminder --marketplace caleb-marks/caleb-mods
/plugin install quiet-tools --marketplace caleb-marks/caleb-mods
```

From a shell:

```
claude plugin install prompt-optimizer --marketplace caleb-marks/caleb-mods
claude plugin install adhd-reminder --marketplace caleb-marks/caleb-mods
claude plugin install quiet-tools --marketplace caleb-marks/caleb-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `caleb-marks/caleb-mods`, then Add plugin.
