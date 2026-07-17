# PourCast Setup Guide

PourCast is a Progressive Web App. Host these files at a URL and it works as a website on your laptop and as an installable app on your iPhone.

## Step 1: Put it on GitHub Pages (one-time, about 5 minutes)

1. Go to github.com and sign in (or create a free account).
2. Click the + in the top right, then "New repository".
3. Name it `pourcast`, set it to Public, and click "Create repository".
4. On the new repo page, click "uploading an existing file".
5. Drag ALL the files from this folder into the upload area (index.html, styles.css, app.js, sw.js, manifest.webmanifest, and the four png icons). SETUP.md is optional.
6. Click "Commit changes".
7. Go to Settings (top of the repo), then "Pages" in the left menu.
8. Under "Build and deployment", set Source to "Deploy from a branch", Branch to `main` and folder to `/ (root)`, then Save.
9. Wait a minute or two, then refresh the Pages screen. Your app URL appears at the top, in the form:

   `https://YOUR-USERNAME.github.io/pourcast/`

Open that URL in any browser. That is your app.

## Step 2: Install it on your iPhone

1. Open the URL in Safari (must be Safari for install to work).
2. Tap the Share button (square with an up arrow).
3. Scroll down and tap "Add to Home Screen", then "Add".
4. PourCast now sits on your home screen with its own icon and opens full screen like a normal app.

On your laptop, just bookmark the URL. In Chrome or Edge you can also click the install icon in the address bar to get it as a desktop app.

## Updating the app later

When Claude gives you updated files, go back to your repo, click "Add file > Upload files", drag the changed files in, and commit. The live app updates within a minute or two. On your phone, close and reopen the app twice to pick up the new version (the first open downloads it in the background).

## Notes

- Your sites, theme, and pour window settings are saved on each device.
- The last forecast is cached, so the app opens instantly and still shows data with patchy reception.
- Forecast sources: Open-Meteo multi-model best match (primary), ECMWF IFS, and BoM ACCESS-G, which rejoins automatically when BoM's open-data feed comes back online.
