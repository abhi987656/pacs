# Personal PACS

A single-user DICOM viewer and radiology reporting workstation for Windows: import CT, MRI and
other studies from a CD/DVD, USB stick or folder, read them in a PACS-style viewer, and write
reports in a RIS-style editor with templates, macros and PDF/Word export. Everything runs offline on
your own PC or laptop. A companion **Android app** lets you write reports on your phone; it syncs
with the PC over your own Wi-Fi or hotspot.

> **Not a certified medical device.** Use it for personal reporting workflow, teaching and research.
> Verify findings on your institution's approved diagnostic systems.

## Features

**Worklist**
- Import from a CD/DVD drive, USB stick, folder or individual files, or drag them onto the window.
  Patient CDs with a `DICOMDIR` and files without extensions work.
- Images are copied into a local archive, so the CD can be removed. Duplicates are skipped.
- Search by name, patient ID, accession or study. Filter by modality, report status and date.
  Search inside report text, which is handy for teaching files.
- **New Case** lets you report without images. Enter the patient name, CR No (patient ID),
  PG No (accession), age/sex and study, then start reporting. If you import the CD later, images
  with the same PG No attach to that case automatically.
- Patient and study details can be corrected later with "Edit patient / study details" on the report page.

**Reporting window** (laid out like a hospital RIS)
- Patient banner: ID, name/sex/age, study, exam date, visit type, accession, referring doctor.
- Side panels: Scan Status, Clinical Details, Report Last Saved By, and Previous Reports, where you
  can view, copy or PDF the patient's older reports.
- Modality, Procedure, Radiologist, Template Name (with "My Templates") and Macro Text fields.
- Ribbon with Home, Insert, Page Layout, View and Templates tabs:
  - Text formatting: font, size, colour, highlight, bold/italic/underline, sub/superscript and change case.
  - Lists, indents, alignment, line spacing and styles.
  - Find/replace, tables, pictures and symbols.
  - Simple view or print layout, zoom and full screen.
- **Templates**: starter templates include NCCT head, CECT chest, HRCT, CECT abdomen, NCCT KUB,
  MRI brain, LS spine, knee, USG abdomen, chest X-ray and a follow-up comparison template.
  Placeholders such as `{{prior_date}}` are filled in automatically.
- **Macros**: type `.nad` then Space, or the code then F3, or use the Macro Text box.
- **Key images**: press **B** in the viewer to insert the current image, with its measurements, into the report.
- Save (draft), **Preliminary**, **Sign off** and **Sign off »** (signs and opens the next unreported study).
- Autosave, version history, spell check, Print, and export as **PDF**, **Word (.docx)** or **text (.txt)**.
  Exports include your letterhead, logo, patient table and signature.

**Voice dictation** (offline – your voice never leaves the computer)
- Press **F4** in the report, or in the viewer while looking at the images, and speak. The text
  appears in the report after each short pause.
- Runs on the computer's processor with the open-source sherpa-onnx engine. Choose a model in
  **Settings → Dictation**; it downloads once:
  - **Parakeet TDT 0.6B v2** by NVIDIA (460 MB). Recommended, the most accurate for medical words.
  - **Whisper base** by OpenAI (200 MB). Smaller and lighter, but less accurate.
- Voice commands:
  - punctuation: "full stop", "comma", "semicolon", "colon" (at the end of a phrase), "question mark",
    "open/close bracket", "hyphen", "slash"
  - layout and editing: "new line", "new paragraph", "delete that"
  - shortcuts: "macro nad", "template CECT abdomen", "stop dictation"
- "12 by 8 millimeters" is written as "12 x 8 mm". Letters spelled out ("C B D") become "CBD".
- **Corrections list**: if a word is often misheard, add "heard as → write instead" in
  Settings → Dictation.
- A good USB or headset microphone makes a big difference. Windows must allow desktop apps to use
  the microphone (Settings → Privacy & security → Microphone).

**Phone app (Android)** – reporting on the go, synced with the PC
- The same report editor on the phone: templates, macros (`.nad` + space), bold/lists/headings,
  previous reports of the patient, clinical details, and **Save** / **Preliminary**.
  Final **sign-off is done on the PC**; reports signed off there are read-only on the phone.
- **New case** on the phone (patient name, CR No, PG No, age/sex, study …). It appears on the PC;
  when you import the CD there, images with the same PG No attach to it.
- **Mic button** for dictation with Android's speech recognition, using the same voice commands and
  corrections list as the PC. Offline when the phone's offline English speech pack is installed.
- **Export** Word, PDF or text and share it (WhatsApp, Gmail, Drive …) or save it to the phone.
- Works **offline**: cases, templates and macros are kept on the phone. Changes sync automatically
  when the phone and PC are on the same Wi-Fi or hotspot (on opening the app, every minute while it
  is open, and shortly after each change).
- What the phone keeps: every case not yet signed off, everything from the last 30 days, and the
  previous studies of those patients. Older signed-off cases stay on the PC only.
- **Templates and macros sync both ways.** If the same item is changed on both before a sync, the
  newest change wins. For reports the older version is kept in the report's **History** on the PC,
  so nothing is lost.

**Viewer window** (laid out like a hospital PACS, with mouse and hot keys like Fujifilm Synapse; put it on
a second monitor if you have one)
- Study list with prior studies, series thumbnails, and drag-and-drop of series into viewports.
- Layouts 1×1 to 2×3. Double-click a viewport to maximise it.
- Right-click opens an image tools menu with presets, tools, scale/rotate/flip, reference lines, tile
  formats, linking, cine, MPR, save and copy.
- Window/level presets on keys 1–9 or the number pad:
  1 Body Soft Tissue, 2 Body Lung, 3 Body Bone, 4 Body Liver, 5 Head Mid Brain, 6 Head Post Fossa,
  7 Head Blood, 8 Head Bone, 9 CTA MIP. The menu also has Head IAC, Stroke and Subdural.
- Measurements: length, angle, ellipse/rectangle ROI (mean/SD HU, area), probe (HU), bidirectional and arrow.
- Text overlay: patient and series details, W/L, slice location and thickness, kVp/mA, TR/TE,
  plus orientation markers.
- **Compare with prior** (key **C**): current and previous study side by side, with linked scrolling.
- **MPR** (key **M**): axial, sagittal and coronal with crosshairs, plus MIP slabs.
- Cine, invert, rotate, flip and magnifier.
- Compressed DICOM: JPEG, JPEG-LS, JPEG 2000, HTJ2K, RLE and JPEG-XL.

## Install (Windows 10/11)

1. On GitHub, open this repository's **Actions** tab, then the latest **Build Windows installer**
   run, and download the **PersonalPACS-Windows** artifact (a zip).
2. Unzip it and run `PersonalPACS-Setup-x.y.z.exe`. It installs for your user only, so no admin
   rights are needed. `PersonalPACS-Portable-x.y.z.exe` runs without installing.
3. Windows may show "Windows protected your PC" because the app is not code-signed. Click
   **More info → Run anyway**.

### Install the phone app (Android 7 or newer)

1. On your phone, open this repository on GitHub (signed in), go to **Actions → Build Android app**,
   open the latest run and download the **PersonalPACS-Android** artifact. Unzip it to get
   `PersonalPACS-Android-x.y.z-buildN.apk`. (Or download it on the PC and copy it to the phone.)
2. Open the APK. Android asks to allow installing apps from your browser/Files app: allow it.
   If Play Protect warns about an unknown app, choose **More details → Install anyway**.
3. **Updates:** if the signing key is saved in the repository (see *Development → Android signing
   key*), a newer APK installs over the old one and keeps your cases and pairing. Otherwise each
   build has its own key: uninstall the old app first, install the new one and pair again (your
   reports are safe on the PC; send any unsynced changes before uninstalling).

### Pair the phone with the PC (once)

1. Connect the phone and the PC to the same Wi-Fi, or connect the PC to the phone's hotspot (most
   reliable: many hospital Wi-Fi networks block devices from talking to each other).
2. On the PC: **Settings → Phone app → Pair a phone…**. A QR code appears. The first time, Windows
   asks whether Personal PACS may use the network: tick **both Private and Public** and click Allow.
3. On the phone: open Personal PACS and tap **Scan QR code** (or **Enter code instead** and type the
   PC address and the 10-letter code shown on the PC).

There is no number or ID to make up: the PC creates its own ID and a secret key, and pairing gives
the phone its own key. The phone finds the PC again by itself when its Wi-Fi address changes.
Everything travels only over your local network, encrypted (AES-256-GCM, key from an ECDH exchange
made during pairing). If a phone is lost, remove it under **Settings → Phone app** on the PC; its key
stops working immediately. Personal PACS must be running on the PC (minimised is fine) for syncing.

## First steps

1. Open **Settings** (gear icon). Enter your name, qualification and registration number. Add your
   signature image and the letterhead (hospital/clinic name, address and logo).
2. In the **Worklist**, click **Import CD / Folder** and choose the CD drive or folder.
3. Double-click a study. The report opens and the images open in the viewer window.
4. Choose a template, type or use macros, press **B** in the viewer for key images, then **Sign off**
   and **PDF**, **Word** or **Print**.

### Viewer mouse and shortcuts (Synapse style)

| Mouse / key | Action |
| --- | --- |
| Left-drag | Window/level (left-right = width, up-down = level) |
| Hold left + click right | Switch the drag between window/level → zoom → pan |
| Right click | Image tools menu |
| Wheel / middle-drag | Scroll through images |
| Double-click the mouse wheel | Link window/level + zoom between tiles |
| Alt+drag / Alt+Ctrl+drag / Alt+Shift+drag | Window/level / zoom / pan |
| Shift+drag / Ctrl+drag | Move / copy a series to another tile |
| R T A D | Ruler, text, arrow, density value (HU). One use, then back to window/level |
| G F E O | Angle, freehand ROI, elliptical ROI, magnifying glass |
| L / Esc | Lock the tool / back to window/level |
| B | Bookmark: key image into the report |
| S K C J | Linked scrolling on/off, add/remove tile, remove all, auto-link |
| I | Link window/level + zoom between tiles |
| Q / U | Lock / unlock reference lines |
| = / - | Zoom to fit / zoom 1:1 |
| N / M | Cine / MPR |
| 1–9, number pad, 0 | Presets, 0 = original |
| Home / End, PgUp / PgDn, arrows | First / last image, ±10, ±1 |
| F5 | Reset the image |
| Shift+T / Shift+A / Shift+I | Text overlay / annotations / invert |
| Alt+C / Alt+Shift+C / Alt+X | Compare with next / previous prior study, close comparison |
| Alt+S / Alt+A | Next / previous series |
| Alt+I / Alt+N / Alt+R / Alt+E | Study info / notes / report / series picker |
| Ctrl+C | Copy the image to the clipboard |
| F4 | Dictation on/off |

## Your data

- Default data folder: `%LOCALAPPDATA%\PersonalPACS\Data`. It holds the database (`pacs.db`) and
  the `archive` of images. You can move it in **Settings → Data**, for example to a bigger D: drive.
- **Back up regularly:** **Settings → Back up reports database** saves a copy of all reports.
- The archive contains patient data. Keep it out of OneDrive/Dropbox and turn on BitLocker on laptops.
- The phone app keeps its copy in the app's private storage and is excluded from Android cloud
  backups. Use a screen lock on the phone. **Settings → Unpair** on the phone removes everything from it.

## Development

Requirements: Node.js 22 or later.

```bash
npm install
npm run dev        # run with hot reload
npm run typecheck
npm run build      # production build into out/
npm run dist:win   # Windows installer + portable exe into dist/ (run on Windows)
```

The Electron binary downloads on the first `npm run dev`.

Phone app (Capacitor 8; screens in `src/mobile`):

```bash
npm run mobile:dev          # the phone screens in a browser (use a phone-sized window)
npm run android:sync        # build the screens and copy them into android/
cd android && ./gradlew assembleRelease   # APK (needs JDK 21 and the Android SDK)
```

GitHub Actions builds the APK on every push (`.github/workflows/build-android.yml`).
`node scripts/android-icons.cjs` redraws the app icon and splash.

**Android signing key.** Android installs an update only when it is signed with the same key as the
installed app. Keys are never stored in the repository. To get updates that install over the old
version, create a key once and save it as two repository secrets
(GitHub → Settings → Secrets and variables → Actions → New repository secret):

```bash
keytool -genkeypair -keystore personalpacs.jks -alias personalpacs -keyalg RSA -keysize 3072 -validity 18250
base64 -w0 personalpacs.jks > personalpacs.jks.b64
```

- `ANDROID_KEYSTORE_BASE64`: the contents of `personalpacs.jks.b64`
- `ANDROID_KEYSTORE_PASSWORD`: the password you chose (use the same one for the key)

Keep `personalpacs.jks` and its password somewhere safe: a lost key means the next build must be
installed fresh (uninstall first). Without the secrets, every build is signed with a one-off key.

Test data: `scripts/make_test_data.py` generates synthetic, anonymous CT/MR studies. These include a
prior study, compressed series and a CD layout with DICOMDIR.

```bash
pip install pydicom numpy pylibjpeg pylibjpeg-openjpeg pyjpegls
python scripts/make_test_data.py test-data
```

### How it is built

- **Electron**, with React and TypeScript, built with electron-vite.
- **Cornerstone3D** (MIT) handles image decoding, GPU rendering, tools and MPR.
- **TipTap** (MIT) is the report editor.
- **SQLite** is the database, using Node's built-in `node:sqlite`, so there are no native modules to compile.
- **dicom-parser** reads headers during import.
- **sherpa-onnx** (Apache-2.0) runs offline speech recognition, using Silero VAD to split speech into
  phrases. It runs in an Electron utility process (`src/main/speechWorker.ts`), so it can't freeze or
  crash the app. Models download from the sherpa-onnx GitHub releases.
- `src/renderer/src/ris/dictation.ts` holds the microphone capture, voice commands and text tidying.
- `src/main`: database, import, archive protocol (`app://bundle/dicom/...`), print/PDF and IPC.
- `src/preload`: the `window.api` bridge.
- `src/renderer/src/ris`: worklist, report page, templates and settings.
- `src/renderer/src/viewer`: the viewer window.
- **Phone sync**: `src/main/phoneLink.ts` is a small HTTP server on the local network (port 47820,
  UDP 47821 for discovery) that only answers paired phones. `src/shared/syncCrypto.ts` holds the
  pairing and encryption code shared by both sides. The database records a revision number on every
  change (SQLite triggers), so the phone asks for "everything since revision N".
- **Exports**: `src/shared/reportExport.ts` makes the Word and text files on both the PC and the
  phone. The phone makes PDFs with pdfmake (`src/mobile/reportPdf.ts`); the PC uses Chromium.
- **Phone app**: React + TipTap (sharing the PC's editor code) in a Capacitor Android shell. The
  phone keeps its data in IndexedDB (`src/mobile/db.ts`) and syncs with `src/mobile/sync.ts`. Two
  small native plugins live in `android/app/src/main/java/com/personalpacs/mobile/`: `LanPlugin`
  (find the PC by UDP broadcast) and `DictationPlugin` (continuous Android speech recognition).

## Roadmap ideas

- Receive studies straight from scanners/PACS (DICOM C-STORE), and query/retrieve.
- Anonymised export of teaching cases.
- Custom medical vocabulary boosting for dictation.
- 3D volume rendering and hanging protocols.
