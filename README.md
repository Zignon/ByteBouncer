# ByteBouncer

A Windows x64 FTP / FTPS client in the spirit of FileZilla, built to use the **full download bandwidth** of the machine it runs on.

## How it gets full bandwidth
* **Segmented downloads** – a large file is split into N byte ranges and every range is fetched over its own FTP connection at the same time (`REST` + `RETR`). Per-connection server throttling or TCP window limits no longer cap a single file.
* **Parallel transfers** – several files move at once, on top of segmentation.
* All of it is tunable in *Settings*: simultaneous files, connections per file, total connection cap, minimum segment size. Defaults: 3 files × up to 4 connections, 10 connections total. If a server refuses logins ("421 ... maximum"), ByteBouncer waits for a free slot instead of failing and learns the server's cap for the rest of the session.
* Servers without `REST` support fall back to one connection per file automatically; failed segments retry from their last byte.

## Features
* Quickconnect bar + Site Manager (saved sites, default remote/local folders)
* FTP, FTPS explicit (AUTH TLS), FTPS implicit and **SFTP (SSH)** with password or private-key auth - segmented multi-connection downloads work on all of them
* Dual-pane local / remote browser: navigate, sort, multi-select (Ctrl / Shift), right-click menus (download, upload, rename, delete, new folder, open, show in Explorer)
* Recursive folder download / upload
* Transfer queue with per-file progress, speed, stream count, cancel / retry / remove, pause queue
* Live total speed, active connections and a bandwidth graph
* Message log with the raw FTP conversation
* **VPN-aware mode**: live badge showing whether a Proton VPN (or other VPN) tunnel is up, one-click launch of the official Proton VPN app, and a *Require VPN* kill switch - transfers only run while the tunnel is up, stop instantly if it drops and resume when it returns. ByteBouncer never handles VPN credentials.
* Version number in the title bar, app icon and blue/orange palette throughout

## Install
Run `dist/ByteBouncer-Setup-<version>-x64.exe (current: 1.1.0)` (per-user install, no admin rights needed). It creates Start Menu + Desktop shortcuts and an Add/Remove Programs entry.

## Build from source
```
npm install
npm start                      # run in development
./build/make-installer.sh      # Linux/macOS: produces dist/ByteBouncer-Setup-<ver>-x64.exe without Wine
npm run dist                   # on Windows: plain electron-builder build
```
Layout: `main/ftp-engine.js` (transfer engine), `main/main.js` (Electron main / IPC), `renderer/` (UI), `build/` (icon, NSIS script, branding script).

## Microsoft Store (MSIX)
1. In [Partner Center](https://partner.microsoft.com/dashboard) create the app and reserve the name **ByteBouncer**. Open *Product management → Product identity* and copy the three values into `build/store-identity.json` (`Package/Identity/Name`, `Package/Identity/Publisher`, `Package/Properties/PublisherDisplayName`). The Publisher must match exactly, including the `CN=` prefix.
2. `./build/make-installer.sh && ./build/make-msix.sh` → `dist/ByteBouncer-<ver>-x64.msix` (unsigned; the Store signs it on publish). Packaged with Microsoft's open-source `makemsix` (`build/tools`), so it builds on Linux.
3. Upload the `.msix` on the submission's *Packages* page. Fill in the listing (description, screenshots, 1:1 Store logo from `build/appx`), set age rating and pricing, submit.

Notes: the package declares `runFullTrust` (required for any Electron app - certification asks you to justify it; "desktop FTP client that reads and writes user-chosen local folders" is sufficient). Versions must be `x.y.z.0`; the script derives this from `package.json`. To test the MSIX locally before submitting, sign it with a self-signed cert on a Windows machine (`signtool sign /fd SHA256 /a /f cert.pfx /p pw ByteBouncer-x.y.z-x64.msix`) after installing the cert into *Trusted People*; the Store-signed copy installs without that.
