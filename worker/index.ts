type User = { id: string; name: string };
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const err = (message: string, status = 400) => json({ error: message }, status);
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const passwordHash = async (password: string, salt: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(salt),
        iterations: 310000,
      },
      key,
      256,
    ),
  );
};
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const body = async (request: Request): Promise<Record<string, unknown>> => {
  if (Number(request.headers.get("content-length") || 0) > 20000)
    throw new Error("Prevelik zahtjev");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Prazan zahtjev");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 20000) {
      await reader.cancel();
      throw new Error("Prevelik zahtjev");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Neispravan unos");
  return value as Record<string, unknown>;
};
const str = (value: unknown, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const validDate = (value: string) => {
  const date = new Date(`${value}T12:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
};
const score = (value: unknown) =>
  typeof value === "number" &&
  value >= 1 &&
  value <= 10 &&
  value * 2 === Math.round(value * 2);
const auth = async (request: Request, env: Env): Promise<User | null> => {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  return env.DB.prepare(
    "SELECT users.id, users.name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  )
    .bind(await digest(token), new Date().toISOString())
    .first<User>();
};
const session = async (env: Env, user: User) => {
  const token = random();
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
  )
    .bind(await digest(token), user.id, expires)
    .run();
  return json({ token, user });
};
const data = async (env: Env) => {
  const [users, places, visits, ratings, photos] = await Promise.all([
    env.DB.prepare("SELECT id,name FROM users ORDER BY created_at").all(),
    env.DB.prepare("SELECT * FROM places ORDER BY created_at DESC").all(),
    env.DB.prepare(
      "SELECT * FROM visits ORDER BY visited_at DESC, created_at DESC",
    ).all(),
    env.DB.prepare("SELECT * FROM ratings").all(),
    env.DB.prepare("SELECT id,visit_id,user_id,created_at FROM photos").all(),
  ]);
  return json({
    users: users.results,
    places: places.results,
    visits: visits.results,
    ratings: ratings.results,
    photos: photos.results,
  });
};
const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/health") return json({ ok: true });
  if (path === "/auth/register" && method === "POST") {
    const input = await body(request);
    const name = str(input.name, 40);
    const password = str(input.password, 200);
    if (!same(str(input.invite, 200), env.INVITE_CODE) || !env.INVITE_CODE)
      return err("Nevažeća pozivnica", 403);
    if (name.length < 2 || password.length < 6)
      return err("Ime mora imati 2, a lozinka barem 6 znakova");
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM users",
    ).first<{ n: number }>();
    if ((count?.n || 0) >= 2) return err("Oba računa već postoje", 403);
    const user = { id: crypto.randomUUID(), name };
    const salt = random();
    try {
      await env.DB.prepare(
        "INSERT INTO users (id,name,salt,password_hash) VALUES (?,?,?,?)",
      )
        .bind(user.id, name, salt, await passwordHash(password, salt))
        .run();
    } catch {
      return err("Ime je već zauzeto");
    }
    return session(env, user);
  }
  if (path === "/auth/login" && method === "POST") {
    const input = await body(request);
    const name = str(input.name, 40);
    const password = str(input.password, 200);
    const key = await digest(
      `${request.headers.get("CF-Connecting-IP") || "local"}:${name.toLowerCase()}`,
    );
    const limit = await env.DB.prepare(
      "SELECT attempts,reset_at FROM login_attempts WHERE key = ?",
    )
      .bind(key)
      .first<{ attempts: number; reset_at: string }>();
    const now = new Date().toISOString();
    if (limit && limit.reset_at > now && limit.attempts >= 5)
      return err("Previše pokušaja. Pokušaj za 15 minuta.", 429);
    const row = await env.DB.prepare(
      "SELECT id,name,salt,password_hash FROM users WHERE name = ?",
    )
      .bind(name)
      .first<User & { salt: string; password_hash: string }>();
    if (
      !row ||
      !same(await passwordHash(password, row.salt), row.password_hash)
    ) {
      const resetAt = new Date(Date.now() + 15 * 60000).toISOString();
      await env.DB.prepare(
        "INSERT INTO login_attempts (key,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN reset_at < ? THEN 1 ELSE attempts + 1 END, reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END",
      )
        .bind(key, resetAt, now, now)
        .run();
      return err("Pogrešno ime ili lozinka", 401);
    }
    await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?")
      .bind(key)
      .run();
    return session(env, { id: row.id, name: row.name });
  }
  const user = await auth(request, env);
  if (!user) return err("Prijavi se ponovno", 401);
  const tile = path.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (tile && method === "GET") {
    const [z, x, y] = tile.slice(1).map(Number);
    if (z > 19 || x >= 2 ** z || y >= 2 ** z) return err("Neispravna karta");
    const tileUrl = new URL(
      `https://maps.geoapify.com/v1/tile/osm-carto/${z}/${x}/${y}.png`,
    );
    tileUrl.searchParams.set("apiKey", env.GEOAPIFY_KEY);
    const result = await fetch(tileUrl);
    if (!result.ok) return err("Karta trenutačno nije dostupna", 502);
    return new Response(result.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400",
      },
    });
  }
  if (path === "/auth/me" && method === "GET") return json({ user });
  if (path === "/auth/logout" && method === "POST") {
    const token = request.headers.get("authorization")?.slice(7) || "";
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await digest(token))
      .run();
    return json({ ok: true });
  }
  if (path === "/data" && method === "GET") return data(env);
  if (path === "/places/search" && method === "GET") {
    const q = str(url.searchParams.get("q"), 80);
    if (q.length < 3) return json({ results: [] });
    const placeApis = ["catering.restaurant", "catering.cafe"].map(
      (category) => {
        const api = new URL("https://api.geoapify.com/v2/places");
        api.searchParams.set("categories", category);
        api.searchParams.set("name", q);
        api.searchParams.set("bias", "proximity:15.982,45.815");
        api.searchParams.set("limit", "6");
        api.searchParams.set("lang", "hr");
        api.searchParams.set("apiKey", env.GEOAPIFY_KEY);
        return api;
      },
    );
    const addressApi = new URL(
      "https://api.geoapify.com/v1/geocode/autocomplete",
    );
    addressApi.searchParams.set("text", q);
    addressApi.searchParams.set("bias", "proximity:15.982,45.815");
    addressApi.searchParams.set("lang", "hr");
    addressApi.searchParams.set("limit", "6");
    addressApi.searchParams.set("apiKey", env.GEOAPIFY_KEY);
    type Feature = { properties: Record<string, unknown> };
    const responses = await Promise.all(
      [...placeApis, addressApi].map((api) => fetch(api)),
    );
    if (responses.every((r) => !r.ok))
      return err("Pretraga trenutačno nije dostupna", 502);
    const collections = await Promise.all(
      responses.map(async (response) =>
        response.ok
          ? ((await response.json()) as { features?: Feature[] }).features || []
          : [],
      ),
    );
    const seen = new Set<string>();
    const results = collections.flat().flatMap((feature) => {
      const p = feature.properties;
      const lat = Number(p.lat),
        lng = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const name = String(p.name || p.address_line1 || q);
      const sourceId = String(p.place_id || "");
      const identity =
        sourceId || `${name}:${lat.toFixed(5)}:${lng.toFixed(5)}`;
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [
        {
          name,
          address: String(p.formatted || ""),
          city: String(p.city || ""),
          lat,
          lng,
          source_id: sourceId,
        },
      ];
    });
    return json({
      results: results.slice(0, 8),
    });
  }
  if (path === "/places" && method === "POST") {
    const v = await body(request);
    const name = str(v.name),
      kind = str(v.kind),
      address = str(v.address),
      city = str(v.city, 100),
      sourceId = str(v.source_id, 100) || null;
    const lat = Number(v.lat),
      lng = Number(v.lng);
    if (
      !name ||
      !["restaurant", "cafe"].includes(kind) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      return err("Provjeri podatke o mjestu");
    if (sourceId) {
      const prior = await env.DB.prepare(
        "SELECT id FROM places WHERE source_id = ?",
      )
        .bind(sourceId)
        .first<{ id: string }>();
      if (prior) return json({ id: prior.id, existing: true });
    }
    const id =
      typeof v.id === "string" && /^[0-9a-f-]{36}$/i.test(v.id)
        ? v.id
        : crypto.randomUUID();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO places (id,name,kind,address,city,lat,lng,source_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(id, name, kind, address, city, lat, lng, sourceId, user.id)
      .run();
    return json({ id }, 201);
  }
  const placeId = path.match(/^\/places\/([^/]+)$/)?.[1];
  if (placeId && method === "PATCH") {
    const v = await body(request);
    const name = str(v.name),
      kind = str(v.kind),
      address = str(v.address),
      city = str(v.city, 100);
    const lat = Number(v.lat),
      lng = Number(v.lng);
    if (
      !name ||
      !["restaurant", "cafe"].includes(kind) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      return err("Provjeri podatke o mjestu");
    const result = await env.DB.prepare(
      "UPDATE places SET name=?,kind=?,address=?,city=?,lat=?,lng=? WHERE id=?",
    )
      .bind(name, kind, address, city, lat, lng, placeId)
      .run();
    return result.meta.changes
      ? json({ id: placeId })
      : err("Mjesto ne postoji", 404);
  }
  if (placeId && method === "DELETE") {
    await env.DB.prepare("DELETE FROM places WHERE id = ?").bind(placeId).run();
    return json({ ok: true });
  }
  if (path === "/visits" && method === "POST") {
    const v = await body(request);
    const placeId = str(v.place_id, 100),
      visitedAt = str(v.visited_at, 10),
      note = str(v.note, 1000);
    if (!validDate(visitedAt)) return err("Provjeri datum");
    const place = await env.DB.prepare("SELECT id FROM places WHERE id = ?")
      .bind(placeId)
      .first();
    if (!place) return err("Mjesto ne postoji", 404);
    const id =
      typeof v.id === "string" && /^[0-9a-f-]{36}$/i.test(v.id)
        ? v.id
        : crypto.randomUUID();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO visits (id,place_id,user_id,visited_at,note) VALUES (?,?,?,?,?)",
    )
      .bind(id, placeId, user.id, visitedAt, note)
      .run();
    return json({ id }, 201);
  }
  const visitId = path.match(/^\/visits\/([^/]+)$/)?.[1];
  if (visitId && method === "PATCH") {
    const v = await body(request);
    const visitedAt = str(v.visited_at, 10),
      note = str(v.note, 1000);
    if (!validDate(visitedAt)) return err("Provjeri datum");
    const result = await env.DB.prepare(
      "UPDATE visits SET visited_at = ?, note = ? WHERE id = ?",
    )
      .bind(visitedAt, note, visitId)
      .run();
    return result.meta.changes
      ? json({ ok: true })
      : err("Posjet ne postoji", 404);
  }
  if (visitId && method === "DELETE") {
    await env.DB.prepare("DELETE FROM visits WHERE id = ?").bind(visitId).run();
    return json({ ok: true });
  }
  const ratingPlace = path.match(/^\/ratings\/([^/]+)$/)?.[1];
  if (ratingPlace && method === "PUT") {
    const v = await body(request);
    if (
      ![v.service, v.ambience, v.value, v.location].every(score) ||
      !(v.food === null || score(v.food))
    )
      return err("Ocjene moraju biti od 1 do 10 u koracima od 0,5");
    const place = await env.DB.prepare("SELECT id FROM places WHERE id = ?")
      .bind(ratingPlace)
      .first();
    if (!place) return err("Mjesto ne postoji", 404);
    await env.DB.prepare(
      "INSERT INTO ratings (place_id,user_id,service,ambience,value,location,food) VALUES (?,?,?,?,?,?,?) ON CONFLICT(place_id,user_id) DO UPDATE SET service=excluded.service,ambience=excluded.ambience,value=excluded.value,location=excluded.location,food=excluded.food,updated_at=CURRENT_TIMESTAMP",
    )
      .bind(
        ratingPlace,
        user.id,
        v.service,
        v.ambience,
        v.value,
        v.location,
        v.food,
      )
      .run();
    return json({ ok: true });
  }
  const photoVisit = path.match(/^\/visits\/([^/]+)\/photos$/)?.[1];
  if (photoVisit && method === "POST") {
    const visit = await env.DB.prepare("SELECT id FROM visits WHERE id = ?")
      .bind(photoVisit)
      .first();
    if (!visit) return err("Posjet ne postoji", 404);
    const type = request.headers.get("content-type") || "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(type))
      return err("Podržane su JPEG, PNG i WebP slike");
    if (Number(request.headers.get("content-length") || 0) > 1_500_000)
      return err("Slika je prevelika");
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1_500_000) return err("Slika je prevelika");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO photos (id,visit_id,user_id,content_type,bytes) VALUES (?,?,?,?,?)",
    )
      .bind(id, photoVisit, user.id, type, bytes)
      .run();
    return json({ id }, 201);
  }
  const photoId = path.match(/^\/photos\/([^/]+)$/)?.[1];
  if (photoId && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT bytes,content_type FROM photos WHERE id = ?",
    )
      .bind(photoId)
      .first<{ bytes: number[]; content_type: string }>();
    if (!row) return err("Slika ne postoji", 404);
    return new Response(new Uint8Array(row.bytes), {
      headers: {
        "Content-Type": row.content_type,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (photoId && method === "DELETE") {
    const row = await env.DB.prepare("SELECT id FROM photos WHERE id = ?")
      .bind(photoId)
      .first<{ id: string }>();
    if (!row) return err("Slika ne postoji", 404);
    await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(photoId).run();
    return json({ ok: true });
  }
  return err("Nije pronađeno", 404);
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const allowed =
      origin === env.ALLOWED_ORIGIN ||
      (origin === null && new URL(request.url).origin === env.ALLOWED_ORIGIN);
    if (origin && !allowed) return err("Nedopušten izvor", 403);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    try {
      const response = await route(request, env);
      Object.entries(cors).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "request_failed",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return new Response(JSON.stringify({ error: "Dogodila se greška" }), {
        status: 500,
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }
  },
} satisfies ExportedHandler<Env>;
