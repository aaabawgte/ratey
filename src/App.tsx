import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
  Moon,
  Sun,
  ArrowLeftRight,
  RotateCcw,
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
type LocationSuggestion = {
  address: string;
  city: string;
  detail: string;
  lat: number;
  lng: number;
};
const center: [number, number] = [45.815, 15.982];
const noPlaces: Place[] = [];
// Zadnji pritisnuti gumb: polazište za morph prijelaze (View Transitions).
let lastPressed: HTMLElement | null = null;
let sheetOrigin: HTMLElement | null = null;
document.addEventListener(
  "click",
  (e) => {
    lastPressed =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>("button")
        : null;
  },
  true,
);
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canMorph = () =>
  typeof document.startViewTransition === "function" && !reducedMotion();
// Promjenu stanja izvodi kao prijelaz. "open" širi pritisnuti redak u ploču,
// "close" je skuplja natrag u isti redak (ili u gumb + ako retka više nema).
function morph(update: () => void, mode?: "open" | "close") {
  if (!canMorph()) return update();
  const root = document.documentElement;
  const candidate =
    mode === "open"
      ? lastPressed?.closest<HTMLElement>(".row, .peek")
      : mode === "close"
        ? sheetOrigin
        : null;
  const row = candidate?.isConnected ? candidate : null;
  if (mode === "open") {
    sheetOrigin = row;
    if (row) {
      root.classList.add("morph-row");
      row.style.viewTransitionName = "sheet";
    }
  }
  const transition = document.startViewTransition(() => {
    if (mode === "open" && row) row.style.viewTransitionName = "";
    flushSync(update);
    if (mode === "close") {
      sheetOrigin = null;
      if (row?.isConnected && !document.querySelector(".sheet")) {
        root.classList.add("morph-row");
        row.style.viewTransitionName = "sheet";
      }
    }
  });
  void transition.finished.finally(() => {
    root.classList.remove("morph-row");
    if (row) row.style.viewTransitionName = "";
  });
}
// Promjena teme otkriva se krugom iz pritisnutog gumba.
function themeMorph(update: () => void) {
  if (!canMorph()) return update();
  const root = document.documentElement;
  const rect = lastPressed?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : 0;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  root.classList.add("theme-morph");
  const transition = document.startViewTransition(() => flushSync(update));
  void transition.ready
    .then(() =>
      root.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${radius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 560,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      ),
    )
    .catch(() => {});
  void transition.finished.finally(() => root.classList.remove("theme-morph"));
}
const kindName = (kind: Place["kind"]) =>
  kind === "restaurant" ? "Restoran" : "Kafić";
async function preparePhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    let scale = Math.min(
      1,
      1600 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Fotografiju nije moguće obraditi");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.78 - attempt * 0.06),
      );
      if (blob && blob.size <= 1_400_000) return blob;
      scale *= 0.8;
    }
    throw new Error("Fotografija je prevelika i nakon smanjivanja");
  } catch {
    throw new Error(
      `Ne mogu otvoriti fotografiju ${file.name}. Odaberi JPEG ili PNG.`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
function MapCanvas({
  places,
  token,
  onSelect,
  pick,
  picked,
  activeId,
}: {
  places: Place[];
  token: string;
  onSelect?: (place: Place) => void;
  pick?: (lat: number, lng: number) => void;
  picked?: [number, number];
  activeId?: string;
}) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  });
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
    const resize = setTimeout(() => instance.invalidateSize(), 100);
    return () => {
      clearTimeout(resize);
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
    places.forEach((place, index) => {
      const marker = document.createElement("div");
      marker.className = "pin-marker";
      marker.dataset.id = place.id;
      const symbol = document.createElement("span");
      symbol.className = `pin ${place.kind}`;
      const label = document.createElement("span");
      label.className = "pin-label";
      if (
        places
          .slice(0, index)
          .some(
            (other) =>
              L.latLng(other.lat, other.lng).distanceTo([
                place.lat,
                place.lng,
              ]) < 1800,
          )
      ) {
        label.classList.add("pin-label-side");
      }
      label.textContent = place.name;
      marker.append(symbol, label);
      const icon = L.divIcon({
        className: "pin-wrap",
        html: marker,
        iconSize: [38, 44],
        iconAnchor: [19, 38],
      });
      const tooltip = document.createElement("span");
      tooltip.textContent = `${place.name}${place.address ? ` · ${place.address}` : ""}`;
      L.marker([place.lat, place.lng], { icon })
        .bindTooltip(tooltip)
        .addTo(group)
        .on("click", () => {
          instance.panTo([place.lat, place.lng]);
          select.current?.(place);
        });
    });
    if (picked)
      L.marker(picked, {
        icon: L.divIcon({
          className: "pin-wrap",
          html: '<span class="pin picked"></span>',
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
  }, [places, picked]);
  useEffect(() => {
    node.current
      ?.querySelectorAll<HTMLElement>(".pin-marker")
      .forEach((el) =>
        el.classList.toggle("active", el.dataset.id === activeId),
      );
  }, [activeId, places]);
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
  const [ratingVisit, setRatingVisit] = useState<Visit | null>(null);
  const [themeChoice, setThemeChoice] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("ratey_theme") as "light" | "dark") || "system",
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const dark = themeChoice === "system" ? systemDark : themeChoice === "dark";
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#0e0e0d" : "#f5f4f1");
  }, [dark]);
  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    localStorage.setItem("ratey_theme", next);
    themeMorph(() => {
      document.documentElement.dataset.theme = next;
      setThemeChoice(next);
    });
  };
  const [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const updateSW = useRef<((reloadPage?: boolean) => Promise<void>) | null>(
    null,
  );
  const screenRef = useRef(screen);
  const pendingUpdate = useRef(false);
  const applyPendingUpdate = useCallback(() => {
    if (screenRef.current || !pendingUpdate.current || !updateSW.current)
      return;
    pendingUpdate.current = false;
    void updateSW.current(true).catch(() => {
      pendingUpdate.current = true;
    });
  }, []);
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
    const onVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void flushQueue().then(refresh);
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  useEffect(() => {
    screenRef.current = screen;
    applyPendingUpdate();
  }, [screen, applyPendingUpdate]);
  useEffect(() => {
    updateSW.current = registerSW({
      immediate: true,
      onNeedRefresh: () => {
        pendingUpdate.current = true;
        applyPendingUpdate();
      },
      onRegisteredSW: (_url, registration) => {
        if (navigator.onLine) void registration?.update().catch(() => {});
      },
      onOfflineReady: () => setNotice("Aplikacija je spremna za rad bez veze"),
    });
    applyPendingUpdate();
    const checkForUpdate = () => {
      if (!navigator.onLine || document.visibilityState === "hidden") return;
      applyPendingUpdate();
      void navigator.serviceWorker
        ?.getRegistration()
        .then((registration) => registration?.update())
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };
    window.addEventListener("pageshow", checkForUpdate);
    window.addEventListener("focus", checkForUpdate);
    window.addEventListener("online", checkForUpdate);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", checkForUpdate);
      window.removeEventListener("focus", checkForUpdate);
      window.removeEventListener("online", checkForUpdate);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyPendingUpdate]);
  const ratingsFor = (id: string) =>
    data.ratings.filter((r) => r.place_id === id);
  const visitRatingsFor = (id: string) =>
    data.ratings.filter((r) => r.visit_id === id);
  const visitsFor = (id: string) =>
    data.visits.filter((v) => v.place_id === id);
  const pending = data.visits.filter(
    (v) =>
      !data.ratings.some((r) => r.visit_id === v.id && r.user_id === user?.id),
  );
  const filtered = useMemo(
    () =>
      data.places.filter(
        (p) =>
          (filter === "all" || p.kind === filter) &&
          `${p.name} ${p.city}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [data.places, filter, search],
  );
  const [peekId, setPeekId] = useState<string | null>(null);
  const peek = filtered.find((p) => p.id === peekId);
  const openPlace = (p: Place) =>
    morph(() => {
      setSelected(p);
      setRatingVisit(null);
      setScreen(null);
    }, "open");
  const close = () =>
    morph(() => {
      setSelected(null);
      setScreen(null);
      setEditingVisit(null);
      setRatingVisit(null);
    }, "close");
  // Kartice se mijenjaju bez View Transition: sadržaj ulazi CSS animacijom.
  const goTab = (next: Tab) => {
    setPeekId(null);
    setTab(next);
    setSelected(null);
    setScreen(null);
    setRatingVisit(null);
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
        dark={dark}
        onToggleTheme={toggleTheme}
        onLogin={(t, u) => {
          localStorage.setItem("ratey_token", t);
          localStorage.setItem("ratey_user", JSON.stringify(u));
          setToken(t);
          setUser(u);
        }}
      />
    );
  return (
    <div className="app">
      <header className="masthead">
        <span className="wordmark">
          ratey<i>.</i>
        </span>
        <div className="masthead-actions">
          {offline && (
            <span className="offline-pill">
              <WifiOff size={14} /> Offline
            </span>
          )}
          <button
            className="icon-button"
            onClick={toggleTheme}
            aria-label={dark ? "Uključi svijetli način" : "Uključi tamni način"}
            title={dark ? "Svijetli način" : "Tamni način"}
          >
            {dark ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <button
            className="avatar"
            onClick={logout}
            title="Odjavi se"
            aria-label="Odjavi se"
          >
            <span>{user.name.slice(0, 1).toUpperCase()}</span>
            <LogOut size={15} />
          </button>
        </div>
      </header>
      <main>
        {tab === "home" && (
          <>
            <section className="intro">
              <p className="kicker">
                {new Intl.DateTimeFormat("hr-HR", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  timeZone: "UTC",
                }).format(new Date(`${today()}T12:00:00Z`))}
              </p>
              <h1>
                Bok, {user.name}
                <span className="dot">.</span>
              </h1>
            </section>
            <dl className="figures">
              <div>
                <dt>mjesta</dt>
                <dd>
                  <CountUp value={data.places.length} />
                </dd>
              </div>
              <div>
                <dt>posjeta</dt>
                <dd>
                  <CountUp value={data.visits.length} />
                </dd>
              </div>
              <div>
                <dt>gradova</dt>
                <dd>
                  <CountUp
                    value={
                      new Set(data.places.map((p) => p.city).filter(Boolean))
                        .size
                    }
                  />
                </dd>
              </div>
            </dl>
            {pending.length > 0 && (
              <section className="section todo">
                <div className="section-heading">
                  <h2>Čekaju tvoju ocjenu</h2>
                  <span className="count">{pending.length}</span>
                </div>
                <div className="rows">
                  {pending.map((v) => {
                    const p = data.places.find(
                      (place) => place.id === v.place_id,
                    );
                    return p ? (
                      <button
                        key={v.id}
                        className="row"
                        onClick={() =>
                          morph(() => {
                            setSelected(p);
                            setRatingVisit(v);
                            setScreen("rating");
                          }, "open")
                        }
                      >
                        <KindIcon kind={p.kind} />
                        <span className="row-main">
                          <strong>{p.name}</strong>
                          <small>{prettyDate(v.visited_at)}</small>
                        </span>
                        <span className="row-action">Ocijeni</span>
                      </button>
                    ) : null;
                  })}
                </div>
              </section>
            )}
            <section className="section">
              <div className="section-heading">
                <h2>Zadnji posjeti</h2>
                <button
                  className="text-button"
                  onClick={() => goTab("calendar")}
                >
                  Vidi sve <ChevronRight size={16} />
                </button>
              </div>
              {data.visits.length ? (
                <div className="rows">
                  {data.visits.slice(0, 5).map((v) => {
                    const p = data.places.find((x) => x.id === v.place_id);
                    return p ? (
                      <button
                        className="row"
                        key={v.id}
                        onClick={() => openPlace(p)}
                      >
                        <DateLead day={v.visited_at} />
                        <span className="row-main">
                          <strong>{p.name}</strong>
                          <small>{p.city || kindName(p.kind)}</small>
                        </span>
                        <span className="row-trail score">
                          <Star size={13} fill="currentColor" />
                          {formatScore(placeAverage(visitRatingsFor(v.id)))}
                        </span>
                      </button>
                    ) : null;
                  })}
                </div>
              ) : (
                <Empty text="Još nema posjeta. Dodaj prvo mjesto gumbom + dolje." />
              )}
            </section>
          </>
        )}
        {tab === "map" && (
          <div className="map-screen">
            <div className="map-stage">
              <MapCanvas
                places={filtered}
                token={token}
                onSelect={(p) => morph(() => setPeekId(p.id))}
                pick={peek ? () => morph(() => setPeekId(null)) : undefined}
                activeId={peek?.id}
              />
            </div>
            <div className="map-drawer">
              <div className="drawer-head">
                <h1>
                  Karta<span className="dot">.</span>
                </h1>
                <span className="count">{filtered.length}</span>
              </div>
              <div className="search-line">
                <Search size={18} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Traži mjesto ili grad..."
                  aria-label="Traži mjesto ili grad"
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
              {filtered.length ? (
                <div className="rows">
                  {filtered.map((p) => (
                    <PlaceRow
                      key={p.id}
                      place={p}
                      ratings={ratingsFor(p.id)}
                      visits={visitsFor(p.id)}
                      onClick={() => openPlace(p)}
                    />
                  ))}
                </div>
              ) : (
                <Empty text="Nema mjesta za ovu pretragu." />
              )}
            </div>
          </div>
        )}
        {tab === "calendar" && (
          <>
            <div className="page-title">
              <h1>
                Kalendar<span className="dot">.</span>
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
      <nav className="dock" aria-label="Glavni izbornik">
        {(
          [
            ["home", House, "Početna"],
            ["map", MapPin, "Karta"],
            ["add", Plus, "Dodaj novo mjesto"],
            ["calendar", CalendarDays, "Kalendar"],
            ["stats", ChartNoAxesColumn, "Statistika"],
          ] as const
        ).map(([key, Icon, label]) =>
          key === "add" ? (
            <button
              className="dock-add"
              key={key}
              aria-label={label}
              title={label}
              onClick={() =>
                morph(() => {
                  setSelected(null);
                  setRatingVisit(null);
                  setScreen("place");
                })
              }
            >
              <Icon size={22} />
            </button>
          ) : (
            <button
              className={tab === key ? "dock-item active" : "dock-item"}
              key={key}
              title={label}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => goTab(key)}
            >
              <Icon size={21} strokeWidth={tab === key ? 2.3 : 1.8} />
              <span>{label}</span>
            </button>
          ),
        )}
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
            if (p)
              morph(() => {
                setSelected(p);
                setScreen("visit");
              });
            else close();
          }}
          token={token}
        />
      )}
      {selected && screen === "editPlace" && (
        <PlaceForm
          place={selected}
          user={user}
          token={token}
          onClose={() => morph(() => setScreen(null))}
          onSaved={async (id) => {
            await saved("Mjesto ažurirano");
            const p = (
              navigator.onLine
                ? await api<Data>("/data")
                : (JSON.parse(
                    localStorage.getItem("ratey_data") || "{}",
                  ) as Data)
            ).places.find((p) => p.id === id);
            morph(() => {
              if (p) setSelected(p);
              setScreen(null);
            });
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
          onEditPlace={() => morph(() => setScreen("editPlace"))}
          onDeletePlace={async () => {
            await saved("Mjesto obrisano");
            close();
          }}
          onVisit={() =>
            morph(() => {
              setEditingVisit(null);
              setScreen("visit");
            })
          }
          onEditVisit={(v) =>
            morph(() => {
              setEditingVisit(v);
              setScreen("visit");
            })
          }
          onRate={(v) =>
            morph(() => {
              setRatingVisit(v);
              setScreen("rating");
            })
          }
          onRefresh={saved}
        />
      )}
      {selected && screen === "visit" && (
        <VisitForm
          place={selected}
          user={user}
          token={token}
          visit={editingVisit}
          onClose={() =>
            morph(() => {
              setScreen(null);
              setEditingVisit(null);
            })
          }
          onSaved={async (v, isNew) => {
            await saved("Posjet spremljen!");
            morph(() => {
              setRatingVisit(isNew ? v : null);
              setScreen(isNew ? "rating" : null);
              setEditingVisit(null);
            });
          }}
        />
      )}
      {selected && ratingVisit && screen === "rating" && (
        <RatingForm
          place={selected}
          visit={ratingVisit}
          user={user}
          current={data.ratings.find(
            (r) => r.visit_id === ratingVisit.id && r.user_id === user.id,
          )}
          onClose={() =>
            morph(() => {
              setScreen(null);
              setRatingVisit(null);
            })
          }
          onSaved={async () => {
            await saved("Ocjena spremljena!");
            morph(() => {
              setScreen(null);
              setRatingVisit(null);
            });
          }}
        />
      )}
      {tab === "map" && peek && (
        <div className="peek">
          <button className="peek-main" onClick={() => openPlace(peek)}>
            <KindIcon kind={peek.kind} />
            <span className="row-main">
              <strong>{peek.name}</strong>
              <small>
                {peek.city || peek.address || kindName(peek.kind)} ·{" "}
                {visitsFor(peek.id).length} posjet(a)
              </small>
            </span>
            <span className="row-trail score">
              <Star size={13} fill="currentColor" />
              {formatScore(placeAverage(ratingsFor(peek.id)))}
            </span>
          </button>
          <button
            className="icon-button"
            aria-label="Zatvori pregled"
            onClick={() => morph(() => setPeekId(null))}
          >
            <X size={18} />
          </button>
        </div>
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
    </div>
  );
}
function Login({
  onLogin,
  dark,
  onToggleTheme,
}: {
  onLogin: (token: string, user: User) => void;
  dark: boolean;
  onToggleTheme: () => void;
}) {
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
    <div className="auth">
      <button
        className="icon-button auth-theme-toggle"
        onClick={onToggleTheme}
        aria-label={dark ? "Uključi svijetli način" : "Uključi tamni način"}
        title={dark ? "Svijetli način" : "Tamni način"}
      >
        {dark ? <Sun size={19} /> : <Moon size={19} />}
      </button>
      <div className="auth-card">
        <span className="wordmark wordmark-lg">
          ratey<i>.</i>
        </span>
        <h1>
          {register ? "Kreiraj svoj račun." : "Nastavimo tamo gdje smo stali."}
        </h1>
        <p className="lede">Vaša privatna karta izlazaka čeka.</p>
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
              minLength={register ? 6 : undefined}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Najmanje 6 znakova"
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
      <p>{text}</p>
    </div>
  );
}
function KindIcon({ kind }: { kind: Place["kind"] }) {
  return (
    <span className="row-lead kind-icon">
      {kind === "restaurant" ? <Utensils size={18} /> : <Coffee size={18} />}
    </span>
  );
}
function DateLead({ day }: { day: string }) {
  return (
    <span className="row-lead date-lead">
      <strong>{day.slice(8, 10)}</strong>
      <small>
        {new Intl.DateTimeFormat("hr-HR", { month: "short" }).format(
          new Date(day),
        )}
      </small>
    </span>
  );
}
function Bars({ items }: { items: [string, number][] }) {
  const max = Math.max(...items.map((x) => x[1]));
  return (
    <div className="bars">
      {items.map(([key, value]) => (
        <div key={key}>
          <span>
            {new Intl.DateTimeFormat("hr-HR", {
              month: "short",
              year: "numeric",
            }).format(new Date(`${key}-01`))}
          </span>
          <div>
            <i style={{ width: `${(value / max) * 100}%` }} />
          </div>
          <b>{value}</b>
        </div>
      ))}
    </div>
  );
}
function PlaceRow({
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
    <button className="row" onClick={onClick}>
      <KindIcon kind={place.kind} />
      <span className="row-main">
        <strong>{place.name}</strong>
        <small>
          {place.city || place.address || kindName(place.kind)} ·{" "}
          {visits.length} posjet(a)
        </small>
      </span>
      <span className="row-trail score">
        <Star size={13} fill="currentColor" />
        {formatScore(placeAverage(ratings))}
      </span>
    </button>
  );
}
// Broj se odbrojava do vrijednosti nakon što završi ulazni prijelaz.
function CountUp({ value, score }: { value: number | null; score?: boolean }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (value === null || reducedMotion()) return;
    const begin = performance.now() + 320;
    const start = from.current;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, Math.max(0, (now - begin) / 750));
      const current = start + (value - start) * (1 - Math.pow(1 - t, 4));
      from.current = current;
      setShown(t === 1 ? value : current);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  if (value === null) return "—";
  const n = reducedMotion() ? value : shown;
  if (!score) return Math.round(n);
  return n === value
    ? formatScore(value)
    : n.toLocaleString("hr-HR", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
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
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; time: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Povlačenje zaglavlja prema dolje zatvara ploču.
  const endDrag = (e: React.PointerEvent) => {
    const start = drag.current;
    const el = sheet.current;
    drag.current = null;
    if (!start || !el) return;
    const distance = Math.max(0, e.clientY - start.y);
    const speed = distance / Math.max(1, e.timeStamp - start.time);
    if (distance > 110 || (distance > 30 && speed > 0.6)) return onClose();
    el.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)";
    el.style.transform = "";
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheet}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          className="sheet-grip"
          onPointerDown={(e) => {
            if ((e.target as Element).closest("button") || !sheet.current)
              return;
            drag.current = { y: e.clientY, time: e.timeStamp };
            e.currentTarget.setPointerCapture(e.pointerId);
            sheet.current.style.transition = "none";
          }}
          onPointerMove={(e) => {
            if (drag.current && sheet.current)
              sheet.current.style.transform = `translateY(${Math.max(0, e.clientY - drag.current.y)}px)`;
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
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
    [query, setQuery] = useState(""),
    [results, setResults] = useState<LocationSuggestion[]>([]),
    [addressStatus, setAddressStatus] = useState<
      "idle" | "loading" | "ready" | "missing"
    >(place ? "ready" : "idle"),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const lookupId = useRef(0);
  useEffect(() => {
    if (query.trim().length < 3 || !navigator.onLine) return;
    let active = true;
    const id = setTimeout(() => {
      void api<{ results: LocationSuggestion[] }>(
        `/locations/search?q=${encodeURIComponent(query.trim())}`,
        "GET",
        undefined,
        token,
      )
        .then((r) => {
          if (active) setResults(r.results);
        })
        .catch(() => {
          if (active) setResults([]);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, [query, token]);
  const select = (r: LocationSuggestion) => {
    lookupId.current += 1;
    setAddress(r.address);
    setCity(r.city);
    setCoords([Number(r.lat), Number(r.lng)]);
    setAddressStatus(r.address ? "ready" : "missing");
    setQuery("");
    setResults([]);
    setError("");
  };
  const pickLocation = (lat: number, lng: number) => {
    const id = ++lookupId.current;
    setCoords([lat, lng]);
    setAddress("");
    setCity("");
    setResults([]);
    setQuery("");
    setError("");
    if (!navigator.onLine) {
      setAddressStatus("missing");
      return;
    }
    setAddressStatus("loading");
    void api<{ address: string; city: string }>(
      `/locations/reverse?lat=${lat}&lng=${lng}`,
      "GET",
      undefined,
      token,
    )
      .then((result) => {
        if (id !== lookupId.current) return;
        setAddress(result.address);
        setCity(result.city);
        setAddressStatus(result.address ? "ready" : "missing");
      })
      .catch(() => {
        if (id === lookupId.current) setAddressStatus("missing");
      });
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!coords) {
      setError("Odaberi adresu pretragom ili postavi pin na karti");
      return;
    }
    if (addressStatus === "loading") return;
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
          source_id: null,
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
          source_id: null,
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
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Npr. Naš omiljeni Batak"
          />
        </label>
        <div className="field-label">
          <strong>Adresa na karti</strong>
          <span>Potraži ulicu ili grad pa dodirni točno mjesto na karti.</span>
        </div>
        <div className="field-icon">
          <Search size={18} />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setResults([]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (results[0]) select(results[0]);
              }
            }}
            placeholder="Traži adresu ili grad..."
            aria-label="Traži adresu ili grad"
          />
        </div>
        {results.length > 0 && (
          <div className="suggestions">
            {results.map((r, i) => (
              <button type="button" key={i} onClick={() => select(r)}>
                <MapPin size={16} />
                <span>
                  <strong>{r.address}</strong>
                  {r.detail && <small>{r.detail}</small>}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="pick-map">
          <MapCanvas
            places={noPlaces}
            token={token}
            picked={coords || undefined}
            pick={pickLocation}
          />
        </div>
        <button
          type="button"
          className="locate-button"
          onClick={() => {
            navigator.geolocation.getCurrentPosition(
              (pos) => pickLocation(pos.coords.latitude, pos.coords.longitude),
              () => setError("Lokacija nije dostupna"),
            );
          }}
        >
          <Navigation size={17} /> Pronađi moju lokaciju
        </button>
        <div className="chosen-address" aria-live="polite">
          <MapPin size={17} />
          <span>
            <strong>
              {addressStatus === "loading"
                ? "Tražim adresu..."
                : address ||
                  (coords ? "Pin je postavljen" : "Odaberi lokaciju")}
            </strong>
            <small>
              {addressStatus === "missing" && coords
                ? "Nema točne adrese za ovu točku, ali pin će biti spremljen."
                : city ||
                  (coords
                    ? "Dodirni kartu za promjenu pina."
                    : "Dodirni kartu ili potraži adresu.")}
            </small>
          </span>
        </div>
        {error && <div className="form-error">{error}</div>}
        <button
          className="primary full"
          disabled={loading || addressStatus === "loading"}
        >
          {loading ? "Spremam..." : place ? "Spremi promjene" : "Dodaj mjesto"}
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
  onSaved: (visit: Visit, isNew: boolean) => Promise<void>;
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
        await onSaved(
          {
            id,
            place_id: place.id,
            user_id: user.id,
            visited_at: date,
            note,
            created_at: visit?.created_at || new Date().toISOString(),
          },
          !visit,
        );
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
        const photo = await preparePhoto(file);
        const response = await fetch(`${apiBase}/visits/${id}/photos`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": photo.type,
          },
          body: photo,
        });
        if (!response.ok)
          throw new Error(
            "Posjet je spremljen, ali jedna fotografija nije. Pokušaj je dodati ponovno.",
          );
      }
      await onSaved(
        {
          id,
          place_id: place.id,
          user_id: user.id,
          visited_at: date,
          note,
          created_at: visit?.created_at || new Date().toISOString(),
        },
        !visit,
      );
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
          <small>Neobavezno · fotke se automatski smanjuju</small>
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
  visit,
  user,
  current,
  onClose,
  onSaved,
}: {
  place: Place;
  visit: Visit;
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
          path: `/visits/${visit.id}/ratings`,
          method: "PUT",
          payload: values,
        });
        updateCached((d) => ({
          ...d,
          ratings: [
            ...d.ratings.filter(
              (r) => !(r.visit_id === visit.id && r.user_id === user.id),
            ),
            {
              ...values,
              place_id: place.id,
              visit_id: visit.id,
              user_id: user.id,
              updated_at: new Date().toISOString(),
            },
          ],
        }));
        await onSaved();
        return;
      }
      await api(`/visits/${visit.id}/ratings`, "PUT", values);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Ocijeni posjet · ${place.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="form-intro">
          {prettyDate(visit.visited_at)} · Tvoja ocjena je samo tvoja.
          Zajednički prosjek računamo automatski.
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
  onRate: (visit: Visit) => void;
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
      <div className="place-hero">
        <div className="place-score">
          <strong>
            <CountUp value={placeAverage(ratings)} score />
          </strong>
          <span>/ 10</span>
        </div>
        <div className="place-meta">
          <span className="tag">{kindName(place.kind)}</span>
          <span>
            <MapPin size={14} />
            {place.address || place.city || "Lokacija na karti"}
          </span>
        </div>
        <p className="place-note">
          {ratings.length
            ? `${ratings.length} ocjena kroz ${new Set(ratings.map((r) => r.visit_id)).size} posjeta`
            : "Još nema ocjena"}
        </p>
      </div>
      <div className="score-bars">
        {categories.map(([key, label]) => {
          const value = ratingAverage(ratings, key);
          return (
            <div key={key}>
              <span>{label}</span>
              <div>
                <i style={{ width: `${(value ?? 0) * 10}%` }} />
              </div>
              <b>{formatScore(value)}</b>
            </div>
          );
        })}
      </div>
      <div className="duo">
        {data.users.map((u) => {
          const personRatings = ratings.filter((x) => x.user_id === u.id);
          return (
            <div key={u.id}>
              <span className="mini-avatar">
                {u.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="duo-name">{u.name}</span>
              <strong>
                {personRatings.length
                  ? formatScore(placeAverage(personRatings))
                  : "—"}
              </strong>
              {!personRatings.length && <small>Čeka ocjenu</small>}
            </div>
          );
        })}
      </div>
      <button className="primary full" onClick={onVisit}>
        <Plus size={18} /> Novi posjet
      </button>
      <div className="section-heading detail-heading">
        <h3>Vaši posjeti</h3>
        <span className="count">{visits.length}</span>
      </div>
      {visits.length ? (
        <div className="entries">
          {visits.map((v) => {
            const visitRatings = ratings.filter((r) => r.visit_id === v.id);
            const mine = visitRatings.some((r) => r.user_id === user.id);
            const photos = data.photos.filter((p) => p.visit_id === v.id);
            return (
              <article className="entry" key={v.id}>
                <header>
                  <strong>{prettyDate(v.visited_at)}</strong>
                  <span className="entry-score">
                    <Star size={13} fill="currentColor" />
                    {formatScore(placeAverage(visitRatings))}
                    <small>· {visitRatings.length}/2 ocjene</small>
                  </span>
                </header>
                {v.note && <p>{v.note}</p>}
                {photos.length > 0 && (
                  <div className="photo-grid">
                    {photos.map((p) => (
                      <PhotoThumb
                        key={p.id}
                        id={p.id}
                        token={token}
                        className="photo-thumb"
                      />
                    ))}
                  </div>
                )}
                <footer>
                  <button className="secondary" onClick={() => onRate(v)}>
                    {mine ? "Uredi moju ocjenu" : "Ocijeni posjet"}
                  </button>
                  <button
                    className="link-button"
                    onClick={() => onEditVisit(v)}
                  >
                    Uredi
                  </button>
                  <button
                    className="link-button danger"
                    onClick={() => void removeVisit(v)}
                  >
                    Obriši
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty text="Još nema zabilježenih posjeta." />
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="place-admin">
        <button className="link-button" onClick={onEditPlace}>
          Uredi mjesto
        </button>
        <button
          className="link-button danger"
          onClick={() => void removePlace()}
        >
          Obriši mjesto
        </button>
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
      <div className="calendar">
        <div className="calendar-head">
          <strong>
            {new Intl.DateTimeFormat("hr-HR", {
              month: "long",
              year: "numeric",
            }).format(month)}
          </strong>
          <div>
            <button
              className="icon-button"
              onClick={() => setMonth(new Date(year, m - 1, 1))}
              aria-label="Prethodni mjesec"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              className="icon-button"
              onClick={() => setMonth(new Date(year, m + 1, 1))}
              aria-label="Sljedeći mjesec"
            >
              <ChevronRight size={20} />
            </button>
          </div>
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
          <div className="rows">
            {visits.map((v) => {
              const p = data.places.find((x) => x.id === v.place_id);
              return p ? (
                <button className="row" key={v.id} onClick={() => openPlace(p)}>
                  <KindIcon kind={p.kind} />
                  <span className="row-main">
                    <strong>{p.name}</strong>
                    <small>{v.note || p.city || kindName(p.kind)}</small>
                  </span>
                  <ChevronRight className="row-trail" size={18} />
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
          <span className="count">{data.visits.length}</span>
        </div>
        {data.visits.length ? (
          <div className="rows">
            {data.visits.map((v) => {
              const p = data.places.find((x) => x.id === v.place_id);
              return p ? (
                <button className="row" key={v.id} onClick={() => openPlace(p)}>
                  <DateLead day={v.visited_at} />
                  <span className="row-main">
                    <strong>{p.name}</strong>
                    <small>{v.note || p.city || kindName(p.kind)}</small>
                  </span>
                </button>
              ) : null;
            })}
          </div>
        ) : (
          <Empty text="Još nema posjeta." />
        )}
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
  const agreement = data.visits
    .map((visit) => ({
      visit,
      p: data.places.find((place) => place.id === visit.place_id),
      ratings: data.ratings.filter((r) => r.visit_id === visit.id),
    }))
    .filter((x) => x.p && x.ratings.length === 2)
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
        <h1>
          Statistika<span className="dot">.</span>
        </h1>
        <p>Malo brojki o svim vašim izlascima.</p>
      </div>
      <dl className="figures figures-4">
        <div>
          <dt>Ukupno posjeta</dt>
          <dd>
            <CountUp value={data.visits.length} />
          </dd>
        </div>
        <div>
          <dt>Različitih mjesta</dt>
          <dd>
            <CountUp value={data.places.length} />
          </dd>
        </div>
        <div>
          <dt>Gradova</dt>
          <dd>
            <CountUp
              value={
                new Set(data.places.map((p) => p.city).filter(Boolean)).size
              }
            />
          </dd>
        </div>
        <div>
          <dt>Povrataka</dt>
          <dd>
            <CountUp value={repeated} />
          </dd>
        </div>
      </dl>
      <section className="section">
        <div className="section-heading">
          <h2>Najbolje ocijenjena</h2>
        </div>
        {ranked.length ? (
          <div className="rows">
            {ranked.slice(0, 5).map((x, i) => (
              <button
                className="row"
                key={x.p.id}
                onClick={() => openPlace(x.p)}
              >
                <span className="row-lead rank">{i + 1}</span>
                <span className="row-main">
                  <strong>{x.p.name}</strong>
                  <small>
                    {x.ratings.length} ocjena kroz{" "}
                    {new Set(x.ratings.map((r) => r.visit_id)).size} posjeta
                  </small>
                </span>
                <span className="row-trail">
                  {formatScore(placeAverage(x.ratings))}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Empty text="Ocijenite prvo mjesto pa će se ovdje pojaviti." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Najveće neslaganje</h2>
        </div>
        {agreement.length ? (
          <div className="rows">
            {agreement.slice(0, 3).map((x) => (
              <button
                className="row"
                key={x.visit.id}
                onClick={() => x.p && openPlace(x.p)}
              >
                <span className="row-lead rank">
                  <ArrowLeftRight size={17} />
                </span>
                <span className="row-main">
                  <strong>{x.p?.name}</strong>
                  <small>
                    {prettyDate(x.visit.visited_at)} · razlika u ocjeni
                  </small>
                </span>
                <span className="row-trail">{formatScore(x.difference)}</span>
              </button>
            ))}
          </div>
        ) : (
          <Empty text="Ovo postaje zanimljivo kad oboje ocijenite isti posjet." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Posjeti po mjesecima</h2>
        </div>
        {byMonth.length ? (
          <Bars items={byMonth} />
        ) : (
          <Empty text="Prvi izlazak pokrenut će statistiku." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Najčešći povratci</h2>
        </div>
        {mostVisited.length ? (
          <div className="rows">
            {mostVisited.map((x) => (
              <button
                className="row"
                key={x.p.id}
                onClick={() => openPlace(x.p)}
              >
                <span className="row-lead rank">
                  <RotateCcw size={17} />
                </span>
                <span className="row-main">
                  <strong>{x.p.name}</strong>
                  <small>{x.p.city || kindName(x.p.kind)}</small>
                </span>
                <span className="row-trail">{x.count}×</span>
              </button>
            ))}
          </div>
        ) : (
          <Empty text="Kad se vratite na omiljeno mjesto, vidjet će se ovdje." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Nova mjesta po mjesecima</h2>
        </div>
        {newByMonth.length ? (
          <Bars items={newByMonth} />
        ) : (
          <Empty text="Dodajte prvo mjesto." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Gradovi koje istražujete</h2>
        </div>
        {cities.length ? (
          <div className="rows">
            {cities.map(([city, count]) => (
              <div className="row" key={city}>
                <span className="row-main">
                  <strong>{city}</strong>
                </span>
                <span className="row-trail">{count}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="Gradovi će se pojaviti nakon prvog posjeta." />
        )}
      </section>
      <section className="section">
        <div className="section-heading">
          <h2>Najbolje po kategoriji</h2>
        </div>
        <div className="rows">
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
                className="row"
                key={key}
                onClick={() => openPlace(top.p)}
              >
                <span className="row-main">
                  <small>{label}</small>
                  <strong>{top.p.name}</strong>
                </span>
                <span className="row-trail">
                  {formatScore(ratingAverage(top.ratings, key))}
                </span>
              </button>
            ) : null;
          })}
        </div>
      </section>
    </>
  );
}
export default App;
