"use strict";
const { randomBytes, createHash, randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const ApiError = require("../../shared/ApiError");
const { connectProgressTestDB } = require("../../config/db");
const getModels = require("./progress-test.model");
const validation = require("./progress-test.validation");
let initialization;
let expiryTimer;
async function models() {
  if (!initialization)
    initialization = connectProgressTestDB()
      .then(async (connection) => {
        const m = getModels(connection);
        await Promise.all(Object.values(m).map((model) => model.init()));
        return m;
      })
      .catch((error) => {
        initialization = null;
        throw error;
      });
  return initialization;
}
const parse = (schema, body) => {
  const result = schema.safeParse(body);
  if (!result.success)
    throw ApiError.badRequest(
      result.error.issues.map((i) => i.message).join(" "),
    );
  return result.data;
};
const checkId = (id) => parse(validation.id, id);
const hash = (token) => createHash("sha256").update(token).digest("hex");
function examState(exam, now = new Date()) {
  return now < new Date(exam.startsAt)
    ? "LOCKED"
    : now >= new Date(exam.endsAt)
      ? "CLOSED"
      : "OPEN";
}
function publicQuestions(questions) {
  return questions.map(({ id, type, text, options, points }) => ({
    id,
    type,
    text,
    options,
    points,
  }));
}
function scoreAnswers(questions, answers, grades = {}) {
  let score = 0;
  let pending = false;
  for (const q of questions) {
    if (q.type === "choice") {
      if (answers[q.id] === q.correctOption) score += q.points;
    } else if (Object.hasOwn(grades, q.id)) score += grades[q.id];
    else pending = true;
  }
  return {
    score,
    maxScore: questions.reduce((n, q) => n + q.points, 0),
    status: pending ? "PENDING_REVIEW" : "GRADED",
  };
}
function validateAnswers(questions, answers) {
  const index = new Map(questions.map((q) => [q.id, q]));
  for (const [id, answer] of Object.entries(answers)) {
    const q = index.get(id);
    if (
      !q ||
      (answer !== null &&
        (q.type === "choice"
          ? !Number.isInteger(answer) ||
            answer < 0 ||
            answer >= q.options.length
          : typeof answer !== "string"))
    )
      throw ApiError.badRequest(
        "Câu trả lời không hợp lệ hoặc không thuộc bài kiểm tra.",
      );
  }
}
async function listCatalog() {
  const { Subject, Category, Question } = await models();
  const [subjects, categories, questionCount] = await Promise.all([
    Subject.find().sort({ name: 1 }).lean(),
    Category.find().sort({ name: 1 }).lean(),
    Question.countDocuments(),
  ]);
  return { subjects, categories, questionCount };
}
async function saveCatalog(type, id, body) {
  const m = await models();
  const schema = type === "subjects" ? validation.subject : validation.category;
  const data = parse(schema, body);
  const Model = type === "subjects" ? m.Subject : m.Category;
  if (data.subjectId && !(await m.Subject.exists({ _id: data.subjectId })))
    throw ApiError.notFound("Môn học không tồn tại.");
  if (!id) return Model.create(data);
  if (type === "categories") {
    const previous = await Model.findById(checkId(id)).lean();
    if (previous && String(previous.subjectId) !== data.subjectId)
      throw ApiError.badRequest(
        "Không chuyển danh mục sang môn khác. Hãy tạo danh mục mới.",
      );
  }
  const record = await Model.findByIdAndUpdate(checkId(id), data, {
    new: true,
    runValidators: true,
  });
  if (!record) throw ApiError.notFound("Danh mục không tồn tại.");
  return record;
}
async function deleteCatalog(type, id) {
  const m = await models();
  checkId(id);
  if (type === "subjects") {
    if (
      (await m.Category.exists({ subjectId: id })) ||
      (await m.Question.exists({ subjectId: id }))
    )
      throw ApiError.conflict(
        "Môn học đang có danh mục/câu hỏi, cần xóa dữ liệu liên quan trước.",
      );
  } else if (await m.Question.exists({ categoryId: id }))
    throw ApiError.conflict("Danh mục đang chứa câu hỏi.");
  const result = await (type === "subjects" ? m.Subject : m.Category).deleteOne(
    { _id: id },
  );
  if (!result.deletedCount) throw ApiError.notFound("Danh mục không tồn tại.");
  return { deleted: true };
}
async function listQuestions(query) {
  const { Question } = await models();
  const filter = {};
  if (query.subjectId) filter.subjectId = checkId(query.subjectId);
  if (query.categoryId) filter.categoryId = checkId(query.categoryId);
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1));
  const limit = 20;
  const [items, total] = await Promise.all([
    Question.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Question.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}
async function saveQuestion(id, body) {
  const m = await models();
  const data = parse(validation.question, body);
  if (
    !(await m.Category.exists({
      _id: data.categoryId,
      subjectId: data.subjectId,
    }))
  )
    throw ApiError.badRequest("Danh mục không thuộc môn đã chọn.");
  if (!id) return m.Question.create(data);
  const record = await m.Question.findByIdAndUpdate(checkId(id), data, {
    new: true,
    runValidators: true,
  });
  if (!record) throw ApiError.notFound("Câu hỏi không tồn tại.");
  return record;
}
async function deleteQuestion(id) {
  const { Question } = await models();
  const result = await Question.deleteOne({ _id: checkId(id) });
  if (!result.deletedCount) throw ApiError.notFound("Câu hỏi không tồn tại.");
  return { deleted: true };
}
async function createExam(body, actor) {
  const m = await models();
  const data = parse(validation.exam, body);
  if (new Date(data.endsAt) <= new Date())
    throw ApiError.badRequest("Không thể tạo lịch đã kết thúc.");
  const subject = await m.Subject.findById(data.subjectId).lean();
  const ids = [...new Set(data.categoryIds)];
  const categories = await m.Category.find({
    _id: { $in: ids },
    subjectId: data.subjectId,
  }).lean();
  if (!subject || categories.length !== ids.length)
    throw ApiError.badRequest("Môn hoặc danh mục được chọn không hợp lệ.");
  const pool = await m.Question.find({
    subjectId: data.subjectId,
    categoryId: { $in: ids },
  })
    .sort({ _id: 1 })
    .limit(1001)
    .lean();
  const count = data.questionCount ?? pool.length;
  if (!pool.length || count > pool.length || count > 100)
    throw ApiError.badRequest(
      "Chọn từ 1 đến 100 câu, không vượt quá số câu trong ngân hàng.",
    );
  // Freeze the question set, answer key and explanation when scheduling.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = require("node:crypto").randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const questions = pool
    .slice(0, count)
    .map((q) => ({
      id: String(q._id),
      type: q.type,
      text: q.text,
      options: q.options,
      correctOption: q.correctOption,
      explanation: q.explanation,
      points: q.points,
    }));
  if (Buffer.byteLength(JSON.stringify(questions), 'utf8') > 2 * 1024 * 1024) {
    throw ApiError.badRequest('Nội dung đề quá lớn. Hãy giảm số câu hoặc rút gọn câu hỏi/giải thích.');
  }
  const { password, questionCount, ...fields } = data;
  const record = await m.Exam.create({
    ...fields,
    slug: randomUUID(),
    subjectName: subject.name,
    categoryNames: categories.map((c) => c.name),
    questions,
    passwordHash: await bcrypt.hash(password, 10),
    createdBy: actor,
  });
  return { id: record.id, slug: record.slug };
}
async function listExams(isPublic = false) {
  const { Exam } = await models();
  const now = new Date();
  const rows = await Exam.find(
    isPublic ? { startsAt: { $lte: now }, endsAt: { $gt: now } } : {},
  )
    .sort({ startsAt: -1 })
    .limit(300)
    .lean();
  return rows.map((exam) => ({
    ...(isPublic
      ? {
          slug: exam.slug,
          title: exam.title,
          subjectName: exam.subjectName,
          startsAt: exam.startsAt,
          endsAt: exam.endsAt,
          durationMinutes: exam.durationMinutes,
        }
      : exam),
    state: examState(exam),
    serverTime: now.toISOString(),
  }));
}
async function publicExam(slug) {
  const { Exam } = await models();
  const exam = await Exam.findOne({ slug }).lean();
  if (!exam) throw ApiError.notFound("Bài kiểm tra không tồn tại.");
  return {
    title: exam.title,
    subjectName: exam.subjectName,
    categoryNames: exam.categoryNames,
    startsAt: exam.startsAt,
    endsAt: exam.endsAt,
    durationMinutes: exam.durationMinutes,
    state: examState(exam),
    serverTime: new Date().toISOString(),
  };
}
async function joinExam(slug, body) {
  const data = parse(validation.join, body);
  const { Exam, Attempt } = await models();
  const exam = await Exam.findOne({ slug })
    .select("+passwordHash +questions")
    .lean();
  if (!exam) throw ApiError.notFound("Bài kiểm tra không tồn tại.");
  if (examState(exam) !== "OPEN")
    throw ApiError.forbidden(
      "Đường dẫn đang khóa: bài kiểm tra chưa mở hoặc đã kết thúc.",
    );
  if (!(await bcrypt.compare(data.password, exam.passwordHash)))
    throw ApiError.forbidden("Mật khẩu kiểm tra không đúng.");
  const now = new Date();
  if (examState(exam, now) !== "OPEN")
    throw ApiError.forbidden("Bài kiểm tra đã kết thúc.");
  const token = randomBytes(32).toString("hex");
  const attempt = await Attempt.create({
    examId: exam._id,
    name: data.name,
    tokenHash: hash(token),
    questions: exam.questions,
    startedAt: now,
    lastSeenAt: now,
    deadline: new Date(
      Math.min(
        new Date(exam.endsAt).getTime(),
        now.getTime() + exam.durationMinutes * 60000,
      ),
    ),
    maxScore: exam.questions.reduce((n, q) => n + q.points, 0),
  });
  return { token, attemptId: attempt.id };
}
async function verifyPassword(slug, body) {
  const password = parse(validation.verify, body).password;
  const { Exam } = await models();
  const exam = await Exam.findOne({ slug }).select("+passwordHash").lean();
  if (!exam || examState(exam) !== "OPEN")
    throw ApiError.forbidden("Đường dẫn kiểm tra đang khóa.");
  if (!(await bcrypt.compare(password, exam.passwordHash)))
    throw ApiError.forbidden("Mật khẩu kiểm tra không đúng.");
  return { verified: true };
}
async function findAttempt(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw ApiError.unauthorized("Phiên làm bài không hợp lệ.");
  const { Attempt } = await models();
  const attempt = await Attempt.findOne({ tokenHash: hash(token) })
    .select("+questions +pendingAnswerLog")
    .lean();
  if (!attempt) throw ApiError.unauthorized("Phiên làm bài không tồn tại.");
  await flushAnswerLog(attempt);
  return attempt;
}
async function flushAnswerLog(attempt) {
  if (!attempt.pendingAnswerLog) return;
  const { Attempt, AnswerLog } = await models();
  const log = attempt.pendingAnswerLog;
  await AnswerLog.updateOne(
    { attemptId: attempt._id, revision: log.revision },
    { $setOnInsert: { ...log, attemptId: attempt._id } },
    { upsert: true },
  );
  await Attempt.updateOne(
    { _id: attempt._id, "pendingAnswerLog.revision": log.revision },
    { $unset: { pendingAnswerLog: 1 } },
  );
}
async function finalize(attempt) {
  const { Attempt } = await models();
  const scoring = scoreAnswers(
    attempt.questions,
    attempt.answers ?? {},
    attempt.grades,
  );
  const result = await Attempt.findOneAndUpdate(
    { _id: attempt._id, revision: attempt.revision, status: "IN_PROGRESS" },
    { $set: { ...scoring, submittedAt: new Date() }, $inc: { revision: 1 } },
    { new: true },
  )
    .select("+questions")
    .lean();
  return result;
}
async function readAttempt(token) {
  let attempt = await findAttempt(token);
  if (
    attempt.status === "IN_PROGRESS" &&
    new Date() >= new Date(attempt.deadline)
  ) {
    attempt = (await finalize(attempt)) ?? (await findAttempt(token));
  }
  if (attempt.status === "IN_PROGRESS") {
    const { Attempt } = await models();
    await Attempt.updateOne(
      { _id: attempt._id, status: "IN_PROGRESS" },
      { $set: { lastSeenAt: new Date() } },
    );
  }
  return {
    id: attempt._id,
    name: attempt.name,
    status: attempt.status,
    questions: publicQuestions(attempt.questions),
    answers: attempt.answers,
    deadline: attempt.deadline,
    revision: attempt.revision,
    score: attempt.score,
    maxScore: attempt.maxScore,
    serverTime: new Date().toISOString(),
  };
}
function startExpirySweep() {
  if (expiryTimer) return;
  let busy = false;
  expiryTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { Attempt } = await models();
      const expired = await Attempt.find({
        status: "IN_PROGRESS",
        deadline: { $lte: new Date() },
      })
        .select("+questions +pendingAnswerLog")
        .limit(100)
        .lean();
      for (const attempt of expired) {
        await flushAnswerLog(attempt);
        await finalize(attempt);
      }
    } catch {
      console.warn(
        "[progress-test] expired attempts will be finalized on the next scan.",
      );
    } finally {
      busy = false;
    }
  }, 15000);
  expiryTimer.unref();
}
async function saveAnswers(token, body) {
  const data = parse(validation.save, body);
  const attempt = await findAttempt(token);
  if (
    attempt.status !== "IN_PROGRESS" ||
    new Date() >= new Date(attempt.deadline)
  ) {
    await finalize(attempt);
    throw ApiError.conflict("Bài làm đã kết thúc.");
  }
  validateAnswers(attempt.questions, data.answers);
  const now = new Date();
  const { Attempt } = await models();
  const result = await Attempt.findOneAndUpdate(
    {
      _id: attempt._id,
      revision: data.revision,
      status: "IN_PROGRESS",
      deadline: { $gt: now },
    },
    {
      $set: {
        answers: data.answers,
        lastSeenAt: now,
        pendingAnswerLog: {
          revision: data.revision + 1,
          receivedAt: now,
          answers: data.answers,
        },
      },
      $inc: { revision: 1 },
    },
    { new: true },
  )
    .select("+pendingAnswerLog")
    .lean();
  if (!result)
    throw ApiError.conflict(
      "Bài làm đã được cập nhật hoặc đã hết giờ. Hãy tải lại phiên làm bài.",
    );
  await flushAnswerLog(result);
  return { revision: result.revision, savedAt: now };
}
async function logEvent(token, body) {
  const data = parse(validation.event, body);
  const attempt = await findAttempt(token);
  const { Activity } = await models();
  if (
    attempt.status === "IN_PROGRESS" &&
    new Date() < new Date(attempt.deadline)
  )
    await Activity.updateOne(
      { attemptId: attempt._id, id: data.id },
      {
        $setOnInsert: {
          ...data,
          attemptId: attempt._id,
          receivedAt: new Date(),
        },
      },
      { upsert: true },
    );
  return { recorded: true };
}
async function submit(token) {
  for (let i = 0; i < 5; i++) {
    const attempt = await findAttempt(token);
    if (attempt.status !== "IN_PROGRESS") return readAttempt(token);
    if (await finalize(attempt)) return readAttempt(token);
  }
  throw ApiError.conflict("Bài làm đang được cập nhật. Vui lòng thử lại.");
}
async function results(examId, attemptId) {
  const { Attempt, Activity, AnswerLog } = await models();
  checkId(examId);
  const filter = { examId, ...(attemptId ? { _id: checkId(attemptId) } : {}) };
  const attempts = await Attempt.find(filter)
    .select(attemptId ? "+questions +pendingAnswerLog" : "+pendingAnswerLog")
    .sort({ startedAt: -1 })
    .limit(1000)
    .lean();
  const final = [];
  for (const attempt of attempts) {
    await flushAnswerLog(attempt);
    delete attempt.pendingAnswerLog;
    if (
      attempt.status === "IN_PROGRESS" &&
      new Date() >= new Date(attempt.deadline)
    ) {
      const full = await Attempt.findById(attempt._id)
        .select("+questions")
        .lean();
      await finalize(full);
      const updated = await Attempt.findById(attempt._id)
        .select(attemptId ? "+questions" : "")
        .lean();
      final.push(updated);
    } else final.push(attempt);
  }
  const counts = new Map(
    (
      await Activity.aggregate([
        {
          $match: {
            attemptId: { $in: final.map((a) => a._id) },
            type: { $ne: "RETURN" },
          },
        },
        { $group: { _id: "$attemptId", count: { $sum: 1 } } },
      ])
    ).map((row) => [String(row._id), row.count]),
  );
  for (const attempt of final) {
    if (attemptId) {
      [attempt.events, attempt.answerHistory] = await Promise.all([
        Activity.find({ attemptId: attempt._id })
          .sort({ receivedAt: 1 })
          .lean(),
        AnswerLog.find({ attemptId: attempt._id }).sort({ revision: 1 }).lean(),
      ]);
    } else attempt.eventCount = counts.get(String(attempt._id)) ?? 0;
  }
  return final;
}
async function gradeAttempt(id, body, actor) {
  const data = parse(validation.grade, body);
  const { Attempt } = await models();
  const attempt = await Attempt.findById(checkId(id))
    .select("+questions")
    .lean();
  if (!attempt || attempt.status === "IN_PROGRESS")
    throw ApiError.conflict("Chỉ chấm bài đã nộp hoặc hết giờ.");
  for (const [qid, score] of Object.entries(data.grades)) {
    const q = attempt.questions.find((q) => q.id === qid);
    if (!q || q.type !== "essay" || score > q.points)
      throw ApiError.badRequest(
        "Điểm tự luận phải thuộc câu hỏi và không vượt điểm tối đa.",
      );
  }
  const grades = { ...attempt.grades, ...data.grades };
  const updated = await Attempt.findOneAndUpdate(
    { _id: id, revision: attempt.revision, status: { $ne: "IN_PROGRESS" } },
    {
      $set: {
        ...scoreAnswers(attempt.questions, attempt.answers, grades),
        grades,
        gradedBy: actor,
      },
      $inc: { revision: 1 },
    },
    { new: true },
  ).lean();
  if (!updated)
    throw ApiError.conflict("Bài đã được chấm bởi người khác. Hãy tải lại.");
  return updated;
}
module.exports = {
  models,
  startExpirySweep,
  listCatalog,
  saveCatalog,
  deleteCatalog,
  listQuestions,
  saveQuestion,
  deleteQuestion,
  createExam,
  listExams,
  publicExam,
  joinExam,
  verifyPassword,
  readAttempt,
  saveAnswers,
  logEvent,
  submit,
  results,
  gradeAttempt,
  examState,
  publicQuestions,
  scoreAnswers,
  validateAnswers,
};
