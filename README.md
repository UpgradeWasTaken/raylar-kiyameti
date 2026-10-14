# Raylar Kıyameti

A browser railway tycoon set in Turkey — all **81 provinces and 973 districts**, real 2025 populations, real terrain, and the
existing state railway network — playable alone in your browser or together in one persistent, shared world.

> **Türkçe özet** — Türkiye’nin 81 ili ve 973 ilçesinde demiryolu şirketi kurduğun bir tarayıcı oyunu. Konvansiyonel,
> hızlı tren, elektrikli/elektriksiz, tramvay ve metro hatları döşe; banliyö, bölgesel, anahat, YHT ve yük trenleri işlet.
> Her oyuncunun Türk lirası bütçesi var, kredi çekebilir. Raylar sahibinindir: başkasının rayını kullanmak için sözleşme
> yaparsın ya da raylar dinamik bir ücretle herkese açılır. Başkalarının raylarını satın almak için teklif verirsin; kimse
> satmaya zorlanamaz. Tek oyunculu modda dünya tarayıcında çalışır (yapay zekâ rakiplerle); çok oyunculu modda herkes
> Supabase üzerindeki ortak dünyada oynar. Kurulum aşağıda.

## What you can do

- **Lay track** anywhere in Turkey: conventional or high-speed, single or double, electrified or not, plus tram and metro
  networks. Costs follow the real map: mountains need tunnels, water needs bridges (straits like the Bosphorus are
  crossable, open sea is not), dense cities mean land acquisition, sharp curves cap the speed. Borders cannot be crossed.
- **Build stations** — railway stations (with optional freight terminals), tram stops and metro stations. Each one
  draws riders from the population around it (walking catchment for short trips, regional catchment for intercity).
- **Run lines** with ten train types: trams, metros, suburban EMUs, regional DMUs, diesel and electric intercity
  trains, diesel high-speed trains, the YHT-300 and two kinds of freight trains. Pick the stops, the route is found
  automatically; forecast riders and profit before opening; set fleet size and fares.
- **Ownership and deals.** Every piece of track and every station belongs to a company.
  - Open your track to everyone for a base fee per train-km; the fee rises dynamically with congestion
    (`base × (1 + 2 × utilisation²)`).
  - Or keep it closed and sign **usage contracts**: a fixed fee for a fixed term, requested by the user or offered by
    the owner.
  - **Buy** other companies’ track and stations by sending an offer (they can accept or reject — nobody can be forced)
    or by buying what they list for sale. Sell yours the same way.
- **Money.** Every company starts with ₺250 million and can borrow against its assets. Revenue comes from fares and
  freight; costs are train operation, maintenance, track fees and interest. Run out of cash and credit and you have
  48 game hours to recover before bankruptcy hands your network to the state.
- **The state railway** (Devlet Demiryolları) owns the existing ~7,900 km conventional network with 174 stations, open
  to everyone for a fee. It negotiates by fixed rules: it sells track at 1.6× book value, buys at 0.5×, and signs
  usage contracts at ≥ 70 % of its open fee.
- **Progression.** Carrying passengers and freight and investing earn experience; metro and suburban EMUs unlock at
  level 2, electric intercity and freight trains at 3, high-speed track and the diesel high-speed train at 4, the YHT-300 at 5.
- **MMO bits:** a shared real-time world, chat, announcements of new lines and bankruptcies, a value ranking.
- Turkish and English UI, works on desktop and phones.

### How demand works

For every pair of stops on a line the engine estimates trips per hour:

- local trips (commuting, errands), linear in the population around both stops and fading over ~9 km;
- intercity trips, a gravity model on regional catchments that people drive to for long journeys;
- the train’s share against car/bus (and air for long distances), from generalised cost: access, waiting (headway),
  riding time weighted by comfort, and fare;
- competition: lines with stops near both ends share the market by a logit on their generalised costs;
- capacity on the busiest leg caps what a line can carry. Interchanges with other lines make stops more attractive.

Freight uses industry-weighted population (ports and industrial provinces count more) and favours long hauls.

## Play it

Once GitHub Pages is enabled (below) the game is at **https://upgradewastaken.github.io/raylar-kiyameti/**.

- **Single player** works immediately, with no server. The whole engine runs in your browser (PostgreSQL compiled to
  WebAssembly via PGlite) and saves in IndexedDB. The first start takes 10–20 seconds to build the world; later starts
  are quick. You can pause or run time at 1×–60× (1× = one game minute per second) and add up to five AI rivals.
- **Multiplayer** appears once a Supabase project is connected. Time runs for everyone at one game hour per real minute.

## Deploy to GitHub Pages

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge this branch into `main` (or run the **Deploy to GitHub Pages** workflow from the Actions tab). The workflow
   builds the site and publishes it.

## Turn on multiplayer (Supabase, free tier is enough)

GitHub Pages only serves static files, so the shared world lives in a Supabase project (Postgres + auth). All game
rules run inside the database as SQL functions — the browser only calls one function, `game_rpc` — so players cannot
cheat by editing the page. The public key in the page is meant to be public.

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Sign In / Providers**: enable **Allow anonymous sign-ins** (for “Play as guest”). If you want
   email accounts without confirmation mails, also turn off **Confirm email** under Email.
3. Install the game into the database — either:
   - **from GitHub:** add a repository secret `SUPABASE_DB_URL` with the **Session pooler** connection string
     (Supabase → **Connect** → Session pooler, with your database password filled in), then run the
     **Set up multiplayer database** workflow from the Actions tab; or
   - **from your computer:** `npm ci && node tools/db-setup.mjs "<session pooler connection string>"`.

   Running it again later upgrades the rules and keeps the world. `--reseed` (or the workflow’s checkbox) wipes it.
4. Add repository **variables** (Settings → Secrets and variables → Actions → Variables): `SUPABASE_URL`
   (`https://<project>.supabase.co`) and `SUPABASE_ANON_KEY` (Project Settings → API keys: the publishable / anon key),
   and re-run the Pages workflow. *Alternatively* edit `public/config.json` to
   `{ "supabaseUrl": "...", "supabaseAnonKey": "..." }`.
5. Optional: the economy advances whenever any player is online. To keep it ticking with nobody online, enable the
   `pg_cron` extension and run
   `select cron.schedule('raylar-settle', '* * * * *', $$select public.game_rpc('settle')$$);`

## Develop

```sh
npm install
npm run dev            # http://localhost:5173
npm test               # engine tests in PGlite
npm run build          # type-check and production build into dist/
npm run balance        # economics of typical lines (payback times)
```

- `PG_URL=postgres://… npm run test:pg` runs the engine tests on a real PostgreSQL server (checked on 15).
- `npm run e2e` drives the offline game in headless Chromium (start `npx vite preview --port 4173` first);
  `npm run e2e:online` plays a two-player session against a Supabase-compatible backend
  (`tests/online/stack.mjs` assembles one locally from Postgres, Supabase Auth and PostgREST).
- `npm run data:fetch && npm run data` rebuilds the world data from the original sources.

### Layout

| Path | What |
|---|---|
| `sql/engine/` | The game: schema, balance (`02_config.sql`), terrain survey, construction, lines and timetables, demand and settlement, market, API |
| `sql/seed/` | Generated world data: provinces, districts, population points, terrain grids, the state railway |
| `src/backend/` | `local.worker.ts` runs the engine in PGlite; `online.ts` calls Supabase |
| `src/game/` | Client mirror of the world (revision-based sync), route finding, deterministic train positions, AI rivals |
| `src/map/` | MapLibre map built from our own data, train overlay |
| `src/ui/` | Preact interface |
| `tools/build-data/` | Data pipeline |

Every client sees the same trains at the same places: positions are computed from each line’s timetable and the
shared game clock rather than streamed.

## Data and credits

- Province and district boundaries: [geoBoundaries](https://www.geoboundaries.org) (CC BY 4.0).
- Province and district populations (TÜİK ADNKS 2025): [TurkiyeAPI](https://github.com/ubeydeozdmr/turkiye-api) (MIT).
- Town locations: [GeoNames](https://www.geonames.org) via `all-the-cities` (CC BY 4.0).
- Coastlines, lakes, rivers, neighbouring countries and the railway network: [Natural Earth](https://www.naturalearthdata.com) (public domain).
- Elevation: Mapzen/Tilezen terrain tiles on AWS Open Data (SRTM, GMTED2010, ETOPO1 and others).
- Labels: Noto Sans glyphs (SIL Open Font License) from `smp-noto-glyphs`.
- Optional detailed map: © OpenStreetMap contributors.
- Built with MapLibre GL JS, PGlite, Supabase, Preact and Vite.

The state railway in the game is a simplified, fictional stand-in for the real network; company names and figures in
the game are not those of real organisations.
