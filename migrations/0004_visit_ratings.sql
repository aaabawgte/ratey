CREATE TABLE visit_ratings (
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  service REAL NOT NULL,
  ambience REAL NOT NULL,
  value REAL NOT NULL,
  location REAL NOT NULL,
  food REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (visit_id, user_id)
);
CREATE INDEX visit_ratings_user ON visit_ratings(user_id);

-- Stare ocjene mjesta čuvamo u tablici ratings i kopiramo ih na zadnju posjetu.
INSERT INTO visit_ratings
  (visit_id, user_id, service, ambience, value, location, food, updated_at)
SELECT
  (SELECT v.id FROM visits v WHERE v.place_id = r.place_id
   ORDER BY v.visited_at DESC, v.created_at DESC, v.id DESC LIMIT 1),
  r.user_id, r.service, r.ambience, r.value, r.location, r.food, r.updated_at
FROM ratings r
WHERE EXISTS (SELECT 1 FROM visits v WHERE v.place_id = r.place_id);
