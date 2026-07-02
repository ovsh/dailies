import type { DailiesAPI } from "../shared/ipc";
import { createMockApi } from "./mock/api";

export const api: DailiesAPI = window.dailies ?? createMockApi();
