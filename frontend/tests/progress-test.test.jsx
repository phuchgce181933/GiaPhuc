import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import StudentPage from "../src/features/progress-test/pages/StudentPage";
import AttemptPage from "../src/features/progress-test/pages/AttemptPage";
import MathText from "../src/features/progress-test/components/MathText";
import { request } from "../src/features/progress-test/service";
import { eventId } from "../src/features/progress-test/utils";
vi.mock('../src/components/common/AppDialog', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/features/progress-test/service", () => ({
  request: vi.fn(),
  dateLabel: (value) => value,
  statusLabel: (value) => value,
}));
const exam = {
  title: "Toán Unit 1",
  subjectName: "Toán",
  categoryNames: ["Unit 1"],
  state: "OPEN",
  startsAt: "2026-10-07T00:00:00Z",
  endsAt: "2026-10-07T23:00:00Z",
  durationMinutes: 30,
};
const attempt = () => ({
  id: "attempt",
  name: "Học sinh QA",
  status: "IN_PROGRESS",
  questions: [
    {
      id: "q1",
      type: "choice",
      text: "2 + 2 = ?",
      options: ["4", "5"],
      points: 2,
    },
  ],
  answers: {},
  revision: 0,
  deadline: new Date(Date.now() + 600000).toISOString(),
  serverTime: new Date().toISOString(),
  maxScore: 2,
});
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const student = () =>
  render(
    <MemoryRouter initialEntries={["/tests/example"]}>
      <Routes>
        <Route path="/tests/:slug" element={<StudentPage />} />
      </Routes>
    </MemoryRouter>,
  );
test("locked exam displays its lock state and has no password/start form", async () => {
  request.mockResolvedValue({ ...exam, state: "LOCKED" });
  student();
  expect(await screen.findByText("Đường dẫn đang khóa")).toBeTruthy();
  expect(screen.queryByLabelText("Mật khẩu kiểm tra")).toBeNull();
});
test("student verifies password then provides name before creating an attempt", async () => {
  request.mockImplementation(async (path) =>
    path.endsWith("/verify")
      ? { verified: true }
      : path.endsWith("/join")
        ? { token: "a".repeat(64) }
        : path === "/attempt"
          ? attempt()
          : exam,
  );
  const user = userEvent.setup();
  student();
  await user.type(await screen.findByLabelText("Mật khẩu kiểm tra"), "secret");
  await user.click(screen.getByRole("button", { name: "Tiếp tục" }));
  expect(await screen.findByLabelText("Họ và tên của bạn")).toBeTruthy();
  expect(request.mock.calls.some(([path]) => path.endsWith("/join"))).toBe(
    false,
  );
  await user.type(screen.getByLabelText("Họ và tên của bạn"), "Nguyễn Văn QA");
  await user.click(screen.getByRole("button", { name: "Bắt đầu làm bài" }));
  expect(await screen.findByText("2 + 2 = ?")).toBeTruthy();
  expect(request).toHaveBeenCalledWith(
    "/exams/example/join",
    expect.objectContaining({
      data: { name: "Nguyễn Văn QA", password: "secret" },
    }),
  );
});
test("wrong password remains on password step and never starts an attempt", async () => {
  request.mockImplementation(async (path) => {
    if (path.endsWith("/verify"))
      throw new Error("Mật khẩu kiểm tra không đúng.");
    return exam;
  });
  const user = userEvent.setup();
  student();
  await user.type(await screen.findByLabelText("Mật khẩu kiểm tra"), "wrong");
  await user.click(screen.getByRole("button", { name: "Tiếp tục" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByLabelText("Họ và tên của bạn")).toBeNull();
});
test("choice is saved on the server before submit and blur is logged with session token", async () => {
  const initial = attempt();
  request.mockImplementation(async (path) =>
    path === "/attempt/answers"
      ? { revision: 1 }
      : path === "/attempt/submit"
        ? { ...initial, status: "GRADED", score: 2 }
        : initial,
  );
  const token = "a".repeat(64);
  render(<AttemptPage token={token} onInvalid={() => {}} />);
  await screen.findByText("2 + 2 = ?");
  fireEvent.click(screen.getAllByRole("radio")[0]);
  fireEvent(window, new Event("blur"));
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/attempt/events"),
    expect.objectContaining({
      keepalive: true,
      headers: expect.objectContaining({ "X-Attempt-Token": token }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Nộp bài" }));
  expect(await screen.findByText("Đã ghi nhận bài làm")).toBeTruthy();
  const saveIndex = request.mock.calls.findIndex(
    ([path]) => path === "/attempt/answers",
  );
  const submitIndex = request.mock.calls.findIndex(
    ([path]) => path === "/attempt/submit",
  );
  expect(saveIndex).toBeLessThan(submitIndex);
  expect(request.mock.calls[saveIndex][1].data.answers).toEqual({ q1: 0 });
});
test("essay rendered pending review has no editable answer controls", async () => {
  request.mockResolvedValue({
    ...attempt(),
    status: "PENDING_REVIEW",
    score: 0,
  });
  render(<AttemptPage token={"a".repeat(64)} onInvalid={() => {}} />);
  await screen.findByText("Đã ghi nhận bài làm");
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByText(/Giáo viên sẽ chấm/)).toBeTruthy();
});
test("math content renders equations and escapes text HTML without executable tags", () => {
  const { container } = render(
    <MathText text={"Giải $\\frac{1}{2}$ và <script>alert(1)</script>"} />,
  );
  expect(container.querySelector(".katex")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>");
});
test("activity event IDs work on LAN HTTP without crypto.randomUUID", () => {
  const original = crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: (bytes) => original.getRandomValues(bytes),
  });
  expect(eventId()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
