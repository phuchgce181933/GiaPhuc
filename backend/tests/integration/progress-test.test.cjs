const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const config = require("../../src/config");
config.PROGRESS_TEST.MONGODB_DB = `progress_test_qa_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const service = require("../../src/modules/progress-test/progress-test.service");
const { disconnectDB } = require("../../src/config/db");

test("Progress Test isolated MongoDB: snapshots, authentication, autosave CAS, grading, events, deadline and no answer leaks", async () => {
  let db;
  try {
    const m = await service.models();
    db = m.Subject.db;
    assert.equal(db.name, config.PROGRESS_TEST.MONGODB_DB);
    assert.notEqual(db.name, config.MONGODB_DB);
    assert.notEqual(db.name, config.TIMETABLE.MONGODB_DB);
    const subject = await service.saveCatalog("subjects", null, {
      name: "Toán QA",
    });
    const category = await service.saveCatalog("categories", null, {
      subjectId: subject.id,
      name: "Đại số",
    });
    const choice = await service.saveQuestion(null, {
      subjectId: subject.id,
      categoryId: category.id,
      text: "Tính $\\frac{2}{1}$",
      type: "choice",
      options: ["2", "3"],
      correctOption: 0,
      points: 2,
      explanation: "2/1=2",
    });
    const essay = await service.saveQuestion(null, {
      subjectId: subject.id,
      categoryId: category.id,
      text: "Giải thích x²",
      type: "essay",
      options: [],
      correctOption: null,
      points: 3,
    });
    await assert.rejects(service.deleteCatalog("subjects", subject.id));
    await assert.rejects(service.deleteCatalog("categories", category.id));
    const now = Date.now();
    const fields = {
      title: "Bài QA",
      subjectId: subject.id,
      categoryIds: [category.id],
      startsAt: new Date(now - 60000).toISOString(),
      endsAt: new Date(now + 600000).toISOString(),
      durationMinutes: 5,
      password: "qa-pass",
      questionCount: 2,
    };
    const exam = await service.createExam(fields, "QA-ACTOR");
    await assert.rejects(
      service.joinExam(exam.slug, { name: "Student", password: "wrong" }),
    );
    await assert.rejects(
      service.joinExam(exam.slug, { name: "", password: "qa-pass" }),
    );
    await service.verifyPassword(exam.slug, { password: "qa-pass" });
    const entered = await service.joinExam(exam.slug, {
      name: "Nguyễn Văn QA",
      password: "qa-pass",
    });
    const read = await service.readAttempt(entered.token);
    assert.equal(read.questions.length, 2);
    assert.ok(
      read.questions.every(
        (q) => q.correctOption === undefined && q.explanation === undefined,
      ),
    );
    const admin = await service.listExams();
    assert.equal(admin[0].passwordHash, undefined);
    assert.equal(admin[0].questions, undefined);
    const snapshots = await m.Attempt.findById(entered.attemptId)
      .select("+questions")
      .lean();
    await service.deleteQuestion(choice.id);
    assert.equal(
      snapshots.questions.find((q) => q.id === choice.id).correctOption,
      0,
    );
    const saved = await service.saveAnswers(entered.token, {
      revision: read.revision,
      answers: { [choice.id]: 0, [essay.id]: "Bài giải" },
    });
    await assert.rejects(
      service.saveAnswers(entered.token, {
        revision: read.revision,
        answers: {},
      }),
      /cập nhật/,
    );
    const event = { id: randomUUID(), type: "TAB_HIDDEN", detail: "" };
    await service.logEvent(entered.token, event);
    await service.logEvent(entered.token, event);
    const result = await service.submit(entered.token);
    assert.equal(result.status, "PENDING_REVIEW");
    assert.equal(result.score, 2);
    await assert.rejects(
      service.saveAnswers(entered.token, {
        revision: saved.revision,
        answers: {},
      }),
    );
    await assert.rejects(
      service.gradeAttempt(
        entered.attemptId,
        { grades: { [essay.id]: 4 } },
        "QA-GRADER",
      ),
    );
    const graded = await service.gradeAttempt(
      entered.attemptId,
      { grades: { [essay.id]: 2.5 } },
      "QA-GRADER",
    );
    assert.equal(graded.score, 4.5);
    assert.equal(graded.status, "GRADED");
    const [detail] = await service.results(exam.id, entered.attemptId);
    assert.equal(detail.events.length, 1);
    assert.equal(detail.answerHistory.length, 1);
    assert.equal(detail.answers[choice.id], 0);
    assert.equal(detail.tokenHash, undefined);
    const late = await service.joinExam(exam.slug, {
      name: "Late QA",
      password: "qa-pass",
    });
    const receivedAt = new Date();
    await m.Attempt.updateOne(
      { _id: late.attemptId },
      {
        $set: {
          answers: { [choice.id]: 0 },
          revision: 1,
          pendingAnswerLog: {
            revision: 1,
            receivedAt,
            answers: { [choice.id]: 0 },
          },
        },
      },
    );
    await service.readAttempt(late.token);
    assert.equal(
      await m.AnswerLog.countDocuments({ attemptId: late.attemptId }),
      1,
    );
    assert.equal(
      (
        await m.Attempt.findById(late.attemptId)
          .select("+pendingAnswerLog")
          .lean()
      ).pendingAnswerLog,
      undefined,
    );
    await m.Attempt.updateOne(
      { _id: late.attemptId },
      { $set: { deadline: new Date(Date.now() - 1000) } },
    );
    await assert.rejects(
      service.saveAnswers(late.token, {
        revision: 0,
        answers: { [choice.id]: 0 },
      }),
    );
    assert.notEqual(
      (await service.readAttempt(late.token)).status,
      "IN_PROGRESS",
    );
    await m.Exam.updateOne(
      { _id: exam.id },
      { $set: { endsAt: new Date(Date.now() - 1000) } },
    );
    await assert.rejects(
      service.joinExam(exam.slug, { name: "Student", password: "qa-pass" }),
    );
    assert.equal((await service.listExams(true)).length, 0);
    // Real HTTP routes reject admin calls without JWT and sanitize student output.
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use(
      "/progress-test",
      require("../../src/modules/progress-test/progress-test.route"),
    );
    app.use(require("../../src/middlewares/error.middleware"));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}/progress-test`;
      assert.equal((await fetch(`${base}/questions`)).status, 401);
      const response = await fetch(`${base}/public/attempt`, {
        headers: { "X-Attempt-Token": entered.token },
      });
      const json = await response.json();
      assert.equal(response.status, 200);
      assert.ok(
        json.data.questions.every((q) => q.correctOption === undefined),
      );
      assert.equal(
        (
          await fetch(`${base}/public/attempt`, {
            headers: { "X-Attempt-Token": "f".repeat(64) },
          })
        ).status,
        401,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (db) {
      assert.ok(db.name.startsWith("progress_test_qa_"));
      await db.dropDatabase();
    }
    await disconnectDB();
  }
});
