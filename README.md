# Personal PACS

A single-user DICOM viewer and radiology reporting workstation for Windows: import CT, MRI and
other studies from a CD/DVD, USB stick or folder, read them in a PACS-style viewer, and write
reports in a RIS-style editor with templates, macros and PDF export. Everything runs offline on
your own PC or laptop.

> **Not a certified medical device.** Use it for personal reporting workflow, teaching and research.
> Verify findings on your institution's approved diagnostic systems.

## Features

**Worklist**
- Import from a CD/DVD drive, USB stick, folder or individual files, or drag them onto the window.
  Patient CDs with a `DICOMDIR` and files without extensions work.
- Images are copied into a local archive, so the CD can be removed. Duplicates are skipped.
- Search by name, patient ID, accession or study. Filter by modality, report status and date.
  Search inside report text, which is handy for teaching files.

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
- **Key images**: press **K** in the viewer to insert the current image, with its measurements, into the report.
- Save (draft), **Preliminary**, **Sign off** and **Sign off »** (signs and opens the next unreported study).
- Autosave, version history, spell check and Print / **PDF**. The printed report includes your
  letterhead, logo, patient table and signature.

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

**Viewer window** (laid out like a hospital PACS; put it on a second monitor if you have one)
- Study list with prior studies, series thumbnails, and drag-and-drop of series into viewports.
- Layouts 1×1 to 2×3. Double-click a viewport to maximise it.
- Window/level presets on keys 1–9: abdomen, lung, bone, brain, mediastinum, liver, subdural, stroke and CTA.
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

## First steps

1. Open **Settings** (gear icon). Enter your name, qualification and registration number. Add your
   signature image and the letterhead (hospital/clinic name, address and logo).
2. In the **Worklist**, click **Import CD / Folder** and choose the CD drive or folder.
3. Double-click a study. The report opens and the images open in the viewer window.
4. Choose a template, type or use macros, press **K** in the viewer for key images, then **Sign off**
   and **PDF** or **Print**.

### Viewer shortcuts

| Key | Action |
| --- | --- |
| Wheel / ↑ ↓ | Next / previous image |
| Left / middle / right drag | Selected tool (W/L) / pan / zoom |
| 1–9, 0 | Window presets, 0 = default |
| W H Z S G | Window/level, pan, zoom, scroll, magnify |
| L A E O P B T X | Length, angle, ellipse, rectangle, probe, bidirectional, arrow, eraser |
| I F R | Invert, flip, reset |
| M / C | MPR / compare with prior |
| Space | Cine |
| K | Key image to report |
| F4 | Start / stop dictation into the report |

## Your data

- Default data folder: `%LOCALAPPDATA%\PersonalPACS\Data`. It holds the database (`pacs.db`) and
  the `archive` of images. You can move it in **Settings → Data**, for example to a bigger D: drive.
- **Back up regularly:** **Settings → Back up reports database** saves a copy of all reports.
- The archive contains patient data. Keep it out of OneDrive/Dropbox and turn on BitLocker on laptops.

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

## Roadmap ideas

- Receive studies straight from scanners/PACS (DICOM C-STORE), and query/retrieve.
- Anonymised export of teaching cases.
- Custom medical vocabulary boosting for dictation.
- 3D volume rendering and hanging protocols.
