"use strict";
const { Schema } = require("mongoose");
function getModels(connection) {
  const model = (name, schema, collection) =>
    connection.models[name] ?? connection.model(name, schema, collection);
  const subject = new Schema(
    {
      name: { type: String, required: true },
      active: { type: Boolean, default: true },
    },
    { timestamps: true },
  );
  subject.index({ name: 1 }, { unique: true });
  const category = new Schema(
    {
      subjectId: { type: Schema.Types.ObjectId, required: true },
      name: { type: String, required: true },
    },
    { timestamps: true },
  );
  category.index({ subjectId: 1, name: 1 }, { unique: true });
  const question = new Schema(
    {
      subjectId: { type: Schema.Types.ObjectId, required: true },
      categoryId: { type: Schema.Types.ObjectId, required: true },
      type: { type: String, enum: ["choice", "essay"], required: true },
      text: String,
      options: [String],
      correctOption: Number,
      explanation: String,
      points: Number,
    },
    { timestamps: true },
  );
  question.index({ subjectId: 1, categoryId: 1 });
  const exam = new Schema(
    {
      slug: { type: String, required: true, unique: true },
      title: String,
      subjectId: Schema.Types.ObjectId,
      subjectName: String,
      categoryIds: [Schema.Types.ObjectId],
      categoryNames: [String],
      startsAt: Date,
      endsAt: Date,
      durationMinutes: Number,
      passwordHash: { type: String, select: false },
      questions: { type: [Schema.Types.Mixed], select: false },
      createdBy: String,
    },
    { timestamps: true },
  );
  exam.index({ startsAt: 1, endsAt: 1 });
  const attempt = new Schema(
    {
      examId: { type: Schema.Types.ObjectId, required: true },
      name: String,
      tokenHash: { type: String, required: true, unique: true, select: false },
      questions: { type: [Schema.Types.Mixed], select: false },
      answers: { type: Schema.Types.Mixed, default: {} },
      answerHistory: { type: [Schema.Types.Mixed], default: [] },
      events: { type: [Schema.Types.Mixed], default: [] },
      startedAt: Date,
      deadline: Date,
      lastSeenAt: Date,
      submittedAt: Date,
      status: {
        type: String,
        enum: ["IN_PROGRESS", "PENDING_REVIEW", "GRADED"],
        default: "IN_PROGRESS",
      },
      revision: { type: Number, default: 0 },
      score: Number,
      maxScore: Number,
      grades: { type: Schema.Types.Mixed, default: {} },
      gradedBy: String,
    },
    { timestamps: true },
  );
  attempt.index({ examId: 1, startedAt: -1 });
  attempt.add({
    pendingAnswerLog: { type: Schema.Types.Mixed, select: false },
  });
  const answerLog = new Schema({
    attemptId: Schema.Types.ObjectId,
    revision: Number,
    receivedAt: Date,
    answers: Schema.Types.Mixed,
  });
  answerLog.index({ attemptId: 1, revision: 1 }, { unique: true });
  const activity = new Schema({
    attemptId: Schema.Types.ObjectId,
    id: String,
    type: String,
    detail: String,
    receivedAt: Date,
  });
  activity.index({ attemptId: 1, id: 1 }, { unique: true });
  return {
    Subject: model("ProgressSubject", subject, "subjects"),
    Category: model("ProgressCategory", category, "categories"),
    Question: model("ProgressQuestion", question, "questions"),
    Exam: model("ProgressExam", exam, "exams"),
    Attempt: model("ProgressAttempt", attempt, "attempts"),
    AnswerLog: model("ProgressAnswerLog", answerLog, "answer_history"),
    Activity: model("ProgressActivity", activity, "activities"),
  };
}
module.exports = getModels;
