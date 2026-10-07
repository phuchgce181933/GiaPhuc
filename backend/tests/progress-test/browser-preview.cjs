// Temporary, isolated UI QA fixture. Never writes to the product database.
const express = require("express");
const { randomUUID } = require("node:crypto");
const config = require("../../src/config");
config.PROGRESS_TEST.MONGODB_DB = `progress_ui_qa_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const service = require("../../src/modules/progress-test/progress-test.service");
(async () => {
  const models = await service.models();
  const subject = await service.saveCatalog("subjects", null, {
    name: "Toán · Kiểm thử giao diện",
  });
  const category = await service.saveCatalog("categories", null, {
    name: "Đại số",
    subjectId: subject.id,
  });
  await service.saveQuestion(null, {
    subjectId: subject.id,
    categoryId: category.id,
    type: "choice",
    text: "Tính giá trị $\\frac{1}{2} + \\frac{1}{2}$ bằng bao nhiêu?",
    options: ["$1$", "$2$", "$\\frac{1}{2}$", "$0$"],
    correctOption: 0,
    explanation: "Hai nửa cộng lại bằng một.",
    points: 2,
  });
  await service.saveQuestion(null, {
    subjectId: subject.id,
    categoryId: category.id,
    type: "essay",
    text: "Giải phương trình $x^{2} - 4 = 0$. Trình bày cách làm.",
    options: [],
    correctOption: null,
    explanation: "x bằng 2 hoặc -2.",
    points: 3,
  });
  const exam = await service.createExam(
    {
      title: "Bài kiểm thử Toán · Unit 1",
      subjectId: subject.id,
      categoryIds: [category.id],
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
      durationMinutes: 30,
      password: "QA-demo-2026",
      questionCount: 2,
    },
    "UI-QA",
  );
  const app = express();
  app.use(require("cors")());
  app.use(express.json());
  app.use(
    "/api/progress-test",
    require("../../src/modules/progress-test/progress-test.route"),
  );
  app.use(require("../../src/middlewares/error.middleware"));
  const server = app.listen(5002, "127.0.0.1", () =>
    console.log(`QA_URL=/tests/${exam.slug}`),
  );
  app.post("/__qa/cleanup", async (_req, res) => {
    if (!models.Subject.db.name.startsWith("progress_ui_qa_"))
      throw new Error("Refusing to remove non-QA data");
    await models.Subject.db.dropDatabase();
    res.json({ cleaned: true });
    server.close(async () => {
      await require("../../src/config/db").disconnectDB();
    });
  });
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
