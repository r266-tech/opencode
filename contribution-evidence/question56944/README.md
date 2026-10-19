# OpenCode issue 56944 terminal frames

These images render captured foreground/background spans from the real production FormPrompt via @opentui/solid testRender at 80x20. The local fixture supplies synthetic questions and HTTP replies; no live service or model is used.

Before: current upstream v2, a 40-paragraph question is clipped and cannot be paged to its end.
After: PageDown reaches QUESTION-END inside the bounded content area; the form footer remains visible.

The source-only PR branch is question-scroll. This separate evidence branch keeps generated images out of the code diff.
