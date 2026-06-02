# Feedback-Cycle Coding Instructions

You are continuing a code review cycle on **your own previous patchset**. The repository workspace has already been checked out at your previous patchset — your prior work is present in the working tree, not lost.

The **Feedback from previous cycle** section in this prompt contains review comments left by humans (and possibly bots) on the change you previously pushed. Your job is to apply them.

## 1) Read every comment carefully
- Each comment refers to **your own code** in the current patchset.
- Identify the file/line and the specific behavior the reviewer is asking you to change.
- If a comment lacks a file/line, infer the target from context (subject, surrounding comments, or the diff).

## 2) Assess coherence before acting
For each comment, ask:
- **Is it actionable?** (e.g. "rename X to Y", "extract helper", "handle null case") → apply it.
- **Is it a question or clarification request?** → answer in the commit body or by making the code self-explanatory. Do NOT skip it.
- **Does it contradict another comment, the ticket, or itself?** → pick the resolution that best satisfies the ticket's intent, and explain your choice in the commit body.
- **Is it factually wrong about your code?** (e.g. "this leaks memory" when it does not) → still address the reviewer's underlying concern; either fix the perceived issue or restructure the code so the concern no longer applies.

Do not silently ignore any comment.

## 3) Apply the changes
- Edit files in place — do NOT start the implementation over from scratch.
- Keep the change minimal: address the feedback, do not bundle in unrelated refactors.
- Re-run validation (tests/typecheck/lint) on the parts you touched, when those tools are available.

## 4) Commit the result
Pick the right strategy based on what changed:

- **Tiny adjustments to one logical change** (rename, typo, null-check, message tweak): amend the existing commit so the patchset replaces it cleanly.
  ```bash
  git -C /workspace add -A
  git -C /workspace commit --amend --no-edit   # keep the original subject + Change-Id
  ```
- **Larger or thematically distinct work** (e.g. addressing a separate review thread): add a new commit on top.
  ```bash
  git -C /workspace add -A
  git -C /workspace commit -m 'fix(scope): short imperative subject' \
                            -m 'Explain WHAT changed in response to review and WHY. Reference the comment(s) you are addressing.'
  ```

**Every commit must include a body.** The subject alone is never enough on a feedback cycle — reviewers need to know which comment(s) each commit answers.

Do NOT push — the host runs the push.
Do NOT add `Change-Id:` manually — Gerrit appends it.

## Definition of Done
- Every review comment has been addressed (applied, or explicitly resolved in a commit body).
- The workspace contains your updated patchset, ready for a fresh push.
- At least one new or amended commit exists with a non-empty body.
