"use strict";
const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const authenticate = require("../../middlewares/auth.middleware");
const { requirePermission } = require("../../middlewares/rbac.middleware");
const { PERMISSIONS: P } = require("../../shared/permissions");
const c = require("./progress-test.controller");
const router = Router();
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: {
    success: false,
    message: "Đã thử mật khẩu quá nhiều lần. Vui lòng thử lại sau.",
  },
});
const publicReadLimiter = rateLimit({
  windowMs: 60000,
  max: 3000,
  message: {
    success: false,
    message: "Máy chủ đang nhận nhiều yêu cầu. Hãy thử lại sau một phút.",
  },
});
router.get("/public/exams", publicReadLimiter, c.publicExams);
router.get("/public/exams/:slug", publicReadLimiter, c.publicExam);
router.post("/public/exams/:slug/verify", passwordLimiter, c.verify);
router.post("/public/exams/:slug/join", passwordLimiter, c.join);
router.use(
  "/public/attempt",
  rateLimit({
    windowMs: 60000,
    max: 180,
    keyGenerator: (req) =>
      require("node:crypto")
        .createHash("sha256")
        .update(String(req.headers["x-attempt-token"] ?? "missing"))
        .digest("hex"),
    message: {
      success: false,
      message:
        "Phiên làm bài đang gửi quá nhiều yêu cầu. Vui lòng chờ một phút.",
    },
  }),
);
router.get("/public/attempt", c.readAttempt);
router.put("/public/attempt/answers", c.saveAnswers);
router.post("/public/attempt/events", c.event);
router.post("/public/attempt/submit", c.submit);
router.use(authenticate, requirePermission(P.PROGRESS_VIEW));
router.get("/catalog", c.catalog);
router.post("/subjects", requirePermission(P.PROGRESS_CATALOG), c.saveSubject);
router.patch(
  "/subjects/:id",
  requirePermission(P.PROGRESS_CATALOG),
  c.saveSubject,
);
router.delete(
  "/subjects/:id",
  requirePermission(P.PROGRESS_CATALOG),
  c.deleteSubject,
);
router.post(
  "/categories",
  requirePermission(P.PROGRESS_CATALOG),
  c.saveCategory,
);
router.patch(
  "/categories/:id",
  requirePermission(P.PROGRESS_CATALOG),
  c.saveCategory,
);
router.delete(
  "/categories/:id",
  requirePermission(P.PROGRESS_CATALOG),
  c.deleteCategory,
);
router.get("/questions", requirePermission(P.PROGRESS_QUESTION), c.questions);
router.post(
  "/questions",
  requirePermission(P.PROGRESS_QUESTION),
  c.saveQuestion,
);
router.patch(
  "/questions/:id",
  requirePermission(P.PROGRESS_QUESTION),
  c.saveQuestion,
);
router.delete(
  "/questions/:id",
  requirePermission(P.PROGRESS_QUESTION),
  c.deleteQuestion,
);
router.get("/exams", c.exams);
router.post("/exams", requirePermission(P.PROGRESS_SCHEDULE), c.createExam);
router.get(
  "/exams/:id/results",
  requirePermission(P.PROGRESS_RESULT),
  c.results,
);
router.get(
  "/exams/:id/results/:attemptId",
  requirePermission(P.PROGRESS_RESULT),
  c.results,
);
router.patch(
  "/attempts/:id/grade",
  requirePermission(P.PROGRESS_GRADE),
  c.grade,
);
module.exports = router;
