import { adminKeyPage, rotateOpenRouterKey } from "../../lib/admin";

export function GET(): Response {
  return adminKeyPage();
}

export function POST(request: Request): Promise<Response> {
  return rotateOpenRouterKey(request);
}
