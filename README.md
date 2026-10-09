# Ratey

Privatna, mobilna PWA aplikacija za dvoje: restorani i kafići, posjeti, odvojene ocjene, karta, kalendar, fotografije i statistika. Frontend je React/Vite na GitHub Pagesu; API je Cloudflare Worker s D1 bazom i R2 fotografijama. Sučelje je na hrvatskom.

## Lokalno pokretanje

Treba Node.js 24 ili noviji.

1. `npm install`
2. Kopiraj `.dev.vars.example` u `.dev.vars` i postavi jak nasumičan `INVITE_CODE` i Geoapify API ključ. `.dev.vars` se ne sprema u Git.
3. `npm run api:types`
4. `npx wrangler d1 migrations apply ratey --local`
5. U jednom terminalu `npm run api:dev`, u drugom `npm run dev`.
6. Otvori `http://localhost:5173` i napravi dva računa pomoću istog pozivnog koda. Treći račun nije dopušten.

Geoapify pokreće pretragu mjesta i pločice karte. Ako pretraga ne nađe mjesto, naziv, adresu i pin možeš unijeti ručno. Karta traži valjan ključ. Podaci o lokacijama: © OpenStreetMap contributors, Geoapify.

## Produkcija

1. U Cloudflare računu stvori D1 bazu `ratey` i R2 spremnik `ratey-photos`.
2. Upisati stvarni D1 `database_id` u `wrangler.jsonc` i promijeniti `ALLOWED_ORIGIN` u adresu GitHub Pagesa, npr. `https://korisnik.github.io`. Ovo je *origin*, bez `/ratey/` na kraju.
3. Postavi Worker secrets `INVITE_CODE` (jak, nasumičan kod) i `GEOAPIFY_KEY` (`npx wrangler secret put ...`). Ne spremaj ih u Git. Geoapify ključ ograniči po mogućnosti i prati potrošnju.
4. Pokreni `npx wrangler d1 migrations apply ratey --remote`, zatim `npx wrangler deploy`.
5. Na GitHub repozitoriju postavi Actions varijablu `VITE_API_URL` na HTTPS adresu Workera, npr. `https://ratey-api.korisnik.workers.dev`. U Settings → Pages odaberi GitHub Actions kao izvor. Push na `main` automatski gradi i objavljuje frontend.
6. Na oba iPhonea otvori GitHub Pages adresu u Safariju, zatim Share → Add to Home Screen. Svaka osoba radi svoj račun istim pozivnim kodom. Nakon dva računa registracija se zatvara.

Privatni API podaci i fotografije nikad se ne objavljuju u GitHub Pages direktoriju. Frontend kod je javan ako je repozitorij javan; stvarne ocjene i slike ostaju iza prijave na Workeru.

## Provjere

`npm run build`, `npm run api:check`, `npm test`, `npm run lint`. Na pravom iPhoneu provjeriti instalaciju na početni zaslon, oba logina, kartu, kameru, rad bez veze i prihvaćanje nove verzije nakon objave.
