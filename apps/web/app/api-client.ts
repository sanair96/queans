import { assertOk } from "./api-errors";

export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? "http://localhost:4000";

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: "no-store"
  });

  await assertOk(response, "API request");

  return response.json() as Promise<T>;
}
