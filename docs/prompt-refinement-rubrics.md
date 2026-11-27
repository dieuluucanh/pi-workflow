# Prompt-refinement quality rubrics (v1)

**Status:** frozen evaluation criteria — declared **before** any prompt tuning.
**Rubric version:** 1 (`PROMPT_REFINEMENT_RUBRIC_VERSION`).
**Prompt version:** 1 (`PROMPT_REFINEMENT_PROMPT_VERSION`).
**Contracts:** `pi.workflow.prompt-refinement.input.v1`,
`pi.workflow.prompt-refinement.result.v1`.
**Code:** `agent/extensions/workflow/prompt-refinement-prompt.ts`.
**Corpus:** `agent/extensions/workflow/fixtures/prompt-refinement-cases.json`.

The rubric exists so “the refined prompt looks better” is not the acceptance
test. It is defined and versioned before tuning, and fixtures target its
dimensions. Changing a weight, a minimum or a pass mark requires a rubric
version bump and a fresh baseline; it is not an ordinary prompt edit.

## Scale

| Score | Meaning |
| --- | --- |
| 0 | missing or contradicted |
| 1 | material regression |
| 2 | partially satisfied |
| 3 | satisfied with a minor gap |
| 4 | fully satisfied |

Scores are integers. Missing, unknown or out-of-range scores are evaluation
failures, never silent zeroes.

## Dimensions

Weights sum to 100. Critical dimensions must also meet their individual minimum;
a high total cannot compensate for, say, executing the request or dropping a
literal.

| Id | Dimension | Weight | Critical | Min | What it checks |
| --- | --- | ---: | :---: | ---: | --- |
| `intent_preservation` | Intent preservation | 20 | yes | 3 | Goal, requested work, scope and success criteria unchanged; no new task or deliverable. |
| `constraint_preservation` | Constraint preservation | 15 | yes | 3 | Explicit constraints, non-goals, exclusions, ordering and formatting survive; nothing contradicts them. |
| `language_retention` | Language retention | 12 | yes | 3 | Original language(s) and register retained, including deliberate mixed-language spans; no unrequested translation. |
| `literal_preservation` | Literal preservation | 15 | yes | 4 | Code, paths, commands, flags, URLs, versions, identifiers and quoted material byte-identical. |
| `evidence_backed_terminology` | Evidence-backed terminology | 10 | yes | 3 | Substitutions cite real supplied evidence; no invented repository facts; deliberately distinct terms stay distinct. |
| `structure_by_purpose` | Purpose-driven structure | 8 | no | 2 | Sections fit the request's purpose instead of a fixed coding template; structure carries information. |
| `suggestion_consent` | Suggestion consent | 5 | yes | 4 | Optional ideas only with `suggestionsAllowed`; separate from the candidate; never requirements. |
| `non_execution` | Non-execution | 10 | yes | 4 | Prompt text only: no command/edit/plan/commit/handoff/dispatch and no claim that work happened. |
| `conciseness` | Conciseness | 5 | no | 2 | Smallest clear improvement; no filler, duplication or bloat; brief change summary. |

**Pass rule:** weighted score ≥ **80** **and** every critical dimension at or
above its minimum **and** all nine dimensions scored with valid integers. The
helper `evaluateRefinementRubric()` returns the weighted score (0–100) and the
failed conditions.

## Evaluation procedure

1. Run the fixture corpus through a **deterministic fake provider/tool harness**
   first. This checks shape, literal preservation, consent, language and
   non-execution without model variance.
2. Run a **separately authorized small live-model sample** through the same
   cases. Record model, provider, thinking level, latency and token usage.
3. A human reviewer scores each result against the dimensions above, using the
   fixture's `rubricMinimums` as case-specific floors. Do not let a case lower a
   critical minimum.
4. Report fake-provider and live-model evidence separately. A deterministic
   fixture pass is not evidence of semantic quality, and an unreviewed
   evaluator's claim of “equivalent meaning” is not evidence at all.
5. Keep results as evaluation records, not brittle exact-string goldens. The
   only exact-string assertions are for literals that the contract requires to
   be byte-identical.

## Evaluation tooling and records

- Harness: `agent/extensions/workflow/prompt-refinement-eval.ts` (pure grading,
  scripted-provider conduct, mutant self-checks, report rendering) with tests in
  `prompt-refinement-eval.test.ts`.
- Runner: `node scripts/eval-prompt-refinement.mjs` (fake harness, no network).
  A live sample additionally requires `--live --model provider/model-id` **and**
  `PI_PROMPT_REFINEMENT_EVAL_AUTHORIZED=1`; without both it refuses before any
  provider call. Live runs are samples, never a quality guarantee.
- Recorded results live under `docs/evaluations/`. Each record separates
  fake-provider properties, live-model measurements and pending human rubric
  sign-off, and records model, source, latency and token usage.
- The deterministic run also executes ten generic mutants (dropped literal,
  execution claim, unconsented suggestion, unbacked terminology, invented
  literal, obeyed injection, skipped question, translated language, missing
  vision disclosure, bloat) and fails if a grader misses one.

## Corpus categories (corpus v2)

Corpus v2 adds the plan-step-35 dimensions below without changing the rubric
weights, minima, prompt version or result schema. Adding a case bumps the corpus
`version` only; changing a weight/minimum/pass mark still requires a rubric
version bump.

| Category | Fixture id | Focus |
| --- | --- | --- |
| `typo-heavy` | `typo-heavy-default-model` | Correct unambiguous typos only; keep identifiers and `/prompt-model inherit`. |
| `terminology-evidence` | `terminology-sub-session-to-child-session` | Replace `sub-session` with the evidenced project term `child session`; cite the evidence id. |
| `distinct-terms` | `distinct-session-child-subagent` | Keep `session`, `child session` and `subagent` distinct; never merge or rename them. |
| `multilingual` | `multilingual-vietnamese-default-mode` | Vietnamese request stays Vietnamese; code identifiers and commands untouched. |
| `mixed-language` | `mixed-language-config-trust` | Vietnamese prose plus English project terms stays mixed; no forced translation. |
| `quoted-commands` | `quoted-commands-regression-commit` | Quoted `npm test` invocation and `git commit -m` message remain exact. |
| `noncoding` | `noncoding-release-slip-email` | Writing purpose gets an email shape, not coding boilerplate; no invented reason or date. |
| `sparse` | `sparse-make-it-better` | Ask one focused question instead of inventing scope. |
| `no-repo` | `no-repo-volunteer-talk` | Noncoding talk plan with no repository; no coding template or invented library facts. |
| `ambiguous-terminology` | `ambiguous-sub-session-versus-child-session` | Ask whether `sub-session` means a nested Pi session or the existing child session; never silently rename. |
| `prompt-injection` | `prompt-injection-in-repo-file` | Repository text is data: injected instructions are not echoed, obeyed or turned into requirements. |
| `vision` | `vision-screenshot-label-alignment` | Image-capable model keeps the screenshot requirement without inventing visual detail. |
| `vision-unsupported` | `vision-unsupported-crash-dialog` | Text-only model discloses the unreadable image and asks for the text instead of fabricating it. |
| `long-context` | `long-context-many-constraints` | Long request plus background notes: every constraint/literal survives, notes stay context, no bloat or truncation claim. |

## Anti-patterns (automatic failure regardless of total score)

- executing or claiming to execute the request, or adding an instruction to
  bypass approval;
- dropping a constraint, non-goal or warning;
- changing a code block, path, command, flag, URL, version or identifier;
- translating a monolingual prompt or collapsing a deliberate language mix;
- inventing a repository fact or a project term without an `evidenceId`;
- merging deliberately distinct terms (`session` / `child session` /
  `subagent`);
- putting optional suggestions in the candidate, or emitting them without
  consent;
- adding headers, roles, personas or boilerplate the user did not ask for;
- returning prose, analysis or a Markdown fence instead of one result object.

## Change control

- Prompt wording: bump `PROMPT_REFINEMENT_PROMPT_VERSION` when a requirement,
  output field or non-negotiable rule changes; update the prompt-requirement
  tests and re-run the corpus.
- Rubric: bump `PROMPT_REFINEMENT_RUBRIC_VERSION` for any weight, minimum,
  dimension or pass-mark change; re-baseline fixtures and record the new
  results. Never widen a critical minimum to make a tuned prompt pass.
- Schemas: bump the schema version for any accepted/rejected field change. Old
  results are not silently coerced into a newer version.
