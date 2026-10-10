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

## Deploying on your own server

These steps assume a Debian or Ubuntu VPS where you have root. You'll need a domain (or subdomain) pointing at the server: browsers need HTTPS for the clipboard and for secure WebSockets (`wss://`).

1. **Install Node 20+ and Caddy** (Caddy handles HTTPS certificates for you):
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt-get update && sudo apt-get install -y caddy
   ```
2. **Create a service user and get the code**:
   ```sh
   sudo useradd --system --create-home --home-dir /opt/spin-the-wheel --shell /usr/sbin/nologin wheel
   sudo -u wheel git clone <your repo url> /opt/spin-the-wheel/app
   ```
   (For a private repo, add a read-only deploy key, or copy the folder up with `rsync` instead.)
3. **Install dependencies**:
   ```sh
   cd /opt/spin-the-wheel/app/server && sudo -u wheel npm ci --omit=dev
   ```
4. **Start it as a service**:
   ```sh
   sudo cp /opt/spin-the-wheel/app/deploy/spin-the-wheel.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now spin-the-wheel
   curl http://127.0.0.1:8080/healthz    # should print: ok
   ```
5. **Put HTTPS in front**: copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, put your domain in it, then `sudo systemctl reload caddy`. Open ports 80 and 443 (for example `sudo ufw allow 80,443/tcp`).
6. **Update later**:
   ```sh
   cd /opt/spin-the-wheel/app && sudo -u wheel git pull
   cd server && sudo -u wheel npm ci --omit=dev && sudo systemctl restart spin-the-wheel
   ```

Check logs with `journalctl -u spin-the-wheel -f`. Rooms are kept in `/var/lib/spin-the-wheel/rooms.json`.

### Keeping the page elsewhere

If the page lives on a static host and only the server is yours, set the server address in `config.js` (`window.SPIN_WS_URL = 'wss://wheel.example.com/ws'`) and start the server with `ALLOWED_ORIGINS=https://your-page-host`. Serving the page from the same server is simpler.

## How spin links work

Spin links need no server. Each link holds the list plus a random seed (`#s=...`), and the seed deterministically picks the winner by the weights. So the same link always gives the same result, for the recipient and for you. This is meant for casual use: the outcome is fixed when the link is created, and someone who reads the code could work it out before spinning. Use a live room if you want a real draw.

## Static hosting only

Without the server the page still works as a solo wheel and for spin links. On GitHub Pages (public repos, or private on a paid plan): **Settings → Pages → Deploy from a branch**, then choose the branch and the `/ (root)` folder. The **Go live together** button needs the server, so it will tell you the live server can't be reached.
