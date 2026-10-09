import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import { registerSW } from "virtual:pwa-register";
import {
  MapPin,
  Plus,
  CalendarDays,
  ChartNoAxesColumn,
  House,
  LogOut,
  Search,
  Star,
  X,
  Camera,
  ChevronLeft,
  ChevronRight,
  WifiOff,
  RefreshCw,
  Utensils,
  Coffee,
  Check,
  Navigation,
} from "lucide-react";
import {
  api,
  apiBase,
  categories,
  emptyData,
  flushQueue,
  formatScore,
  getQueue,
  placeAverage,
  prettyDate,
  queueAction,
  ratingAverage,
  today,
  updateCached,
  type Data,
  type Place,
  type Rating,
  type User,
  type Visit,
} from "./lib";

type Tab = "home" | "map" | "calendar" | "stats";
type Suggestion = {
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  source_id: string;
};
const center: [number, number] = [45.815, 15.982];
const kindName = (kind: Place["kind"]) =>
  kind === "restaurant" ? "Restoran" : "Kafić";
function MapCanvas({
  places,
  token,
  onSelect,
  pick,
  picked,
}: {
  places: Place[];
  token: string;
  onSelect?: (place: Place) => void;
  pick?: (lat: number, lng: number) => void;
  picked?: [number, number];
}) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!node.current || map.current) return;
    const instance = L.map(node.current, { zoomControl: false }).setView(
      center,
      11,
    );
    class PrivateTiles extends L.GridLayer {
      createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
        const img = document.createElement("img");
        img.alt = "";
        img.width = 256;
        img.height = 256;
        void fetch(`${apiBase}/tiles/${coords.z}/${coords.x}/${coords.y}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => {
            if (!r.ok) throw new Error("Map tile unavailable");
            return r.blob();
          })
          .then((blob) => {
            const src = URL.createObjectURL(blob);
            img.onload = () => {
              URL.revokeObjectURL(src);
              done(undefined, img);
            };
            img.onerror = () => {
              URL.revokeObjectURL(src);
              done(new Error("Map tile unavailable"), img);
            };
            img.src = src;
          })
          .catch((e) => done(e, img));
        return img;
      }
    }
    new PrivateTiles({
      maxZoom: 19,
      attribution:
        'Powered by <a href="https://www.geoapify.com/">Geoapify</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    }).addTo(instance);
    L.control.zoom({ position: "bottomright" }).addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    map.current = instance;
    setTimeout(() => instance.invalidateSize(), 100);
    return () => {
      instance.remove();
      map.current = null;
      layer.current = null;
    };
  }, [token]);
  useEffect(() => {
    const instance = map.current,
      group = layer.current;
    if (!instance || !group) return;
    group.clearLayers();
    places.forEach((place) => {
      const icon = L.divIcon({
        className: "pin-wrap",
        html: `<span class="pin ${place.kind}">${place.kind === "restaurant" ? "✦" : "●"}</span>`,
        iconSize: [38, 44],
        iconAnchor: [19, 38],
      });
      L.marker([place.lat, place.lng], { icon })
        .addTo(group)
        .on("click", () => onSelect?.(place));
    });
    if (picked)
      L.marker(picked, {
        icon: L.divIcon({
          className: "pin-wrap",
          html: '<span class="pin picked">✓</span>',
          iconSize: [38, 44],
          iconAnchor: [19, 38],
        }),
      }).addTo(group);
    if (picked) instance.setView(picked, 15);
    else if (places.length)
      instance.fitBounds(
        L.latLngBounds(places.map((p) => [p.lat, p.lng] as [number, number])),
        { padding: [35, 35], maxZoom: 13 },
      );
  }, [places, picked, onSelect]);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !pick) return;
    const handler = (e: L.LeafletMouseEvent) =>
      pick(e.latlng.lat, e.latlng.lng);
    instance.on("click", handler);
    return () => {
      instance.off("click", handler);
    };
  }, [pick]);
  return <div ref={node} className="map-canvas" aria-label="Karta mjesta" />;
}
function PhotoThumb({
  id,
  token,
  className = "",
}: {
  id: string;
  token: string;
  className?: string;
}) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    fetch(`${apiBase}/photos/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, token]);
  return src ? (
    <img
      className={className}
      src={src}
      alt="Fotografija s posjeta"
      loading="lazy"
    />
  ) : (
    <div className={`${className} photo-placeholder`}>
      <Camera size={18} />
    </div>
  );
}
function App() {
  const [token, setToken] = useState(localStorage.getItem("ratey_token") || "");
  const [user, setUser] = useState<User | null>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("ratey_user") || "null",
      ) as User | null;
    } catch {
      return null;
    }
  });
  const [data, setData] = useState<Data>(() => {
    try {
      return JSON.parse(localStorage.getItem("ratey_data") || "") as Data;
    } catch {
      return emptyData;
    }
  });
  const [tab, setTab] = useState<Tab>("home");
  const [selected, setSelected] = useState<Place | null>(null);
  const [screen, setScreen] = useState<
    "place" | "editPlace" | "visit" | "rating" | null
  >(null);
  const [editingVisit, setEditingVisit] = useState<Visit | null>(null);
  const [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const updateSW = useRef<((reloadPage?: boolean) => Promise<void>) | null>(
    null,
  );
  const [month, setMonth] = useState(() => new Date());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "restaurant" | "cafe">("all");
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const result = await api<Data>("/data", "GET", undefined, token);
      setData(result);
      localStorage.setItem("ratey_data", JSON.stringify(result));
      setOffline(false);
    } catch (e) {
      if (
        navigator.onLine &&
        e instanceof Error &&
        e.message === "Prijavi se ponovno"
      ) {
        localStorage.removeItem("ratey_token");
        localStorage.removeItem("ratey_user");
        setToken("");
        setUser(null);
      } else setOffline(true);
    }
  }, [token]);
  useEffect(() => {
    if (!token) return;
    api<{ user: User }>("/auth/me", "GET", undefined, token)
      .then((r) => {
        setUser(r.user);
        localStorage.setItem("ratey_user", JSON.stringify(r.user));
      })
      .catch(() => {
        if (navigator.onLine) {
          localStorage.removeItem("ratey_token");
          localStorage.removeItem("ratey_user");
          setToken("");
          setUser(null);
        }
      });
    void flushQueue().then(refresh);
  }, [token, refresh]);
  useEffect(() => {
    const onOnline = () => {
      setOffline(false);
      void flushQueue().then(refresh);
    };
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refresh]);
  useEffect(() => {
    updateSW.current = registerSW({
      onNeedRefresh: () => setNeedsUpdate(true),
      onOfflineReady: () => setNotice("Aplikacija je spremna za rad bez veze"),
    });
    const onFocus = () => {
      void navigator.serviceWorker?.getRegistration().then((r) => r?.update());
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const ratingsFor = (id: string) =>
    data.ratings.filter((r) => r.place_id === id);
  const visitsFor = (id: string) =>
    data.visits.filter((v) => v.place_id === id);
  const pending = data.places.filter(
    (p) =>
      !data.ratings.some((r) => r.place_id === p.id && r.user_id === user?.id),
  );
  const filtered = data.places.filter(
    (p) =>
      (filter === "all" || p.kind === filter) &&
      `${p.name} ${p.city}`.toLowerCase().includes(search.toLowerCase()),
  );
  const openPlace = (p: Place) => {
    setSelected(p);
    setScreen(null);
  };
  const close = () => {
    setSelected(null);
    setScreen(null);
    setEditingVisit(null);
  };
  const saved = async (message = "Spremljeno!") => {
    if (navigator.onLine) await refresh();
    else {
      try {
        setData(JSON.parse(localStorage.getItem("ratey_data") || "") as Data);
      } catch {
        /* keep cached data */
      }
    }
    setNotice(message);
    setTimeout(() => setNotice(""), 3500);
  };
  const logout = async () => {
    if (
      getQueue().length &&
      !confirm(
        "Imaš unose koji još nisu poslani. Odjavom će se obrisati. Odjaviti se?",
      )
    )
      return;
    try {
      await api("/auth/logout", "POST", undefined, token);
    } catch {
      /* local logout still works */
    }
    localStorage.removeItem("ratey_token");
    localStorage.removeItem("ratey_user");
    localStorage.removeItem("ratey_data");
    localStorage.removeItem("ratey_queue");
    setToken("");
    setUser(null);
    setData(emptyData);
  };
  if (!token || !user)
    return (
      <Login
        onLogin={(t, u) => {
          localStorage.setItem("ratey_token", t);
          localStorage.setItem("ratey_user", JSON.stringify(u));
          setToken(t);
          setUser(u);
        }}
      />
    );
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            r<span>.</span>
          </span>
          <div>
            <strong>ratey</strong>
            <small>naša mjesta</small>
          </div>
        </div>
        <div className="top-actions">
          {offline && (
            <span className="offline-pill">
              <WifiOff size={14} /> Offline
            </span>
          )}
          <button className="avatar" onClick={logout} title="Odjavi se">
            <span>{user.name.slice(0, 1).toUpperCase()}</span>
            <LogOut size={15} />
          </button>
        </div>
      </header>
      <main>
        {tab === "home" && (
          <>
            <section className="hero">
              <div className="eyebrow">VAŠ MALI VODIČ</div>
              <h1>
                Mjesta koja
                <br />
                <em>ostaju u priči.</em>
              </h1>
              <p>
                Svaki izlazak, svaka ocjena i svaki pin — sve na jednom mjestu.
              </p>
              <button
                className="primary hero-button"
                onClick={() => setScreen("place")}
              >
                <Plus size={19} /> Dodaj novo mjesto
              </button>
              <div className="hero-orbit">✳</div>
            </section>
            <section className="quick-stats">
              <div>
                <strong>{data.places.length}</strong>
                <span>mjesta</span>
              </div>
              <div>
                <strong>{data.visits.length}</strong>
                <span>posjeta</span>
              </div>
              <div>
                <strong>
                  {new Set(data.places.map((p) => p.city).filter(Boolean)).size}
                </strong>
                <span>gradova</span>
              </div>
            </section>
            {pending.length > 0 && (
              <section className="section">
                <div className="section-heading">
                  <h2>Čekaju tvoju ocjenu</h2>
                  <span className="count">{pending.length}</span>
                </div>
                <div className="horizontal-list">
                  {pending.map((p) => (
                    <button
                      key={p.id}
                      className="pending-card"
                      onClick={() => {
                        setSelected(p);
                        setScreen("rating");
                      }}
                    >
                      <span className="kind-icon">
                        {p.kind === "restaurant" ? (
                          <Utensils size={19} />
                        ) : (
                          <Coffee size={19} />
                        )}
                      </span>
                      <strong>{p.name}</strong>
                      <small>{p.city || p.address || "Novo mjesto"}</small>
                      <span className="rate-link">
                        Ocijeni <ChevronRight size={15} />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="section">
              <div className="section-heading">
                <h2>Zadnji posjeti</h2>
                <button
                  className="text-button"
                  onClick={() => setTab("calendar")}
                >
                  Vidi sve <ChevronRight size={16} />
                </button>
              </div>
              {data.visits.length ? (
                <div className="visit-list">
                  {data.visits.slice(0, 5).map((v) => {
                    const p = data.places.find((x) => x.id === v.place_id);
                    return p ? (
                      <button
                        className="visit-row"
                        key={v.id}
                        onClick={() => openPlace(p)}
                      >
                        <span className="date-badge">
                          <strong>{v.visited_at.slice(8, 10)}</strong>
                          <small>
                            {new Intl.DateTimeFormat("hr-HR", {
                              month: "short",
                            }).format(new Date(v.visited_at))}
                          </small>
                        </span>
                        <span className="visit-info">
                          <strong>{p.name}</strong>
                          <small>{p.city || kindName(p.kind)}</small>
                        </span>
                        <span className="score-mini">
                          <Star size={14} fill="currentColor" />
                          {formatScore(placeAverage(ratingsFor(p.id)))}
                        </span>
                      </button>
                    ) : null;
                  })}
                </div>
              ) : (
                <Empty text="Još nema posjeta. Krenite s prvim mjestom!" />
              )}
            </section>
          </>
        )}
        {tab === "map" && (
          <>
            <div className="page-title">
              <span className="eyebrow">SVI VAŠI PINOVI</span>
              <h1>
                Karta izlazaka<span className="dot">.</span>
              </h1>
              <p>{data.places.length} mjesta na vašoj karti</p>
            </div>
            <div className="map-panel">
              <MapCanvas places={filtered} token={token} onSelect={openPlace} />
            </div>
            <div className="search-line">
              <Search size={18} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Traži mjesto ili grad..."
              />
            </div>
            <div className="chips">
              {(["all", "restaurant", "cafe"] as const).map((k) => (
                <button
                  className={filter === k ? "chip active" : "chip"}
                  onClick={() => setFilter(k)}
                  key={k}
                >
                  {k === "all"
                    ? "Sve"
                    : k === "restaurant"
                      ? "Restorani"
                      : "Kafići"}
                </button>
              ))}
            </div>
            <div className="place-list">
              {filtered.map((p) => (
                <PlaceCard
                  key={p.id}
                  place={p}
                  ratings={ratingsFor(p.id)}
                  visits={visitsFor(p.id)}
                  onClick={() => openPlace(p)}
                />
              ))}
            </div>
          </>
        )}
        {tab === "calendar" && (
          <>
            <div className="page-title">
              <span className="eyebrow">KAD SMO BILI?</span>
              <h1>
                Naš kalendar<span className="dot">.</span>
              </h1>
              <p>Svaki datum ima svoju priču.</p>
            </div>
            <CalendarView
              month={month}
              setMonth={setMonth}
              data={data}
              openPlace={openPlace}
            />
          </>
        )}
        {tab === "stats" && <Stats data={data} openPlace={openPlace} />}
      </main>
      <nav className="bottom-nav" aria-label="Glavni izbornik">
        {(
          [
            ["home", House, "Početna"],
            ["map", MapPin, "Karta"],
            ["calendar", CalendarDays, "Kalendar"],
            ["stats", ChartNoAxesColumn, "Statistika"],
          ] as const
        ).map(([key, Icon, label]) => (
          <button
            className={tab === key ? "nav-item active" : "nav-item"}
            key={key}
            onClick={() => {
              setTab(key);
              setSelected(null);
              setScreen(null);
            }}
          >
            <Icon size={22} strokeWidth={tab === key ? 2.5 : 1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {screen === "place" && (
        <PlaceForm
          user={user}
          onClose={close}
          onSaved={async (id) => {
            await saved("Mjesto dodano!");
            const all = navigator.onLine
              ? await api<Data>("/data")
              : (JSON.parse(
                  localStorage.getItem("ratey_data") || "{}",
                ) as Data);
            const p = all.places.find((p) => p.id === id);
            if (p) {
              setSelected(p);
              setScreen("visit");
            } else close();
          }}
          token={token}
        />
      )}
      {selected && screen === "editPlace" && (
        <PlaceForm
          place={selected}
          user={user}
          token={token}
          onClose={() => setScreen(null)}
          onSaved={async (id) => {
            await saved("Mjesto ažurirano");
            const p = (
              navigator.onLine
                ? await api<Data>("/data")
                : (JSON.parse(
                    localStorage.getItem("ratey_data") || "{}",
                  ) as Data)
            ).places.find((p) => p.id === id);
            if (p) setSelected(p);
            setScreen(null);
          }}
        />
      )}
      {selected && !screen && (
        <PlaceDetail
          place={selected}
          data={data}
          token={token}
          user={user}
          onClose={close}
          onEditPlace={() => setScreen("editPlace")}
          onDeletePlace={async () => {
            await saved("Mjesto obrisano");
            close();
          }}
          onVisit={() => {
            setEditingVisit(null);
            setScreen("visit");
          }}
          onEditVisit={(v) => {
            setEditingVisit(v);
            setScreen("visit");
          }}
          onRate={() => setScreen("rating")}
          onRefresh={saved}
        />
      )}
      {selected && screen === "visit" && (
        <VisitForm
          place={selected}
          user={user}
          token={token}
          visit={editingVisit}
          onClose={() => {
            setScreen(null);
            setEditingVisit(null);
          }}
          onSaved={async () => {
            await saved("Posjet spremljen!");
            setScreen(null);
            setEditingVisit(null);
          }}
        />
      )}
      {selected && screen === "rating" && (
        <RatingForm
          place={selected}
          user={user}
          current={data.ratings.find(
            (r) => r.place_id === selected.id && r.user_id === user.id,
          )}
          onClose={() => setScreen(null)}
          onSaved={async () => {
            await saved("Ocjena spremljena!");
            setScreen(null);
          }}
        />
      )}
      {notice && (
        <div className="toast">
          <Check size={17} />
          {notice}
        </div>
      )}
      {getQueue().length > 0 && (
        <div className="sync-note">
          <RefreshCw size={15} /> {getQueue().length} unos(a) čeka
          sinkronizaciju
        </div>
      )}
      {needsUpdate && (
        <div className="update-banner">
          <span>Nova verzija je spremna.</span>
          <button
            disabled={screen !== null}
            onClick={() => void updateSW.current?.(true)}
          >
            {screen ? "Završi unos prvo" : "Osvježi"}
          </button>
        </div>
      )}
    </div>
  );
}
function Login({ onLogin }: { onLogin: (token: string, user: User) => void }) {
  const [register, setRegister] = useState(false),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [invite, setInvite] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string; user: User }>(
        register ? "/auth/register" : "/auth/login",
        "POST",
        { name, password, ...(register ? { invite } : {}) },
        "",
      );
      onLogin(r.token, r.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <div className="auth-art">
        <div className="auth-art-inner">
          ✦
          <span>
            Naša mala
            <br />
            velika mjesta.
          </span>
        </div>
      </div>
      <div className="auth-content">
        <div className="brand">
          <span className="brand-mark">
            r<span>.</span>
          </span>
          <div>
            <strong>ratey</strong>
            <small>naša mjesta</small>
          </div>
        </div>
        <span className="eyebrow">DOBRO DOŠLI</span>
        <h1>
          {register ? "Kreiraj svoj račun." : "Nastavimo tamo gdje smo stali."}
        </h1>
        <p>Vaša privatna karta izlazaka čeka.</p>
        <form onSubmit={submit}>
          <label>
            Ime
            <input
              autoComplete="username"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tvoje ime"
            />
          </label>
          <label>
            Lozinka
            <input
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={register ? 12 : undefined}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Najmanje 12 znakova"
            />
          </label>
          {register && (
            <label>
              Pozivni kod
              <input
                type="password"
                required
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                placeholder="Vaš zajednički kod"
              />
            </label>
          )}
          {error && <div className="form-error">{error}</div>}
          <button className="primary full" disabled={busy}>
            {busy ? "Samo tren..." : register ? "Kreiraj račun" : "Prijavi se"}
          </button>
        </form>
        <button
          className="auth-switch"
          onClick={() => {
            setRegister(!register);
            setError("");
          }}
        >
          {register
            ? "Već imaš račun? Prijavi se"
            : "Prvi put ovdje? Kreiraj račun"}
        </button>
      </div>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <span>✳</span>
      <p>{text}</p>
    </div>
  );
}
function PlaceCard({
  place,
  ratings,
  visits,
  onClick,
}: {
  place: Place;
  ratings: Rating[];
  visits: Visit[];
  onClick: () => void;
}) {
  return (
    <button className="place-card" onClick={onClick}>
      <span className="kind-icon">
        {place.kind === "restaurant" ? (
          <Utensils size={19} />
        ) : (
          <Coffee size={19} />
        )}
      </span>
      <span className="place-card-text">
        <strong>{place.name}</strong>
        <small>
          <MapPin size={13} />
          {place.city || place.address || kindName(place.kind)} ·{" "}
          {visits.length} posjet(a)
        </small>
      </span>
      <span className="score-pill">
        <Star size={14} fill="currentColor" />
        {formatScore(placeAverage(ratings))}
      </span>
    </button>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Zatvori"
          >
            <X size={22} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
function PlaceForm({
  user,
  place,
  onClose,
  onSaved,
  token,
}: {
  user: User;
  place?: Place;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  token: string;
}) {
  const [name, setName] = useState(place?.name || ""),
    [kind, setKind] = useState<"restaurant" | "cafe">(
      place?.kind || "restaurant",
    ),
    [address, setAddress] = useState(place?.address || ""),
    [city, setCity] = useState(place?.city || ""),
    [coords, setCoords] = useState<[number, number] | null>(
      place ? [place.lat, place.lng] : null,
    ),
    [source, setSource] = useState(place?.source_id || ""),
    [results, setResults] = useState<Suggestion[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (name.trim().length < 3 || source) {
      return;
    }
    const id = setTimeout(() => {
      void api<{ results: Suggestion[] }>(
        `/places/search?q=${encodeURIComponent(name)}`,
        "GET",
        undefined,
        token,
      )
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 400);
    return () => clearTimeout(id);
  }, [name, source, token]);
  const select = (r: Suggestion) => {
    setName(r.name);
    setAddress(r.address);
    setCity(r.city);
    setCoords([Number(r.lat), Number(r.lng)]);
    setSource(r.source_id);
    setResults([]);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!coords) {
      setError("Odaberi rezultat pretrage ili postavi pin na karti");
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (!navigator.onLine) {
        const id = place?.id || crypto.randomUUID();
        const payload = {
          id,
          name,
          kind,
          address,
          city,
          lat: coords[0],
          lng: coords[1],
          source_id: source || null,
        };
        queueAction({
          path: place ? `/places/${id}` : "/places",
          method: place ? "PATCH" : "POST",
          payload,
        });
        updateCached((d) => ({
          ...d,
          places: place
            ? d.places.map((p) => (p.id === id ? { ...p, ...payload } : p))
            : [
                {
                  ...payload,
                  created_by: user.id,
                  created_at: new Date().toISOString(),
                },
                ...d.places,
              ],
        }));
        await onSaved(id);
        return;
      }
      const r = await api<{ id: string }>(
        place ? `/places/${place.id}` : "/places",
        place ? "PATCH" : "POST",
        {
          name,
          kind,
          address,
          city,
          lat: coords[0],
          lng: coords[1],
          source_id: source || null,
        },
        token,
      );
      await onSaved(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal title={place ? "Uredi mjesto" : "Novo mjesto"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="kind-toggle">
          <button
            type="button"
            className={kind === "restaurant" ? "selected" : ""}
            onClick={() => setKind("restaurant")}
          >
            <Utensils size={17} /> Restoran
          </button>
          <button
            type="button"
            className={kind === "cafe" ? "selected" : ""}
            onClick={() => setKind("cafe")}
          >
            <Coffee size={17} /> Kafić
          </button>
        </div>
        <label>
          Naziv mjesta
          <div className="field-icon">
            <Search size={18} />
            <input
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSource("");
                setResults([]);
              }}
              placeholder="Npr. Batak Family Mall"
            />
          </div>
        </label>
        {results.length > 0 && (
          <div className="suggestions">
            {results.map((r, i) => (
              <button type="button" key={i} onClick={() => select(r)}>
                <MapPin size={16} />
                <span>
                  <strong>{r.name}</strong>
                  <small>{r.address}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        <label>
          Adresa
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Ulica i broj (neobavezno)"
          />
        </label>
        <label>
          Grad
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Grad"
          />
        </label>
        <div className="field-label">
          {coords
            ? "Pin je postavljen. Dodirni kartu za promjenu."
            : "Dodirni kartu za ručno postavljanje pina"}
        </div>
        <div className="pick-map">
          <MapCanvas
            places={[]}
            token={token}
            picked={coords || undefined}
            pick={(lat, lng) => setCoords([lat, lng])}
          />
        </div>
        <button
          type="button"
          className="locate-button"
          onClick={() =>
            navigator.geolocation.getCurrentPosition(
              (pos) => setCoords([pos.coords.latitude, pos.coords.longitude]),
              () => setError("Lokacija nije dostupna"),
            )
          }
        >
          <Navigation size={17} /> Postavi pin na moju lokaciju
        </button>
        {error && <div className="form-error">{error}</div>}
        <button className="primary full" disabled={loading}>
          {loading ? "Spremam..." : "Dodaj mjesto"}
        </button>
      </form>
    </Modal>
  );
}
function VisitForm({
  place,
  user,
  token,
  visit,
  onClose,
  onSaved,
}: {
  place: Place;
  user: User;
  token: string;
  visit: Visit | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [date, setDate] = useState(visit?.visited_at || today()),
    [note, setNote] = useState(visit?.note || ""),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!navigator.onLine) {
        if (files.length)
          throw new Error("Fotografije dodaj kad se vrati veza");
        const id = visit?.id || crypto.randomUUID();
        queueAction({
          path: visit ? `/visits/${id}` : "/visits",
          method: visit ? "PATCH" : "POST",
          payload: visit
            ? { visited_at: date, note }
            : { id, place_id: place.id, visited_at: date, note },
        });
        updateCached((d) => ({
          ...d,
          visits: visit
            ? d.visits.map((v) =>
                v.id === id ? { ...v, visited_at: date, note } : v,
              )
            : [
                {
                  id,
                  place_id: place.id,
                  user_id: user.id,
                  visited_at: date,
                  note,
                  created_at: new Date().toISOString(),
                },
                ...d.visits,
              ],
        }));
        await onSaved();
        return;
      }
      const id =
        visit?.id ||
        (
          await api<{ id: string }>(
            "/visits",
            "POST",
            { place_id: place.id, visited_at: date, note },
            token,
          )
        ).id;
      if (visit)
        await api(`/visits/${id}`, "PATCH", { visited_at: date, note }, token);
      for (const file of files) {
        const response = await fetch(`${apiBase}/visits/${id}/photos`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": file.type,
          },
          body: file,
        });
        if (!response.ok)
          throw new Error(
            "Posjet je spremljen, ali jedna fotografija nije. Pokušaj je dodati ponovno.",
          );
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${visit ? "Uredi posjet" : "Novi posjet"} · ${place.name}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <p className="form-intro">
          Zabilježi kad ste bili i kaj vam je ostalo u sjećanju.
        </p>
        <label>
          Datum posjeta
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          Bilješka <span className="optional">neobavezno</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Bilo je baš fino..."
            rows={4}
          />
        </label>
        <label className="upload-box">
          <Camera size={22} />
          <strong>Dodaj fotke</strong>
          <small>
            Neobavezno · JPEG, PNG, WebP ili HEIC · do 8 MB po slici
          </small>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            multiple
            onChange={(e) => setFiles([...(e.target.files || [])])}
          />
        </label>
        {files.length > 0 && (
          <p className="selected-files">
            {files.length} odabrana(e) fotografija(e)
          </p>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="primary full" disabled={busy}>
          {busy ? "Spremam..." : "Spremi posjet"}
        </button>
      </form>
    </Modal>
  );
}
function RatingForm({
  place,
  user,
  current,
  onClose,
  onSaved,
}: {
  place: Place;
  user: User;
  current?: Rating;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState({
      service: current?.service ?? 7,
      ambience: current?.ambience ?? 7,
      value: current?.value ?? 7,
      location: current?.location ?? 7,
      food: current?.food ?? (null as number | null),
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (key: keyof typeof values, value: number | null) =>
    setValues((v) => ({ ...v, [key]: value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!navigator.onLine) {
        queueAction({
          path: `/ratings/${place.id}`,
          method: "PUT",
          payload: values,
        });
        updateCached((d) => ({
          ...d,
          ratings: [
            ...d.ratings.filter(
              (r) => !(r.place_id === place.id && r.user_id === user.id),
            ),
            {
              ...values,
              place_id: place.id,
              user_id: user.id,
              updated_at: new Date().toISOString(),
            },
          ],
        }));
        await onSaved();
        return;
      }
      await api(`/ratings/${place.id}`, "PUT", values);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Ocijeni · ${place.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="form-intro">
          Tvoja ocjena je samo tvoja. Zajednički prosjek računamo automatski.
        </p>
        {categories.map(([key, label]) => (
          <div className="rating-field" key={key}>
            <div>
              <strong>{label}</strong>
              <span>
                {values[key] === null
                  ? "Nismo probali"
                  : formatScore(values[key])}
              </span>
            </div>
            {key === "food" && (
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={values.food === null}
                  onChange={(e) => set("food", e.target.checked ? null : 7)}
                />{" "}
                Nismo probali / nema hrane
              </label>
            )}
            {values[key] !== null && (
              <input
                aria-label={label}
                type="range"
                min="1"
                max="10"
                step="0.5"
                value={values[key] ?? 7}
                onChange={(e) => set(key, Number(e.target.value))}
              />
            )}
          </div>
        ))}
        {error && <div className="form-error">{error}</div>}
        <button className="primary full" disabled={busy}>
          {busy ? "Spremam..." : "Spremi moju ocjenu"}
        </button>
      </form>
    </Modal>
  );
}
function PlaceDetail({
  place,
  data,
  token,
  user,
  onClose,
  onEditPlace,
  onDeletePlace,
  onVisit,
  onEditVisit,
  onRate,
  onRefresh,
}: {
  place: Place;
  data: Data;
  token: string;
  user: User;
  onClose: () => void;
  onEditPlace: () => void;
  onDeletePlace: () => Promise<void>;
  onVisit: () => void;
  onEditVisit: (visit: Visit) => void;
  onRate: () => void;
  onRefresh: (message?: string) => Promise<void>;
}) {
  const ratings = data.ratings.filter((r) => r.place_id === place.id),
    visits = data.visits.filter((v) => v.place_id === place.id);
  const [error, setError] = useState("");
  const removePlace = async () => {
    if (!confirm("Obrisati ovo mjesto, sve posjete i fotografije?")) return;
    try {
      await api(`/places/${place.id}`, "DELETE");
      await onDeletePlace();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  };
  const removeVisit = async (visit: Visit) => {
    if (!confirm("Obrisati ovaj posjet i njegove fotografije?")) return;
    try {
      await api(`/visits/${visit.id}`, "DELETE");
      await onRefresh("Posjet obrisan");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  };
  return (
    <Modal title={place.name} onClose={onClose}>
      <div className="detail-meta">
        <span className="tag">{kindName(place.kind)}</span>
        <span>
          <MapPin size={15} />
          {place.address || place.city || "Lokacija na karti"}
        </span>
      </div>
      <div className="big-rating">
        <div>
          <span>ZAJEDNIČKA OCJENA</span>
          <strong>
            {formatScore(placeAverage(ratings))}
            <small> / 10</small>
          </strong>
          <p>
            {ratings.length < 2
              ? "Privremena ocjena · čeka drugu osobu"
              : "Ocijenili ste oboje"}
          </p>
        </div>
        <Star size={34} fill="currentColor" />
      </div>
      <div className="category-list">
        {categories.map(([key, label]) => (
          <div key={key}>
            <span>{label}</span>
            <strong>{formatScore(ratingAverage(ratings, key))}</strong>
          </div>
        ))}
      </div>
      <div className="people-ratings">
        {data.users.map((u) => {
          const r = ratings.find((x) => x.user_id === u.id);
          return (
            <div key={u.id}>
              <span className="mini-avatar">
                {u.name.slice(0, 1).toUpperCase()}
              </span>
              <span>{u.name}</span>
              <strong>
                {r ? formatScore(placeAverage([r])) : "Čeka ocjenu"}
              </strong>
            </div>
          );
        })}
      </div>
      <div className="detail-actions">
        <button className="primary" onClick={onVisit}>
          <Plus size={18} /> Novi posjet
        </button>
        <button className="secondary" onClick={onRate}>
          <Star size={18} />{" "}
          {ratings.some((r) => r.user_id === user.id)
            ? "Uredi ocjenu"
            : "Ocijeni"}
        </button>
      </div>
      <div className="section-heading detail-heading">
        <h3>Vaši posjeti</h3>
        <span className="count">{visits.length}</span>
      </div>
      {visits.length ? (
        visits.map((v) => (
          <div className="detail-visit" key={v.id}>
            <div>
              <strong>{prettyDate(v.visited_at)}</strong>
              <div className="visit-links">
                <button className="delete-link" onClick={() => onEditVisit(v)}>
                  Uredi
                </button>
                <button
                  className="delete-link"
                  onClick={() => void removeVisit(v)}
                >
                  Obriši
                </button>
              </div>
            </div>
            {v.note && <p>{v.note}</p>}
            {data.photos.some((p) => p.visit_id === v.id) && (
              <div className="photo-grid">
                {data.photos
                  .filter((p) => p.visit_id === v.id)
                  .map((p) => (
                    <PhotoThumb
                      key={p.id}
                      id={p.id}
                      token={token}
                      className="photo-thumb"
                    />
                  ))}
              </div>
            )}
          </div>
        ))
      ) : (
        <Empty text="Još nema zabilježenih posjeta." />
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="place-admin">
        <button onClick={onEditPlace}>Uredi mjesto</button>
        <button onClick={() => void removePlace()}>Obriši mjesto</button>
      </div>
      <div className="map-attribution">
        Podaci o lokacijama:{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          OpenStreetMap
        </a>{" "}
        ·{" "}
        <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">
          Geoapify
        </a>
      </div>
    </Modal>
  );
}
function CalendarView({
  month,
  setMonth,
  data,
  openPlace,
}: {
  month: Date;
  setMonth: (date: Date) => void;
  data: Data;
  openPlace: (p: Place) => void;
}) {
  const [day, setDay] = useState(today());
  const year = month.getFullYear(),
    m = month.getMonth(),
    start = (new Date(year, m, 1).getDay() + 6) % 7,
    days = new Date(year, m + 1, 0).getDate();
  const cells = [
    ...Array(start).fill(null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ] as (number | null)[];
  const dayStr = (d: number) =>
    `${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const visits = data.visits.filter((v) => v.visited_at === day);
  return (
    <>
      <div className="calendar-card">
        <div className="calendar-head">
          <button
            onClick={() => setMonth(new Date(year, m - 1, 1))}
            aria-label="Prethodni mjesec"
          >
            <ChevronLeft />
          </button>
          <strong>
            {new Intl.DateTimeFormat("hr-HR", {
              month: "long",
              year: "numeric",
            }).format(month)}
          </strong>
          <button
            onClick={() => setMonth(new Date(year, m + 1, 1))}
            aria-label="Sljedeći mjesec"
          >
            <ChevronRight />
          </button>
        </div>
        <div className="calendar-grid">
          {["Pon", "Uto", "Sri", "Čet", "Pet", "Sub", "Ned"].map((d) => (
            <span className="weekday" key={d}>
              {d}
            </span>
          ))}
          {cells.map((d, i) =>
            d ? (
              <button
                key={i}
                className={`${day === dayStr(d) ? "selected" : ""} ${data.visits.some((v) => v.visited_at === dayStr(d)) ? "has-visit" : ""}`}
                onClick={() => setDay(dayStr(d))}
              >
                {d}
              </button>
            ) : (
              <span key={i} />
            ),
          )}
        </div>
      </div>
      <section className="section">
        <div className="section-heading">
          <h2>{prettyDate(day)}</h2>
          <span className="count">{visits.length}</span>
        </div>
        {visits.length ? (
          <div className="visit-list">
            {visits.map((v) => {
              const p = data.places.find((x) => x.id === v.place_id);
              return p ? (
                <button
                  className="visit-row"
                  key={v.id}
                  onClick={() => openPlace(p)}
                >
                  <span className="kind-icon">
                    {p.kind === "restaurant" ? (
                      <Utensils size={19} />
                    ) : (
                      <Coffee size={19} />
                    )}
                  </span>
                  <span className="visit-info">
                    <strong>{p.name}</strong>
                    <small>{v.note || p.city || kindName(p.kind)}</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
              ) : null;
            })}
          </div>
        ) : (
          <Empty text="Na ovaj dan nema zabilježenih posjeta." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Svi posjeti</h2>
        </div>
        <div className="visit-list">
          {data.visits.map((v) => {
            const p = data.places.find((x) => x.id === v.place_id);
            return p ? (
              <button
                className="visit-row"
                key={v.id}
                onClick={() => openPlace(p)}
              >
                <span className="date-badge">
                  <strong>{v.visited_at.slice(8, 10)}</strong>
                  <small>
                    {new Intl.DateTimeFormat("hr-HR", {
                      month: "short",
                    }).format(new Date(v.visited_at))}
                  </small>
                </span>
                <span className="visit-info">
                  <strong>{p.name}</strong>
                  <small>{v.note || p.city || kindName(p.kind)}</small>
                </span>
              </button>
            ) : null;
          })}
        </div>
      </section>
    </>
  );
}
function Stats({
  data,
  openPlace,
}: {
  data: Data;
  openPlace: (p: Place) => void;
}) {
  const rated = data.places
    .map((p) => ({
      p,
      ratings: data.ratings.filter((r) => r.place_id === p.id),
    }))
    .filter((x) => x.ratings.length);
  const ranked = [...rated].sort(
    (a, b) => (placeAverage(b.ratings) || 0) - (placeAverage(a.ratings) || 0),
  );
  const repeated = data.places.filter(
    (p) => data.visits.filter((v) => v.place_id === p.id).length > 1,
  ).length;
  const agreement = [...rated]
    .filter((x) => x.ratings.length === 2)
    .map((x) => ({
      ...x,
      difference: Math.abs(
        (placeAverage([x.ratings[0]]) || 0) -
          (placeAverage([x.ratings[1]]) || 0),
      ),
    }))
    .sort((a, b) => b.difference - a.difference);
  const byMonth = Object.entries(
    data.visits.reduce<Record<string, number>>((acc, v) => {
      const key = v.visited_at.slice(0, 7);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6);
  const mostVisited = [...data.places]
    .map((p) => ({
      p,
      count: data.visits.filter((v) => v.place_id === p.id).length,
    }))
    .filter((x) => x.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  const newByMonth = Object.entries(
    data.places.reduce<Record<string, number>>((acc, p) => {
      const key = p.created_at.slice(0, 7);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6);
  const cities = Object.entries(
    data.places.reduce<Record<string, number>>((acc, p) => {
      if (p.city) acc[p.city] = (acc[p.city] || 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  return (
    <>
      <div className="page-title">
        <span className="eyebrow">BROJKE S PRIČOM</span>
        <h1>
          Naša statistika<span className="dot">.</span>
        </h1>
        <p>Malo brojki o svim vašim izlascima.</p>
      </div>
      <div className="stat-grid">
        <div>
          <span>Ukupno posjeta</span>
          <strong>{data.visits.length}</strong>
        </div>
        <div>
          <span>Različitih mjesta</span>
          <strong>{data.places.length}</strong>
        </div>
        <div>
          <span>Gradova</span>
          <strong>
            {new Set(data.places.map((p) => p.city).filter(Boolean)).size}
          </strong>
        </div>
        <div>
          <span>Povrataka</span>
          <strong>{repeated}</strong>
        </div>
      </div>
      <section className="section">
        <div className="section-heading">
          <h2>Najbolje ocijenjena</h2>
        </div>
        {ranked.length ? (
          ranked.slice(0, 5).map((x, i) => (
            <button
              className="rank-row"
              key={x.p.id}
              onClick={() => openPlace(x.p)}
            >
              <span className="rank">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <strong>{x.p.name}</strong>
                <small>{x.ratings.length}/2 ocjene</small>
              </span>
              <b>{formatScore(placeAverage(x.ratings))}</b>
            </button>
          ))
        ) : (
          <Empty text="Ocijenite prvo mjesto pa će se ovdje pojaviti." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Najveće neslaganje</h2>
        </div>
        {agreement.length ? (
          agreement.slice(0, 3).map((x) => (
            <button
              className="rank-row"
              key={x.p.id}
              onClick={() => openPlace(x.p)}
            >
              <span className="rank">↔</span>
              <span>
                <strong>{x.p.name}</strong>
                <small>Razlika u ukupnoj ocjeni</small>
              </span>
              <b>{formatScore(x.difference)}</b>
            </button>
          ))
        ) : (
          <Empty text="Ovo postaje zanimljivo kad oboje ocijenite ista mjesta." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Posjeti po mjesecima</h2>
        </div>
        {byMonth.length ? (
          <div className="month-bars">
            {byMonth.map(([key, value]) => (
              <div key={key}>
                <span>
                  {new Intl.DateTimeFormat("hr-HR", {
                    month: "short",
                    year: "numeric",
                  }).format(new Date(`${key}-01`))}
                </span>
                <div>
                  <i
                    style={{
                      width: `${(value / Math.max(...byMonth.map((x) => x[1]))) * 100}%`,
                    }}
                  />
                </div>
                <b>{value}</b>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="Prvi izlazak pokrenut će statistiku." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Najčešći povratci</h2>
        </div>
        {mostVisited.length ? (
          mostVisited.map((x) => (
            <button
              className="rank-row"
              key={x.p.id}
              onClick={() => openPlace(x.p)}
            >
              <span className="rank">↺</span>
              <span>
                <strong>{x.p.name}</strong>
                <small>{x.p.city || kindName(x.p.kind)}</small>
              </span>
              <b>{x.count}×</b>
            </button>
          ))
        ) : (
          <Empty text="Kad se vratite na omiljeno mjesto, vidjet će se ovdje." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Nova mjesta po mjesecima</h2>
        </div>
        {newByMonth.length ? (
          <div className="month-bars">
            {newByMonth.map(([key, value]) => (
              <div key={key}>
                <span>
                  {new Intl.DateTimeFormat("hr-HR", {
                    month: "short",
                    year: "numeric",
                  }).format(new Date(`${key}-01`))}
                </span>
                <div>
                  <i
                    style={{
                      width: `${(value / Math.max(...newByMonth.map((x) => x[1]))) * 100}%`,
                    }}
                  />
                </div>
                <b>{value}</b>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="Dodajte prvo mjesto." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Gradovi koje istražujete</h2>
        </div>
        {cities.length ? (
          cities.map(([city, count]) => (
            <div className="category-winner" key={city}>
              <span>Grad</span>
              <strong>{city}</strong>
              <b>{count}</b>
            </div>
          ))
        ) : (
          <Empty text="Gradovi će se pojaviti nakon prvog posjeta." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Najbolje po kategoriji</h2>
        </div>
        {categories.map(([key, label]) => {
          const top = [...rated]
            .filter((x) => ratingAverage(x.ratings, key) !== null)
            .sort(
              (a, b) =>
                (ratingAverage(b.ratings, key) || 0) -
                (ratingAverage(a.ratings, key) || 0),
            )[0];
          return top ? (
            <button
              className="category-winner"
              key={key}
              onClick={() => openPlace(top.p)}
            >
              <span>{label}</span>
              <strong>{top.p.name}</strong>
              <b>{formatScore(ratingAverage(top.ratings, key))}</b>
            </button>
          ) : null;
        })}
      </section>
    </>
  );
}
export default App;
