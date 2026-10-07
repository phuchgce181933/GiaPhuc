"use strict";
const { z } = require("zod");
const id = z.string().regex(/^[0-9a-fA-F]{24}$/);
const text = z.string().trim().min(1).max(120);
const subject = z.object({ name: text }).strict();
const category = z.object({ name: text, subjectId: id }).strict();
const question = z
  .object({
    subjectId: id,
    categoryId: id,
    type: z.enum(["choice", "essay"]),
    text: z.string().trim().min(1).max(10000),
    options: z.array(z.string().trim().min(1).max(2000)).max(8).default([]),
    correctOption: z.number().int().min(0).max(7).nullable().optional(),
    explanation: z.string().max(10000).default(""),
    points: z.number().positive().max(100).default(1),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (
      q.type === "choice" &&
      (q.options.length < 2 ||
        q.correctOption == null ||
        q.correctOption >= q.options.length)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Trắc nghiệm cần ít nhất 2 lựa chọn và một đáp án đúng hợp lệ.",
      });
    if (q.type === "essay" && (q.options.length || q.correctOption != null))
      ctx.addIssue({
        code: "custom",
        message: "Tự luận không có lựa chọn trắc nghiệm.",
      });
  });
const exam = z
  .object({
    title: text,
    subjectId: id,
    categoryIds: z.array(id).min(1).max(100),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    durationMinutes: z.number().int().min(1).max(300),
    password: z.string().min(4).max(100),
    questionCount: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (value) => new Date(value.endsAt) > new Date(value.startsAt),
    "Thời gian kết thúc phải sau thời gian bắt đầu.",
  )
  .refine(value => value.durationMinutes * 60000 <= Date.parse(value.endsAt) - Date.parse(value.startsAt), {
    message: 'Thời gian làm bài không được vượt khoảng thời gian mở kiểm tra.',
    path: ['durationMinutes'],
  });
const join = z
  .object({
    name: z.string().trim().min(2).max(120),
    password: z.string().min(1).max(100),
  })
  .strict();
const verify = z.object({ password: z.string().min(1).max(100) }).strict();
const save = z
  .object({
    revision: z.number().int().nonnegative(),
    answers: z
      .record(z.union([z.number().int(), z.string().max(10000), z.null()]))
      .refine((v) => Object.keys(v).length <= 100),
  })
  .strict();
const event = z
  .object({
    id: z.string().uuid(),
    type: z.enum([
      "TAB_HIDDEN",
      "WINDOW_BLUR",
      "PAGE_EXIT",
      "RETURN",
      "FULLSCREEN_EXIT",
    ]),
    detail: z.string().max(200).default(""),
  })
  .strict();
const grade = z
  .object({
    grades: z
      .record(z.number().nonnegative().max(100))
      .refine((v) => Object.keys(v).length <= 100),
  })
  .strict();
module.exports = {
  id,
  subject,
  category,
  question,
  exam,
  join,
  verify,
  save,
  event,
  grade,
};
