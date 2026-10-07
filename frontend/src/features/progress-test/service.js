import axios from "axios";
import { api } from "../../lib/axios";
import { env } from "../../lib/env";
const publicClient = axios.create({
  baseURL: `${env.API_BASE_URL}/progress-test/public`,
  timeout: 20000,
});
export async function request(
  path,
  { method = "GET", data, publicAccess = false, token } = {},
) {
  try {
    const response = await (publicAccess ? publicClient : api).request({
      url: publicAccess ? path : `/progress-test${path}`,
      method,
      data,
      headers: token ? { "X-Attempt-Token": token } : undefined,
    });
    return response.data.data;
  } catch (cause) {
    const error = new Error(
      cause.response?.data?.message ??
        "Không kết nối được máy chủ. Vui lòng thử lại.",
    );
    error.status = cause.response?.status;
    throw error;
  }
}
export const dateLabel = (date) =>
  new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(new Date(date));
export const statusLabel = (status) =>
  ({
    OPEN: "Đang mở",
    LOCKED: "Chưa đến giờ",
    CLOSED: "Đã kết thúc",
    IN_PROGRESS: "Đang làm",
    PENDING_REVIEW: "Chờ chấm tự luận",
    GRADED: "Đã chấm",
  })[status] ?? status;
