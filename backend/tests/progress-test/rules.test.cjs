const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../../src/modules/progress-test/progress-test.service");
const v = require("../../src/modules/progress-test/progress-test.validation");
test("server schedule uses an inclusive start and exclusive end", () => {
  const exam = {
    startsAt: "2026-10-07T01:00:00Z",
    endsAt: "2026-10-07T02:00:00Z",
  };
  assert.equal(s.examState(exam, new Date("2026-10-07T00:59:59Z")), "LOCKED");
  assert.equal(s.examState(exam, new Date(exam.startsAt)), "OPEN");
  assert.equal(s.examState(exam, new Date(exam.endsAt)), "CLOSED");
});
test("student questions never contain correct answers or explanations", () => {
  const q = {
    id: "q",
    type: "choice",
    text: "$x^2$",
    options: ["1", "2"],
    points: 2,
    correctOption: 0,
    explanation: "answer secret",
  };
  const [safe] = s.publicQuestions([q]);
  assert.equal(safe.correctOption, undefined);
  assert.equal(safe.explanation, undefined);
  assert.equal(safe.text, "$x^2$");
});
test("choice scoring is server based and essays need manual review", () => {
  const questions = [
    {
      id: "choice",
      type: "choice",
      correctOption: 0,
      options: ["A", "B"],
      points: 2,
    },
    { id: "essay", type: "essay", points: 3 },
  ];
  assert.deepEqual(s.scoreAnswers(questions, { choice: 0, essay: "worked" }), {
    score: 2,
    maxScore: 5,
    status: "PENDING_REVIEW",
  });
  assert.deepEqual(s.scoreAnswers(questions, { choice: 0 }, { essay: 1.5 }), {
    score: 3.5,
    maxScore: 5,
    status: "GRADED",
  });
  assert.equal(s.scoreAnswers([questions[0]], { choice: "0" }).score, 0);
});
test("forged question ids and answers with wrong types are rejected", () => {
  const questions = [
    { id: "a", type: "choice", options: ["x", "y"] },
    { id: "b", type: "essay" },
  ];
  assert.throws(() => s.validateAnswers(questions, { other: 0 }));
  assert.throws(() => s.validateAnswers(questions, { a: 99 }));
  assert.throws(() => s.validateAnswers(questions, { b: 1 }));
  assert.doesNotThrow(() => s.validateAnswers(questions, { a: 0, b: "x²" }));
});
test("question validation enforces choice answers and no choices for essay", () => {
  const q = {
    subjectId: "a".repeat(24),
    categoryId: "b".repeat(24),
    type: "choice",
    text: "Q",
    options: ["1", "2"],
    correctOption: 0,
    points: 1,
  };
  assert.equal(v.question.safeParse(q).success, true);
  assert.equal(v.question.safeParse({ ...q, correctOption: 3 }).success, false);
  assert.equal(v.question.safeParse({ ...q, type: "essay" }).success, false);
  assert.equal(
    v.question.safeParse({
      ...q,
      type: "essay",
      options: [],
      correctOption: null,
    }).success,
    true,
  );
});
test("clients cannot supply a score, forged event timestamp or answer-key overwrite", () => {
  assert.equal(
    v.save.safeParse({ revision: 0, answers: {}, score: 100 }).success,
    false,
  );
  assert.equal(
    v.event.safeParse({
      id: require("node:crypto").randomUUID(),
      type: "PAGE_EXIT",
      receivedAt: "yesterday",
    }).success,
    false,
  );
});
test("Progress Test action permissions are separate from the read permission", () => {
  const {
    requirePermission,
  } = require("../../src/middlewares/rbac.middleware");
  const { PERMISSIONS: P } = require("../../src/shared/permissions");
  for (const action of [
    P.PROGRESS_CATALOG,
    P.PROGRESS_QUESTION,
    P.PROGRESS_SCHEDULE,
    P.PROGRESS_RESULT,
    P.PROGRESS_GRADE,
  ]) {
    let error;
    requirePermission(P.PROGRESS_VIEW, action)(
      { user: { role: { permissions: [P.PROGRESS_VIEW] } } },
      {},
      (e) => {
        error = e;
      },
    );
    assert.equal(error.statusCode, 403);
    error = null;
    requirePermission(P.PROGRESS_VIEW, action)(
      { user: { role: { permissions: [P.PROGRESS_VIEW, action] } } },
      {},
      (e) => {
        error = e;
      },
    );
    assert.equal(error, undefined);
  }
});
