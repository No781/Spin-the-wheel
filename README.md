# Spin the Wheel

A small, elegant decision-maker. Add options, set how likely each one is, and spin.

- Weighted odds: each option has a weight, and the wheel and the actual result both follow it
- Set a weight to `0` to sit an option out without deleting it
- Optional "remove the winner" mode, sound, confetti, and a recent-spins history
- **Live rooms** (needs the server): everyone in a room edits the same wheel in real time and sees each spin land together
- **Spin links** (works on any static host): one link per person, with a fixed outcome you can look up
- Options are saved in your browser, and **Copy list link** shares an editable list via the URL

The front end is plain HTML/CSS/JS with no build step. Solo mode and spin links work on any static host. Live rooms need the small Node server in `server/`.

## Live rooms

Click **Go live together** to turn the wheel you're looking at into a room, then send the invite link. Everyone who opens it joins the same wheel:

- edits (add, rename, reweight, remove, equalize, clear) show up for everyone immediately, and you can see who is editing which row
- anyone can press spin. The **server** picks the winner with a cryptographic random draw and tells every client the same animation (start time, duration, final angle), so the wheel lands together and nobody can predict or fudge it
- the options are locked while the wheel is turning, and results go into a shared history
- "remove the winner" is a shared room setting handled by the server
- **presence that works on phones too** (no mouse needed): each person shows as *active*, *idle* (no touch, key or scroll for 45 s) or *away* (tab hidden or phone locked) with how long, plus *editing Pizza* while they have a field focused. Their avatar pulses and the row they change flashes in their colour whenever they do something
- tap-to-send emoji reactions (👋 🎉 🤞 😂 ❤️ 👀) float up over everyone's wheel with the sender's name
- a short live feed ("Bob set Pizza to 9", "Sam joined") and a latency readout (for example `42 ms`) that proves the connection is live
- rooms are saved to disk, survive restarts, and are deleted after 30 days of inactivity
- clients reconnect automatically if the connection drops

The room ID in the link (`#r=...`) is the only access control, so treat the invite link like a password: anyone with it can join and edit.

### Run it locally

```sh
cd server
npm install
npm start          # http://127.0.0.1:8080
```

Open it in two browser windows, click **Go live together** in one, and open the invite link in the other.

### Server settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind. Keep it on localhost behind a proxy |
| `DATA_FILE` | `server/data/rooms.json` | Where rooms are saved |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so per-IP limits use `X-Forwarded-For` |
| `ALLOWED_ORIGINS` | same host only | Comma-separated extra page origins allowed to connect, if the page is hosted elsewhere |

Built-in protections: connections must come from an allowed origin, messages are size- and rate-limited, there are caps on rooms, people per room, options per room and connections per IP, option names are always rendered as plain text, and the server only serves a fixed list of public files.

## Deploying on your own server (next to an existing site)

`deploy/install.sh` sets everything up on an Ubuntu/Debian server **without disturbing sites that are already running there**.

### Use a subdomain

Serve the wheel on its own subdomain (for example `wheel.example.com`), not under a path like `example.com/wheel`. A subdomain gets its own separate web server config, so your existing site's config isn't edited at all, and the browser keeps the two sites' stored data apart. The live connection (`/ws`) is also built for a site root. All you need is one DNS record: an `A` record for `wheel` pointing at the same IP as your main domain.

### Check what your server runs (read-only)

```sh
sudo ss -tlnp | grep -E ':(80|443)\s'                      # which program owns the web ports
systemctl is-active nginx apache2 caddy                     # which web servers are running
sudo nginx -T 2>/dev/null | grep -E 'server_name|listen'    # if nginx: the sites it serves
```

The installer runs the same detection itself and adapts: with **nginx** it adds one new site; with Apache, Caddy or anything else it installs only the app and prints the config to add by hand; with no web server at all it installs nginx.

### Install

1. Create the DNS record for the subdomain.
2. Get this repo onto the server (`git clone`, or copy the folder with `scp`/`rsync`; a private repo needs a read-only deploy key).
3. See what would happen first. This changes nothing:
   ```sh
   cd Spin-the-wheel
   sudo ./deploy/install.sh --domain wheel.example.com --email you@example.com --dry-run
   ```
4. Install for real (it asks for confirmation; add `--yes` to skip that):
   ```sh
   sudo ./deploy/install.sh --domain wheel.example.com --email you@example.com
   ```
5. Verify. It checks the app, nginx, HTTPS, the certificate, a real WebSocket round trip, and that your other site still answers:
   ```sh
   sudo /opt/spin-the-wheel/app/deploy/check.sh
   ```
   If anything fails, paste its output into the conversation to get help.

Options: `--port N` (default: first free port from 8080), `--no-tls` (HTTP only), `--no-web` (app only, print the proxy config), `--dry-run`, `--yes`.

### What it does, and what it never does

It does: create an unprivileged `spinwheel` user, copy the app to `/opt/spin-the-wheel/app` (read-only for the service), install a **private** copy of Node under `/opt/spin-the-wheel/node` (checksum verified; your system Node is not touched), run the app as a systemd service on `127.0.0.1` only, add one nginx site file for the domain, and get a Let's Encrypt certificate with certbot (installing the `certbot` package if you don't have it).

It never: edits your existing nginx files, installs a second web server over yours, changes firewall rules or upgrades system packages. Before reloading nginx it runs `nginx -t`, and if nginx rejects the new site it removes it again and reloads nothing. It refuses to run if your existing nginx config is already broken or if another site already uses the domain. The reload is graceful (no restart, no downtime for your other sites).

### Update, uninstall, troubleshoot

- **Update:** `git pull`, then run `install.sh` again with the same options. It's safe to repeat, keeps your `config.js` and your saved rooms, and restarts only the wheel.
- **Uninstall:** `sudo /opt/spin-the-wheel/app/deploy/uninstall.sh` removes the service and its nginx site and keeps saved rooms; add `--purge` to delete those and the service user as well. The certificate is left (remove it with `sudo certbot delete --cert-name <domain>`).
- **Logs:** `journalctl -u spin-the-wheel -f`. Rooms are saved in `/var/lib/spin-the-wheel/rooms.json`.
- **Renewal:** certbot renews certificates by itself (a systemd timer or cron job, set up by its package). `check.sh` tells you whether one exists.

### Keeping the page elsewhere

If the page lives on a static host and only the server is yours, set the server address in `config.js` (`window.SPIN_WS_URL = 'wss://wheel.example.com/ws'`) and start the server with `ALLOWED_ORIGINS=https://your-page-host`. Serving the page from the same server is simpler.

## How spin links work

Spin links need no server. Each link holds the list plus a random seed (`#s=...`), and the seed deterministically picks the winner by the weights. So the same link always gives the same result, for the recipient and for you. This is meant for casual use: the outcome is fixed when the link is created, and someone who reads the code could work it out before spinning. Use a live room if you want a real draw.

## Static hosting only

Without the server the page still works as a solo wheel and for spin links. On GitHub Pages (public repos, or private on a paid plan): **Settings → Pages → Deploy from a branch**, then choose the branch and the `/ (root)` folder. The **Go live together** button needs the server, so it will tell you the live server can't be reached.
