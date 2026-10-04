# Spin the Wheel

A small, elegant decision-maker. Add options, set how likely each one is, and spin.

- Weighted odds: each option has a weight; the wheel and the actual result both follow it
- Set a weight to `0` to sit an option out without deleting it
- Optional "remove the winner" mode, sound, confetti, and a recent-spins history
- Options are saved in your browser, and **Copy list link** shares an editable list via the URL
- **Send to people to spin**: create one link per person. They see a read-only wheel, spin, and get a fixed outcome. You can reveal or look up any result without spoiling it for them
- Plain HTML/CSS/JS, no build step

## How personal links work

There's no server. Each link holds the list plus a random seed (`#s=...`), and the seed deterministically picks the winner by the weights. So the same link always gives the same result, for the recipient and for you. This is meant for casual use: the outcome is fixed when the link is created, and someone who reads the code could work it out before spinning.

## Run locally

Open `index.html`, or serve the folder: `python3 -m http.server`.

## Deploy to GitHub Pages

In the repo go to **Settings → Pages**, choose **Deploy from a branch**, pick the branch (e.g. `main`) and the `/ (root)` folder, then save. The site will be live at `https://<user>.github.io/Spin-the-wheel/`.
