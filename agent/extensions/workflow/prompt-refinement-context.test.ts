/**
 * Prompt-refinement context preparation (parity plan row 9).
 *
 * Guarantees under test:
 *   - current-branch selection is compaction-aware (summary, not replayed
 *     pre-compaction history) and bounded with explicit truncation notes;
 *   - hidden thinking, raw tool results and workflow-injected entries never
 *     reach the child context;
 *   - credentials are redacted before any context text is released;
 *   - image bytes and attachment IDs stay separate, and bytes only leave for a
 *     capability-validated image model; unsupported images are disclosed with a
 *     request for text instead of a model change;
 *   - provenance carries the policy generation, and changed authority drops
 *     file-derived context instead of carrying it into a later provider turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REFINEMENT_CONTEXT_LIMITS,
  appendInspectionEvidence,
  contextPolicyChanged,
  describePreparedContext,
  imageDigest,
  planRefinementImages,
  policyGenerationId,
  prepareRefinementContext,
  redactCredentials,
  withoutFileContext,
  type RefinementPolicySnapshot,
} from "./prompt-refinement-context.ts";

const POLICY: RefinementPolicySnapshot = {
  trusted: true,
  root: "C:/Users/Lenovo/.pi",
  grants: ["C:/Users/Lenovo/.pi/agent/extensions/workflow"],
  sensitivePatterns: ["**/.env", "**/*.pem"],
  excludePaths: ["node_modules"],
  outside: "block",
};

const PNG_BASE64 = Buffer.from("hello image").toString("base64");

function userEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    message: { role: "user", content: text },
  };
}

function assistantEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

test("context: compaction-aware current-branch selection excludes old history and hidden data", () => {
  const branch = [
    userEntry("old-u", "old unrelated history that was summarized away"),
    assistantEntry("old-a", "old answer"),
    { type: "compaction", id: "c1", summary: "Summary: the user is refining a child-session lifecycle prompt." },
    userEntry("u1", "Please improve the child-session lifecycle"),
    {
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_THOUGHT_NEVER_FORWARD" },
          { type: "text", text: "I will inspect the workflow extension." },
        ],
      },
    },
    {
      type: "message",
      id: "t1",
      message: { role: "toolResult", content: "raw tool log line that must not be replayed" },
    },
    { type: "custom_message", id: "w1", customType: "workflow-context", content: "injected plan context" },
    { type: "usage", id: "usage-1", kind: "cache_warm" },
  ];

  const prepared = prepareRefinementContext({
    branch,
    policy: POLICY,
    modelInput: ["text"],
  });

  assert.match(prepared.text, /Conversation summary \(compacted\)/);
  assert.match(prepared.text, /child-session lifecycle prompt/);
  assert.match(prepared.text, /Please improve the child-session lifecycle/);
  assert.match(prepared.text, /I will inspect the workflow extension\./);

  assert.doesNotMatch(prepared.text, /old unrelated history/);
  assert.doesNotMatch(prepared.text, /SECRET_THOUGHT_NEVER_FORWARD/);
  assert.doesNotMatch(prepared.text, /raw tool log line/);
  assert.doesNotMatch(prepared.text, /injected plan context/);

  assert.ok(prepared.disclosures.some((note) => /compaction/i.test(note)));
  assert.ok(prepared.disclosures.some((note) => /thinking/i.test(note)));
  assert.ok(prepared.disclosures.some((note) => /tool result/i.test(note)));
  assert.ok(prepared.disclosures.some((note) => /workflow-injected/i.test(note)));

  assert.equal(prepared.policyGeneration, policyGenerationId(POLICY));
  const conversation = prepared.blocks.find(
    (block) => block.label === "Recent conversation (current branch)",
  );
  assert.ok(conversation);
  assert.deepEqual(conversation.provenance.entryIds, ["u1", "a1"]);
  assert.equal(conversation.provenance.kind, "conversation");
  assert.equal(conversation.provenance.policyGeneration, prepared.policyGeneration);

  const compacted = prepared.blocks.find(
    (block) => block.provenance.kind === "compaction",
  );
  assert.ok(compacted);
  assert.deepEqual(compacted.provenance.entryIds, ["c1"]);
});

test("context: credentials are redacted before release", () => {
  const secretText = [
    "api_key=sk-abcdefghijklmnop1234",
    "Authorization: Bearer abcdefghijklmnop",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    "-----END RSA PRIVATE KEY-----",
    "An ordinary sentence about architecture stays readable.",
  ].join("\n");

  const prepared = prepareRefinementContext({
    branch: [userEntry("u1", secretText)],
    policy: POLICY,
    modelInput: ["text"],
  });

  assert.doesNotMatch(prepared.text, /sk-abcdefghijklmnop1234/);
  assert.doesNotMatch(prepared.text, /abcdefghijklmnop/);
  assert.doesNotMatch(prepared.text, /MIIBOgIBAAJBAKj34/);
  assert.match(prepared.text, /\[redacted/);
  assert.match(prepared.text, /ordinary sentence about architecture/);
  assert.ok(prepared.disclosures.some((note) => /credentials were redacted/i.test(note)));

  const direct = redactCredentials("token=supersecret123456");
  assert.equal(direct.redacted, true);
  assert.doesNotMatch(direct.text, /supersecret123456/);
  assert.equal(redactCredentials("ordinary words").redacted, false);
});

test("context: recent selection is bounded and discloses truncation", () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    type: "message",
    id: `m${index}`,
    message: {
      role: "user",
      content: `message-${index} ${"x".repeat(80)}`,
    },
  }));

  const prepared = prepareRefinementContext({
    branch: messages,
    policy: POLICY,
    modelInput: ["text"],
    limits: { maxEntries: 5, maxCharsPerMessage: 40, maxTotalChars: 160 },
  });

  assert.equal(prepared.truncated, true);
  assert.ok(prepared.disclosures.some((note) => /truncated/i.test(note)));
  const conversation = prepared.blocks.find(
    (block) => block.label === "Recent conversation (current branch)",
  );
  assert.ok(conversation);
  const turns = conversation.text.match(/#### User/g) ?? [];
  assert.ok(turns.length <= 5, `expected <= 5 turns, got ${turns.length}`);
  assert.match(prepared.text, /message-29/);
  assert.doesNotMatch(prepared.text, /message-0 /);
  assert.match(prepared.text, /\[context truncated\]/);
});

test("images: bytes stay separate from attachment metadata for a validated image model", () => {
  const prepared = prepareRefinementContext({
    branch: [],
    policy: POLICY,
    modelInput: ["text", "image"],
    attachments: [
      {
        attachmentId: "img-1",
        name: "screenshot.png",
        mimeType: "image/png",
        data: PNG_BASE64,
        size: Buffer.from("hello image").byteLength,
      },
    ],
  });

  assert.equal(prepared.images.length, 1);
  assert.equal(prepared.images[0]!.attachmentId, "img-1");
  assert.equal(prepared.images[0]!.data, PNG_BASE64);
  assert.equal(prepared.images[0]!.digest, imageDigest(PNG_BASE64));

  assert.equal(prepared.attachmentRefs.length, 1);
  const ref = prepared.attachmentRefs[0]!;
  assert.equal(ref.attachmentId, "img-1");
  assert.equal(ref.byteLength, Buffer.from("hello image").byteLength);
  assert.equal("data" in ref, false, "attachment metadata must not carry bytes");

  assert.match(prepared.text, /included as image input/);
  const metadataOnly = JSON.stringify({
    blocks: prepared.blocks,
    disclosures: prepared.disclosures,
    attachmentRefs: prepared.attachmentRefs,
  });
  assert.equal(metadataOnly.includes(PNG_BASE64), false);
  assert.equal(prepared.unsupportedImages.length, 0);
});

test("images: text-only model discloses unsupported images and asks for text, never swaps models", () => {
  const prepared = prepareRefinementContext({
    branch: [],
    policy: POLICY,
    modelInput: ["text"],
    attachments: [
      {
        attachmentId: "img-2",
        name: "diagram.png",
        mimeType: "image/png",
        data: PNG_BASE64,
      },
    ],
  });

  assert.equal(prepared.images.length, 0);
  assert.equal(prepared.unsupportedImages.length, 1);
  assert.equal(
    prepared.unsupportedImages[0]!.reason,
    "model-lacks-image-input",
  );
  assert.ok(
    prepared.disclosures.some(
      (note) =>
        /ask the user to describe it in text/i.test(note) &&
        /do not change the selected model/i.test(note),
    ),
  );
  // The app-owned reference survives; the bytes do not leak into text.
  assert.equal(prepared.attachmentRefs.length, 1);
  const metadataOnly = JSON.stringify({
    blocks: prepared.blocks,
    disclosures: prepared.disclosures,
    attachmentRefs: prepared.attachmentRefs,
    unsupportedImages: prepared.unsupportedImages,
  });
  assert.equal(metadataOnly.includes(PNG_BASE64), false);
  assert.match(prepared.text, /not included; the user must supply a text description/);
});

test("images: unknown capability fails closed; invalid bytes and digests are refused", () => {
  const unknown = planRefinementImages({
    attachments: [{ attachmentId: "img-3", mimeType: "image/png", data: PNG_BASE64 }],
  });
  assert.equal(unknown.images.length, 0);
  assert.equal(unknown.unsupported[0]!.reason, "model-capability-unknown");

  const invalid = planRefinementImages({
    modelInput: ["text", "image"],
    attachments: [{ attachmentId: "img-4", mimeType: "image/png", data: "not base64!!" }],
  });
  assert.equal(invalid.unsupported[0]!.reason, "invalid-base64");

  const mismatch = planRefinementImages({
    modelInput: ["text", "image"],
    attachments: [
      {
        attachmentId: "img-5",
        mimeType: "image/png",
        data: PNG_BASE64,
        digest: "img1-deadbeef",
      },
    ],
  });
  assert.equal(mismatch.unsupported[0]!.reason, "digest-mismatch");

  const unsupportedMime = planRefinementImages({
    modelInput: ["text", "image"],
    attachments: [
      { attachmentId: "img-6", mimeType: "application/pdf", data: PNG_BASE64 },
    ],
  });
  assert.equal(unsupportedMime.unsupported[0]!.reason, "unsupported-mime");

  const missingBytes = planRefinementImages({
    modelInput: ["text", "image"],
    attachments: [
      { attachmentId: "img-7", name: "cached.png", mimeType: "image/png", size: 10 },
    ],
  });
  assert.equal(missingBytes.unsupported[0]!.reason, "missing-bytes");
  assert.equal(missingBytes.attachmentRefs[0]!.byteLength, 10);
});

test("policy provenance: a changed generation fences file-derived context", () => {
  const prepared = prepareRefinementContext({
    branch: [userEntry("u1", "Review the child-session runtime.")],
    policy: POLICY,
    modelInput: ["text"],
  });
  const generation = prepared.policyGeneration;
  assert.equal(contextPolicyChanged(prepared, generation), false);

  const narrowed: RefinementPolicySnapshot = {
    ...POLICY,
    grants: [],
    sensitivePatterns: [...(POLICY.sensitivePatterns ?? []), "**/*.key"],
  };
  const nextGeneration = policyGenerationId(narrowed);
  assert.notEqual(nextGeneration, generation);
  assert.equal(contextPolicyChanged(prepared, nextGeneration), true);

  const withEvidence = appendInspectionEvidence(prepared, {
    evidenceId: "ev-1",
    tool: "read",
    path: "src/runtime.ts",
    summary: "export function startRefinement() {}",
    policyGeneration: generation,
  });
  const evidenceBlock = withEvidence.blocks.find(
    (block) => block.provenance.kind === "inspection",
  );
  assert.ok(evidenceBlock);
  assert.equal(evidenceBlock.provenance.path, "src/runtime.ts");
  assert.deepEqual(evidenceBlock.provenance.evidenceIds, ["ev-1"]);
  assert.equal(evidenceBlock.provenance.policyGeneration, generation);
  assert.match(evidenceBlock.text, /untrusted task data/i);

  const stale = appendInspectionEvidence(
    withEvidence,
    {
      evidenceId: "ev-2",
      tool: "grep",
      path: "src/runtime.ts",
      summary: "another match",
      policyGeneration: nextGeneration,
    },
    { currentPolicyGeneration: nextGeneration },
  );
  assert.equal(
    stale.blocks.some((block) => block.provenance.kind === "inspection"),
    false,
  );
  assert.ok(stale.disclosures.some((note) => /withheld/i.test(note)));

  const dropped = withoutFileContext(withEvidence);
  assert.equal(
    dropped.blocks.some((block) => block.provenance.kind === "inspection"),
    false,
  );
  assert.equal(dropped.images.length, 0);
  assert.match(dropped.text, /Review the child-session runtime\./);
});

test("context: describe reports bounds without exposing content", () => {
  const prepared = prepareRefinementContext({
    branch: [userEntry("u1", "a prompt about architecture")],
    policy: POLICY,
    modelInput: ["text"],
  });
  const description = describePreparedContext(prepared);
  assert.match(description, /context v1/);
  assert.match(description, /policy pg1-/);
  assert.match(
    `${prepared.version}/${DEFAULT_REFINEMENT_CONTEXT_LIMITS.maxEntries}`,
    /^1\/24$/,
  );
});
