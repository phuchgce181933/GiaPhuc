"use strict";
const service = require("./progress-test.service");
const catchAsync = require("../../shared/catchAsync");
const send = (handler) =>
  catchAsync(async (req, res) =>
    res.json({ success: true, data: await handler(req) }),
  );
const token = (req) => req.headers["x-attempt-token"];
module.exports = {
  catalog: send(() => service.listCatalog()),
  saveSubject: send((req) =>
    service.saveCatalog("subjects", req.params.id, req.body),
  ),
  saveCategory: send((req) =>
    service.saveCatalog("categories", req.params.id, req.body),
  ),
  deleteSubject: send((req) =>
    service.deleteCatalog("subjects", req.params.id),
  ),
  deleteCategory: send((req) =>
    service.deleteCatalog("categories", req.params.id),
  ),
  questions: send((req) => service.listQuestions(req.query)),
  saveQuestion: send((req) => service.saveQuestion(req.params.id, req.body)),
  deleteQuestion: send((req) => service.deleteQuestion(req.params.id)),
  exams: send(() => service.listExams()),
  createExam: send((req) => service.createExam(req.body, req.user.id)),
  results: send((req) => service.results(req.params.id, req.params.attemptId)),
  grade: send((req) =>
    service.gradeAttempt(req.params.id, req.body, req.user.id),
  ),
  publicExams: send(() => service.listExams(true)),
  publicExam: send((req) => service.publicExam(req.params.slug)),
  join: send((req) => service.joinExam(req.params.slug, req.body)),
  verify: send((req) => service.verifyPassword(req.params.slug, req.body)),
  readAttempt: send((req) => service.readAttempt(token(req))),
  saveAnswers: send((req) => service.saveAnswers(token(req), req.body)),
  event: send((req) => service.logEvent(token(req), req.body)),
  submit: send((req) => service.submit(token(req))),
};
