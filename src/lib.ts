export type User = { id: string; name: string };
export type Place = {
  id: string;
  name: string;
  kind: "restaurant" | "cafe";
  address: string;
  city: string;
  lat: number;
  lng: number;
  source_id: string | null;
  created_by: string;
  created_at: string;
};
export type Visit = {
  id: string;
  place_id: string;
  user_id: string;
  visited_at: string;
  note: string;
  created_at: string;
};
export type Rating = {
  place_id: string;
  user_id: string;
  service: number;
  ambience: number;
  value: number;
  location: number;
  food: number | null;
  updated_at: string;
};
export type Photo = {
  id: string;
  visit_id: string;
  user_id: string;
  created_at: string;
};
export type Data = {
  users: User[];
  places: Place[];
  visits: Visit[];
  ratings: Rating[];
  photos: Photo[];
};
export const emptyData: Data = {
  users: [],
  places: [],
  visits: [],
  ratings: [],
  photos: [],
};
export const categories = [
  ["service", "Usluga"],
  ["ambience", "Ambijent"],
  ["value", "Cijene"],
  ["location", "Lokacija"],
  ["food", "Hrana"],
] as const;
export const ratingAverage = (
  ratings: Rating[],
  key: keyof Pick<
    Rating,
    "service" | "ambience" | "value" | "location" | "food"
  >,
) => {
  const values = ratings
    .map((r) => r[key])
    .filter((n): n is number => typeof n === "number");
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
};
export const placeAverage = (ratings: Rating[]) => {
  const values = categories
    .map(([key]) => ratingAverage(ratings, key))
    .filter((n): n is number => n !== null);
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
};
export const formatScore = (value: number | null) =>
  value === null
    ? "—"
    : value.toLocaleString("hr-HR", { maximumFractionDigits: 2 });
export const today = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zagreb" });
export const prettyDate = (day: string) =>
  new Intl.DateTimeFormat("hr-HR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
export const apiBase = (
  import.meta.env.VITE_API_URL || "http://localhost:8787"
).replace(/\/$/, "");
export async function api<T>(
  path: string,
  method = "GET",
  payload?: unknown,
  token = localStorage.getItem("ratey_token") || "",
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "Nešto je pošlo po krivu");
  return data;
}
export type PendingAction = { path: string; method: string; payload: unknown };
export const getQueue = (): PendingAction[] => {
  try {
    return JSON.parse(
      localStorage.getItem("ratey_queue") || "[]",
    ) as PendingAction[];
  } catch {
    return [];
  }
};
export const queueAction = (item: PendingAction) =>
  localStorage.setItem("ratey_queue", JSON.stringify([...getQueue(), item]));
export const updateCached = (change: (data: Data) => Data) => {
  let current = emptyData;
  try {
    current = JSON.parse(localStorage.getItem("ratey_data") || "") as Data;
  } catch {
    /* use empty cache */
  }
  localStorage.setItem("ratey_data", JSON.stringify(change(current)));
};
export async function flushQueue() {
  const items = getQueue();
  for (let i = 0; i < items.length; i++) {
    try {
      await api(items[i].path, items[i].method, items[i].payload);
      localStorage.setItem("ratey_queue", JSON.stringify(items.slice(i + 1)));
    } catch {
      break;
    }
  }
}
