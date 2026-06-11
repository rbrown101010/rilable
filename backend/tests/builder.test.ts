import assert from "node:assert/strict";
import test from "node:test";

import { renderPocTemplate } from "../convex/builder";

test("POC template renders parseable static app files without external LLM", () => {
  const output = renderPocTemplate("Build this web app: <script>alert('x')</script> habit tracker");

  assert.match(output, /^APP_NAME:/m);
  assert.match(output, /^APP_EMOJI: ⚡$/m);
  assert.match(output, /===FILE: index\.html===/);
  assert.match(output, /===FILE: style\.css===/);
  assert.match(output, /===FILE: app\.js===/);
  assert.match(output, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt; habit tracker/);
  assert.doesNotMatch(output, /<script>alert\('x'\)<\/script>/);
});

test("ProjectOps/agile prompts render a useful software delivery board instead of a P6 shell", () => {
  const output = renderPocTemplate(
    "Build a project dashboard app for Virgil software work with agile backlog, kanban board, sprint focus, blockers, risks, dependencies, owners, and AI project manager recommendations"
  );

  assert.match(output, /^APP_NAME: ProjectOps$/m);
  assert.match(output, /^APP_EMOJI: 📊$/m);
  assert.match(output, /Agile software delivery/i);
  assert.match(output, /Backlog/i);
  assert.match(output, /Kanban/i);
  assert.match(output, /Sprint focus/i);
  assert.match(output, /AI project manager/i);
  assert.match(output, /side quest/i);
  assert.match(output, /blocked flag/i);
  assert.match(output, /dependencies/i);
  assert.match(output, /localStorage\.setItem\('forge-projectops-items'/);
  assert.match(output, /function renderBoard/);
  assert.match(output, /function recommendNextTask/);
  assert.match(output, /function detectSideQuests/);
  assert.match(output, /<form id="work-item-form"/);
  assert.match(output, /function editWorkItem/);
  assert.match(output, /function deleteWorkItem/);
  assert.match(output, /function moveWorkItem/);
  assert.match(output, /id="status-filter"/);
  assert.match(output, /Recommendation rationale:/);
  assert.match(output, /Side-quest warning:/);
  assert.match(output, /Native Android rewrite/);
  assert.doesNotMatch(output, /Connect Cogitator memory graph/);
  assert.match(output, /data-view="board"/);
  assert.doesNotMatch(output, /P6-style schedule/i);
});
